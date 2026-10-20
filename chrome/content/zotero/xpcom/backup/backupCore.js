"use strict";

/**
 * Backup logic that doesn't depend on Zotero, Mozilla APIs or any particular storage service
 *
 * Everything that touches the outside world (making the database snapshot, listing local files,
 * talking to Google Drive or a folder) is passed in, so this can be tested in plain Node (see
 * fork/test/backupCore.test.js).
 *
 * A backup has two parts:
 *
 *  - A snapshot: one ZIP containing a consistent copy of the database, the abbreviation lists
 *    and a small metadata file. Snapshots are small, taken every time, and the newest N are kept.
 *  - Attachment files: the storage folder, uploaded incrementally. A local manifest records what
 *    has been uploaded, so only new and changed files are sent. Files deleted locally are NOT
 *    deleted from the backup unless asked, since a backup that follows deletions is a mirror,
 *    not a safety net.
 *
 * Backend interface (async):
 *   listSnapshots()                       -> [{ id, name, size }]
 *   uploadSnapshot(name, localPath)       -> { id }
 *   deleteSnapshot(id)
 *   downloadSnapshot(id, localPath)
 *   uploadFile(relPath, localPath, existingRemoteId?) -> { id }
 *   downloadFile(remoteId, localPath)
 *   deleteFile(remoteId)
 *   listFiles()                           -> Map(relPath -> { id, size })
 */
(function (root) {
	const SNAPSHOT_PREFIX = 'library-';
	const SNAPSHOT_SUFFIX = '.zip';
	const MANIFEST_VERSION = 1;
	const MANIFEST_SAVE_INTERVAL = 25;
	const FREQUENCIES = { manual: Infinity, daily: 24 * 3600 * 1000, weekly: 7 * 24 * 3600 * 1000 };


	function _pad(n, width = 2) {
		return String(n).padStart(width, '0');
	}


	/** library-YYYYMMDD-HHMMSS.zip, in UTC so names sort chronologically everywhere */
	function snapshotName(date) {
		return SNAPSHOT_PREFIX
			+ date.getUTCFullYear() + _pad(date.getUTCMonth() + 1) + _pad(date.getUTCDate())
			+ '-' + _pad(date.getUTCHours()) + _pad(date.getUTCMinutes()) + _pad(date.getUTCSeconds())
			+ SNAPSHOT_SUFFIX;
	}


	/** @return {Date|null} - null if the name isn't one of ours */
	function parseSnapshotName(name) {
		let m = /^library-(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})\.zip$/.exec(name);
		if (!m) return null;
		let [, y, mo, d, h, mi, s] = m.map(Number);
		let date = new Date(Date.UTC(y, mo - 1, d, h, mi, s));
		// Reject things like month 13 that Date would roll over
		return date.getUTCMonth() === mo - 1 && date.getUTCDate() === d ? date : null;
	}


	/**
	 * Which snapshots to delete so that the newest `keepLast` remain
	 *
	 * Only files whose names parse as snapshots are considered, so unrelated files in the
	 * destination are never touched. keepLast is clamped to at least 1: pruning can never remove
	 * the last remaining snapshot.
	 *
	 * @param {{ id, name }[]} snapshots
	 * @param {Number} keepLast
	 * @return {{ id, name }[]}
	 */
	function selectSnapshotsToDelete(snapshots, keepLast) {
		keepLast = Math.max(1, Math.floor(keepLast) || 1);
		return snapshots
			.map(s => ({ s, date: parseSnapshotName(s.name) }))
			.filter(x => x.date)
			.sort((a, b) => b.date - a.date)
			.slice(keepLast)
			.map(x => x.s);
	}


	/**
	 * @param {Object} options
	 * @param {Number} options.now - ms
	 * @param {Number|null} options.lastRun - ms of the last successful backup, or null
	 * @param {'manual'|'daily'|'weekly'} options.frequency
	 */
	function shouldRunBackup({ now, lastRun, frequency }) {
		let interval = FREQUENCIES[frequency];
		if (interval === undefined) {
			throw new Error("Unknown backup frequency '" + frequency + "'");
		}
		if (interval === Infinity) return false;
		if (!lastRun) return true;
		return now - lastRun >= interval;
	}


	/**
	 * Normalize a relative path to forward slashes and reject anything that could escape the
	 * directory it's joined to
	 *
	 * @return {String}
	 */
	function normalizeRelPath(relPath) {
		if (typeof relPath !== 'string' || !relPath) {
			throw new Error("Invalid path");
		}
		let p = relPath.replace(/\\/g, '/');
		if (p.startsWith('/') || /^[a-zA-Z]:/.test(p) || p.includes('\0')) {
			throw new Error("Unsafe path: " + relPath);
		}
		let parts = p.split('/').filter(part => part !== '' && part !== '.');
		if (!parts.length || parts.includes('..')) {
			throw new Error("Unsafe path: " + relPath);
		}
		return parts.join('/');
	}


	/** Join a root directory and an untrusted relative path (e.g., a ZIP entry name) */
	function safeJoin(rootDir, relPath, sep = '/') {
		return rootDir.replace(/[\\/]+$/, '') + sep + normalizeRelPath(relPath).split('/').join(sep);
	}


	function emptyManifest() {
		return { version: MANIFEST_VERSION, files: {} };
	}


	function parseManifest(text) {
		if (!text) return emptyManifest();
		let data;
		try {
			data = JSON.parse(text);
		}
		catch (e) {
			// A damaged manifest only costs a re-upload, never data
			return emptyManifest();
		}
		if (!data || data.version !== MANIFEST_VERSION || typeof data.files !== 'object' || !data.files) {
			return emptyManifest();
		}
		return data;
	}


	/**
	 * Decide which local files need uploading
	 *
	 * A file is uploaded if it isn't in the manifest, or its size or modification time differ.
	 *
	 * If the caller supplies the destination's own listing (`remoteFiles`):
	 *  - A file that isn't in the manifest but exists at the destination with the same size is
	 *    "adopted": recorded in the manifest without uploading. This is what happens after a
	 *    restore or if the manifest is lost, and it avoids re-sending (or, on Drive, duplicating)
	 *    everything. Matching on size alone can miss an edit that kept the size identical, so
	 *    this only applies when there is no manifest entry to go on.
	 *  - A manifest entry whose remote file has gone missing or changed size is uploaded again,
	 *    so a wiped destination heals itself.
	 *  - A file that has to be uploaded and already exists remotely is sent as an update to the
	 *    existing remote file, so no duplicates are made.
	 *
	 * @param {{ path, size, mtime }[]} localFiles - path is relative to the storage folder
	 * @param {Object} manifest
	 * @param {Map<String, { id, size }>} [remoteFiles]
	 * @return {{ toUpload: Object[], adopt: Object[], unchanged: Number }}
	 */
	function planFileSync(localFiles, manifest, remoteFiles) {
		let toUpload = [];
		let adopt = [];
		let unchanged = 0;
		for (let file of localFiles) {
			let path = normalizeRelPath(file.path);
			let entry = manifest.files[path];
			let remote = remoteFiles?.get(path);
			
			if (!entry && remote && remote.size === file.size) {
				adopt.push({ path, size: file.size, mtime: file.mtime, remoteId: remote.id });
				continue;
			}
			
			let changed = !entry || entry.size !== file.size || entry.mtime !== file.mtime;
			if (!changed && remoteFiles) {
				changed = !remote || (remote.size !== undefined && remote.size !== file.size);
			}
			if (changed) {
				toUpload.push({ ...file, path, remoteId: entry?.remoteId || remote?.id });
			}
			else {
				unchanged++;
			}
		}
		return { toUpload, adopt, unchanged };
	}
	
	
	/**
	 * Run a backup
	 *
	 * @param {Object} deps
	 * @param {Object} deps.backend
	 * @param {Function} deps.makeSnapshot - async () => { path } (a local ZIP, removed afterwards)
	 * @param {Function} deps.removeLocal - async path => void
	 * @param {Function} [deps.listLocalFiles] - async () => [{ path, size, mtime, absolutePath }];
	 *     omit to skip attachment files
	 * @param {Object} [deps.manifest]
	 * @param {Function} [deps.saveManifest] - async manifest => void
	 * @param {Number} [deps.keepSnapshots=10]
	 * @param {Boolean} [deps.verifyRemote=false] - Compare against the destination's listing
	 * @param {Function} [deps.now] - () => Date
	 * @param {Function} [deps.progress] - ({ phase, done, total }) => void
	 * @param {Function} [deps.isCancelled] - () => Boolean
	 * @return {Promise<Object>} - report
	 */
	async function runBackup(deps) {
		let {
			backend, makeSnapshot, removeLocal, listLocalFiles, saveManifest,
			keepSnapshots = 10, verifyRemote = false, progress, isCancelled
		} = deps;
		let now = deps.now || (() => new Date());
		let manifest = deps.manifest || emptyManifest();
		let report = {
			startedAt: now().toISOString(),
			snapshot: null,
			prunedSnapshots: [],
			files: { uploaded: 0, unchanged: 0, failed: [] },
			warnings: [],
			cancelled: false
		};

		// 1. Snapshot. A failure here is fatal: nothing useful has been backed up.
		progress?.({ phase: 'snapshot', done: 0, total: 1 });
		let snapshotFile = await makeSnapshot();
		try {
			let name = snapshotName(now());
			let { id } = await backend.uploadSnapshot(name, snapshotFile.path);
			report.snapshot = { name, id };
		}
		finally {
			await removeLocal(snapshotFile.path);
		}
		progress?.({ phase: 'snapshot', done: 1, total: 1 });

		// 2. Prune old snapshots. Never fails the backup.
		try {
			let victims = selectSnapshotsToDelete(await backend.listSnapshots(), keepSnapshots)
				.filter(s => s.id !== report.snapshot.id);
			for (let victim of victims) {
				await backend.deleteSnapshot(victim.id);
				report.prunedSnapshots.push(victim.name);
			}
		}
		catch (e) {
			report.warnings.push("Couldn't remove old snapshots: " + (e.message || e));
		}

		// 3. Attachment files
		if (listLocalFiles) {
			let local = await listLocalFiles();
			let remoteFiles = verifyRemote ? await backend.listFiles() : undefined;
			let { toUpload, adopt, unchanged } = planFileSync(local, manifest, remoteFiles);
			for (let a of adopt) {
				manifest.files[a.path] = { size: a.size, mtime: a.mtime, remoteId: a.remoteId };
			}
			report.files.unchanged = unchanged + adopt.length;

			let byPath = new Map(local.map(f => [normalizeRelPath(f.path), f]));
			let sinceSave = 0;
			for (let i = 0; i < toUpload.length; i++) {
				if (isCancelled?.()) {
					report.cancelled = true;
					break;
				}
				let file = toUpload[i];
				progress?.({ phase: 'files', done: i, total: toUpload.length });
				try {
					let source = byPath.get(file.path);
					let { id } = await backend.uploadFile(
						file.path,
						source.absolutePath,
						file.remoteId
					);
					manifest.files[file.path] = { size: file.size, mtime: file.mtime, remoteId: id };
					report.files.uploaded++;
				}
				catch (e) {
					report.files.failed.push({ path: file.path, error: String(e.message || e) });
				}
				if (saveManifest && ++sinceSave >= MANIFEST_SAVE_INTERVAL) {
					await saveManifest(manifest);
					sinceSave = 0;
				}
			}
			progress?.({ phase: 'files', done: toUpload.length, total: toUpload.length });
			if (saveManifest) await saveManifest(manifest);
		}

		report.finishedAt = now().toISOString();
		return report;
	}


	const api = {
		SNAPSHOT_PREFIX,
		MANIFEST_VERSION,
		FREQUENCIES,
		snapshotName,
		parseSnapshotName,
		selectSnapshotsToDelete,
		shouldRunBackup,
		normalizeRelPath,
		safeJoin,
		emptyManifest,
		parseManifest,
		planFileSync,
		runBackup
	};

	if (typeof module !== 'undefined' && module.exports) {
		module.exports = api;
	}
	else if (root) {
		root.BackupCore = api;
	}
})(typeof Zotero !== 'undefined' ? Zotero : null);

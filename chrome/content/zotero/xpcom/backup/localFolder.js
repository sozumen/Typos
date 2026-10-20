"use strict";

/**
 * Backup backend that writes to a folder (an external drive, a NAS mount, or a folder that
 * Dropbox / iCloud / OneDrive already syncs)
 *
 * Layout:
 *   <dir>/snapshots/library-YYYYMMDD-HHMMSS.zip
 *   <dir>/files/<relative path of each attachment file>
 *
 * IDs are paths relative to <dir>. File I/O is injected so this can be tested in Node:
 *   io.join(...parts) -> String
 *   io.mkdirp(path)
 *   io.copy(src, dest)           -- overwrites
 *   io.move(src, dest)           -- overwrites
 *   io.remove(path)              -- ignores missing files
 *   io.list(dir)                 -- [{ name, isDir, size }], [] if dir is missing
 *
 * Writes go to a ".partial" file first and are renamed on completion, so an interrupted
 * backup never leaves a half-written file under a real name.
 */
(function (root) {
	const PARTIAL = '.partial';


	class LocalFolderBackend {
		constructor({ dir, io }) {
			if (!dir) throw new Error("No backup folder set");
			this._dir = dir;
			this._io = io;
		}

		_path(id) {
			// IDs come from our own listings, but a manifest on disk could be edited
			let rel = root.BackupCore.normalizeRelPath(id);
			return this._io.join(this._dir, ...rel.split('/'));
		}

		async _put(id, localPath) {
			let dest = this._path(id);
			let tmp = dest + PARTIAL;
			await this._io.mkdirp(this._io.parent(dest));
			await this._io.copy(localPath, tmp);
			await this._io.move(tmp, dest);
			return { id };
		}

		async listSnapshots() {
			let entries = await this._io.list(this._io.join(this._dir, 'snapshots'));
			return entries
				.filter(e => !e.isDir && !e.name.endsWith(PARTIAL))
				.map(e => ({ id: 'snapshots/' + e.name, name: e.name, size: e.size }));
		}

		async uploadSnapshot(name, localPath) {
			return this._put('snapshots/' + name, localPath);
		}

		async deleteSnapshot(id) {
			await this._io.remove(this._path(id));
		}

		async downloadSnapshot(id, localPath) {
			await this._io.copy(this._path(id), localPath);
		}

		async uploadFile(relPath, localPath) {
			return this._put('files/' + root.BackupCore.normalizeRelPath(relPath), localPath);
		}

		async downloadFile(id, localPath) {
			await this._io.mkdirp(this._io.parent(localPath));
			await this._io.copy(this._path(id), localPath);
		}

		async deleteFile(id) {
			await this._io.remove(this._path(id));
		}

		async listFiles() {
			let out = new Map();
			let base = this._io.join(this._dir, 'files');
			let walk = async (dir, prefix) => {
				for (let e of await this._io.list(dir)) {
					if (e.isDir) {
						await walk(this._io.join(dir, e.name), prefix + e.name + '/');
					}
					else if (!e.name.endsWith(PARTIAL)) {
						out.set(prefix + e.name, { id: 'files/' + prefix + e.name, size: e.size });
					}
				}
			};
			await walk(base, '');
			return out;
		}
	}


	const api = { LocalFolderBackend };

	if (typeof module !== 'undefined' && module.exports) {
		// In Node, the tests assign BackupCore before requiring this
		module.exports = api;
	}
	else if (root) {
		root.LocalFolder = api;
	}
})(typeof Zotero !== 'undefined' ? Zotero : globalThis);

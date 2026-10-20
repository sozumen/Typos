"use strict";

/**
 * Typos update checking: the sequence of steps, with the outside world passed in
 *
 * `check` asks GitHub for the newest release and says what to do about it. `fetchInstaller`
 * downloads the installer and refuses to hand it back unless its SHA-256 matches the one in the
 * release's SHA256SUMS file. Both take their I/O as functions, so they run in plain Node with fakes
 * (fork/test/updateFlow.test.js) and in the application with real ones (typosUpdate.js).
 *
 * What the checksum does and does not do: it catches a corrupted or truncated download and a file
 * swapped on a mirror. It cannot catch a release whose installer *and* SHA256SUMS were both
 * replaced, because both come from the same GitHub account; protect that account (two-factor
 * authentication) and the release workflow. Windows will also show "unknown publisher" until the
 * installer is code-signed. See docs/WINDOWS.md.
 */
(function (root) {
	const L = typeof require === 'function' && typeof module !== 'undefined'
		? require('./updateLogic.js')
		: root.TyposUpdateLogic;

	class UpdateError extends Error {
		constructor(kind, message) {
			super(message);
			this.name = 'UpdateError';
			this.kind = kind;
		}
	}

	const API_HEADERS = {
		Accept: 'application/vnd.github+json',
		'X-GitHub-Api-Version': '2022-11-28'
	};

	/**
	 * @param {Object} o
	 * @param {Function} o.request - (url, { headers, timeout }) -> Promise<{ status, text }>. Resolves
	 *   for any HTTP status; rejects only if nothing came back.
	 * @param {String} o.repo - "owner/name"
	 * @param {String} o.currentVersion
	 * @param {String|null} o.arch - 'x64' | 'arm64' | 'win32'; null where an installer can't be run
	 * @param {Boolean} [o.manual]
	 * @param {String} [o.skippedVersion]
	 * @return {Promise<Object>} One of:
	 *   { kind: 'update', release }          a newer release with a checked-able installer
	 *   { kind: 'update-manual', release, message }  newer, but nothing this computer can run
	 *                                         automatically (no installer for it yet, or not Windows)
	 *   { kind: 'up-to-date', release }
	 *   { kind: 'skipped', release }
	 *   { kind: 'dev-build', release }        the running copy has no release number
	 *   { kind: 'no-releases' }               the repository has no published release
	 *   { kind: 'ignored', reason, message }  newest release is a draft / pre-release / odd tag
	 *   { kind: 'error', error: UpdateError }
	 */
	async function check({ request, repo, currentVersion, arch, manual = false, skippedVersion = '' }) {
		let url = L.latestReleaseURL(repo); // throws for a malformed repository name: that is a bug
		let response;
		try {
			response = await request(url, { headers: API_HEADERS, timeout: 30000 });
		}
		catch (e) {
			return {
				kind: 'error',
				error: new UpdateError('network', 'Could not reach GitHub to look for updates.')
			};
		}
		if (response.status === 404) return { kind: 'no-releases' };
		if (response.status === 403 || response.status === 429) {
			return {
				kind: 'error',
				error: new UpdateError('rate-limit', 'GitHub is limiting requests from this network right now. Try again later.')
			};
		}
		if (response.status !== 200) {
			return {
				kind: 'error',
				error: new UpdateError('bad-reply', 'GitHub answered with an error (' + response.status + ').')
			};
		}
		let json;
		try {
			json = JSON.parse(response.text);
		}
		catch (e) {
			return { kind: 'error', error: new UpdateError('bad-reply', 'GitHub sent a reply that could not be read.') };
		}

		let parsed = L.parseRelease(json, { arch });
		if (!parsed.ok) {
			if (parsed.release) {
				// A release exists, but this computer can't install it automatically
				let verdict = L.decide(currentVersion, parsed.release, { skippedVersion, manual });
				if (verdict === 'update') {
					return { kind: 'update-manual', release: parsed.release, message: parsed.message };
				}
				return { kind: verdict === 'unknown-current' ? 'dev-build' : verdict, release: parsed.release };
			}
			if (parsed.reason === 'bad-reply') {
				return { kind: 'error', error: new UpdateError('bad-reply', parsed.message) };
			}
			return { kind: 'ignored', reason: parsed.reason, message: parsed.message };
		}

		let release = parsed.release;
		let verdict = L.decide(currentVersion, release, { skippedVersion, manual });
		if (verdict === 'unknown-current') return { kind: 'dev-build', release };
		if (verdict === 'update' && !arch) {
			return {
				kind: 'update-manual',
				release,
				message: 'Typos can only install its own updates on Windows.'
			};
		}
		return { kind: verdict, release };
	}

	/**
	 * Download the installer and check it.
	 *
	 * @param {Object} o
	 * @param {Object} o.release - From check()
	 * @param {String} o.dir - Folder to download into
	 * @param {Function} o.request - As above, for the checksum file
	 * @param {Function} o.download - (url, path) -> Promise
	 * @param {Function} o.sha256File - (path) -> Promise<hex>
	 * @param {Function} o.fileSize - (path) -> Promise<Number>
	 * @param {Function} o.removeFile - (path) -> Promise
	 * @param {Function} o.join - (dir, name) -> path
	 * @return {Promise<String>} Path to a downloaded installer whose checksum matched
	 */
	async function fetchInstaller({ release, dir, request, download, sha256File, fileSize, removeFile, join }) {
		if (!release || !release.installer || !release.checksumsURL) {
			throw new UpdateError('no-installer', 'This release has no installer to download.');
		}
		if (!L.isTrustedDownloadURL(release.installer.url) || !L.isTrustedDownloadURL(release.checksumsURL)) {
			throw new UpdateError('untrusted', 'The release points somewhere other than GitHub, so it was not downloaded.');
		}

		// The checksum first: if it can't be had there is nothing to compare against
		let sums;
		try {
			sums = await request(release.checksumsURL, { headers: {}, timeout: 30000 });
		}
		catch (e) {
			throw new UpdateError('network', 'Could not download the checksum file.');
		}
		if (sums.status !== 200) {
			throw new UpdateError('checksum-missing', 'Could not download the checksum file (' + sums.status + ').');
		}
		let expected = L.findChecksum(sums.text, release.installer.name);
		if (!expected) {
			throw new UpdateError('checksum-missing', 'The checksum file has no entry for ' + release.installer.name + '.');
		}

		let path = join(dir, release.installer.name);
		try {
			await removeFile(path); // never trust something left from an earlier try
		}
		catch (e) {
			// nothing there
		}
		try {
			await download(release.installer.url, path);
		}
		catch (e) {
			await removeFile(path).catch(() => {});
			throw new UpdateError('network', 'The download did not finish.');
		}

		if (release.installer.size) {
			let size = await fileSize(path);
			if (size !== release.installer.size) {
				await removeFile(path).catch(() => {});
				throw new UpdateError('size-mismatch', 'The download is ' + size + ' bytes; GitHub lists ' + release.installer.size + '.');
			}
		}
		let actual = await sha256File(path);
		if (!L.checksumMatches(actual, expected)) {
			await removeFile(path).catch(() => {});
			throw new UpdateError('checksum-mismatch', 'The download does not match its published checksum, so it was deleted and not run.');
		}
		return path;
	}

	const api = { UpdateError, check, fetchInstaller };

	if (typeof module !== 'undefined' && module.exports) {
		module.exports = api;
	}
	else if (root) {
		root.TyposUpdateFlow = api;
	}
})(typeof Zotero !== 'undefined' ? Zotero : null);

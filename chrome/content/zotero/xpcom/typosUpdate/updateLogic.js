"use strict";

/**
 * Typos update checking: the decisions, with no I/O
 *
 * Typos checks its GitHub Releases for a newer installer, tells the person, and (if they agree)
 * downloads it, checks its SHA-256 against the release's SHA256SUMS file and runs it. This file
 * holds everything in that process that is a decision rather than an action: reading version
 * numbers, reading the release JSON, choosing the installer, reading the checksum file, deciding
 * whether to prompt, and working out how the running copy was installed. The glue that touches the
 * application is typosUpdate.js.
 *
 * Version numbers are 2 to 4 numbers: Zotero's own (10.0.7) plus a fourth for the Typos release
 * (10.0.7.3). A missing number counts as 0, so 10.0.7 is older than 10.0.7.1.
 *
 * Tested in plain Node: fork/test/updateLogic.test.js
 */
(function (root) {
	const DEFAULT_REPO = 'sozumen/typos';
	const DAY = 24 * 60 * 60 * 1000;

	// Where a release's files may come from. A release listing that points elsewhere is refused.
	const DOWNLOAD_HOSTS = [
		'github.com',
		'objects.githubusercontent.com',
		'release-assets.githubusercontent.com'
	];

	/** "v10.0.7.3", "10.0.7.3" or "typos-v10.0.7.3" -> [10, 0, 7, 3]; null if it isn't a version */
	function parseVersion(text) {
		if (typeof text !== 'string') return null;
		let m = /^(?:typos-)?v?(\d+(?:\.\d+){1,3})$/i.exec(text.trim());
		if (!m) return null;
		let parts = m[1].split('.').map(Number);
		if (parts.some(n => !Number.isSafeInteger(n))) return null;
		return parts;
	}

	/** -1 if a is older than b, 1 if newer, 0 if the same. Both may be strings or parsed arrays. */
	function compareVersions(a, b) {
		let pa = Array.isArray(a) ? a : parseVersion(a);
		let pb = Array.isArray(b) ? b : parseVersion(b);
		if (!pa || !pb) throw new Error('Not a version number: ' + (!pa ? a : b));
		for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
			let x = pa[i] || 0;
			let y = pb[i] || 0;
			if (x !== y) return x < y ? -1 : 1;
		}
		return 0;
	}

	function formatVersion(parts) {
		return parts.join('.');
	}

	/** "owner/name" as it appears in GitHub URLs */
	function isValidRepo(repo) {
		return typeof repo === 'string' && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)
			&& !repo.split('/').some(part => part === '.' || part === '..');
	}

	function latestReleaseURL(repo) {
		if (!isValidRepo(repo)) throw new Error('Not a GitHub repository name: ' + repo);
		return 'https://api.github.com/repos/' + repo + '/releases/latest';
	}

	function releasesPageURL(repo) {
		if (!isValidRepo(repo)) throw new Error('Not a GitHub repository name: ' + repo);
		return 'https://github.com/' + repo + '/releases';
	}

	/** Whether a URL may be fetched as part of an update: https, on a GitHub download host */
	function isTrustedDownloadURL(url) {
		let u;
		try {
			u = new URL(url);
		}
		catch (e) {
			return false;
		}
		return u.protocol === 'https:' && !u.username && !u.password
			&& DOWNLOAD_HOSTS.includes(u.hostname.toLowerCase());
	}

	/**
	 * Installer file names are Typos-<version>_<arch>_setup.exe, as app/build.sh makes them
	 * @param {String} arch - 'x64', 'arm64' or 'win32'
	 */
	function installerName(version, arch) {
		return 'Typos-' + version + '_' + arch + '_setup.exe';
	}

	/** Which installer this computer needs, from what the application reports. null if unknown. */
	function archForPlatform(osArch, isWin) {
		if (!isWin) return null;
		let a = String(osArch || '').toLowerCase();
		if (a === 'x86_64' || a === 'x64' || a === 'amd64') return 'x64';
		if (a === 'aarch64' || a === 'arm64') return 'arm64';
		if (a === 'x86' || a === 'i686' || a === 'ia32') return 'win32';
		return null;
	}

	/**
	 * Read the JSON GitHub returns for `releases/latest`.
	 *
	 * @param {Object} json
	 * @param {Object} options
	 * @param {String} options.arch - 'x64' | 'arm64' | 'win32', or null for "just tell me the version"
	 * @return {{ ok: true, release: Object } | { ok: false, reason: String, message: String }}
	 *   reason: 'bad-reply' | 'draft' | 'prerelease' | 'no-version' | 'no-installer' | 'no-checksums'
	 *   (no-installer / no-checksums still carry `release` so the person can be pointed to the page)
	 */
	function parseRelease(json, { arch = null } = {}) {
		if (!json || typeof json !== 'object' || typeof json.tag_name !== 'string') {
			return { ok: false, reason: 'bad-reply', message: 'GitHub sent a reply that is not a release.' };
		}
		if (json.draft) {
			return { ok: false, reason: 'draft', message: 'The newest release is still a draft.' };
		}
		if (json.prerelease) {
			return { ok: false, reason: 'prerelease', message: 'The newest release is marked as a pre-release.' };
		}
		let parts = parseVersion(json.tag_name);
		if (!parts) {
			return {
				ok: false,
				reason: 'no-version',
				message: 'The newest release is tagged "' + json.tag_name + '", which is not a version number.'
			};
		}
		let version = formatVersion(parts);
		let assets = Array.isArray(json.assets) ? json.assets : [];
		let release = {
			version,
			parts,
			tag: json.tag_name,
			name: typeof json.name === 'string' && json.name ? json.name : 'Typos ' + version,
			notes: typeof json.body === 'string' ? json.body : '',
			pageURL: typeof json.html_url === 'string' && /^https:\/\/github\.com\//.test(json.html_url)
				? json.html_url
				: null,
			publishedAt: json.published_at || null,
			installer: null,
			checksumsURL: null
		};
		if (!arch) return { ok: true, release };

		let wanted = installerName(version, arch);
		let installer = assets.find(a => a && a.name === wanted);
		if (!installer || !isTrustedDownloadURL(installer.browser_download_url)) {
			return {
				ok: false,
				reason: 'no-installer',
				message: 'Release ' + version + ' has no ' + wanted + ' (yet). It may still be building.',
				release
			};
		}
		release.installer = {
			name: installer.name,
			url: installer.browser_download_url,
			size: Number.isFinite(installer.size) ? installer.size : null
		};
		let sums = assets.find(a => a && a.name === 'SHA256SUMS');
		if (!sums || !isTrustedDownloadURL(sums.browser_download_url)) {
			return {
				ok: false,
				reason: 'no-checksums',
				message: 'Release ' + version + ' has no SHA256SUMS file, so the download could not be checked.',
				release
			};
		}
		release.checksumsURL = sums.browser_download_url;
		return { ok: true, release };
	}

	/**
	 * Find a file's SHA-256 in the text of a SHA256SUMS file ("<64 hex>  <name>" or "<hex> *<name>")
	 * @return {String|null} Lowercase hex
	 */
	function findChecksum(text, fileName) {
		if (typeof text !== 'string') return null;
		for (let line of text.split(/\r?\n/)) {
			let m = /^([0-9a-fA-F]{64})\s+\*?(.+?)\s*$/.exec(line);
			if (m && m[2] === fileName) return m[1].toLowerCase();
		}
		return null;
	}

	/** Compare a computed SHA-256 to the published one */
	function checksumMatches(actual, expected) {
		return typeof actual === 'string' && typeof expected === 'string'
			&& /^[0-9a-f]{64}$/i.test(actual) && /^[0-9a-f]{64}$/i.test(expected)
			&& actual.toLowerCase() === expected.toLowerCase();
	}

	/**
	 * What to tell the person
	 * @param {String} current - The running version
	 * @param {Object} release - From parseRelease
	 * @param {Object} [options]
	 * @param {String} [options.skippedVersion] - A version the person chose to skip
	 * @param {Boolean} [options.manual] - The person asked for the check (skips are ignored)
	 * @return {'update'|'up-to-date'|'skipped'|'unknown-current'}
	 */
	function decide(current, release, { skippedVersion = '', manual = false } = {}) {
		let cur = parseVersion(current);
		// A source build ("10.0.7.SOURCE") or anything else unparseable is a development copy
		if (!cur) return 'unknown-current';
		if (compareVersions(cur, release.parts) >= 0) return 'up-to-date';
		if (!manual && skippedVersion && parseVersion(skippedVersion)
				&& compareVersions(skippedVersion, release.parts) === 0) {
			return 'skipped';
		}
		return 'update';
	}

	/**
	 * Is an automatic check due?
	 * @param {Number} lastCheck - Milliseconds since the epoch, 0 if never
	 * @param {Number} now
	 * @param {Number} intervalHours
	 */
	function isCheckDue(lastCheck, now, intervalHours = 24) {
		let interval = Math.max(1, Number(intervalHours) || 24) * 60 * 60 * 1000;
		if (!Number.isFinite(lastCheck) || lastCheck <= 0) return true;
		// A clock that went backwards must not stop checks for years
		if (lastCheck > now) return true;
		return now - lastCheck >= interval;
	}

	function normalizePath(p) {
		return String(p || '').replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase();
	}

	function isInside(path, dir) {
		let p = normalizePath(path);
		let d = normalizePath(dir);
		return !!d && (p === d || p.startsWith(d + '\\'));
	}

	/**
	 * How the running copy was installed, so the new installer can be told the same.
	 *
	 * @param {String} appDir - Folder the running application is in
	 * @param {Object} env
	 * @param {String[]} env.programFiles - ProgramFiles, ProgramFiles(x86), ProgramW6432 (any may be empty)
	 * @param {String} env.localAppData
	 * @return {{ scope: 'all'|'user'|null, args: String[] }} scope null: somewhere else (a build
	 *   folder, an unpacked zip), where an installer would put the app in a different place
	 */
	function installScope(appDir, { programFiles = [], localAppData = '' } = {}) {
		if (programFiles.some(dir => isInside(appDir, dir))) {
			return { scope: 'all', args: ['/AllUsers', '/Updating'] };
		}
		if (isInside(appDir, localAppData)) {
			return { scope: 'user', args: ['/CurrentUser', '/Updating'] };
		}
		return { scope: null, args: [] };
	}

	/**
	 * Release notes are Markdown written for GitHub. Show the start as plain text.
	 */
	function summarizeNotes(markdown, maxLength = 900) {
		let text = String(markdown || '')
			.replace(/\r\n?/g, '\n')
			.replace(/<!--[\s\S]*?-->/g, '')
			.replace(/^\s*#{1,6}\s*/gm, '')
			.replace(/\*\*(.+?)\*\*/g, '$1')
			.replace(/`([^`]+)`/g, '$1')
			.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
			.replace(/\n{3,}/g, '\n\n')
			.trim();
		if (text.length <= maxLength) return text;
		let cut = text.slice(0, maxLength);
		let lastBreak = Math.max(cut.lastIndexOf('\n'), cut.lastIndexOf('. '));
		if (lastBreak > maxLength * 0.5) cut = cut.slice(0, lastBreak);
		return cut.trimEnd() + '…';
	}

	/** "104857600" -> "100 MB" */
	function formatSize(bytes) {
		if (!Number.isFinite(bytes) || bytes <= 0) return '';
		let units = ['bytes', 'KB', 'MB', 'GB'];
		let i = 0;
		while (bytes >= 1024 && i < units.length - 1) {
			bytes /= 1024;
			i++;
		}
		return (i === 0 ? String(bytes) : bytes.toFixed(bytes >= 100 ? 0 : 1)) + ' ' + units[i];
	}

	const api = {
		DEFAULT_REPO,
		DAY,
		DOWNLOAD_HOSTS,
		parseVersion,
		compareVersions,
		formatVersion,
		isValidRepo,
		latestReleaseURL,
		releasesPageURL,
		isTrustedDownloadURL,
		installerName,
		archForPlatform,
		parseRelease,
		findChecksum,
		checksumMatches,
		decide,
		isCheckDue,
		installScope,
		summarizeNotes,
		formatSize
	};

	if (typeof module !== 'undefined' && module.exports) {
		module.exports = api;
	}
	else if (root) {
		root.TyposUpdateLogic = api;
	}
})(typeof Zotero !== 'undefined' ? Zotero : null);

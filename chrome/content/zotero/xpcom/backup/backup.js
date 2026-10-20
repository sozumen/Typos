"use strict";

/**
 * Local and cloud backup
 *
 * The data directory is already local storage. This adds backup copies of it to a second place:
 * a folder (an external drive, a NAS, or a folder that another service already syncs) or Google
 * Drive. See backupCore.js for what a backup contains and how files are synced.
 *
 * This is a backup, not sync: it only ever writes to the destination, never merges changes back,
 * and restoring is an explicit action that writes into a new empty folder.
 *
 * Preferences (extensions.zotero.cloudBackup.*):
 *   destination     'none' | 'folder' | 'gdrive'
 *   folder          Path for the 'folder' destination
 *   frequency       'manual' | 'daily' | 'weekly'
 *   keepSnapshots   How many database snapshots to keep
 *   includeFiles    Also back up attachment files
 *   googleClientId  OAuth client ID (user-supplied; see docs/BACKUP.md)
 *   lastRun         ms timestamp of the last successful backup
 *   lastStatus      JSON summary of the last run, for display
 * The Google client secret and refresh token are in the login manager.
 */
Zotero.Backup = new function () {
	const PREF = 'cloudBackup.';
	const LOGIN_HOST = 'chrome://typos-backup';
	const LOGIN_REALM = 'Google Drive backup';
	const OAUTH_PATH = '/backup/oauth/google';
	const SIGN_IN_TIMEOUT = 5 * 60 * 1000;
	const SCHEDULE_CHECK_INTERVAL = 30 * 60 * 1000;
	const STARTUP_DELAY = 2 * 60 * 1000;
	const SKIP_NAMES = new Set(['.zotero-ft-cache', '.zotero-ft-unprocessed', '.DS_Store']);

	var _running = false;
	var _cancelled = false;
	var _timer = null;
	var _pendingSignIn = null;
	var _listeners = new Set();


	//
	// Setup
	//

	this.init = function () {
		Zotero.Server.Endpoints[OAUTH_PATH] = OAuthCallbackEndpoint;

		// Always run the timer: each tick re-reads the settings, so choosing a destination
		// later starts scheduled backups without a restart
		setTimeout(() => this._scheduleTick(), STARTUP_DELAY);
		_timer = setInterval(() => this._scheduleTick(), SCHEDULE_CHECK_INTERVAL);
	};


	this.uninit = function () {
		if (_timer) clearInterval(_timer);
		_timer = null;
	};


	this.getSettings = function () {
		let destination = Zotero.Prefs.get(PREF + 'destination');
		return {
			destination: ['folder', 'gdrive'].includes(destination) ? destination : 'none',
			folder: Zotero.Prefs.get(PREF + 'folder') || '',
			frequency: Object.keys(Zotero.BackupCore.FREQUENCIES).includes(Zotero.Prefs.get(PREF + 'frequency'))
				? Zotero.Prefs.get(PREF + 'frequency')
				: 'daily',
			keepSnapshots: Math.max(1, Number(Zotero.Prefs.get(PREF + 'keepSnapshots')) || 10),
			includeFiles: Zotero.Prefs.get(PREF + 'includeFiles') !== false,
			googleClientId: Zotero.Prefs.get(PREF + 'googleClientId') || ''
		};
	};


	this.getLastStatus = function () {
		try {
			return JSON.parse(Zotero.Prefs.get(PREF + 'lastStatus') || 'null');
		}
		catch (e) {
			return null;
		}
	};


	this.addListener = function (fn) {
		_listeners.add(fn);
		return () => _listeners.delete(fn);
	};


	this._emit = function (event) {
		for (let fn of _listeners) {
			try {
				fn(event);
			}
			catch (e) {
				Zotero.logError(e);
			}
		}
	};


	this.isRunning = () => _running;

	this.cancel = function () {
		_cancelled = true;
	};


	this._scheduleTick = async function () {
		try {
			let { destination, frequency } = this.getSettings();
			if (destination === 'none' || _running || Zotero.locked) return;
			let lastRun = Number(Zotero.Prefs.get(PREF + 'lastRun')) || null;
			if (Zotero.BackupCore.shouldRunBackup({ now: Date.now(), lastRun, frequency })) {
				await this.run();
			}
		}
		catch (e) {
			// Already recorded by run(); don't let the timer produce unhandled rejections
			Zotero.debug("Scheduled backup failed: " + e);
		}
	};


	//
	// Secrets (login manager, encrypted with the OS key store like the sync API key)
	//

	async function _findLogin(username) {
		let logins = await Services.logins.searchLoginsAsync({
			origin: LOGIN_HOST,
			httpRealm: LOGIN_REALM
		});
		return logins.find(l => l.username === username) || null;
	}


	async function _getSecret(username) {
		let login = await _findLogin(username);
		if (!login) return null;
		return Zotero.OSKeyStore.isEncrypted(login.password)
			? Zotero.OSKeyStore.decrypt(login.password)
			: login.password;
	}


	async function _setSecret(username, value) {
		let old = await _findLogin(username);
		let LoginInfo = new Components.Constructor(
			"@mozilla.org/login-manager/loginInfo;1",
			Components.interfaces.nsILoginInfo,
			"init"
		);
		let stored = await Zotero.OSKeyStore.encrypt(value);
		let info = new LoginInfo(LOGIN_HOST, null, LOGIN_REALM, username, stored, '', '');
		if (old) {
			Services.logins.modifyLogin(old, info);
		}
		else {
			await Services.logins.addLoginAsync(info);
		}
	}


	async function _clearSecret(username) {
		let old = await _findLogin(username);
		if (old) Services.logins.removeLogin(old);
	}


	this.setGoogleClient = async function (clientId, clientSecret) {
		Zotero.Prefs.set(PREF + 'googleClientId', clientId.trim());
		if (clientSecret) await _setSecret('client-secret', clientSecret.trim());
	};


	this.isSignedInToGoogle = async function () {
		return !!(await _getSecret('refresh-token'));
	};


	this.signOutOfGoogle = async function () {
		// Local only: the refresh token stays valid at Google until revoked at
		// https://myaccount.google.com/permissions
		await _clearSecret('refresh-token');
	};


	//
	// Google sign-in
	//

	function _randomBytes(n) {
		return Cc["@mozilla.org/security/random-generator;1"]
			.createInstance(Ci.nsIRandomGenerator)
			.generateRandomBytes(n);
	}


	function _sha256(str) {
		let data = new TextEncoder().encode(str);
		let hasher = Cc["@mozilla.org/security/hash;1"].createInstance(Ci.nsICryptoHash);
		hasher.init(hasher.SHA256);
		hasher.update(data, data.length);
		return Uint8Array.from(hasher.finish(false), c => c.charCodeAt(0));
	}


	/**
	 * Adapter for the Drive client's injected `http`
	 */
	async function _http({ method, url, headers, body }) {
		let xhr = await Zotero.HTTP.request(method, url, {
			headers,
			body,
			successCodes: false,
			responseType: 'text',
			timeout: 120000,
			errorDelayMax: 0, // the Drive client does its own retrying
			logBodyLength: 0
		});
		let responseHeaders = {};
		for (let line of xhr.getAllResponseHeaders().trim().split(/[\r\n]+/)) {
			let i = line.indexOf(':');
			if (i > 0) responseHeaders[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
		}
		return { status: xhr.status, headers: responseHeaders, text: xhr.responseText };
	}


	/**
	 * Open the browser for Google sign-in and wait for the redirect back to the local server
	 */
	this.signInToGoogle = async function () {
		let { googleClientId } = this.getSettings();
		let clientSecret = await _getSecret('client-secret');
		if (!googleClientId || !clientSecret) {
			throw new Error("Enter a Google client ID and client secret first");
		}
		if (_pendingSignIn) {
			throw new Error("A Google sign-in is already in progress");
		}

		let GD = Zotero.GoogleDrive;
		let { verifier, challenge, state } = await GD.createPKCE(_randomBytes, _sha256);
		let redirectUri = `http://127.0.0.1:${Zotero.Server.port}${OAUTH_PATH}`;

		let codePromise = new Promise((resolve, reject) => {
			let timeout = setTimeout(() => {
				_pendingSignIn = null;
				reject(new Error("Google sign-in timed out"));
			}, SIGN_IN_TIMEOUT);
			_pendingSignIn = {
				state,
				resolve: (code) => {
					clearTimeout(timeout);
					_pendingSignIn = null;
					resolve(code);
				},
				reject: (err) => {
					clearTimeout(timeout);
					_pendingSignIn = null;
					reject(err);
				}
			};
		});

		Zotero.launchURL(GD.buildAuthURL({ clientId: googleClientId, redirectUri, challenge, state }));
		let code = await codePromise;

		let tokens = await GD.exchangeCode({
			http: _http,
			clientId: googleClientId,
			clientSecret,
			code,
			redirectUri,
			verifier
		});
		if (!tokens.refreshToken) {
			throw new Error("Google didn't return a refresh token -- remove this app's access at "
				+ "https://myaccount.google.com/permissions and sign in again");
		}
		await _setSecret('refresh-token', tokens.refreshToken);
	};


	function OAuthCallbackEndpoint() {}
	OAuthCallbackEndpoint.prototype = {
		supportedMethods: ['GET'],
		// The redirect from Google is a browser navigation, which the server blocks by default.
		// This is safe because the request is only acted on while a sign-in is pending and only
		// if it carries the random `state` we generated for it.
		allowRequestsFromUnsafeWebContent: true,

		init: function (req) {
			let page = (title, message) => [
				200,
				'text/html; charset=utf-8',
				'<!DOCTYPE html><html><head><meta charset="utf-8"><title>' + title + '</title></head>'
					+ '<body style="font-family: sans-serif; max-width: 30em; margin: 4em auto">'
					+ '<h2>' + title + '</h2><p>' + message + '</p></body></html>'
			];
			let pending = _pendingSignIn;
			let params = req.searchParams;
			if (!pending || params.get('state') !== pending.state) {
				return page("Not expecting a sign-in", "You can close this tab.");
			}
			if (params.get('error') || !params.get('code')) {
				pending.reject(new Error("Google sign-in was cancelled or denied ("
					+ (params.get('error') || 'no code') + ")"));
				return page("Sign-in failed", "Return to the app for details. You can close this tab.");
			}
			pending.resolve(params.get('code'));
			return page("Signed in", "You can close this tab and return to the app.");
		}
	};


	//
	// Backends
	//

	function _localIO() {
		return {
			join: (...parts) => PathUtils.join(...parts),
			parent: p => PathUtils.parent(p),
			mkdirp: p => IOUtils.makeDirectory(p, { createAncestors: true, ignoreExisting: true }),
			copy: (a, b) => IOUtils.copy(a, b, { noOverwrite: false }),
			move: (a, b) => IOUtils.move(a, b, { noOverwrite: false }),
			remove: p => IOUtils.remove(p, { ignoreAbsent: true }),
			list: async (dir) => {
				if (!(await IOUtils.exists(dir))) return [];
				let out = [];
				for (let p of await IOUtils.getChildren(dir)) {
					let stat = await IOUtils.stat(p);
					out.push({
						name: PathUtils.filename(p),
						isDir: stat.type === 'directory',
						size: stat.size
					});
				}
				return out;
			}
		};
	}


	/**
	 * @return {Promise<{ backend: Object, key: String }>} - key identifies the destination, for
	 *     keeping a separate manifest per destination
	 */
	this._createBackend = async function () {
		let settings = this.getSettings();
		if (settings.destination === 'folder') {
			if (!settings.folder) throw new Error("No backup folder chosen");
			if (!(await IOUtils.exists(settings.folder))) {
				throw new Error("Backup folder not found: " + settings.folder
					+ " (is the drive connected?)");
			}
			return {
				backend: new Zotero.LocalFolder.LocalFolderBackend({
					dir: PathUtils.join(settings.folder, 'Typos Backup'),
					io: _localIO()
				}),
				key: 'folder-' + _shortHash(settings.folder)
			};
		}
		if (settings.destination === 'gdrive') {
			let clientSecret = await _getSecret('client-secret');
			let refreshToken = await _getSecret('refresh-token');
			if (!settings.googleClientId || !clientSecret) {
				throw new Error("Google client ID and secret aren't set");
			}
			if (!refreshToken) {
				throw new Error("Not signed in to Google Drive");
			}
			let GD = Zotero.GoogleDrive;
			let tokens = new GD.TokenManager({
				http: _http,
				clientId: settings.googleClientId,
				clientSecret,
				refreshToken
			});
			return {
				backend: new GD.GoogleDriveBackend({
					http: _http,
					getAccessToken: () => tokens.getAccessToken(),
					invalidateToken: () => tokens.invalidate(),
					readChunk: async (path, offset, length) => IOUtils.read(path, { offset, maxBytes: length }),
					fileSize: async path => (await IOUtils.stat(path)).size,
					download: async ({ url, headers, destPath }) => {
						let res = await Zotero.HTTP.download(url, destPath, { headers, successCodes: false });
						return { status: res.status };
					}
				}),
				key: 'gdrive-' + _shortHash(settings.googleClientId)
			};
		}
		throw new Error("No backup destination chosen");
	};


	function _shortHash(str) {
		let h = 5381;
		for (let i = 0; i < str.length; i++) {
			h = ((h * 33) ^ str.charCodeAt(i)) >>> 0;
		}
		return h.toString(16);
	}


	//
	// Creating a backup
	//

	this._manifestPath = function (key) {
		return PathUtils.join(Zotero.DataDirectory.dir, `cloud-backup-manifest-${key}.json`);
	};


	/**
	 * Make a consistent copy of the database plus the abbreviation lists, zipped
	 *
	 * @return {Promise<{ path: String }>}
	 */
	this._makeSnapshot = async function () {
		let stagingDir = PathUtils.join(
			Zotero.getTempDirectory().path,
			'backup-' + Zotero.Utilities.randomString(8)
		);
		let zipPath = stagingDir + '.zip';
		await IOUtils.makeDirectory(stagingDir, { createAncestors: true });
		try {
			let ok = await Zotero.DB.backUpDatabase({
				suffix: 'cloudbackup',
				force: true,
				online: true
			});
			let dbBackup = Zotero.DataDirectory.getDatabase() + '.cloudbackup.bak';
			if (!ok || !(await IOUtils.exists(dbBackup))) {
				throw new Error("Couldn't make a copy of the database to back up");
			}
			await IOUtils.move(dbBackup, PathUtils.join(stagingDir, 'zotero.sqlite'));

			let abbrDir = Zotero.ClassicalAbbreviations.dir;
			if (await IOUtils.exists(abbrDir)) {
				let target = PathUtils.join(stagingDir, 'abbreviations');
				await IOUtils.makeDirectory(target);
				for (let p of await IOUtils.getChildren(abbrDir)) {
					if (p.endsWith('.json')) {
						await IOUtils.copy(p, PathUtils.join(target, PathUtils.filename(p)));
					}
				}
			}

			await IOUtils.writeJSON(PathUtils.join(stagingDir, 'snapshot.json'), {
				format: 1,
				createdAt: new Date().toISOString(),
				appVersion: Zotero.version,
				schemaVersion: Zotero.Schema.version
			});

			if (!(await Zotero.File.zipDirectory(stagingDir, zipPath))) {
				throw new Error("Couldn't create snapshot archive");
			}
			return { path: zipPath };
		}
		finally {
			await IOUtils.remove(stagingDir, { recursive: true, ignoreAbsent: true });
		}
	};


	this._listStorageFiles = async function () {
		let root = PathUtils.join(Zotero.DataDirectory.dir, 'storage');
		let out = [];
		if (!(await IOUtils.exists(root))) return out;
		let walk = async (dir, prefix) => {
			for (let p of await IOUtils.getChildren(dir)) {
				let name = PathUtils.filename(p);
				if (SKIP_NAMES.has(name) || name.endsWith('.tmp')) continue;
				let stat = await IOUtils.stat(p);
				if (stat.type === 'directory') {
					await walk(p, prefix + name + '/');
				}
				else if (stat.type === 'regular') {
					out.push({
						path: prefix + name,
						size: stat.size,
						mtime: Math.floor(stat.lastModified),
						absolutePath: p
					});
				}
			}
		};
		await walk(root, '');
		return out;
	};


	/**
	 * Run a backup now
	 *
	 * @param {Object} [options]
	 * @param {Boolean} [options.verifyRemote=false] - Compare against what's actually at the
	 *     destination instead of trusting the record of past uploads
	 * @return {Promise<Object>} - Report from BackupCore.runBackup()
	 */
	this.run = async function ({ verifyRemote = false } = {}) {
		if (_running) throw new Error("A backup is already running");
		_running = true;
		_cancelled = false;
		this._emit({ type: 'start' });
		try {
			let settings = this.getSettings();
			let { backend, key } = await this._createBackend();
			let manifestPath = this._manifestPath(key);
			let manifest = Zotero.BackupCore.parseManifest(
				(await IOUtils.exists(manifestPath)) ? await IOUtils.readUTF8(manifestPath) : null
			);

			let report = await Zotero.BackupCore.runBackup({
				backend,
				manifest,
				saveManifest: m => IOUtils.writeJSON(manifestPath, m),
				makeSnapshot: () => this._makeSnapshot(),
				removeLocal: p => IOUtils.remove(p, { ignoreAbsent: true }),
				listLocalFiles: settings.includeFiles ? () => this._listStorageFiles() : undefined,
				keepSnapshots: settings.keepSnapshots,
				// With no record of past uploads (first run, or after a restore), compare against
				// what's already at the destination rather than uploading everything again
				verifyRemote: verifyRemote || !Object.keys(manifest.files).length,
				progress: p => this._emit({ type: 'progress', ...p }),
				isCancelled: () => _cancelled
			});

			let ok = !report.cancelled && !report.files.failed.length;
			if (!report.cancelled) {
				Zotero.Prefs.set(PREF + 'lastRun', String(Date.now()));
			}
			this._saveStatus({
				time: new Date().toISOString(),
				ok,
				cancelled: report.cancelled,
				uploaded: report.files.uploaded,
				failed: report.files.failed.length,
				snapshot: report.snapshot?.name,
				message: ok ? '' : report.cancelled
					? 'Cancelled'
					: `${report.files.failed.length} file(s) couldn't be uploaded`
			});
			this._emit({ type: 'done', report });
			return report;
		}
		catch (e) {
			Zotero.logError(e);
			this._saveStatus({ time: new Date().toISOString(), ok: false, message: e.message || String(e) });
			this._emit({ type: 'error', error: e });
			throw e;
		}
		finally {
			_running = false;
		}
	};


	this._saveStatus = function (status) {
		Zotero.Prefs.set(PREF + 'lastStatus', JSON.stringify(status));
	};


	//
	// Restoring
	//

	/**
	 * @return {Promise<{ id, name, size }[]>} - Newest first
	 */
	this.listSnapshots = async function () {
		let { backend } = await this._createBackend();
		return (await backend.listSnapshots())
			.filter(s => Zotero.BackupCore.parseSnapshotName(s.name))
			.sort((a, b) => b.name.localeCompare(a.name));
	};


	/**
	 * Restore a snapshot (and optionally attachment files) into a new data directory
	 *
	 * Never touches the current data directory. The target must not exist or must be empty. Once
	 * it's restored, the caller can point the app at it with useAsDataDirectory().
	 *
	 * @param {Object} options
	 * @param {String} options.snapshotId
	 * @param {String} options.targetDir
	 * @param {Boolean} [options.includeFiles=true]
	 * @param {Function} [options.progress]
	 * @return {Promise<{ files: Number, failed: { path, error }[] }>}
	 */
	this.restore = async function ({ snapshotId, targetDir, includeFiles = true, progress }) {
		if (_running) throw new Error("A backup is running");
		if (await IOUtils.exists(targetDir)) {
			let stat = await IOUtils.stat(targetDir);
			if (stat.type !== 'directory' || (await IOUtils.getChildren(targetDir)).length) {
				throw new Error("Choose a new or empty folder to restore into");
			}
		}
		await IOUtils.makeDirectory(targetDir, { createAncestors: true, ignoreExisting: true });

		let { backend } = await this._createBackend();
		let zipPath = PathUtils.join(Zotero.getTempDirectory().path, 'restore-' + Zotero.Utilities.randomString(8) + '.zip');
		try {
			progress?.({ phase: 'snapshot' });
			await backend.downloadSnapshot(snapshotId, zipPath);
			this._extractSnapshot(zipPath, targetDir);
		}
		finally {
			await IOUtils.remove(zipPath, { ignoreAbsent: true });
		}
		if (!(await IOUtils.exists(PathUtils.join(targetDir, 'zotero.sqlite')))) {
			throw new Error("The snapshot doesn't contain a database");
		}

		let result = { files: 0, failed: [] };
		if (includeFiles) {
			let remote = await backend.listFiles();
			let total = remote.size;
			let done = 0;
			for (let [relPath, { id }] of remote) {
				progress?.({ phase: 'files', done: done++, total });
				try {
					await backend.downloadFile(
						id,
						Zotero.BackupCore.safeJoin(PathUtils.join(targetDir, 'storage'), relPath, Zotero.isWin ? '\\' : '/')
					);
					result.files++;
				}
				catch (e) {
					result.failed.push({ path: relPath, error: String(e.message || e) });
				}
			}
		}
		return result;
	};


	this._extractSnapshot = function (zipPath, targetDir) {
		let reader = Cc["@mozilla.org/libjar/zip-reader;1"].createInstance(Ci.nsIZipReader);
		reader.open(Zotero.File.pathToFile(zipPath));
		try {
			let entries = reader.findEntries(null);
			while (entries.hasMore()) {
				let name = entries.getNext();
				if (name.endsWith('/')) continue;
				// Only what we put in a snapshot, and nowhere outside the target
				if (name !== 'zotero.sqlite' && name !== 'snapshot.json'
						&& !/^abbreviations\/[^/]+\.json$/.test(name)) {
					Zotero.debug("Ignoring unexpected snapshot entry " + name, 2);
					continue;
				}
				let dest = Zotero.BackupCore.safeJoin(targetDir, name, Zotero.isWin ? '\\' : '/');
				Zotero.File.createDirectoryIfMissing(PathUtils.parent(dest));
				reader.extract(name, Zotero.File.pathToFile(dest));
			}
		}
		finally {
			reader.close();
		}
	};


	/**
	 * Make the restored directory the data directory. Takes effect after a restart.
	 */
	this.useAsDataDirectory = function (targetDir) {
		Zotero.DataDirectory.set(targetDir);
	};
};

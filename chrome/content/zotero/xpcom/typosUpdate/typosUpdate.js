"use strict";

/**
 * Typos updates: the part that touches the application
 *
 * Typos is a fork; it must never be replaced by a build from another project, so Mozilla's own
 * update machinery stays switched off (app/assets/prefs.js). This module is the replacement:
 * it asks the project's GitHub Releases for a newer installer, tells the person, and only if they
 * say yes downloads it, checks its SHA-256 against the release's SHA256SUMS and runs it.
 *
 *   - Nothing is downloaded or installed without the person choosing "Download and install".
 *   - Automatic checks run at most once a day (typosUpdate.intervalHours) and can be turned off.
 *   - The only thing a check sends is an ordinary request to api.github.com.
 *   - The installer is started with /AllUsers or /CurrentUser to match how the running copy was
 *     installed, and /Updating so it waits for Typos to quit.
 *
 * The decisions are in updateLogic.js and the sequence in updateFlow.js (both tested in plain
 * Node); the user-facing wording here is English only. See docs/WINDOWS.md.
 */
Zotero.TyposUpdater = new function () {
	const PREF = 'typosUpdate.';
	const STARTUP_DELAY = 45 * 1000;
	const TICK_INTERVAL = 60 * 60 * 1000;
	const TEMP_DIR_NAME = 'Typos-update';

	var _timer = null;
	var _busy = false;
	var _installing = false;


	//
	// Setup
	//

	this.init = function () {
		// Remove an installer left behind by an earlier update
		setTimeout(() => this._cleanUp(), STARTUP_DELAY);
		setTimeout(() => this._tick(), STARTUP_DELAY);
		// The tick only checks when the interval has passed, so a long-running session still gets a check
		_timer = setInterval(() => this._tick(), TICK_INTERVAL);
	};

	this.uninit = function () {
		if (_timer) clearInterval(_timer);
		_timer = null;
	};


	//
	// Settings
	//

	this.getSettings = function () {
		let repo = (Zotero.Prefs.get(PREF + 'repo') || '').trim();
		if (!Zotero.TyposUpdateLogic.isValidRepo(repo)) repo = Zotero.TyposUpdateLogic.DEFAULT_REPO;
		return {
			enabled: Zotero.Prefs.get(PREF + 'enabled') !== false,
			repo,
			intervalHours: Math.max(1, Number(Zotero.Prefs.get(PREF + 'intervalHours')) || 24),
			lastCheck: Number(Zotero.Prefs.get(PREF + 'lastCheck')) || 0,
			skippedVersion: Zotero.Prefs.get(PREF + 'skipVersion') || ''
		};
	};

	/** The installer this computer needs: 'x64', 'arm64', 'win32', or null where one can't be run */
	this.getArch = function () {
		let abi = String(Services.appinfo.XPCOMABI || '').split('-')[0];
		return Zotero.TyposUpdateLogic.archForPlatform(abi, Zotero.isWin);
	};

	/** { scope: 'all'|'user'|null, args } for the copy that is running */
	this.getInstallScope = function () {
		if (!Zotero.isWin) return { scope: null, args: [] };
		let programFiles = ['ProgramFiles', 'ProgramFiles(x86)', 'ProgramW6432']
			.map(name => Services.env.get(name) || '');
		return Zotero.TyposUpdateLogic.installScope(
			Services.dirsvc.get('GreD', Ci.nsIFile).path,
			{ programFiles, localAppData: Services.env.get('LOCALAPPDATA') || '' }
		);
	};


	//
	// Checking
	//

	this._tick = async function () {
		try {
			let settings = this.getSettings();
			if (!settings.enabled) return;
			// A copy built from source has no release number to compare
			if (!Zotero.TyposUpdateLogic.parseVersion(Zotero.version)) return;
			if (!Zotero.TyposUpdateLogic.isCheckDue(settings.lastCheck, Date.now(), settings.intervalHours)) return;
			await this.checkNow({ manual: false });
		}
		catch (e) {
			Zotero.logError(e);
		}
	};

	function httpRequest(url, { headers, timeout }) {
		return Zotero.HTTP.request('GET', url, {
			headers,
			timeout,
			successCodes: false,
			errorDelayMax: 0,
			logBodyLength: 0,
			responseType: 'text'
		}).then(xhr => ({ status: xhr.status, text: xhr.responseText }));
	}

	/**
	 * @param {Object} [options]
	 * @param {Boolean} [options.manual] - The person asked: say something whatever the result
	 */
	this.checkNow = async function ({ manual = false } = {}) {
		if (_busy || _installing) return null;
		_busy = true;
		try {
			let settings = this.getSettings();
			let result = await Zotero.TyposUpdateFlow.check({
				request: httpRequest,
				repo: settings.repo,
				currentVersion: Zotero.version,
				arch: this.getArch(),
				manual,
				skippedVersion: settings.skippedVersion
			});
			if (result.kind !== 'error') {
				Zotero.Prefs.set(PREF + 'lastCheck', String(Date.now()));
			}
			Zotero.debug('Typos update check: ' + result.kind
				+ (result.release ? ' (' + result.release.version + ')' : ''));
			await this._report(result, manual);
			return result;
		}
		catch (e) {
			Zotero.logError(e);
			if (manual) {
				this._alert('Typos could not check for updates.', e.message);
			}
			return null;
		}
		finally {
			_busy = false;
		}
	};


	//
	// Telling the person
	//

	function parentWindow() {
		return Zotero.getMainWindow();
	}

	this._alert = function (title, text) {
		Services.prompt.alert(parentWindow(), title, text);
	};

	async function report(result, manual) {
		let L = Zotero.TyposUpdateLogic;
		switch (result.kind) {
			case 'update':
			case 'update-manual':
				return promptForUpdate(result);
			case 'up-to-date':
				if (manual) {
					Zotero.TyposUpdater._alert(
						'Typos is up to date',
						'You have the newest version (' + Zotero.version + ').'
					);
				}
				return;
			case 'dev-build':
				if (manual) {
					Zotero.TyposUpdater._alert(
						'This is a development build',
						'This copy of Typos (' + Zotero.version + ') was built from source and has no release number, so it does not compare itself to releases.'
							+ (result.release ? '\n\nThe newest release is ' + result.release.version + '.' : '')
					);
				}
				return;
			case 'no-releases':
				if (manual) {
					Zotero.TyposUpdater._alert(
						'No releases yet',
						'No version of Typos has been published at ' + L.releasesPageURL(Zotero.TyposUpdater.getSettings().repo) + ' yet.'
					);
				}
				return;
			case 'ignored':
				if (manual) Zotero.TyposUpdater._alert('No update to offer', result.message);
				return;
			case 'error':
				if (manual) Zotero.TyposUpdater._alert('Typos could not check for updates', result.error.message);
				else Zotero.debug('Typos update check failed: ' + result.error.message);
				return;
			case 'skipped':
			default:
				return;
		}
	}
	this._report = report;

	async function promptForUpdate({ kind, release, message }) {
		let L = Zotero.TyposUpdateLogic;
		let canInstall = kind === 'update' && Zotero.TyposUpdater.getInstallScope().scope;
		let text = 'Typos ' + release.version + ' is available. You have ' + Zotero.version + '.';
		let notes = L.summarizeNotes(release.notes);
		if (notes) text += '\n\n' + notes;
		if (canInstall) {
			let size = L.formatSize(release.installer.size);
			text += '\n\nChoosing "Download and install" downloads the installer' + (size ? ' (' + size + ')' : '')
				+ ', checks it against the checksum published with the release, then closes Typos and runs it. '
				+ 'Your library and settings are not touched.';
		}
		else {
			text += '\n\n' + (message || (kind === 'update'
				? 'This copy of Typos is not in a standard install location, so it cannot update itself.'
				: ''));
		}

		let ps = Services.prompt;
		let flags = ps.BUTTON_POS_0 * ps.BUTTON_TITLE_IS_STRING
			+ ps.BUTTON_POS_1 * ps.BUTTON_TITLE_IS_STRING
			+ ps.BUTTON_POS_2 * ps.BUTTON_TITLE_IS_STRING
			+ ps.BUTTON_POS_0_DEFAULT;
		let index = ps.confirmEx(
			parentWindow(),
			'Typos update available',
			text,
			flags,
			canInstall ? 'Download and install' : 'Open release page',
			'Not now',
			'Skip this version',
			null,
			{}
		);
		if (index === 0) {
			if (canInstall) {
				await Zotero.TyposUpdater.install(release);
			}
			else {
				Zotero.launchURL(release.pageURL || L.releasesPageURL(Zotero.TyposUpdater.getSettings().repo));
			}
		}
		else if (index === 2) {
			Zotero.Prefs.set(PREF + 'skipVersion', release.version);
		}
	}


	//
	// Installing
	//

	async function sha256File(path) {
		let ch = Cc["@mozilla.org/security/hash;1"].createInstance(Ci.nsICryptoHash);
		ch.init(ch.SHA256);
		let stream = Cc["@mozilla.org/network/file-input-stream;1"].createInstance(Ci.nsIFileInputStream);
		try {
			stream.init(Zotero.File.pathToFile(path), -1, -1, Ci.nsIFileInputStream.CLOSE_ON_EOF);
			ch.updateFromStream(stream, -1);
			let hash = ch.finish(false);
			let hex = '';
			for (let i = 0; i < hash.length; i++) {
				hex += ('0' + hash.charCodeAt(i).toString(16)).slice(-2);
			}
			return hex;
		}
		finally {
			stream.close();
		}
	}

	this._tempDir = function () {
		return PathUtils.join(PathUtils.tempDir, TEMP_DIR_NAME);
	};

	this._cleanUp = async function () {
		try {
			await IOUtils.remove(this._tempDir(), { recursive: true, ignoreAbsent: true });
		}
		catch (e) {
			Zotero.debug('Could not remove old Typos installer: ' + e.message);
		}
	};

	/**
	 * Download, check and run the installer for a release, then quit so it can replace the files
	 * @param {Object} release - From check()
	 */
	this.install = async function (release) {
		if (_installing) return;
		let scope = this.getInstallScope();
		if (!scope.scope) {
			Zotero.launchURL(release.pageURL || Zotero.TyposUpdateLogic.releasesPageURL(this.getSettings().repo));
			return;
		}
		_installing = true;
		let progress = new Zotero.ProgressWindow({ closeOnClick: false });
		progress.changeHeadline('Updating Typos');
		progress.addDescription('Downloading Typos ' + release.version + '…');
		progress.show();
		try {
			let dir = this._tempDir();
			await IOUtils.makeDirectory(dir, { createAncestors: true });
			let path = await Zotero.TyposUpdateFlow.fetchInstaller({
				release,
				dir,
				request: httpRequest,
				download: (url, target) => Zotero.HTTP.download(url, target),
				sha256File,
				fileSize: async target => (await IOUtils.stat(target)).size,
				removeFile: target => IOUtils.remove(target, { ignoreAbsent: true }),
				join: (d, name) => PathUtils.join(d, name)
			});
			progress.close();
			this._launchInstaller(path, scope.args);
		}
		catch (e) {
			Zotero.logError(e);
			progress.close();
			_installing = false;
			let ps = Services.prompt;
			let open = ps.confirmEx(
				parentWindow(),
				'The update was not installed',
				(e.kind ? e.message : 'Something went wrong while downloading the update: ' + e.message)
					+ '\n\nNothing was changed. You can try again later or download the installer yourself.',
				ps.BUTTON_POS_0 * ps.BUTTON_TITLE_IS_STRING + ps.BUTTON_POS_1 * ps.BUTTON_TITLE_IS_STRING
					+ ps.BUTTON_POS_1_DEFAULT,
				'Open release page',
				'Close',
				null, null, {}
			);
			if (open === 0) {
				Zotero.launchURL(release.pageURL || Zotero.TyposUpdateLogic.releasesPageURL(this.getSettings().repo));
			}
		}
	};

	this._launchInstaller = function (path, args) {
		let file = Zotero.File.pathToFile(path);
		let process = Cc["@mozilla.org/process/util;1"].createInstance(Ci.nsIProcess);
		process.init(file);
		Zotero.debug('Starting Typos installer: ' + path + ' ' + args.join(' '));
		// Not blocking: the installer waits for Typos to quit (/Updating), then asks for
		// administrator permission if it is an all-users install
		process.run(false, args, args.length);
		// Let the installer start before the window goes away
		setTimeout(() => Zotero.Utilities.Internal.quit(), 1500);
	};
};

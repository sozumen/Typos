'use strict';

// Runs the application glue (typosUpdate.js) against fake Zotero / Services objects: it can't prove the
// real APIs behave as assumed, but it does exercise every branch of the glue's own logic.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const DIR = path.join(__dirname, '../../chrome/content/zotero/xpcom/typosUpdate');
const SUM = 'e'.repeat(64);
const NAME = 'Typos-10.0.7.3_x64_setup.exe';
const API = 'https://api.github.com/repos/sozumen/typos-releases/releases/latest';
const BASE = 'https://github.com/sozumen/typos-releases/releases/download/v10.0.7.3/';

function releaseJSON() {
	return {
		tag_name: 'v10.0.7.3', draft: false, prerelease: false, body: '## Changes\n- Better things',
		html_url: 'https://github.com/sozumen/typos-releases/releases/tag/v10.0.7.3',
		assets: [
			{ name: NAME, size: 7, browser_download_url: BASE + NAME },
			{ name: 'SHA256SUMS', size: 90, browser_download_url: BASE + 'SHA256SUMS' }
		]
	};
}

function setup({ version = '10.0.7.2', isWin = true, appDir = 'C:\\Program Files\\Typos', responses = {}, prefs = {}, answers = [], sha = SUM, downloadFails = false } = {}) {
	let log = { prompts: [], alerts: [], launched: [], urls: [], processes: [], quits: 0, prefs: Object.assign({}, prefs), removed: [], downloaded: [] };
	let timeouts = [];
	let responseMap = Object.assign({
		[API]: { status: 200, responseText: JSON.stringify(releaseJSON()) },
		[BASE + 'SHA256SUMS']: { status: 200, responseText: SUM + '  ' + NAME + '\n' }
	}, responses);

	let Zotero = {
		version, isWin,
		debug() {}, logError(e) { log.error = e; },
		Prefs: {
			get: k => log.prefs[k],
			set: (k, v) => { log.prefs[k] = v; }
		},
		HTTP: {
			request: async (method, url) => {
				let r = responseMap[url];
				if (r instanceof Error) throw r;
				return r || { status: 404, responseText: '' };
			},
			download: async (url, target) => {
				if (downloadFails) throw new Error('reset');
				log.downloaded.push({ url, target });
			}
		},
		getMainWindow: () => ({ fake: 'window' }),
		launchURL: url => log.urls.push(url),
		File: { pathToFile: p => ({ path: p }) },
		ProgressWindow: class {
			changeHeadline() {}
			addDescription() {}
			show() { log.progressShown = true; }
			close() { log.progressClosed = true; }
		},
		Utilities: { Internal: { quit() { log.quits++; } } }
	};
	let ps = {
		BUTTON_POS_0: 1, BUTTON_POS_1: 256, BUTTON_POS_2: 65536,
		BUTTON_TITLE_IS_STRING: 127, BUTTON_POS_0_DEFAULT: 0, BUTTON_POS_1_DEFAULT: 0,
		alert: (w, title, text) => log.alerts.push({ title, text }),
		confirmEx: (w, title, text, flags, b0, b1, b2) => {
			log.prompts.push({ title, text, b0, b1, b2 });
			return answers.length ? answers.shift() : 1;
		}
	};
	let env = { ProgramFiles: 'C:\\Program Files', 'ProgramFiles(x86)': 'C:\\Program Files (x86)', ProgramW6432: 'C:\\Program Files', LOCALAPPDATA: 'C:\\Users\\Ann\\AppData\\Local' };
	let context = {
		Zotero,
		Services: {
			prompt: ps,
			appinfo: { XPCOMABI: 'x86_64-msvc' },
			dirsvc: { get: () => ({ path: appDir }) },
			env: { get: k => env[k] || '' }
		},
		Cc: {
			'@mozilla.org/security/hash;1': { createInstance: () => ({
				SHA256: 3, init() {}, updateFromStream() {},
				finish: () => Buffer.from(sha, 'hex').toString('latin1')
			}) },
			'@mozilla.org/network/file-input-stream;1': { createInstance: () => ({ init() {}, close() {} }) },
			'@mozilla.org/process/util;1': { createInstance: () => ({
				init(file) { this.file = file; },
				run(blocking, args, n) { log.processes.push({ file: this.file.path, blocking, args: Array.from(args).slice(0, n) }); }
			}) }
		},
		Ci: { nsICryptoHash: {}, nsIFileInputStream: { CLOSE_ON_EOF: 1 }, nsIFile: {}, nsIProcess: {} },
		PathUtils: { tempDir: 'C:\\Temp', join: (...p) => p.join('\\') },
		IOUtils: {
			makeDirectory: async () => {},
			stat: async () => ({ size: 7 }),
			remove: async p => { log.removed.push(p); }
		},
		setTimeout: (fn, ms) => { timeouts.push({ fn, ms }); return timeouts.length; },
		setInterval: () => 1, clearInterval() {},
		Date, Number, String, Math, JSON, Promise, Array, Object, Error, URL
	};
	vm.createContext(context);
	for (let file of ['updateLogic.js', 'updateFlow.js', 'typosUpdate.js']) {
		// "const" at the top level of a script is not a property of the context; Zotero is, which is all these need
		vm.runInContext(fs.readFileSync(path.join(DIR, file), 'utf8'), context, { filename: file });
	}
	return { Zotero, log, timeouts, ps };
}

test('glue: loads and exposes the updater', () => {
	let { Zotero } = setup();
	assert.equal(typeof Zotero.TyposUpdater.checkNow, 'function');
	assert.equal(Zotero.TyposUpdater.getArch(), 'x64');
	assert.equal(Zotero.TyposUpdater.getInstallScope().scope, 'all');
});

test('glue: settings fall back to defaults and reject a bad repository', () => {
	let { Zotero } = setup({ prefs: { 'typosUpdate.repo': 'not a repo', 'typosUpdate.intervalHours': 'x' } });
	let s = Zotero.TyposUpdater.getSettings();
	assert.equal(s.repo, 'sozumen/typos-releases');
	assert.equal(s.intervalHours, 24);
	assert.equal(s.enabled, true);
	assert.equal(s.lastCheck, 0);
});

test('glue: a newer release prompts; "Not now" changes nothing but the check time', async () => {
	let { Zotero, log } = setup({ answers: [1] });
	let r = await Zotero.TyposUpdater.checkNow({ manual: false });
	assert.equal(r.kind, 'update');
	assert.equal(log.prompts.length, 1);
	assert.match(log.prompts[0].text, /Typos 10\.0\.7\.3 is available\. You have 10\.0\.7\.2\./);
	assert.equal(log.prompts[0].b0, 'Download and install');
	assert.equal(log.processes.length, 0);
	assert.equal(log.downloaded.length, 0);
	assert.ok(Number(log.prefs['typosUpdate.lastCheck']) > 0);
});

test('glue: "Skip this version" is remembered, and an automatic check stays quiet afterwards', async () => {
	let { Zotero, log } = setup({ answers: [2] });
	await Zotero.TyposUpdater.checkNow({ manual: false });
	assert.equal(log.prefs['typosUpdate.skipVersion'], '10.0.7.3');
	await Zotero.TyposUpdater.checkNow({ manual: false });
	assert.equal(log.prompts.length, 1);
	// A manual check still offers it
	await Zotero.TyposUpdater.checkNow({ manual: true });
	assert.equal(log.prompts.length, 2);
});

test('glue: "Download and install" downloads, checks, starts the installer with the right switches, then quits', async () => {
	let { Zotero, log, timeouts } = setup({ answers: [0] });
	await Zotero.TyposUpdater.checkNow({ manual: true });
	assert.equal(log.downloaded.length, 1);
	assert.equal(log.downloaded[0].url, BASE + NAME);
	assert.equal(log.downloaded[0].target, 'C:\\Temp\\Typos-update\\' + NAME);
	assert.deepEqual(log.processes, [{
		file: 'C:\\Temp\\Typos-update\\' + NAME, blocking: false, args: ['/AllUsers', '/Updating']
	}]);
	assert.equal(log.quits, 0);
	timeouts.forEach(t => t.fn());
	assert.equal(log.quits >= 1, true);
});

test('glue: a per-user install is updated per-user', async () => {
	let { Zotero, log } = setup({ appDir: 'C:\\Users\\Ann\\AppData\\Local\\Typos', answers: [0] });
	await Zotero.TyposUpdater.checkNow({ manual: true });
	assert.deepEqual(log.processes[0].args, ['/CurrentUser', '/Updating']);
});

test('glue: a wrong checksum stops everything and runs nothing', async () => {
	let { Zotero, log } = setup({ answers: [0, 1], sha: 'f'.repeat(64) });
	await Zotero.TyposUpdater.checkNow({ manual: true });
	assert.equal(log.processes.length, 0);
	assert.equal(log.quits, 0);
	assert.equal(log.prompts.length, 2);
	assert.equal(log.prompts[1].title, 'The update was not installed');
	assert.match(log.prompts[1].text, /does not match its published checksum/);
	assert.ok(log.removed.some(p => p.endsWith(NAME)));
});

test('glue: a failed download is reported and can open the release page', async () => {
	let { Zotero, log } = setup({ answers: [0, 0], downloadFails: true });
	await Zotero.TyposUpdater.checkNow({ manual: true });
	assert.equal(log.processes.length, 0);
	assert.deepEqual(log.urls, ['https://github.com/sozumen/typos-releases/releases/tag/v10.0.7.3']);
});

test('glue: a copy in some other folder opens the release page instead of installing', async () => {
	let { Zotero, log } = setup({ appDir: 'D:\\build\\Typos_win-x64', answers: [0] });
	await Zotero.TyposUpdater.checkNow({ manual: true });
	assert.equal(log.prompts[0].b0, 'Open release page');
	assert.equal(log.processes.length, 0);
	assert.equal(log.downloaded.length, 0);
	assert.equal(log.urls.length, 1);
});

test('glue: manual checks always answer; automatic checks are quiet unless there is an update', async () => {
	let { Zotero, log } = setup({ version: '10.0.7.3' });
	await Zotero.TyposUpdater.checkNow({ manual: false });
	assert.equal(log.alerts.length, 0);
	await Zotero.TyposUpdater.checkNow({ manual: true });
	assert.equal(log.alerts.length, 1);
	assert.match(log.alerts[0].text, /newest version \(10\.0\.7\.3\)/);

	({ Zotero, log } = setup({ responses: { [API]: new Error('offline') } }));
	await Zotero.TyposUpdater.checkNow({ manual: false });
	assert.equal(log.alerts.length, 0);
	assert.equal(log.prefs['typosUpdate.lastCheck'], undefined); // a failed check doesn't count
	await Zotero.TyposUpdater.checkNow({ manual: true });
	assert.equal(log.alerts.length, 1);
	assert.match(log.alerts[0].text, /Could not reach GitHub/);

	({ Zotero, log } = setup({ responses: { [API]: { status: 404, responseText: '' } } }));
	await Zotero.TyposUpdater.checkNow({ manual: true });
	assert.equal(log.alerts[0].title, 'No releases yet');
});

test('glue: a development build never checks automatically and says so when asked', async () => {
	let { Zotero, log } = setup({ version: '10.0.7.SOURCE' });
	await Zotero.TyposUpdater._tick();
	assert.equal(log.prompts.length + log.alerts.length, 0);
	assert.equal(log.prefs['typosUpdate.lastCheck'], undefined);
	await Zotero.TyposUpdater.checkNow({ manual: true });
	assert.equal(log.alerts[0].title, 'This is a development build');
});

test('glue: automatic checks respect the switch and the interval', async () => {
	let { Zotero, log } = setup({ prefs: { 'typosUpdate.enabled': false } });
	await Zotero.TyposUpdater._tick();
	assert.equal(log.prefs['typosUpdate.lastCheck'], undefined);

	({ Zotero, log } = setup({ prefs: { 'typosUpdate.lastCheck': String(Date.now() - 3600 * 1000) } }));
	await Zotero.TyposUpdater._tick();
	assert.equal(log.prompts.length, 0); // checked an hour ago
	({ Zotero, log } = setup({ prefs: { 'typosUpdate.lastCheck': String(Date.now() - 25 * 3600 * 1000) }, answers: [1] }));
	await Zotero.TyposUpdater._tick();
	assert.equal(log.prompts.length, 1);
});

test('glue: init schedules a cleanup and a first check; cleanup removes the download folder', async () => {
	let { Zotero, log, timeouts } = setup();
	Zotero.TyposUpdater.init();
	assert.equal(timeouts.length, 2);
	await Zotero.TyposUpdater._cleanUp();
	assert.deepEqual(log.removed, ['C:\\Temp\\Typos-update']);
});

test('glue: off Windows an update is announced but never installed', async () => {
	let { Zotero, log } = setup({ isWin: false, appDir: '/opt/typos', answers: [0] });
	let r = await Zotero.TyposUpdater.checkNow({ manual: true });
	assert.equal(r.kind, 'update-manual');
	assert.equal(log.prompts[0].b0, 'Open release page');
	assert.equal(log.processes.length, 0);
});

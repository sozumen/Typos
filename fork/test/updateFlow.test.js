'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const F = require('../../chrome/content/zotero/xpcom/typosUpdate/updateFlow.js');

const SUM = 'c'.repeat(64);
const NAME = 'Typos-10.0.7.3_x64_setup.exe';

function releaseJSON(extra = {}) {
	return Object.assign({
		tag_name: 'v10.0.7.3',
		draft: false,
		prerelease: false,
		html_url: 'https://github.com/sozumen/typos/releases/tag/v10.0.7.3',
		body: 'Notes',
		assets: [
			{ name: NAME, size: 5, browser_download_url: 'https://github.com/sozumen/typos/releases/download/v10.0.7.3/' + NAME },
			{ name: 'SHA256SUMS', size: 90, browser_download_url: 'https://github.com/sozumen/typos/releases/download/v10.0.7.3/SHA256SUMS' }
		]
	}, extra);
}

function requester(map) {
	let calls = [];
	let fn = async (url, options) => {
		calls.push({ url, options });
		let r = map[url];
		if (typeof r === 'function') r = r();
		if (r instanceof Error) throw r;
		if (!r) return { status: 404, text: '' };
		return r;
	};
	fn.calls = calls;
	return fn;
}

const API = 'https://api.github.com/repos/sozumen/typos/releases/latest';
const base = { repo: 'sozumen/typos', arch: 'x64' };

test('check: a newer release is reported with its installer', async () => {
	let request = requester({ [API]: { status: 200, text: JSON.stringify(releaseJSON()) } });
	let r = await F.check(Object.assign({ request, currentVersion: '10.0.7.2' }, base));
	assert.equal(r.kind, 'update');
	assert.equal(r.release.version, '10.0.7.3');
	assert.equal(r.release.installer.name, NAME);
	assert.equal(request.calls[0].options.headers.Accept, 'application/vnd.github+json');
});

test('check: up to date, skipped, and manual overriding a skip', async () => {
	let request = requester({ [API]: { status: 200, text: JSON.stringify(releaseJSON()) } });
	assert.equal((await F.check(Object.assign({ request, currentVersion: '10.0.7.3' }, base))).kind, 'up-to-date');
	assert.equal((await F.check(Object.assign({ request, currentVersion: '10.0.7.2', skippedVersion: '10.0.7.3' }, base))).kind, 'skipped');
	assert.equal((await F.check(Object.assign({ request, currentVersion: '10.0.7.2', skippedVersion: '10.0.7.3', manual: true }, base))).kind, 'update');
});

test('check: a source build is a development copy', async () => {
	let request = requester({ [API]: { status: 200, text: JSON.stringify(releaseJSON()) } });
	let r = await F.check(Object.assign({ request, currentVersion: '10.0.7.SOURCE' }, base));
	assert.equal(r.kind, 'dev-build');
	assert.equal(r.release.version, '10.0.7.3');
});

test('check: no releases yet', async () => {
	let request = requester({});
	assert.equal((await F.check(Object.assign({ request, currentVersion: '10.0.7.1' }, base))).kind, 'no-releases');
});

test('check: network failure, rate limit, server error, junk', async () => {
	let r = await F.check(Object.assign({ request: requester({ [API]: new Error('offline') }), currentVersion: '10.0.7.1' }, base));
	assert.equal(r.kind, 'error');
	assert.equal(r.error.kind, 'network');

	r = await F.check(Object.assign({ request: requester({ [API]: { status: 403, text: '{}' } }), currentVersion: '10.0.7.1' }, base));
	assert.equal(r.error.kind, 'rate-limit');

	r = await F.check(Object.assign({ request: requester({ [API]: { status: 500, text: '' } }), currentVersion: '10.0.7.1' }, base));
	assert.equal(r.error.kind, 'bad-reply');
	assert.match(r.error.message, /500/);

	r = await F.check(Object.assign({ request: requester({ [API]: { status: 200, text: '<html>' } }), currentVersion: '10.0.7.1' }, base));
	assert.equal(r.error.kind, 'bad-reply');

	r = await F.check(Object.assign({ request: requester({ [API]: { status: 200, text: '[]' } }), currentVersion: '10.0.7.1' }, base));
	assert.equal(r.error.kind, 'bad-reply');
});

test('check: a pre-release or draft is ignored, not offered', async () => {
	for (let extra of [{ prerelease: true }, { draft: true }, { tag_name: 'nightly' }]) {
		let request = requester({ [API]: { status: 200, text: JSON.stringify(releaseJSON(extra)) } });
		let r = await F.check(Object.assign({ request, currentVersion: '10.0.7.1' }, base));
		assert.equal(r.kind, 'ignored', JSON.stringify(extra));
	}
});

test('check: a release whose installer is not built yet is a manual update', async () => {
	let json = releaseJSON();
	json.assets = [];
	let request = requester({ [API]: { status: 200, text: JSON.stringify(json) } });
	let r = await F.check(Object.assign({ request, currentVersion: '10.0.7.1' }, base));
	assert.equal(r.kind, 'update-manual');
	assert.match(r.message, /no Typos-10\.0\.7\.3_x64_setup\.exe/);
	// ...but not if the person is already up to date
	r = await F.check(Object.assign({ request, currentVersion: '10.0.7.3' }, base));
	assert.equal(r.kind, 'up-to-date');
});

test('check: where an installer cannot run, a newer release is a manual update', async () => {
	let request = requester({ [API]: { status: 200, text: JSON.stringify(releaseJSON()) } });
	let r = await F.check({ request, repo: 'sozumen/typos', arch: null, currentVersion: '10.0.7.1' });
	assert.equal(r.kind, 'update-manual');
	assert.match(r.message, /Windows/);
});

test('check: an invalid repository name is a programming error, not a network call', async () => {
	let request = requester({});
	await assert.rejects(() => F.check({ request, repo: 'bad', arch: 'x64', currentVersion: '10.0.7.1' }), /repository/);
	assert.equal(request.calls.length, 0);
});

// ---------------------------------------------------------------- fetchInstaller

function installerHarness({ sums = SUM + '  ' + NAME + '\n', actual = SUM, size = 5, downloadFails = false } = {}) {
	let files = new Map();
	let release = F && require('../../chrome/content/zotero/xpcom/typosUpdate/updateLogic.js')
		.parseRelease(releaseJSON(), { arch: 'x64' }).release;
	let io = {
		release,
		dir: 'C:\\Temp\\Typos-update',
		join: (d, n) => d + '\\' + n,
		request: requester({ [release.checksumsURL]: { status: 200, text: sums } }),
		download: async (url, path) => {
			if (downloadFails) throw new Error('reset');
			files.set(path, { url });
		},
		sha256File: async () => actual,
		fileSize: async () => size,
		removeFile: async path => {
			if (!files.has(path)) throw new Error('missing');
			files.delete(path);
		}
	};
	return { io, files, release };
}

test('fetchInstaller: returns the path when the checksum matches', async () => {
	let { io, files } = installerHarness();
	let path = await F.fetchInstaller(io);
	assert.equal(path, 'C:\\Temp\\Typos-update\\' + NAME);
	assert.ok(files.has(path));
});

test('fetchInstaller: a wrong checksum deletes the file and throws', async () => {
	let { io, files } = installerHarness({ actual: 'd'.repeat(64) });
	await assert.rejects(() => F.fetchInstaller(io), e => e.kind === 'checksum-mismatch');
	assert.equal(files.size, 0);
});

test('fetchInstaller: a wrong size is caught before hashing', async () => {
	let { io, files } = installerHarness({ size: 4 });
	await assert.rejects(() => F.fetchInstaller(io), e => e.kind === 'size-mismatch');
	assert.equal(files.size, 0);
});

test('fetchInstaller: no checksum entry, no checksum file, no download', async () => {
	let { io } = installerHarness({ sums: SUM + '  Some-other-file.exe\n' });
	await assert.rejects(() => F.fetchInstaller(io), e => e.kind === 'checksum-missing');

	let h = installerHarness();
	h.io.request = requester({});
	await assert.rejects(() => F.fetchInstaller(h.io), e => e.kind === 'checksum-missing');
	assert.equal(h.files.size, 0);

	h = installerHarness();
	h.io.request = requester({ [h.release.checksumsURL]: new Error('offline') });
	await assert.rejects(() => F.fetchInstaller(h.io), e => e.kind === 'network');
});

test('fetchInstaller: a failed download leaves nothing behind', async () => {
	let { io, files } = installerHarness({ downloadFails: true });
	await assert.rejects(() => F.fetchInstaller(io), e => e.kind === 'network');
	assert.equal(files.size, 0);
});

test('fetchInstaller: refuses URLs outside GitHub and releases without files', async () => {
	let { io } = installerHarness();
	io.release = Object.assign({}, io.release, { installer: Object.assign({}, io.release.installer, { url: 'https://evil.example/x.exe' }) });
	await assert.rejects(() => F.fetchInstaller(io), e => e.kind === 'untrusted');

	await assert.rejects(() => F.fetchInstaller(Object.assign({}, io, { release: { installer: null } })), e => e.kind === 'no-installer');
});

test('fetchInstaller: removes a stale file from an earlier attempt before downloading', async () => {
	let h = installerHarness();
	let path = h.io.join(h.io.dir, NAME);
	h.files.set(path, { stale: true });
	await F.fetchInstaller(h.io);
	assert.equal(h.files.get(path).stale, undefined);
	assert.equal(h.files.get(path).url, h.release.installer.url);
});

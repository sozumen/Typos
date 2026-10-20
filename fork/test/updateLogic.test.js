'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const L = require('../../chrome/content/zotero/xpcom/typosUpdate/updateLogic.js');

const SUM = 'a'.repeat(64);

function release(overrides = {}) {
	return Object.assign({
		tag_name: 'v10.0.7.3',
		name: 'Typos 10.0.7.3',
		body: '## What changed\n\n- **Fixed** the thing',
		html_url: 'https://github.com/sozumen/typos/releases/tag/v10.0.7.3',
		draft: false,
		prerelease: false,
		published_at: '2026-10-20T12:00:00Z',
		assets: [
			{
				name: 'Typos-10.0.7.3_x64_setup.exe',
				size: 104857600,
				browser_download_url: 'https://github.com/sozumen/typos/releases/download/v10.0.7.3/Typos-10.0.7.3_x64_setup.exe'
			},
			{
				name: 'SHA256SUMS',
				size: 200,
				browser_download_url: 'https://github.com/sozumen/typos/releases/download/v10.0.7.3/SHA256SUMS'
			}
		]
	}, overrides);
}

test('parseVersion reads 2 to 4 numbers, with optional v / typos- prefix', () => {
	assert.deepEqual(L.parseVersion('10.0.7'), [10, 0, 7]);
	assert.deepEqual(L.parseVersion('v10.0.7.3'), [10, 0, 7, 3]);
	assert.deepEqual(L.parseVersion('typos-v10.0.7.3'), [10, 0, 7, 3]);
	assert.deepEqual(L.parseVersion(' 10.1 '), [10, 1]);
});

test('parseVersion refuses anything else, including source builds and pre-releases', () => {
	for (let bad of ['10', '10.0.7.SOURCE', '10.0.7-beta.1', 'latest', '', '1.2.3.4.5', '1..2', null, undefined, 7, '10.0.7+abc']) {
		assert.equal(L.parseVersion(bad), null, String(bad));
	}
});

test('compareVersions orders numerically, not as text, and pads with zeros', () => {
	assert.equal(L.compareVersions('10.0.7.2', '10.0.7.10'), -1);
	assert.equal(L.compareVersions('10.0.8', '10.0.7.9'), 1);
	assert.equal(L.compareVersions('10.0.7', '10.0.7.0'), 0);
	assert.equal(L.compareVersions('10.0.7', '10.0.7.1'), -1);
	assert.equal(L.compareVersions('11.0', '10.9.9.9'), 1);
	assert.equal(L.compareVersions([10, 0, 7, 3], 'v10.0.7.3'), 0);
	assert.throws(() => L.compareVersions('10.0.7.SOURCE', '10.0.7'), /Not a version/);
});

test('repository names and URLs', () => {
	assert.equal(L.isValidRepo('sozumen/typos'), true);
	assert.equal(L.isValidRepo('a/b/c'), false);
	assert.equal(L.isValidRepo('../x'), false);
	assert.equal(L.isValidRepo('sozumen/..'), false);
	assert.equal(L.isValidRepo('evil.com/x?y=1'), false);
	assert.equal(L.latestReleaseURL('sozumen/typos'), 'https://api.github.com/repos/sozumen/typos/releases/latest');
	assert.equal(L.releasesPageURL('sozumen/typos'), 'https://github.com/sozumen/typos/releases');
	assert.throws(() => L.latestReleaseURL('nope'), /repository/);
});

test('download URLs must be https on a GitHub host, with no credentials', () => {
	assert.equal(L.isTrustedDownloadURL('https://github.com/x/y/releases/download/v1/a.exe'), true);
	assert.equal(L.isTrustedDownloadURL('https://objects.githubusercontent.com/abc'), true);
	assert.equal(L.isTrustedDownloadURL('http://github.com/x/y/a.exe'), false);
	assert.equal(L.isTrustedDownloadURL('https://github.com.evil.example/a.exe'), false);
	assert.equal(L.isTrustedDownloadURL('https://evil.example/github.com/a.exe'), false);
	assert.equal(L.isTrustedDownloadURL('https://user:pw@github.com/a.exe'), false);
	assert.equal(L.isTrustedDownloadURL('file:///c:/a.exe'), false);
	assert.equal(L.isTrustedDownloadURL('not a url'), false);
	assert.equal(L.isTrustedDownloadURL(undefined), false);
});

test('archForPlatform', () => {
	assert.equal(L.archForPlatform('x86_64', true), 'x64');
	assert.equal(L.archForPlatform('aarch64', true), 'arm64');
	assert.equal(L.archForPlatform('x86', true), 'win32');
	assert.equal(L.archForPlatform('x86_64', false), null);
	assert.equal(L.archForPlatform('riscv', true), null);
});

test('parseRelease finds the installer and checksum file', () => {
	let r = L.parseRelease(release(), { arch: 'x64' });
	assert.equal(r.ok, true);
	assert.equal(r.release.version, '10.0.7.3');
	assert.deepEqual(r.release.parts, [10, 0, 7, 3]);
	assert.equal(r.release.installer.name, 'Typos-10.0.7.3_x64_setup.exe');
	assert.equal(r.release.installer.size, 104857600);
	assert.match(r.release.checksumsURL, /SHA256SUMS$/);
	assert.match(r.release.pageURL, /^https:\/\/github\.com\//);
});

test('parseRelease without an arch only reads the version', () => {
	let r = L.parseRelease(release({ assets: [] }), { arch: null });
	assert.equal(r.ok, true);
	assert.equal(r.release.installer, null);
});

test('parseRelease: wrong architecture, missing files and untrusted URLs', () => {
	let r = L.parseRelease(release(), { arch: 'arm64' });
	assert.equal(r.ok, false);
	assert.equal(r.reason, 'no-installer');
	assert.equal(r.release.version, '10.0.7.3'); // so the person can still be told

	let noSums = release();
	noSums.assets = noSums.assets.filter(a => a.name !== 'SHA256SUMS');
	assert.equal(L.parseRelease(noSums, { arch: 'x64' }).reason, 'no-checksums');

	let evil = release();
	evil.assets[0].browser_download_url = 'https://evil.example/Typos-10.0.7.3_x64_setup.exe';
	assert.equal(L.parseRelease(evil, { arch: 'x64' }).reason, 'no-installer');

	let evilSums = release();
	evilSums.assets[1].browser_download_url = 'http://github.com/x/SHA256SUMS';
	assert.equal(L.parseRelease(evilSums, { arch: 'x64' }).reason, 'no-checksums');
});

test('parseRelease: drafts, pre-releases, odd tags and nonsense', () => {
	assert.equal(L.parseRelease(release({ draft: true }), { arch: 'x64' }).reason, 'draft');
	assert.equal(L.parseRelease(release({ prerelease: true }), { arch: 'x64' }).reason, 'prerelease');
	assert.equal(L.parseRelease(release({ tag_name: 'nightly' }), { arch: 'x64' }).reason, 'no-version');
	for (let junk of [null, undefined, 'x', 5, {}, { tag_name: 5 }, []]) {
		assert.equal(L.parseRelease(junk, { arch: 'x64' }).reason, 'bad-reply', JSON.stringify(junk));
	}
});

test('parseRelease ignores an html_url that is not on github.com', () => {
	let r = L.parseRelease(release({ html_url: 'https://evil.example/' }), { arch: 'x64' });
	assert.equal(r.release.pageURL, null);
});

test('parseRelease does not take an installer for another version', () => {
	let rel = release();
	rel.assets[0].name = 'Typos-10.0.7.2_x64_setup.exe';
	assert.equal(L.parseRelease(rel, { arch: 'x64' }).reason, 'no-installer');
});

test('findChecksum reads sha256sum output in both modes', () => {
	let text = [
		SUM + '  Typos-10.0.7.3_x64_setup.exe',
		'B'.repeat(64) + ' *Typos-10.0.7.3_arm64_setup.exe',
		'not a checksum line',
		''
	].join('\r\n');
	assert.equal(L.findChecksum(text, 'Typos-10.0.7.3_x64_setup.exe'), SUM);
	assert.equal(L.findChecksum(text, 'Typos-10.0.7.3_arm64_setup.exe'), 'b'.repeat(64));
	assert.equal(L.findChecksum(text, 'Typos-10.0.7.3_win32_setup.exe'), null);
	assert.equal(L.findChecksum('', 'x'), null);
	assert.equal(L.findChecksum(null, 'x'), null);
});

test('findChecksum needs the whole file name and a full-length hash', () => {
	assert.equal(L.findChecksum('abc  setup.exe', 'setup.exe'), null);
	assert.equal(L.findChecksum(SUM + '  old-setup.exe', 'setup.exe'), null);
	assert.equal(L.findChecksum(SUM + '0  setup.exe', 'setup.exe'), null);
});

test('checksumMatches', () => {
	assert.equal(L.checksumMatches(SUM, SUM.toUpperCase()), true);
	assert.equal(L.checksumMatches(SUM, 'b'.repeat(64)), false);
	assert.equal(L.checksumMatches('', ''), false);
	assert.equal(L.checksumMatches(SUM, null), false);
	assert.equal(L.checksumMatches('xyz', 'xyz'), false);
});

test('decide: update, up to date, skipped, development copy', () => {
	let rel = L.parseRelease(release(), { arch: null }).release;
	assert.equal(L.decide('10.0.7.2', rel), 'update');
	assert.equal(L.decide('10.0.7', rel), 'update');
	assert.equal(L.decide('10.0.7.3', rel), 'up-to-date');
	assert.equal(L.decide('10.0.7.4', rel), 'up-to-date');
	assert.equal(L.decide('10.0.8', rel), 'up-to-date');
	assert.equal(L.decide('10.0.7.SOURCE', rel), 'unknown-current');
	assert.equal(L.decide('10.0.7.2', rel, { skippedVersion: '10.0.7.3' }), 'skipped');
	assert.equal(L.decide('10.0.7.2', rel, { skippedVersion: '10.0.7.3', manual: true }), 'update');
	// A skip applies to that version only
	assert.equal(L.decide('10.0.7.2', rel, { skippedVersion: '10.0.7.2' }), 'update');
	assert.equal(L.decide('10.0.7.2', rel, { skippedVersion: 'garbage' }), 'update');
});

test('isCheckDue', () => {
	let h = 3600 * 1000;
	assert.equal(L.isCheckDue(0, 1e12, 24), true);
	assert.equal(L.isCheckDue(NaN, 1e12, 24), true);
	assert.equal(L.isCheckDue(1e12 - 23 * h, 1e12, 24), false);
	assert.equal(L.isCheckDue(1e12 - 24 * h, 1e12, 24), true);
	assert.equal(L.isCheckDue(1e12 + h, 1e12, 24), true); // clock went backwards
	assert.equal(L.isCheckDue(1e12 - 2 * h, 1e12, 'junk'), false); // falls back to 24 hours
	assert.equal(L.isCheckDue(1e12 - 2 * h, 1e12, 0.5), true); // never more often than hourly, so 2 hours is due
	assert.equal(L.isCheckDue(1e12 - 0.5 * h, 1e12, 0.5), false);
});

test('installScope tells per-user from all-users installs', () => {
	let env = {
		programFiles: ['C:\\Program Files', 'C:\\Program Files (x86)', ''],
		localAppData: 'C:\\Users\\Ann\\AppData\\Local'
	};
	assert.deepEqual(L.installScope('C:\\Program Files\\Typos', env),
		{ scope: 'all', args: ['/AllUsers', '/Updating'] });
	assert.deepEqual(L.installScope('c:\\program files (x86)\\Typos\\', env),
		{ scope: 'all', args: ['/AllUsers', '/Updating'] });
	assert.deepEqual(L.installScope('C:\\Users\\Ann\\AppData\\Local\\Typos', env),
		{ scope: 'user', args: ['/CurrentUser', '/Updating'] });
	assert.deepEqual(L.installScope('C:/Users/Ann/AppData/Local/Typos', env),
		{ scope: 'user', args: ['/CurrentUser', '/Updating'] });
});

test('installScope: other places, and look-alike folder names, are not recognised', () => {
	let env = { programFiles: ['C:\\Program Files'], localAppData: 'C:\\Users\\Ann\\AppData\\Local' };
	assert.equal(L.installScope('D:\\build\\Typos_win-x64', env).scope, null);
	assert.equal(L.installScope('C:\\Program Files Extra\\Typos', env).scope, null);
	assert.equal(L.installScope('C:\\Users\\Ann\\AppData\\LocalLow\\Typos', env).scope, null);
	assert.equal(L.installScope('C:\\Program Files\\Typos', { programFiles: [], localAppData: '' }).scope, null);
	assert.deepEqual(L.installScope('', env), { scope: null, args: [] });
});

test('summarizeNotes makes Markdown readable and keeps it short', () => {
	let out = L.summarizeNotes('## What changed\r\n\r\n- **Fixed** the `thing` [see](https://x.example)\n<!-- hidden -->\n\n\n\nMore');
	assert.equal(out, 'What changed\n\n- Fixed the thing see\n\nMore');
	let long = ('Sentence number one is here. ').repeat(100);
	let cut = L.summarizeNotes(long, 200);
	assert.ok(cut.length <= 201);
	assert.ok(cut.endsWith('…'));
	assert.equal(L.summarizeNotes(null), '');
});

test('formatSize', () => {
	assert.equal(L.formatSize(104857600), '100 MB');
	assert.equal(L.formatSize(1536), '1.5 KB');
	assert.equal(L.formatSize(900), '900 bytes');
	assert.equal(L.formatSize(0), '');
	assert.equal(L.formatSize(null), '');
});

"use strict";

const test = require('node:test');
const assert = require('node:assert/strict');
const core = require('../../chrome/content/zotero/xpcom/backup/backupCore.js');

class FakeBackend {
	constructor() {
		this.snapshots = new Map(); // id -> { name, size }
		this.files = new Map(); // id -> { path, content }
		this.nextId = 1;
		this.failPaths = new Set();
		this.failSnapshotDelete = false;
	}
	async listSnapshots() {
		return [...this.snapshots].map(([id, s]) => ({ id, name: s.name, size: s.size }));
	}
	async uploadSnapshot(name, localPath) {
		let id = 's' + this.nextId++;
		this.snapshots.set(id, { name, size: localPath.length });
		return { id };
	}
	async deleteSnapshot(id) {
		if (this.failSnapshotDelete) throw new Error('nope');
		this.snapshots.delete(id);
	}
	async uploadFile(relPath, localPath, existingId) {
		if (this.failPaths.has(relPath)) throw new Error('upload failed');
		let id = existingId && this.files.has(existingId) ? existingId : 'f' + this.nextId++;
		this.files.set(id, { path: relPath, localPath });
		return { id };
	}
	async listFiles() {
		return new Map([...this.files].map(([id, f]) => [f.path, { id, size: f.size }]));
	}
}

function fakeDeps(extra = {}) {
	let removed = [];
	let t = Date.UTC(2026, 9, 17, 12, 0, 0);
	return {
		removed,
		deps: {
			makeSnapshot: async () => ({ path: '/tmp/snap.zip' }),
			removeLocal: async p => removed.push(p),
			now: () => new Date(t++ * 1), // unique, ascending
			...extra
		}
	};
}

test('snapshot names round-trip and sort chronologically', () => {
	let d = new Date(Date.UTC(2026, 0, 2, 3, 4, 5));
	let name = core.snapshotName(d);
	assert.equal(name, 'library-20260102-030405.zip');
	assert.equal(core.parseSnapshotName(name).getTime(), d.getTime());
	assert.equal(core.parseSnapshotName('library-20261301-000000.zip'), null);
	assert.equal(core.parseSnapshotName('notes.zip'), null);
});

test('selectSnapshotsToDelete keeps newest N and ignores foreign files', () => {
	let snaps = [
		{ id: 1, name: 'library-20260101-000000.zip' },
		{ id: 2, name: 'library-20260103-000000.zip' },
		{ id: 3, name: 'library-20260102-000000.zip' },
		{ id: 4, name: 'holiday-photos.zip' }
	];
	assert.deepEqual(core.selectSnapshotsToDelete(snaps, 2).map(s => s.id), [1]);
	assert.deepEqual(core.selectSnapshotsToDelete(snaps, 10), []);
	// Never deletes everything
	assert.deepEqual(core.selectSnapshotsToDelete(snaps, 0).map(s => s.id).sort(), [1, 3]);
});

test('shouldRunBackup', () => {
	let now = 10 * 24 * 3600 * 1000;
	assert.equal(core.shouldRunBackup({ now, lastRun: null, frequency: 'manual' }), false);
	assert.equal(core.shouldRunBackup({ now, lastRun: null, frequency: 'daily' }), true);
	assert.equal(core.shouldRunBackup({ now, lastRun: now - 3600e3, frequency: 'daily' }), false);
	assert.equal(core.shouldRunBackup({ now, lastRun: now - 25 * 3600e3, frequency: 'daily' }), true);
	assert.equal(core.shouldRunBackup({ now, lastRun: now - 2 * 24 * 3600e3, frequency: 'weekly' }), false);
	assert.throws(() => core.shouldRunBackup({ now, lastRun: 0, frequency: 'hourly' }));
});

test('normalizeRelPath rejects traversal and absolute paths', () => {
	assert.equal(core.normalizeRelPath('ABCD1234\\file.pdf'), 'ABCD1234/file.pdf');
	assert.equal(core.normalizeRelPath('./a//b'), 'a/b');
	for (let bad of ['../x', 'a/../../x', '/etc/passwd', 'C:\\x', '', '..', 'a\0b']) {
		assert.throws(() => core.normalizeRelPath(bad), undefined, bad);
	}
	assert.equal(core.safeJoin('/data/', 'a/b.txt'), '/data/a/b.txt');
	assert.throws(() => core.safeJoin('/data', '../evil'));
});

test('parseManifest tolerates damage', () => {
	assert.deepEqual(core.parseManifest(null), core.emptyManifest());
	assert.deepEqual(core.parseManifest('{not json'), core.emptyManifest());
	assert.deepEqual(core.parseManifest('{"version":99,"files":{}}'), core.emptyManifest());
	let m = { version: 1, files: { 'a/b': { size: 1, mtime: 2, remoteId: 'x' } } };
	assert.deepEqual(core.parseManifest(JSON.stringify(m)), m);
});

test('planFileSync uploads new and changed files only', () => {
	let manifest = {
		version: 1,
		files: {
			'A/one.pdf': { size: 10, mtime: 100, remoteId: 'r1' },
			'A/two.pdf': { size: 20, mtime: 200, remoteId: 'r2' }
		}
	};
	let local = [
		{ path: 'A/one.pdf', size: 10, mtime: 100 },
		{ path: 'A/two.pdf', size: 20, mtime: 201 },
		{ path: 'B/new.pdf', size: 5, mtime: 1 }
	];
	let { toUpload, unchanged } = core.planFileSync(local, manifest);
	assert.equal(unchanged, 1);
	assert.deepEqual(toUpload.map(f => [f.path, f.remoteId]), [['A/two.pdf', 'r2'], ['B/new.pdf', undefined]]);
});

test('planFileSync with remote listing re-uploads files missing from destination', () => {
	let manifest = { version: 1, files: { 'A/one.pdf': { size: 10, mtime: 100, remoteId: 'r1' } } };
	let local = [{ path: 'A/one.pdf', size: 10, mtime: 100 }];
	assert.equal(core.planFileSync(local, manifest, new Map()).toUpload.length, 1);
	assert.equal(core.planFileSync(local, manifest, new Map([['A/one.pdf', { id: 'r1', size: 10 }]])).toUpload.length, 0);
	assert.equal(core.planFileSync(local, manifest, new Map([['A/one.pdf', { id: 'r1', size: 3 }]])).toUpload.length, 1);
});

test('runBackup uploads snapshot, prunes, syncs files and cleans up', async () => {
	let backend = new FakeBackend();
	for (let d of ['20260101', '20260102', '20260103']) {
		await backend.uploadSnapshot(`library-${d}-000000.zip`, 'x');
	}
	let saved = [];
	let { deps, removed } = fakeDeps({
		backend,
		keepSnapshots: 2,
		listLocalFiles: async () => [
			{ path: 'A/one.pdf', size: 1, mtime: 1, absolutePath: '/s/A/one.pdf' },
			{ path: 'B/two.pdf', size: 2, mtime: 2, absolutePath: '/s/B/two.pdf' }
		],
		saveManifest: async m => saved.push(JSON.parse(JSON.stringify(m)))
	});
	let report = await core.runBackup(deps);
	assert.equal(report.files.uploaded, 2);
	assert.deepEqual(removed, ['/tmp/snap.zip']);
	assert.equal(backend.snapshots.size, 2);
	assert.ok([...backend.snapshots.values()].some(s => s.name === report.snapshot.name));
	assert.equal(report.prunedSnapshots.length, 2);
	assert.ok(saved.at(-1).files['A/one.pdf'].remoteId);

	// Second run with the saved manifest uploads nothing new
	let second = fakeDeps({
		backend,
		manifest: saved.at(-1),
		listLocalFiles: deps.listLocalFiles,
		now: () => new Date(Date.UTC(2026, 9, 18))
	});
	let report2 = await core.runBackup(second.deps);
	assert.equal(report2.files.uploaded, 0);
	assert.equal(report2.files.unchanged, 2);
});

test('runBackup: one failed file does not stop the rest; failed files stay out of the manifest', async () => {
	let backend = new FakeBackend();
	backend.failPaths.add('A/bad.pdf');
	let manifest = core.emptyManifest();
	let { deps } = fakeDeps({
		backend,
		manifest,
		listLocalFiles: async () => [
			{ path: 'A/bad.pdf', size: 1, mtime: 1, absolutePath: '/s/bad' },
			{ path: 'A/good.pdf', size: 1, mtime: 1, absolutePath: '/s/good' }
		]
	});
	let report = await core.runBackup(deps);
	assert.equal(report.files.uploaded, 1);
	assert.equal(report.files.failed.length, 1);
	assert.equal(report.files.failed[0].path, 'A/bad.pdf');
	assert.ok(!manifest.files['A/bad.pdf']);
	assert.ok(manifest.files['A/good.pdf']);
});

test('runBackup: snapshot failure is fatal and still removes the temp file', async () => {
	let backend = new FakeBackend();
	backend.uploadSnapshot = async () => { throw new Error('quota'); };
	let { deps, removed } = fakeDeps({ backend });
	await assert.rejects(() => core.runBackup(deps), /quota/);
	assert.deepEqual(removed, ['/tmp/snap.zip']);
});

test('runBackup: prune failure is a warning, not a failure', async () => {
	let backend = new FakeBackend();
	backend.failSnapshotDelete = true;
	for (let d of ['20250101', '20250102']) {
		await backend.uploadSnapshot(`library-${d}-000000.zip`, 'x');
	}
	let { deps } = fakeDeps({ backend, keepSnapshots: 1 });
	let report = await core.runBackup(deps);
	assert.equal(report.warnings.length, 1);
	assert.ok(report.snapshot);
});

test('runBackup honors cancellation between files', async () => {
	let backend = new FakeBackend();
	let n = 0;
	let { deps } = fakeDeps({
		backend,
		isCancelled: () => n++ >= 1,
		listLocalFiles: async () => [1, 2, 3].map(i => ({ path: `f${i}`, size: i, mtime: i, absolutePath: `/s/f${i}` }))
	});
	let report = await core.runBackup(deps);
	assert.equal(report.cancelled, true);
	assert.equal(report.files.uploaded, 1);
});

test('planFileSync adopts same-size remote files that have no manifest entry', () => {
	let local = [
		{ path: 'A/one.pdf', size: 10, mtime: 5 },
		{ path: 'A/two.pdf', size: 20, mtime: 6 },
		{ path: 'A/three.pdf', size: 30, mtime: 7 }
	];
	let remote = new Map([
		['A/one.pdf', { id: 'r1', size: 10 }],
		['A/two.pdf', { id: 'r2', size: 99 }]
	]);
	let { toUpload, adopt, unchanged } = core.planFileSync(local, core.emptyManifest(), remote);
	assert.deepEqual(adopt, [{ path: 'A/one.pdf', size: 10, mtime: 5, remoteId: 'r1' }]);
	// Different size: update the existing remote file rather than creating a duplicate
	assert.deepEqual(toUpload.map(f => [f.path, f.remoteId]), [['A/two.pdf', 'r2'], ['A/three.pdf', undefined]]);
	assert.equal(unchanged, 0);
});

test('runBackup after a lost manifest adopts existing remote files instead of duplicating', async () => {
	let backend = new FakeBackend();
	let files = [
		{ path: 'A/one.pdf', size: 4, mtime: 1, absolutePath: '/s/one' },
		{ path: 'A/two.pdf', size: 5, mtime: 1, absolutePath: '/s/two' }
	];
	let first = fakeDeps({ backend, listLocalFiles: async () => files });
	await core.runBackup(first.deps);
	assert.equal(backend.files.size, 2);
	
	// Manifest lost; remote listing says sizes (the fake doesn't track size, so supply it)
	for (let [id, f] of backend.files) f.size = files.find(x => x.path === f.path).size;
	let manifest = core.emptyManifest();
	let second = fakeDeps({ backend, manifest, verifyRemote: true, listLocalFiles: async () => files });
	let report = await core.runBackup(second.deps);
	assert.equal(report.files.uploaded, 0);
	assert.equal(backend.files.size, 2);
	assert.ok(manifest.files['A/one.pdf'].remoteId);
});

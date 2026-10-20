"use strict";

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

globalThis.BackupCore = require('../../chrome/content/zotero/xpcom/backup/backupCore.js');
const { LocalFolderBackend } = require('../../chrome/content/zotero/xpcom/backup/localFolder.js');

const io = {
	join: (...p) => path.join(...p),
	parent: p => path.dirname(p),
	mkdirp: async p => fs.mkdirSync(p, { recursive: true }),
	copy: async (a, b) => fs.copyFileSync(a, b),
	move: async (a, b) => fs.renameSync(a, b),
	remove: async p => fs.rmSync(p, { force: true }),
	list: async d => {
		if (!fs.existsSync(d)) return [];
		return fs.readdirSync(d, { withFileTypes: true }).map(e => ({
			name: e.name,
			isDir: e.isDirectory(),
			size: e.isFile() ? fs.statSync(path.join(d, e.name)).size : 0
		}));
	}
};

function setup() {
	let tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lfb-'));
	let src = path.join(tmp, 'src.bin');
	fs.writeFileSync(src, 'hello');
	return { tmp, src, backend: new LocalFolderBackend({ dir: path.join(tmp, 'dest'), io }) };
}

test('snapshots: upload, list, download, delete', async () => {
	let { tmp, src, backend } = setup();
	assert.deepEqual(await backend.listSnapshots(), []);
	let { id } = await backend.uploadSnapshot('library-20260101-000000.zip', src);
	assert.equal(id, 'snapshots/library-20260101-000000.zip');
	assert.deepEqual(await backend.listSnapshots(), [{ id, name: 'library-20260101-000000.zip', size: 5 }]);
	let out = path.join(tmp, 'restored');
	await backend.downloadSnapshot(id, out);
	assert.equal(fs.readFileSync(out, 'utf8'), 'hello');
	await backend.deleteSnapshot(id);
	await backend.deleteSnapshot(id);
	assert.deepEqual(await backend.listSnapshots(), []);
});

test('files keep their directory structure and are listed by relative path', async () => {
	let { tmp, src, backend } = setup();
	await backend.uploadFile('ABCD1234/paper.pdf', src);
	await backend.uploadFile('EFGH5678/notes.txt', src);
	let files = await backend.listFiles();
	assert.deepEqual([...files.keys()].sort(), ['ABCD1234/paper.pdf', 'EFGH5678/notes.txt']);
	assert.equal(files.get('ABCD1234/paper.pdf').size, 5);
	let out = path.join(tmp, 'x', 'y', 'paper.pdf');
	await backend.downloadFile(files.get('ABCD1234/paper.pdf').id, out);
	assert.equal(fs.readFileSync(out, 'utf8'), 'hello');
});

test('overwriting a file replaces it; no .partial files are left or listed', async () => {
	let { tmp, src, backend } = setup();
	await backend.uploadFile('K/a.txt', src);
	fs.writeFileSync(src, 'changed!');
	await backend.uploadFile('K/a.txt', src);
	let files = await backend.listFiles();
	assert.equal(files.get('K/a.txt').size, 8);
	fs.writeFileSync(path.join(tmp, 'dest', 'files', 'K', 'b.txt.partial'), 'junk');
	assert.deepEqual([...(await backend.listFiles()).keys()], ['K/a.txt']);
});

test('refuses path traversal in IDs and relative paths', async () => {
	let { src, backend } = setup();
	await assert.rejects(backend.uploadFile('../escape.txt', src), /Unsafe/);
	await assert.rejects(backend.deleteFile('../../etc/passwd'), /Unsafe/);
	await assert.rejects(backend.downloadSnapshot('/abs/path', '/tmp/x'), /Unsafe/);
});

test('works end to end with runBackup', async () => {
	let { tmp, backend } = setup();
	let storage = path.join(tmp, 'storage');
	fs.mkdirSync(path.join(storage, 'AAAA1111'), { recursive: true });
	fs.writeFileSync(path.join(storage, 'AAAA1111', 'a.pdf'), 'pdf');
	let snap = path.join(tmp, 'snap.zip');
	fs.writeFileSync(snap, 'zip');
	let report = await BackupCore.runBackup({
		backend,
		makeSnapshot: async () => ({ path: snap }),
		removeLocal: async p => fs.rmSync(p, { force: true }),
		listLocalFiles: async () => [{
			path: 'AAAA1111/a.pdf', size: 3, mtime: 1, absolutePath: path.join(storage, 'AAAA1111', 'a.pdf')
		}]
	});
	assert.equal(report.files.uploaded, 1);
	assert.equal((await backend.listSnapshots()).length, 1);
	assert.ok(!fs.existsSync(snap), 'temp snapshot removed');
});

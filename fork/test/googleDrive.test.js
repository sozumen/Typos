"use strict";

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const drive = require('../../chrome/content/zotero/xpcom/backup/googleDrive.js');

const FOLDER = 'application/vnd.google-apps.folder';

/** Minimal in-memory imitation of the parts of Drive v3 that the backend uses */
class FakeDrive {
	constructor() {
		this.files = new Map(); // id -> { id, name, mimeType, parents, content }
		this.sessions = new Map(); // location -> { target, name, parents, size, received: [] }
		this.n = 1;
		this.requests = [];
		this.failNext = []; // statuses to return before behaving
		this.validToken = 'tok1';
		this.tokenRequests = 0;
	}

	id(prefix) {
		return prefix + this.n++;
	}

	ok(obj, status = 200, headers = {}) {
		return { status, headers, text: JSON.stringify(obj) };
	}

	async http({ method, url, headers = {}, body }) {
		this.requests.push({ method, url, headers, body });
		let u = new URL(url);
		if (u.origin === 'https://oauth2.googleapis.com') {
			this.tokenRequests++;
			let form = new URLSearchParams(body);
			if (form.get('refresh_token') === 'revoked') {
				return this.ok({ error: 'invalid_grant' }, 400);
			}
			this.validToken = 'tok' + (this.tokenRequests + 1);
			return this.ok({ access_token: this.validToken, expires_in: 3600, refresh_token: 'rt' });
		}
		if (headers.Authorization !== 'Bearer ' + this.validToken) {
			return this.ok({ error: { message: 'Invalid Credentials' } }, 401);
		}
		if (this.failNext.length) {
			return this.ok({ error: { message: 'boom' } }, this.failNext.shift());
		}
		let path = u.pathname;

		if (path === '/drive/v3/files' && method === 'GET') {
			let q = u.searchParams.get('q');
			let parent = /'((?:\\.|[^'\\])*)' in parents/.exec(q)[1];
			let nameMatch = /^name = '((?:\\.|[^'\\])*)'/.exec(q);
			let name = nameMatch && nameMatch[1].replace(/\\(.)/g, '$1');
			let wantFolder = q.includes(`mimeType = '${FOLDER}'`);
			let all = [...this.files.values()].filter(f => f.parents.includes(parent)
				&& (wantFolder ? f.mimeType === FOLDER : f.mimeType !== FOLDER)
				&& (!name || f.name === name));
			// Paginate at 2 to exercise nextPageToken
			let start = Number(u.searchParams.get('pageToken') || 0);
			let page = all.slice(start, start + 2);
			let out = { files: page.map(f => ({ id: f.id, name: f.name, size: String(f.content?.length ?? 0) })) };
			if (start + 2 < all.length) out.nextPageToken = String(start + 2);
			return this.ok(out);
		}
		if (path === '/drive/v3/files' && method === 'POST') {
			let meta = JSON.parse(body);
			let f = { id: this.id('d'), ...meta, content: null };
			this.files.set(f.id, f);
			return this.ok({ id: f.id });
		}
		if (path.startsWith('/drive/v3/files/') && method === 'DELETE') {
			let id = path.split('/').pop();
			if (!this.files.has(id)) return this.ok({ error: { message: 'not found' } }, 404);
			this.files.delete(id);
			return { status: 204, headers: {}, text: '' };
		}
		if (path.startsWith('/upload/')) {
			if (path.startsWith('/upload/drive/v3/files') && u.searchParams.get('uploadType') === 'resumable'
					&& (method === 'POST' || method === 'PATCH')) {
				let meta = JSON.parse(body);
				let target = null;
				if (method === 'PATCH') {
					target = path.split('/').pop();
					if (!this.files.has(target)) return this.ok({ error: { message: 'not found' } }, 404);
				}
				let loc = 'https://www.googleapis.com/upload/session/' + this.id('sess');
				this.sessions.set(loc, {
					target, name: meta.name, parents: meta.parents,
					size: Number(headers['X-Upload-Content-Length']), received: []
				});
				return { status: 200, headers: { location: loc }, text: '' };
			}
			if (method === 'PUT') {
				let s = this.sessions.get(url);
				if (!s) return this.ok({}, 404);
				let range = headers['Content-Range'];
				if (s.size === 0) {
					return this._finish(s, url);
				}
				let m = /bytes (\d+)-(\d+)\/(\d+)/.exec(range);
				assert.equal(Number(m[1]), Buffer.concat(s.received).length, 'chunks arrive in order');
				s.received.push(Buffer.from(body));
				let have = Buffer.concat(s.received).length;
				if (have < s.size) {
					return { status: 308, headers: { range: `bytes=0-${have - 1}` }, text: '' };
				}
				return this._finish(s, url);
			}
		}
		return this.ok({ error: { message: 'unhandled ' + method + ' ' + url } }, 400);
	}

	_finish(s, loc) {
		let content = Buffer.concat(s.received);
		let f;
		if (s.target) {
			f = this.files.get(s.target);
			f.name = s.name;
			f.content = content;
		}
		else {
			f = { id: this.id('d'), name: s.name, mimeType: 'application/octet-stream', parents: s.parents, content };
			this.files.set(f.id, f);
		}
		this.sessions.delete(loc);
		return this.ok({ id: f.id }, s.target ? 200 : 201);
	}
}

function makeBackend(fake, localFiles = {}, extra = {}) {
	let tm = new drive.TokenManager({
		http: o => fake.http(o), clientId: 'cid', clientSecret: 'sec', refreshToken: 'rt'
	});
	let sleeps = [];
	let backend = new drive.GoogleDriveBackend({
		http: o => fake.http(o),
		getAccessToken: () => tm.getAccessToken(),
		invalidateToken: () => tm.invalidate(),
		readChunk: async (p, off, len) => localFiles[p].subarray(off, off + len),
		fileSize: async p => localFiles[p].length,
		download: async ({ url, destPath }) => {
			let id = decodeURIComponent(/files\/([^?]+)/.exec(url)[1]);
			let f = fake.files.get(id);
			if (!f) return { status: 404 };
			localFiles[destPath] = f.content;
			return { status: 200 };
		},
		sleep: async ms => sleeps.push(ms),
		chunkSize: 4,
		...extra
	});
	return { backend, sleeps, tm };
}

test('PKCE challenge is S256 of the verifier and URL carries the right parameters', async () => {
	let sha = async s => crypto.createHash('sha256').update(s).digest();
	let { verifier, challenge, state } = await drive.createPKCE(n => crypto.randomBytes(n), sha);
	assert.match(verifier, /^[A-Za-z0-9_-]{43,128}$/);
	assert.equal(challenge, crypto.createHash('sha256').update(verifier).digest('base64url'));
	let url = new URL(drive.buildAuthURL({
		clientId: 'cid', redirectUri: 'http://127.0.0.1:23119/cb', challenge, state
	}));
	assert.equal(url.searchParams.get('scope'), 'https://www.googleapis.com/auth/drive.file');
	assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
	assert.equal(url.searchParams.get('access_type'), 'offline');
	assert.equal(url.searchParams.get('state'), state);
});

test('exchangeCode returns tokens or a readable error', async () => {
	let ok = await drive.exchangeCode({
		http: async () => ({ status: 200, headers: {}, text: '{"access_token":"a","refresh_token":"r","expires_in":5}' }),
		clientId: 'c', clientSecret: 's', code: 'x', redirectUri: 'u', verifier: 'v'
	});
	assert.deepEqual(ok, { accessToken: 'a', refreshToken: 'r', expiresIn: 5 });
	await assert.rejects(drive.exchangeCode({
		http: async () => ({ status: 400, headers: {}, text: '{"error":"invalid_grant","error_description":"Bad code"}' }),
		clientId: 'c', clientSecret: 's', code: 'x', redirectUri: 'u', verifier: 'v'
	}), /Bad code/);
});

test('TokenManager caches, refreshes before expiry, and reports revocation', async () => {
	let fake = new FakeDrive();
	let t = 0;
	let tm = new drive.TokenManager({
		http: o => fake.http(o), clientId: 'c', clientSecret: 's', refreshToken: 'rt', now: () => t
	});
	let a = await tm.getAccessToken();
	assert.equal(await tm.getAccessToken(), a);
	assert.equal(fake.tokenRequests, 1);
	t = 3600 * 1000 - 30000; // inside the one-minute early-refresh window
	assert.notEqual(await tm.getAccessToken(), a);
	let bad = new drive.TokenManager({ http: o => fake.http(o), clientId: 'c', clientSecret: 's', refreshToken: 'revoked' });
	await assert.rejects(bad.getAccessToken(), /sign in again/);
});

test('uploads a multi-chunk snapshot into snapshots/ and lists it back', async () => {
	let fake = new FakeDrive();
	let local = { '/tmp/a.zip': Buffer.from('0123456789') };
	let { backend } = makeBackend(fake, local);
	let { id } = await backend.uploadSnapshot('library-20260101-000000.zip', '/tmp/a.zip');
	assert.equal(fake.files.get(id).content.toString(), '0123456789');
	let list = await backend.listSnapshots();
	assert.deepEqual(list, [{ id, name: 'library-20260101-000000.zip', size: 10 }]);
	// Folder structure: root > snapshots
	let snapFolder = [...fake.files.values()].find(f => f.name === 'snapshots');
	let rootFolder = [...fake.files.values()].find(f => f.name === 'Typos Backup');
	assert.deepEqual(snapFolder.parents, [rootFolder.id]);
	assert.deepEqual(rootFolder.parents, ['root']);
});

test('reuses existing folders instead of creating duplicates', async () => {
	let fake = new FakeDrive();
	let local = { '/a': Buffer.from('x') };
	await makeBackend(fake, local).backend.uploadFile('A/one.txt', '/a');
	await makeBackend(fake, local).backend.uploadFile('A/two.txt', '/a');
	let folders = [...fake.files.values()].filter(f => f.mimeType === FOLDER);
	assert.equal(folders.length, 2); // root + files
});

test('re-uploading with an existing ID updates in place; stale ID creates a new file', async () => {
	let fake = new FakeDrive();
	let local = { '/a': Buffer.from('v1'), '/b': Buffer.from('version two') };
	let { backend } = makeBackend(fake, local);
	let { id } = await backend.uploadFile('A/x.txt', '/a');
	let again = await backend.uploadFile('A/x.txt', '/b', id);
	assert.equal(again.id, id);
	assert.equal(fake.files.get(id).content.toString(), 'version two');
	let fresh = await backend.uploadFile('A/x.txt', '/b', 'gone');
	assert.notEqual(fresh.id, id);
});

test('empty files upload', async () => {
	let fake = new FakeDrive();
	let { backend } = makeBackend(fake, { '/e': Buffer.alloc(0) });
	let { id } = await backend.uploadFile('empty.txt', '/e');
	assert.equal(fake.files.get(id).content.length, 0);
});

test('listFiles follows pagination and keys by relative path', async () => {
	let fake = new FakeDrive();
	let local = { '/a': Buffer.from('abc') };
	let { backend } = makeBackend(fake, local);
	for (let i = 0; i < 5; i++) await backend.uploadFile(`K${i}/f.pdf`, '/a');
	let files = await backend.listFiles();
	assert.equal(files.size, 5);
	assert.equal(files.get('K3/f.pdf').size, 3);
});

test('a 401 triggers one token refresh and a retry', async () => {
	let fake = new FakeDrive();
	let { backend, tm } = makeBackend(fake, { '/a': Buffer.from('x') });
	await tm.getAccessToken();
	fake.validToken = 'rotated-elsewhere';
	// Next refresh will mint a valid token, so the retry succeeds
	await backend.listSnapshots();
	assert.ok(fake.tokenRequests >= 2);
});

test('retries 5xx with backoff and gives up with a clear error', async () => {
	let fake = new FakeDrive();
	let { backend, sleeps } = makeBackend(fake, {});
	fake.failNext = [503, 500];
	await backend.listSnapshots();
	assert.equal(sleeps.length, 2);
	assert.ok(sleeps[1] > sleeps[0]);

	fake.failNext = [500, 500, 500, 500, 500, 500];
	await assert.rejects(backend.listSnapshots(), err => err.status === 500 && /boom/.test(err.message));
});

test('does not retry client errors', async () => {
	let fake = new FakeDrive();
	let { backend, sleeps } = makeBackend(fake, {});
	fake.failNext = [400];
	await assert.rejects(backend.listSnapshots(), /400/);
	assert.equal(sleeps.length, 0);
});

test('delete tolerates already-deleted files; download round-trips', async () => {
	let fake = new FakeDrive();
	let local = { '/a': Buffer.from('payload') };
	let { backend } = makeBackend(fake, local);
	let { id } = await backend.uploadSnapshot('library-20260101-000000.zip', '/a');
	await backend.downloadSnapshot(id, '/restored.zip');
	assert.equal(local['/restored.zip'].toString(), 'payload');
	await backend.deleteSnapshot(id);
	await backend.deleteSnapshot(id); // 404 is fine
	await assert.rejects(backend.downloadSnapshot(id, '/x'), /404/);
});

test('folder names with quotes are escaped in queries', async () => {
	assert.equal(drive.escapeQuery("it's a \\ test"), "it\\'s a \\\\ test");
	let fake = new FakeDrive();
	let { backend } = makeBackend(fake, {}, { folderName: "Joe's backup" });
	await backend.listSnapshots();
	await backend.listSnapshots();
	let created = [...fake.files.values()].filter(f => f.name === "Joe's backup");
	assert.equal(created.length, 1);
});

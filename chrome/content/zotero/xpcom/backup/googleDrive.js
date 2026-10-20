"use strict";

/**
 * Google Drive backup backend and OAuth helpers
 *
 * No Zotero or Mozilla dependencies: HTTP, file access, hashing and sleeping are passed in, so the
 * whole thing runs in Node against a fake Drive (see fork/test/googleDrive.test.js).
 *
 * Uses the Drive v3 REST API with the narrow `drive.file` scope, which only lets the app see
 * files it created itself. A backup folder made by a previous install of this app can't be seen
 * with that scope, so restoring on a new machine works after signing in with the same client ID.
 *
 * Layout in Drive:
 *   <folderName>/snapshots/library-YYYYMMDD-HHMMSS.zip
 *   <folderName>/files/<relative path of each attachment file>
 *
 * Injected `http` function:
 *   async ({ method, url, headers, body }) => { status, headers (lowercase keys), text }
 *   `body` is a string or Uint8Array. It must not throw for non-2xx statuses.
 */
(function (root) {
	const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
	const TOKEN_URL = 'https://oauth2.googleapis.com/token';
	const API = 'https://www.googleapis.com/drive/v3';
	const UPLOAD_API = 'https://www.googleapis.com/upload/drive/v3';
	const SCOPE = 'https://www.googleapis.com/auth/drive.file';
	const FOLDER_MIME = 'application/vnd.google-apps.folder';
	const CHUNK_SIZE = 8 * 1024 * 1024; // must be a multiple of 256 KiB
	const MAX_ATTEMPTS = 5;


	class DriveError extends Error {
		constructor(message, status, body) {
			super(message);
			this.name = 'DriveError';
			this.status = status;
			this.body = body;
		}
	}


	//
	// OAuth (installed-app flow with PKCE and a loopback redirect)
	//

	function _base64url(bytes) {
		let s = '';
		for (let b of bytes) s += String.fromCharCode(b);
		let b64 = typeof btoa === 'function' ? btoa(s) : Buffer.from(s, 'binary').toString('base64');
		return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
	}


	/**
	 * @param {Function} randomBytes - n => Uint8Array
	 * @param {Function} sha256 - async Uint8Array|String => Uint8Array
	 * @return {Promise<{ verifier, challenge, state }>}
	 */
	async function createPKCE(randomBytes, sha256) {
		let verifier = _base64url(randomBytes(48)); // 64 chars, within RFC 7636's 43-128
		let challenge = _base64url(await sha256(verifier));
		let state = _base64url(randomBytes(16));
		return { verifier, challenge, state };
	}


	function buildAuthURL({ clientId, redirectUri, challenge, state, loginHint }) {
		let params = new URLSearchParams({
			client_id: clientId,
			redirect_uri: redirectUri,
			response_type: 'code',
			scope: SCOPE,
			code_challenge: challenge,
			code_challenge_method: 'S256',
			state,
			// offline + consent so Google actually returns a refresh token
			access_type: 'offline',
			prompt: 'consent'
		});
		if (loginHint) params.set('login_hint', loginHint);
		return AUTH_URL + '?' + params.toString();
	}


	function _form(obj) {
		return new URLSearchParams(obj).toString();
	}


	function _parseJSON(text) {
		try {
			return text ? JSON.parse(text) : {};
		}
		catch (e) {
			return {};
		}
	}


	async function exchangeCode({ http, clientId, clientSecret, code, redirectUri, verifier }) {
		let res = await http({
			method: 'POST',
			url: TOKEN_URL,
			headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
			body: _form({
				client_id: clientId,
				client_secret: clientSecret,
				code,
				redirect_uri: redirectUri,
				grant_type: 'authorization_code',
				code_verifier: verifier
			})
		});
		let data = _parseJSON(res.text);
		if (res.status !== 200 || !data.access_token) {
			throw new DriveError(
				"Google sign-in failed: " + (data.error_description || data.error || res.status),
				res.status, data
			);
		}
		return {
			accessToken: data.access_token,
			refreshToken: data.refresh_token || null,
			expiresIn: data.expires_in
		};
	}


	/**
	 * Keeps an access token fresh from a stored refresh token
	 */
	class TokenManager {
		constructor({ http, clientId, clientSecret, refreshToken, now = Date.now }) {
			this._http = http;
			this._clientId = clientId;
			this._clientSecret = clientSecret;
			this._refreshToken = refreshToken;
			this._now = now;
			this._token = null;
			this._expires = 0;
		}

		invalidate() {
			this._token = null;
		}

		async getAccessToken() {
			// Refresh a minute early so a token can't expire mid-request
			if (this._token && this._now() < this._expires - 60000) {
				return this._token;
			}
			if (!this._refreshToken) {
				throw new DriveError("Not signed in to Google Drive", 401);
			}
			let res = await this._http({
				method: 'POST',
				url: TOKEN_URL,
				headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
				body: _form({
					client_id: this._clientId,
					client_secret: this._clientSecret,
					refresh_token: this._refreshToken,
					grant_type: 'refresh_token'
				})
			});
			let data = _parseJSON(res.text);
			if (res.status !== 200 || !data.access_token) {
				let revoked = data.error === 'invalid_grant';
				throw new DriveError(
					revoked
						? "Google Drive access was revoked or expired -- sign in again"
						: "Couldn't refresh Google access: " + (data.error_description || data.error || res.status),
					res.status, data
				);
			}
			this._token = data.access_token;
			this._expires = this._now() + (data.expires_in || 3600) * 1000;
			return this._token;
		}
	}


	//
	// Drive backend
	//

	/** Escape a value for use inside single quotes in a Drive query */
	function escapeQuery(value) {
		return String(value).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
	}


	class GoogleDriveBackend {
		/**
		 * @param {Object} options
		 * @param {Function} options.http
		 * @param {Function} options.getAccessToken - async () => String
		 * @param {Function} [options.invalidateToken] - Called after a 401 so the next call refreshes
		 * @param {Function} options.readChunk - async (path, offset, length) => Uint8Array
		 * @param {Function} options.fileSize - async path => Number
		 * @param {Function} options.download - async ({ url, headers, destPath }) => { status }
		 * @param {String} [options.folderName='Typos Backup']
		 * @param {Function} [options.sleep]
		 */
		constructor(options) {
			this._http = options.http;
			this._getToken = options.getAccessToken;
			this._invalidate = options.invalidateToken || (() => {});
			this._readChunk = options.readChunk;
			this._fileSize = options.fileSize;
			this._download = options.download;
			this._folderName = options.folderName || 'Typos Backup';
			this._sleep = options.sleep || (ms => new Promise(resolve => setTimeout(resolve, ms)));
			this._folders = {};
			this.chunkSize = options.chunkSize || CHUNK_SIZE;
		}

		//
		// Request plumbing
		//

		/**
		 * Authenticated request with retry on 401 (once), 429 and 5xx
		 * @return {Promise<{ status, headers, text }>} - Only 2xx (and any in `accept`) returned
		 */
		async _request({ method, url, headers = {}, body, accept = [] }) {
			let refreshed = false;
			for (let attempt = 1; ; attempt++) {
				let token = await this._getToken();
				let res = await this._http({
					method,
					url,
					headers: { ...headers, Authorization: 'Bearer ' + token },
					body
				});
				if ((res.status >= 200 && res.status < 300) || accept.includes(res.status)) {
					return res;
				}
				if (res.status === 401 && !refreshed) {
					refreshed = true;
					this._invalidate();
					continue;
				}
				let retriable = res.status === 429 || res.status >= 500
					|| (res.status === 403 && /rateLimitExceeded|userRateLimitExceeded/.test(res.text || ''));
				if (retriable && attempt < MAX_ATTEMPTS) {
					await this._sleep(Math.min(30000, 500 * 2 ** attempt));
					continue;
				}
				let detail = _parseJSON(res.text).error;
				throw new DriveError(
					`Google Drive ${method} failed (${res.status})`
						+ (detail?.message ? ': ' + detail.message : ''),
					res.status,
					res.text
				);
			}
		}

		async _json(options) {
			return _parseJSON((await this._request(options)).text);
		}

		//
		// Folders
		//

		async _findFolder(name, parentId) {
			let q = `name = '${escapeQuery(name)}' and mimeType = '${FOLDER_MIME}'`
				+ ` and '${escapeQuery(parentId)}' in parents and trashed = false`;
			let data = await this._json({
				method: 'GET',
				url: `${API}/files?` + _form({ q, fields: 'files(id,name)', pageSize: '10', spaces: 'drive' })
			});
			return data.files?.[0]?.id || null;
		}

		async _ensureFolder(name, parentId) {
			let id = await this._findFolder(name, parentId);
			if (id) return id;
			let data = await this._json({
				method: 'POST',
				url: `${API}/files?fields=id`,
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ name, mimeType: FOLDER_MIME, parents: [parentId] })
			});
			return data.id;
		}

		/** @param {'root'|'snapshots'|'files'} kind */
		async _folder(kind) {
			if (this._folders[kind]) return this._folders[kind];
			if (kind === 'root') {
				this._folders.root = await this._ensureFolder(this._folderName, 'root');
			}
			else {
				let rootId = await this._folder('root');
				this._folders[kind] = await this._ensureFolder(kind, rootId);
			}
			return this._folders[kind];
		}

		async _list(parentId) {
			let out = [];
			let pageToken;
			do {
				let params = {
					q: `'${escapeQuery(parentId)}' in parents and trashed = false and mimeType != '${FOLDER_MIME}'`,
					fields: 'nextPageToken,files(id,name,size)',
					pageSize: '1000',
					spaces: 'drive'
				};
				if (pageToken) params.pageToken = pageToken;
				let data = await this._json({ method: 'GET', url: `${API}/files?` + _form(params) });
				out.push(...(data.files || []));
				pageToken = data.nextPageToken;
			} while (pageToken);
			return out;
		}

		//
		// Upload
		//

		async _upload({ parentId, name, localPath, existingId }) {
			let size = await this._fileSize(localPath);

			// Start a resumable session. Updating an existing file keeps its ID (and so its
			// history and any sharing), and a stale ID falls back to creating a new file.
			let start = async id => this._request({
				method: id ? 'PATCH' : 'POST',
				url: id
					? `${UPLOAD_API}/files/${encodeURIComponent(id)}?uploadType=resumable&fields=id`
					: `${UPLOAD_API}/files?uploadType=resumable&fields=id`,
				headers: {
					'Content-Type': 'application/json; charset=UTF-8',
					'X-Upload-Content-Length': String(size)
				},
				body: JSON.stringify(id ? { name } : { name, parents: [parentId] }),
				accept: id ? [404] : []
			});
			let res = await start(existingId);
			if (res.status === 404) res = await start(null);
			let location = res.headers['location'];
			if (!location) throw new DriveError("Google Drive didn't return an upload location", res.status);

			if (size === 0) {
				let done = await this._request({ method: 'PUT', url: location, headers: { 'Content-Length': '0' } });
				return { id: _parseJSON(done.text).id };
			}

			let offset = 0;
			while (offset < size) {
				let length = Math.min(this.chunkSize, size - offset);
				let chunk = await this._readChunk(localPath, offset, length);
				let last = offset + length >= size;
				let put = await this._request({
					method: 'PUT',
					url: location,
					headers: { 'Content-Range': `bytes ${offset}-${offset + length - 1}/${size}` },
					body: chunk,
					accept: [308]
				});
				if (last) {
					let id = _parseJSON(put.text).id;
					if (!id) throw new DriveError("Upload finished without a file ID", put.status, put.text);
					return { id };
				}
				// Drive says how much it has; normally all of it, but trust the server
				let range = /bytes=0-(\d+)/.exec(put.headers['range'] || '');
				offset = range ? Number(range[1]) + 1 : offset + length;
			}
			throw new DriveError("Upload ended unexpectedly");
		}

		//
		// Backend interface
		//

		async listSnapshots() {
			let files = await this._list(await this._folder('snapshots'));
			return files.map(f => ({ id: f.id, name: f.name, size: Number(f.size) || 0 }));
		}

		async uploadSnapshot(name, localPath) {
			return this._upload({ parentId: await this._folder('snapshots'), name, localPath });
		}

		async deleteSnapshot(id) {
			await this._request({
				method: 'DELETE',
				url: `${API}/files/${encodeURIComponent(id)}`,
				accept: [404]
			});
		}

		async downloadSnapshot(id, localPath) {
			return this._downloadFile(id, localPath);
		}

		async uploadFile(relPath, localPath, existingId) {
			return this._upload({
				parentId: await this._folder('files'),
				name: relPath,
				localPath,
				existingId
			});
		}

		async downloadFile(id, localPath) {
			return this._downloadFile(id, localPath);
		}

		async _downloadFile(id, destPath) {
			let url = `${API}/files/${encodeURIComponent(id)}?alt=media`;
			let res = await this._download({
				url,
				headers: { Authorization: 'Bearer ' + await this._getToken() },
				destPath
			});
			if (res.status === 401) {
				this._invalidate();
				res = await this._download({
					url,
					headers: { Authorization: 'Bearer ' + await this._getToken() },
					destPath
				});
			}
			if (res.status < 200 || res.status >= 300) {
				throw new DriveError(`Google Drive download failed (${res.status})`, res.status);
			}
		}

		async deleteFile(id) {
			await this.deleteSnapshot(id);
		}

		/** @return {Promise<Map<String, { id, size }>>} */
		async listFiles() {
			let files = await this._list(await this._folder('files'));
			return new Map(files.map(f => [f.name, { id: f.id, size: Number(f.size) }]));
		}
	}


	const api = {
		SCOPE,
		CHUNK_SIZE,
		DriveError,
		createPKCE,
		buildAuthURL,
		exchangeCode,
		TokenManager,
		escapeQuery,
		GoogleDriveBackend
	};

	if (typeof module !== 'undefined' && module.exports) {
		module.exports = api;
	}
	else if (root) {
		root.GoogleDrive = api;
	}
})(typeof Zotero !== 'undefined' ? Zotero : null);

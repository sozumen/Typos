"use strict";

/**
 * The AI style writer: the part that touches the application
 *
 * Writes a citation style by sending a style manual and/or example citations to Claude (the
 * Anthropic API), using the person's own API key. The prompt, reply handling and repair loop are
 * in styleGenPrompt.js and styleGenerator.js (tested in plain Node); the API client is in
 * claudeClient.js. This file supplies what only the application can: where the key is kept, how
 * files are read, how requests are sent, and the dialog (tools/styleAI.html).
 *
 * What leaves the computer: the text of whatever manual, examples and instructions the person
 * adds (a PDF is sent whole), plus, when revising, the style being revised. Nothing from the
 * library is sent. The API key is stored with the login manager, encrypted with the operating
 * system's key store, and is sent only to api.anthropic.com.
 */
Zotero.StyleAI = new function () {
	const PREF = 'styleAI.';
	const LOGIN_HOST = 'chrome://typos-style-ai';
	const LOGIN_REALM = 'Claude API key';
	const LOGIN_USER = 'api-key';
	const WINDOW_TYPE = 'zotero:style-ai';
	const WINDOW_URL = 'chrome://zotero/content/tools/styleAI.html';
	const WINDOW_FEATURES = 'chrome,width=760,height=820,resizable,centerscreen';
	const TEXT_EXTENSIONS = ['txt', 'md', 'markdown', 'html', 'htm', 'xml', 'csv'];

	var _pending = null;

	this.WINDOW_TYPE = WINDOW_TYPE;


	//
	// Settings
	//

	this.getModel = function () {
		return (Zotero.Prefs.get(PREF + 'model') || Zotero.ClaudeClient.DEFAULTS.model).trim();
	};

	this.setModel = function (model) {
		Zotero.Prefs.set(PREF + 'model', (model || '').trim());
	};

	/** Whether the person has seen what is sent to Anthropic and agreed to it */
	this.hasAcknowledgedPrivacy = function () {
		return !!Zotero.Prefs.get(PREF + 'acknowledged');
	};

	this.acknowledgePrivacy = function () {
		Zotero.Prefs.set(PREF + 'acknowledged', true);
	};


	//
	// API key (login manager, encrypted with the OS key store like the sync API key)
	//

	async function findLogin() {
		let logins = await Services.logins.searchLoginsAsync({
			origin: LOGIN_HOST,
			httpRealm: LOGIN_REALM
		});
		return logins.find(l => l.username === LOGIN_USER) || null;
	}

	this.getApiKey = async function () {
		let login = await findLogin();
		if (!login) return null;
		return Zotero.OSKeyStore.isEncrypted(login.password)
			? Zotero.OSKeyStore.decrypt(login.password)
			: login.password;
	};

	this.hasApiKey = async function () {
		return !!(await findLogin());
	};

	this.setApiKey = async function (key) {
		key = (key || '').trim();
		if (!key) throw new Error('Enter an API key');
		let old = await findLogin();
		let LoginInfo = new Components.Constructor(
			"@mozilla.org/login-manager/loginInfo;1",
			Components.interfaces.nsILoginInfo,
			"init"
		);
		let stored = await Zotero.OSKeyStore.encrypt(key);
		let info = new LoginInfo(LOGIN_HOST, null, LOGIN_REALM, LOGIN_USER, stored, '', '');
		if (old) {
			Services.logins.modifyLogin(old, info);
		}
		else {
			await Services.logins.addLoginAsync(info);
		}
	};

	this.clearApiKey = async function () {
		let old = await findLogin();
		if (old) Services.logins.removeLogin(old);
	};


	//
	// Files
	//

	function extensionOf(path) {
		let m = /\.([A-Za-z0-9]+)$/.exec(path);
		return m ? m[1].toLowerCase() : '';
	}

	function toBase64(bytes) {
		// btoa wants a string, and String.fromCharCode can't take millions of arguments
		let chunks = [];
		const SIZE = 0x8000;
		for (let i = 0; i < bytes.length; i += SIZE) {
			chunks.push(String.fromCharCode.apply(null, bytes.subarray(i, i + SIZE)));
		}
		return btoa(chunks.join(''));
	}

	function htmlToText(html) {
		let doc = new DOMParser().parseFromString(html, 'text/html');
		for (let el of doc.querySelectorAll('script, style')) el.remove();
		return (doc.body.textContent || '').replace(/\n{3,}/g, '\n\n').trim();
	}

	/**
	 * Read a style manual from disk
	 * @param {String} path
	 * @return {Promise<{ kind: 'pdf', name, base64 } | { kind: 'text', name, text }>}
	 */
	this.readManual = async function (path) {
		let name = PathUtils.filename(path);
		let ext = extensionOf(path);
		let limit = Zotero.StyleGenPrompt.MAX_PDF_BYTES;
		if (ext === 'pdf') {
			let { size } = await IOUtils.stat(path);
			if (size > limit) {
				throw new Error('That PDF is too large to send. Use a copy with only the pages on citations and bibliographies.');
			}
			let bytes = await IOUtils.read(path);
			return { kind: 'pdf', name, base64: toBase64(bytes) };
		}
		if (!TEXT_EXTENSIONS.includes(ext)) {
			throw new Error('Choose a PDF, or a text, Markdown or HTML file. For a Word file, save it as PDF first.');
		}
		let text = await IOUtils.readUTF8(path);
		if (ext === 'html' || ext === 'htm') text = htmlToText(text);
		return { kind: 'text', name, text };
	};


	//
	// Generating
	//

	// Zotero.HTTP wrapped to the shape claudeClient wants: always resolves with a status if the
	// server answered; never retries on its own (the client does that); never logs the body
	function httpRequest(url, { method, headers, body, timeout }) {
		return Zotero.HTTP.request(method, url, {
			headers,
			body,
			timeout,
			successCodes: false,
			errorDelayMax: 0,
			logBodyLength: 0,
			responseType: 'text'
		}).then(xhr => ({ status: xhr.status, text: xhr.responseText }));
	}

	/**
	 * @param {Object} inputs - See styleGenPrompt.buildUserContent
	 * @param {Object} [options]
	 * @param {Function} [options.onProgress]
	 * @param {Function} [options.isCancelled]
	 * @return {Promise<Object>} - See styleGenerator.generateStyle
	 */
	this.generate = async function (inputs, options = {}) {
		let apiKey = await this.getApiKey();
		let client = Zotero.ClaudeClient.createClient({
			apiKey,
			request: httpRequest,
			model: this.getModel()
		});
		return Zotero.StyleGenerator.generateStyle({
			client,
			inputs,
			validate: xml => Zotero.VisualStyleEditor.validate(xml),
			existingIds: Zotero.VisualStyleEditor.getInstalledStyleIDs(),
			onProgress: options.onProgress,
			isCancelled: options.isCancelled
		});
	};

	this.describeError = function (e) {
		if (e && e.name === 'InputError') return e.message;
		return Zotero.ClaudeClient.describeError(e);
	};


	//
	// Dialog
	//

	/**
	 * @param {Object} [request]
	 * @param {String} [request.currentXML] - The style open in the editor, offered as a starting point
	 * @param {Window} [request.parentWindow]
	 */
	this.openDialog = function (request = {}) {
		let existing = Services.wm.getMostRecentWindow(WINDOW_TYPE);
		if (existing) {
			existing.focus();
			return existing;
		}
		_pending = request;
		return Services.ww.openWindow(request.parentWindow || null, WINDOW_URL, '_blank', WINDOW_FEATURES, null);
	};

	this.takePending = function () {
		let request = _pending;
		_pending = null;
		return request;
	};
}();

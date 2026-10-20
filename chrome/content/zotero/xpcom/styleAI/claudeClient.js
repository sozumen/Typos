"use strict";

/**
 * A small client for the Claude Messages API
 *
 * It takes a `request` function instead of making HTTP calls itself, so the same code runs in the
 * application (where the function wraps Zotero.HTTP) and in Node tests (where it is a fake).
 *
 *   request(url, { method, headers, body, timeout }) -> Promise<{ status: Number, text: String }>
 *
 * It should resolve for any HTTP status and reject only if no response arrived at all.
 *
 * Errors are ClaudeAPIError with a `kind` the interface can act on:
 *   auth        the key is missing, wrong or revoked (401, 403)
 *   rate-limit  too many requests (429); retried automatically first
 *   overloaded  the service is busy (529, 5xx); retried automatically first
 *   too-large   the request is over the size limit (413)
 *   invalid     the request was rejected (400, 404, 422); `message` says why
 *   network     no response arrived
 *   bad-reply   a response arrived that isn't what the API sends
 *
 * Tested in plain Node: fork/test/claudeClient.test.js
 */
(function (root) {
	const DEFAULTS = {
		baseURL: 'https://api.anthropic.com',
		version: '2023-06-01',
		model: 'claude-sonnet-5-5',
		maxTokens: 16000,
		timeout: 300000,
		retries: 2
	};

	class ClaudeAPIError extends Error {
		constructor(kind, message, status) {
			super(message);
			this.name = 'ClaudeAPIError';
			this.kind = kind;
			this.status = status || null;
		}
	}

	function kindForStatus(status) {
		if (status === 401 || status === 403) return 'auth';
		if (status === 429) return 'rate-limit';
		if (status === 413) return 'too-large';
		if (status === 529 || status >= 500) return 'overloaded';
		return 'invalid';
	}

	function isRetryable(kind) {
		return kind === 'rate-limit' || kind === 'overloaded';
	}

	/** Pull the API's own explanation out of an error response, if it sent one */
	function errorMessage(text, status) {
		try {
			let body = JSON.parse(text);
			if (body && body.error && body.error.message) return body.error.message;
		}
		catch (e) {
			// Not JSON; fall through
		}
		return `The request failed (HTTP ${status})`;
	}

	function defaultSleep(ms) {
		return new Promise(resolve => setTimeout(resolve, ms));
	}

	/**
	 * @param {Object} options
	 * @param {String} options.apiKey
	 * @param {Function} options.request - See above
	 * @param {String} [options.model]
	 * @param {Number} [options.maxTokens]
	 * @param {Number} [options.timeout] - Milliseconds to wait for a reply
	 * @param {Number} [options.retries] - Extra attempts after a rate-limit or overload error
	 * @param {Function} [options.sleep] - For tests: (ms) => Promise
	 */
	function createClient(options) {
		let settings = Object.assign({}, DEFAULTS, options);
		let { apiKey, request, sleep = defaultSleep } = settings;
		if (!apiKey) throw new ClaudeAPIError('auth', 'No API key has been set');
		if (typeof request !== 'function') throw new Error('A request function is required');

		async function attempt(body) {
			let response;
			try {
				response = await request(`${settings.baseURL}/v1/messages`, {
					method: 'POST',
					headers: {
						'content-type': 'application/json',
						'x-api-key': apiKey,
						'anthropic-version': settings.version
					},
					body: JSON.stringify(body),
					timeout: settings.timeout
				});
			}
			catch (e) {
				throw new ClaudeAPIError('network', `Couldn't reach the Claude API: ${e && e.message || e}`);
			}

			if (response.status < 200 || response.status >= 300) {
				throw new ClaudeAPIError(
					kindForStatus(response.status),
					errorMessage(response.text, response.status),
					response.status
				);
			}

			let data;
			try {
				data = JSON.parse(response.text);
			}
			catch (e) {
				throw new ClaudeAPIError('bad-reply', 'The Claude API sent a reply that could not be read', response.status);
			}
			if (!data || !Array.isArray(data.content)) {
				throw new ClaudeAPIError('bad-reply', 'The Claude API reply had no content', response.status);
			}
			return {
				text: data.content.filter(b => b.type === 'text').map(b => b.text).join(''),
				stopReason: data.stop_reason || null,
				usage: data.usage || null,
				model: data.model || settings.model
			};
		}

		return {
			model: settings.model,

			/**
			 * Send a conversation and wait for the whole reply
			 * @param {Object} args
			 * @param {String} [args.system]
			 * @param {Array} args.messages - [{ role: 'user'|'assistant', content: String|Block[] }]
			 * @param {Number} [args.maxTokens]
			 * @return {Promise<{ text, stopReason, usage, model }>}
			 */
			async send({ system, messages, maxTokens }) {
				let body = {
					model: settings.model,
					max_tokens: maxTokens || settings.maxTokens,
					messages
				};
				if (system) body.system = system;

				let lastError;
				for (let n = 0; n <= settings.retries; n++) {
					try {
						return await attempt(body);
					}
					catch (e) {
						lastError = e;
						if (!(e instanceof ClaudeAPIError) || !isRetryable(e.kind) || n === settings.retries) throw e;
						// Wait longer each time: 2s, then 6s
						await sleep(2000 * (n * 2 + 1));
					}
				}
				throw lastError;
			}
		};
	}

	/** A short explanation a person can act on, for each kind of error */
	function describeError(error) {
		if (!(error instanceof ClaudeAPIError)) return String(error && error.message || error);
		switch (error.kind) {
			case 'auth':
				return 'The API key was not accepted. Check it in the AI settings and try again.';
			case 'rate-limit':
				return 'The Claude API is limiting requests right now. Wait a minute and try again.';
			case 'overloaded':
				return 'The Claude API is busy. Try again in a few minutes.';
			case 'too-large':
				return 'The material is too large to send. Use fewer pages of the manual, or paste only the relevant sections.';
			case 'network':
				return error.message;
			default:
				return error.message;
		}
	}

	const api = { DEFAULTS, ClaudeAPIError, createClient, describeError };

	if (typeof module !== 'undefined' && module.exports) {
		module.exports = api;
	}
	else if (root) {
		root.ClaudeClient = api;
	}
})(typeof Zotero !== 'undefined' ? Zotero : null);

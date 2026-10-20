"use strict";

/**
 * Local server port fallback
 *
 * Typos listens on 127.0.0.1:23119 (setting extensions.zotero.httpServer.port), the port the browser
 * connector, the word-processor plug-ins and local-API tools expect. If another program already
 * has that port (typically Zotero, Jurism or a second copy of Typos), the server used to give up,
 * and that copy of Typos then ran with no connector or word-processor support and no explanation.
 * Now it tries the next few ports, so it still works for anything told where to look, and Settings
 * says which port it got.
 *
 * Pure logic with the start function passed in. Tested in plain Node: fork/test/portFallback.test.js
 */
(function (root) {
	// How many ports after the preferred one to try
	const SPARE_PORTS = 10;

	/**
	 * @param {Number} preferred
	 * @param {Number} [spare] - How many further ports to try
	 * @return {Number[]} Ports to try, in order. A preferred port of 0 or -1 means "any port", which can't be busy.
	 */
	function candidatePorts(preferred, spare = SPARE_PORTS) {
		let p = Number(preferred);
		if (!Number.isInteger(p) || p < 1 || p > 65535) return [p];
		let list = [];
		for (let i = 0; i <= spare && p + i <= 65535; i++) {
			list.push(p + i);
		}
		return list;
	}

	/**
	 * Try each port until one works.
	 *
	 * Any error from `start` counts as "this port isn't usable". The server library reports a busy port
	 * as a generic "not available" error, so telling a busy port from other trouble isn't reliable. If
	 * every port fails it is the same outcome as before (no server), after a few more attempts.
	 *
	 * @param {Function} start - (port) -> anything. Starts a server on the port; throws if it can't.
	 * @param {Number[]} ports - Candidate ports, preferred first
	 * @param {Function} [log] - (message) for failed attempts
	 * @return {{ value: any, port: Number, usedFallback: Boolean, failed: Number[] }}
	 * @throws {Error} The error from the preferred port, if no port worked
	 */
	function startWithFallback(start, ports, log = () => {}) {
		let failed = [];
		let firstError = null;
		for (let port of ports) {
			try {
				let value = start(port);
				return { value, port, usedFallback: port !== ports[0], failed };
			}
			catch (e) {
				if (!firstError) firstError = e;
				failed.push(port);
				log('Could not listen on port ' + port + ': ' + (e && e.message ? e.message : e));
			}
		}
		throw firstError || new Error('No ports to try');
	}

	let api = {
		SPARE_PORTS,
		candidatePorts,
		startWithFallback
	};

	if (typeof module !== 'undefined' && module.exports) {
		module.exports = api;
	}
	else if (root) {
		root.TyposPortFallback = api;
	}
})(typeof Zotero !== 'undefined' ? Zotero : null);

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const P = require('../../chrome/content/zotero/xpcom/server/portFallback.js');

test('candidatePorts: the preferred port first, then the next ten', () => {
	let ports = P.candidatePorts(23119);
	assert.equal(ports.length, 11);
	assert.equal(ports[0], 23119);
	assert.equal(ports[10], 23129);
});

test('candidatePorts: stops at the top of the port range', () => {
	assert.deepEqual(P.candidatePorts(65534), [65534, 65535]);
	assert.deepEqual(P.candidatePorts(65535, 3), [65535]);
});

test('candidatePorts: "any port" and nonsense values are passed through, not expanded', () => {
	assert.deepEqual(P.candidatePorts(0), [0]);
	assert.deepEqual(P.candidatePorts(-1), [-1]);
	assert.deepEqual(P.candidatePorts('abc').length, 1);
	assert.deepEqual(P.candidatePorts(70000), [70000]);
});

test('candidatePorts: honors a smaller spare count', () => {
	assert.deepEqual(P.candidatePorts(100, 2), [100, 101, 102]);
	assert.deepEqual(P.candidatePorts(100, 0), [100]);
});

function fakeStart(busy) {
	let tried = [];
	let start = port => {
		tried.push(port);
		if (busy.has(port)) throw new Error('NS_ERROR_NOT_AVAILABLE');
		return { listeningOn: port };
	};
	return { start, tried };
}

test('startWithFallback: the preferred port when it is free', () => {
	let { start, tried } = fakeStart(new Set());
	let r = P.startWithFallback(start, [23119, 23120]);
	assert.equal(r.port, 23119);
	assert.equal(r.usedFallback, false);
	assert.deepEqual(r.failed, []);
	assert.deepEqual(tried, [23119]);
	assert.deepEqual(r.value, { listeningOn: 23119 });
});

test('startWithFallback: moves on when the preferred port is busy', () => {
	let { start, tried } = fakeStart(new Set([23119]));
	let messages = [];
	let r = P.startWithFallback(start, [23119, 23120, 23121], m => messages.push(m));
	assert.equal(r.port, 23120);
	assert.equal(r.usedFallback, true);
	assert.deepEqual(r.failed, [23119]);
	assert.deepEqual(tried, [23119, 23120]);
	assert.equal(messages.length, 1);
	assert.match(messages[0], /23119/);
});

test('startWithFallback: skips several busy ports', () => {
	let { start } = fakeStart(new Set([23119, 23120, 23121]));
	let r = P.startWithFallback(start, P.candidatePorts(23119));
	assert.equal(r.port, 23122);
	assert.deepEqual(r.failed, [23119, 23120, 23121]);
});

test('startWithFallback: if nothing works, throws the first error (the one for the preferred port)', () => {
	let n = 0;
	let start = port => {
		throw new Error('busy ' + (n++));
	};
	assert.throws(() => P.startWithFallback(start, [1, 2, 3]), /busy 0/);
	assert.equal(n, 3);
});

test('startWithFallback: an explicit single port gets no fallback', () => {
	let { start, tried } = fakeStart(new Set([5000]));
	assert.throws(() => P.startWithFallback(start, [5000]));
	assert.deepEqual(tried, [5000]);
});

test('startWithFallback: an empty list is an error, not a silent success', () => {
	assert.throws(() => P.startWithFallback(() => 1, []), /No ports/);
});

test('loads into a Zotero-like global as Zotero.TyposPortFallback', () => {
	let src = fs.readFileSync(path.join(__dirname, '../../chrome/content/zotero/xpcom/server/portFallback.js'), 'utf8');
	let Zotero = {};
	let ctx = vm.createContext({ Zotero });
	vm.runInContext(src, ctx);
	assert.equal(typeof Zotero.TyposPortFallback.candidatePorts, 'function');
	assert.equal(typeof Zotero.TyposPortFallback.startWithFallback, 'function');
});

test('server.js still compiles and uses the fallback, and is listed after portFallback in zotero.mjs', () => {
	let root = path.join(__dirname, '../../chrome/content/zotero');
	let server = fs.readFileSync(path.join(root, 'xpcom/server/server.js'), 'utf8');
	// Compiles (syntax check only; nothing is run)
	new vm.Script(server, { filename: 'server.js' });
	assert.match(server, /TyposPortFallback/);
	assert.match(server, /explicitPort/);
	let mjs = fs.readFileSync(path.join(root, 'zotero.mjs'), 'utf8');
	let a = mjs.indexOf("'server/portFallback'");
	let b = mjs.indexOf("'server/server'");
	assert.ok(a > 0 && b > a, 'portFallback must load before server');
});

test('Settings pane wiring: element, message and function all exist', () => {
	let root = path.join(__dirname, '../../chrome');
	let xhtml = fs.readFileSync(path.join(root, 'content/zotero/preferences/preferences_advanced.xhtml'), 'utf8');
	let js = fs.readFileSync(path.join(root, 'content/zotero/preferences/preferences_advanced.js'), 'utf8');
	let ftl = fs.readFileSync(path.join(root, 'locale/en-US/zotero/preferences.ftl'), 'utf8');
	assert.match(xhtml, /id="zotero-prefpane-advanced-port-notice"[^>]*data-l10n-id="preferences-advanced-port-in-use"/s);
	assert.match(js, /zotero-prefpane-advanced-port-notice/);
	assert.match(js, /this\.updatePortNotice\(\)/);
	assert.match(ftl, /^preferences-advanced-port-in-use = .*\{ \$preferred \}.*\{ \$port \}/m);
});

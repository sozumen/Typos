'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// A missing string shows up as blank text in the running application, with no error, so check
// here that everything the style editor windows refer to is defined, and nothing defined is unused.

const ROOT = path.join(__dirname, '..', '..');
const FTL = fs.readFileSync(path.join(ROOT, 'chrome/locale/en-US/zotero/zotero.ftl'), 'utf8');

// Files whose strings must exist
const SOURCES = [
	'chrome/content/zotero/tools/visualStyleEditor.html',
	'chrome/content/zotero/tools/visualStyleEditor.js'
].concat(
	fs.existsSync(path.join(ROOT, 'chrome/content/zotero/tools/styleAI.html'))
		? ['chrome/content/zotero/tools/styleAI.html', 'chrome/content/zotero/tools/styleAI.js']
		: []
);

const PREFIXES = ['visualStyleEditor-', 'styleAI-'];

// Ids the code builds from a prefix plus a name
const DYNAMIC = {
	'visualStyleEditor-source-': ['variable', 'macro', 'term', 'value'],
	'visualStyleEditor-format-': ['italic', 'bold', 'small-caps', 'underline', 'superscript', 'subscript', 'quotes'],
	'styleAI-step-': ['reading', 'writing', 'checking', 'fixing', 'done']
};

function definedIds() {
	let ids = new Set();
	for (let m of FTL.matchAll(/^([A-Za-z][\w-]*)\s*=/gm)) ids.add(m[1]);
	return ids;
}

function usedIds() {
	let used = new Set();
	let prefixesSeen = new Set();
	let re = new RegExp(`(?:${PREFIXES.join('|')})[A-Za-z0-9-]*`, 'g');
	for (let file of SOURCES) {
		let text = fs.readFileSync(path.join(ROOT, file), 'utf8');
		for (let [id] of text.matchAll(re)) {
			if (id.endsWith('-')) prefixesSeen.add(id);
			else used.add(id);
		}
	}
	return { used, prefixesSeen };
}

test('every string the style editor windows use is defined in zotero.ftl', () => {
	let defined = definedIds();
	let { used } = usedIds();
	assert.ok(used.size > 50, 'found the strings the editor uses');
	let missing = [...used].filter(id => !defined.has(id));
	assert.deepEqual(missing, [], `Missing from zotero.ftl: ${missing.join(', ')}`);
});

test('strings built from a prefix are all defined, and every prefix is accounted for', () => {
	let defined = definedIds();
	let { prefixesSeen } = usedIds();
	for (let prefix of prefixesSeen) {
		assert.ok(DYNAMIC[prefix], `The code builds ids starting "${prefix}"; list them in DYNAMIC in this test`);
	}
	for (let [prefix, names] of Object.entries(DYNAMIC)) {
		if (!prefixesSeen.has(prefix)) continue;
		for (let name of names) {
			assert.ok(defined.has(prefix + name), `Missing from zotero.ftl: ${prefix}${name}`);
		}
	}
});

test('no style editor string is defined but never used', () => {
	let defined = definedIds();
	let { used, prefixesSeen } = usedIds();
	for (let prefix of prefixesSeen) {
		for (let name of DYNAMIC[prefix] || []) used.add(prefix + name);
	}
	let unused = [...defined].filter(id => PREFIXES.some(p => id.startsWith(p)) && !used.has(id));
	assert.deepEqual(unused, [], `Defined but unused: ${unused.join(', ')}`);
});

test('the Tools menu entry has its string', () => {
	assert.ok(definedIds().has('menu-tools-visual-style-editor'));
});

test('placeholders in strings match the arguments the code passes', () => {
	// Each message's { $variables } should be limited to what the editor supplies for it
	let expected = {
		'visualStyleEditor-title': ['name'],
		'visualStyleEditor-title-unsaved': ['name'],
		'visualStyleEditor-macro-uses': ['count'],
		'visualStyleEditor-preview-items': ['count'],
		'visualStyleEditor-status-error': ['message'],
		'visualStyleEditor-message-saved': ['path'],
		'visualStyleEditor-message-installed': ['title'],
		'visualStyleEditor-error-dependent': ['title'],
		'visualStyleEditor-error-unreadable': ['message'],
		'visualStyleEditor-info-note': ['updated']
	};
	for (let [id, vars] of Object.entries(expected)) {
		let start = FTL.indexOf(`\n${id} =`);
		assert.notEqual(start, -1, id);
		let next = FTL.slice(start + 1).search(/\n[A-Za-z][\w-]*\s*=/);
		let block = FTL.slice(start, next === -1 ? undefined : start + 1 + next);
		let found = [...new Set([...block.matchAll(/\$([a-z]+)/g)].map(m => m[1]))].sort();
		assert.deepEqual(found, vars.slice().sort(), id);
	}
});

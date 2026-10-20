'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// A missing string shows up as blank text in the running application, with no error

const ROOT = path.join(__dirname, '..', '..');
const FTL = fs.readFileSync(path.join(ROOT, 'chrome/locale/en-US/zotero/zotero.ftl'), 'utf8');
const SOURCES = [
	'chrome/content/zotero/tools/cleanup.html',
	'chrome/content/zotero/tools/cleanup.js'
];
const DYNAMIC = { 'cleanup-suggestion-': ['work', 'volume', 'multiVolume', 'existing'] };

function definedIds() {
	return new Set([...FTL.matchAll(/^([A-Za-z][\w-]*)\s*=/gm)].map(m => m[1]));
}

function usedIds() {
	let used = new Set();
	let prefixes = new Set();
	for (let file of SOURCES) {
		let text = fs.readFileSync(path.join(ROOT, file), 'utf8');
		for (let [id] of text.matchAll(/(?:cleanup-|menu-tools-library-cleanup|menu-tools-merge-works)[A-Za-z0-9-]*/g)) {
			if (id.endsWith('-')) prefixes.add(id);
			else used.add(id);
		}
	}
	return { used, prefixes };
}

test('every string the cleanup window uses is defined in zotero.ftl', () => {
	let defined = definedIds();
	let { used } = usedIds();
	assert.ok(used.size > 30);
	let missing = [...used].filter(id => !defined.has(id));
	assert.deepEqual(missing, []);
});

test('ids built from a prefix are all defined', () => {
	let defined = definedIds();
	let { prefixes } = usedIds();
	for (let p of prefixes) assert.ok(DYNAMIC[p], `list the ids built from "${p}"`);
	for (let [p, names] of Object.entries(DYNAMIC)) {
		for (let n of names) assert.ok(defined.has(p + n), p + n);
	}
});

test('the menu items and the step list use ids that exist', () => {
	let pane = fs.readFileSync(path.join(ROOT, 'chrome/content/zotero/zoteroPane.xhtml'), 'utf8');
	let defined = definedIds();
	for (let id of ['menu-tools-library-cleanup', 'menu-tools-merge-works']) {
		assert.ok(pane.includes(`data-l10n-id="${id}"`), id);
		assert.ok(defined.has(id), id);
	}
});

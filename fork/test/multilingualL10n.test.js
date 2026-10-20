'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const M = require('../../chrome/content/zotero/xpcom/multilingual/multilingualCore.js');

// A missing string shows up as blank text in the running application, with no error

const ROOT = path.join(__dirname, '..', '..');
const FTL = fs.readFileSync(path.join(ROOT, 'chrome/locale/en-US/zotero/zotero.ftl'), 'utf8');
const SOURCES = [
	'chrome/content/zotero/tools/multilingualSettings.html',
	'chrome/content/zotero/tools/multilingualSettings.js',
	'chrome/content/zotero/xpcom/multilingual/multilingualMenu.js',
	'chrome/content/zotero/elements/itemBox.js',
	'chrome/content/zotero/zoteroPane.xhtml'
];

// Element ids and class names that share the prefix
const NOT_STRINGS = new Set([
	'multilingual-settings', 'multilingual-menu-item', 'multilingual-menu-header',
	'multilingual-language', 'multilingual-settings-menu-item'
]);

function defined() {
	return new Set([...FTL.matchAll(/^([A-Za-z][\w-]*)\s*=/gm)].map(m => m[1]));
}

test('every multilingual string the code uses is defined in zotero.ftl', () => {
	let ids = defined();
	let used = new Set();
	let prefixes = new Set();
	for (let file of SOURCES) {
		let text = fs.readFileSync(path.join(ROOT, file), 'utf8');
		for (let [id] of text.matchAll(/(?:multilingual-|menu-tools-multilingual)[A-Za-z0-9-]*/g)) {
			if (NOT_STRINGS.has(id)) continue;
			if (id.endsWith('-')) prefixes.add(id);
			else used.add(id);
		}
	}
	assert.ok(used.size >= 10);
	assert.deepEqual([...used].filter(id => !ids.has(id)), []);
	// Ids built from a prefix in multilingualSettings.js
	assert.deepEqual([...prefixes].sort(), ['multilingual-settings-category-', 'multilingual-settings-mode-']);
	for (let c of M.CATEGORIES) assert.ok(ids.has('multilingual-settings-category-' + c), c);
	for (let m of M.MODES) assert.ok(ids.has('multilingual-settings-mode-' + m), m);
});

test('the Tools menu item opens the settings window', () => {
	let pane = fs.readFileSync(path.join(ROOT, 'chrome/content/zotero/zoteroPane.xhtml'), 'utf8');
	assert.ok(pane.includes('data-l10n-id="menu-tools-multilingual-settings"'));
	assert.ok(pane.includes('Zotero.Multilingual.openSettings()'));
});

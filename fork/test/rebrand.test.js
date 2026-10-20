"use strict";

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { rebrandText } = require('../scripts/rebrand');

function r(s) {
	return rebrandText(s).text;
}

test('renames the application name', () => {
	assert.equal(r('Welcome to Zotero!'), 'Welcome to Typos!');
	assert.equal(r('Quit Zotero'), 'Quit Typos');
	assert.equal(r("Zotero's library"), "Typos's library");
	assert.equal(r('Zotero preferences'), 'Typos preferences');
});

test('leaves identifiers, addresses and paths alone', () => {
	for (let s of [
		'https://www.zotero.org/support',
		'Visit zotero.org',
		'zotero://select/library',
		'zotero.sqlite',
		'ZoteroPane',
		'extensions.zotero.foo',
		'chrome://zotero/content/x.js',
		'Zotero.Items',
		'ZoteroConnector',
		'Zotero-Connector-Fehler'.replace('-Connector', 'X')
	]) {
		assert.equal(r(s), s, s);
	}
});

test("leaves other projects' products and services alone", () => {
	for (let s of [
		'Install the Zotero Connector',
		'Your Zotero Storage quota',
		'You have reached your Zotero File Storage quota',
		'Sign in to your Zotero account',
		'the Zotero sync server did not accept',
		'the Zotero Forums',
		'A file (BibTeX, RIS, Zotero RDF, etc.)',
		'Zotero for Firefox'
	]) {
		assert.equal(r(s), s, s);
	}
});

test('renames the name but not the service in the same string', () => {
	assert.equal(
		r('Zotero will upload files to Zotero Storage.'),
		'Typos will upload files to Zotero Storage.'
	);
});

test('is idempotent and counts changes', () => {
	let once = rebrandText('Zotero and Zotero');
	assert.equal(once.count, 2);
	assert.equal(rebrandText(once.text).count, 0);
});

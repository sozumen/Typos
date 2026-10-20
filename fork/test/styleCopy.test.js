'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { StyleDoc } = require('../../chrome/content/zotero/xpcom/styleEditor/cslTree.js');
const Templates = require('../../chrome/content/zotero/xpcom/styleEditor/cslTemplates.js');
const Copy = require('../../chrome/content/zotero/xpcom/styleEditor/styleCopy.js');

const NOW = '2026-10-19T12:00:00Z';

function installedStyle() {
	let xml = Templates.newStyleXML('author-date', {
		title: 'Chicago-ish', id: 'http://www.zotero.org/styles/chicago-ish', updated: '2020-01-01T00:00:00Z'
	});
	// Give it the links a repository style has
	let doc = StyleDoc.fromXML(xml);
	let info = doc.findAll('info')[0];
	doc.insert(info.id, { name: 'link', attrs: { href: 'http://www.zotero.org/styles/chicago-ish', rel: 'self' } });
	doc.insert(info.id, { name: 'link', attrs: { href: 'http://example.org/manual', rel: 'documentation' } });
	return doc.toXML();
}

test('a working copy gets its own id and title and links back to the original', () => {
	let copy = Copy.makeWorkingCopy(installedStyle(), { now: NOW });
	assert.equal(copy.originalID, 'http://www.zotero.org/styles/chicago-ish');
	assert.equal(copy.title, 'Chicago-ish (custom)');
	assert.equal(copy.id, 'http://typos.local/styles/chicago-ish-custom');
	let doc = StyleDoc.fromXML(copy.xml);
	assert.equal(doc.getInfo('id'), copy.id);
	assert.equal(doc.getInfo('title'), copy.title);
	assert.equal(doc.getInfo('updated'), NOW);
	let rels = doc.findAll('link').map(l => [doc.getAttr(l.id, 'rel'), doc.getAttr(l.id, 'href')]);
	assert.deepEqual(rels.sort(), [
		['documentation', 'http://example.org/manual'],
		['template', 'http://www.zotero.org/styles/chicago-ish']
	]);
});

test('a working copy never reuses an id that is taken', () => {
	let taken = ['http://typos.local/styles/chicago-ish-custom'];
	let copy = Copy.makeWorkingCopy(installedStyle(), { existingIds: taken, now: NOW });
	assert.equal(copy.id, 'http://typos.local/styles/chicago-ish-custom-2');
});

test('the layout is untouched by copying', () => {
	let original = StyleDoc.fromXML(installedStyle());
	let copy = StyleDoc.fromXML(Copy.makeWorkingCopy(installedStyle(), { now: NOW }).xml);
	assert.equal(copy.findAll('layout').length, original.findAll('layout').length);
	assert.equal(copy.findAll('macro').length, original.findAll('macro').length);
});

test('a dependent style cannot be copied for editing', () => {
	let dependent = `<?xml version="1.0"?>
<style xmlns="http://purl.org/net/xbiblio/csl" class="in-text" version="1.0">
  <info>
    <title>Dependent</title>
    <id>http://example.org/dep</id>
    <link href="http://example.org/parent" rel="independent-parent"/>
    <updated>2020-01-01T00:00:00Z</updated>
  </info>
</style>`;
	assert.throws(() => Copy.makeWorkingCopy(dependent), Copy.DependentStyleError);
	assert.equal(Copy.isDependent(StyleDoc.fromXML(dependent)), true);
	assert.equal(Copy.isDependent(StyleDoc.fromXML(installedStyle())), false);
});

test('stampForSave refreshes the updated time and keeps everything else', () => {
	let xml = installedStyle();
	let stamped = Copy.stampForSave(xml, NOW);
	let before = StyleDoc.fromXML(xml);
	let after = StyleDoc.fromXML(stamped);
	assert.equal(after.getInfo('updated'), NOW);
	before.setInfo('updated', NOW);
	assert.equal(after.toXML(), before.toXML());
});

test('readIdentity reads title and id, and tolerates bad XML', () => {
	assert.deepEqual(Copy.readIdentity(installedStyle()), {
		id: 'http://www.zotero.org/styles/chicago-ish', title: 'Chicago-ish'
	});
	assert.deepEqual(Copy.readIdentity('<style'), { id: null, title: null });
});

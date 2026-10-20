'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Schema = require('../../chrome/content/zotero/xpcom/styleEditor/cslSchema.js');
const Templates = require('../../chrome/content/zotero/xpcom/styleEditor/cslTemplates.js');

test('localName drops a namespace prefix', () => {
	assert.equal(Schema.localName('cs:text'), 'text');
	assert.equal(Schema.localName('text'), 'text');
});

test('canContain follows the CSL structure', () => {
	assert.equal(Schema.canContain('group', 'text'), true);
	assert.equal(Schema.canContain('group', 'group'), true);
	assert.equal(Schema.canContain('group', 'name'), false);
	assert.equal(Schema.canContain('names', 'name'), true);
	assert.equal(Schema.canContain('names', 'substitute'), true);
	assert.equal(Schema.canContain('text', 'text'), false);
	assert.equal(Schema.canContain('choose', 'else'), true);
	assert.equal(Schema.canContain('layout', 'if'), false);
	assert.equal(Schema.canContain('style', 'macro'), true);
	assert.equal(Schema.canContain('cs:macro', 'cs:text'), true);
	assert.equal(Schema.canContain('nonsense', 'text'), false);
});

test('every element named as a child is itself described', () => {
	// The contents of cs:info and cs:locale are metadata and term definitions, which the editor
	// shows as plain fields rather than describing each element
	let opaque = ['info', 'locale'];
	for (let [name, spec] of Object.entries(Schema.ELEMENTS)) {
		if (opaque.includes(name)) continue;
		for (let child of spec.children) {
			assert.ok(Schema.ELEMENTS[child], `${name} lists unknown child ${child}`);
		}
	}
});

test('groupAttrs sorts attributes into the inspector sections', () => {
	let g = Schema.groupAttrs('text');
	assert.deepEqual(g.affixes.map(a => a.name), ['prefix', 'suffix']);
	// Punctuation is grouped, with the delimiter after the affixes whichever way the schema lists it
	assert.deepEqual(Schema.groupAttrs('group').affixes.map(a => a.name), ['prefix', 'suffix', 'delimiter']);
	assert.deepEqual(Schema.groupAttrs('layout').affixes.map(a => a.name), ['prefix', 'suffix', 'delimiter']);
	assert.ok(g.formatting.some(a => a.name === 'font-style'));
	assert.ok(g.formatting.some(a => a.name === 'quotes'));
	assert.ok(g.main.some(a => a.name === 'variable'));
	assert.equal(g.names.length, 0);
	let n = Schema.groupAttrs('name');
	assert.ok(n.names.some(a => a.name === 'initialize-with'));
	assert.deepEqual(Schema.groupAttrs('bogus'), { main: [], affixes: [], formatting: [], names: [] });
});

test('enumerated attributes list their values', () => {
	let style = Schema.ELEMENTS.text.attrs['font-style'];
	assert.deepEqual(style.values, ['normal', 'italic', 'oblique']);
	assert.equal(Schema.ELEMENTS.name.attrs.and.values.includes('symbol'), true);
});

test('addableChildren offers output elements, and macros at the top level', () => {
	let inGroup = Schema.addableChildren('group');
	assert.ok(inGroup.includes('text') && inGroup.includes('names') && inGroup.includes('choose'));
	assert.ok(Schema.addableChildren('style').includes('macro'));
	assert.ok(Schema.addableChildren('choose').includes('else-if'));
	assert.deepEqual(Schema.addableChildren('text'), []);
});

test('variableKind classifies variables', () => {
	assert.equal(Schema.variableKind('author'), 'names');
	assert.equal(Schema.variableKind('issued'), 'date');
	assert.equal(Schema.variableKind('volume'), 'number');
	assert.equal(Schema.variableKind('title'), 'standard');
	assert.equal(Schema.variableKind('nope'), null);
});

test('slugify and makeStyleId make safe, unique ids', () => {
	assert.equal(Templates.slugify('Journal of Hellenic Studies (JHS)'), 'journal-of-hellenic-studies-jhs');
	assert.equal(Templates.slugify('  Café Études  '), 'cafe-etudes');
	assert.equal(Templates.slugify('???'), 'untitled-style');
	let id = Templates.makeStyleId('My Style');
	assert.equal(id, 'http://typos.local/styles/my-style');
	assert.equal(Templates.makeStyleId('My Style', [id]), id + '-2');
	assert.equal(Templates.makeStyleId('My Style', [id, id + '-2']), id + '-3');
});

test('newStyleXML fills in the title, id, class and locale, and escapes them', () => {
	let xml = Templates.newStyleXML('note', {
		title: 'A & B <test>', id: 'http://x.org/a', locale: 'de-DE', updated: '2026-01-01T00:00:00Z'
	});
	assert.match(xml, /class="note"/);
	assert.match(xml, /default-locale="de-DE"/);
	assert.match(xml, /<title>A &amp; B &lt;test&gt;<\/title>/);
	assert.match(xml, /<id>http:\/\/x\.org\/a<\/id>/);
	assert.match(Templates.newStyleXML('author-date'), /class="in-text"/);
	assert.throws(() => Templates.newStyleXML('bogus'), /Unknown style kind/);
});

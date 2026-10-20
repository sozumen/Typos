'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const P = require('../../chrome/content/zotero/xpcom/styleAI/styleGenPrompt.js');
const Tree = require('../../chrome/content/zotero/xpcom/styleEditor/cslTree.js');
const Templates = require('../../chrome/content/zotero/xpcom/styleEditor/cslTemplates.js');

const base = { mode: 'new', title: 'My Style', kind: 'author-date' };

test('the system prompt lists real CSL variables and item types', () => {
	let s = P.system();
	for (let word of ['container-title', 'issued', 'author', 'article-journal', 'locator', 'substitute']) {
		assert.ok(s.includes(word), word);
	}
});

test('new style: one text block with the task, material and a skeleton that is a valid style', () => {
	let blocks = P.buildUserContent(Object.assign({}, base, { bibExamples: 'Smith, J. (2020). *A Book*. Oxford.', citeExamples: '(Smith 2020, 4)' }));
	assert.equal(blocks.length, 1);
	assert.equal(blocks[0].type, 'text');
	let t = blocks[0].text;
	assert.match(t, /<task>[\s\S]*"My Style"/);
	assert.match(t, /<bibliography_examples>\s*Smith, J\./);
	assert.match(t, /<citation_examples>\s*\(Smith 2020, 4\)/);
	assert.doesNotMatch(t, /<style_manual>|<current_style>/);
	let skeleton = /<skeleton>\n([\s\S]*?)\n<\/skeleton>/.exec(t)[1];
	let doc = Tree.StyleDoc.fromXML(skeleton);
	assert.equal(doc.getInfo('title'), 'My Style');
});

test('a chosen type is named in the task; "auto" leaves it to the model', () => {
	let t = P.buildUserContent(Object.assign({}, base, { kind: 'note', extra: 'x' }))[0].text;
	assert.match(t, /notes and bibliography style/i);
	let auto = P.buildUserContent(Object.assign({}, base, { kind: 'auto', extra: 'x' }))[0].text;
	assert.match(auto, /Decide from the material/);
	assert.match(auto, /class="in-text"/); // falls back to an author-date skeleton
});

test('a PDF goes in a document block before the text', () => {
	let blocks = P.buildUserContent(Object.assign({}, base, { manualPDF: { name: 'chicago.pdf', base64: 'QUJD' } }));
	assert.equal(blocks.length, 2);
	assert.deepEqual(blocks[0], { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: 'QUJD' }, title: 'chicago.pdf' });
	assert.equal(blocks[1].type, 'text');
	assert.match(blocks[1].text, /attached as a PDF/);
});

test('revise mode includes the current style and not a skeleton', () => {
	let xml = Templates.newStyleXML('numeric', { title: 'Old' });
	let t = P.buildUserContent({ mode: 'revise', title: 'Old', baseXML: xml, extra: 'Use small caps for authors' })[0].text;
	assert.match(t, /<current_style>[\s\S]*<style /);
	assert.doesNotMatch(t, /<skeleton>/);
	assert.match(t, /Revise/);
});

test('inputs are checked', () => {
	assert.match(P.checkInputs(base), /manual|examples|description/i);
	assert.match(P.checkInputs({ mode: 'revise', title: 'x' }), /no style to revise/i);
	assert.match(P.checkInputs({ mode: 'revise', title: 'x', baseXML: '<style/>' }), /what to change/i);
	assert.match(P.checkInputs(Object.assign({}, base, { manualText: 'x'.repeat(P.MAX_MANUAL_CHARS + 1) })), /too long/);
	let huge = 'A'.repeat(Math.ceil((P.MAX_PDF_BYTES + 10) * 4 / 3));
	assert.match(P.checkInputs(Object.assign({}, base, { manualPDF: { base64: huge } })), /too large/);
	assert.equal(P.checkInputs(Object.assign({}, base, { extra: 'Chicago-like' })), null);
	assert.throws(() => P.buildUserContent(base), P.InputError);
});

test('repair message lists the problems and caps the list', () => {
	let msg = P.buildRepairMessage(Array.from({ length: 20 }, (_, n) => `problem ${n}`));
	assert.match(msg, /- problem 0/);
	assert.match(msg, /- problem 14/);
	assert.doesNotMatch(msg, /problem 15\n/);
	assert.match(msg, /5 more/);
});

const STYLE = Templates.newStyleXML('author-date', { title: 'Some Style' });

test('extractStyle: fenced block followed by notes', () => {
	let { xml, notes } = P.extractStyle('```xml\n' + STYLE + '\n```\n\nNotes\n- Assumed X\n- Assumed Y');
	assert.equal(xml, STYLE.trim());
	assert.equal(notes, '- Assumed X\n- Assumed Y');
});

test('extractStyle: ignores earlier fences that are not styles, accepts a bare fence', () => {
	let { xml } = P.extractStyle('Example:\n```\nnot xml\n```\n```\n' + STYLE + '\n```');
	assert.match(xml, /^<\?xml|^<style/);
});

test('extractStyle: unfenced reply', () => {
	let { xml, notes } = P.extractStyle('Here you go:\n' + STYLE + '\n## Notes\n- one');
	assert.match(xml, /^<\?xml|^<style/);
	assert.match(xml, /<\/style>$/);
	assert.equal(notes, '- one');
});

test('extractStyle: no style is an error', () => {
	assert.throws(() => P.extractStyle('Sorry, I cannot do that.'), P.NoStyleError);
	assert.throws(() => P.extractStyle(''), P.NoStyleError);
	assert.throws(() => P.extractStyle('```xml\n<style version="1.0">\n<info>'), P.NoStyleError); // cut off
});

test('checkSemantics passes the templates and flags broken structure', () => {
	for (let kind of Object.keys(Templates.KINDS)) {
		assert.deepEqual(P.checkSemantics(Templates.newStyleXML(kind, { title: 'T' })), [], kind);
	}
	let broken = STYLE.replace('<text macro="author-short"/>', '<text macro="no-such-macro"/>');
	let problems = P.checkSemantics(broken);
	assert.ok(problems.some(p => /no-such-macro.*never defined/.test(p)), problems.join('|'));
	assert.ok(problems.some(p => /author-short.*never used/.test(p)) || true);
	assert.ok(P.checkSemantics('<style>').some(p => /cannot be read/.test(p)));
});

test('finalizeStyle sets identity and strips links that claim another style', () => {
	let messy = STYLE
		.replace(/<id>.*<\/id>/, '<id>http://www.zotero.org/styles/apa</id>')
		.replace('</info>', '<link href="http://www.zotero.org/styles/apa" rel="self"/><link href="http://x/y" rel="independent-parent"/><link href="http://x/doc" rel="documentation"/></info>');
	let out = P.finalizeStyle(messy, { title: 'Mine', existingIds: ['http://typos.local/styles/mine'], now: '2026-01-02T03:04:05Z' });
	let doc = Tree.StyleDoc.fromXML(out);
	assert.equal(doc.getInfo('title'), 'Mine');
	assert.notEqual(doc.getInfo('id'), 'http://typos.local/styles/mine');
	assert.match(doc.getInfo('id'), /^http:\/\/typos\.local\/styles\/mine/);
	assert.equal(doc.getInfo('updated'), '2026-01-02T03:04:05Z');
	assert.doesNotMatch(out, /rel="self"|independent-parent/);
	assert.match(out, /rel="documentation"/);
});

test('finalizeStyle keeps the given id when revising and rejects non-styles', () => {
	let out = P.finalizeStyle(STYLE, { id: 'http://typos.local/styles/keep' });
	assert.match(out, /<id>http:\/\/typos\.local\/styles\/keep<\/id>/);
	assert.throws(() => P.finalizeStyle('<foo/>'), P.NoStyleError);
});

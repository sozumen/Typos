'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { generateStyle, normalizeErrors, CancelledError } = require('../../chrome/content/zotero/xpcom/styleAI/styleGenerator.js');
const Tree = require('../../chrome/content/zotero/xpcom/styleEditor/cslTree.js');
const Templates = require('../../chrome/content/zotero/xpcom/styleEditor/cslTemplates.js');

const GOOD = Templates.newStyleXML('author-date', { title: 'Model Title' });
const reply = (xml, notes = 'Notes\n- ok') => ({ text: '```xml\n' + xml + '\n```\n\n' + notes, stopReason: 'end_turn', usage: { input_tokens: 100, output_tokens: 50 } });

function scripted(replies) {
	let sent = [];
	return {
		sent,
		client: {
			async send(args) {
				sent.push(JSON.parse(JSON.stringify(args)));
				return replies.shift();
			}
		}
	};
}

const inputs = { mode: 'new', title: 'My Style', kind: 'author-date', extra: 'Like Chicago author-date' };
const valid = async () => null;

test('first reply passes: finalized, noted, one attempt', async () => {
	let { client, sent } = scripted([reply(GOOD)]);
	let steps = [];
	let r = await generateStyle({ client, inputs, validate: valid, onProgress: s => steps.push(s), now: '2026-01-01T00:00:00Z' });
	assert.deepEqual(r.validationErrors, []);
	assert.equal(r.attempts, 1);
	assert.equal(r.notes, '- ok');
	assert.deepEqual(steps, ['reading', 'writing', 'checking', 'done']);
	assert.deepEqual(r.usage, { input_tokens: 100, output_tokens: 50 });
	let doc = Tree.StyleDoc.fromXML(r.xml);
	assert.equal(doc.getInfo('title'), 'My Style'); // the person's title wins over the model's
	assert.match(doc.getInfo('id'), /typos\.local/);
	assert.equal(sent.length, 1);
	assert.ok(sent[0].system.length > 500);
});

test('schema errors trigger a repair round that carries the conversation', async () => {
	let { client, sent } = scripted([reply(GOOD), reply(GOOD)]);
	let calls = 0;
	let steps = [];
	let validate = async () => (++calls === 1 ? 'x.csl:12:3: error: attribute foo not allowed' : null);
	let r = await generateStyle({ client, inputs, validate, onProgress: s => steps.push(s) });
	assert.equal(r.attempts, 2);
	assert.deepEqual(r.validationErrors, []);
	assert.deepEqual(steps, ['reading', 'writing', 'checking', 'fixing', 'checking', 'done']);
	assert.equal(sent[1].messages.length, 3);
	assert.equal(sent[1].messages[1].role, 'assistant');
	assert.match(sent[1].messages[2].content, /line 12: attribute foo not allowed/);
});

test('undefined macros are caught without the schema validator and sent back', async () => {
	let bad = GOOD.replace('<text macro="author-short"/>', '<text macro="ghost"/>');
	assert.notEqual(bad, GOOD);
	let { client, sent } = scripted([reply(bad), reply(GOOD)]);
	let validated = 0;
	let r = await generateStyle({ client, inputs, validate: async () => { validated++; return null; } });
	assert.equal(r.attempts, 2);
	assert.match(sent[1].messages[2].content, /ghost/);
	assert.equal(validated, 1); // only the style that parsed and had no semantic problems
});

test('a reply with no style is asked again; an unusable last reply throws', async () => {
	let { client, sent } = scripted([{ text: 'Sorry.' }, reply(GOOD)]);
	let r = await generateStyle({ client, inputs, validate: valid });
	assert.equal(r.attempts, 2);
	assert.match(sent[1].messages[2].content, /did not contain/);

	let again = scripted([{ text: 'No.' }, { text: 'No.' }, { text: 'No.' }]);
	await assert.rejects(generateStyle({ client: again.client, inputs, validate: valid }), /did not contain/);
	assert.equal(again.sent.length, 3);
});

test('a cut-off reply is reported as such', async () => {
	let { client, sent } = scripted([{ text: '```xml\n<style version="1.0">', stopReason: 'max_tokens' }, reply(GOOD)]);
	await generateStyle({ client, inputs, validate: valid });
	assert.match(sent[1].messages[2].content, /cut off/);
});

test('after the allowed repairs the best style is still returned with its errors', async () => {
	let { client } = scripted([reply(GOOD), reply(GOOD), reply(GOOD)]);
	let r = await generateStyle({ client, inputs, validate: async () => 'f:1:1: error: nope' });
	assert.equal(r.attempts, 3);
	assert.deepEqual(r.validationErrors, ['line 1: nope']);
	assert.ok(Tree.StyleDoc.fromXML(r.xml));
});

test('maxRepairs 0 means a single try', async () => {
	let { client, sent } = scripted([reply(GOOD)]);
	let r = await generateStyle({ client, inputs, validate: async () => 'f:1:1: error: nope', maxRepairs: 0 });
	assert.equal(sent.length, 1);
	assert.equal(r.validationErrors.length, 1);
});

test('if the validator itself fails the style is returned, flagged as unchecked', async () => {
	let { client } = scripted([reply(GOOD)]);
	let r = await generateStyle({ client, inputs, validate: async () => { throw new Error('worker died'); } });
	assert.equal(r.attempts, 1);
	assert.match(r.validationErrors[0], /could not be checked.*worker died/);
});

test('unused macros are reported but do not trigger a repair', async () => {
	let extra = GOOD.replace('</macro>', '</macro><macro name="spare"><text value="x"/></macro>');
	let { client } = scripted([reply(extra)]);
	let r = await generateStyle({ client, inputs, validate: valid });
	assert.equal(r.attempts, 1);
	assert.deepEqual(r.validationErrors, []);
	assert.match(r.unusedMacros[0], /spare/);
});

test('revising keeps the id of the style being revised', async () => {
	let base = Templates.newStyleXML('numeric', { title: 'Old', id: 'http://typos.local/styles/old' });
	let { client, sent } = scripted([reply(GOOD)]);
	let r = await generateStyle({ client, inputs: { mode: 'revise', title: 'Old', baseXML: base, extra: 'change it' }, validate: valid });
	assert.equal(Tree.StyleDoc.fromXML(r.xml).getInfo('id'), 'http://typos.local/styles/old');
	assert.match(sent[0].messages[0].content[0].text, /current_style/);
});

test('cancelling stops before the next request', async () => {
	let { client, sent } = scripted([reply(GOOD)]);
	let cancelled = false;
	await assert.rejects(
		generateStyle({ client, inputs, validate: valid, isCancelled: () => cancelled, onProgress: s => { if (s === 'reading') cancelled = true; } }),
		CancelledError
	);
	assert.equal(sent.length, 0);
});

test('bad inputs are refused before anything is sent', async () => {
	let { client, sent } = scripted([]);
	await assert.rejects(generateStyle({ client, inputs: { mode: 'new', title: 'x' }, validate: valid }), /Add a style manual/);
	assert.equal(sent.length, 0);
});

test('normalizeErrors handles strings, arrays and empties', () => {
	assert.deepEqual(normalizeErrors(null), []);
	assert.deepEqual(normalizeErrors(''), []);
	assert.deepEqual(normalizeErrors('a:3:4: error: bad thing\n\nplain'), ['line 3: bad thing', 'plain']);
	assert.deepEqual(normalizeErrors(['x']), ['x']);
});

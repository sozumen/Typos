'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const M = require('../../chrome/content/zotero/xpcom/cleanup/workMerge.js');
const J = require('../../chrome/content/zotero/xpcom/import/jurismMapping.js');

test('language tags are cleaned up; nonsense becomes und', () => {
	assert.equal(M.languageTag('en_us'), 'en-US');
	assert.equal(M.languageTag(' LA '), 'la');
	assert.equal(M.languageTag('grc'), 'grc');
	assert.equal(M.languageTag(''), 'und');
	assert.equal(M.languageTag('Latin text'), 'und');
});

test('the other title is kept as an alternate-language title', () => {
	let r = M.mergeTitles(
		{ title: 'Adversus Marcionem', language: 'la', extra: 'note: x' },
		[{ title: 'Against Marcion', language: 'en' }]
	);
	assert.deepEqual(r.added, [{ title: 'Against Marcion', language: 'en' }]);
	let alt = J.parseAlternates(r.extra);
	assert.deepEqual(alt.fields.title, { en: 'Against Marcion' });
	assert.equal(alt.mainLang.title, 'la');
	assert.match(r.extra, /^note: x\nmlz-alternates:/);
});

test('merging again updates the same line and keeps earlier titles', () => {
	let first = M.mergeTitles({ title: 'A', language: 'la', extra: '' }, [{ title: 'B', language: 'en' }]);
	let second = M.mergeTitles({ title: 'A', language: 'la', extra: first.extra }, [{ title: 'C', language: 'fr' }]);
	let alt = J.parseAlternates(second.extra);
	assert.deepEqual(alt.fields.title, { en: 'B', fr: 'C' });
	assert.equal(second.extra.split('\n').filter(l => l.startsWith('mlz-alternates:')).length, 1);
});

test('a title that is already there, or the same as the master, is skipped', () => {
	let r = M.mergeTitles({ title: 'Iliad', extra: '' }, [{ title: 'ILIAD.', language: 'en' }]);
	assert.deepEqual(r.added, []);
	assert.deepEqual(r.skipped, ['ILIAD.']);
	assert.equal(r.extra, '');
});

test('two titles in the same language are both kept', () => {
	let r = M.mergeTitles({ title: 'A', language: 'la', extra: '' }, [
		{ title: 'B', language: 'en' },
		{ title: 'C', language: 'en' }
	]);
	assert.deepEqual(r.added.map(a => a.language), ['en', 'en-x2']);
});

test('suggestMaster picks the fullest record', () => {
	let id = M.suggestMaster([
		{ id: 1, fields: { title: 'x' }, creators: [] },
		{ id: 2, fields: { title: 'x', date: '1900', publisher: 'p' }, creators: [{}] }
	]);
	assert.equal(id, 2);
});

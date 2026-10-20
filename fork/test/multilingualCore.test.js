'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const M = require('../../chrome/content/zotero/xpcom/multilingual/multilingualCore.js');

function settings(over) {
	return M.normalizeSettings(over);
}

test('language tags are normalized, and nonsense is refused', () => {
	assert.equal(M.normalizeTag('en_us'), 'en-US');
	assert.equal(M.normalizeTag(' LA '), 'la');
	assert.equal(M.normalizeTag('grc'), 'grc');
	assert.equal(M.normalizeTag('sr-Latn'), 'sr-Latn');
	assert.equal(M.normalizeTag('Latin text'), null);
	assert.equal(M.normalizeTag(''), null);
});

test('creator text: "Last, First" or a single name', () => {
	assert.deepEqual(M.parseCreatorText('Dekkers, Eligius'), { lastName: 'Dekkers', firstName: 'Eligius', fieldMode: 0 });
	assert.deepEqual(M.parseCreatorText('Origenes'), { lastName: 'Origenes', firstName: '', fieldMode: 1 });
	assert.deepEqual(M.parseCreatorText('Smith,'), { lastName: 'Smith', firstName: '', fieldMode: 1 });
	assert.equal(M.parseCreatorText('  '), null);
	assert.equal(M.formatCreatorText({ lastName: 'Dekkers', firstName: 'Eligius', fieldMode: 0 }), 'Dekkers, Eligius');
	assert.equal(M.formatCreatorText({ lastName: 'Origenes', firstName: '', fieldMode: 1 }), 'Origenes');
});

test('variables are sorted into the setting categories', () => {
	assert.equal(M.categoryForVariable('title'), 'titles');
	assert.equal(M.categoryForVariable('container-title'), 'titles');
	assert.equal(M.categoryForVariable('collection-title-short'), 'titles');
	assert.equal(M.categoryForVariable('publisher'), 'publishers');
	assert.equal(M.categoryForVariable('publisher-place'), 'publishers');
	assert.equal(M.categoryForVariable('genre'), 'other');
});

test('settings read from a preference are cleaned up', () => {
	let s = settings({ titles: { mode: 'variant', languages: ['EN', 'bad tag', 'en'] }, creators: { mode: 'both', languages: ['grc'] }, other: { mode: 'x' } });
	assert.deepEqual(s.titles, { mode: 'variant', languages: ['en'] });
	assert.equal(s.creators.mode, 'variant');
	assert.equal(s.other.mode, 'orig');
	assert.deepEqual(settings(null), M.defaultSettings());
});

test('pickVariant takes the first preferred language that has a value', () => {
	assert.deepEqual(M.pickVariant({ en: 'Against Marcion', fr: '' }, ['fr', 'en']), { tag: 'en', value: 'Against Marcion' });
	assert.equal(M.pickVariant({ en: 'x' }, ['de']), null);
	assert.equal(M.pickVariant(null, ['en']), null);
});

test('text: variant mode replaces, both mode adds in brackets, orig mode leaves alone', () => {
	let variants = { title: { en: 'Against Marcion' } };
	let sources = [{ variable: 'title', field: 'title' }];
	let get = f => variants[f];

	let a = { title: 'Adversus Marcionem' };
	assert.equal(M.substituteText(a, sources, get, settings({ titles: { mode: 'variant', languages: ['en'] } })), true);
	assert.equal(a.title, 'Against Marcion');

	let b = { title: 'Adversus Marcionem' };
	M.substituteText(b, sources, get, settings({ titles: { mode: 'both', languages: ['en'] } }));
	assert.equal(b.title, 'Adversus Marcionem [Against Marcion]');

	let c = { title: 'Adversus Marcionem' };
	assert.equal(M.substituteText(c, sources, get, settings({ titles: { mode: 'orig', languages: ['en'] } })), false);
	assert.equal(c.title, 'Adversus Marcionem');

	let d = { title: 'Adversus Marcionem' };
	assert.equal(M.substituteText(d, sources, get, settings({ titles: { mode: 'variant', languages: ['de'] } })), false);
});

test('text: only the matching category is changed', () => {
	let item = { title: 'T', publisher: 'P' };
	let sources = [{ variable: 'title', field: 'title' }, { variable: 'publisher', field: 'publisher' }];
	M.substituteText(item, sources, () => ({ en: 'X' }), settings({ publishers: { mode: 'variant', languages: ['en'] } }));
	assert.deepEqual(item, { title: 'T', publisher: 'X' });
});

test('names: the variant takes the creator\'s place in the right list', () => {
	let item = { author: [{ family: 'A', given: 'a' }, { literal: 'Origenes' }], editor: [{ family: 'E', given: 'e' }] };
	let entries = [
		{ cslType: 'author', position: 1, variants: { grc: { lastName: 'Ὠριγένης', firstName: '', fieldMode: 1 }, en: { lastName: 'Origen', firstName: '', fieldMode: 1 } } },
		{ cslType: 'editor', position: 0, variants: { en: { lastName: 'Eldridge', firstName: 'Ed', fieldMode: 0 } } }
	];
	assert.equal(M.substituteNames(item, entries, settings({ creators: { mode: 'variant', languages: ['en'] } })), true);
	assert.deepEqual(item.author[1], { literal: 'Origen' });
	assert.deepEqual(item.author[0], { family: 'A', given: 'a' });
	assert.deepEqual(item.editor[0], { family: 'Eldridge', given: 'Ed' });
});

test('names: a missing list or position is skipped, and orig mode changes nothing', () => {
	let item = { author: [{ literal: 'X' }] };
	let entries = [{ cslType: 'translator', position: 0, variants: { en: { lastName: 'T', fieldMode: 1 } } }, { cslType: 'author', position: 3, variants: { en: { lastName: 'T', fieldMode: 1 } } }];
	assert.equal(M.substituteNames(item, entries, settings({ creators: { mode: 'variant', languages: ['en'] } })), false);
	assert.equal(M.substituteNames(item, entries, settings({})), false);
});


test('planAlternates turns an import\'s Extra data into operations', () => {
	let alternates = {
		v: 1,
		fields: { title: { en: 'The Instructor', 'bad tag': 'x' }, court: { ja: '' }, unknown: { en: 'y' } },
		creators: [
			{ index: 0, creatorType: 'author', languageTag: 'ja', firstName: 'ヨーコ', lastName: '小野', fieldMode: 0 },
			{ index: 5, creatorType: 'author', languageTag: 'ja', firstName: '', lastName: 'Gone', fieldMode: 1 },
			{ index: 1, creatorType: 'author', languageTag: 'ja', lastName: 'Ono Group', fieldMode: 1 }
		],
		mainLang: { title: 'de', 'creator:0': 'en', 'creator:9': 'en', unknown: 'fr' }
	};
	let plan = M.planAlternates(alternates, {
		resolveField: name => name === 'unknown' ? null : name,
		creatorCount: 2
	});
	assert.deepEqual(plan.fieldLanguages, [{ field: 'title', language: 'de' }]);
	assert.deepEqual(plan.variants, [{ field: 'title', language: 'en', value: 'The Instructor' }]);
	assert.deepEqual(plan.creatorLanguages, [{ index: 0, language: 'en' }]);
	assert.deepEqual(plan.creatorVariants.map(v => [v.index, v.language, v.name.lastName, v.name.fieldMode]), [
		[0, 'ja', '小野', 0],
		[1, 'ja', 'Ono Group', 1]
	]);
	assert.ok(plan.skipped.length >= 5);
	assert.deepEqual(M.planAlternates(null, { resolveField: x => x, creatorCount: 0 }).variants, []);
});

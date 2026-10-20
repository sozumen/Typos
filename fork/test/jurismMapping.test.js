'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const J = require('../../chrome/content/zotero/xpcom/import/jurismMapping.js');
const schemaData = require('../../resource/schema/fork/schema.json');

// A schema stub backed by the real generated schema, so validity matches the application
const types = new Map(schemaData.itemTypes.map(t => [t.itemType, t]));
const schema = {
	isValidField: (type, field) => !!types.get(type)?.fields.some(f => f.field === field),
	// Like Zotero.ItemFields.getFieldIDFromTypeAndBase(): a base field resolves to the type's own name
	resolveField: (type, field) => {
		let fields = types.get(type)?.fields || [];
		return fields.find(f => f.field === field)?.field
			|| fields.find(f => f.baseField === field)?.field
			|| null;
	},
	isValidCreatorType: (type, ct) => !!types.get(type)?.creatorTypes.some(c => c.creatorType === ct)
};

test('types that exist here are kept, including classic', () => {
	assert.equal(J.mapItemType('classic'), 'classic');
	assert.equal(J.mapItemType('book'), 'book');
	assert.equal(J.mapItemType('case'), 'case');
});

test('Juris-M-only types map to ordinary ones', () => {
	assert.equal(J.mapItemType('gazette'), 'statute');
	assert.equal(J.mapItemType('regulation'), 'statute');
	assert.equal(J.mapItemType('treaty'), 'document');
	assert.equal(J.mapItemType('legalCommentary'), 'bookSection');
	for (let target of Object.values(J.TYPE_MAP)) {
		assert.ok(types.has(target), `${target} must exist in the schema`);
	}
});

test('every Juris-M-only field has a label', () => {
	for (let [field, label] of Object.entries(J.FIELD_LABELS)) {
		assert.ok(label && label !== field, `${field} needs a readable label`);
	}
});

test('a classic item imports unchanged', () => {
	let { json, warnings } = J.mapItem({
		itemType: 'classic',
		fields: { title: 'Iliad', volume: '1', place: 'Oxford', manuscriptType: 'codex' },
		creators: [{ creatorType: 'author', lastName: 'Homer', fieldMode: 1 }]
	}, schema);
	assert.deepEqual(warnings, []);
	assert.equal(json.itemType, 'classic');
	assert.equal(json.title, 'Iliad');
	assert.equal(json.manuscriptType, 'codex');
	assert.equal(json.extra, undefined);
	assert.deepEqual(json.creators, [{ creatorType: 'author', name: 'Homer' }]);
});

test('invalid fields go to Extra with readable labels, existing Extra is kept first', () => {
	let { json, warnings } = J.mapItem({
		itemType: 'regulation',
		fields: {
			nameOfAct: 'Water Act Regulations',
			jurisdiction: 'us:c9',
			regulatoryBody: 'EPA',
			extra: 'Existing note'
		},
		creators: []
	}, schema);
	assert.equal(json.itemType, 'statute');
	assert.equal(json.nameOfAct, 'Water Act Regulations');
	assert.equal(json.extra, 'Existing note\nJurisdiction: us:c9\nAuthority: EPA');
	assert.deepEqual(warnings, ["Item type 'regulation' imported as 'statute'"]);
});

test('empty and null values are skipped', () => {
	let { json } = J.mapItem({
		itemType: 'book',
		fields: { title: 'T', publisher: '', place: null, series: undefined },
		creators: []
	}, schema);
	assert.deepEqual(Object.keys(json).sort(), ['creators', 'itemType', 'title']);
});

test('multi-line values folded in Extra lines cannot inject extra lines', () => {
	let { json } = J.mapItem({
		itemType: 'book',
		fields: { title: 'T', jurisdiction: 'a\nFake: injected' },
		creators: []
	}, schema);
	assert.equal(json.extra.split('\n').length, 1);
	assert.equal(json.extra, 'Jurisdiction: a Fake: injected');
});

test('creator types invalid for the target type are mapped, with a warning only when unexpected', () => {
	let { json, warnings } = J.mapItem({
		itemType: 'hearing',
		fields: { title: 'H' },
		creators: [{ creatorType: 'testimonyBy', firstName: 'Ann', lastName: 'Lee', fieldMode: 0 }]
	}, schema);
	assert.equal(json.creators[0].creatorType, 'contributor');
	assert.deepEqual(json.creators[0], { creatorType: 'contributor', firstName: 'Ann', lastName: 'Lee' });
	assert.deepEqual(warnings, []);
	
	let r = J.mapItem({
		itemType: 'classic',
		fields: { title: 'X' },
		creators: [{ creatorType: 'castMember', firstName: 'A', lastName: 'B', fieldMode: 0 }]
	}, schema);
	assert.equal(r.json.creators[0].creatorType, 'contributor');
	assert.equal(r.warnings.length, 1);
});

test('single-field creators become { name }', () => {
	let { json } = J.mapItem({
		itemType: 'book',
		fields: { title: 'T' },
		creators: [
			{ creatorType: 'author', lastName: 'UNESCO', firstName: '', fieldMode: 1 },
			{ creatorType: 'author', lastName: 'Plato', firstName: '', fieldMode: 0 }
		]
	}, schema);
	assert.deepEqual(json.creators, [
		{ creatorType: 'author', name: 'UNESCO' },
		{ creatorType: 'author', name: 'Plato' }
	]);
});

test('alternate-language data survives as one Extra line and round-trips', () => {
	let alternates = {
		fields: { title: { ja: '日本語 "題"\n二行目' } },
		creators: [{ index: 0, creatorType: 'author', languageTag: 'ja', lastName: '山田', firstName: '太郎' }],
		mainLang: { title: 'en' }
	};
	let { json } = J.mapItem({
		itemType: 'book',
		fields: { title: 'Title', extra: 'keep me' },
		creators: [],
		alternates
	}, schema);
	let lines = json.extra.split('\n');
	assert.equal(lines.length, 2);
	assert.equal(lines[0], 'keep me');
	assert.deepEqual(J.parseAlternates(json.extra), { v: 1, ...alternates });
});

test('no alternates line is written when there are none', () => {
	assert.equal(J.serializeAlternates(null), null);
	assert.equal(J.serializeAlternates({ fields: {}, creators: [], mainLang: {} }), null);
});

test('parseAlternates tolerates garbage and newer versions', () => {
	assert.equal(J.parseAlternates('mlz-alternates: {broken'), null);
	assert.equal(J.parseAlternates('mlz-alternates: {"v":99}'), null);
	assert.equal(J.parseAlternates('nothing here'), null);
	assert.equal(J.parseAlternates(undefined), null);
});

test('normalizeValue is applied to field values', () => {
	let { json } = J.mapItem({
		itemType: 'book',
		fields: { title: 'T', date: '2020-01-01 January 1, 2020' },
		creators: []
	}, { ...schema, normalizeValue: (f, v) => (f === 'date' ? v.replace(/^\S+ /, '') : v) });
	assert.equal(json.date, 'January 1, 2020');
});

test('base field names resolve to the item type\'s own field name', () => {
	let { json, warnings } = J.mapItem({
		itemType: 'gazette',
		fields: { title: 'Official Gazette Notice' },
		creators: []
	}, schema);
	assert.equal(json.itemType, 'statute');
	assert.equal(json.nameOfAct, 'Official Gazette Notice');
	assert.equal(json.title, undefined);
	assert.equal(json.extra, undefined);
	assert.deepEqual(warnings, ["Item type 'gazette' imported as 'statute'"]);
});

test('a field that resolves to an already-filled field goes to Extra instead of overwriting', () => {
	let { json } = J.mapItem({
		itemType: 'regulation',
		fields: { nameOfAct: 'Specific', title: 'Base' },
		creators: []
	}, schema);
	assert.equal(json.nameOfAct, 'Specific');
	assert.equal(json.extra, 'Title: Base');
});

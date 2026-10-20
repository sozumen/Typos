'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const X = require('../../chrome/content/zotero/xpcom/cleanup/cleanupExtra.js');
const C = require('../../chrome/content/zotero/xpcom/cleanup/criticalEditions.js');
const schemaData = require('../../resource/schema/fork/schema.json');

const types = new Map(schemaData.itemTypes.map(t => [t.itemType, t]));
const schema = {
	isValidField: (type, field) => !!types.get(type)?.fields.some(f => f.field === field),
	isValidCreatorType: (type, ct) => !!types.get(type)?.creatorTypes.some(c => c.creatorType === ct)
};

// The three examples from the library
const tertullian = {
	id: 1, itemType: 'classic',
	fields: {
		title: 'Adversus Marcionem',
		referenceSystem: 'Book, chapter',
		originalLanguage: 'la',
		extra: [
			'collection: Corpus Christianorum Series Latina',
			'collection-title: Corpus Christianorum Series Latina',
			'Pages: 77-172',
			'Volume Title: Opera catholica. Adversus Marcionem',
			'Editor: Dekkers || Eligius'
		].join('\n')
	},
	creators: [{ creatorType: 'author', lastName: 'Tertullian', firstName: '', fieldMode: 1 }]
};
const epiphanius = {
	id: 2, itemType: 'classic',
	fields: {
		title: 'Ancoratus',
		extra: [
			'Book-title: Epiphanius',
			'Volume-title: Ancoratus und Panarion <i>haer.</i> 1-33',
			'editor: Bergermann || Marc',
			'note: keep this line'
		].join('\n')
	},
	creators: [{ creatorType: 'author', lastName: 'Epiphanius', firstName: '', fieldMode: 1 }]
};
const clement = {
	id: 3, itemType: 'classic',
	fields: {
		title: 'Paedagogus',
		extra: [
			'collection-title: Sources chrétiennes',
			'container-title: Le pédagogue',
			'volume-title: Livre 1',
			'Editor: Mondésert || Claude',
			'Editor: Marrou || Henri-Irénée'
		].join('\n')
	},
	creators: [{ creatorType: 'author', lastName: 'Clement of Alexandria', firstName: '', fieldMode: 1 }]
};

test('labels are matched whatever their case and spelling', () => {
	let e = X.extractEdition(tertullian.fields.extra);
	assert.equal(e.series, 'Corpus Christianorum Series Latina');
	assert.equal(e.pages, '77-172');
	assert.equal(e.volumeTitle, 'Opera catholica. Adversus Marcionem');
	assert.deepEqual(e.editors, [{ lastName: 'Dekkers', firstName: 'Eligius', fieldMode: 0 }]);
	// both series lines carry the same text, so both can go
	assert.deepEqual([...e.used].sort(), [0, 1, 2, 3, 4]);
	let b = X.extractEdition(epiphanius.fields.extra);
	assert.equal(b.container, 'Epiphanius');
	assert.deepEqual([...b.used].sort(), [0, 1, 2]);
});

test('a name without || is a single-field name', () => {
	assert.deepEqual(X.parseCreator('Aristotle'), { lastName: 'Aristotle', firstName: '', fieldMode: 1 });
	assert.equal(X.parseCreator('  '), null);
});

test('URLs and JSON lines are not read as labels', () => {
	let lines = X.parseLines('https://example.org/x\nmlz-alternates: {"v":1}');
	assert.equal(lines[0].label, null);
	assert.equal(lines[1].norm, 'mlz-alternates');
});

test('different text on a second series line is kept, not dropped', () => {
	let e = X.extractEdition('collection: A\nseries: B');
	assert.equal(e.series, 'A');
	assert.deepEqual(e.conflicts, ['series: B']);
	assert.deepEqual([...e.used], [0]);
});

test('the identification test needs type, author, title, an editor in Extra, and a container', () => {
	assert.equal(C.test(tertullian).matches, true);
	assert.equal(C.test(epiphanius).matches, true);
	assert.equal(C.test(clement).matches, true);
	let noAuthor = { ...clement, creators: [] };
	assert.deepEqual(C.test(noAuthor).missing, ['author']);
	assert.equal(C.test(noAuthor).nearMiss, true);
	let book = { ...clement, itemType: 'book' };
	assert.equal(C.test(book).matches, false);
	assert.equal(C.test({ ...clement, fields: { title: 'x', extra: 'Editor: A || B' } }).matches, false);
});

test('an item with pages becomes a book section; without pages, a book', () => {
	assert.equal(C.planItem(tertullian, schema).newType, 'bookSection');
	assert.equal(C.planItem(epiphanius, schema).newType, 'book');
});

test('volume designations are told apart from titles', () => {
	for (let t of ['Livre 1', 'Vol. 2', 'Band 3', 'Tome II', '4', 'Teil 1-2']) {
		assert.equal(C.looksLikeDesignation(t), true, t);
	}
	for (let t of ['Opera catholica', 'Ancoratus und Panarion haer. 1-33']) {
		assert.equal(C.looksLikeDesignation(t), false, t);
	}
});

test('Tertullian: section of a volume, series filled in, no multi-volume parent', () => {
	let plan = C.planItem(tertullian, schema);
	assert.equal(plan.set.bookTitle, 'Opera catholica. Adversus Marcionem');
	assert.equal(plan.set.pages, '77-172');
	assert.equal(plan.set.series, 'Corpus Christianorum Series Latina');
	assert.equal(plan.multiKey, null);
	assert.ok(plan.volumeKey);
	assert.deepEqual(plan.workFields, { referenceSystem: 'Book, chapter', originalLanguage: 'la' });
});

test('Epiphanius: a whole volume in a set called "Epiphanius"', () => {
	let plan = C.planItem(epiphanius, schema);
	assert.equal(plan.set.title, 'Ancoratus und Panarion <i>haer.</i> 1-33');
	assert.equal(plan.entity.multiVolume.title, 'Epiphanius');
	assert.equal(plan.volumeKey, null);
	assert.ok(plan.itemIsVolume);
});

test('Clement: "Livre 1" is joined to the container title', () => {
	let plan = C.planItem(clement, schema);
	assert.equal(plan.set.title, 'Le pédagogue, Livre 1');
	assert.equal(plan.entity.multiVolume.title, 'Le pédagogue');
	assert.equal(plan.addEditors.length, 2);
});

test('resolve: Extra lines that moved are removed, others kept', () => {
	let plan = C.planItem(epiphanius, schema);
	let r = C.resolve(plan, new Set(), epiphanius, schema);
	assert.equal(r.fields.extra, 'note: keep this line');
	assert.equal(r.itemType, 'book');
	assert.deepEqual(r.creators.map(c => c.creatorType), ['author', 'editor']);
});

test('resolve: with no Work record, the work fields go to Extra rather than vanish', () => {
	let plan = C.planItem(tertullian, schema);
	let off = C.resolve(plan, new Set(), tertullian, schema);
	assert.match(off.fields.extra, /Reference System: Book, chapter/);
	assert.match(off.fields.extra, /Original Language: la/);
	assert.equal(off.fields.referenceSystem, null);
	let on = C.resolve(plan, new Set([plan.workKey]), tertullian, schema);
	assert.doesNotMatch(on.fields.extra, /Reference System/);
	assert.deepEqual(on.links, [{ type: 'criticalEditionOf', from: 'item', to: plan.workKey }]);
});

test('resolve: links follow the ticked suggestions', () => {
	let plan = C.planItem(tertullian, schema);
	let all = new Set([plan.workKey, plan.volumeKey]);
	let r = C.resolve(plan, all, tertullian, schema);
	assert.deepEqual(r.links.map(l => l.type + ':' + (l.from === 'item' ? 'item' : 'x')), ['criticalEditionOf:item', 'partOf:item']);
	let clementPlan = C.planItem(clement, schema);
	let r2 = C.resolve(clementPlan, new Set([clementPlan.workKey, clementPlan.multiKey]), clement, schema);
	assert.deepEqual(r2.links.map(l => [l.type, l.to === clementPlan.multiKey]), [['criticalEditionOf', false], ['partOf', true]]);
});

test('planAll: two editions of one work share one Work suggestion', () => {
	let second = {
		id: 4, itemType: 'classic',
		fields: { title: 'Adversus Marcionem', extra: 'Book-title: Tertullian, Opera\nVolume-title: Contre Marcion 1\nEditor: Braun || René' },
		creators: [{ creatorType: 'author', lastName: 'Tertullian', firstName: '', fieldMode: 1 }]
	};
	let { items, suggestions } = C.planAll([tertullian, second, epiphanius], schema);
	assert.equal(items.length, 3);
	let works = suggestions.filter(s => s.kind === 'work');
	assert.equal(works.length, 2);
	let shared = works.find(w => w.title === 'Adversus Marcionem');
	assert.deepEqual(shared.itemIDs, [1, 4]);
});

test('planAll: an existing plain Classic record is offered as the work', () => {
	let existing = {
		id: 9, itemType: 'classic', fields: { title: 'Paedagogus' },
		creators: [{ creatorType: 'author', lastName: 'Clement of Alexandria', firstName: '', fieldMode: 1 }]
	};
	let { suggestions } = C.planAll([clement, existing], schema);
	let work = suggestions.find(s => s.kind === 'work');
	assert.equal(work.existingID, 9);
});

test('planAll: lists near misses and ignores other items', () => {
	let noAuthor = { ...clement, id: 7, creators: [] };
	let other = { id: 8, itemType: 'book', fields: { title: 'x' }, creators: [] };
	let { items, nearMisses } = C.planAll([noAuthor, other, tertullian], schema);
	assert.equal(items.length, 1);
	assert.deepEqual(nearMisses, [7]);
});

test('series conflict: the field wins and the Extra lines stay', () => {
	let s = { ...tertullian, fields: { ...tertullian.fields, series: 'CCSL' } };
	let plan = C.planItem(s, schema);
	assert.equal(plan.set.series, undefined);
	assert.equal(plan.warnings.length, 1);
	let r = C.resolve(plan, new Set(), s, schema);
	assert.match(r.fields.extra, /collection: Corpus Christianorum Series Latina/);
});

test('entityData builds records with the right type, title and creators', () => {
	let { suggestions } = C.planAll([clement], schema);
	let by = k => C.entityData(suggestions.find(s => s.kind === k));
	assert.equal(by('work').itemType, 'classic');
	assert.equal(by('work').creators[0].lastName, 'Clement of Alexandria');
	assert.equal(by('multiVolume').fields.title, 'Le pédagogue');
	assert.equal(by('multiVolume').fields.series, 'Sources chrétiennes');
});

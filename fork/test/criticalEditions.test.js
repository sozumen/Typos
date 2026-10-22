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

test('the identification test needs type, author, title and an editor', () => {
	assert.equal(C.test(tertullian).matches, true);
	assert.equal(C.test(epiphanius).matches, true);
	assert.equal(C.test(clement).matches, true);
	let noAuthor = { ...clement, creators: [] };
	assert.deepEqual(C.test(noAuthor).missing, ['author']);
	assert.equal(C.test(noAuthor).nearMiss, true);
	let book = { ...clement, itemType: 'book' };
	assert.equal(C.test(book).matches, false);
	// No container or volume title is needed any more
	assert.equal(C.test({ ...clement, fields: { title: 'x', extra: 'Editor: A || B' } }).matches, true);
	// An author alone is a plain work, not an edition
	let plain = { ...clement, fields: { title: 'Iliad' } };
	assert.deepEqual(C.test(plain).missing, ['editor or contributor']);
	assert.equal(C.test(plain).nearMiss, false);
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
	// The set's title is the title; the volume's own title goes in Volume Title
	assert.equal(plan.set.title, 'Epiphanius');
	assert.equal(plan.set.volumeTitle, 'Ancoratus und Panarion <i>haer.</i> 1-33');
	assert.equal(plan.entity.multiVolume.title, 'Epiphanius');
	assert.equal(plan.volumeKey, null);
	assert.ok(plan.itemIsVolume);
});

test('Clement: "Livre 1" goes in Volume Title, the set\'s title in Title', () => {
	let plan = C.planItem(clement, schema);
	assert.equal(plan.set.title, 'Le pédagogue');
	assert.equal(plan.set.volumeTitle, 'Livre 1');
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

test('planAll: a shared record gets the fields from whichever item has them', () => {
	let plain = {
		id: 10, itemType: 'classic',
		fields: { title: 'Adversus Marcionem', extra: 'Book-title: X\nVolume-title: Y\nEditor: A || B' },
		creators: [{ creatorType: 'author', lastName: 'Tertullian', firstName: '', fieldMode: 1 }]
	};
	let { suggestions } = C.planAll([plain, tertullian], schema);
	let work = suggestions.find(s => s.kind === 'work');
	assert.equal(work.build.fields.referenceSystem, 'Book, chapter');
	assert.equal(C.entityData(work).fields.originalLanguage, 'la');
});


test('without a Volume Title field, the set and volume titles are joined as before', () => {
	let noVolumeTitle = {
		isValidField: (type, field) => field !== 'volumeTitle' && schema.isValidField(type, field),
		isValidCreatorType: schema.isValidCreatorType
	};
	let plan = C.planItem(clement, noVolumeTitle);
	assert.equal(plan.set.title, 'Le pédagogue, Livre 1');
	assert.equal(plan.set.volumeTitle, undefined);
	assert.equal(C.planItem(epiphanius, noVolumeTitle).set.title, 'Ancoratus und Panarion <i>haer.</i> 1-33');
});

test('a volume title Zotero already moved from Extra into the field is still read', () => {
	let lines = tertullian.fields.extra.split('\n').filter(l => !/^Volume Title/.test(l));
	let moved = {
		...tertullian,
		fields: { ...tertullian.fields, extra: lines.join('\n'), volumeTitle: 'Opera catholica. Adversus Marcionem' }
	};
	assert.equal(C.test(moved).matches, true);
	let plan = C.planItem(moved, schema);
	assert.equal(plan.set.bookTitle, 'Opera catholica. Adversus Marcionem');
	// It is now the book title, so the field is cleared rather than kept twice
	assert.deepEqual(plan.clear, ['volumeTitle']);
	let r = C.resolve(plan, new Set(), moved, schema);
	assert.equal(r.fields.volumeTitle, null);
	assert.equal(r.fields.bookTitle, 'Opera catholica. Adversus Marcionem');
});

test('a section in a volume of a set: Book Title is the set, Volume Title the volume', () => {
	let section = {
		...epiphanius, id: 20,
		fields: { ...epiphanius.fields, extra: epiphanius.fields.extra + '\nPages: 1-100' }
	};
	let { items, suggestions } = C.planAll([section], schema);
	let plan = items[0];
	assert.equal(plan.newType, 'bookSection');
	assert.equal(plan.set.bookTitle, 'Epiphanius');
	assert.equal(plan.set.volumeTitle, 'Ancoratus und Panarion <i>haer.</i> 1-33');
	let volume = suggestions.find(s => s.kind === 'volume');
	// The preview names the volume in full; the record splits it like the item
	assert.equal(volume.title, 'Ancoratus und Panarion <i>haer.</i> 1-33');
	let data = C.entityData(volume, schema);
	assert.equal(data.itemType, 'book');
	assert.equal(data.fields.title, 'Epiphanius');
	assert.equal(data.fields.volumeTitle, 'Ancoratus und Panarion <i>haer.</i> 1-33');
});

test('a set is created as a Multi-Volume Work when that type exists', () => {
	let { suggestions } = C.planAll([clement], schema);
	let set = suggestions.find(s => s.kind === 'multiVolume');
	let data = C.entityData(set, schema);
	assert.equal(data.itemType, 'multiVolumeWork');
	assert.equal(data.fields.title, 'Le pédagogue');
	assert.equal(data.fields.series, 'Sources chrétiennes');
	// Without the schema (or the type) it is a Book, as before
	assert.equal(C.entityData(set).itemType, 'book');
});


// Classic Works whose editor is a creator, or filed as a contributor
const author = { creatorType: 'author', lastName: 'Tertullian', firstName: '', fieldMode: 1 };
const evans = { creatorType: 'editor', lastName: 'Evans', firstName: 'Ernest', fieldMode: 0 };
const asContributor = c => ({ ...c, creatorType: 'contributor' });

test('an editor in the creators is enough, with nothing in Extra', () => {
	let item = { id: 30, itemType: 'classic', fields: { title: 'Adversus Marcionem' }, creators: [author, evans] };
	assert.equal(C.test(item).matches, true);
	let { items, suggestions } = C.planAll([item], schema);
	let plan = items[0];
	assert.equal(plan.newType, 'book');
	// The edition keeps the work's title, and is linked to a new work record
	assert.equal(plan.set.title, undefined);
	assert.deepEqual(plan.addEditors, []);
	assert.deepEqual(plan.contributorsToEditors, []);
	assert.deepEqual(suggestions.map(s => s.kind), ['work']);
	let r = C.resolve(plan, new Set([plan.workKey]), item, schema);
	assert.equal(r.itemType, 'book');
	assert.deepEqual(r.creators.map(c => c.creatorType), ['author', 'editor']);
	assert.deepEqual(r.links, [{ type: 'criticalEditionOf', from: 'item', to: plan.workKey }]);
});

test('a contributor stands in for a missing editor and becomes one', () => {
	let item = { id: 31, itemType: 'classic', fields: { title: 'Adversus Marcionem' }, creators: [author, asContributor(evans)] };
	assert.equal(C.test(item).matches, true);
	let plan = C.planItem(item, schema);
	assert.equal(plan.contributorsToEditors.length, 1);
	let r = C.resolve(plan, new Set(), item, schema);
	assert.deepEqual(r.creators.map(c => c.creatorType), ['author', 'editor']);
	assert.equal(r.creators[1].lastName, 'Evans');
});

test('with a real editor, contributors stay contributors', () => {
	let other = { creatorType: 'contributor', lastName: 'Helper', firstName: 'A', fieldMode: 0 };
	let item = { id: 32, itemType: 'classic', fields: { title: 'Adversus Marcionem' }, creators: [author, evans, other] };
	let plan = C.planItem(item, schema);
	assert.deepEqual(plan.contributorsToEditors, []);
	let r = C.resolve(plan, new Set(), item, schema);
	assert.deepEqual(r.creators.map(c => c.creatorType), ['author', 'editor', 'contributor']);
});

test('"Contributor:" lines in Extra become editors only when there is no editor', () => {
	let item = {
		id: 33, itemType: 'classic',
		fields: { title: 'Adversus Marcionem', extra: 'Contributor: Evans || Ernest\nkeep: me' },
		creators: [author]
	};
	assert.equal(C.test(item).matches, true);
	let plan = C.planItem(item, schema);
	assert.deepEqual(plan.addEditors.map(e => e.lastName), ['Evans']);
	let r = C.resolve(plan, new Set(), item, schema);
	assert.equal(r.fields.extra, 'keep: me');
	assert.deepEqual(r.creators.map(c => c.creatorType), ['author', 'editor']);

	let withEditor = { ...item, id: 34, creators: [author, evans] };
	let plan2 = C.planItem(withEditor, schema);
	assert.deepEqual(plan2.addEditors, []);
	let r2 = C.resolve(plan2, new Set(), withEditor, schema);
	assert.match(r2.fields.extra, /Contributor: Evans \|\| Ernest/);
});

test('a volume record gets the editors from the creators as well as from Extra', () => {
	let item = {
		id: 35, itemType: 'classic',
		fields: { title: 'Adversus Marcionem', extra: 'Volume Title: Opera catholica\nPages: 1-20\nEditor: Dekkers || Eligius' },
		creators: [author, asContributor(evans)]
	};
	let { items, suggestions } = C.planAll([item], schema);
	assert.equal(items[0].newType, 'bookSection');
	// There is an editor in Extra, so the contributor stays a contributor
	assert.deepEqual(items[0].contributorsToEditors, []);
	let volume = C.entityData(suggestions.find(s => s.kind === 'volume'), schema);
	assert.deepEqual(volume.creators.map(c => c.lastName), ['Dekkers']);

	let both = { ...item, id: 36, creators: [author, evans] };
	let v2 = C.entityData(C.planAll([both], schema).suggestions.find(s => s.kind === 'volume'), schema);
	assert.deepEqual(v2.creators.map(c => c.lastName), ['Evans', 'Dekkers']);
});

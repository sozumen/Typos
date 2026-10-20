'use strict';

// Runs the importer's SQL against a database built from Juris-M's own schema files, so column
// and table names are checked against the real thing rather than against assumptions.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { DatabaseSync } = require('node:sqlite');

const ROOT = path.join(__dirname, '..', '..');
const schemaData = require(path.join(ROOT, 'resource/schema/fork/schema.json'));

// --- Load the importer with a minimal Zotero global -------------------------------------------

function loadImporter() {
	let Zotero = {
		Date: { sqlToISO8601: v => v.replace(' ', 'T') + 'Z' }
	};
	let context = vm.createContext({ Zotero, PathUtils: path, IOUtils: {}, console });
	for (let file of ['jurismMapping.js', 'jurismImport.js']) {
		let code = fs.readFileSync(path.join(ROOT, 'chrome/content/zotero/xpcom/import', file), 'utf8');
		vm.runInContext(code, context, { filename: file });
	}
	return Zotero;
}

// --- Adapter exposing the subset of Zotero.DBConnection the importer uses ---------------------

class NodeDB {
	constructor(db) {
		this.db = db;
	}
	_args(params) {
		return params === undefined ? [] : Array.isArray(params) ? params : [params];
	}
	async queryAsync(sql, params) {
		return this.db.prepare(sql).all(...this._args(params)).map(r => ({ ...r }));
	}
	async valueQueryAsync(sql, params) {
		let row = this.db.prepare(sql).get(...this._args(params));
		return row ? Object.values(row)[0] : false;
	}
	async columnQueryAsync(sql, params) {
		return this.db.prepare(sql).all(...this._args(params)).map(r => Object.values(r)[0]);
	}
	async tableExists(name) {
		return !!this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
	}
}

// --- Build a Juris-M-shaped database --------------------------------------------------------

function buildFixture() {
	let db = new DatabaseSync(':memory:');
	// Some referenced tables (e.g., fieldFormats) are created at runtime by Juris-M, not in the schema files
	db.exec('PRAGMA foreign_keys = OFF');
	for (let file of ['jurism-userdata.sql', 'jurism-multilingual.sql']) {
		db.exec(fs.readFileSync(path.join(__dirname, 'fixtures', file), 'utf8'));
	}
	// The tables exist in the schema files; Juris-M fills them at runtime from its global schema
	db.exec(`
		INSERT INTO itemTypes (itemTypeID, typeName) VALUES (1,'book'),(2,'classic'),(3,'note'),(4,'attachment'),(5,'annotation'),(6,'regulation');
		INSERT INTO fields (fieldID, fieldName) VALUES (1,'title'),(2,'date'),(3,'jurisdiction'),(4,'extra');
		INSERT INTO creatorTypes (creatorTypeID, creatorType) VALUES (1,'author'),(2,'translator');
		INSERT INTO libraries (libraryID, type, editable, filesEditable) VALUES (1,'user',1,1);
	`);
	let run = (sql, ...params) => db.prepare(sql).run(...params);
	let item = (id, typeID, key) => run(
		"INSERT INTO items (itemID, itemTypeID, libraryID, key, dateAdded, dateModified) "
		+ "VALUES (?,?,1,?,'2020-01-02 03:04:05','2021-02-03 04:05:06')", id, typeID, key
	);
	let value = (valueID, text) => run("INSERT INTO itemDataValues VALUES (?,?)", valueID, text);
	let data = (itemID, fieldID, valueID) => run("INSERT INTO itemData VALUES (?,?,?)", itemID, fieldID, valueID);
	
	// 1: a classic work with a main-language creator in itemCreatorsMain
	item(1, 2, 'CLASSIC1');
	value(1, 'Iliad'); data(1, 1, 1);
	value(2, '-0750 c. 750 BCE'); data(1, 2, 2);
	run("INSERT INTO creators VALUES (1,'','Homer',1)");
	run("INSERT INTO itemCreatorsMain VALUES (1,1,1,0,'grc')");
	
	// 2: a multilingual book with alternate title and alternate creator; creator in itemCreators
	item(2, 1, 'BOOK0002');
	value(3, 'Tale'); data(2, 1, 3);
	value(4, '物語'); run("INSERT INTO itemDataAlt VALUES (2,1,'ja',4)");
	run("INSERT INTO itemDataMain VALUES (2,1,'en')");
	run("INSERT INTO creators VALUES (2,'Jane','Doe',0)");
	run("INSERT INTO itemCreators VALUES (2,2,1,0)");
	run("INSERT INTO creators VALUES (3,'太郎','山田',0)");
	run("INSERT INTO itemCreatorsAlt VALUES (2,3,1,0,'ja')");
	
	// 3: a Juris-M-only type with a Juris-M-only field
	item(3, 6, 'REGUL003');
	value(5, 'Water Rules'); data(3, 1, 5);
	value(6, 'us:c9'); data(3, 3, 6);
	
	// 4: child note; 5: child attachment; 6: annotation on the attachment
	item(4, 3, 'NOTE0004');
	run("INSERT INTO itemNotes VALUES (4,2,'<p>hello</p>','hello')");
	item(5, 4, 'ATTACH05');
	run("INSERT INTO itemAttachments (itemID, parentItemID, linkMode, contentType, path) VALUES (5,2,0,'application/pdf','storage:paper.pdf')");
	item(6, 5, 'ANNOT006');
	run("INSERT INTO itemAnnotations VALUES (6,5,1,'Ann','quoted','comment','#ffd400','12','00001|000100|00000','{\"pageIndex\":11}',0)");
	
	// 7: trashed item
	item(7, 1, 'TRASH007');
	run("INSERT INTO deletedItems (itemID) VALUES (7)");
	
	// Collections: PARENT01 > CHILD001, with item 1 in the child
	run("INSERT INTO collections (collectionID, collectionName, parentCollectionID, libraryID, key) VALUES (1,'Parent',NULL,1,'PARENT01')");
	run("INSERT INTO collections (collectionID, collectionName, parentCollectionID, libraryID, key) VALUES (2,'Child',1,1,'CHILD001')");
	run("INSERT INTO collectionItems (collectionID, itemID) VALUES (2,1)");
	
	// Tags and relations
	run("INSERT INTO tags VALUES (1,'epic')");
	run("INSERT INTO itemTags VALUES (1,1,0)");
	run("INSERT INTO relationPredicates VALUES (1,'dc:relation'),(2,'owl:sameAs')");
	run("INSERT INTO itemRelations VALUES (1,1,'http://zotero.org/users/local/abcd1234/items/BOOK0002')");
	run("INSERT INTO itemRelations VALUES (1,2,'http://zotero.org/users/123/items/XXXXXXXX')");
	
	return db;
}

// Objects created inside the vm context have a different Object.prototype; compare plain copies
const plain = x => JSON.parse(JSON.stringify(x));

// --- Tests ------------------------------------------------------------------------------------

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

async function readFixture(options = {}) {
	let Zotero = loadImporter();
	let report = { counts: {}, warnings: [], typeChanges: {}, failed: [] };
	let source = await Zotero.JurismImport._internals.readSource(new NodeDB(buildFixture()), options, report);
	return { Zotero, source, report };
}

test('reads items, excluding the trash by default', async () => {
	let { source } = await readFixture();
	let keys = Array.from(source.items.values()).map(i => i.key).sort();
	assert.deepEqual(keys, ['ANNOT006', 'ATTACH05', 'BOOK0002', 'CLASSIC1', 'NOTE0004', 'REGUL003']);
	
	let withTrash = (await readFixture({ includeTrashed: true })).source;
	assert.equal(withTrash.items.size, 7);
	assert.equal(Array.from(withTrash.items.values()).find(i => i.key === 'TRASH007').deleted, true);
});

test('reads fields, dates and the user library id', async () => {
	let { source } = await readFixture();
	let classic = Array.from(source.items.values()).find(i => i.key === 'CLASSIC1');
	assert.equal(source.libraryID, 1);
	assert.equal(classic.itemType, 'classic');
	assert.equal(classic.fields.title, 'Iliad');
	assert.equal(classic.fields.date, '-0750 c. 750 BCE');
	assert.equal(classic.dateAdded, '2020-01-02 03:04:05');
});

test('reads creators from itemCreatorsMain and from itemCreators', async () => {
	let { source } = await readFixture();
	let byKey = Object.fromEntries(Array.from(source.items.values()).map(i => [i.key, i]));
	assert.deepEqual(plain(byKey.CLASSIC1.creators), [
		{ creatorType: 'author', firstName: '', lastName: 'Homer', fieldMode: 1 }
	]);
	assert.equal(byKey.CLASSIC1.alternates.mainLang['creator:0'], 'grc');
	assert.deepEqual(plain(byKey.BOOK0002.creators), [
		{ creatorType: 'author', firstName: 'Jane', lastName: 'Doe', fieldMode: 0 }
	]);
});

test('reads alternate-language data', async () => {
	let { source } = await readFixture();
	let book = Array.from(source.items.values()).find(i => i.key === 'BOOK0002');
	assert.deepEqual(plain(book.alternates.fields), { title: { ja: '物語' } });
	assert.deepEqual(plain(book.alternates.mainLang), { title: 'en' });
	assert.deepEqual(plain(book.alternates.creators), [{
		index: 0, creatorType: 'author', languageTag: 'ja', firstName: '太郎', lastName: '山田', fieldMode: 0
	}]);
});

test('reads notes, attachments and annotations with resolved parent keys', async () => {
	let { source } = await readFixture();
	let byKey = Object.fromEntries(Array.from(source.items.values()).map(i => [i.key, i]));
	assert.equal(byKey.NOTE0004.note, '<p>hello</p>');
	assert.equal(byKey.NOTE0004.parentKey, 'BOOK0002');
	assert.deepEqual(plain(byKey.ATTACH05.attachment), {
		linkMode: 'imported_file', contentType: 'application/pdf', path: 'storage:paper.pdf'
	});
	assert.equal(byKey.ATTACH05.parentKey, 'BOOK0002');
	assert.equal(byKey.ANNOT006.parentKey, 'ATTACH05');
	assert.equal(byKey.ANNOT006.annotation.annotationType, 'highlight');
	assert.equal(byKey.ANNOT006.annotation.annotationText, 'quoted');
	assert.equal(byKey.ANNOT006.annotation.annotationPosition, '{"pageIndex":11}');
});

test('annotations can be skipped', async () => {
	let { source } = await readFixture({ importAnnotations: false });
	assert.ok(!Array.from(source.items.values()).some(i => i.key === 'ANNOT006'));
});

test('reads collections, hierarchy, membership, tags and only item-to-item relations', async () => {
	let { source, report } = await readFixture();
	let byKey = Object.fromEntries(Array.from(source.items.values()).map(i => [i.key, i]));
	let collections = Array.from(source.collections.values());
	assert.deepEqual(
		collections.map(c => [c.key, c.parentID]).sort(),
		[['CHILD001', 1], ['PARENT01', null]]
	);
	assert.deepEqual(plain(byKey.CLASSIC1.collections), ['CHILD001']);
	assert.deepEqual(plain(byKey.CLASSIC1.tags), [{ tag: 'epic', type: 0 }]);
	assert.deepEqual(plain(byKey.CLASSIC1.relations), {
		'dc:relation': ['http://zotero.org/users/local/abcd1234/items/BOOK0002']
	});
	assert.match(report.warnings.join(' '), /owl:sameAs/);
});

test('entries map Juris-M-only types and keep everything', async () => {
	let { Zotero, source } = await readFixture();
	let report = { counts: {}, warnings: [], typeChanges: {}, failed: [] };
	let entries = Array.from(source.items.values())
		.map(src => Zotero.JurismImport._internals.toEntry(src, schema, report, {}));
	let byKey = Object.fromEntries(entries.map(e => [e.key, e]));
	
	assert.equal(byKey.CLASSIC1.json.itemType, 'classic');
	assert.deepEqual(plain(byKey.CLASSIC1.json.tags), [{ tag: 'epic', type: 0 }]);
	assert.deepEqual(plain(byKey.CLASSIC1.json.collections), ['CHILD001']);
	assert.equal(byKey.CLASSIC1.json.dateAdded, '2020-01-02T03:04:05Z');
	
	assert.equal(byKey.REGUL003.json.itemType, 'statute');
	// The stored base field 'title' resolves to statute's own 'nameOfAct'
	assert.equal(byKey.REGUL003.json.nameOfAct, 'Water Rules');
	assert.equal(byKey.REGUL003.json.title, undefined);
	assert.equal(byKey.REGUL003.json.extra, 'Jurisdiction: us:c9');
	assert.deepEqual(plain(report.typeChanges), { regulation: 1 });
	
	// Alternates preserved in Extra
	assert.match(byKey.BOOK0002.json.extra, /^mlz-alternates: /);
	
	// Children point at parents and sort after them
	assert.equal(byKey.NOTE0004.kind, 'child');
	assert.equal(byKey.NOTE0004.json.parentItem, 'BOOK0002');
	assert.equal(byKey.ATTACH05.json.filename, 'paper.pdf');
	assert.equal(byKey.ATTACH05.json.linkMode, 'imported_file');
	assert.equal(byKey.ANNOT006.kind, 'annotation');
	assert.equal(byKey.ANNOT006.json.parentItem, 'ATTACH05');
	// Child items don't carry collection membership
	assert.equal(byKey.NOTE0004.json.collections, undefined);
});

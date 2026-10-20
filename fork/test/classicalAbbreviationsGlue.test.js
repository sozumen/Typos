"use strict";

/**
 * Tests Zotero.ClassicalAbbreviations (storage, profiles, resolution, scope) with a minimal stub
 * of the Zotero environment. The real thing is exercised by test/tests/classicalAbbreviationsTest.js
 * inside the application.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');

const XPCOM = path.join(__dirname, '..', '..', 'chrome', 'content', 'zotero', 'xpcom');

function makeEnvironment() {
	let dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'abbr-'));
	let prefs = new Map();
	let defaults = {
		'classicalAbbreviations.mode': 'off',
		'classicalAbbreviations.active': '',
		'classicalAbbreviations.scope': 'classic',
		'classicalAbbreviations.abbreviateWorks': true,
		'classicalAbbreviations.abbreviateAuthors': true,
		'classicalAbbreviations.abbreviateJournals': true,
		'classicalAbbreviations.abbreviateSeries': true,
		'classicalAbbreviations.abbreviatePublishers': false,
		'classicalAbbreviations.abbreviatePlaces': false,
		'classicalAbbreviations.preferItemAbbreviations': true,
		'classicalAbbreviations.profiles': '',
		'classicalAbbreviations.styleProfiles': ''
	};
	let itemTypeNames = { 1: 'classic', 2: 'journalArticle' };

	let builtinJournals = { 'academy of management journal': 'Acad. Manage. J.' };

	let Zotero = {
		debug() {},
		logError(e) { throw e; },
		defineProperty: (obj, name, desc) => Object.defineProperty(obj, name, desc),
		Prefs: {
			get: key => (prefs.has(key) ? prefs.get(key) : defaults[key]),
			set: (key, value) => { prefs.set(key, value); },
			clear: key => { prefs.delete(key); },
			registerObserver: () => 1,
			unregisterObserver: () => {}
		},
		DataDirectory: { dir: dataDir },
		ItemTypes: { getName: id => itemTypeNames[id] },
		File: { getContentsAsync: async p => fs.readFileSync(p, 'utf8') },
		Cite: {
			getAbbreviation(listname, obj, jurisdiction, category, key) {
				let hit = builtinJournals[String(key).toLowerCase()];
				obj[jurisdiction] = obj[jurisdiction] || {};
				obj[jurisdiction][category] = obj[jurisdiction][category] || {};
				// Like the real one, return the input when there is nothing better
				obj[jurisdiction][category][key] = hit || key;
			}
		}
	};

	let context = vm.createContext({
		Zotero,
		PathUtils: {
			join: (...p) => path.join(...p),
			filename: p => path.basename(p)
		},
		IOUtils: {
			exists: async p => fs.existsSync(p),
			makeDirectory: async p => fs.mkdirSync(p, { recursive: true }),
			getChildren: async d => fs.readdirSync(d).map(f => path.join(d, f)),
			readUTF8: async p => fs.readFileSync(p, 'utf8'),
			writeUTF8: async (p, text) => fs.writeFileSync(p, text),
			remove: async p => fs.rmSync(p, { force: true })
		}
	});
	for (let file of ['abbreviationIndex.js', 'abbreviationProfiles.js', 'classicalAbbreviations.js']) {
		vm.runInContext(fs.readFileSync(path.join(XPCOM, file), 'utf8'), context, { filename: file });
	}
	return { Zotero, CA: Zotero.ClassicalAbbreviations, dataDir };
}

// Objects created in the vm have a different Object prototype; compare via JSON
const plain = x => JSON.parse(JSON.stringify(x));

const journalsList = JSON.stringify({
	name: 'Journals', id: 'journals',
	entries: [
		{ type: 'journal', full: 'The Classical Quarterly', abbreviation: 'CQ' },
		{ type: 'series', full: 'Loeb Classical Library', abbreviation: 'LCL' },
		{ type: 'work', full: 'Iliad', abbreviation: 'Il.', author: 'Homer' },
		{ type: 'author', full: 'Homer', abbreviation: 'Hom.' }
	]
});
const altList = JSON.stringify({
	name: 'Alternative', id: 'alternative',
	entries: [{ type: 'journal', full: 'The Classical Quarterly', abbreviation: 'Class. Q.' }]
});

const classicItem = { itemTypeID: 1 };
const articleItem = { itemTypeID: 2 };
const article = () => ({ title: 'A Study', 'container-title': 'The Classical Quarterly' });

test('imported lists are stored, activated, and survive a reload', async () => {
	let { CA, Zotero } = makeEnvironment();
	await CA.init();
	await CA.importText(journalsList, { format: 'json' });
	assert.deepEqual(plain(CA.getActiveIDs()), ['journals']);
	assert.equal(CA.getLists()[0].count, 4);

	CA.uninit();
	await CA.init();
	assert.equal(CA.getLists().length, 1);
});

test('getAvailableLists puts the built-in journal table first, getLists omits it', async () => {
	let { CA } = makeEnvironment();
	await CA.init();
	await CA.importText(journalsList, { format: 'json' });
	let available = CA.getAvailableLists();
	assert.equal(available[0].id, 'zotero-journals');
	assert.equal(available[0].builtin, true);
	assert.equal(CA.getLists().length, 1);
	assert.equal(available.length, 2);
});

test('a list cannot take the built-in list ID', async () => {
	let { CA } = makeEnvironment();
	await CA.init();
	await CA.importText(JSON.stringify({ name: 'x', id: 'zotero-journals', entries: [] }), { format: 'json' });
	assert.equal(CA.getLists()[0].id, 'zotero-journals-imported');
});

test('general settings abbreviate journals and series on any item type', async () => {
	let { CA } = makeEnvironment();
	await CA.init();
	await CA.importText(journalsList, { format: 'json' });
	CA.setMode('abbreviated');
	let csl = { ...article(), 'collection-title': 'Loeb Classical Library' };
	assert.equal(CA.applyToCSLItem(articleItem, csl), true);
	assert.equal(csl['container-title'], 'CQ');
	assert.equal(csl['collection-title'], 'LCL');
});

test('scope "classic" limits works and authors, not journals', async () => {
	let { CA, Zotero } = makeEnvironment();
	await CA.init();
	await CA.importText(journalsList, { format: 'json' });
	CA.setMode('abbreviated');
	let make = () => ({
		title: 'Iliad', author: [{ family: 'Homer' }], 'container-title': 'The Classical Quarterly'
	});
	let book = make();
	CA.applyToCSLItem(articleItem, book);
	assert.equal(book.title, 'Iliad');
	assert.equal(book['container-title'], 'CQ');

	let classic = make();
	CA.applyToCSLItem(classicItem, classic);
	assert.equal(classic.title, 'Il.');

	Zotero.Prefs.set('classicalAbbreviations.scope', 'all');
	let everything = make();
	CA.applyToCSLItem(articleItem, everything);
	assert.equal(everything.title, 'Il.');
});

test('turning a type off in the general settings stops it being applied', async () => {
	let { CA, Zotero } = makeEnvironment();
	await CA.init();
	await CA.importText(journalsList, { format: 'json' });
	CA.setMode('abbreviated');
	Zotero.Prefs.set('classicalAbbreviations.abbreviateJournals', false);
	let csl = article();
	CA.applyToCSLItem(articleItem, csl);
	assert.equal(csl['container-title'], 'The Classical Quarterly');
});

test('built-in journal table works as a list and obeys list order', async () => {
	let { CA } = makeEnvironment();
	await CA.init();
	await CA.importText(JSON.stringify({
		name: 'Mine', id: 'mine',
		entries: [{ type: 'journal', full: 'Academy of Management Journal', abbreviation: 'AMJ' }]
	}), { format: 'json', activate: false });
	CA.setMode('abbreviated');
	let item = () => ({ 'container-title': 'Academy of Management Journal' });

	CA.setActiveIDs(['zotero-journals']);
	let a = item();
	CA.applyToCSLItem(articleItem, a);
	assert.equal(a['container-title'], 'Acad. Manage. J.');

	CA.setActiveIDs(['mine', 'zotero-journals']);
	let b = item();
	CA.applyToCSLItem(articleItem, b);
	assert.equal(b['container-title'], 'AMJ');

	CA.setActiveIDs(['zotero-journals', 'mine']);
	let c = item();
	CA.applyToCSLItem(articleItem, c);
	assert.equal(c['container-title'], 'Acad. Manage. J.');

	// A title the built-in table doesn't know is left alone (not "abbreviated" to itself)
	CA.setActiveIDs(['zotero-journals']);
	let d = { 'container-title': 'Unknown Gazette' };
	assert.equal(CA.applyToCSLItem(articleItem, d), false);
});

test('profiles: create, update, list, remove', async () => {
	let { CA } = makeEnvironment();
	await CA.init();
	let saved = CA.saveProfile({ name: 'SBL Style', mode: 'abbreviated', active: ['journals'], types: ['journal'] });
	assert.equal(saved.id, 'sbl-style');
	let again = CA.saveProfile({ name: 'SBL Style', mode: 'abbreviated', active: ['journals'], types: ['journal'] });
	assert.equal(again.id, 'sbl-style-2', 'a new profile with the same name gets its own ID');
	CA.saveProfile({ ...saved, mode: 'short-title' });
	let profiles = plain(CA.getProfiles());
	assert.equal(profiles.length, 2);
	assert.equal(profiles.find(p => p.id === 'sbl-style').mode, 'short-title');
	assert.equal(CA.removeProfile('nope'), false);
	assert.equal(CA.removeProfile('sbl-style'), true);
	assert.deepEqual(plain(CA.getProfiles()).map(p => p.id), ['sbl-style-2']);
});

test('resolution: document, then style, then general settings', async () => {
	let { CA } = makeEnvironment();
	await CA.init();
	await CA.importText(journalsList, { format: 'json' });
	await CA.importText(altList, { format: 'json', activate: false });
	CA.setMode('abbreviated');
	CA.setActiveIDs(['journals']);
	CA.saveProfile({ name: 'Alt', mode: 'abbreviated', active: ['alternative'], types: ['journal'] });

	let style = 'http://example.com/style';
	let abbr = (resolveArgs) => {
		let csl = article();
		CA.applyToCSLItem(articleItem, csl, CA.resolve(resolveArgs));
		return csl['container-title'];
	};

	assert.equal(abbr({ styleID: style }), 'CQ');
	CA.setAssignment(style, 'alt');
	assert.equal(abbr({ styleID: style }), 'Class. Q.');
	assert.equal(abbr({ styleID: 'other-style' }), 'CQ');
	assert.equal(abbr({ styleID: style, documentProfileID: 'off' }), 'The Classical Quarterly');
	assert.equal(abbr({ styleID: style, documentProfileID: 'default' }), 'CQ');
	assert.equal(abbr({ styleID: style, documentProfileID: 'alt' }), 'Class. Q.');
	assert.equal(abbr({ styleID: style, documentProfileID: 'gone' }), 'Class. Q.');

	CA.setAssignment(style, null);
	assert.equal(abbr({ styleID: style }), 'CQ');
	assert.equal(CA.resolve({ styleID: style }).source, 'default');
	assert.equal(CA.resolve({ styleID: style, documentProfileID: 'alt' }).source, 'document');
});

test('a profile works even when the general settings are off', async () => {
	let { CA } = makeEnvironment();
	await CA.init();
	await CA.importText(journalsList, { format: 'json' });
	CA.setMode('off');
	CA.saveProfile({ name: 'Journals', mode: 'abbreviated', active: ['journals'], types: ['journal'] });
	let csl = article();
	CA.applyToCSLItem(articleItem, csl, CA.resolve({ documentProfileID: 'journals' }));
	assert.equal(csl['container-title'], 'CQ');
	let none = article();
	assert.equal(CA.applyToCSLItem(articleItem, none, CA.resolve({})), false);
});

test('signatures change when a list is re-imported, a profile edited or an assignment changed', async () => {
	let { CA } = makeEnvironment();
	await CA.init();
	await CA.importText(journalsList, { format: 'json' });
	CA.setMode('abbreviated');
	let s1 = CA.resolve({ styleID: 's' }).signature;
	await CA.importText(journalsList.replace('"CQ"', '"CQ."'), { format: 'json' });
	let s2 = CA.resolve({ styleID: 's' }).signature;
	assert.notEqual(s1, s2);

	let saved = CA.saveProfile({ name: 'P', mode: 'abbreviated', active: ['journals'], types: ['journal'] });
	CA.setAssignment('s', saved.id);
	let s3 = CA.resolve({ styleID: 's' }).signature;
	assert.notEqual(s2, s3);
	CA.saveProfile({ ...saved, types: ['journal', 'series'] });
	assert.notEqual(CA.resolve({ styleID: 's' }).signature, s3);
	assert.equal(CA.getCacheSignature(), CA.resolve().signature);
});

test('removing a list clears it from the general settings, profiles and re-index', async () => {
	let { CA } = makeEnvironment();
	await CA.init();
	await CA.importText(journalsList, { format: 'json' });
	CA.setMode('abbreviated');
	CA.saveProfile({ name: 'P', mode: 'abbreviated', active: ['journals', 'other'], types: ['journal'] });
	assert.equal(await CA.remove('journals'), true);
	assert.deepEqual(plain(CA.getActiveIDs()), []);
	assert.deepEqual(plain(CA.getProfiles())[0].active, ['other']);
	let csl = article();
	assert.equal(CA.applyToCSLItem(articleItem, csl, CA.resolve({ documentProfileID: 'p' })), false);
	assert.equal(await CA.remove('journals'), false);
});

test('corrupt stored profile or assignment preferences do not break anything', async () => {
	let { CA, Zotero } = makeEnvironment();
	await CA.init();
	Zotero.Prefs.set('classicalAbbreviations.profiles', '{garbage');
	Zotero.Prefs.set('classicalAbbreviations.styleProfiles', '[1,2');
	assert.deepEqual(plain(CA.getProfiles()), []);
	assert.deepEqual(plain(CA.getAssignments()), {});
	assert.equal(CA.resolve({ styleID: 'x', documentProfileID: 'whatever' }).source, 'default');
});

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const A = require('../../chrome/content/zotero/xpcom/abbreviationIndex.js');

const EXAMPLES = path.join(__dirname, '..', 'examples');
const sampleJSON = fs.readFileSync(path.join(EXAMPLES, 'classical-abbreviations-sample.json'), 'utf8');
const sampleCSV = fs.readFileSync(path.join(EXAMPLES, 'classical-abbreviations-sample.csv'), 'utf8');

function sampleIndex() {
	return new A.AbbreviationIndex([A.parseJSON(sampleJSON).list]);
}

test('normalizeKey ignores case, accents, punctuation, ligatures and spacing', () => {
	assert.equal(A.normalizeKey('  Æneid. '), 'aeneid');
	assert.equal(A.normalizeKey('AENEID'), 'aeneid');
	assert.equal(A.normalizeKey('Épistulae   ad-Atticum'), 'epistulae ad atticum');
	assert.equal(A.normalizeKey(undefined), '');
});

test('parseJSON accepts the sample file with no warnings', () => {
	let { list, warnings } = A.parseJSON(sampleJSON);
	assert.equal(list.id, 'sample-classical');
	assert.equal(list.entries.length, 7);
	assert.deepEqual(warnings, []);
});

test('parseJSON derives an id from the name and strips a BOM', () => {
	let { list } = A.parseJSON('﻿' + JSON.stringify({ name: 'My Great List!', entries: [] }));
	assert.equal(list.id, 'my-great-list');
});

test('parseJSON rejects bad input with clear errors', () => {
	assert.throws(() => A.parseJSON('{nope'), /Not valid JSON/);
	assert.throws(() => A.parseJSON('[]'), /must be an object/);
	assert.throws(() => A.parseJSON('{"entries":[]}'), /needs a name/);
	assert.throws(() => A.parseJSON('{"name":"x"}'), /entries/);
	assert.throws(() => A.parseJSON('{"name":"x","entries":[],"format":"other"}'), /Unrecognized format/);
	assert.throws(() => A.parseJSON('{"name":"x","entries":[],"version":99}'), /newer/);
});

test('invalid entries are skipped with warnings, valid ones kept', () => {
	let { list, warnings } = A.parseJSON(JSON.stringify({
		name: 'x',
		entries: [
			{ type: 'work', full: 'Iliad', abbreviation: 'Il.' },
			{ type: 'poem', full: 'A', abbreviation: 'B' },
			{ type: 'work', full: 'NoAbbr' },
			'junk'
		]
	}));
	assert.equal(list.entries.length, 1);
	assert.equal(warnings.length, 3);
});

test('duplicate entries: later wins and conflicts are reported', () => {
	let { list, warnings } = A.parseJSON(JSON.stringify({
		name: 'x',
		entries: [
			{ type: 'work', full: 'Iliad', abbreviation: 'Il.' },
			{ type: 'work', full: 'iliad', abbreviation: 'Ilias' },
			{ type: 'work', full: 'Iliad', abbreviation: 'Ilias' }
		]
	}));
	assert.equal(list.entries.length, 1);
	assert.equal(list.entries[0].abbreviation, 'Ilias');
	assert.equal(warnings.length, 1);
});

test('parseCSV matches the JSON sample for the shared entries', () => {
	let { list, warnings } = A.parseCSV(sampleCSV, { name: 'Sample CSV' });
	assert.deepEqual(warnings, []);
	assert.equal(list.entries.length, 5);
	let vergil = list.entries.find(e => e.full === 'Vergil');
	assert.deepEqual(vergil.aliases, ['Virgil', 'Publius Vergilius Maro']);
});

test('parseCSV handles quotes, embedded commas and newlines, CRLF, and TSV', () => {
	let csv = 'type,full,abbreviation,author,aliases\r\n'
		+ 'work,"Letters, Book 1","Ep. 1",Pliny,\r\n'
		+ 'work,"Say ""hi""",SH,,\r\n'
		+ 'work,"Multi\nline",ML,,\r\n';
	let { list } = A.parseCSV(csv, { name: 't' });
	assert.deepEqual(list.entries.map(e => e.full), ['Letters, Book 1', 'Say "hi"', 'Multi\nline']);
	
	let tsv = 'type\tfull\tabbreviation\nauthor\tHomer\tHom.\n';
	assert.equal(A.parseCSV(tsv, { name: 't' }).list.entries[0].abbreviation, 'Hom.');
});

test('parseCSV validates header, name and quoting', () => {
	assert.throws(() => A.parseCSV('type,full\nwork,x', { name: 'n' }), /abbreviation/);
	assert.throws(() => A.parseCSV('type,full,abbreviation\n', {}), /name is required/);
	assert.throws(() => A.parseCSV('', { name: 'n' }), /empty/);
	assert.throws(() => A.parseCSV('type,full,abbreviation\nwork,"oops,x', { name: 'n' }), /Unterminated/);
});

test('CSL-style abbreviation files are converted by category', () => {
	let { list, warnings } = A.parseJSON(JSON.stringify({
		info: { name: 'CSL list', URI: 'http://example.com' },
		default: {
			title: { Iliad: 'Il.' },
			'container-title': { 'Classical Quarterly': 'CQ' },
			'collection-title': { 'Loeb Classical Library': 'LCL' },
			author: { Homer: 'Hom.' },
			place: { London: 'Lond.' },
			publisher: { 'Oxford University Press': 'OUP' },
			'container-title-word': { quarterly: 'Q.', journal: 'J.' },
			nickname: { x: 'y' }
		}
	}));
	assert.equal(list.name, 'CSL list');
	assert.deepEqual(list.entries.map(e => [e.type, e.full]), [
		['work', 'Iliad'],
		['journal', 'Classical Quarterly'],
		['series', 'Loeb Classical Library'],
		['author', 'Homer'],
		['place', 'London'],
		['publisher', 'Oxford University Press']
	]);
	assert.equal(warnings.length, 2);
	assert.match(warnings[0], /2 word-by-word rules/);
	assert.match(warnings[1], /1 abbreviations in unsupported categories/);
});

test('lookupWork matches full names, aliases and normalized spellings', () => {
	let index = sampleIndex();
	assert.equal(index.lookupWork('Iliad').abbreviation, 'Il.');
	assert.equal(index.lookupWork('ILIAS').abbreviation, 'Il.');
	assert.equal(index.lookupWork('Epistulae ad Atticum').abbreviation, 'Att.');
	assert.equal(index.lookupWork('Unknown Work'), null);
});

test('lookupWork uses the author to disambiguate and to block mismatches', () => {
	let index = new A.AbbreviationIndex([{
		entries: [
			{ type: 'work', full: 'Elegies', abbreviation: 'Eleg.', author: 'Propertius', aliases: [] },
			{ type: 'work', full: 'Elegies', abbreviation: 'Tib.', author: 'Tibullus', aliases: [] },
			{ type: 'author', full: 'Propertius', abbreviation: 'Prop.', aliases: ['Sextus Propertius'] }
		]
	}]);
	assert.equal(index.lookupWork('Elegies', ['Tibullus']).abbreviation, 'Tib.');
	assert.equal(index.lookupWork('Elegies', ['Sextus Propertius']).abbreviation, 'Eleg.');
	// Author-specific titles don't match other authors or no author at all
	assert.equal(index.lookupWork('Elegies', ['Ovid']), null);
	assert.equal(index.lookupWork('Elegies'), null);
});

test('author-constrained and unconstrained entries: constrained match wins, unconstrained is fallback', () => {
	let index = new A.AbbreviationIndex([{
		entries: [
			{ type: 'work', full: 'Histories', abbreviation: 'Hist.', author: '', aliases: [] },
			{ type: 'work', full: 'Histories', abbreviation: 'Hdt.', author: 'Herodotus', aliases: [] }
		]
	}]);
	assert.equal(index.lookupWork('Histories', ['Herodotus']).abbreviation, 'Hdt.');
	assert.equal(index.lookupWork('Histories', ['Polybius']).abbreviation, 'Hist.');
});

test('earlier lists take precedence', () => {
	let a = { entries: [{ type: 'work', full: 'Iliad', abbreviation: 'Il.', author: '', aliases: [] }] };
	let b = { entries: [{ type: 'work', full: 'Iliad', abbreviation: 'Ilias', author: '', aliases: [] }] };
	assert.equal(new A.AbbreviationIndex([a, b]).lookupWork('Iliad').abbreviation, 'Il.');
	assert.equal(new A.AbbreviationIndex([b, a]).lookupWork('Iliad').abbreviation, 'Ilias');
});

test('lookupAuthor tries each candidate name', () => {
	let index = sampleIndex();
	assert.equal(index.lookupAuthor(['Marcus Tullius Cicero', 'Cicero']).abbreviation, 'Cic.');
	assert.equal(index.lookupAuthor(['Virgil']).abbreviation, 'Verg.');
	assert.equal(index.lookupAuthor(['Nobody']), null);
});

test('applyToCSL abbreviated mode replaces title and matching authors', () => {
	let item = {
		title: 'Iliad',
		author: [{ family: 'Homer' }, { family: 'Smith', given: 'Jane' }]
	};
	assert.equal(A.applyToCSL(item, sampleIndex(), { mode: 'abbreviated' }), true);
	assert.equal(item.title, 'Il.');
	assert.equal(item['title-short'], 'Il.');
	assert.deepEqual(item.author, [{ literal: 'Hom.' }, { family: 'Smith', given: 'Jane' }]);
});

test('applyToCSL matches given+family and literal author names', () => {
	let index = sampleIndex();
	let a = { title: 'Letters to Atticus', author: [{ given: 'Marcus Tullius', family: 'Cicero' }] };
	A.applyToCSL(a, index, { mode: 'abbreviated' });
	assert.equal(a.title, 'Att.');
	assert.deepEqual(a.author, [{ literal: 'Cic.' }]);
	
	let b = { title: 'Aeneid', author: [{ literal: 'Virgil' }] };
	A.applyToCSL(b, index, { mode: 'abbreviated' });
	assert.equal(b.title, 'Aen.');
	assert.deepEqual(b.author, [{ literal: 'Verg.' }]);
});

test('applyToCSL short-title mode leaves title and authors alone', () => {
	let item = { title: 'Odyssey', author: [{ family: 'Homer' }] };
	assert.equal(A.applyToCSL(item, sampleIndex(), { mode: 'short-title' }), true);
	assert.equal(item.title, 'Odyssey');
	assert.equal(item['title-short'], 'Od.');
	assert.deepEqual(item.author, [{ family: 'Homer' }]);
});

test('applyToCSL honours abbreviateWorks / abbreviateAuthors and off mode', () => {
	let make = () => ({ title: 'Iliad', author: [{ family: 'Homer' }] });
	
	let noAuthors = make();
	A.applyToCSL(noAuthors, sampleIndex(), { mode: 'abbreviated', abbreviateAuthors: false });
	assert.equal(noAuthors.title, 'Il.');
	assert.deepEqual(noAuthors.author, [{ family: 'Homer' }]);
	
	let noWorks = make();
	A.applyToCSL(noWorks, sampleIndex(), { mode: 'abbreviated', abbreviateWorks: false });
	assert.equal(noWorks.title, 'Iliad');
	assert.deepEqual(noWorks.author, [{ literal: 'Hom.' }]);
	
	let off = make();
	assert.equal(A.applyToCSL(off, sampleIndex(), { mode: 'off' }), false);
	assert.deepEqual(off, make());
	
	assert.throws(() => A.applyToCSL(make(), sampleIndex(), { mode: 'bogus' }), /Unknown abbreviation mode/);
});

test('applyToCSL reports no change when nothing matches', () => {
	let item = { title: 'Something Else', author: [{ family: 'Nobody' }] };
	assert.equal(A.applyToCSL(item, sampleIndex(), { mode: 'abbreviated' }), false);
});

const journalList = () => A.validateList({
	name: 'Journals',
	entries: [
		{ type: 'journal', full: 'The Classical Quarterly', abbreviation: 'CQ', aliases: ['Class. Q.'] },
		{ type: 'journal', full: 'Journal of Hellenic Studies', abbreviation: 'JHS' },
		{ type: 'series', full: 'Loeb Classical Library', abbreviation: 'LCL' },
		{ type: 'publisher', full: 'Oxford University Press', abbreviation: 'OUP' },
		{ type: 'place', full: 'Oxford', abbreviation: 'Oxf.' },
		{ type: 'work', full: 'Iliad', abbreviation: 'Il.' }
	]
}).list;

test('new entry types validate; unknown types are reported with the list of valid ones', () => {
	let { warnings } = A.validateList({
		name: 'x',
		entries: [
			{ type: 'journal', full: 'A', abbreviation: 'B' },
			{ type: 'newspaper', full: 'A', abbreviation: 'B' }
		]
	});
	assert.equal(warnings.length, 1);
	assert.match(warnings[0], /journal, series, publisher, place/);
});

test('looseKey ignores leading articles, & / and, accents and punctuation', () => {
	assert.equal(A.looseKey('The Classical Quarterly'), 'classical quarterly');
	assert.equal(A.looseKey('Studies in Ancient & Modern History'), A.looseKey('Studies in Ancient and Modern History'));
	assert.equal(A.looseKey('Revue des Études Anciennes'), 'revue des etudes anciennes');
	// "The" inside a title is left alone
	assert.equal(A.looseKey('Journal of the History of Ideas'), 'journal of the history of ideas');
});

test('lookupSimple finds journals by full title and alias, and does not cross types', () => {
	let index = new A.AbbreviationIndex([journalList()]);
	assert.equal(index.lookupSimple('journal', 'Classical Quarterly').abbreviation, 'CQ');
	assert.equal(index.lookupSimple('journal', 'class. q').abbreviation, 'CQ');
	assert.equal(index.lookupSimple('series', 'Loeb Classical Library').abbreviation, 'LCL');
	assert.equal(index.lookupSimple('journal', 'Loeb Classical Library'), null);
	assert.equal(index.lookupSimple('journal', 'Unknown Journal'), null);
	assert.equal(index.lookupSimple('journal', ''), null);
});

test('applyToCSL: journals, series, publishers and places in abbreviated mode', () => {
	let index = new A.AbbreviationIndex([journalList()]);
	let item = {
		title: 'On Style',
		'container-title': 'The Classical Quarterly',
		'collection-title': 'Loeb Classical Library',
		publisher: 'Oxford University Press',
		'publisher-place': 'Oxford'
	};
	// Publisher and place are off unless asked for
	assert.equal(A.applyToCSL(item, index, { mode: 'abbreviated' }), true);
	assert.equal(item['container-title'], 'CQ');
	assert.equal(item['container-title-short'], 'CQ');
	assert.equal(item['collection-title'], 'LCL');
	assert.equal(item.publisher, 'Oxford University Press');
	assert.equal(item['publisher-place'], 'Oxford');
	
	A.applyToCSL(item, index, { mode: 'abbreviated', types: ['publisher', 'place'] });
	assert.equal(item.publisher, 'OUP');
	assert.equal(item['publisher-place'], 'Oxf.');
});

test('applyToCSL short-title mode sets only short variables and skips publisher/place', () => {
	let index = new A.AbbreviationIndex([journalList()]);
	let item = {
		'container-title': 'Journal of Hellenic Studies',
		publisher: 'Oxford University Press'
	};
	A.applyToCSL(item, index, { mode: 'short-title', types: ['journal', 'publisher'] });
	assert.equal(item['container-title'], 'Journal of Hellenic Studies');
	assert.equal(item['container-title-short'], 'JHS');
	assert.equal(item.publisher, 'Oxford University Press');
});

test('the item\'s own Journal Abbr wins unless preferItemAbbreviations is false', () => {
	let index = new A.AbbreviationIndex([journalList()]);
	let make = () => ({ 'container-title': 'Journal of Hellenic Studies', 'container-title-short': 'J. Hell. Stud.' });
	let a = make();
	A.applyToCSL(a, index, { mode: 'abbreviated' });
	assert.equal(a['container-title'], 'J. Hell. Stud.');
	let b = make();
	A.applyToCSL(b, index, { mode: 'abbreviated', preferItemAbbreviations: false });
	assert.equal(b['container-title'], 'JHS');
	assert.equal(b['container-title-short'], 'JHS');
});

test('Zotero\'s CSL JSON carries Journal Abbr as journalAbbreviation, and that counts as the item\'s own', () => {
	let index = new A.AbbreviationIndex([journalList()]);
	let make = () => ({ 'container-title': 'Journal of Hellenic Studies', journalAbbreviation: 'J. Hell. Stud.' });
	let a = make();
	A.applyToCSL(a, index, { mode: 'abbreviated' });
	assert.equal(a['container-title'], 'J. Hell. Stud.');
	let b = make();
	A.applyToCSL(b, index, { mode: 'abbreviated', preferItemAbbreviations: false });
	assert.equal(b['container-title'], 'JHS');
	assert.equal(b.journalAbbreviation, 'JHS');
});

test('explicit types override the defaults and the legacy flags', () => {
	let index = new A.AbbreviationIndex([journalList()]);
	let item = { title: 'Iliad', 'container-title': 'The Classical Quarterly' };
	A.applyToCSL(item, index, { mode: 'abbreviated', types: ['journal'] });
	assert.equal(item.title, 'Iliad');
	assert.equal(item['container-title'], 'CQ');
	assert.deepEqual([...A.enabledTypes({})].sort(), ['author', 'journal', 'series', 'work']);
	assert.deepEqual([...A.enabledTypes({ abbreviateWorks: false })].sort(), ['author', 'journal', 'series']);
	assert.deepEqual([...A.enabledTypes({ types: ['place', 'bogus'] })], ['place']);
});

test('provider lists answer lookups in list order, so earlier lists win', () => {
	let calls = [];
	let builtin = { entries: [], provider: { journal: (full) => { calls.push(full); return full === 'Nature' ? 'Nat.' : null; } } };
	let mine = A.validateList({ name: 'Mine', entries: [{ type: 'journal', full: 'Nature', abbreviation: 'N' }] }).list;
	
	let providerFirst = new A.AbbreviationIndex([builtin, mine]);
	assert.equal(providerFirst.lookupSimple('journal', 'Nature').abbreviation, 'Nat.');
	let mineFirst = new A.AbbreviationIndex([mine, builtin]);
	assert.equal(mineFirst.lookupSimple('journal', 'Nature').abbreviation, 'N');
	
	// Fall through to later sources when the provider has no answer
	assert.equal(providerFirst.lookupSimple('journal', 'Unknown'), null);
	assert.ok(providerFirst.size > 0);
	assert.equal(new A.AbbreviationIndex([builtin]).size, 1);
});

test('non-string and missing CSL values are ignored', () => {
	let index = new A.AbbreviationIndex([journalList()]);
	let item = { 'container-title': 42, 'collection-title': null };
	assert.equal(A.applyToCSL(item, index, { mode: 'abbreviated' }), false);
});

test('the journals/series sample files parse without warnings and agree with each other', () => {
	let json = A.parseJSON(fs.readFileSync(path.join(EXAMPLES, 'journals-and-series-sample.json'), 'utf8'));
	let csv = A.parseCSV(fs.readFileSync(path.join(EXAMPLES, 'journals-and-series-sample.csv'), 'utf8'), { name: 'x' });
	assert.deepEqual(json.warnings, []);
	assert.deepEqual(csv.warnings, []);
	let index = new A.AbbreviationIndex([json.list]);
	for (let entry of csv.list.entries) {
		assert.equal(index.lookupSimple(entry.type, entry.full).abbreviation, entry.abbreviation, entry.full);
	}
	assert.equal(index.lookupSimple('journal', 'Classical Quarterly').abbreviation, 'CQ');
});

test('two lists with different abbreviations for the same journal: order decides', () => {
	let mk = (name, abbr) => A.validateList({ name, entries: [{ type: 'journal', full: 'Hermes', abbreviation: abbr }] }).list;
	let a = mk('A', 'Herm.');
	let b = mk('B', 'Hermes');
	assert.equal(new A.AbbreviationIndex([a, b]).lookupSimple('journal', 'Hermes').abbreviation, 'Herm.');
	assert.equal(new A.AbbreviationIndex([b, a]).lookupSimple('journal', 'Hermes').abbreviation, 'Hermes');
});

test('lists written under the earlier format name are still accepted', () => {
	let { list } = A.parseJSON(JSON.stringify({ format: 'refmgr-abbreviations', name: 'Old', entries: [] }));
	assert.equal(list.format, 'typos-abbreviations');
	assert.throws(() => A.parseJSON(JSON.stringify({ format: 'something-else', name: 'x', entries: [] })), /Unrecognized format/);
});

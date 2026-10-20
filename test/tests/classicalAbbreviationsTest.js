"use strict";

describe("Zotero.ClassicalAbbreviations", function () {
	var json = JSON.stringify({
		name: 'Test list',
		id: 'test-list',
		entries: [
			{ type: 'author', full: 'Homer', abbreviation: 'Hom.' },
			{ type: 'work', full: 'Iliad', abbreviation: 'Il.', author: 'Homer' }
		]
	});
	
	async function createClassic() {
		let item = new Zotero.Item('classic');
		item.setField('title', 'Iliad');
		item.setCreators([{ creatorType: 'author', lastName: 'Homer', fieldMode: 1 }]);
		await item.saveTx();
		return item;
	}
	
	before(async function () {
		await Zotero.ClassicalAbbreviations.init();
	});
	
	afterEach(async function () {
		for (let list of Zotero.ClassicalAbbreviations.getLists()) {
			await Zotero.ClassicalAbbreviations.remove(list.id);
		}
		for (let pref of [
			'mode', 'active', 'scope', 'abbreviateWorks', 'abbreviateAuthors',
			'abbreviateJournals', 'abbreviateSeries', 'abbreviatePublishers', 'abbreviatePlaces',
			'preferItemAbbreviations', 'profiles', 'styleProfiles'
		]) {
			Zotero.Prefs.clear('classicalAbbreviations.' + pref);
		}
	});
	
	it("should import a JSON list and activate it", async function () {
		let { list, warnings } = await Zotero.ClassicalAbbreviations.importText(json, { format: 'json' });
		assert.equal(list.id, 'test-list');
		assert.lengthOf(warnings, 0);
		assert.deepEqual(Zotero.ClassicalAbbreviations.getActiveIDs(), ['test-list']);
		assert.equal(Zotero.ClassicalAbbreviations.getLists()[0].count, 2);
	});
	
	it("should import CSV text using the supplied name", async function () {
		let csv = 'type,full,abbreviation\nauthor,Homer,Hom.\n';
		let { list } = await Zotero.ClassicalAbbreviations.importText(csv, { format: 'csv', name: 'From CSV' });
		assert.equal(list.id, 'from-csv');
	});
	
	it("should reject a malformed list without changing state", async function () {
		let e = await getPromiseError(
			Zotero.ClassicalAbbreviations.importText('{nope', { format: 'json' })
		);
		assert.equal(e.name, 'AbbreviationFormatError');
		assert.lengthOf(Zotero.ClassicalAbbreviations.getLists(), 0);
	});
	
	it("should keep lists across a restart", async function () {
		await Zotero.ClassicalAbbreviations.importText(json, { format: 'json' });
		Zotero.ClassicalAbbreviations.uninit();
		await Zotero.ClassicalAbbreviations.init();
		assert.lengthOf(Zotero.ClassicalAbbreviations.getLists(), 1);
	});
	
	it("should remove a list and deactivate it", async function () {
		await Zotero.ClassicalAbbreviations.importText(json, { format: 'json' });
		assert.isTrue(await Zotero.ClassicalAbbreviations.remove('test-list'));
		assert.deepEqual(Zotero.ClassicalAbbreviations.getActiveIDs(), []);
	});
	
	describe("in the citation pipeline", function () {
		it("should do nothing while the mode is off", async function () {
			await Zotero.ClassicalAbbreviations.importText(json, { format: 'json' });
			let item = await createClassic();
			let csl = new Zotero.Cite.System({}).retrieveItem(item);
			assert.equal(csl.title, 'Iliad');
		});
		
		it("should abbreviate title and author in 'abbreviated' mode", async function () {
			await Zotero.ClassicalAbbreviations.importText(json, { format: 'json' });
			Zotero.ClassicalAbbreviations.setMode('abbreviated');
			let item = await createClassic();
			let csl = new Zotero.Cite.System({}).retrieveItem(item);
			assert.equal(csl.title, 'Il.');
			assert.deepEqual(csl.author, [{ literal: 'Hom.' }]);
		});
		
		it("should only set title-short in 'short-title' mode", async function () {
			await Zotero.ClassicalAbbreviations.importText(json, { format: 'json' });
			Zotero.ClassicalAbbreviations.setMode('short-title');
			let item = await createClassic();
			let csl = new Zotero.Cite.System({}).retrieveItem(item);
			assert.equal(csl.title, 'Iliad');
			assert.equal(csl['title-short'], 'Il.');
		});
		
		it("should skip non-classic items unless scope is 'all'", async function () {
			await Zotero.ClassicalAbbreviations.importText(json, { format: 'json' });
			Zotero.ClassicalAbbreviations.setMode('abbreviated');
			let book = new Zotero.Item('book');
			book.setField('title', 'Iliad');
			book.setCreators([{ creatorType: 'author', lastName: 'Homer', fieldMode: 1 }]);
			await book.saveTx();
			
			assert.equal(new Zotero.Cite.System({}).retrieveItem(book).title, 'Iliad');
			Zotero.Prefs.set('classicalAbbreviations.scope', 'all');
			assert.equal(new Zotero.Cite.System({}).retrieveItem(book).title, 'Il.');
		});
		
		it("should stop abbreviating when a list is deactivated", async function () {
			await Zotero.ClassicalAbbreviations.importText(json, { format: 'json' });
			Zotero.ClassicalAbbreviations.setMode('abbreviated');
			Zotero.ClassicalAbbreviations.setActiveIDs([]);
			let item = await createClassic();
			assert.equal(new Zotero.Cite.System({}).retrieveItem(item).title, 'Iliad');
		});
	});
	
	describe("journals, series and profiles", function () {
		var journals = JSON.stringify({
			name: 'Journals',
			id: 'journals',
			entries: [
				{ type: 'journal', full: 'The Classical Quarterly', abbreviation: 'CQ' },
				{ type: 'series', full: 'Loeb Classical Library', abbreviation: 'LCL' }
			]
		});
		var alt = JSON.stringify({
			name: 'Alternative',
			id: 'alternative',
			entries: [{ type: 'journal', full: 'The Classical Quarterly', abbreviation: 'Class. Q.' }]
		});
		
		async function createArticle() {
			let item = new Zotero.Item('journalArticle');
			item.setField('title', 'A Study');
			item.setField('publicationTitle', 'The Classical Quarterly');
			await item.saveTx();
			return item;
		}
		
		async function createBook() {
			let item = new Zotero.Item('book');
			item.setField('title', 'Homer: Iliad');
			item.setField('series', 'Loeb Classical Library');
			await item.saveTx();
			return item;
		}
		
		function csl(item, resolved) {
			let out = Zotero.Utilities.Item.itemToCSLJSON(item);
			Zotero.ClassicalAbbreviations.applyToCSLItem(item, out, resolved);
			return out;
		}
		
		it("should abbreviate journals and series on any item type, whatever the scope", async function () {
			await Zotero.ClassicalAbbreviations.importText(journals, { format: 'json' });
			Zotero.ClassicalAbbreviations.setMode('abbreviated');
			let article = csl(await createArticle());
			assert.equal(article['container-title'], 'CQ');
			let book = csl(await createBook());
			assert.equal(book['collection-title'], 'LCL');
		});
		
		it("should use an item's own Journal Abbr over a list unless told not to", async function () {
			await Zotero.ClassicalAbbreviations.importText(journals, { format: 'json' });
			Zotero.ClassicalAbbreviations.setMode('abbreviated');
			let article = await createArticle();
			article.setField('journalAbbreviation', 'Class. Quart.');
			await article.saveTx();
			assert.equal(csl(article)['container-title'], 'Class. Quart.');
			Zotero.Prefs.set('classicalAbbreviations.preferItemAbbreviations', false);
			assert.equal(csl(article)['container-title'], 'CQ');
		});
		
		it("should offer the built-in journal table as a selectable list", async function () {
			let builtin = Zotero.ClassicalAbbreviations.getAvailableLists()
				.find(l => l.id === Zotero.ClassicalAbbreviations.BUILTIN_JOURNALS_ID);
			assert.ok(builtin);
			assert.isTrue(builtin.builtin);
			Zotero.ClassicalAbbreviations.setMode('abbreviated');
			Zotero.ClassicalAbbreviations.setActiveIDs([builtin.id]);
			let item = new Zotero.Item('journalArticle');
			item.setField('publicationTitle', 'Academy of Management Journal');
			await item.saveTx();
			assert.equal(csl(item)['container-title'], 'Acad. Manage. J.');
		});
		
		it("should create, update and remove profiles", async function () {
			let saved = Zotero.ClassicalAbbreviations.saveProfile({
				name: 'My Profile', mode: 'abbreviated', active: ['journals'], types: ['journal']
			});
			assert.equal(saved.id, 'my-profile');
			Zotero.ClassicalAbbreviations.saveProfile({ ...saved, mode: 'short-title' });
			let profiles = Zotero.ClassicalAbbreviations.getProfiles();
			assert.lengthOf(profiles, 1);
			assert.equal(profiles[0].mode, 'short-title');
			
			Zotero.ClassicalAbbreviations.setAssignment('http://example.com/style', 'my-profile');
			assert.isTrue(Zotero.ClassicalAbbreviations.removeProfile('my-profile'));
			assert.isEmpty(Zotero.ClassicalAbbreviations.getProfiles());
			assert.isEmpty(Zotero.ClassicalAbbreviations.getAssignments());
		});
		
		it("should resolve document, then style, then general settings", async function () {
			await Zotero.ClassicalAbbreviations.importText(journals, { format: 'json' });
			await Zotero.ClassicalAbbreviations.importText(alt, { format: 'json', activate: false });
			Zotero.ClassicalAbbreviations.setMode('abbreviated');
			Zotero.ClassicalAbbreviations.setActiveIDs(['journals']);
			Zotero.ClassicalAbbreviations.saveProfile({
				name: 'Alt', mode: 'abbreviated', active: ['alternative'], types: ['journal']
			});
			let styleID = 'http://example.com/some-style';
			let article = await createArticle();
			
			// General settings
			assert.equal(csl(article, Zotero.ClassicalAbbreviations.resolve({ styleID }))['container-title'], 'CQ');
			
			// Style assignment
			Zotero.ClassicalAbbreviations.setAssignment(styleID, 'alt');
			assert.equal(csl(article, Zotero.ClassicalAbbreviations.resolve({ styleID }))['container-title'], 'Class. Q.');
			assert.equal(csl(article, Zotero.ClassicalAbbreviations.resolve({ styleID: 'other' }))['container-title'], 'CQ');
			
			// The document's choice wins over the style's
			let off = Zotero.ClassicalAbbreviations.resolve({ styleID, documentProfileID: 'off' });
			assert.equal(csl(article, off)['container-title'], 'The Classical Quarterly');
			let general = Zotero.ClassicalAbbreviations.resolve({ styleID, documentProfileID: 'default' });
			assert.equal(csl(article, general)['container-title'], 'CQ');
			
			// A document naming a profile that doesn't exist falls through to the style
			let missing = Zotero.ClassicalAbbreviations.resolve({ styleID, documentProfileID: 'gone' });
			assert.equal(csl(article, missing)['container-title'], 'Class. Q.');
		});
		
		it("should apply the chosen profile in citations made with a style", async function () {
			await Zotero.ClassicalAbbreviations.importText(journals, { format: 'json' });
			Zotero.ClassicalAbbreviations.setMode('off');
			Zotero.ClassicalAbbreviations.saveProfile({
				name: 'Journals', mode: 'abbreviated', active: ['journals'], types: ['journal']
			});
			let article = await createArticle();
			let style = Zotero.Styles.get('http://www.zotero.org/styles/chicago-note-bibliography');
			
			let withProfile = style.getCiteProc('en-US', 'text', { abbreviationProfile: 'journals' });
			let plain = style.getCiteProc('en-US', 'text');
			let bib = engine => Zotero.Cite.makeFormattedBibliographyOrCitationList(engine, [article], 'text');
			assert.include(bib(withProfile), 'CQ');
			assert.notInclude(bib(plain), 'CQ');
		});
		
		it("should not reuse a cached engine after the profile's lists change", async function () {
			await Zotero.ClassicalAbbreviations.importText(journals, { format: 'json' });
			Zotero.ClassicalAbbreviations.setMode('abbreviated');
			let style = Zotero.Styles.get('http://www.zotero.org/styles/chicago-note-bibliography');
			let a = style.getCiteProc('en-US', 'text', { cache: true });
			Zotero.ClassicalAbbreviations.setActiveIDs([]);
			let b = style.getCiteProc('en-US', 'text', { cache: true });
			assert.notStrictEqual(a, b);
		});
		
		it("should remove a deleted list from profiles", async function () {
			await Zotero.ClassicalAbbreviations.importText(journals, { format: 'json' });
			Zotero.ClassicalAbbreviations.saveProfile({
				name: 'P', mode: 'abbreviated', active: ['journals'], types: ['journal']
			});
			await Zotero.ClassicalAbbreviations.remove('journals');
			assert.deepEqual(Zotero.ClassicalAbbreviations.getProfiles()[0].active, []);
		});
	});
});

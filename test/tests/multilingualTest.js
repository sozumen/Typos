"use strict";

describe("Zotero.Multilingual", function () {
	var libraryID;
	
	before(async function () {
		libraryID = Zotero.Libraries.userLibraryID;
		await Zotero.Multilingual.waitReady();
	});
	
	afterEach(function () {
		Zotero.Multilingual.setSettings(null);
	});
	
	async function createBook(title, creators = [{ creatorType: 'author', lastName: 'Ono', firstName: 'Yoko' }]) {
		let item = new Zotero.Item('book');
		item.libraryID = libraryID;
		item.setField('title', title);
		item.setCreators(creators);
		await item.saveTx();
		return item;
	}
	
	function retrieve(item) {
		return new Zotero.Cite.System({}).retrieveItem(item);
	}
	
	function csl(item) {
		return Zotero.Utilities.Item.itemToCSLJSON(item);
	}
	
	describe("setup", function () {
		it("should create the tables and the default languages", async function () {
			assert.isTrue(Zotero.Multilingual.isReady());
			for (let table of ['zlsTags', 'itemDataMain', 'itemDataAlt', 'itemCreatorsMain', 'itemCreatorsAlt']) {
				assert.isTrue(await Zotero.DB.tableExists(table), table);
			}
			let tags = Zotero.Multilingual.getLanguageTags().map(t => t.tag);
			assert.include(tags, 'grc');
			assert.include(tags, 'de');
		});
	});
	
	describe("languages", function () {
		it("should add a language", async function () {
			let tag = await Zotero.Multilingual.addLanguageTag('  ja-Latn ');
			assert.equal(tag, 'ja-Latn');
			assert.include(Zotero.Multilingual.getLanguageTags().map(t => t.tag), 'ja-Latn');
		});
		
		it("should reject something that isn't a language tag", async function () {
			let item = await createBook('Tag test');
			let e = await getPromiseError(Zotero.Multilingual.setFieldLanguage(item, 'title', 'not a tag!'));
			assert.ok(e);
		});
	});
	
	describe("field languages and variants", function () {
		it("should store a field's language and its variants", async function () {
			let item = await createBook('Der Pädagoge');
			await Zotero.Multilingual.setFieldLanguage(item, 'title', 'de');
			await Zotero.Multilingual.setVariant(item, 'title', 'en', 'The Instructor');
			await Zotero.Multilingual.setVariant(item, 'title', 'grc', 'Παιδαγωγός');
			assert.equal(Zotero.Multilingual.getFieldLanguage(item, 'title'), 'de');
			assert.deepEqual(Zotero.Multilingual.getVariants(item, 'title'), {
				en: 'The Instructor', grc: 'Παιδαγωγός'
			});
		});
		
		it("should survive a reload from the database", async function () {
			let item = await createBook('Reload');
			await Zotero.Multilingual.setFieldLanguage(item, 'title', 'fr');
			await Zotero.Multilingual.setVariant(item, 'title', 'en', 'Reloaded');
			await Zotero.Multilingual._loadAll();
			assert.equal(Zotero.Multilingual.getFieldLanguage(item, 'title'), 'fr');
			assert.equal(Zotero.Multilingual.getVariants(item, 'title').en, 'Reloaded');
		});
		
		it("should clear a language and remove a variant", async function () {
			let item = await createBook('Clearing');
			await Zotero.Multilingual.setFieldLanguage(item, 'title', 'fr');
			await Zotero.Multilingual.setVariant(item, 'title', 'en', 'Cleared');
			await Zotero.Multilingual.setFieldLanguage(item, 'title', null);
			await Zotero.Multilingual.setVariant(item, 'title', 'en', '');
			assert.isNull(Zotero.Multilingual.getFieldLanguage(item, 'title'));
			assert.deepEqual(Zotero.Multilingual.getVariants(item, 'title'), {});
			assert.isFalse(Zotero.Multilingual.hasData(item));
		});
		
		it("should refuse fields that can't have languages", async function () {
			let item = await createBook('Refusing');
			assert.isFalse(Zotero.Multilingual.isSupportedField(item, 'date'));
			assert.isFalse(Zotero.Multilingual.isSupportedField(item, 'extra'));
			assert.isFalse(Zotero.Multilingual.isSupportedField(item, 'volume'));
			assert.isFalse(Zotero.Multilingual.isSupportedField(item, 'publicationTitle'));
			assert.isTrue(Zotero.Multilingual.isSupportedField(item, 'title'));
			assert.isTrue(Zotero.Multilingual.isSupportedField(item, 'publisher'));
			let e = await getPromiseError(Zotero.Multilingual.setVariant(item, 'date', 'en', '1999'));
			assert.ok(e);
		});
		
		it("should mark the item modified", async function () {
			let item = await createBook('Modified');
			let before = await Zotero.DB.valueQueryAsync(
				"SELECT clientDateModified FROM items WHERE itemID=?", [item.id]
			);
			await Zotero.Promise.delay(1100);
			await Zotero.Multilingual.setVariant(item, 'title', 'en', 'Changed');
			let after = await Zotero.DB.valueQueryAsync(
				"SELECT clientDateModified FROM items WHERE itemID=?", [item.id]
			);
			assert.notEqual(after, before);
		});
		
		it("should forget an item's data when it's erased", async function () {
			let item = await createBook('Erasing');
			let id = item.id;
			await Zotero.Multilingual.setVariant(item, 'title', 'en', 'Erased');
			await item.eraseTx();
			assert.equal(
				await Zotero.DB.valueQueryAsync("SELECT COUNT(*) FROM itemDataAlt WHERE itemID=?", [id]),
				0
			);
			assert.isFalse(Zotero.Multilingual.hasData({ id }));
		});
	});
	
	describe("creators", function () {
		it("should store a creator's language and variants", async function () {
			let item = await createBook('Creators');
			await Zotero.Multilingual.setCreatorLanguage(item, 0, 'en');
			await Zotero.Multilingual.setCreatorVariant(item, 0, 'ja', { lastName: '小野', firstName: 'ヨーコ' });
			assert.equal(Zotero.Multilingual.getCreatorLanguage(item, 0), 'en');
			let variants = Zotero.Multilingual.getCreatorVariants(item, 0);
			assert.equal(variants.ja.lastName, '小野');
			assert.equal(variants.ja.firstName, 'ヨーコ');
			await Zotero.Multilingual._loadAll();
			assert.equal(Zotero.Multilingual.getCreatorVariants(item, 0).ja.lastName, '小野');
		});
		
		it("should keep variants with their creator when creators are reordered", async function () {
			let item = await createBook('Reorder', [
				{ creatorType: 'author', lastName: 'First', firstName: 'A' },
				{ creatorType: 'author', lastName: 'Second', firstName: 'B' }
			]);
			await Zotero.Multilingual.setCreatorVariant(item, 0, 'ja', { lastName: 'Ichi', firstName: '' , fieldMode: 1 });
			await Zotero.Multilingual.setCreatorLanguage(item, 1, 'fr');
			await Zotero.Multilingual.remapCreators(item, i => 1 - i);
			assert.equal(Zotero.Multilingual.getCreatorLanguage(item, 0), 'fr');
			assert.equal(Zotero.Multilingual.getCreatorVariants(item, 1).ja.lastName, 'Ichi');
			await Zotero.Multilingual._loadAll();
			assert.equal(Zotero.Multilingual.getCreatorLanguage(item, 0), 'fr');
			assert.equal(Zotero.Multilingual.getCreatorVariants(item, 1).ja.lastName, 'Ichi');
		});
		
		it("should drop a removed creator's data", async function () {
			let item = await createBook('Removing', [
				{ creatorType: 'author', lastName: 'First', firstName: 'A' },
				{ creatorType: 'author', lastName: 'Second', firstName: 'B' }
			]);
			await Zotero.Multilingual.setCreatorLanguage(item, 0, 'fr');
			await Zotero.Multilingual.setCreatorLanguage(item, 1, 'de');
			await Zotero.Multilingual.remapCreators(item, i => i === 0 ? null : i - 1);
			assert.equal(Zotero.Multilingual.getCreatorLanguage(item, 0), 'de');
			assert.isNull(Zotero.Multilingual.getCreatorLanguage(item, 1));
		});
	});
	
	describe("purging unused data", function () {
		it("should keep values and creators that only variants use", async function () {
			let item = await createBook('Purging');
			await Zotero.Multilingual.setVariant(item, 'title', 'en', 'Only A Variant Uses This');
			await Zotero.Multilingual.setCreatorVariant(item, 0, 'ja', { lastName: 'Henkō', firstName: 'Taro' });
			Zotero.Prefs.set('purge.items', true);
			Zotero.Prefs.set('purge.creators', true);
			await Zotero.Creators.purge();
			await Zotero.Items.purge();
			await Zotero.Multilingual._loadAll();
			assert.equal(
				Zotero.Multilingual.getVariants(item, 'title').en, 'Only A Variant Uses This'
			);
			assert.equal(Zotero.Multilingual.getCreatorVariants(item, 0).ja.lastName, 'Henkō');
		});
	});
	
	describe("citations", function () {
		it("should leave citations alone by default", async function () {
			let item = await createBook('Original title');
			await Zotero.Multilingual.setVariant(item, 'title', 'en', 'Variant title');
			assert.equal(csl(item).title, 'Original title');
			let cslItem = retrieve(item);
			assert.equal(cslItem.title, 'Original title');
		});
		
		it("should use a variant of the title when asked", async function () {
			let item = await createBook('Der Pädagoge');
			await Zotero.Multilingual.setVariant(item, 'title', 'en', 'The Instructor');
			let settings = Zotero.Multilingual.getSettings();
			Zotero.Multilingual.setSettings({
				...settings, titles: { mode: 'variant', languages: ['en'] }
			});
			let cslItem = retrieve(item);
			assert.equal(cslItem.title, 'The Instructor');
		});
		
		it("should show both when asked", async function () {
			let item = await createBook('Der Pädagoge');
			await Zotero.Multilingual.setVariant(item, 'title', 'en', 'The Instructor');
			let settings = Zotero.Multilingual.getSettings();
			Zotero.Multilingual.setSettings({
				...settings, titles: { mode: 'both', languages: ['en'] }
			});
			let cslItem = retrieve(item);
			assert.equal(cslItem.title, 'Der Pädagoge [The Instructor]');
		});
		
		it("should use a variant of a creator's name", async function () {
			let item = await createBook('Names');
			await Zotero.Multilingual.setCreatorVariant(item, 0, 'ja', { lastName: '小野', firstName: 'ヨーコ' });
			let settings = Zotero.Multilingual.getSettings();
			Zotero.Multilingual.setSettings({
				...settings, creators: { mode: 'variant', languages: ['ja'] }
			});
			let cslItem = retrieve(item);
			assert.equal(cslItem.author[0].family, '小野');
			assert.equal(cslItem.author[0].given, 'ヨーコ');
		});
		
		it("should fall back to the original when there's no variant in the chosen languages", async function () {
			let item = await createBook('Fallback');
			await Zotero.Multilingual.setVariant(item, 'title', 'fr', 'Repli');
			let settings = Zotero.Multilingual.getSettings();
			Zotero.Multilingual.setSettings({
				...settings, titles: { mode: 'variant', languages: ['en'] }
			});
			let cslItem = retrieve(item);
			assert.equal(cslItem.title, 'Fallback');
		});
	});
});

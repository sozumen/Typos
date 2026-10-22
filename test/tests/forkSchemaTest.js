"use strict";

// Item types and fields that Typos adds to Zotero's schema (fork/schema/overlay.json)
describe("Typos schema additions", function () {
	const VOLUME_TITLE_TYPES = [
		'book', 'bookSection', 'classic', 'encyclopediaArticle', 'dictionaryEntry', 'conferencePaper'
	];
	
	describe("Multi-Volume Work", function () {
		it("should be registered with a localized name", function () {
			assert.ok(Zotero.ItemTypes.getID('multiVolumeWork'));
			assert.equal(Zotero.ItemTypes.getLocalizedString('multiVolumeWork'), 'Multi-Volume Work');
		});
		
		it("should have the fields of a set of volumes, and no volume or pages", function () {
			let typeID = Zotero.ItemTypes.getID('multiVolumeWork');
			for (let field of ['title', 'numberOfVolumes', 'series', 'publisher', 'place', 'date', 'ISBN']) {
				assert.isTrue(Zotero.ItemFields.isValidForType(Zotero.ItemFields.getID(field), typeID), field);
			}
			for (let field of ['volume', 'volumeTitle', 'pages']) {
				assert.isFalse(Zotero.ItemFields.isValidForType(Zotero.ItemFields.getID(field), typeID), field);
			}
			assert.equal(
				Zotero.CreatorTypes.getName(Zotero.CreatorTypes.getPrimaryIDForType(typeID)),
				'author'
			);
		});
		
		it("should save, reload and cite as a book", async function () {
			let item = new Zotero.Item('multiVolumeWork');
			item.setField('title', 'Die griechischen christlichen Schriftsteller');
			item.setField('numberOfVolumes', '3');
			item.setCreators([{ creatorType: 'editor', lastName: 'Holl', firstName: 'Karl' }]);
			await item.saveTx();
			let reloaded = await Zotero.Items.getAsync(item.id);
			assert.equal(reloaded.itemType, 'multiVolumeWork');
			assert.equal(reloaded.getField('numberOfVolumes'), '3');
			let csl = Zotero.Utilities.Item.itemToCSLJSON(reloaded);
			assert.equal(csl.type, 'book');
			assert.equal(csl['number-of-volumes'], '3');
			assert.equal(csl.editor[0].family, 'Holl');
		});
	});
	
	describe("Volume Title", function () {
		it("should be a field of books, book sections and similar types", function () {
			let fieldID = Zotero.ItemFields.getID('volumeTitle');
			assert.ok(fieldID);
			assert.equal(Zotero.ItemFields.getLocalizedString('volumeTitle'), 'Volume Title');
			for (let type of VOLUME_TITLE_TYPES) {
				assert.isTrue(Zotero.ItemFields.isValidForType(fieldID, Zotero.ItemTypes.getID(type)), type);
			}
			assert.isFalse(Zotero.ItemFields.isValidForType(fieldID, Zotero.ItemTypes.getID('journalArticle')));
		});
		
		it("should come right after Volume", function () {
			for (let type of ['book', 'bookSection']) {
				let fields = Zotero.ItemFields.getItemTypeFields(Zotero.ItemTypes.getID(type))
					.map(id => Zotero.ItemFields.getName(id));
				assert.equal(fields[fields.indexOf('volume') + 1], 'volumeTitle', type);
			}
		});
		
		it("should be CSL's volume-title, both ways", async function () {
			let item = new Zotero.Item('bookSection');
			item.setField('title', 'Ancoratus');
			item.setField('bookTitle', 'Epiphanius');
			item.setField('volume', '1');
			item.setField('volumeTitle', 'Ancoratus und Panarion haer. 1-33');
			await item.saveTx();
			let csl = Zotero.Utilities.Item.itemToCSLJSON(item);
			assert.equal(csl['container-title'], 'Epiphanius');
			assert.equal(csl['volume-title'], 'Ancoratus und Panarion haer. 1-33');
			
			let back = new Zotero.Item('book');
			Zotero.Utilities.Item.itemFromCSLJSON(back, csl);
			assert.equal(back.itemType, 'bookSection');
			assert.equal(back.getField('volumeTitle'), 'Ancoratus und Panarion haer. 1-33');
		});
		
		it("should be filled from a Volume Title line in Extra", async function () {
			let item = new Zotero.Item('book');
			item.fromJSON({ itemType: 'book', title: 'Opera', extra: 'Volume Title: Opera catholica\nkeep: me' });
			assert.equal(item.getField('volumeTitle'), 'Opera catholica');
			assert.equal(item.getField('extra'), 'keep: me');
		});
		
		it("should be able to have languages and variants", function () {
			let item = new Zotero.Item('book');
			assert.isTrue(Zotero.Multilingual.isSupportedField(item, 'volumeTitle'));
		});
	});
});

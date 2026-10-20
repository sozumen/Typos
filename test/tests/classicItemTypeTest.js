describe("Classic Work item type", function () {
	it("should be registered with its custom fields", function () {
		let itemTypeID = Zotero.ItemTypes.getID('classic');
		assert.ok(itemTypeID);
		for (let field of ['referenceSystem', 'corpusId', 'compositionDate', 'originalLanguage']) {
			assert.isTrue(
				Zotero.ItemFields.isValidForType(Zotero.ItemFields.getID(field), itemTypeID),
				`${field} should be valid for classic`
			);
		}
	});

	it("should have a localized name", function () {
		assert.equal(Zotero.ItemTypes.getLocalizedString('classic'), 'Classic Work');
	});

	it("should appear among the primary item types", function () {
		assert.include(Zotero.ItemTypes.getPrimaryTypes().map(x => x.name), 'classic');
	});

	it("should save and reload field values", async function () {
		let item = new Zotero.Item('classic');
		item.setField('title', 'Nicomachean Ethics');
		item.setField('referenceSystem', 'Bekker');
		item.setField('corpusId', 'TLG 0086.010');
		item.setField('compositionDate', 'c. 340 BCE');
		item.setCreators([{ creatorType: 'author', lastName: 'Aristotle', fieldMode: 1 }]);
		await item.saveTx();

		let reloaded = await Zotero.Items.getAsync(item.id);
		assert.equal(reloaded.itemType, 'classic');
		assert.equal(reloaded.getField('referenceSystem'), 'Bekker');
		assert.equal(reloaded.getField('corpusId'), 'TLG 0086.010');
		assert.equal(reloaded.getField('compositionDate'), 'c. 340 BCE');
		assert.equal(reloaded.getCreators()[0].lastName, 'Aristotle');
	});

	it("should export to CSL as a book", async function () {
		let item = new Zotero.Item('classic');
		item.setField('title', 'Iliad');
		item.setCreators([{ creatorType: 'author', lastName: 'Homer', fieldMode: 1 }]);
		await item.saveTx();

		let json = Zotero.Utilities.Item.itemToCSLJSON(item);
		assert.equal(json.type, 'book');
		assert.equal(json.title, 'Iliad');
	});
});

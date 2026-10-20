"use strict";

describe("Zotero.JurismImport", function () {
	describe("#importJSON()", function () {
		it("should import a classic item unchanged", async function () {
			let key = Zotero.DataObjectUtilities.generateKey();
			let report = await Zotero.JurismImport.importJSON(JSON.stringify([{
				key,
				itemType: 'classic',
				title: 'Iliad',
				creators: [{ creatorType: 'author', name: 'Homer' }],
				tags: [{ tag: 'epic' }]
			}]));
			assert.equal(report.counts.items, 1);
			assert.lengthOf(report.failed, 0);
			
			let item = Zotero.Items.getByLibraryAndKey(Zotero.Libraries.userLibraryID, key);
			assert.equal(item.itemType, 'classic');
			assert.equal(item.getField('title'), 'Iliad');
			assert.equal(item.getCreators()[0].lastName, 'Homer');
			assert.sameMembers(item.getTags().map(t => t.tag), ['epic']);
		});
		
		it("should map a Juris-M-only type and keep its extra data", async function () {
			let key = Zotero.DataObjectUtilities.generateKey();
			let report = await Zotero.JurismImport.importJSON(JSON.stringify({
				items: [{ key, itemType: 'regulation', nameOfAct: 'Water Rules', jurisdiction: 'us:c9' }]
			}));
			assert.deepEqual(report.typeChanges, { regulation: 1 });
			
			let item = Zotero.Items.getByLibraryAndKey(Zotero.Libraries.userLibraryID, key);
			assert.equal(item.itemType, 'statute');
			assert.include(item.getField('extra'), 'Jurisdiction: us:c9');
		});
		
		it("should skip items whose key already exists", async function () {
			let key = Zotero.DataObjectUtilities.generateKey();
			let json = JSON.stringify([{ key, itemType: 'book', title: 'Once' }]);
			await Zotero.JurismImport.importJSON(json);
			let report = await Zotero.JurismImport.importJSON(json);
			assert.equal(report.counts.items, 0);
			assert.equal(report.counts.skippedExisting, 1);
		});
		
		it("should import notes under their parent", async function () {
			let parentKey = Zotero.DataObjectUtilities.generateKey();
			let noteKey = Zotero.DataObjectUtilities.generateKey();
			// The note is listed first to check that parents are saved before children
			await Zotero.JurismImport.importJSON(JSON.stringify([
				{ key: noteKey, itemType: 'note', note: '<p>hi</p>', parentItem: parentKey },
				{ key: parentKey, itemType: 'book', title: 'Parent' }
			]));
			let note = Zotero.Items.getByLibraryAndKey(Zotero.Libraries.userLibraryID, noteKey);
			assert.equal(note.parentItem.key, parentKey);
		});
		
		it("should reject input that isn't an item list", async function () {
			let e = await getPromiseError(Zotero.JurismImport.importJSON('{"foo": 1}'));
			assert.include(e.message, "Expected an array");
			e = await getPromiseError(Zotero.JurismImport.importJSON('not json'));
			assert.include(e.message, "Not valid JSON");
		});
	});
	
	describe("#inspect()", function () {
		it("should reject a missing file", async function () {
			let e = await getPromiseError(Zotero.JurismImport.inspect('/nonexistent/zotero.sqlite'));
			assert.include(e.message, "not found");
		});
	});
});

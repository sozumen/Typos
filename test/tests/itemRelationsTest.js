"use strict";

describe("Zotero.ItemRelations", function () {
	var book, chapter, classic, edition;
	
	beforeEach(async function () {
		book = await createDataObject('item', { itemType: 'book' });
		chapter = await createDataObject('item', { itemType: 'bookSection' });
		classic = await createDataObject('item', { itemType: 'classic' });
		edition = await createDataObject('item', { itemType: 'book' });
	});
	
	describe("#add()", function () {
		it("should store a directed relation on the subject only", async function () {
			await Zotero.ItemRelations.add(chapter, 'partOf', book);
			assert.isTrue(chapter.hasRelation('rm:partOf', Zotero.URI.getItemURI(book)));
			assert.lengthOf(book.getRelationsByPredicate('rm:partOf'), 0);
		});
		
		it("should persist across reloads", async function () {
			await Zotero.ItemRelations.add(edition, 'criticalEditionOf', classic);
			let reloaded = await Zotero.Items.getAsync(edition.id);
			await reloaded.reload(['relations'], true);
			assert.lengthOf(reloaded.getRelationsByPredicate('rm:criticalEditionOf'), 1);
		});
		
		it("should reject a relation to the same item", async function () {
			let e = await getPromiseError(Zotero.ItemRelations.add(book, 'partOf', book));
			assert.equal(e.code, 'self');
		});
		
		it("should reject a duplicate relation", async function () {
			await Zotero.ItemRelations.add(chapter, 'partOf', book);
			let e = await getPromiseError(Zotero.ItemRelations.add(chapter, 'partOf', book));
			assert.equal(e.code, 'exists');
		});
		
		it("should reject a relation that would create a cycle", async function () {
			await Zotero.ItemRelations.add(chapter, 'partOf', book);
			let e = await getPromiseError(Zotero.ItemRelations.add(book, 'partOf', chapter));
			assert.equal(e.code, 'cycle');
		});
		
		it("should reject an indirect cycle", async function () {
			let a = await createDataObject('item', { itemType: 'book' });
			let b = await createDataObject('item', { itemType: 'book' });
			let c = await createDataObject('item', { itemType: 'book' });
			await Zotero.ItemRelations.add(a, 'partOf', b);
			await Zotero.ItemRelations.add(b, 'partOf', c);
			let e = await getPromiseError(Zotero.ItemRelations.add(c, 'partOf', a));
			assert.equal(e.code, 'cycle');
		});
		
		it("should allow the same pair to be related by different types", async function () {
			await Zotero.ItemRelations.add(edition, 'criticalEditionOf', classic);
			await Zotero.ItemRelations.add(edition, 'translationOf', classic);
			assert.lengthOf((await Zotero.ItemRelations.getOutgoing(edition)), 2);
		});
		
		it("should reject items in different libraries", async function () {
			let group = await createGroup();
			let other = await createDataObject('item', { libraryID: group.libraryID });
			let e = await getPromiseError(Zotero.ItemRelations.add(book, 'partOf', other));
			assert.equal(e.code, 'different-library');
		});
		
		it("should reject notes", async function () {
			let note = await createDataObject('item', { itemType: 'note' });
			let e = await getPromiseError(Zotero.ItemRelations.add(note, 'partOf', book));
			assert.equal(e.code, 'not-regular');
		});
		
		it("should reject an unknown type", async function () {
			let e = await getPromiseError(Zotero.ItemRelations.add(chapter, 'bogus', book));
			assert.include(e.message, 'Unknown relation type');
		});
	});
	
	describe("#getOutgoing() and #getIncoming()", function () {
		it("should report both directions", async function () {
			await Zotero.ItemRelations.add(edition, 'criticalEditionOf', classic);
			
			let outgoing = await Zotero.ItemRelations.getOutgoing(edition);
			assert.equal(outgoing[0].typeKey, 'criticalEditionOf');
			assert.equal(outgoing[0].items[0].id, classic.id);
			
			let incoming = await Zotero.ItemRelations.getIncoming(classic);
			assert.equal(incoming[0].typeKey, 'criticalEditionOf');
			assert.equal(incoming[0].items[0].id, edition.id);
		});
		
		it("should ignore items in the trash", async function () {
			await Zotero.ItemRelations.add(edition, 'criticalEditionOf', classic);
			edition.deleted = true;
			await edition.saveTx();
			assert.lengthOf(await Zotero.ItemRelations.getIncoming(classic), 0);
		});
	});
	
	describe("hierarchy", function () {
		it("should return ancestors and descendants", async function () {
			let series = await createDataObject('item', { itemType: 'book' });
			await Zotero.ItemRelations.add(chapter, 'partOf', book);
			await Zotero.ItemRelations.add(book, 'partOf', series);
			
			let ancestors = await Zotero.ItemRelations.getAncestors(chapter, 'partOf');
			assert.deepEqual(ancestors.map(x => x.item.id), [book.id, series.id]);
			assert.deepEqual(ancestors.map(x => x.depth), [1, 2]);
			
			let descendants = await Zotero.ItemRelations.getDescendants(series, 'partOf');
			assert.deepEqual(descendants.map(x => x.item.id), [book.id, chapter.id]);
		});
		
		it("should build a descendant tree", async function () {
			await Zotero.ItemRelations.add(chapter, 'partOf', book);
			let tree = await Zotero.ItemRelations.getDescendantTree(book, 'partOf');
			assert.equal(tree.item.id, book.id);
			assert.equal(tree.children[0].item.id, chapter.id);
		});
	});
	
	describe("#getSiblings()", function () {
		it("should find items related to the same item in the same way", async function () {
			let other = await createDataObject('item', { itemType: 'book' });
			await Zotero.ItemRelations.add(edition, 'criticalEditionOf', classic);
			await Zotero.ItemRelations.add(other, 'criticalEditionOf', classic);
			let siblings = await Zotero.ItemRelations.getSiblings(edition);
			assert.lengthOf(siblings, 1);
			assert.equal(siblings[0].typeKey, 'criticalEditionOf');
			assert.equal(siblings[0].parent.id, classic.id);
			assert.deepEqual(siblings[0].items.map(i => i.id), [other.id]);
		});
		
		it("should not count items related in a different way, or the item itself", async function () {
			let other = await createDataObject('item', { itemType: 'book' });
			await Zotero.ItemRelations.add(edition, 'criticalEditionOf', classic);
			await Zotero.ItemRelations.add(other, 'translationOf', classic);
			assert.lengthOf(await Zotero.ItemRelations.getSiblings(edition), 0);
		});
		
		it("should treat two volumes of one set as siblings", async function () {
			let volume2 = await createDataObject('item', { itemType: 'book' });
			await Zotero.ItemRelations.add(book, 'partOf', edition);
			await Zotero.ItemRelations.add(volume2, 'partOf', edition);
			let siblings = await Zotero.ItemRelations.getSiblings(volume2);
			assert.deepEqual(siblings[0].items.map(i => i.id), [book.id]);
		});
	});
	
	describe("#remove()", function () {
		it("should remove the relation", async function () {
			await Zotero.ItemRelations.add(chapter, 'partOf', book);
			assert.isTrue(await Zotero.ItemRelations.remove(chapter, 'partOf', book));
			assert.lengthOf(await Zotero.ItemRelations.getOutgoing(chapter), 0);
			assert.lengthOf(await Zotero.ItemRelations.getIncoming(book), 0);
		});
	});
});

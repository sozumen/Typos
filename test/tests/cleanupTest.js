"use strict";

describe("Zotero.Cleanup", function () {
	var libraryID;
	
	var counter = 0;
	
	// Work titles must be unique across tests, since records an earlier test created stay in the
	// library and would be offered as the existing work
	function unique(title) {
		return title + ' ' + (++counter) + Zotero.Utilities.randomString(4);
	}
	
	async function createClassic(title, authorName, extra, fields = {}) {
		let item = new Zotero.Item('classic');
		item.libraryID = libraryID;
		item.setField('title', title);
		for (let [k, v] of Object.entries(fields)) item.setField(k, v);
		item.setField('extra', extra);
		item.setCreators([{ creatorType: 'author', name: authorName }]);
		await item.saveTx();
		return item;
	}
	
	const TERTULLIAN = [
		'collection: Corpus Christianorum Series Latina',
		'collection-title: Corpus Christianorum Series Latina',
		'Pages: 77-172',
		'Volume Title: Opera catholica. Adversus Marcionem',
		'Editor: Dekkers || Eligius'
	].join('\n');
	const CLEMENT = [
		'collection-title: Sources chrétiennes',
		'container-title: Le pédagogue',
		'volume-title: Livre 1',
		'Editor: Mondésert || Claude',
		'Editor: Marrou || Henri-Irénée',
		'keep: me'
	].join('\n');
	
	beforeEach(function () {
		libraryID = Zotero.Libraries.userLibraryID;
	});
	
	describe("critical editions step", function () {
		it("should find candidates and leave other Classic Works alone", async function () {
			let edition = await createClassic(unique('Adversus Marcionem'), 'Tertullian', TERTULLIAN);
			let plain = await createClassic('Iliad', 'Homer', '');
			let scan = await Zotero.Cleanup.scanCriticalEditions(libraryID);
			let ids = scan.items.map(p => p.itemID);
			assert.include(ids, edition.id);
			assert.notInclude(ids, plain.id);
		});
		
		it("should convert items, create linked records and write an undo file", async function () {
			let tertullian = await createClassic(unique('Adversus Marcionem'), 'Tertullian', TERTULLIAN,
				{ referenceSystem: 'Book, chapter' });
			let clement = await createClassic(unique('Paedagogus'), 'Clement of Alexandria', CLEMENT);
			let scan = await Zotero.Cleanup.scanCriticalEditions(libraryID);
			let mine = scan.items.filter(p => [tertullian.id, clement.id].includes(p.itemID));
			let suggestions = scan.suggestions.filter(s => s.itemIDs.some(id => [tertullian.id, clement.id].includes(id)));
			
			let result = await Zotero.Cleanup.applyCriticalEditions(scan, {
				itemIDs: mine.map(p => p.itemID),
				suggestionIDs: suggestions.map(s => s.id)
			});
			assert.equal(result.converted, 2);
			assert.isString(result.logPath);
			
			// Tertullian: a section in a volume, series and pages moved out of Extra
			await tertullian.reload();
			assert.equal(tertullian.itemType, 'bookSection');
			assert.equal(tertullian.getField('bookTitle'), 'Opera catholica. Adversus Marcionem');
			assert.equal(tertullian.getField('pages'), '77-172');
			assert.equal(tertullian.getField('series'), 'Corpus Christianorum Series Latina');
			assert.equal(tertullian.getField('extra'), '');
			let editors = tertullian.getCreators().filter(c => c.creatorTypeID == Zotero.CreatorTypes.getID('editor'));
			assert.equal(editors[0].lastName, 'Dekkers');
			
			let work = (await Zotero.ItemRelations.getOutgoing(tertullian))
				.find(r => r.typeKey === 'criticalEditionOf').items[0];
			assert.equal(work.itemType, 'classic');
			assert.equal(work.getField('title'), tertullian.getField('title'));
			assert.equal(work.getField('referenceSystem'), 'Book, chapter');
			let volume = (await Zotero.ItemRelations.getOutgoing(tertullian))
				.find(r => r.typeKey === 'partOf').items[0];
			assert.equal(volume.itemType, 'book');
			assert.equal(volume.getField('title'), 'Opera catholica. Adversus Marcionem');
			
			// Clement: a whole book that is part of a set; unrelated Extra lines kept
			await clement.reload();
			assert.equal(clement.itemType, 'book');
			assert.equal(clement.getField('title'), 'Le pédagogue');
			assert.equal(clement.getField('volumeTitle'), 'Livre 1');
			assert.equal(clement.getField('extra'), 'keep: me');
			let set = (await Zotero.ItemRelations.getOutgoing(clement))
				.find(r => r.typeKey === 'partOf').items[0];
			assert.equal(set.itemType, 'multiVolumeWork');
			assert.equal(set.getField('title'), 'Le pédagogue');
			assert.equal(set.getField('series'), 'Sources chrétiennes');
			
			// A second run finds nothing more for these items
			let again = await Zotero.Cleanup.scanCriticalEditions(libraryID);
			assert.notInclude(again.items.map(p => p.itemID), tertullian.id);
		});
		
		it("should convert Classic Works with an editor or a contributor in the creators", async function () {
			async function classicWith(title, creators) {
				let item = new Zotero.Item('classic');
				item.libraryID = libraryID;
				item.setField('title', title);
				item.setCreators(creators);
				await item.saveTx();
				return item;
			}
			let author = { creatorType: 'author', name: 'Tertullian' };
			let withEditor = await classicWith(unique('De anima'), [
				author, { creatorType: 'editor', lastName: 'Waszink', firstName: 'Jan Hendrik' }
			]);
			let withContributor = await classicWith(unique('Apologeticum'), [
				author, { creatorType: 'contributor', lastName: 'Becker', firstName: 'Carl' }
			]);
			let plainWork = await classicWith(unique('De spectaculis'), [author]);
			
			let scan = await Zotero.Cleanup.scanCriticalEditions(libraryID);
			let ids = scan.items.map(p => p.itemID);
			assert.include(ids, withEditor.id);
			assert.include(ids, withContributor.id);
			assert.notInclude(ids, plainWork.id);
			
			let mine = [withEditor.id, withContributor.id];
			let result = await Zotero.Cleanup.applyCriticalEditions(scan, {
				itemIDs: mine,
				suggestionIDs: scan.suggestions.filter(s => s.itemIDs.some(id => mine.includes(id))).map(s => s.id)
			});
			assert.equal(result.converted, 2);
			
			for (let item of [withEditor, withContributor]) {
				await item.reload();
				assert.equal(item.itemType, 'book');
				let types = item.getCreators().map(c => Zotero.CreatorTypes.getName(c.creatorTypeID));
				assert.deepEqual(types, ['author', 'editor']);
				let work = (await Zotero.ItemRelations.getOutgoing(item))
					.find(r => r.typeKey === 'criticalEditionOf').items[0];
				assert.equal(work.itemType, 'classic');
				assert.equal(work.getField('title'), item.getField('title'));
				assert.lengthOf(work.getCreators(), 1);
			}
		});
		
		it("should make editions of the same work siblings", async function () {
			let a = await createClassic(unique('Adversus Marcionem'), 'Tertullian', TERTULLIAN);
			let b = await createClassic(a.getField('title'), 'Tertullian',
				'Book-title: Tertullian\nVolume-title: Contre Marcion 1\nEditor: Braun || René');
			let scan = await Zotero.Cleanup.scanCriticalEditions(libraryID);
			let work = scan.suggestions.find(s => s.kind === 'work' && s.itemIDs.includes(a.id));
			assert.sameMembers(work.itemIDs.filter(id => [a.id, b.id].includes(id)), [a.id, b.id]);
			await Zotero.Cleanup.applyCriticalEditions(scan, {
				itemIDs: [a.id, b.id],
				suggestionIDs: [work.id]
			});
			let siblings = await Zotero.ItemRelations.getSiblings(a);
			let editionSiblings = siblings.find(s => s.typeKey === 'criticalEditionOf');
			assert.deepEqual(editionSiblings.items.map(i => i.id), [b.id]);
		});
		
		it("should keep the data when a record is not ticked", async function () {
			let item = await createClassic(unique('Adversus Marcionem'), 'Tertullian', TERTULLIAN,
				{ referenceSystem: 'Book, chapter' });
			let scan = await Zotero.Cleanup.scanCriticalEditions(libraryID);
			await Zotero.Cleanup.applyCriticalEditions(scan, { itemIDs: [item.id], suggestionIDs: [] });
			await item.reload();
			assert.equal(item.itemType, 'bookSection');
			assert.include(item.getField('extra'), 'Reference System: Book, chapter');
			assert.lengthOf(await Zotero.ItemRelations.getOutgoing(item), 0);
		});
		
		it("should undo a run", async function () {
			let item = await createClassic(unique('Adversus Marcionem'), 'Tertullian', TERTULLIAN);
			let before = item.toJSON();
			let scan = await Zotero.Cleanup.scanCriticalEditions(libraryID);
			let work = scan.suggestions.find(s => s.kind === 'work' && s.itemIDs.includes(item.id));
			let result = await Zotero.Cleanup.applyCriticalEditions(scan, {
				itemIDs: [item.id],
				suggestionIDs: scan.suggestions.filter(s => s.itemIDs.includes(item.id)).map(s => s.id)
			});
			await item.reload();
			assert.equal(item.itemType, 'bookSection');
			
			let undone = await Zotero.Cleanup.undo(result.logPath);
			assert.equal(undone.restored, 1);
			assert.isAbove(undone.removed, 0);
			await item.reload();
			assert.equal(item.itemType, 'classic');
			assert.equal(item.getField('extra'), before.extra);
			assert.lengthOf(await Zotero.ItemRelations.getOutgoing(item), 0);
			
			// ... and not twice
			let failed = false;
			try {
				await Zotero.Cleanup.undo(result.logPath);
			}
			catch (e) {
				failed = true;
			}
			assert.isTrue(failed);
		});
	});
	
	describe("#mergeWorks()", function () {
		it("should keep the other title as an alternate-language title", async function () {
			let latin = await createClassic('Adversus Marcionem', 'Tertullian', '', { language: 'la' });
			let english = await createClassic('Against Marcion', 'Tertullian', '', { language: 'en' });
			await Zotero.Cleanup.mergeWorks(latin, [english]);
			await latin.reload();
			let alt = Zotero.JurismMapping.parseAlternates(latin.getField('extra'));
			assert.equal(alt.fields.title.en, 'Against Marcion');
			await english.reload();
			assert.isTrue(english.deleted);
		});
		
		it("should move relationships to the kept work", async function () {
			let latin = await createClassic('Adversus Marcionem', 'Tertullian', '');
			let english = await createClassic('Against Marcion', 'Tertullian', '');
			let edition = await createDataObject('item', { itemType: 'book' });
			await Zotero.ItemRelations.add(edition, 'criticalEditionOf', english);
			await Zotero.Cleanup.mergeWorks(latin, [english], { [english.id]: 'en' });
			await edition.reload();
			let out = await Zotero.ItemRelations.getOutgoing(edition);
			assert.equal(out[0].items[0].id, latin.id);
		});
		
		it("should refuse items that are not Classic Works", async function () {
			let work = await createClassic('Iliad', 'Homer', '');
			let book = await createDataObject('item', { itemType: 'book' });
			let failed = false;
			try {
				await Zotero.Cleanup.mergeWorks(work, [book]);
			}
			catch (e) {
				failed = true;
			}
			assert.isTrue(failed);
		});
	});
});

"use strict";

/**
 * Import from an existing Juris-M library
 *
 * Two sources are supported:
 *
 *  - importDatabase(): reads a Juris-M data directory directly (zotero.sqlite plus storage/).
 *    This keeps everything: item keys (so existing Word documents can be relinked), collections
 *    and their hierarchy, tags, notes, child items, related-item links, PDF annotations,
 *    attachment files and alternate-language data.
 *  - importJSON(): reads item JSON in the Zotero API shape (an array, or an object with an
 *    "items" array). This is a lower-fidelity fallback for when the database can't be read.
 *
 * Both go through Zotero.JurismMapping (jurismMapping.js), which decides how Juris-M item types
 * and fields map onto this application's model and makes sure no data is silently dropped.
 *
 * The source database is never modified: it's copied to a temporary file and the copy is read.
 * Importing is idempotent -- items whose key already exists in the target library are skipped, so
 * an interrupted import can simply be run again.
 *
 * Not handled yet: group libraries (only the personal library is read), feeds, saved searches,
 * and the Juris-M jurisdiction/court tables, none of which have a counterpart here.
 */
Zotero.JurismImport = new function () {
	const BATCH_SIZE = 50;

	const REQUIRED_TABLES = [
		'items', 'itemTypes', 'itemData', 'itemDataValues', 'fields', 'creators', 'itemCreators',
		'creatorTypes', 'collections', 'collectionItems', 'tags', 'itemTags', 'itemNotes',
		'itemAttachments', 'libraries'
	];

	const LINK_MODES = ['imported_file', 'imported_url', 'linked_file', 'linked_url', 'embedded_image'];
	const ANNOTATION_TYPES = {
		1: 'highlight', 2: 'note', 3: 'image', 4: 'ink', 5: 'underline', 6: 'text'
	};
	// Date fields whose stored values are in Zotero's "YYYY-MM-DD original text" form
	const JURISM_DATE_FIELDS = new Set([
		'date', 'filingDate', 'conferenceDate', 'newsCaseDate', 'priorityDate', 'publicationDate',
		'originalDate', 'dateAmended', 'openingDate', 'adoptionDate', 'signingDate'
	]);
	const CHILD_ORDER = { regular: 0, child: 1, annotation: 2 };


	//
	// Schema bridge for the mapping layer
	//

	function _schema() {
		return {
			isValidField(itemType, field) {
				let typeID = Zotero.ItemTypes.getID(itemType);
				let fieldID = Zotero.ItemFields.getID(field);
				return !!typeID && !!fieldID && Zotero.ItemFields.isValidForType(fieldID, typeID);
			},
			resolveField(itemType, field) {
				let typeID = Zotero.ItemTypes.getID(itemType);
				let fieldID = Zotero.ItemFields.getID(field);
				if (!typeID || !fieldID) return null;
				let resolvedID = Zotero.ItemFields.getFieldIDFromTypeAndBase(typeID, fieldID);
				return resolvedID ? Zotero.ItemFields.getName(resolvedID) : null;
			},
			isValidCreatorType(itemType, creatorType) {
				let typeID = Zotero.ItemTypes.getID(itemType);
				let creatorTypeID = Zotero.CreatorTypes.getID(creatorType);
				return !!typeID && !!creatorTypeID
					&& Zotero.CreatorTypes.isValidForItemType(creatorTypeID, typeID);
			},
			normalizeValue(field, value) {
				if (field === 'accessDate') {
					return Zotero.Date.sqlToISO8601(value);
				}
				let isDate = JURISM_DATE_FIELDS.has(field)
					|| Zotero.Schema.globalSchemaMeta?.fields?.[field]?.type === 'date';
				return isDate ? Zotero.Date.multipartToStr(value) : value;
			}
		};
	}


	function _sqlToISO(value) {
		return value ? Zotero.Date.sqlToISO8601(value) : undefined;
	}


	function _newReport() {
		return {
			counts: {
				items: 0, notes: 0, attachments: 0, annotations: 0, collections: 0,
				skippedExisting: 0, relations: 0, filesCopied: 0, filesMissing: 0
			},
			typeChanges: {},
			warnings: [],
			failed: []
		};
	}


	//
	// Reading a Juris-M database
	//

	/**
	 * Copy the database (and any journal files next to it) to a temporary location and open it
	 */
	async function _openCopy(dbPath) {
		if (!(await IOUtils.exists(dbPath))) {
			throw new Error("Database file not found: " + dbPath);
		}
		let tmpDir = Zotero.getTempDirectory().path;
		let tmpPath = PathUtils.join(tmpDir, 'jurism-import-' + Date.now() + '.sqlite');
		let copied = [tmpPath];
		await IOUtils.copy(dbPath, tmpPath);
		for (let suffix of ['-wal', '-journal']) {
			if (await IOUtils.exists(dbPath + suffix)) {
				await IOUtils.copy(dbPath + suffix, tmpPath + suffix);
				copied.push(tmpPath + suffix);
			}
		}
		let db = new Zotero.DBConnection(tmpPath);
		return { db, cleanup: async () => {
			try {
				await db.closeDatabase();
			}
			catch (e) {
				Zotero.logError(e);
			}
			for (let path of copied) {
				await IOUtils.remove(path, { ignoreAbsent: true });
			}
		} };
	}


	async function _missingTables(db) {
		let missing = [];
		for (let table of REQUIRED_TABLES) {
			if (!(await db.tableExists(table))) missing.push(table);
		}
		return missing;
	}


	function _push(map, key, value) {
		let list = map.get(key);
		if (!list) {
			list = [];
			map.set(key, list);
		}
		list.push(value);
	}


	/**
	 * Read everything we need from the source database into plain objects
	 */
	async function _readSource(db, options, report) {
		let libraryID = await db.valueQueryAsync("SELECT libraryID FROM libraries WHERE type='user'") || 1;

		let trash = options.includeTrashed
			? ''
			: ' AND i.itemID NOT IN (SELECT itemID FROM deletedItems)';
		let hasDeleted = await db.tableExists('deletedItems');
		let itemRows = await db.queryAsync(
			"SELECT i.itemID, i.key, i.dateAdded, i.dateModified, it.typeName AS itemType "
			+ "FROM items i JOIN itemTypes it USING (itemTypeID) WHERE i.libraryID=?"
			+ (hasDeleted ? trash : ''),
			libraryID
		);
		let items = new Map();
		for (let row of itemRows) {
			items.set(row.itemID, {
				itemID: row.itemID,
				key: row.key,
				itemType: row.itemType,
				dateAdded: row.dateAdded,
				dateModified: row.dateModified,
				fields: {},
				creators: [],
				tags: [],
				collections: [],
				relations: {},
				alternates: { fields: {}, creators: [], mainLang: {} }
			});
		}
		if (hasDeleted && options.includeTrashed) {
			let ids = await db.columnQueryAsync("SELECT itemID FROM deletedItems");
			for (let id of ids) {
				if (items.has(id)) items.get(id).deleted = true;
			}
		}

		// Field values
		for (let row of await db.queryAsync(
			"SELECT itemID, fieldName AS field, value FROM itemData "
			+ "JOIN fields USING (fieldID) JOIN itemDataValues USING (valueID)"
		)) {
			let item = items.get(row.itemID);
			if (item) item.fields[row.field] = row.value;
		}

		// Creators. Juris-M keeps main-language creators in itemCreatorsMain; fall back to
		// itemCreators for items that have no rows there.
		let creatorsByItem = new Map();
		let creatorSQL = table => "SELECT ic.itemID, ic.orderIndex, ct.creatorType, c.firstName, "
			+ "c.lastName, c.fieldMode" + (table === 'itemCreatorsMain' ? ", ic.languageTag" : "")
			+ " FROM " + table + " ic JOIN creators c USING (creatorID) "
			+ "JOIN creatorTypes ct USING (creatorTypeID) ORDER BY ic.itemID, ic.orderIndex";
		for (let table of ['itemCreators', 'itemCreatorsMain']) {
			if (!(await db.tableExists(table))) continue;
			let byItem = new Map();
			for (let row of await db.queryAsync(creatorSQL(table))) {
				_push(byItem, row.itemID, row);
			}
			// Rows from itemCreatorsMain override itemCreators for the same item
			for (let [itemID, rows] of byItem) creatorsByItem.set(itemID, rows);
		}
		for (let [itemID, rows] of creatorsByItem) {
			let item = items.get(itemID);
			if (!item) continue;
			for (let row of rows) {
				item.creators.push({
					creatorType: row.creatorType,
					firstName: row.firstName,
					lastName: row.lastName,
					fieldMode: row.fieldMode
				});
				if (row.languageTag) {
					item.alternates.mainLang['creator:' + row.orderIndex] = row.languageTag;
				}
			}
		}

		// Multilingual data (absent in plain Zotero databases)
		{
			if (await db.tableExists('itemDataAlt')) {
				for (let row of await db.queryAsync(
					"SELECT itemID, fieldName AS field, languageTag, value FROM itemDataAlt "
					+ "JOIN fields USING (fieldID) JOIN itemDataValues USING (valueID)"
				)) {
					let item = items.get(row.itemID);
					if (!item) continue;
					(item.alternates.fields[row.field] ||= {})[row.languageTag] = row.value;
				}
			}
			if (await db.tableExists('itemDataMain')) {
				for (let row of await db.queryAsync(
					"SELECT itemID, fieldName AS field, languageTag FROM itemDataMain "
					+ "JOIN fields USING (fieldID) WHERE languageTag IS NOT NULL"
				)) {
					let item = items.get(row.itemID);
					if (item) item.alternates.mainLang[row.field] = row.languageTag;
				}
			}
			if (await db.tableExists('itemCreatorsAlt')) {
				for (let row of await db.queryAsync(
					"SELECT ic.itemID, ic.orderIndex, ct.creatorType, c.firstName, c.lastName, "
					+ "c.fieldMode, ic.languageTag FROM itemCreatorsAlt ic "
					+ "JOIN creators c USING (creatorID) JOIN creatorTypes ct USING (creatorTypeID)"
				)) {
					let item = items.get(row.itemID);
					if (!item) continue;
					item.alternates.creators.push({
						index: row.orderIndex,
						creatorType: row.creatorType,
						languageTag: row.languageTag,
						firstName: row.firstName,
						lastName: row.lastName,
						fieldMode: row.fieldMode
					});
				}
			}
		}

		// Tags
		for (let row of await db.queryAsync(
			"SELECT itemID, name, type FROM itemTags JOIN tags USING (tagID)"
		)) {
			let item = items.get(row.itemID);
			if (item) item.tags.push({ tag: row.name, type: row.type || 0 });
		}

		// Notes
		for (let row of await db.queryAsync(
			"SELECT itemID, parentItemID, note FROM itemNotes"
		)) {
			let item = items.get(row.itemID);
			if (!item) continue;
			item.note = row.note;
			item.parentItemID = row.parentItemID;
		}

		// Attachments
		for (let row of await db.queryAsync(
			"SELECT itemID, parentItemID, linkMode, contentType, path FROM itemAttachments"
		)) {
			let item = items.get(row.itemID);
			if (!item) continue;
			item.parentItemID = row.parentItemID;
			item.attachment = {
				linkMode: LINK_MODES[row.linkMode],
				contentType: row.contentType,
				path: row.path
			};
		}

		// Annotations
		if (options.importAnnotations !== false && await db.tableExists('itemAnnotations')) {
			for (let row of await db.queryAsync(
				"SELECT itemID, parentItemID, type, authorName, text, comment, color, pageLabel, "
				+ "sortIndex, position FROM itemAnnotations"
			)) {
				let item = items.get(row.itemID);
				if (!item) continue;
				item.parentItemID = row.parentItemID;
				item.annotation = {
					annotationType: ANNOTATION_TYPES[row.type],
					annotationAuthorName: row.authorName || '',
					annotationText: row.text || '',
					annotationComment: row.comment || '',
					annotationColor: row.color || '',
					annotationPageLabel: row.pageLabel || '',
					annotationSortIndex: row.sortIndex,
					annotationPosition: row.position
				};
			}
		}

		// Annotation items without annotation data (annotations disabled) can't be imported
		for (let [itemID, item] of items) {
			if (item.itemType === 'annotation' && !item.annotation) items.delete(itemID);
		}
		
		// Collections
		let collections = new Map();
		for (let row of await db.queryAsync(
			"SELECT collectionID, collectionName, parentCollectionID, key FROM collections "
			+ "WHERE libraryID=?",
			libraryID
		)) {
			collections.set(row.collectionID, {
				id: row.collectionID,
				key: row.key,
				name: row.collectionName,
				parentID: row.parentCollectionID
			});
		}
		for (let row of await db.queryAsync("SELECT collectionID, itemID FROM collectionItems")) {
			let item = items.get(row.itemID);
			let collection = collections.get(row.collectionID);
			if (item && collection) item.collections.push(collection.key);
		}

		// Relations (only item-to-item "related" links are carried over)
		if (await db.tableExists('itemRelations')) {
			let skipped = new Set();
			for (let row of await db.queryAsync(
				"SELECT itemID, predicate, object FROM itemRelations "
				+ "JOIN relationPredicates USING (predicateID)"
			)) {
				let item = items.get(row.itemID);
				if (!item) continue;
				if (row.predicate === 'dc:relation') {
					(item.relations[row.predicate] ||= []).push(row.object);
				}
				else {
					skipped.add(row.predicate);
				}
			}
			if (skipped.size) {
				report.warnings.push("Relations of these kinds weren't imported: "
					+ Array.from(skipped).sort().join(', '));
			}
		}

		// Resolve parent keys
		for (let item of items.values()) {
			if (item.parentItemID) {
				item.parentKey = items.get(item.parentItemID)?.key;
			}
		}

		return { libraryID, items, collections };
	}


	//
	// Saving
	//

	/**
	 * Convert a source item into a save entry using the mapping layer
	 */
	function _toEntry(src, schema, report, options) {
		let kind = src.annotation ? 'annotation' : (src.parentKey ? 'child' : 'regular');
		let entry = { key: src.key, kind, src };

		if (src.annotation) {
			entry.json = Object.assign({ itemType: 'annotation', parentItem: src.parentKey }, src.annotation);
		}
		else if (src.itemType === 'note') {
			entry.json = { itemType: 'note', note: src.note || '' };
			if (src.parentKey) entry.json.parentItem = src.parentKey;
		}
		else {
			let { json, warnings } = Zotero.JurismMapping.mapItem(src, schema);
			for (let warning of warnings) report.warnings.push(`${src.key}: ${warning}`);
			if (json.itemType !== src.itemType) {
				report.typeChanges[src.itemType] = (report.typeChanges[src.itemType] || 0) + 1;
			}
			entry.json = json;
			if (src.parentKey) entry.json.parentItem = src.parentKey;
			if (src.attachment) {
				let { linkMode, contentType, path } = src.attachment;
				entry.json.linkMode = linkMode;
				if (contentType) entry.json.contentType = contentType;
				if (linkMode === 'imported_file' || linkMode === 'imported_url') {
					entry.json.filename = (path || '').replace(/^storage:/, '');
				}
				else if (linkMode === 'linked_file') {
					entry.json.path = _resolveLinkedPath(path, options, report, src.key);
				}
			}
		}

		if (src.tags && src.tags.length) entry.json.tags = src.tags;
		if (src.collections && src.collections.length && !src.annotation && !src.parentKey) {
			entry.json.collections = src.collections;
		}
		if (src.dateAdded) entry.json.dateAdded = _sqlToISO(src.dateAdded);
		if (src.dateModified) entry.json.dateModified = _sqlToISO(src.dateModified);
		if (src.deleted) entry.json.deleted = true;
		return entry;
	}


	function _resolveLinkedPath(path, options, report, key) {
		if (!path) return path;
		if (path.startsWith('attachments:')) {
			if (options.linkedFileBase) {
				return PathUtils.join(options.linkedFileBase, path.slice('attachments:'.length));
			}
			report.warnings.push(`${key}: linked file '${path}' is relative to Juris-M's base `
				+ `directory; set a linked-file base directory to relink it`);
		}
		return path;
	}


	async function _saveCollections(libraryID, collections, report, options) {
		// Parents before children
		let remaining = Array.from(collections.values());
		let saved = new Set();
		let guard = remaining.length + 1;
		while (remaining.length && guard-- > 0) {
			let next = [];
			for (let c of remaining) {
				let parent = c.parentID ? collections.get(c.parentID) : null;
				if (parent && !saved.has(parent.key)) {
					next.push(c);
					continue;
				}
				if (Zotero.Collections.getByLibraryAndKey(libraryID, c.key)) {
					saved.add(c.key);
					continue;
				}
				let collection = new Zotero.Collection();
				collection.libraryID = libraryID;
				collection.key = c.key;
				collection.name = c.name;
				if (parent) collection.parentKey = parent.key;
				await collection.saveTx({ skipSelect: true, notifierQueue: options.notifierQueue });
				saved.add(c.key);
				report.counts.collections++;
			}
			remaining = next;
		}
		if (remaining.length) {
			report.warnings.push(`${remaining.length} collection(s) had unresolvable parents and `
				+ `weren't imported`);
		}
	}


	async function _saveEntries(libraryID, entries, options, report, copyFiles) {
		entries.sort((a, b) => CHILD_ORDER[a.kind] - CHILD_ORDER[b.kind]);
		let total = entries.length;
		let done = 0;

		for (let start = 0; start < entries.length; start += BATCH_SIZE) {
			if (options.isCancelled && options.isCancelled()) {
				report.warnings.push("Import was cancelled; run it again to continue.");
				return;
			}
			let batch = entries.slice(start, start + BATCH_SIZE);
			let toCopy = [];
			await Zotero.DB.executeTransaction(async () => {
				for (let entry of batch) {
					if (Zotero.Items.getByLibraryAndKey(libraryID, entry.key)) {
						report.counts.skippedExisting++;
						continue;
					}
					try {
						let item = new Zotero.Item();
						item.libraryID = libraryID;
						item.key = entry.key;
						item.fromJSON(entry.json);
						await item.save({
							skipSelect: true,
							skipDateModifiedUpdate: true,
							notifierQueue: options.notifierQueue
						});
						entry.item = item;
						let json = entry.json;
						if (json.itemType === 'note') report.counts.notes++;
						else if (json.itemType === 'attachment') report.counts.attachments++;
						else if (json.itemType === 'annotation') report.counts.annotations++;
						else report.counts.items++;
						if (copyFiles && json.itemType === 'attachment'
								&& (json.linkMode === 'imported_file' || json.linkMode === 'imported_url')) {
							toCopy.push(entry);
						}
					}
					catch (e) {
						Zotero.logError(e);
						report.failed.push({ key: entry.key, error: String(e.message || e) });
					}
				}
			});

			// File copies happen outside the transaction, since they can be slow
			for (let entry of toCopy) {
				await _copyAttachmentFiles(entry, options, report);
			}
			done += batch.length;
			options.progress?.({ phase: 'items', done, total });
		}
	}


	async function _copyAttachmentFiles(entry, options, report) {
		let sourceDir = PathUtils.join(options.storageDir, entry.key);
		if (!(await IOUtils.exists(sourceDir))) {
			report.counts.filesMissing++;
			report.warnings.push(`${entry.key}: attachment file not found in the Juris-M storage folder`);
			return;
		}
		try {
			let destDir = await Zotero.Attachments.createDirectoryForItem(entry.item);
			await Zotero.File.copyDirectory(sourceDir, destDir);
			report.counts.filesCopied++;
		}
		catch (e) {
			Zotero.logError(e);
			report.counts.filesMissing++;
			report.warnings.push(`${entry.key}: couldn't copy attachment files (${e.message})`);
		}
	}


	/**
	 * Second pass, once all items exist: related-item links, rewritten to this library's URIs
	 */
	async function _saveRelations(libraryID, entries, report, options) {
		let prefix = Zotero.URI.getLibraryURI(libraryID) + '/items/';
		let known = new Set(entries.filter(e => e.item).map(e => e.key));
		await Zotero.DB.executeTransaction(async () => {
			for (let entry of entries) {
				if (!entry.item || !entry.src?.relations?.['dc:relation']) continue;
				let changed = false;
				for (let uri of entry.src.relations['dc:relation']) {
					let key = (uri.match(/\/items\/([A-Z0-9]{8})$/) || [])[1];
					if (!key) continue;
					if (!known.has(key) && !Zotero.Items.getByLibraryAndKey(libraryID, key)) continue;
					if (entry.item.addRelation('dc:relation', prefix + key)) {
						changed = true;
						report.counts.relations++;
					}
				}
				if (changed) {
					await entry.item.save({
						skipDateModifiedUpdate: true,
						skipSelect: true,
						notifierQueue: options.notifierQueue
					});
				}
			}
		});
	}


	// Exposed for tests only
	this._internals = { readSource: _readSource, toEntry: _toEntry, schema: _schema };
	
	
	//
	// Public API
	//

	/**
	 * Check that a file looks like a Juris-M/Zotero database and report what's in it, without
	 * importing anything
	 *
	 * @param {String} dbPath
	 * @return {Promise<{ valid: Boolean, missing: String[], counts: Object }>}
	 */
	this.inspect = async function (dbPath) {
		let { db, cleanup } = await _openCopy(dbPath);
		try {
			let missing = await _missingTables(db);
			if (missing.length) {
				return { valid: false, missing, counts: {} };
			}
			let count = async sql => (await db.valueQueryAsync(sql)) || 0;
			return {
				valid: true,
				missing: [],
				counts: {
					items: await count("SELECT COUNT(*) FROM items WHERE itemTypeID NOT IN "
						+ "(SELECT itemTypeID FROM itemTypes WHERE typeName IN ('note','attachment','annotation'))"),
					collections: await count("SELECT COUNT(*) FROM collections"),
					multilingualFields: (await db.tableExists('itemDataAlt'))
						? await count("SELECT COUNT(*) FROM itemDataAlt") : 0
				}
			};
		}
		finally {
			await cleanup();
		}
	};


	/**
	 * Import from a Juris-M database file
	 *
	 * @param {String} dbPath - Path to zotero.sqlite in the Juris-M data directory
	 * @param {Object} [options]
	 * @param {Integer} [options.libraryID] - Target library (default: the personal library)
	 * @param {String} [options.storageDir] - Juris-M storage folder (default: "storage" next to
	 *     the database)
	 * @param {String} [options.linkedFileBase] - Folder that Juris-M's "attachments:" paths are
	 *     relative to
	 * @param {Boolean} [options.includeTrashed=false]
	 * @param {Boolean} [options.importAnnotations=true]
	 * @param {Function} [options.progress] - ({ phase, done, total }) => void
	 * @param {Function} [options.isCancelled] - () => Boolean
	 * @return {Promise<Object>} - Report with counts, warnings, typeChanges and failed items
	 */
	this.importDatabase = async function (dbPath, options = {}) {
		options = Object.assign({}, options);
		options.storageDir ||= PathUtils.join(PathUtils.parent(dbPath), 'storage');
		let libraryID = options.libraryID || Zotero.Libraries.userLibraryID;
		let report = _newReport();
		let resumeSync = Zotero.Sync?.Runner?.delayIndefinite?.();
		options.notifierQueue = new Zotero.Notifier.Queue();
		let { db, cleanup } = await _openCopy(dbPath);
		try {
			let missing = await _missingTables(db);
			if (missing.length) {
				throw new Error("Not a Juris-M or Zotero database (missing tables: "
					+ missing.join(', ') + ")");
			}
			options.progress?.({ phase: 'reading', done: 0, total: 0 });
			let source = await _readSource(db, options, report);

			await _saveCollections(libraryID, source.collections, report, options);

			let schema = _schema();
			let entries = Array.from(source.items.values())
				.map(src => _toEntry(src, schema, report, options));
			await _saveEntries(libraryID, entries, options, report, true);
			await _saveRelations(libraryID, entries, report, options);
		}
		finally {
			await cleanup();
			await Zotero.Notifier.commit(options.notifierQueue);
			resumeSync?.();
		}
		return report;
	};


	// Properties that belong to the API item structure rather than being data fields
	const STRUCTURAL = new Set([
		'key', 'version', 'itemType', 'creators', 'tags', 'collections', 'relations', 'parentItem',
		'dateAdded', 'dateModified', 'deleted', 'inPublications', 'note', 'linkMode', 'contentType',
		'charset', 'filename', 'path', 'md5', 'mtime'
	]);


	/**
	 * Import items from Zotero-API-shaped JSON
	 *
	 * Collections aren't reconstructed (the JSON only has collection keys), and attachment files
	 * aren't copied, but notes, tags, creators and related-item links come through. Items without
	 * a key get a fresh one.
	 *
	 * @param {String} text - JSON: an array of items, or { items: [...] }
	 * @param {Object} [options] - libraryID, progress, isCancelled
	 * @return {Promise<Object>} - Report
	 */
	this.importJSON = async function (text, options = {}) {
		let data;
		try {
			data = JSON.parse(String(text).replace(/^﻿/, ''));
		}
		catch (e) {
			throw new Error("Not valid JSON: " + e.message);
		}
		let list = Array.isArray(data) ? data : data && Array.isArray(data.items) ? data.items : null;
		if (!list) {
			throw new Error("Expected an array of items, or an object with an 'items' array");
		}

		let libraryID = options.libraryID || Zotero.Libraries.userLibraryID;
		let report = _newReport();
		let schema = _schema();
		let entries = [];
		for (let raw of list) {
			if (!raw || typeof raw !== 'object' || !raw.itemType) {
				report.warnings.push("Skipped an entry with no itemType");
				continue;
			}
			let src = {
				itemType: raw.itemType,
				fields: {},
				creators: (raw.creators || []).map(c => ({
					creatorType: c.creatorType,
					firstName: c.firstName,
					lastName: c.lastName !== undefined ? c.lastName : c.name,
					fieldMode: c.name !== undefined ? 1 : 0
				})),
				tags: raw.tags || [],
				note: raw.note,
				parentKey: raw.parentItem,
				dateAdded: undefined,
				relations: {}
			};
			for (let [k, v] of Object.entries(raw)) {
				if (!STRUCTURAL.has(k) && typeof v === 'string') src.fields[k] = v;
			}
			let key = raw.key || Zotero.DataObjectUtilities.generateKey();
			src.key = key;
			// JSON from the API already has user-visible date strings, so don't normalize dates
			let jsonSchema = Object.assign({}, schema, { normalizeValue: (f, v) => v });
			let entry = _toEntry(src, jsonSchema, report, options);
			if (raw.dateAdded) entry.json.dateAdded = raw.dateAdded;
			if (raw.dateModified) entry.json.dateModified = raw.dateModified;
			entries.push(entry);
		}

		options = Object.assign({}, options, { notifierQueue: new Zotero.Notifier.Queue() });
		let resumeSync = Zotero.Sync?.Runner?.delayIndefinite?.();
		try {
			await _saveEntries(libraryID, entries, options, report, false);
		}
		finally {
			await Zotero.Notifier.commit(options.notifierQueue);
			resumeSync?.();
		}
		return report;
	};
};

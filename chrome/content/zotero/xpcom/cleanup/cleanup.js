"use strict";

/**
 * Library cleanup: a list of steps, each of which finds items that need tidying, shows what it
 * would change, and applies the changes the person ticks
 *
 * The decisions are in the pure modules (cleanupExtra.js, criticalEditions.js, workMerge.js);
 * this file reads items into plain snapshots, writes the result back in one database transaction,
 * and keeps an undo file for every run so that a run can be reversed later.
 *
 * To add a step: put its pure logic in a new module, then register it with
 * Zotero.Cleanup.registerStep({ id, l10nID, scan, apply }).
 */
Zotero.Cleanup = new function () {
	const WINDOW_TYPE = 'zotero:library-cleanup';
	const WINDOW_URL = 'chrome://zotero/content/tools/cleanup.html';
	const WINDOW_FEATURES = 'chrome,width=900,height=760,resizable,centerscreen';
	const LOG_DIR = 'typos-cleanup';
	const LOG_VERSION = 1;

	// Keys of Item#toJSON() that are not fields
	const NOT_FIELDS = new Set([
		'key', 'version', 'itemType', 'creators', 'tags', 'collections', 'relations',
		'dateAdded', 'dateModified', 'parentItem', 'deleted', 'inPublications', 'mimeType',
		'linkMode', 'contentType', 'charset', 'filename', 'md5', 'mtime', 'path'
	]);

	let _steps = new Map();
	let _pending = null;

	this.WINDOW_TYPE = WINDOW_TYPE;


	//
	// Steps
	//

	/**
	 * @param {Object} step
	 * @param {String} step.id
	 * @param {String} step.l10nID - Fluent ID of the step's name
	 * @param {String} step.descriptionL10nID
	 * @param {Function} step.scan - async (libraryID) => scan result (see scanCriticalEditions)
	 * @param {Function} step.apply - async (scan, selection) => result
	 */
	this.registerStep = function (step) {
		if (!step.id || typeof step.scan !== 'function' || typeof step.apply !== 'function') {
			throw new Error("A cleanup step needs an id, scan() and apply()");
		}
		_steps.set(step.id, step);
	};


	this.getSteps = function () {
		return [..._steps.values()];
	};


	this.getStep = function (id) {
		return _steps.get(id) || null;
	};


	//
	// Reading and writing items
	//

	let schema = this.schema = {
		isValidField(itemType, field) {
			let typeID = Zotero.ItemTypes.getID(itemType);
			let fieldID = Zotero.ItemFields.getID(field);
			return !!typeID && !!fieldID && Zotero.ItemFields.isValidForType(fieldID, typeID);
		},
		isValidCreatorType(itemType, creatorType) {
			let typeID = Zotero.ItemTypes.getID(itemType);
			let creatorTypeID = Zotero.CreatorTypes.getID(creatorType);
			return !!typeID && !!creatorTypeID && Zotero.CreatorTypes.isValidForItemType(creatorTypeID, typeID);
		}
	};


	/**
	 * A plain copy of an item: { id, key, itemType, fields, creators }
	 */
	this.snapshot = function (item) {
		let json = item.toJSON();
		let fields = {};
		for (let [key, value] of Object.entries(json)) {
			if (NOT_FIELDS.has(key) || typeof value !== 'string') continue;
			fields[key] = value;
		}
		let creators = (json.creators || []).map((c) => {
			if (c.name !== undefined) {
				return { creatorType: c.creatorType, firstName: '', lastName: c.name, fieldMode: 1 };
			}
			return { creatorType: c.creatorType, firstName: c.firstName || '', lastName: c.lastName || '', fieldMode: 0 };
		});
		return { id: item.id, key: item.key, itemType: json.itemType, fields, creators };
	};


	function _toAPICreators(creators) {
		return creators.map(c => c.fieldMode === 1
			? { creatorType: c.creatorType, name: c.lastName }
			: { creatorType: c.creatorType, firstName: c.firstName, lastName: c.lastName });
	}


	function _applyData(item, data) {
		for (let [field, value] of Object.entries(data.fields)) {
			if (value === null || value === undefined) {
				if (schema.isValidField(item.itemType, field)) item.setField(field, '');
				continue;
			}
			if (schema.isValidField(item.itemType, field)) {
				item.setField(field, value);
			}
		}
		item.setCreators(_toAPICreators(data.creators));
	}


	//
	// Step: critical editions imported as Classic Work items
	//

	/**
	 * Find the candidates and work out what to do with them. Reads only; changes nothing.
	 *
	 * @param {Number} libraryID
	 * @return {Promise<{ libraryID: Number, items: Object[], suggestions: Object[],
	 *     nearMisses: Number[], titles: Object }>}
	 *     titles: { itemID: title } for showing the plan
	 */
	this.scanCriticalEditions = async function (libraryID) {
		let typeID = Zotero.ItemTypes.getID('classic');
		let ids = await Zotero.DB.columnQueryAsync(
			"SELECT itemID FROM items WHERE libraryID=? AND itemTypeID=? "
				+ "AND itemID NOT IN (SELECT itemID FROM deletedItems)",
			[libraryID, typeID]
		);
		let items = await Zotero.Items.getAsync(ids);
		let snapshots = [];
		let titles = {};
		for (let item of items) {
			await item.loadAllData();
			snapshots.push(this.snapshot(item));
			titles[item.id] = item.getDisplayTitle();
		}
		let plan = Zotero.CleanupCriticalEditions.planAll(snapshots, this.schema);
		plan.libraryID = libraryID;
		plan.titles = titles;
		plan.snapshots = Object.fromEntries(snapshots.map(s => [s.id, s]));
		return plan;
	};


	/**
	 * Apply a scan. Everything happens in one transaction, so a failure leaves the library as
	 * it was. An undo file is written when it succeeds.
	 *
	 * @param {Object} scan - from scanCriticalEditions
	 * @param {Object} selection
	 * @param {Number[]} selection.itemIDs - items to convert
	 * @param {String[]} selection.suggestionIDs - records to create (or existing ones to link to)
	 * @return {Promise<{ converted: Number, created: Number, linked: Number, warnings: String[],
	 *     logPath: String|null }>}
	 */
	this.applyCriticalEditions = async function (scan, selection) {
		let C = Zotero.CleanupCriticalEditions;
		let itemIDs = new Set(selection.itemIDs);
		let wanted = new Set(selection.suggestionIDs);
		let log = {
			version: LOG_VERSION,
			step: C.STEP_ID,
			date: new Date().toISOString(),
			libraryID: scan.libraryID,
			changed: [],
			created: []
		};
		let warnings = [];
		let linked = 0;
		let converted = 0;

		await Zotero.DB.executeTransaction(async () => {
			let records = new Map(); // suggestion id -> Zotero.Item

			// Records that will be created or linked to; only those some chosen item uses
			for (let s of scan.suggestions) {
				if (!wanted.has(s.id) || !s.itemIDs.some(id => itemIDs.has(id))) continue;
				if (s.existingID) {
					let existing = await Zotero.Items.getAsync(s.existingID);
					if (existing && !existing.deleted) records.set(s.id, existing);
					continue;
				}
				let data = C.entityData(s, schema);
				let record = new Zotero.Item(data.itemType);
				record.libraryID = scan.libraryID;
				_applyData(record, data);
				await record.save();
				records.set(s.id, record);
				log.created.push({ id: record.id, key: record.key });
			}

			// Convert the items
			let available = new Set(records.keys());
			let pendingLinks = [];
			for (let plan of scan.items) {
				if (!itemIDs.has(plan.itemID)) continue;
				let item = await Zotero.Items.getAsync(plan.itemID);
				await item.loadAllData();
				let snap = this.snapshot(item);
				let result = C.resolve(plan, available, snap, this.schema);

				log.changed.push({ id: item.id, key: item.key, before: item.toJSON() });

				item.setType(Zotero.ItemTypes.getID(result.itemType));
				_applyData(item, result);
				await item.save();
				converted++;
				for (let link of result.links) {
					pendingLinks.push({ item, link });
				}
				warnings.push(...plan.warnings.map(w => `${scan.titles[plan.itemID]}: ${w}`));
			}

			// Links, after everything exists
			for (let { item, link } of pendingLinks) {
				let subject = link.from === 'item' ? item : records.get(link.from);
				let object = records.get(link.to);
				if (!subject || !object) continue;
				try {
					await Zotero.ItemRelations.add(subject, link.type, object, { skipSave: true });
					await subject.save({ skipDateModifiedUpdate: true });
					linked++;
				}
				catch (e) {
					// "exists" is expected when several items share a record
					if (e instanceof Zotero.ItemRelations.InvalidRelationError) {
						if (e.code !== 'exists') {
							warnings.push(`${subject.getDisplayTitle()}: ${e.message}`);
						}
					}
					else {
						throw e;
					}
				}
			}
		});

		let logPath = null;
		try {
			logPath = await this._writeLog(log);
		}
		catch (e) {
			Zotero.logError(e);
			warnings.push("The changes were made, but the undo file could not be saved.");
		}
		return { converted, created: log.created.length, linked, warnings, logPath };
	};


	//
	// Undo files
	//

	this._logDir = function () {
		return PathUtils.join(Zotero.DataDirectory.dir, LOG_DIR);
	};


	this._writeLog = async function (log) {
		let dir = this._logDir();
		await IOUtils.makeDirectory(dir, { createAncestors: true, ignoreExisting: true });
		let stamp = log.date.replace(/[-:]/g, '').replace(/\..*$/, '').replace('T', '-');
		let path = PathUtils.join(dir, `cleanup-${log.step}-${stamp}.json`);
		await IOUtils.writeJSON(path, log);
		return path;
	};


	/**
	 * @return {Promise<{ path: String, step: String, date: String, items: Number, created: Number }[]>}
	 *     Newest first
	 */
	this.listLogs = async function () {
		let dir = this._logDir();
		if (!(await IOUtils.exists(dir))) return [];
		let out = [];
		for (let path of await IOUtils.getChildren(dir)) {
			if (!path.endsWith('.json')) continue;
			try {
				let log = await IOUtils.readJSON(path);
				if (log.version !== LOG_VERSION) continue;
				out.push({
					path,
					step: log.step,
					date: log.date,
					items: log.changed.length,
					created: log.created.length,
					undone: !!log.undone
				});
			}
			catch (e) {
				Zotero.logError(e);
			}
		}
		return out.sort((a, b) => b.date.localeCompare(a.date));
	};


	/**
	 * Reverse a run: put the converted items back as they were and delete the records the run
	 * created. Items changed again since are restored too, so this is meant to be used soon after.
	 *
	 * @return {Promise<{ restored: Number, removed: Number }>}
	 */
	this.undo = async function (logPath) {
		let log = await IOUtils.readJSON(logPath);
		if (log.version !== LOG_VERSION) throw new Error("Unknown undo file version");
		if (log.undone) throw new Error("This run has already been undone");
		let restored = 0;
		let removed = 0;
		await Zotero.DB.executeTransaction(async () => {
			for (let c of log.changed) {
				let item = await Zotero.Items.getAsync(c.id);
				if (!item || item.key !== c.key) continue;
				await item.loadAllData();
				// Strict, so Extra isn't read again and its lines turned back into fields and creators
				item.fromJSON(c.before, { strict: true });
				await item.save();
				restored++;
			}
			for (let c of log.created) {
				let item = await Zotero.Items.getAsync(c.id);
				if (!item || item.key !== c.key) continue;
				await item.erase();
				removed++;
			}
		});
		log.undone = new Date().toISOString();
		await IOUtils.writeJSON(logPath, log);
		return { restored, removed };
	};


	//
	// Step: merge duplicate works, keeping the titles as languages
	//

	/**
	 * @param {Zotero.Item[]} items - The Classic Work items to look at
	 * @return {Promise<Object[]>} - [{ id, title, language, suggestedMaster }]
	 */
	this.describeForMerge = async function (items) {
		let snaps = [];
		for (let item of items) {
			await item.loadAllData();
			let snap = this.snapshot(item);
			snap.relationCount = Object.values(item.getRelations()).reduce((n, v) => n + v.length, 0);
			snaps.push(snap);
		}
		let master = snaps.length ? Zotero.CleanupWorkMerge.suggestMaster(snaps) : null;
		return snaps.map(s => ({
			id: s.id,
			title: s.fields.title || '',
			creators: s.creators.filter(c => c.creatorType === 'author')
				.map(c => [c.lastName, c.firstName].filter(Boolean).join(', ')).join('; '),
			language: s.fields.language || '',
			suggestedMaster: s.id === master
		}));
	};


	/**
	 * Merge items into one, keeping the other titles as alternate-language titles
	 *
	 * @param {Zotero.Item} master
	 * @param {Zotero.Item[]} others
	 * @param {Object} languages - { itemID: language tag } for the items in `others`
	 * @return {Promise<{ added: Object[], skipped: String[] }>}
	 */
	this.mergeWorks = async function (master, others, languages = {}) {
		if (!others.length) throw new Error("Choose at least two works to merge");
		for (let item of [master, ...others]) {
			if (item.itemType !== 'classic') throw new Error("Only Classic Work items can be merged here");
			if (item.libraryID !== master.libraryID) throw new Error("Works must be in the same library");
			if (item.deleted) throw new Error("A work in the trash can't be merged");
		}
		if (others.some(o => o.id === master.id)) throw new Error("The kept work can't also be merged into itself");

		let result = Zotero.CleanupWorkMerge.mergeTitles(
			{
				title: master.getField('title'),
				language: master.getField('language'),
				extra: master.getField('extra')
			},
			others.map(o => ({
				title: o.getField('title'),
				language: languages[o.id] !== undefined ? languages[o.id] : o.getField('language')
			}))
		);
		if (result.extra !== master.getField('extra')) {
			master.setField('extra', result.extra);
			await master.saveTx();
		}
		await Zotero.Items.merge(master, others);
		return { added: result.added, skipped: result.skipped };
	};


	//
	// Windows
	//

	/**
	 * @param {Object} [request]
	 * @param {String} [request.mode] - 'steps' (default) or 'merge'
	 * @param {Zotero.Item[]} [request.items] - for 'merge': the works to merge
	 * @param {Number} [request.libraryID]
	 */
	this.openDialog = function (request = {}) {
		let existing = Services.wm.getMostRecentWindow(WINDOW_TYPE);
		if (existing) {
			existing.focus();
			return existing;
		}
		_pending = request;
		return Services.ww.openWindow(request.parentWindow || null, WINDOW_URL, '_blank', WINDOW_FEATURES, null);
	};


	this.openMergeDialog = function (parentWindow) {
		let pane = Zotero.getActiveZoteroPane();
		let items = pane ? pane.getSelectedItems() : [];
		return this.openDialog({ mode: 'merge', items, parentWindow });
	};


	this.takePending = function () {
		let request = _pending;
		_pending = null;
		return request;
	};


	this.init = function () {
		this.registerStep({
			id: Zotero.CleanupCriticalEditions.STEP_ID,
			l10nID: 'cleanup-step-critical-editions',
			descriptionL10nID: 'cleanup-step-critical-editions-description',
			scan: libraryID => this.scanCriticalEditions(libraryID),
			apply: (scan, selection) => this.applyCriticalEditions(scan, selection)
		});
	};
}();

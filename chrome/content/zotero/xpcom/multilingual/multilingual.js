"use strict";

/**
 * Per-field language support (the data side)
 *
 * Any text field and any creator can have a language and variants (the same value in other
 * languages or scripts). The tables are the same shape as Juris-M's, so data imported from a
 * Jurism library keeps its meaning:
 *
 *   zlsTags            the languages offered in menus (tag, nickname)
 *   itemDataMain       the language of a field's main value        (itemID, fieldID, languageTag)
 *   itemDataAlt        a variant of a field                        (itemID, fieldID, languageTag, valueID)
 *   itemCreatorsMain   the language of a creator's main name       (itemID, creatorID, creatorTypeID, orderIndex, languageTag)
 *   itemCreatorsAlt    a variant of a creator's name               (itemID, creatorID, creatorTypeID, orderIndex, languageTag)
 *
 * They are created here, when Typos starts, and are not part of Zotero's own schema, so the
 * schema version Zotero checks is unchanged. Zotero's cleanup of unused values and creators is
 * adjusted to leave the rows these tables use.
 *
 * Everything is kept in memory as well (the tables hold only what has a language or variant), because
 * the citation code that reads it is synchronous.
 */
Zotero.Multilingual = new function () {
	const PREF_CITATION = 'multilingual.citation';
	const SCHEMA_VERSION = 1;

	// Fields that don't get languages: dates, identifiers, numbers, and Extra
	const EXCLUDED_FIELDS = new Set([
		'extra', 'url', 'DOI', 'ISBN', 'ISSN', 'PMID', 'PMCID', 'language', 'citationKey',
		'accessDate', 'dateAdded', 'dateModified', 'itemType', 'volume', 'issue', 'pages',
		'numPages', 'numberOfVolumes', 'seriesNumber', 'number', 'filingDate', 'archiveLocation'
	]);

	const TABLES = [
		`CREATE TABLE IF NOT EXISTS zlsTags (
			tag TEXT PRIMARY KEY,
			nickname TEXT,
			parent TEXT
		)`,
		`CREATE TABLE IF NOT EXISTS itemDataMain (
			itemID INTEGER,
			fieldID INTEGER,
			languageTag TEXT,
			PRIMARY KEY (itemID, fieldID),
			FOREIGN KEY (itemID) REFERENCES items(itemID) ON DELETE CASCADE,
			FOREIGN KEY (fieldID) REFERENCES fields(fieldID)
		)`,
		`CREATE TABLE IF NOT EXISTS itemDataAlt (
			itemID INTEGER,
			fieldID INTEGER,
			languageTag TEXT,
			valueID INTEGER,
			PRIMARY KEY (itemID, fieldID, languageTag),
			FOREIGN KEY (itemID) REFERENCES items(itemID) ON DELETE CASCADE,
			FOREIGN KEY (fieldID) REFERENCES fields(fieldID),
			FOREIGN KEY (valueID) REFERENCES itemDataValues(valueID)
		)`,
		`CREATE TABLE IF NOT EXISTS itemCreatorsMain (
			itemID INT,
			creatorID INT,
			creatorTypeID INT DEFAULT 1,
			orderIndex INT DEFAULT 0,
			languageTag TEXT,
			PRIMARY KEY (itemID, creatorID, creatorTypeID, orderIndex),
			FOREIGN KEY (itemID) REFERENCES items(itemID) ON DELETE CASCADE,
			FOREIGN KEY (creatorID) REFERENCES creators(creatorID) ON DELETE CASCADE
		)`,
		`CREATE TABLE IF NOT EXISTS itemCreatorsAlt (
			itemID INT,
			creatorID INT,
			creatorTypeID INT DEFAULT 1,
			orderIndex INT DEFAULT 0,
			languageTag TEXT,
			PRIMARY KEY (itemID, creatorTypeID, orderIndex, languageTag),
			FOREIGN KEY (itemID) REFERENCES items(itemID) ON DELETE CASCADE,
			FOREIGN KEY (creatorID) REFERENCES creators(creatorID) ON DELETE CASCADE,
			FOREIGN KEY (creatorTypeID) REFERENCES creatorTypes(creatorTypeID)
		)`,
		"CREATE INDEX IF NOT EXISTS zlsTags_nickname ON zlsTags(nickname)",
		"CREATE INDEX IF NOT EXISTS itemDataMain_fieldID ON itemDataMain(fieldID)",
		"CREATE INDEX IF NOT EXISTS itemDataAlt_fieldID ON itemDataAlt(fieldID)",
		"CREATE INDEX IF NOT EXISTS itemDataAlt_itemID_fieldID ON itemDataAlt(itemID, fieldID)",
		"CREATE INDEX IF NOT EXISTS itemCreatorsMain_creatorTypeID ON itemCreatorsMain(creatorTypeID)",
		"CREATE INDEX IF NOT EXISTS itemCreatorsMain_itemID_orderIndex ON itemCreatorsMain(itemID, orderIndex)",
		"CREATE INDEX IF NOT EXISTS itemCreatorsAlt_creatorTypeID ON itemCreatorsAlt(creatorTypeID)",
		"CREATE INDEX IF NOT EXISTS itemCreatorsAlt_itemID_orderIndex ON itemCreatorsAlt(itemID, orderIndex)"
	];

	let _ready = false;
	let _tags = [];                 // [{ tag, nickname }]
	let _fieldMain = new Map();     // itemID -> Map(fieldID -> tag)
	let _fieldAlt = new Map();      // itemID -> Map(fieldID -> Map(tag -> value))
	let _creatorMain = new Map();   // itemID -> Map(orderIndex -> tag)
	let _creatorAlt = new Map();    // itemID -> Map(orderIndex -> Map(tag -> { firstName, lastName, fieldMode }))
	let _settings = null;
	let _textSourcesCache = new Map(); // itemTypeID -> [{ variable, fieldID }]
	let _observerID = null;
	let _readyResolve;
	let _readyPromise = new Promise(resolve => _readyResolve = resolve);


	function _core() {
		return Zotero.MultilingualCore;
	}


	//
	// Setup
	//

	this.init = async function () {
		try {
			await this._init();
		}
		catch (e) {
			// Languages are optional: a failure here must not stop Typos or its cleanup of unused data
			Zotero.logError(e);
			_readyResolve(false);
		}
	};


	this._init = async function () {
		for (let sql of TABLES) {
			await Zotero.DB.queryAsync(sql);
		}
		let version = await Zotero.DB.valueQueryAsync(
			"SELECT value FROM settings WHERE setting='typos' AND key='multilingualSchema'"
		);
		if (!version) {
			await Zotero.DB.queryAsync(
				"REPLACE INTO settings (setting, key, value) VALUES ('typos', 'multilingualSchema', ?)",
				[SCHEMA_VERSION]
			);
		}
		if (!(await Zotero.DB.valueQueryAsync("SELECT COUNT(*) FROM zlsTags"))) {
			await Zotero.DB.executeTransaction(async () => {
				for (let [tag, nickname] of _core().DEFAULT_TAGS) {
					await Zotero.DB.queryAsync(
						"INSERT OR IGNORE INTO zlsTags (tag, nickname) VALUES (?, ?)", [tag, nickname]
					);
				}
			});
		}
		await this._loadAll();
		if (_observerID === null && Zotero.Notifier) {
			_observerID = Zotero.Notifier.registerObserver(this, ['item'], 'multilingual');
		}
		_ready = true;
		_readyResolve(true);
	};


	/**
	 * Resolves once the tables exist (or false if setup failed), so cleanup code can rely on them
	 */
	this.waitReady = function () {
		return _readyPromise;
	};


	this.isReady = () => _ready;


	this._loadAll = async function () {
		_tags = (await Zotero.DB.queryAsync("SELECT tag, nickname FROM zlsTags ORDER BY tag"))
			.map(r => ({ tag: r.tag, nickname: r.nickname || '' }));
		_fieldMain = new Map();
		_fieldAlt = new Map();
		_creatorMain = new Map();
		_creatorAlt = new Map();
		let nested = (map, a) => {
			if (!map.has(a)) map.set(a, new Map());
			return map.get(a);
		};
		for (let r of await Zotero.DB.queryAsync("SELECT itemID, fieldID, languageTag FROM itemDataMain")) {
			nested(_fieldMain, r.itemID).set(r.fieldID, r.languageTag);
		}
		for (let r of await Zotero.DB.queryAsync(
			"SELECT itemID, fieldID, languageTag, value FROM itemDataAlt JOIN itemDataValues USING (valueID)"
		)) {
			nested(nested(_fieldAlt, r.itemID), r.fieldID).set(r.languageTag, r.value);
		}
		for (let r of await Zotero.DB.queryAsync("SELECT itemID, orderIndex, languageTag FROM itemCreatorsMain")) {
			nested(_creatorMain, r.itemID).set(r.orderIndex, r.languageTag);
		}
		for (let r of await Zotero.DB.queryAsync(
			"SELECT itemID, orderIndex, languageTag, firstName, lastName, fieldMode "
			+ "FROM itemCreatorsAlt JOIN creators USING (creatorID)"
		)) {
			nested(nested(_creatorAlt, r.itemID), r.orderIndex).set(r.languageTag, {
				firstName: r.firstName, lastName: r.lastName, fieldMode: r.fieldMode
			});
		}
	};


	/** Drop what's cached for deleted items (the rows go with the item) */
	this.notify = function (event, type, ids) {
		if (type !== 'item' || event !== 'delete') return;
		for (let id of ids) {
			_fieldMain.delete(id);
			_fieldAlt.delete(id);
			_creatorMain.delete(id);
			_creatorAlt.delete(id);
		}
	};


	//
	// Languages
	//

	this.getLanguageTags = function () {
		return _tags.slice();
	};


	this.addLanguageTag = async function (value, nickname = '') {
		let tag = _core().normalizeTag(value);
		if (!tag) throw new Error(`"${value}" isn't a language tag`);
		if (_tags.some(t => t.tag === tag)) return tag;
		await Zotero.DB.queryAsync(
			"INSERT OR IGNORE INTO zlsTags (tag, nickname) VALUES (?, ?)", [tag, nickname]
		);
		_tags.push({ tag, nickname });
		_tags.sort((a, b) => a.tag.localeCompare(b.tag));
		return tag;
	};


	//
	// Which fields can have languages
	//

	/**
	 * @return {Number|null} - the field ID, if the field can have a language and variants
	 */
	this.getSupportedFieldID = function (item, fieldName) {
		if (!item || !item.isRegularItem || !item.isRegularItem()) return null;
		if (EXCLUDED_FIELDS.has(fieldName)) return null;
		let fieldID = Zotero.ItemFields.getID(fieldName);
		if (!fieldID || !Zotero.ItemFields.isValidForType(fieldID, item.itemTypeID)) return null;
		if (Zotero.ItemFields.isDate(fieldName)) return null;
		return fieldID;
	};


	this.isSupportedField = function (item, fieldName) {
		return !!this.getSupportedFieldID(item, fieldName);
	};


	function _requireField(item, fieldName) {
		let fieldID = Zotero.Multilingual.getSupportedFieldID(item, fieldName);
		if (!fieldID) throw new Error(`The field '${fieldName}' can't have a language`);
		return fieldID;
	}


	async function _touch(item) {
		await Zotero.DB.queryAsync(
			"UPDATE items SET clientDateModified=CURRENT_TIMESTAMP WHERE itemID=?", [item.id]
		);
		Zotero.Notifier.queue('modify', 'item', item.id, { multilingual: true });
	}


	//
	// Field languages and variants
	//

	/** @return {String|null} */
	this.getFieldLanguage = function (item, fieldName) {
		let fieldID = Zotero.ItemFields.getID(fieldName);
		return _fieldMain.get(item.id)?.get(fieldID) || null;
	};


	this.setFieldLanguage = async function (item, fieldName, language) {
		let fieldID = _requireField(item, fieldName);
		let tag = language ? _core().normalizeTag(language) : null;
		if (language && !tag) throw new Error(`"${language}" isn't a language tag`);
		if (tag) await this.addLanguageTag(tag);
		await Zotero.DB.executeTransaction(async () => {
			if (tag) {
				await Zotero.DB.queryAsync(
					"REPLACE INTO itemDataMain (itemID, fieldID, languageTag) VALUES (?, ?, ?)",
					[item.id, fieldID, tag]
				);
			}
			else {
				await Zotero.DB.queryAsync(
					"DELETE FROM itemDataMain WHERE itemID=? AND fieldID=?", [item.id, fieldID]
				);
			}
			await _touch(item);
		});
		let map = _fieldMain.get(item.id) || new Map();
		if (tag) map.set(fieldID, tag);
		else map.delete(fieldID);
		map.size ? _fieldMain.set(item.id, map) : _fieldMain.delete(item.id);
	};


	/** @return {Object} - { tag: value } */
	this.getVariants = function (item, fieldName) {
		let fieldID = Zotero.ItemFields.getID(fieldName);
		let map = _fieldAlt.get(item.id)?.get(fieldID);
		return map ? Object.fromEntries(map) : {};
	};


	/**
	 * Set, change or (with an empty value) remove a variant
	 */
	this.setVariant = async function (item, fieldName, language, value) {
		let fieldID = _requireField(item, fieldName);
		let tag = _core().normalizeTag(language);
		if (!tag) throw new Error(`"${language}" isn't a language tag`);
		value = String(value === undefined || value === null ? '' : value).trim();
		await this.addLanguageTag(tag);
		await Zotero.DB.executeTransaction(async () => {
			if (value) {
				let valueID = await Zotero.DB.valueQueryAsync(
					"SELECT valueID FROM itemDataValues WHERE value=?", [value]
				);
				if (!valueID) {
					valueID = Zotero.ID.get('itemDataValues');
					await Zotero.DB.queryAsync(
						"INSERT INTO itemDataValues (valueID, value, valueNormalized) VALUES (?,?,?)",
						[valueID, value, Zotero.Utilities.Internal.normalizeForSearchStorage(value)]
					);
				}
				await Zotero.DB.queryAsync(
					"REPLACE INTO itemDataAlt (itemID, fieldID, languageTag, valueID) VALUES (?,?,?,?)",
					[item.id, fieldID, tag, valueID]
				);
			}
			else {
				await Zotero.DB.queryAsync(
					"DELETE FROM itemDataAlt WHERE itemID=? AND fieldID=? AND languageTag=?",
					[item.id, fieldID, tag]
				);
			}
			await _touch(item);
		});
		let byField = _fieldAlt.get(item.id) || new Map();
		let variants = byField.get(fieldID) || new Map();
		if (value) variants.set(tag, value);
		else variants.delete(tag);
		variants.size ? byField.set(fieldID, variants) : byField.delete(fieldID);
		byField.size ? _fieldAlt.set(item.id, byField) : _fieldAlt.delete(item.id);
	};


	//
	// Creators (by position in the item's creator list)
	//

	this.getCreatorLanguage = function (item, index) {
		return _creatorMain.get(item.id)?.get(index) || null;
	};


	this.setCreatorLanguage = async function (item, index, language) {
		let creator = item.getCreator(index);
		if (!creator) throw new Error(`The item has no creator ${index}`);
		let tag = language ? _core().normalizeTag(language) : null;
		if (language && !tag) throw new Error(`"${language}" isn't a language tag`);
		if (tag) await this.addLanguageTag(tag);
		await Zotero.DB.executeTransaction(async () => {
			await Zotero.DB.queryAsync(
				"DELETE FROM itemCreatorsMain WHERE itemID=? AND orderIndex=?", [item.id, index]
			);
			if (tag) {
				let creatorID = await Zotero.Creators.getIDFromData(creator, true);
				await Zotero.DB.queryAsync(
					"INSERT INTO itemCreatorsMain (itemID, creatorID, creatorTypeID, orderIndex, languageTag) "
					+ "VALUES (?,?,?,?,?)",
					[item.id, creatorID, creator.creatorTypeID, index, tag]
				);
			}
			await _touch(item);
		});
		let map = _creatorMain.get(item.id) || new Map();
		if (tag) map.set(index, tag);
		else map.delete(index);
		map.size ? _creatorMain.set(item.id, map) : _creatorMain.delete(item.id);
	};


	/** @return {Object} - { tag: { firstName, lastName, fieldMode } } */
	this.getCreatorVariants = function (item, index) {
		let map = _creatorAlt.get(item.id)?.get(index);
		return map ? Object.fromEntries(map) : {};
	};


	/**
	 * @param {Object|null} name - { firstName, lastName, fieldMode }, or null to remove
	 */
	this.setCreatorVariant = async function (item, index, language, name) {
		let creator = item.getCreator(index);
		if (!creator) throw new Error(`The item has no creator ${index}`);
		let tag = _core().normalizeTag(language);
		if (!tag) throw new Error(`"${language}" isn't a language tag`);
		await this.addLanguageTag(tag);
		let clean = null;
		if (name && (name.lastName || name.firstName)) {
			clean = Zotero.Creators.cleanData({
				firstName: name.fieldMode === 1 ? '' : name.firstName || '',
				lastName: name.lastName || '',
				fieldMode: name.fieldMode === 1 ? 1 : 0
			});
		}
		await Zotero.DB.executeTransaction(async () => {
			await Zotero.DB.queryAsync(
				"DELETE FROM itemCreatorsAlt WHERE itemID=? AND orderIndex=? AND languageTag=?",
				[item.id, index, tag]
			);
			if (clean) {
				let creatorID = await Zotero.Creators.getIDFromData(clean, true);
				await Zotero.DB.queryAsync(
					"INSERT INTO itemCreatorsAlt (itemID, creatorID, creatorTypeID, orderIndex, languageTag) "
					+ "VALUES (?,?,?,?,?)",
					[item.id, creatorID, creator.creatorTypeID, index, tag]
				);
			}
			await _touch(item);
		});
		let byIndex = _creatorAlt.get(item.id) || new Map();
		let variants = byIndex.get(index) || new Map();
		if (clean) {
			variants.set(tag, { firstName: clean.firstName, lastName: clean.lastName, fieldMode: clean.fieldMode });
		}
		else {
			variants.delete(tag);
		}
		variants.size ? byIndex.set(index, variants) : byIndex.delete(index);
		byIndex.size ? _creatorAlt.set(item.id, byIndex) : _creatorAlt.delete(item.id);
	};


	/**
	 * Keep creator languages and variants with their creators when the creator list changes
	 *
	 * @param {Zotero.Item} item
	 * @param {Function} mapIndex - (oldIndex) => new index, or null if the creator was removed
	 */
	this.remapCreators = async function (item, mapIndex) {
		let main = _creatorMain.get(item.id);
		let alt = _creatorAlt.get(item.id);
		if (!main && !alt) return;
		await Zotero.DB.executeTransaction(async () => {
			let indexes = new Set([...(main ? main.keys() : []), ...(alt ? alt.keys() : [])]);
			// Move through a temporary range so two rows never collide
			for (let table of ['itemCreatorsMain', 'itemCreatorsAlt']) {
				await Zotero.DB.queryAsync(
					`UPDATE ${table} SET orderIndex=orderIndex+100000 WHERE itemID=?`, [item.id]
				);
			}
			for (let oldIndex of indexes) {
				let newIndex = mapIndex(oldIndex);
				for (let table of ['itemCreatorsMain', 'itemCreatorsAlt']) {
					if (newIndex === null || newIndex === undefined) {
						await Zotero.DB.queryAsync(
							`DELETE FROM ${table} WHERE itemID=? AND orderIndex=?`, [item.id, oldIndex + 100000]
						);
					}
					else {
						await Zotero.DB.queryAsync(
							`UPDATE ${table} SET orderIndex=? WHERE itemID=? AND orderIndex=?`,
							[newIndex, item.id, oldIndex + 100000]
						);
					}
				}
			}
		});
		let remap = (map) => {
			if (!map) return map;
			let out = new Map();
			for (let [oldIndex, value] of map) {
				let newIndex = mapIndex(oldIndex);
				if (newIndex !== null && newIndex !== undefined) out.set(newIndex, value);
			}
			return out;
		};
		if (main) _creatorMain.set(item.id, remap(main));
		if (alt) _creatorAlt.set(item.id, remap(alt));
	};


	//
	// Whole-item views
	//

	this.hasData = function (item) {
		return _fieldMain.has(item.id) || _fieldAlt.has(item.id)
			|| _creatorMain.has(item.id) || _creatorAlt.has(item.id);
	};


	/**
	 * A plain description of an item's languages and variants, for display and export
	 *
	 * @return {{ fields: Object, creators: Object[] }}
	 */
	this.getItemData = function (item) {
		let fields = {};
		let names = new Set();
		for (let id of [...(_fieldMain.get(item.id)?.keys() || []), ...(_fieldAlt.get(item.id)?.keys() || [])]) {
			names.add(Zotero.ItemFields.getName(id));
		}
		for (let name of names) {
			fields[name] = {
				language: this.getFieldLanguage(item, name),
				variants: this.getVariants(item, name)
			};
		}
		let creators = [];
		let indexes = new Set([...(_creatorMain.get(item.id)?.keys() || []), ...(_creatorAlt.get(item.id)?.keys() || [])]);
		for (let index of [...indexes].sort((a, b) => a - b)) {
			creators.push({
				index,
				language: this.getCreatorLanguage(item, index),
				variants: this.getCreatorVariants(item, index)
			});
		}
		return { fields, creators };
	};


	//
	// Settings for citations
	//

	this.getSettings = function () {
		if (_settings) return _settings;
		let raw = null;
		try {
			let text = Zotero.Prefs.get(PREF_CITATION);
			raw = text ? JSON.parse(text) : null;
		}
		catch (e) {
			Zotero.logError(e);
		}
		_settings = _core().normalizeSettings(raw);
		return _settings;
	};


	this.setSettings = function (settings) {
		_settings = _core().normalizeSettings(settings);
		Zotero.Prefs.set(PREF_CITATION, JSON.stringify(_settings));
		return _settings;
	};


	//
	// Citations
	//

	/**
	 * For each CSL text variable, the item field its value came from
	 */
	function _textSources(item) {
		let cached = _textSourcesCache.get(item.itemTypeID);
		if (cached) return cached;
		let sources = [];
		let eventPlaceTypes = ['audioRecording', 'presentation', 'videoRecording'];
		let typeName = Zotero.ItemTypes.getName(item.itemTypeID);
		for (let [variable, fields] of Object.entries(Zotero.Schema.CSL_TEXT_MAPPINGS)) {
			if (variable === 'shortTitle') continue;
			if (eventPlaceTypes.includes(typeName)) {
				if (variable === 'event-place') fields = ['place'];
				else if (variable === 'publisher-place') continue;
			}
			for (let field of fields) {
				let fieldID = Zotero.ItemFields.getID(field);
				if (!fieldID) continue;
				let typeFieldID = Zotero.ItemFields.isValidForType(fieldID, item.itemTypeID)
					? fieldID
					: Zotero.ItemFields.getFieldIDFromTypeAndBase(item.itemTypeID, fieldID);
				if (typeFieldID) {
					sources.push({ variable, field: Zotero.ItemFields.getName(typeFieldID) });
				}
			}
		}
		_textSourcesCache.set(item.itemTypeID, sources);
		return sources;
	}


	/**
	 * Replace titles, names and other values in a CSL item with the variants the settings ask for
	 *
	 * Called from Zotero.Cite.System.retrieveItem(), so it must stay synchronous.
	 *
	 * @return {Boolean}
	 */
	this.applyToCSLItem = function (zoteroItem, cslItem) {
		if (!_ready || !this.hasData(zoteroItem)) return false;
		let settings = this.getSettings();
		let core = _core();
		let changed = false;

		if (settings.titles.mode !== 'orig' || settings.publishers.mode !== 'orig' || settings.other.mode !== 'orig') {
			// Only fields that have variants matter, and only the first field for a variable counts
			let seen = new Set();
			let sources = _textSources(zoteroItem).filter((s) => {
				if (seen.has(s.variable)) return false;
				if (typeof cslItem[s.variable] !== 'string') return false;
				// The field that supplied the value is the first one with a value
				if (!zoteroItem.getField(s.field)) return false;
				seen.add(s.variable);
				return true;
			});
			changed = core.substituteText(
				cslItem, sources, field => this.getVariants(zoteroItem, field), settings
			) || changed;
		}

		if (settings.creators.mode !== 'orig' && _creatorAlt.has(zoteroItem.id)) {
			let primary = Zotero.CreatorTypes.getName(
				Zotero.CreatorTypes.getPrimaryIDForType(zoteroItem.itemTypeID)
			);
			let counts = {};
			let entries = [];
			zoteroItem.getCreators().forEach((creator, index) => {
				let typeName = Zotero.CreatorTypes.getName(creator.creatorTypeID);
				let cslType = Zotero.Schema.CSL_NAME_MAPPINGS[typeName]
					|| (typeName === primary ? 'author' : null);
				if (!cslType) return;
				let position = counts[cslType] = (counts[cslType] ?? -1) + 1;
				let variants = this.getCreatorVariants(zoteroItem, index);
				if (Object.keys(variants).length) entries.push({ cslType, position, variants });
			});
			changed = core.substituteNames(cslItem, entries, settings) || changed;
		}
		return changed;
	};
}();

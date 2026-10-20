"use strict";

/**
 * Storage, import, profiles and citation-pipeline integration for abbreviation lists
 *
 * Parsing, matching and the CSL transformation are in abbreviationIndex.js; profile logic
 * (which settings apply to a document or style) is in abbreviationProfiles.js. This module keeps
 * imported lists as JSON files in <data directory>/abbreviations/ (so they're covered by backups
 * and travel with the library), stores profiles in preferences, and applies abbreviations to
 * items as they're handed to the citation engine.
 *
 * The name is historical: lists started as classical works and authors, and now also cover
 * journals, series, publishers and places.
 *
 * Settings
 * --------
 * The global settings in Preferences are the 'default' profile (extensions.zotero.
 * classicalAbbreviations.*):
 *   mode                'off' | 'abbreviated' | 'short-title'
 *   active              Comma-separated list IDs, highest priority first
 *   scope               'classic' (work and author abbreviations only for Classic Work items)
 *                       | 'all' (every item). Journals, series, etc. always apply to every item.
 *   abbreviateWorks / abbreviateAuthors / abbreviateJournals / abbreviateSeries /
 *   abbreviatePublishers / abbreviatePlaces    Which kinds of entry to apply
 *   preferItemAbbreviations   An item's own Journal Abbr wins over a list
 * User-created profiles (JSON array) are in `profiles`; style -> profile assignments (JSON object)
 * are in `styleProfiles`. Documents store their choice in their own document preferences.
 *
 * The application's built-in journal abbreviation table is available as a list with ID
 * 'zotero-journals', so profiles can include or leave out it like any imported list.
 */
Zotero.ClassicalAbbreviations = new function () {
	const DIR_NAME = 'abbreviations';
	const PREF_PREFIX = 'classicalAbbreviations.';
	const BUILTIN_JOURNALS_ID = 'zotero-journals';
	const TYPE_PREFS = {
		work: 'abbreviateWorks',
		author: 'abbreviateAuthors',
		journal: 'abbreviateJournals',
		series: 'abbreviateSeries',
		publisher: 'abbreviatePublishers',
		place: 'abbreviatePlaces'
	};
	const TYPE_DEFAULTS = {
		work: true, author: true, journal: true, series: true, publisher: false, place: false
	};

	var _lists = new Map(); // id -> list
	var _versions = new Map(); // id -> number, bumped when a list changes
	var _indexes = new Map(); // profile signature -> AbbreviationIndex
	var _initialized = false;
	var _observerIDs = [];

	Zotero.defineProperty(this, 'dir', {
		get: () => PathUtils.join(Zotero.DataDirectory.dir, DIR_NAME)
	});

	Zotero.defineProperty(this, 'BUILTIN_JOURNALS_ID', { get: () => BUILTIN_JOURNALS_ID });


	this.init = async function () {
		if (_initialized) return;
		_lists.clear();

		let dir = this.dir;
		if (await IOUtils.exists(dir)) {
			let children = await IOUtils.getChildren(dir);
			for (let path of children) {
				if (!path.endsWith('.json')) continue;
				try {
					let text = await IOUtils.readUTF8(path);
					let { list } = Zotero.AbbreviationIndex.validateList(JSON.parse(text));
					_lists.set(list.id, list);
				}
				catch (e) {
					// Don't let one bad file take down the rest
					Zotero.logError("Unable to load abbreviation list " + path + ": " + e);
				}
			}
		}

		this._invalidateIndexes();
		_initialized = true;
	};


	this.uninit = function () {
		for (let id of _observerIDs) {
			Zotero.Prefs.unregisterObserver(id);
		}
		_observerIDs = [];
		_initialized = false;
	};


	this._invalidateIndexes = function (changedListID) {
		_indexes.clear();
		if (changedListID) {
			_versions.set(changedListID, (_versions.get(changedListID) || 0) + 1);
		}
	};


	//
	// Built-in journal table
	//

	/**
	 * The built-in journal table (and the user's own abbreviations.json in the data directory,
	 * if there is one), exposed as a list whose entries are looked up on demand
	 */
	function _builtinJournalsList() {
		return {
			id: BUILTIN_JOURNALS_ID,
			entries: [],
			provider: {
				journal: (full) => {
					try {
						let obj = {};
						Zotero.Cite.getAbbreviation('', obj, 'default', 'container-title', full);
						let abbreviation = obj.default?.['container-title']?.[full];
						// The function returns the input unchanged when it has no abbreviation
						return abbreviation && abbreviation !== full ? abbreviation : null;
					}
					catch (e) {
						Zotero.logError(e);
						return null;
					}
				}
			}
		};
	}


	//
	// Global ("default" profile) settings
	//

	this.getMode = function () {
		let mode = Zotero.Prefs.get(PREF_PREFIX + 'mode');
		return Zotero.AbbreviationIndex.MODES.includes(mode) ? mode : 'off';
	};

	this.setMode = function (mode) {
		if (!Zotero.AbbreviationIndex.MODES.includes(mode)) {
			throw new Error("Unknown abbreviation mode '" + mode + "'");
		}
		Zotero.Prefs.set(PREF_PREFIX + 'mode', mode);
	};

	this.getActiveIDs = function () {
		return (Zotero.Prefs.get(PREF_PREFIX + 'active') || '')
			.split(',')
			.map(id => id.trim())
			.filter(Boolean);
	};

	this.setActiveIDs = function (ids) {
		Zotero.Prefs.set(PREF_PREFIX + 'active', ids.join(','));
	};

	/**
	 * @return {String[]} - Entry types the global settings turn on
	 */
	this.getEnabledTypes = function () {
		return Object.entries(TYPE_PREFS)
			.filter(([type, pref]) => {
				let value = Zotero.Prefs.get(PREF_PREFIX + pref);
				return value === undefined || value === null ? TYPE_DEFAULTS[type] : !!value;
			})
			.map(([type]) => type);
	};

	/**
	 * The global settings as a profile
	 */
	this.getDefaultProfile = function () {
		return {
			id: Zotero.AbbreviationProfiles.DEFAULT_ID,
			name: 'Default',
			mode: this.getMode(),
			active: this.getActiveIDs(),
			types: this.getEnabledTypes(),
			scope: Zotero.Prefs.get(PREF_PREFIX + 'scope') === 'all' ? 'all' : 'classic',
			preferItemAbbreviations: Zotero.Prefs.get(PREF_PREFIX + 'preferItemAbbreviations') !== false
		};
	};

	// Compatibility with code written against the single-profile version
	this.getOptions = function () {
		let profile = this.getDefaultProfile();
		return {
			mode: profile.mode,
			scope: profile.scope,
			abbreviateWorks: profile.types.includes('work'),
			abbreviateAuthors: profile.types.includes('author')
		};
	};


	//
	// Profiles
	//

	/**
	 * @return {Object[]} - User-created profiles
	 */
	this.getProfiles = function () {
		let { profiles, warnings } = Zotero.AbbreviationProfiles.parseProfiles(
			Zotero.Prefs.get(PREF_PREFIX + 'profiles')
		);
		for (let warning of warnings) Zotero.debug("Abbreviation profiles: " + warning, 2);
		return profiles;
	};

	/**
	 * Create or update a profile
	 *
	 * @param {Object} profile - Without an `id` (or with an unknown one), a new profile is made
	 * @return {Object} - The saved profile
	 */
	this.saveProfile = function (profile) {
		let AP = Zotero.AbbreviationProfiles;
		let profiles = this.getProfiles();
		let existing = profile.id && profiles.some(p => p.id === profile.id);
		let id = existing ? profile.id : AP.uniqueProfileID(profile.name, profiles.map(p => p.id));
		let saved = AP.normalizeProfile({ ...profile, id });
		let next = existing
			? profiles.map(p => (p.id === id ? saved : p))
			: profiles.concat(saved);
		Zotero.Prefs.set(PREF_PREFIX + 'profiles', AP.serializeProfiles(next));
		this._invalidateIndexes();
		return saved;
	};

	this.removeProfile = function (id) {
		let AP = Zotero.AbbreviationProfiles;
		let profiles = this.getProfiles();
		if (!profiles.some(p => p.id === id)) return false;
		Zotero.Prefs.set(
			PREF_PREFIX + 'profiles',
			AP.serializeProfiles(profiles.filter(p => p.id !== id))
		);
		this._setAssignments(AP.removeProfileFromAssignments(this.getAssignments(), id));
		this._invalidateIndexes();
		return true;
	};

	/**
	 * @return {Object} - { styleID: profileID }
	 */
	this.getAssignments = function () {
		return Zotero.AbbreviationProfiles.parseAssignments(Zotero.Prefs.get(PREF_PREFIX + 'styleProfiles'));
	};

	this._setAssignments = function (assignments) {
		Zotero.Prefs.set(PREF_PREFIX + 'styleProfiles', JSON.stringify(assignments));
	};

	/**
	 * Choose the profile a citation style uses
	 *
	 * @param {String} styleID
	 * @param {String|null} profileID - A profile ID, 'default', 'off', or null to clear
	 */
	this.setAssignment = function (styleID, profileID) {
		let assignments = this.getAssignments();
		if (profileID) {
			assignments[styleID] = profileID;
		}
		else {
			delete assignments[styleID];
		}
		this._setAssignments(assignments);
		this._invalidateIndexes();
	};

	/**
	 * Decide which profile applies and prepare it for use
	 *
	 * @param {Object} [options]
	 * @param {String} [options.styleID]
	 * @param {String} [options.documentProfileID] - The document's choice; '' or omitted for none
	 * @return {{ profile: Object, source: String, signature: String }} - `signature` changes
	 *     whenever anything affecting output does, and is suitable in a cache key
	 */
	this.resolve = function ({ styleID, documentProfileID } = {}) {
		let AP = Zotero.AbbreviationProfiles;
		let { profile, source } = AP.resolveProfile({
			documentProfileID,
			styleID,
			assignments: this.getAssignments(),
			profiles: this.getProfiles(),
			defaultProfile: this.getDefaultProfile()
		});
		let versions = Object.fromEntries(_versions);
		return { profile, source, signature: AP.profileSignature(profile, versions) };
	};


	/**
	 * Index over a profile's active lists, cached by signature
	 */
	this._indexFor = function (resolved) {
		let index = _indexes.get(resolved.signature);
		if (index) return index;
		let lists = resolved.profile.active
			.map(id => (id === BUILTIN_JOURNALS_ID ? _builtinJournalsList() : _lists.get(id)))
			.filter(Boolean);
		index = new Zotero.AbbreviationIndex.AbbreviationIndex(lists);
		_indexes.set(resolved.signature, index);
		return index;
	};


	//
	// Lists
	//

	/**
	 * @return {{ id, name, description, source, count, active, builtin }[]} - Imported lists only
	 */
	this.getLists = function () {
		let active = new Set(this.getActiveIDs());
		return Array.from(_lists.values())
			.map(list => ({
				id: list.id,
				name: list.name,
				description: list.description,
				source: list.source,
				count: list.entries.length,
				active: active.has(list.id),
				builtin: false
			}))
			.sort((a, b) => a.name.localeCompare(b.name));
	};

	/**
	 * Imported lists plus the built-in journal table, for choosing from
	 *
	 * @param {String[]} [activeIDs] - Which IDs to mark active; defaults to the global selection
	 */
	this.getAvailableLists = function (activeIDs) {
		let active = new Set(activeIDs || this.getActiveIDs());
		let builtin = {
			id: BUILTIN_JOURNALS_ID,
			name: 'Zotero journal abbreviations (MEDLINE)',
			description: 'Built in. Journal titles only.',
			source: 'Zotero',
			count: 0,
			active: active.has(BUILTIN_JOURNALS_ID),
			builtin: true
		};
		let lists = this.getLists().map(l => ({ ...l, active: active.has(l.id) }));
		return [builtin, ...lists];
	};


	/**
	 * Import a list from text
	 *
	 * @param {String} text
	 * @param {Object} options
	 * @param {'json'|'csv'} options.format
	 * @param {String} [options.name] - Required for CSV; overrides the name for JSON if given
	 * @param {Boolean} [options.activate=true] - Add the list to the global active lists
	 * @return {Promise<{ list: Object, warnings: String[] }>}
	 */
	this.importText = async function (text, { format, name, activate = true } = {}) {
		let AI = Zotero.AbbreviationIndex;
		let result = format === 'csv' ? AI.parseCSV(text, { name }) : AI.parseJSON(text);
		let list = result.list;
		if (name && format !== 'csv') {
			list.name = name;
		}
		// The ID becomes a file name, so never trust it as is
		list.id = AI.slugify(list.id);
		if (list.id === BUILTIN_JOURNALS_ID) {
			list.id = BUILTIN_JOURNALS_ID + '-imported';
		}

		let replaced = _lists.has(list.id);
		await IOUtils.makeDirectory(this.dir, { createAncestors: true, ignoreExisting: true });
		await IOUtils.writeUTF8(
			PathUtils.join(this.dir, list.id + '.json'),
			JSON.stringify(list, null, '\t') + '\n'
		);
		_lists.set(list.id, list);

		if (activate && !replaced) {
			let ids = this.getActiveIDs();
			if (!ids.includes(list.id)) {
				this.setActiveIDs(ids.concat(list.id));
			}
		}
		this._invalidateIndexes(list.id);
		return result;
	};


	/**
	 * Import a list from a file chosen by the user
	 *
	 * Format comes from the extension: .json, or .csv/.tsv/.txt (delimiter detected). For
	 * delimited files the list is named after the file unless a name is given.
	 */
	this.importFile = async function (path, options = {}) {
		let text = await Zotero.File.getContentsAsync(path, 'UTF-8');
		let fileName = PathUtils.filename(path);
		let ext = (fileName.match(/\.([^.]+)$/) || [])[1]?.toLowerCase();
		let format = ext === 'json' ? 'json' : 'csv';
		let name = options.name || (format === 'csv' ? fileName.replace(/\.[^.]+$/, '') : undefined);
		return this.importText(text, { format, name, activate: options.activate });
	};


	this.remove = async function (id) {
		if (!_lists.has(id)) return false;
		await IOUtils.remove(PathUtils.join(this.dir, id + '.json'), { ignoreAbsent: true });
		_lists.delete(id);
		this.setActiveIDs(this.getActiveIDs().filter(x => x !== id));
		// Drop it from profiles too, so they don't keep a dangling reference
		let profiles = this.getProfiles();
		if (profiles.some(p => p.active.includes(id))) {
			Zotero.Prefs.set(
				PREF_PREFIX + 'profiles',
				Zotero.AbbreviationProfiles.serializeProfiles(
					profiles.map(p => ({ ...p, active: p.active.filter(x => x !== id) }))
				)
			);
		}
		this._invalidateIndexes(id);
		return true;
	};


	//
	// Citation pipeline
	//

	/**
	 * A string that changes whenever the output for the given resolved profile would change, for
	 * use in cache keys
	 *
	 * @param {Object} [resolved] - From resolve(); defaults to the global settings
	 */
	this.getCacheSignature = function (resolved) {
		return (resolved || this.resolve()).signature;
	};

	this.isEnabled = function (resolved) {
		resolved = resolved || this.resolve();
		return resolved.profile.mode !== 'off' && this._indexFor(resolved).size > 0;
	};


	/**
	 * Apply abbreviations to a CSL item that was generated from a Zotero item
	 *
	 * Called synchronously from Zotero.Cite.System.retrieveItem().
	 *
	 * @param {Zotero.Item} zoteroItem
	 * @param {Object} cslItem - Modified in place
	 * @param {Object} [resolved] - From resolve(); defaults to the global settings
	 * @return {Boolean} - Whether anything changed
	 */
	this.applyToCSLItem = function (zoteroItem, cslItem, resolved) {
		resolved = resolved || this.resolve();
		let { profile } = resolved;
		if (profile.mode === 'off') return false;
		let index = this._indexFor(resolved);
		if (!index.size) return false;

		let types = profile.types;
		// Classical works and authors can be limited to Classic Work items; journals, series,
		// publishers and places are about the item's container, so they always apply
		if (profile.scope === 'classic' && Zotero.ItemTypes.getName(zoteroItem.itemTypeID) !== 'classic') {
			types = types.filter(t => t !== 'work' && t !== 'author');
		}
		return Zotero.AbbreviationIndex.applyToCSL(cslItem, index, {
			mode: profile.mode,
			types,
			preferItemAbbreviations: profile.preferItemAbbreviations
		});
	};
};

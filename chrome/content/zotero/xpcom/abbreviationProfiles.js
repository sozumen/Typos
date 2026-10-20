"use strict";

/**
 * Abbreviation profiles: which lists, which output mode and which kinds of entry to use, chosen
 * per document, per citation style, or globally
 *
 * A profile is a named combination, e.g. "Journals abbreviated, classics in full". There are two
 * built-in profile IDs:
 *   'default'  The global settings in Preferences
 *   'off'      No abbreviations at all
 * Everything else is a user-created profile.
 *
 * Which profile applies is decided in this order:
 *   1. The profile chosen for the document (Word / LibreOffice document preferences)
 *   2. The profile assigned to the citation style
 *   3. 'default'
 * A choice that names a profile that no longer exists (a document made on another computer, say)
 * is skipped, so a missing profile never breaks citations.
 *
 * Pure logic with no Zotero dependencies; tested in fork/test/abbreviationProfiles.test.js.
 */
(function (root) {
	const DEFAULT_ID = 'default';
	const OFF_ID = 'off';
	// 'true' and 'false' are reserved because document preferences turn those strings into booleans
	const RESERVED_IDS = ['', DEFAULT_ID, OFF_ID, 'true', 'false'];
	const MODES = ['off', 'abbreviated', 'short-title'];
	const ENTRY_TYPES = ['work', 'author', 'journal', 'series', 'publisher', 'place'];
	const DEFAULT_TYPES = ['work', 'author', 'journal', 'series'];
	const SCOPES = ['classic', 'all'];


	function _slug(str) {
		return String(str ?? '')
			.normalize('NFD')
			.replace(/[̀-ͯ]/g, '')
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, '-')
			.replace(/^-+|-+$/g, '');
	}


	/**
	 * @return {String} - An ID based on the name that isn't reserved or already in use
	 */
	function uniqueProfileID(name, existingIDs = []) {
		let base = _slug(name) || 'profile';
		let taken = new Set([...RESERVED_IDS, ...existingIDs]);
		let id = base;
		for (let n = 2; taken.has(id); n++) {
			id = `${base}-${n}`;
		}
		return id;
	}


	/**
	 * Clean up a profile object, filling in defaults
	 *
	 * @param {Object} raw
	 * @return {Object} - { id, name, mode, active, types, scope, preferItemAbbreviations }
	 * @throws {Error} if there is no usable name or the ID is reserved
	 */
	function normalizeProfile(raw) {
		if (!raw || typeof raw !== 'object') {
			throw new Error("Profile must be an object");
		}
		let name = String(raw.name ?? '').trim();
		if (!name) throw new Error("Profile needs a name");
		let id = String(raw.id ?? '').trim();
		if (RESERVED_IDS.includes(id)) {
			throw new Error(`'${id}' is not a valid profile ID`);
		}
		let seen = new Set();
		let active = (Array.isArray(raw.active) ? raw.active : [])
			.filter(x => typeof x === 'string' && x && !seen.has(x) && seen.add(x));
		let types = Array.isArray(raw.types)
			? [...new Set(raw.types.filter(t => ENTRY_TYPES.includes(t)))]
			: DEFAULT_TYPES.slice();
		return {
			id,
			name,
			mode: MODES.includes(raw.mode) ? raw.mode : 'abbreviated',
			active,
			types,
			scope: SCOPES.includes(raw.scope) ? raw.scope : 'classic',
			preferItemAbbreviations: raw.preferItemAbbreviations !== false
		};
	}


	/**
	 * Parse the stored profile list. Never throws: bad JSON gives no profiles, bad entries are
	 * skipped, and duplicate IDs keep the first.
	 *
	 * @param {String} text
	 * @return {{ profiles: Object[], warnings: String[] }}
	 */
	function parseProfiles(text) {
		let warnings = [];
		if (!text) return { profiles: [], warnings };
		let data;
		try {
			data = JSON.parse(text);
		}
		catch (e) {
			return { profiles: [], warnings: ["Stored abbreviation profiles are not valid JSON"] };
		}
		if (!Array.isArray(data)) {
			return { profiles: [], warnings: ["Stored abbreviation profiles are not a list"] };
		}
		let profiles = [];
		let ids = new Set();
		for (let raw of data) {
			try {
				let profile = normalizeProfile(raw);
				if (ids.has(profile.id)) {
					warnings.push(`Duplicate profile ID '${profile.id}' skipped`);
					continue;
				}
				ids.add(profile.id);
				profiles.push(profile);
			}
			catch (e) {
				warnings.push(`Skipped a profile: ${e.message}`);
			}
		}
		return { profiles, warnings };
	}


	function serializeProfiles(profiles) {
		return JSON.stringify(profiles.map(normalizeProfile));
	}


	/**
	 * Parse the stored { styleID: profileID } map. Never throws.
	 */
	function parseAssignments(text) {
		let out = {};
		if (!text) return out;
		let data;
		try {
			data = JSON.parse(text);
		}
		catch (e) {
			return out;
		}
		if (!data || typeof data !== 'object' || Array.isArray(data)) return out;
		for (let [styleID, profileID] of Object.entries(data)) {
			if (typeof profileID === 'string' && profileID) out[styleID] = profileID;
		}
		return out;
	}


	/** @return {Object} - A copy without any assignments to the given profile */
	function removeProfileFromAssignments(assignments, profileID) {
		return Object.fromEntries(Object.entries(assignments).filter(([, id]) => id !== profileID));
	}


	function _isKnown(id, profiles) {
		return id === DEFAULT_ID || id === OFF_ID || profiles.some(p => p.id === id);
	}


	/**
	 * Decide which profile applies
	 *
	 * @param {Object} options
	 * @param {String} [options.documentProfileID] - '' or undefined means "no choice"
	 * @param {String} [options.styleID]
	 * @param {Object} [options.assignments] - { styleID: profileID }
	 * @param {Object[]} [options.profiles] - User-created profiles
	 * @param {Object} options.defaultProfile - The 'default' profile, built from global settings
	 * @return {{ profile: Object, source: 'document'|'style'|'default' }}
	 */
	function resolveProfile({ documentProfileID, styleID, assignments = {}, profiles = [], defaultProfile }) {
		let pick = (id, source) => {
			if (id === OFF_ID) {
				return {
					profile: {
						id: OFF_ID, name: 'Off', mode: 'off', active: [], types: [],
						scope: 'all', preferItemAbbreviations: true
					},
					source
				};
			}
			if (id === DEFAULT_ID) return { profile: defaultProfile, source };
			return { profile: profiles.find(p => p.id === id), source };
		};

		if (documentProfileID && _isKnown(documentProfileID, profiles)) {
			return pick(documentProfileID, 'document');
		}
		let assigned = styleID ? assignments[styleID] : undefined;
		if (assigned && _isKnown(assigned, profiles)) {
			return pick(assigned, 'style');
		}
		return { profile: defaultProfile, source: 'default' };
	}


	/**
	 * A string that changes whenever anything affecting output changes, for engine cache keys
	 *
	 * @param {Object} profile
	 * @param {Object} [listVersions] - { listID: any }, so editing a list invalidates caches
	 */
	function profileSignature(profile, listVersions = {}) {
		if (!profile || profile.mode === 'off') return 'off';
		return JSON.stringify([
			profile.mode,
			profile.active,
			profile.active.map(id => listVersions[id] ?? 0),
			[...profile.types].sort(),
			profile.scope,
			profile.preferItemAbbreviations
		]);
	}


	const api = {
		DEFAULT_ID,
		OFF_ID,
		RESERVED_IDS,
		uniqueProfileID,
		normalizeProfile,
		parseProfiles,
		serializeProfiles,
		parseAssignments,
		removeProfileFromAssignments,
		resolveProfile,
		profileSignature
	};

	if (typeof module !== 'undefined' && module.exports) {
		module.exports = api;
	}
	else if (root) {
		root.AbbreviationProfiles = api;
	}
})(typeof Zotero !== 'undefined' ? Zotero : null);

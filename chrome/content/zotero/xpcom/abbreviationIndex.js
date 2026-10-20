"use strict";

/**
 * Abbreviation lists for classical works and authors: parsing, validation, lookup, and applying
 * abbreviations to CSL JSON
 *
 * Nothing here touches the file system or the Zotero object model, so it can be tested in plain
 * Node (see fork/test/abbreviationIndex.test.js). Storage and integration with the citation
 * pipeline live in classicalAbbreviations.js.
 *
 * List format (JSON):
 *
 * {
 *   "format": "typos-abbreviations",
 *   "version": 1,
 *   "id": "my-list",              // optional; derived from the name if missing
 *   "name": "My list",
 *   "description": "...",         // optional
 *   "source": "...",              // optional, e.g. the print edition the list comes from
 *   "entries": [
 *     { "type": "author", "full": "Homer", "abbreviation": "Hom.", "aliases": ["Homerus"] },
 *     { "type": "work", "full": "Iliad", "abbreviation": "Il.", "author": "Homer",
 *       "aliases": ["Ilias"] }
 *   ]
 * }
 *
 * CSV/TSV columns: type, full, abbreviation, author, aliases (aliases separated by "|").
 *
 * Entry types and the CSL variable each one abbreviates:
 *   work       title             (a classical work; may be limited to one author)
 *   author     author names      (replaces a matching author with the abbreviation)
 *   journal    container-title   (journals, and any other container: a book a chapter is in)
 *   series     collection-title
 *   publisher  publisher
 *   place      publisher-place
 */
(function (root) {
	const FORMAT = 'typos-abbreviations';
	// Lists written before the application had its name
	const LEGACY_FORMATS = ['refmgr-abbreviations'];
	const VERSION = 1;
	const ENTRY_TYPES = ['work', 'author', 'journal', 'series', 'publisher', 'place'];

	/**
	 * Entry types matched on a single field with no author, and the CSL JSON variables involved.
	 * `short` is the variable styles read for the abbreviated form (form="short"), or null if CSL
	 * has none, in which case the abbreviation can only replace the full form.
	 */
	const SIMPLE_TYPES = {
		journal: { csl: 'container-title', short: 'container-title-short' },
		series: { csl: 'collection-title', short: 'collection-title-short' },
		publisher: { csl: 'publisher', short: null },
		place: { csl: 'publisher-place', short: null }
	};

	/** Types that are on unless a profile says otherwise */
	const DEFAULT_TYPES = ['work', 'author', 'journal', 'series'];

	class AbbreviationFormatError extends Error {
		constructor(message) {
			super(message);
			this.name = 'AbbreviationFormatError';
		}
	}


	/**
	 * Normalize a title or name for matching: case, accents, punctuation, spacing and a few
	 * ligatures don't matter ("Æneid", "Aeneid" and "AENEID." all match)
	 */
	function normalizeKey(str) {
		return String(str ?? '')
			.normalize('NFD')
			.replace(/[̀-ͯ]/g, '')
			.replace(/æ/gi, 'ae')
			.replace(/œ/gi, 'oe')
			.toLowerCase()
			.replace(/[.,;:!?'"’‘“”()[\]{}]/g, '')
			.replace(/[-‐‑–—]/g, ' ')
			.replace(/\s+/g, ' ')
			.trim();
	}


	/**
	 * A looser key for journals, series, publishers and places: also ignores a leading article
	 * and "and" / "&" ("The Classical Quarterly" = "Classical Quarterly";
	 * "Studies in Ancient & Modern History" = "... and ...")
	 */
	function looseKey(str) {
		return normalizeKey(String(str ?? '').replace(/&/g, ' and '))
			.replace(/^(?:the|a|an|der|die|das|le|la|les|el|il|los|las) /, '')
			.replace(/ and /g, ' ');
	}


	function slugify(str) {
		let slug = normalizeKey(str).replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
		return slug || 'list';
	}


	function _str(value, what) {
		if (value === undefined || value === null) return '';
		if (typeof value !== 'string') {
			throw new AbbreviationFormatError(`${what} must be a string`);
		}
		return value.trim();
	}


	/**
	 * Validate and normalize a list object
	 *
	 * @param {Object} data
	 * @return {{ list: Object, warnings: String[] }}
	 */
	function validateList(data) {
		if (!data || typeof data !== 'object' || Array.isArray(data)) {
			throw new AbbreviationFormatError("Abbreviation list must be an object");
		}
		if (data.format !== undefined && data.format !== FORMAT && !LEGACY_FORMATS.includes(data.format)) {
			throw new AbbreviationFormatError(`Unrecognized format '${data.format}'`);
		}
		if (data.version !== undefined && data.version > VERSION) {
			throw new AbbreviationFormatError(
				`List version ${data.version} is newer than this version of the application supports`
			);
		}
		let name = _str(data.name, 'name');
		if (!name) {
			throw new AbbreviationFormatError("Abbreviation list needs a name");
		}
		if (!Array.isArray(data.entries)) {
			throw new AbbreviationFormatError("Abbreviation list needs an 'entries' array");
		}

		let warnings = [];
		let entries = [];
		let seen = new Map();
		data.entries.forEach((raw, i) => {
			let label = `Entry ${i + 1}`;
			if (!raw || typeof raw !== 'object') {
				warnings.push(`${label}: not an object -- skipped`);
				return;
			}
			let type = _str(raw.type, `${label} type`);
			let full = _str(raw.full, `${label} full`);
			let abbreviation = _str(raw.abbreviation, `${label} abbreviation`);
			if (!ENTRY_TYPES.includes(type)) {
				warnings.push(`${label}: type must be one of ${ENTRY_TYPES.join(', ')} -- skipped`);
				return;
			}
			if (!full || !abbreviation) {
				warnings.push(`${label}: 'full' and 'abbreviation' are required -- skipped`);
				return;
			}
			let author = type === 'work' ? _str(raw.author, `${label} author`) : '';
			let aliases = Array.isArray(raw.aliases)
				? raw.aliases.filter(a => typeof a === 'string' && a.trim()).map(a => a.trim())
				: [];

			let dupKey = [type, normalizeKey(full), normalizeKey(author)].join('\u0000');
			if (seen.has(dupKey)) {
				let previous = entries[seen.get(dupKey)];
				if (previous.abbreviation !== abbreviation) {
					warnings.push(
						`${label}: '${full}' appears more than once with different abbreviations `
						+ `('${previous.abbreviation}', '${abbreviation}') -- using the later one`
					);
				}
				entries[seen.get(dupKey)] = { type, full, abbreviation, author, aliases };
				return;
			}
			seen.set(dupKey, entries.length);
			entries.push({ type, full, abbreviation, author, aliases });
		});

		return {
			list: {
				format: FORMAT,
				version: VERSION,
				id: _str(data.id, 'id') || slugify(name),
				name,
				description: _str(data.description, 'description'),
				source: _str(data.source, 'source'),
				entries
			},
			warnings
		};
	}


	function parseJSON(text) {
		let data;
		try {
			data = JSON.parse(String(text).replace(/^﻿/, ''));
		}
		catch (e) {
			throw new AbbreviationFormatError("Not valid JSON: " + e.message);
		}
		// CSL-style abbreviation files have jurisdictions at the top level, not a name and entries
		if (data && typeof data === 'object' && !Array.isArray(data) && !('entries' in data)
				&& (data.default || data.info)) {
			return fromCSLAbbreviations(data);
		}
		return validateList(data);
	}


	/** CSL abbreviation category -> entry type */
	const CSL_CATEGORY_TYPES = {
		title: 'work',
		author: 'author',
		'container-title': 'journal',
		'collection-title': 'series',
		publisher: 'publisher',
		place: 'place'
	};


	/**
	 * Convert a CSL abbreviations object ({ default: { "container-title": { "Full": "Abbr." } } })
	 * to a list
	 *
	 * Categories map to entry types (see CSL_CATEGORY_TYPES). Jurisdiction sections other than
	 * 'default' and unrecognized categories are skipped, and word-by-word categories (those ending
	 * in "-word") can't be represented, so they're counted in a warning.
	 */
	function fromCSLAbbreviations(data) {
		let info = data.info || {};
		let section = data.default || {};
		let entries = [];
		let ignored = 0;
		let wordRules = 0;
		for (let [category, map] of Object.entries(section)) {
			let count = map && typeof map === 'object' ? Object.keys(map).length : 0;
			let type = CSL_CATEGORY_TYPES[category];
			if (!type) {
				if (category.endsWith('-word')) wordRules += count;
				else ignored += count;
				continue;
			}
			for (let [full, abbreviation] of Object.entries(map)) {
				entries.push({ type, full, abbreviation });
			}
		}
		let result = validateList({
			name: info.name || 'Imported CSL abbreviations',
			source: info.URI || '',
			entries
		});
		if (wordRules) {
			result.warnings.push(`${wordRules} word-by-word rules were not imported (only whole `
				+ `titles are matched)`);
		}
		if (ignored) {
			result.warnings.push(`${ignored} abbreviations in unsupported categories were ignored`);
		}
		return result;
	}


	/**
	 * Parse CSV or TSV text into rows of fields, honouring quotes
	 */
	function _parseDelimited(text, delimiter) {
		let rows = [];
		let row = [];
		let field = '';
		let inQuotes = false;
		let i = 0;
		let started = false;
		while (i < text.length) {
			let c = text[i];
			if (inQuotes) {
				if (c === '"') {
					if (text[i + 1] === '"') {
						field += '"';
						i += 2;
						continue;
					}
					inQuotes = false;
					i++;
					continue;
				}
				field += c;
				i++;
				continue;
			}
			if (c === '"' && field === '') {
				inQuotes = true;
				started = true;
				i++;
			}
			else if (c === delimiter) {
				row.push(field);
				field = '';
				started = true;
				i++;
			}
			else if (c === '\r' || c === '\n') {
				if (c === '\r' && text[i + 1] === '\n') i++;
				i++;
				if (started || field !== '' || row.length) {
					row.push(field);
					rows.push(row);
				}
				row = [];
				field = '';
				started = false;
			}
			else {
				field += c;
				started = true;
				i++;
			}
		}
		if (inQuotes) {
			throw new AbbreviationFormatError("Unterminated quoted field");
		}
		if (started || field !== '' || row.length) {
			row.push(field);
			rows.push(row);
		}
		return rows;
	}


	/**
	 * @param {String} text
	 * @param {Object} meta - { name (required), id, description, source }
	 */
	function parseCSV(text, meta = {}) {
		text = String(text).replace(/^﻿/, '');
		let firstLine = text.split(/\r?\n/, 1)[0];
		let delimiter = firstLine.includes('\t') ? '\t' : ',';
		let rows = _parseDelimited(text, delimiter).filter(r => r.some(f => f.trim() !== ''));
		if (!rows.length) {
			throw new AbbreviationFormatError("File is empty");
		}
		let header = rows[0].map(h => h.trim().toLowerCase());
		for (let required of ['type', 'full', 'abbreviation']) {
			if (!header.includes(required)) {
				throw new AbbreviationFormatError(`Missing '${required}' column in header`);
			}
		}
		let col = name => header.indexOf(name);
		let entries = rows.slice(1).map((r) => {
			let get = name => (col(name) >= 0 ? (r[col(name)] ?? '') : '');
			return {
				type: get('type').trim().toLowerCase(),
				full: get('full'),
				abbreviation: get('abbreviation'),
				author: get('author'),
				aliases: get('aliases').split('|').map(a => a.trim()).filter(Boolean)
			};
		});
		if (!meta.name) {
			throw new AbbreviationFormatError("A name is required for CSV imports");
		}
		return validateList({
			name: meta.name,
			id: meta.id,
			description: meta.description,
			source: meta.source,
			entries
		});
	}


	/**
	 * A lookup structure over one or more lists
	 *
	 * Earlier lists take precedence over later ones.
	 */
	class AbbreviationIndex {
		/**
		 * @param {Object[]} lists - Each a validated list. A list may also carry `provider`, an
		 *     object of functions keyed by simple entry type (e.g., { journal: full => abbr|null }),
		 *     which stand in for entries -- used for the application's built-in journal table.
		 */
		constructor(lists = []) {
			this._works = new Map(); // normalized title -> entries
			this._authors = new Map(); // normalized name -> entry
			// type -> [{ map: Map(loose key -> entry) | null, provider: Function | null }], in
			// list order so that earlier lists win
			this._simple = {};
			for (let type of Object.keys(SIMPLE_TYPES)) this._simple[type] = [];
			this._providers = 0;
			for (let list of lists) {
				this.addList(list);
			}
		}

		addList(list) {
			let simple = {};
			for (let type of Object.keys(SIMPLE_TYPES)) simple[type] = new Map();
			for (let entry of list.entries || []) {
				if (SIMPLE_TYPES[entry.type]) {
					for (let key of [entry.full, ...(entry.aliases || [])].map(looseKey).filter(Boolean)) {
						if (!simple[entry.type].has(key)) simple[entry.type].set(key, entry);
					}
					continue;
				}
				let keys = [entry.full, ...(entry.aliases || [])].map(normalizeKey).filter(Boolean);
				if (entry.type === 'author') {
					for (let key of keys) {
						// First list to define a name wins
						if (!this._authors.has(key)) this._authors.set(key, entry);
					}
				}
				else {
					let authorKey = normalizeKey(entry.author);
					for (let key of keys) {
						let bucket = this._works.get(key);
						if (!bucket) {
							bucket = [];
							this._works.set(key, bucket);
						}
						// Don't let a later list override the same (title, author) from an earlier one
						if (!bucket.some(e => normalizeKey(e.author) === authorKey)) {
							bucket.push(entry);
						}
					}
				}
			}
			for (let type of Object.keys(SIMPLE_TYPES)) {
				let provider = list.provider?.[type] || null;
				if (simple[type].size || provider) {
					this._simple[type].push({ map: simple[type], provider });
				}
				if (provider) this._providers++;
			}
		}

		/**
		 * Look up a journal, series, publisher or place
		 *
		 * @param {'journal'|'series'|'publisher'|'place'} type
		 * @param {String} full
		 * @return {{ abbreviation: String }|null}
		 */
		lookupSimple(type, full) {
			let sources = this._simple[type];
			if (!sources || !full) return null;
			let key = looseKey(full);
			if (!key) return null;
			for (let { map, provider } of sources) {
				let entry = map.get(key);
				if (entry) return entry;
				if (provider) {
					let abbreviation = provider(full);
					if (abbreviation) return { type, full, abbreviation };
				}
			}
			return null;
		}

		get size() {
			let works = new Set();
			for (let bucket of this._works.values()) bucket.forEach(e => works.add(e));
			let simple = 0;
			for (let sources of Object.values(this._simple)) {
				for (let { map } of sources) simple += map.size;
			}
			return works.size + new Set(this._authors.values()).size + simple + this._providers;
		}

		/**
		 * @param {String} title
		 * @param {String[]} [authorNames] - Candidate names for the work's author(s), any form
		 * @return {Object|null} - The matching entry
		 */
		lookupWork(title, authorNames = []) {
			let bucket = this._works.get(normalizeKey(title));
			if (!bucket || !bucket.length) return null;

			let names = authorNames.map(normalizeKey).filter(Boolean);
			let matchesAuthor = (entry) => {
				let key = normalizeKey(entry.author);
				if (!key) return false;
				// The entry's author may be listed under an alias in the author entries too
				let authorEntry = this._authors.get(key);
				let candidates = new Set([key]);
				if (authorEntry) {
					[authorEntry.full, ...(authorEntry.aliases || [])]
						.map(normalizeKey)
						.forEach(k => candidates.add(k));
				}
				let last = str => str.split(' ').pop();
				return names.some(n => candidates.has(n)
					// A bare surname matches a full name with the same surname, and vice versa
					|| [...candidates].some(c => (!c.includes(' ') || !n.includes(' '))
						&& last(c) === last(n)));
			};

			let constrained = bucket.filter(e => normalizeKey(e.author));
			let unconstrained = bucket.filter(e => !normalizeKey(e.author));
			let match = constrained.find(matchesAuthor);
			if (match) return match;
			if (unconstrained.length) return unconstrained[0];
			// With no author on the item, an unambiguous title still matches
			if (!names.length && constrained.length === 1) return constrained[0];
			// Otherwise a title that exists only for specific authors isn't a match
			return null;
		}

		/**
		 * @param {String[]} names - Candidate forms of one author's name
		 */
		lookupAuthor(names) {
			for (let name of names) {
				let entry = this._authors.get(normalizeKey(name));
				if (entry) return entry;
			}
			return null;
		}
	}


	const MODES = ['off', 'abbreviated', 'short-title'];


	function _creatorNames(creator) {
		if (creator.literal) return [creator.literal];
		let names = [];
		if (creator.family) {
			if (creator.given) names.push(`${creator.given} ${creator.family}`);
			names.push(creator.family);
		}
		return names;
	}


	/**
	 * The set of entry types an options object turns on. Without an explicit `types` array, the
	 * defaults apply, minus work/author if abbreviateWorks / abbreviateAuthors is false.
	 */
	function enabledTypes(options = {}) {
		if (options.types) {
			return new Set(options.types.filter(t => ENTRY_TYPES.includes(t)));
		}
		let types = new Set(DEFAULT_TYPES);
		if (options.abbreviateWorks === false) types.delete('work');
		if (options.abbreviateAuthors === false) types.delete('author');
		return types;
	}


	/**
	 * Apply abbreviations to a CSL JSON item
	 *
	 * Modes:
	 *  - 'off': nothing changes
	 *  - 'abbreviated': matching values are replaced with their abbreviations, and the short-form
	 *      variable (title-short, container-title-short, ...) is set too, so styles that ask for
	 *      short forms get the same text
	 *  - 'short-title': only the short-form variables are set, so the output changes only in
	 *      styles that ask for short forms (form="short"). Publishers and places have no short
	 *      form in CSL, so this mode leaves them alone.
	 *
	 * A journal's own abbreviation on the item (Journal Abbr, already in container-title-short)
	 * is used in preference to a list's, unless options.preferItemAbbreviations is false.
	 *
	 * @param {Object} cslItem - Modified in place
	 * @param {AbbreviationIndex} index
	 * @param {Object} options
	 * @param {String} [options.mode='abbreviated']
	 * @param {String[]} [options.types] - Entry types to apply. If omitted, work, author, journal
	 *     and series, adjusted by the legacy abbreviateWorks / abbreviateAuthors flags.
	 * @param {Boolean} [options.preferItemAbbreviations=true]
	 * @return {Boolean} - Whether anything changed
	 */
	function applyToCSL(cslItem, index, options = {}) {
		let mode = options.mode || 'abbreviated';
		if (!MODES.includes(mode)) {
			throw new Error(`Unknown abbreviation mode '${mode}'`);
		}
		if (mode === 'off') return false;
		let types = enabledTypes(options);
		let changed = false;

		let authors = Array.isArray(cslItem.author) ? cslItem.author : [];

		if (types.has('work') && cslItem.title) {
			let authorNames = authors.flatMap(_creatorNames);
			let entry = index.lookupWork(cslItem.title, authorNames);
			if (entry) {
				if (mode === 'abbreviated') {
					cslItem.title = entry.abbreviation;
				}
				cslItem['title-short'] = entry.abbreviation;
				changed = true;
			}
		}

		if (mode === 'abbreviated' && types.has('author') && authors.length) {
			cslItem.author = authors.map((creator) => {
				let entry = index.lookupAuthor(_creatorNames(creator));
				if (!entry) return creator;
				changed = true;
				return { literal: entry.abbreviation };
			});
		}

		for (let [type, { csl, short }] of Object.entries(SIMPLE_TYPES)) {
			if (!types.has(type)) continue;
			let full = cslItem[csl];
			if (!full || typeof full !== 'string') continue;
			let abbreviation;
			// Zotero's CSL JSON carries the item's Journal Abbr as journalAbbreviation, other
			// tools as container-title-short
			let own = type === 'journal' && short ? (cslItem[short] || cslItem.journalAbbreviation) : null;
			if (own && options.preferItemAbbreviations !== false) {
				abbreviation = own;
			}
			else {
				abbreviation = index.lookupSimple(type, full)?.abbreviation;
			}
			if (!abbreviation) continue;
			if (mode === 'abbreviated') {
				if (cslItem[csl] !== abbreviation || (short && cslItem[short] !== abbreviation)) {
					cslItem[csl] = abbreviation;
					if (short) cslItem[short] = abbreviation;
					if (type === 'journal' && cslItem.journalAbbreviation) {
						cslItem.journalAbbreviation = abbreviation;
					}
					changed = true;
				}
			}
			else if (short && cslItem[short] !== abbreviation) {
				cslItem[short] = abbreviation;
				if (type === 'journal' && cslItem.journalAbbreviation) {
					cslItem.journalAbbreviation = abbreviation;
				}
				changed = true;
			}
		}

		return changed;
	}


	const api = {
		FORMAT,
		VERSION,
		MODES,
		ENTRY_TYPES,
		SIMPLE_TYPES,
		DEFAULT_TYPES,
		CSL_CATEGORY_TYPES,
		AbbreviationFormatError,
		AbbreviationIndex,
		normalizeKey,
		looseKey,
		enabledTypes,
		slugify,
		validateList,
		parseJSON,
		parseCSV,
		fromCSLAbbreviations,
		applyToCSL
	};

	if (typeof module !== 'undefined' && module.exports) {
		module.exports = api;
	}
	else if (root) {
		root.AbbreviationIndex = api;
	}
})(typeof Zotero !== 'undefined' ? Zotero : null);

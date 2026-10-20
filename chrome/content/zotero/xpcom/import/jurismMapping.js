"use strict";

/**
 * Mapping of Juris-M items to this application's data model
 *
 * Pure functions with no database or Zotero dependencies, so they can be tested in plain Node (see
 * fork/test/jurismMapping.test.js). The schema-dependent questions ("is this field valid for that
 * item type?") are answered by a `schema` object the caller passes in.
 *
 * Principles:
 *  - Types that exist here are kept as they are. That includes Classic Work, which Juris-M also
 *    has.
 *  - Juris-M's legal-only types are mapped to the closest ordinary type.
 *  - Nothing is thrown away. Fields that aren't valid for the target type are written to Extra
 *    as "Label: value" lines, and alternate-language data (Juris-M's multilingual feature) is kept
 *    as one machine-readable line in Extra so it can be restored by a future multilingual feature.
 */
(function (root) {
	/** Juris-M item type -> item type here, for types that don't exist here */
	const TYPE_MAP = {
		gazette: 'statute',
		regulation: 'statute',
		treaty: 'document',
		legalCommentary: 'bookSection'
	};

	/** Juris-M creator type -> creator type here, for types that don't exist here */
	const CREATOR_TYPE_MAP = {
		testimonyBy: 'contributor'
	};

	/** Labels for Juris-M-only fields, used when a field has to be written to Extra */
	const FIELD_LABELS = {
		adminFlag: "Admin Flag",
		adoptionDate: "Date Adopted",
		album: "Album",
		archiveCollection: "Archive Collection",
		assemblyNumber: "Assembly Number",
		bookAbbreviation: "Book Abbreviation",
		conferenceDate: "Conference Date",
		dateAmended: "Date Amended",
		division: "Division",
		documentName: "Document Name",
		gazetteFlag: "Gazette Reference",
		jurisdiction: "Jurisdiction",
		medium: "Medium",
		meetingNumber: "Meeting Number",
		newsCaseDate: "Case Date",
		openingDate: "Date Opened",
		opus: "Opus Number",
		originalDate: "Original Date",
		parentTreaty: "Parent Treaty",
		priorityDate: "Priority Date",
		publicationDate: "Date Published",
		publicationNumber: "Publication Number",
		regnalYear: "Regnal Year",
		regulationType: "Regulation Type",
		regulatoryBody: "Authority",
		reign: "Reign",
		release: "Release",
		resolutionLabel: "Resolution Label",
		sessionType: "Session Type",
		signingDate: "Date Signed",
		supplementName: "Supplement Name",
		treatyNumber: "Treaty Number",
		volumeTitle: "Volume Title",
		yearAsVolume: "Year As Volume"
	};

	const ALTERNATES_KEY = 'mlz-alternates';
	const ALTERNATES_VERSION = 1;

	// Fields that are handled outside the generic field loop
	const RESERVED = new Set(['extra']);


	function mapItemType(jurismType) {
		return TYPE_MAP[jurismType] || jurismType;
	}


	function _labelFor(field) {
		if (FIELD_LABELS[field]) return FIELD_LABELS[field];
		// camelCase -> Title Case
		return field
			.replace(/([a-z0-9])([A-Z])/g, '$1 $2')
			.replace(/^./, c => c.toUpperCase());
	}


	function _extraLine(label, value) {
		// Extra lines are single-line; fold any line breaks so a value can't corrupt later lines
		return `${label}: ${String(value).replace(/\s*[\r\n]+\s*/g, ' ').trim()}`;
	}


	/**
	 * Serialize alternate-language data into the single Extra line
	 *
	 * @param {Object} alternates
	 * @param {Object} [alternates.fields] - { fieldName: { languageTag: value } }
	 * @param {Object[]} [alternates.creators] - [{ index, creatorType, languageTag, firstName,
	 *     lastName, name }]
	 * @param {Object} [alternates.mainLang] - { fieldName: languageTag } for the main values
	 * @return {String|null}
	 */
	function serializeAlternates(alternates) {
		if (!alternates) return null;
		let fields = alternates.fields || {};
		let creators = alternates.creators || [];
		let mainLang = alternates.mainLang || {};
		if (!Object.keys(fields).length && !creators.length && !Object.keys(mainLang).length) {
			return null;
		}
		return `${ALTERNATES_KEY}: ` + JSON.stringify({
			v: ALTERNATES_VERSION,
			fields,
			creators,
			mainLang
		});
	}


	/**
	 * Parse the alternates line back out of an Extra string
	 *
	 * @return {Object|null}
	 */
	function parseAlternates(extra) {
		for (let line of String(extra || '').split('\n')) {
			if (!line.startsWith(ALTERNATES_KEY + ':')) continue;
			try {
				let data = JSON.parse(line.slice(ALTERNATES_KEY.length + 1).trim());
				return data && data.v <= ALTERNATES_VERSION ? data : null;
			}
			catch (e) {
				return null;
			}
		}
		return null;
	}


	/**
	 * Map one Juris-M item
	 *
	 * @param {Object} src
	 * @param {String} src.itemType - Juris-M item type
	 * @param {Object} src.fields - { fieldName: value } for the main-language values
	 * @param {Object[]} src.creators - [{ creatorType, firstName, lastName, fieldMode }]
	 * @param {Object} [src.alternates] - See serializeAlternates()
	 * @param {Object} schema
	 * @param {Function} schema.isValidField - (itemType, field) => Boolean
	 * @param {Function} [schema.resolveField] - (itemType, field) => String|null. Returns the
	 *     item type's own name for a field, which differs from `field` when `field` is a base
	 *     field such as 'title' and the type has its own name for it ('nameOfAct' for statutes), or
	 *     null if the type has no such field. Defaults to isValidField.
	 * @param {Function} schema.isValidCreatorType - (itemType, creatorType) => Boolean
	 * @param {Function} [schema.normalizeValue] - (field, value) => value, e.g., to convert date
	 *     formats
	 * @return {{ json: Object, warnings: String[] }} - json is in Zotero API item JSON form
	 */
	function mapItem(src, schema) {
		let warnings = [];
		let itemType = mapItemType(src.itemType);
		let normalize = schema.normalizeValue || ((field, value) => value);
		let json = { itemType };
		let leftovers = [];

		for (let [field, rawValue] of Object.entries(src.fields || {})) {
			if (RESERVED.has(field)) continue;
			if (rawValue === null || rawValue === undefined || rawValue === '') continue;
			let value = normalize(field, rawValue);
			let resolved = schema.resolveField
				? schema.resolveField(itemType, field)
				: (schema.isValidField(itemType, field) ? field : null);
			if (resolved && json[resolved] === undefined) {
				json[resolved] = value;
			}
			else {
				leftovers.push(_extraLine(_labelFor(field), value));
			}
		}

		json.creators = [];
		for (let creator of src.creators || []) {
			let creatorType = creator.creatorType;
			if (!schema.isValidCreatorType(itemType, creatorType)) {
				let mapped = CREATOR_TYPE_MAP[creatorType];
				creatorType = mapped && schema.isValidCreatorType(itemType, mapped)
					? mapped
					: schema.isValidCreatorType(itemType, 'contributor') ? 'contributor' : 'author';
				if (creatorType !== creator.creatorType && !CREATOR_TYPE_MAP[creator.creatorType]) {
					warnings.push(`Creator type '${creator.creatorType}' isn't valid for `
						+ `'${itemType}' -- imported as '${creatorType}'`);
				}
			}
			if (creator.fieldMode === 1 || (!creator.firstName && creator.lastName)) {
				json.creators.push({ creatorType, name: creator.lastName || '' });
			}
			else {
				json.creators.push({
					creatorType,
					firstName: creator.firstName || '',
					lastName: creator.lastName || ''
				});
			}
		}

		let extraParts = [];
		let existingExtra = (src.fields && src.fields.extra) || '';
		if (existingExtra.trim()) extraParts.push(existingExtra.trim());
		extraParts.push(...leftovers);
		let alternates = serializeAlternates(src.alternates);
		if (alternates) extraParts.push(alternates);
		if (extraParts.length) {
			if (schema.isValidField(itemType, 'extra')) {
				json.extra = extraParts.join('\n');
			}
			else {
				warnings.push(`'${itemType}' has no Extra field -- ${extraParts.length} `
					+ `line(s) of data were not imported`);
			}
		}

		if (itemType !== src.itemType) {
			warnings.push(`Item type '${src.itemType}' imported as '${itemType}'`);
		}

		return { json, warnings };
	}


	const api = {
		TYPE_MAP,
		CREATOR_TYPE_MAP,
		FIELD_LABELS,
		ALTERNATES_KEY,
		mapItemType,
		serializeAlternates,
		parseAlternates,
		mapItem
	};

	if (typeof module !== 'undefined' && module.exports) {
		module.exports = api;
	}
	else if (root) {
		root.JurismMapping = api;
	}
})(typeof Zotero !== 'undefined' ? Zotero : null);

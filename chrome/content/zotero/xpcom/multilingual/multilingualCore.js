"use strict";

/**
 * Per-field language support: the logic that doesn't need the database
 *
 * Every text field and every creator can have a language, and variants: the same value in other
 * languages or scripts (a title in Latin, Greek and English; a name in Greek and in
 * transliteration). This is the same idea as Juris-M's multilingual feature, and the tables
 * match its layout (see multilingual.js).
 *
 * Pure functions with no Zotero dependencies, so they can be tested in plain Node (see
 * fork/test/multilingualCore.test.js).
 */
(function (root) {
	/** Languages offered until the person adds others */
	const DEFAULT_TAGS = [
		['ar', 'Arabic'], ['de', 'German'], ['en', 'English'], ['es', 'Spanish'], ['fr', 'French'],
		['grc', 'Ancient Greek'], ['he', 'Hebrew'], ['it', 'Italian'], ['la', 'Latin'],
		['cop', 'Coptic'], ['syr', 'Syriac'], ['el', 'Greek']
	];

	const CATEGORIES = ['titles', 'creators', 'publishers', 'other'];
	const MODES = ['orig', 'variant', 'both'];


	/**
	 * "en_us" -> "en-US", " LA " -> "la". Anything that isn't a plausible language tag gives null.
	 */
	function normalizeTag(value) {
		let t = String(value || '').trim().replace(/_/g, '-');
		if (!/^[A-Za-z]{2,8}(-[A-Za-z0-9]{1,8})*$/.test(t)) return null;
		let [first, ...rest] = t.split('-');
		return [first.toLowerCase(), ...rest.map(p => (p.length === 2 ? p.toUpperCase() : p))].join('-');
	}


	/**
	 * "Last, First" -> { lastName, firstName, fieldMode: 0 }; no comma -> a single-field name
	 *
	 * @return {{ lastName: String, firstName: String, fieldMode: Number }|null}
	 */
	function parseCreatorText(text) {
		let t = String(text || '').trim();
		if (!t) return null;
		let comma = t.indexOf(',');
		if (comma > 0 && comma < t.length - 1) {
			let lastName = t.slice(0, comma).trim();
			let firstName = t.slice(comma + 1).trim();
			if (lastName && firstName) return { lastName, firstName, fieldMode: 0 };
		}
		return { lastName: t.replace(/,\s*$/, ''), firstName: '', fieldMode: 1 };
	}


	function formatCreatorText(creator) {
		if (!creator) return '';
		if (creator.fieldMode === 1 || !creator.firstName) return creator.lastName || '';
		return `${creator.lastName}, ${creator.firstName}`;
	}


	/** Which setting applies to a CSL text variable */
	function categoryForVariable(variable) {
		if (/(^|-)title(-short)?$/.test(variable)) return 'titles';
		if (variable === 'publisher' || variable === 'publisher-place' || variable === 'event-place') {
			return 'publishers';
		}
		return 'other';
	}


	function defaultSettings() {
		let settings = {};
		for (let c of CATEGORIES) settings[c] = { mode: 'orig', languages: [] };
		return settings;
	}


	/**
	 * Make sure settings read from a preference are usable
	 */
	function normalizeSettings(raw) {
		let settings = defaultSettings();
		if (!raw || typeof raw !== 'object') return settings;
		for (let c of CATEGORIES) {
			let entry = raw[c];
			if (!entry || typeof entry !== 'object') continue;
			let mode = MODES.includes(entry.mode) ? entry.mode : 'orig';
			if (c === 'creators' && mode === 'both') mode = 'variant';
			let languages = (Array.isArray(entry.languages) ? entry.languages : [])
				.map(normalizeTag)
				.filter(Boolean);
			settings[c] = { mode, languages: [...new Set(languages)] };
		}
		return settings;
	}


	/**
	 * The first language in the list that has a variant
	 *
	 * @param {Object} variants - { tag: value }
	 * @param {String[]} languages - In order of preference
	 * @return {{ tag: String, value: any }|null}
	 */
	function pickVariant(variants, languages) {
		if (!variants) return null;
		for (let tag of languages) {
			let value = variants[tag];
			if (value !== undefined && value !== null && value !== '') return { tag, value };
		}
		return null;
	}


	/**
	 * Replace text variables in a CSL item with the variants the settings ask for
	 *
	 * @param {Object} cslItem - Modified in place
	 * @param {{ variable: String, field: String }[]} sources - Which item field each CSL variable
	 *     was read from
	 * @param {Function} getVariants - (field) => { tag: value }
	 * @param {Object} settings - From normalizeSettings
	 * @return {Boolean} - Whether anything changed
	 */
	function substituteText(cslItem, sources, getVariants, settings) {
		let changed = false;
		for (let { variable, field } of sources) {
			if (typeof cslItem[variable] !== 'string') continue;
			let { mode, languages } = settings[categoryForVariable(variable)];
			if (mode === 'orig' || !languages.length) continue;
			let picked = pickVariant(getVariants(field), languages);
			if (!picked) continue;
			cslItem[variable] = mode === 'both'
				? `${cslItem[variable]} [${picked.value}]`
				: picked.value;
			changed = true;
		}
		return changed;
	}


	/** A creator in the shape CSL JSON uses */
	function toCSLName(creator) {
		if (creator.fieldMode === 1 || !creator.firstName) {
			return { literal: creator.lastName || '' };
		}
		return { family: creator.lastName || '', given: creator.firstName };
	}


	/**
	 * Replace names in a CSL item with variants
	 *
	 * @param {Object} cslItem - Modified in place
	 * @param {{ cslType: String, position: Number, variants: Object }[]} entries - One per
	 *     creator that has variants; `position` is the creator's place in cslItem[cslType];
	 *     `variants` is { tag: { firstName, lastName, fieldMode } }
	 * @param {Object} settings
	 * @return {Boolean}
	 */
	function substituteNames(cslItem, entries, settings) {
		let { mode, languages } = settings.creators;
		if (mode === 'orig' || !languages.length) return false;
		let changed = false;
		for (let entry of entries) {
			let list = cslItem[entry.cslType];
			if (!Array.isArray(list) || !list[entry.position]) continue;
			let picked = pickVariant(entry.variants, languages);
			if (!picked) continue;
			list[entry.position] = toCSLName(picked.value);
			changed = true;
		}
		return changed;
	}


	/**
	 * Turn the "mlz-alternates" data an import left in Extra into the operations that store it in
	 * the language tables
	 *
	 * @param {Object} alternates - See JurismMapping.serializeAlternates()
	 * @param {Object} context
	 * @param {Function} context.resolveField - (fieldName) => the name the item's type uses for it
	 *     and that can have languages, or null
	 * @param {Number} context.creatorCount
	 * @return {{ fieldLanguages: Object[], variants: Object[], creatorLanguages: Object[],
	 *     creatorVariants: Object[], skipped: String[] }}
	 */
	function planAlternates(alternates, { resolveField, creatorCount }) {
		let plan = { fieldLanguages: [], variants: [], creatorLanguages: [], creatorVariants: [], skipped: [] };
		if (!alternates) return plan;
		for (let [name, tag] of Object.entries(alternates.mainLang || {})) {
			let language = normalizeTag(tag);
			let m = /^creator:(\d+)$/.exec(name);
			if (m) {
				let index = parseInt(m[1]);
				if (language && index < creatorCount) plan.creatorLanguages.push({ index, language });
				else plan.skipped.push(`${name}: ${tag}`);
				continue;
			}
			let field = resolveField(name);
			if (field && language) plan.fieldLanguages.push({ field, language });
			else plan.skipped.push(`${name}: ${tag}`);
		}
		for (let [name, byTag] of Object.entries(alternates.fields || {})) {
			let field = resolveField(name);
			for (let [tag, value] of Object.entries(byTag || {})) {
				let language = normalizeTag(tag);
				if (field && language && String(value || '').trim()) {
					plan.variants.push({ field, language, value: String(value).trim() });
				}
				else {
					plan.skipped.push(`${name} (${tag})`);
				}
			}
		}
		for (let c of alternates.creators || []) {
			let language = normalizeTag(c.languageTag);
			let index = parseInt(c.index);
			let lastName = c.lastName || c.name || '';
			if (language && index >= 0 && index < creatorCount && (lastName || c.firstName)) {
				plan.creatorVariants.push({
					index,
					language,
					name: {
						lastName,
						firstName: c.fieldMode === 1 ? '' : c.firstName || '',
						fieldMode: c.fieldMode === 1 ? 1 : 0
					}
				});
			}
			else {
				plan.skipped.push(`creator ${c.index} (${c.languageTag})`);
			}
		}
		return plan;
	}


	let api = {
		planAlternates,
		DEFAULT_TAGS,
		CATEGORIES,
		MODES,
		normalizeTag,
		parseCreatorText,
		formatCreatorText,
		categoryForVariable,
		defaultSettings,
		normalizeSettings,
		pickVariant,
		substituteText,
		substituteNames,
		toCSLName
	};

	if (typeof module !== 'undefined' && module.exports) {
		module.exports = api;
	}
	else if (root) {
		root.MultilingualCore = api;
	}
})(typeof Zotero !== 'undefined' ? Zotero : null);

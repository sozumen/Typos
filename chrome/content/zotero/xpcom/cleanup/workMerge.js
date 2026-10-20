"use strict";

/**
 * Cleanup step: merge duplicate classical works, keeping each title as a different language
 *
 * The same ancient work often appears twice under titles in different languages ("Adversus
 * Marcionem", "Against Marcion"). Merging keeps one record and writes the other titles into the
 * alternate-language line of Extra (the same `mlz-alternates` line the Juris-M import uses), so no
 * title is lost and a future multilingual feature can use them.
 *
 * Pure functions with no Zotero dependencies, so they can be tested in plain Node (see
 * fork/test/workMerge.test.js).
 */
(function (root) {
	const J = typeof module !== 'undefined' && module.exports
		? require('../import/jurismMapping.js')
		: root.JurismMapping;
	const X = typeof module !== 'undefined' && module.exports
		? require('./cleanupExtra.js')
		: root.CleanupExtra;

	const UNKNOWN_LANGUAGE = 'und';


	/** "en_US", "EN", "grc " -> "en-US", "en", "grc"; anything unusable -> 'und' */
	function languageTag(value) {
		let t = String(value || '').trim().replace(/_/g, '-');
		if (!/^[A-Za-z]{2,8}(-[A-Za-z0-9]{1,8})*$/.test(t)) return UNKNOWN_LANGUAGE;
		let [first, ...rest] = t.split('-');
		return [first.toLowerCase(), ...rest.map(p => p.length === 2 ? p.toUpperCase() : p)].join('-');
	}


	/**
	 * Extra for the item that survives the merge
	 *
	 * @param {Object} master - { title, language, extra }
	 * @param {Object[]} others - [{ title, language }], with `language` already chosen by the
	 *     person (or taken from the item's Language field)
	 * @return {{ extra: String, added: { title: String, language: String }[], skipped: String[] }}
	 *     skipped: titles not added because the master already has that text or language
	 */
	function mergeTitles(master, others) {
		let existing = J.parseAlternates(master.extra) || { v: 1, fields: {}, creators: [], mainLang: {} };
		let fields = existing.fields || {};
		let titles = Object.assign({}, fields.title || {});
		let mainLang = Object.assign({}, existing.mainLang || {});

		if (!mainLang.title && master.language) {
			mainLang.title = languageTag(master.language);
		}

		let added = [];
		let skipped = [];
		for (let other of others) {
			let title = String(other.title || '').trim();
			if (!title || X.sameText(title, master.title)) {
				if (title) skipped.push(title);
				continue;
			}
			let lang = languageTag(other.language);
			if (Object.values(titles).some(t => X.sameText(t, title))) {
				skipped.push(title);
				continue;
			}
			// One title per language: if the language is taken, make the tag unique rather than overwrite
			let tag = lang;
			let n = 2;
			while (titles[tag] !== undefined || mainLang.title === tag) {
				tag = `${lang}-x${n++}`;
			}
			titles[tag] = title;
			added.push({ title, language: tag });
		}
		if (!added.length) {
			return { extra: String(master.extra || ''), added, skipped };
		}

		let line = J.serializeAlternates({
			fields: Object.assign({}, fields, { title: titles }),
			creators: existing.creators || [],
			mainLang
		});
		let lines = String(master.extra || '').split(/\r?\n/);
		let at = lines.findIndex(l => l.startsWith('mlz-alternates:'));
		if (at >= 0) {
			lines[at] = line;
		}
		else {
			lines.push(line);
		}
		return { extra: lines.filter((l, i) => l.trim() || i < lines.length - 1).join('\n').replace(/^\n+/, ''), added, skipped };
	}


	/**
	 * Which items to offer as the one to keep: the one with the most data
	 *
	 * @param {Object[]} snapshots - [{ id, fields, creators }]
	 * @return {Number} - the id
	 */
	function suggestMaster(snapshots) {
		let score = s => Object.values(s.fields || {}).filter(v => String(v).trim()).length
			+ (s.creators || []).length + (s.relationCount || 0) * 2;
		return snapshots.slice().sort((a, b) => score(b) - score(a) || a.id - b.id)[0].id;
	}


	let api = { UNKNOWN_LANGUAGE, languageTag, mergeTitles, suggestMaster };

	if (typeof module !== 'undefined' && module.exports) {
		module.exports = api;
	}
	else if (root) {
		root.CleanupWorkMerge = api;
	}
})(typeof Zotero !== 'undefined' ? Zotero : null);

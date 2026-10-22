"use strict";

/**
 * Reading bibliographic data out of an Extra field
 *
 * Pure functions with no Zotero dependencies, so they can be tested in plain Node (see
 * fork/test/cleanupExtra.test.js).
 *
 * Imports from Zotero, Jurism and CSL-based tools leave fields that have no home in the item type
 * in Extra, one "Label: value" per line, with labels that differ in case and spelling
 * ("Volume Title", "volume-title", "Book-title", "collection-title"). Editors are written
 * "Editor: Last || First". This module reads those lines into named parts and works out which
 * lines it used, so the rest of Extra can be kept exactly as it was.
 */
(function (root) {
	/**
	 * Normalized label -> what it means here
	 *
	 * Labels are normalized by lowercasing and turning runs of spaces, underscores and hyphens
	 * into one hyphen.
	 */
	const LABELS = {
		'collection': 'series',
		'collection-title': 'series',
		'series': 'series',
		'series-title': 'series',
		'container-title': 'container',
		'book-title': 'container',
		'booktitle': 'container',
		'container': 'container',
		'volume-title': 'volumeTitle',
		'pages': 'pages',
		'page': 'pages',
		'editor': 'editor',
		'contributor': 'contributor'
	};


	function normalizeLabel(label) {
		return String(label || '').trim().toLowerCase().replace(/[\s_-]+/g, '-');
	}


	/**
	 * Split Extra into lines and label them
	 *
	 * @param {String} extra
	 * @return {{ index: Number, text: String, label: String|null, norm: String|null,
	 *     value: String|null }[]} - One entry per line. label is null on lines that aren't
	 *     "Label: value".
	 */
	function parseLines(extra) {
		return String(extra || '').split(/\r?\n/).map((text, index) => {
			let m = /^\s*([A-Za-z][A-Za-z0-9 _-]{0,40}?)\s*:\s*(.+?)\s*$/.exec(text);
			// "mlz-alternates: {json}" and URLs ("https://...") are not labels we read
			if (!m || /^\/\//.test(m[2])) {
				return { index, text, label: null, norm: null, value: null };
			}
			return { index, text, label: m[1], norm: normalizeLabel(m[1]), value: m[2] };
		});
	}


	/**
	 * "Dekkers || Eligius" -> { lastName: 'Dekkers', firstName: 'Eligius' }
	 * A name without "||" is a single-field name.
	 *
	 * @return {{ lastName: String, firstName: String, fieldMode: Number }|null}
	 */
	function parseCreator(value) {
		let parts = String(value || '').split('||').map(s => s.trim());
		if (parts.length >= 2 && parts[0] && parts[1]) {
			return { lastName: parts[0], firstName: parts[1], fieldMode: 0 };
		}
		let name = parts[0];
		return name ? { lastName: name, firstName: '', fieldMode: 1 } : null;
	}


	/**
	 * Read the parts of Extra that matter for cleaning up edition records
	 *
	 * Where a part appears on several lines (for example both "collection" and "collection-title"
	 * with the same text), the first one is used and every line with the same text is marked as
	 * used. Lines with a different text stay in Extra and are reported in `conflicts`, so nothing
	 * is lost silently.
	 *
	 * @param {String} extra
	 * @return {{
	 *     series: String|null, container: String|null, volumeTitle: String|null,
	 *     pages: String|null, editors: Object[], contributors: Object[], lines: Object,
	 *     used: Set<Number>, conflicts: String[]
	 * }} - `used` holds the line indexes that can be removed once the data has moved. Contributor
	 *     lines are in `used` too; a caller that doesn't use them takes `lines.contributors` out.
	 */
	function extractEdition(extra) {
		let result = {
			series: null,
			container: null,
			volumeTitle: null,
			pages: null,
			editors: [],
			contributors: [],
			lines: { series: [], container: [], volumeTitle: [], pages: [], contributors: [] },
			used: new Set(),
			conflicts: []
		};
		for (let line of parseLines(extra)) {
			let part = line.norm && LABELS[line.norm];
			if (!part) continue;
			if (part === 'editor' || part === 'contributor') {
				let creator = parseCreator(line.value);
				if (!creator) continue;
				let list = part === 'editor' ? result.editors : result.contributors;
				let seen = list.some(e => e.lastName === creator.lastName
					&& e.firstName === creator.firstName);
				if (!seen) {
					list.push(creator);
				}
				result.used.add(line.index);
				if (part === 'contributor') result.lines.contributors.push(line.index);
				continue;
			}
			if (result[part] === null) {
				result[part] = line.value;
				result.used.add(line.index);
				result.lines[part].push(line.index);
			}
			else if (sameText(result[part], line.value)) {
				result.used.add(line.index);
				result.lines[part].push(line.index);
			}
			else {
				result.conflicts.push(`${line.label}: ${line.value}`);
			}
		}
		return result;
	}


	function sameText(a, b) {
		return foldText(a) === foldText(b);
	}


	/** Lowercase, remove accents, markup and punctuation: for comparing titles, not for display */
	function foldText(text) {
		return String(text || '')
			.replace(/<[^>]*>/g, '')
			.normalize('NFD').replace(/[̀-ͯ]/g, '')
			.toLowerCase()
			.replace(/[^\p{L}\p{N}]+/gu, ' ')
			.trim();
	}


	/**
	 * Extra with the given lines removed and blank lines at the ends trimmed
	 */
	function removeLines(extra, indexes) {
		let kept = String(extra || '').split(/\r?\n/).filter((_, i) => !indexes.has(i));
		while (kept.length && !kept[0].trim()) kept.shift();
		while (kept.length && !kept[kept.length - 1].trim()) kept.pop();
		return kept.join('\n');
	}


	/** Extra with "Label: value" lines added at the end (a value that is already there is skipped) */
	function appendLines(extra, lines) {
		let existing = String(extra || '').replace(/\s+$/, '');
		let have = new Set(existing.split(/\r?\n/).map(l => l.trim()));
		let add = lines
			.map(l => String(l).replace(/\s*[\r\n]+\s*/g, ' ').trim())
			.filter(l => l && !have.has(l));
		return [existing, ...add].filter(Boolean).join('\n');
	}


	let api = {
		normalizeLabel,
		parseLines,
		parseCreator,
		extractEdition,
		foldText,
		sameText,
		removeLines,
		appendLines
	};

	if (typeof module !== 'undefined' && module.exports) {
		module.exports = api;
	}
	else if (root) {
		root.CleanupExtra = api;
	}
})(typeof Zotero !== 'undefined' ? Zotero : null);

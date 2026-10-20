"use strict";

/**
 * Knowledge of the CSL 1.0.2 grammar that the visual style editor needs: which elements exist,
 * what each may contain, which attributes each takes and what values those attributes accept
 *
 * This is deliberately data, not code, so the editor's inspector can build its forms from it. It
 * is a guide for editing, not a validator -- the real check is Zotero.Styles.validate(), which
 * the editor runs on every change. Where the two disagree, the validator wins.
 *
 * Nothing here touches Zotero or the DOM, so it can be tested in plain Node
 * (see fork/test/cslSchema.test.js).
 */
(function (root) {
	const CSL_NAMESPACE = 'http://purl.org/net/xbiblio/csl';

	/** Strip a namespace prefix: 'cs:text' -> 'text' */
	function localName(name) {
		let i = String(name).indexOf(':');
		return i === -1 ? String(name) : String(name).slice(i + 1);
	}

	//
	// Attribute groups shared by many elements
	//

	const BOOL = ['true', 'false'];

	const AFFIXES = {
		prefix: { type: 'text', label: 'Prefix' },
		suffix: { type: 'text', label: 'Suffix' }
	};

	const FORMATTING = {
		'font-style': { type: 'enum', values: ['normal', 'italic', 'oblique'], label: 'Font style' },
		'font-variant': { type: 'enum', values: ['normal', 'small-caps'], label: 'Font variant' },
		'font-weight': { type: 'enum', values: ['normal', 'bold', 'light'], label: 'Font weight' },
		'text-decoration': { type: 'enum', values: ['none', 'underline'], label: 'Underline' },
		'vertical-align': { type: 'enum', values: ['baseline', 'sup', 'sub'], label: 'Vertical align' }
	};

	const TEXT_CASE = {
		'text-case': {
			type: 'enum',
			values: ['lowercase', 'uppercase', 'capitalize-first', 'capitalize-all', 'title', 'sentence'],
			label: 'Text case'
		}
	};

	const DISPLAY = {
		display: {
			type: 'enum',
			values: ['block', 'left-margin', 'right-inline', 'indent'],
			label: 'Display'
		}
	};

	const STRIP_PERIODS = {
		'strip-periods': { type: 'enum', values: BOOL, label: 'Strip periods' }
	};

	const QUOTES = {
		quotes: { type: 'enum', values: BOOL, label: 'Quotes' }
	};

	const DELIMITER = {
		delimiter: { type: 'text', label: 'Delimiter' }
	};

	/** Attributes that configure how names are shown; valid on style, citation, bibliography, names, name */
	const NAME_OPTIONS = {
		'and': { type: 'enum', values: ['text', 'symbol'], label: '"and" word' },
		'delimiter-precedes-et-al': {
			type: 'enum',
			values: ['contextual', 'after-inverted-name', 'always', 'never'],
			label: 'Delimiter before et al.'
		},
		'delimiter-precedes-last': {
			type: 'enum',
			values: ['contextual', 'after-inverted-name', 'always', 'never'],
			label: 'Delimiter before last name'
		},
		'et-al-min': { type: 'integer', label: 'Et al. when more than' },
		'et-al-use-first': { type: 'integer', label: 'Names to show before et al.' },
		'et-al-use-last': { type: 'enum', values: BOOL, label: 'Show last name after et al.' },
		'et-al-subsequent-min': { type: 'integer', label: 'Et al. when more than (subsequent cites)' },
		'et-al-subsequent-use-first': {
			type: 'integer',
			label: 'Names to show before et al. (subsequent cites)'
		},
		'initialize': { type: 'enum', values: BOOL, label: 'Initialize given names' },
		'initialize-with': { type: 'text', label: 'Initialize with' },
		'name-as-sort-order': { type: 'enum', values: ['first', 'all'], label: 'Family name first' },
		'sort-separator': { type: 'text', label: 'Sort separator' }
	};

	const VARIABLES = {
		standard: [
			'abstract', 'annote', 'archive', 'archive_collection', 'archive_location', 'archive-place',
			'authority', 'call-number', 'citation-key', 'citation-label', 'collection-title',
			'container-title', 'container-title-short', 'dimensions', 'DOI', 'event', 'event-title',
			'event-place', 'genre', 'ISBN', 'ISSN', 'jurisdiction', 'keyword', 'language', 'license',
			'medium', 'note', 'original-publisher', 'original-publisher-place', 'original-title',
			'part-title', 'PMCID', 'PMID', 'publisher', 'publisher-place', 'references',
			'reviewed-genre', 'reviewed-title', 'scale', 'source', 'status', 'title', 'title-short',
			'URL', 'volume-title', 'year-suffix'
		],
		number: [
			'chapter-number', 'citation-number', 'collection-number', 'edition',
			'first-reference-note-number', 'issue', 'locator', 'number', 'number-of-pages',
			'number-of-volumes', 'page', 'page-first', 'part', 'printing', 'section', 'supplement',
			'version', 'volume'
		],
		date: ['accessed', 'available-date', 'event-date', 'issued', 'original-date', 'submitted'],
		names: [
			'author', 'chair', 'collection-editor', 'compiler', 'composer', 'container-author',
			'contributor', 'curator', 'director', 'editor', 'editorial-director', 'editor-translator',
			'executive-producer', 'guest', 'host', 'illustrator', 'interviewer', 'narrator',
			'organizer', 'original-author', 'performer', 'producer', 'recipient', 'reviewed-author',
			'script-writer', 'series-creator', 'translator'
		]
	};

	const ITEM_TYPES = [
		'article', 'article-journal', 'article-magazine', 'article-newspaper', 'bill', 'book',
		'broadcast', 'chapter', 'classic', 'collection', 'dataset', 'document', 'entry',
		'entry-dictionary', 'entry-encyclopedia', 'event', 'figure', 'graphic', 'hearing',
		'interview', 'legal_case', 'legislation', 'manuscript', 'map', 'motion_picture',
		'musical_score', 'pamphlet', 'paper-conference', 'patent', 'performance', 'periodical',
		'personal_communication', 'post', 'post-weblog', 'regulation', 'report', 'review',
		'review-book', 'software', 'song', 'speech', 'standard', 'thesis', 'treaty', 'webpage'
	];

	/** Terms people commonly use; the term list in CSL is open-ended, so this only seeds suggestions */
	const COMMON_TERMS = [
		'accessed', 'and', 'and others', 'at', 'available at', 'by', 'circa', 'cited', 'edition',
		'editor', 'et-al', 'forthcoming', 'from', 'ibid', 'in', 'in press', 'internet', 'no date',
		'online', 'page', 'paragraph', 'retrieved', 'section', 'translator', 'verse', 'volume',
		'line', 'book', 'chapter', 'folio', 'opus'
	];

	const ALL_VARIABLES = [].concat(
		VARIABLES.standard, VARIABLES.number, VARIABLES.date, VARIABLES.names
	);

	function variableKind(variable) {
		for (let kind of Object.keys(VARIABLES)) {
			if (VARIABLES[kind].includes(variable)) return kind;
		}
		return null;
	}

	/** The CSL elements that produce output; allowed inside layout, macro, group, if, else, etc. */
	const RENDERING = ['text', 'number', 'label', 'names', 'date', 'group', 'choose'];

	/**
	 * Per-element description.
	 *
	 *   label     Human name shown in the editor
	 *   children  Element names that may appear inside it
	 *   attrs     Attribute specs: { type: 'text' | 'enum' | 'integer', values?, label }
	 *   leaf      Holds text rather than elements (or nothing)
	 *   rendering Produces output (it can be added from the "Add" menu)
	 */
	const ELEMENTS = {
		style: {
			label: 'Style',
			children: ['info', 'locale', 'macro', 'citation', 'bibliography'],
			attrs: Object.assign({
				'class': { type: 'enum', values: ['in-text', 'note'], label: 'Class' },
				version: { type: 'text', label: 'CSL version' },
				'default-locale': { type: 'text', label: 'Default locale' },
				'demote-non-dropping-particle': {
					type: 'enum',
					values: ['never', 'sort-only', 'display-and-sort'],
					label: 'Demote non-dropping particle'
				},
				'initialize-with-hyphen': { type: 'enum', values: BOOL, label: 'Hyphen in initials' },
				'page-range-format': {
					type: 'enum',
					values: ['expanded', 'minimal', 'minimal-two', 'chicago', 'chicago-15', 'chicago-16'],
					label: 'Page range format'
				}
			}, NAME_OPTIONS, {
				'names-delimiter': { type: 'text', label: 'Delimiter between names lists' },
				'name-delimiter': { type: 'text', label: 'Delimiter between names' }
			})
		},
		info: {
			label: 'Style information',
			children: [
				'author', 'contributor', 'category', 'id', 'issn', 'eissn', 'issnl', 'link',
				'published', 'rights', 'summary', 'title', 'title-short', 'updated'
			],
			attrs: {}
		},
		locale: {
			label: 'Locale overrides',
			children: ['style-options', 'terms', 'date'],
			attrs: { 'xml:lang': { type: 'text', label: 'Language' } }
		},
		macro: {
			label: 'Macro',
			children: RENDERING,
			attrs: { name: { type: 'text', label: 'Name' } },
			rendering: false
		},
		citation: {
			label: 'In-text citation',
			children: ['sort', 'layout'],
			attrs: Object.assign({
				'disambiguate-add-names': { type: 'enum', values: BOOL, label: 'Disambiguate by adding names' },
				'disambiguate-add-givenname': {
					type: 'enum', values: BOOL, label: 'Disambiguate by adding given names'
				},
				'givenname-disambiguation-rule': {
					type: 'enum',
					values: [
						'all-names', 'all-names-with-initials', 'primary-name',
						'primary-name-with-initials', 'by-cite'
					],
					label: 'Given-name rule'
				},
				'disambiguate-add-year-suffix': { type: 'enum', values: BOOL, label: 'Add year suffix (2020a)' },
				'cite-group-delimiter': { type: 'text', label: 'Delimiter within grouped cites' },
				collapse: {
					type: 'enum',
					values: ['citation-number', 'year', 'year-suffix', 'year-suffix-ranged'],
					label: 'Collapse'
				},
				'year-suffix-delimiter': { type: 'text', label: 'Year-suffix delimiter' },
				'after-collapse-delimiter': { type: 'text', label: 'Delimiter after collapsed group' },
				'near-note-distance': { type: 'integer', label: 'Near-note distance' }
			}, NAME_OPTIONS)
		},
		bibliography: {
			label: 'Bibliography',
			children: ['sort', 'layout'],
			attrs: Object.assign({
				'hanging-indent': { type: 'enum', values: BOOL, label: 'Hanging indent' },
				'second-field-align': { type: 'enum', values: ['flush', 'margin'], label: 'Second-field align' },
				'line-spacing': { type: 'integer', label: 'Line spacing' },
				'entry-spacing': { type: 'integer', label: 'Entry spacing' },
				'subsequent-author-substitute': { type: 'text', label: 'Replace repeated author with' },
				'subsequent-author-substitute-rule': {
					type: 'enum',
					values: [
						'complete-all', 'complete-each', 'partial-each', 'partial-first'
					],
					label: 'Repeated-author rule'
				}
			}, NAME_OPTIONS)
		},
		layout: {
			label: 'Layout',
			children: RENDERING,
			attrs: Object.assign({}, AFFIXES, DELIMITER, FORMATTING)
		},
		sort: {
			label: 'Sort order',
			children: ['key'],
			attrs: {}
		},
		key: {
			label: 'Sort key',
			children: [],
			leaf: true,
			attrs: {
				variable: { type: 'variable', label: 'Variable' },
				macro: { type: 'macro', label: 'Macro' },
				sort: { type: 'enum', values: ['ascending', 'descending'], label: 'Direction' },
				'names-min': { type: 'integer', label: 'Names (min)' },
				'names-use-first': { type: 'integer', label: 'Names (use first)' },
				'names-use-last': { type: 'enum', values: BOOL, label: 'Names (use last)' }
			}
		},
		text: {
			label: 'Text',
			children: [],
			leaf: true,
			rendering: true,
			attrs: Object.assign({
				variable: { type: 'variable', label: 'Variable' },
				macro: { type: 'macro', label: 'Macro' },
				term: { type: 'term', label: 'Term' },
				value: { type: 'text', label: 'Literal text' },
				form: {
					type: 'enum',
					values: ['long', 'short', 'verb', 'verb-short', 'symbol'],
					label: 'Form'
				},
				plural: { type: 'enum', values: BOOL, label: 'Plural' }
			}, QUOTES, STRIP_PERIODS, TEXT_CASE, AFFIXES, FORMATTING, DISPLAY)
		},
		number: {
			label: 'Number',
			children: [],
			leaf: true,
			rendering: true,
			attrs: Object.assign({
				variable: { type: 'variable', label: 'Variable' },
				form: {
					type: 'enum',
					values: ['numeric', 'ordinal', 'long-ordinal', 'roman'],
					label: 'Form'
				}
			}, TEXT_CASE, AFFIXES, FORMATTING, DISPLAY)
		},
		label: {
			label: 'Label',
			children: [],
			leaf: true,
			rendering: true,
			attrs: Object.assign({
				variable: { type: 'variable', label: 'Variable' },
				form: { type: 'enum', values: ['long', 'short', 'symbol'], label: 'Form' },
				plural: { type: 'enum', values: ['contextual', 'always', 'never'], label: 'Plural' }
			}, STRIP_PERIODS, TEXT_CASE, AFFIXES, FORMATTING)
		},
		names: {
			label: 'Names',
			children: ['name', 'et-al', 'label', 'substitute'],
			rendering: true,
			attrs: Object.assign({
				variable: { type: 'variable', label: 'Variables' }
			}, DELIMITER, NAME_OPTIONS, AFFIXES, FORMATTING, DISPLAY)
		},
		name: {
			label: 'Name format',
			children: ['name-part'],
			attrs: Object.assign({
				form: { type: 'enum', values: ['long', 'short', 'count'], label: 'Form' }
			}, DELIMITER, NAME_OPTIONS, AFFIXES, FORMATTING)
		},
		'name-part': {
			label: 'Name part',
			children: [],
			leaf: true,
			attrs: Object.assign({
				name: { type: 'enum', values: ['given', 'family'], label: 'Part' }
			}, TEXT_CASE, AFFIXES, FORMATTING)
		},
		'et-al': {
			label: 'Et al.',
			children: [],
			leaf: true,
			attrs: Object.assign({
				term: { type: 'enum', values: ['et-al', 'and others'], label: 'Term' }
			}, FORMATTING)
		},
		substitute: {
			label: 'Substitute if empty',
			children: RENDERING.concat(['name', 'et-al']),
			attrs: {}
		},
		date: {
			label: 'Date',
			children: ['date-part'],
			rendering: true,
			attrs: Object.assign({
				variable: { type: 'variable', label: 'Variable' },
				form: { type: 'enum', values: ['text', 'numeric'], label: 'Form' },
				'date-parts': {
					type: 'enum', values: ['year', 'year-month', 'year-month-day'], label: 'Parts shown'
				}
			}, DELIMITER, TEXT_CASE, AFFIXES, FORMATTING, DISPLAY)
		},
		'date-part': {
			label: 'Date part',
			children: [],
			leaf: true,
			attrs: Object.assign({
				name: { type: 'enum', values: ['day', 'month', 'year'], label: 'Part' },
				form: {
					type: 'enum',
					values: ['numeric', 'numeric-leading-zeros', 'ordinal', 'long', 'short'],
					label: 'Form'
				},
				'range-delimiter': { type: 'text', label: 'Range delimiter' }
			}, STRIP_PERIODS, TEXT_CASE, AFFIXES, FORMATTING)
		},
		group: {
			label: 'Group',
			children: RENDERING,
			rendering: true,
			attrs: Object.assign({}, DELIMITER, AFFIXES, FORMATTING, DISPLAY)
		},
		choose: {
			label: 'Choose',
			children: ['if', 'else-if', 'else'],
			rendering: true,
			attrs: {}
		},
		'if': {
			label: 'If',
			children: RENDERING,
			attrs: conditionAttrs()
		},
		'else-if': {
			label: 'Else if',
			children: RENDERING,
			attrs: conditionAttrs()
		},
		'else': {
			label: 'Else',
			children: RENDERING,
			attrs: {}
		}
	};

	function conditionAttrs() {
		return {
			type: { type: 'item-types', label: 'Item type is' },
			variable: { type: 'variables', label: 'Variable is set' },
			'is-numeric': { type: 'variables', label: 'Variable is numeric' },
			'is-uncertain-date': { type: 'variables', label: 'Date is uncertain' },
			locator: {
				type: 'text', label: 'Locator type is'
			},
			position: {
				type: 'enum-multi',
				values: ['first', 'subsequent', 'ibid', 'ibid-with-locator', 'near-note'],
				label: 'Citation position'
			},
			disambiguate: { type: 'enum', values: ['true'], label: 'Disambiguation' },
			match: { type: 'enum', values: ['all', 'any', 'none'], label: 'Match' }
		};
	}

	/** Metadata-only children of cs:info, shown as simple fields in the editor */
	const INFO_FIELDS = ['title', 'title-short', 'id', 'summary', 'rights', 'updated'];

	/**
	 * The attribute specs that apply to an element, in display order, grouped for the inspector:
	 * { main: [...], formatting: [...], affixes: [...], names: [...] }
	 */
	function groupAttrs(elementName) {
		let spec = ELEMENTS[localName(elementName)];
		let out = { main: [], affixes: [], formatting: [], names: [] };
		if (!spec) return out;
		for (let [name, a] of Object.entries(spec.attrs)) {
			let entry = Object.assign({ name }, a);
			if (name in FORMATTING || name in TEXT_CASE || name in STRIP_PERIODS || name in QUOTES) {
				out.formatting.push(entry);
			}
			else if (name in AFFIXES || name === 'delimiter') {
				// Punctuation: shown together, always in the order prefix, suffix, delimiter
				out.affixes.push(entry);
			}
			else if (name in NAME_OPTIONS) {
				out.names.push(entry);
			}
			else {
				out.main.push(entry);
			}
		}
		let punctuationOrder = ['prefix', 'suffix', 'delimiter'];
		out.affixes.sort((a, b) => punctuationOrder.indexOf(a.name) - punctuationOrder.indexOf(b.name));
		return out;
	}

	function getElement(name) {
		return ELEMENTS[localName(name)] || null;
	}

	/** True if `child` may be placed directly inside `parent` */
	function canContain(parentName, childName) {
		let parent = getElement(parentName);
		if (!parent) return false;
		return parent.children.includes(localName(childName));
	}

	/** Elements that can be added inside `parentName` from the "Add" menu */
	function addableChildren(parentName) {
		let parent = getElement(parentName);
		if (!parent) return [];
		let out = parent.children.filter((n) => {
			let el = ELEMENTS[n];
			return el && (el.rendering || ['name', 'et-al', 'label', 'name-part', 'date-part', 'key',
				'sort', 'if', 'else-if', 'else', 'substitute'].includes(n));
		});
		// 'macro' is added at the style level
		if (localName(parentName) === 'style') out.push('macro');
		return out;
	}

	const api = {
		CSL_NAMESPACE,
		ELEMENTS,
		VARIABLES,
		ALL_VARIABLES,
		ITEM_TYPES,
		COMMON_TERMS,
		RENDERING,
		INFO_FIELDS,
		FORMATTING,
		AFFIXES,
		NAME_OPTIONS,
		localName,
		variableKind,
		getElement,
		groupAttrs,
		canContain,
		addableChildren
	};

	if (typeof module !== 'undefined' && module.exports) {
		module.exports = api;
	}
	else if (root) {
		root.CSLSchema = api;
	}
})(typeof Zotero !== 'undefined' ? Zotero : null);

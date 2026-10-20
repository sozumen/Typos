"use strict";

/**
 * Starting points for new citation styles, and helpers for naming them
 *
 * The visual editor uses these for "New style", and the AI style writer starts from one so that
 * what it produces is always a complete, valid CSL file rather than a fragment.
 *
 * Three kinds: 'author-date' ("Smith 2020" in the text), 'numeric' ("[1]" in the text) and 'note'
 * (footnotes, with a full first note and shortened later ones). They are plain and
 * unopinionated; the point is a working structure to edit, not any publisher's rules.
 *
 * Tested in plain Node: fork/test/cslTemplates.test.js
 */
(function (root) {
	const KINDS = {
		'author-date': {
			label: 'Author-date',
			description: 'In-text citations like (Smith 2020, 45), with an alphabetical bibliography'
		},
		'numeric': {
			label: 'Numeric',
			description: 'In-text citations like [1], with a numbered bibliography'
		},
		'note': {
			label: 'Notes and bibliography',
			description: 'Footnote citations (full first note, short later notes), with a bibliography'
		}
	};

	const ID_PREFIX = 'http://typos.local/styles/';

	function escapeXML(str) {
		return String(str)
			.replace(/&/g, '&amp;')
			.replace(/</g, '&lt;')
			.replace(/>/g, '&gt;')
			.replace(/"/g, '&quot;');
	}

	function slugify(str) {
		let slug = String(str || '')
			.normalize('NFKD')
			.replace(/[̀-ͯ]/g, '')
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, '-')
			.replace(/^-+|-+$/g, '');
		return slug || 'untitled-style';
	}

	/**
	 * An ID for a style that doesn't collide with any in `existingIds`
	 * @param {String} title
	 * @param {Iterable<String>} [existingIds]
	 */
	function makeStyleId(title, existingIds = []) {
		let taken = new Set(existingIds);
		let base = ID_PREFIX + slugify(title);
		let id = base;
		for (let n = 2; taken.has(id); n++) id = `${base}-${n}`;
		return id;
	}

	// Macros shared by all three templates
	const MACROS_COMMON = `
  <macro name="author">
    <names variable="author">
      <name and="text" name-as-sort-order="first" sort-separator=", " delimiter=", " delimiter-precedes-last="always" initialize-with=". "/>
      <substitute>
        <names variable="editor"/>
        <names variable="translator"/>
        <text macro="title"/>
      </substitute>
    </names>
  </macro>
  <macro name="title">
    <choose>
      <if type="article-journal article-magazine article-newspaper chapter paper-conference entry-encyclopedia entry-dictionary webpage post-weblog" match="any">
        <text variable="title" quotes="true"/>
      </if>
      <else>
        <text variable="title" font-style="italic"/>
      </else>
    </choose>
  </macro>
  <macro name="issued-year">
    <date variable="issued">
      <date-part name="year"/>
    </date>
  </macro>
  <macro name="container">
    <choose>
      <if type="article-journal article-magazine article-newspaper chapter paper-conference entry-encyclopedia entry-dictionary" match="any">
        <group delimiter=" ">
          <text term="in" text-case="capitalize-first"/>
          <text variable="container-title" font-style="italic"/>
        </group>
      </if>
    </choose>
  </macro>
  <macro name="publisher">
    <group delimiter=": ">
      <text variable="publisher-place"/>
      <text variable="publisher"/>
    </group>
  </macro>
  <macro name="locator">
    <group delimiter=" ">
      <label variable="locator" form="short"/>
      <text variable="locator"/>
    </group>
  </macro>
  <macro name="access">
    <choose>
      <if variable="DOI">
        <text variable="DOI" prefix="https://doi.org/"/>
      </if>
      <else-if variable="URL">
        <text variable="URL"/>
      </else-if>
    </choose>
  </macro>`;

	// For styles that cite by author name (not the numeric one)
	const MACRO_AUTHOR_SHORT = `
  <macro name="author-short">
    <names variable="author">
      <name form="short" and="text" delimiter=", " initialize-with=". "/>
      <substitute>
        <names variable="editor"/>
        <names variable="translator"/>
        <text variable="title-short" font-style="italic"/>
      </substitute>
    </names>
  </macro>`;

	function header(cls, opts) {
		let title = escapeXML(opts.title);
		let id = escapeXML(opts.id);
		let updated = escapeXML(opts.updated);
		return `<?xml version="1.0" encoding="utf-8"?>
<style xmlns="http://purl.org/net/xbiblio/csl" class="${cls}" version="1.0" default-locale="${escapeXML(opts.locale)}" demote-non-dropping-particle="never" page-range-format="expanded">
  <info>
    <title>${title}</title>
    <id>${id}</id>
    <updated>${updated}</updated>
  </info>`;
	}

	function authorDate(opts) {
		return `${header('in-text', opts)}${MACROS_COMMON}${MACRO_AUTHOR_SHORT}
  <citation et-al-min="3" et-al-use-first="1" disambiguate-add-year-suffix="true" disambiguate-add-names="true" disambiguate-add-givenname="true" collapse="year">
    <sort>
      <key macro="author-short"/>
      <key macro="issued-year"/>
    </sort>
    <layout prefix="(" suffix=")" delimiter="; ">
      <group delimiter=", ">
        <group delimiter=" ">
          <text macro="author-short"/>
          <text macro="issued-year"/>
        </group>
        <text macro="locator"/>
      </group>
    </layout>
  </citation>
  <bibliography hanging-indent="true" et-al-min="8" et-al-use-first="6" subsequent-author-substitute="———" subsequent-author-substitute-rule="complete-all">
    <sort>
      <key macro="author"/>
      <key macro="issued-year"/>
      <key variable="title"/>
    </sort>
    <layout suffix=".">
      <group delimiter=". ">
        <text macro="author"/>
        <text macro="issued-year"/>
        <text macro="title"/>
        <text macro="container"/>
        <group delimiter=", ">
          <text variable="volume"/>
          <text variable="page"/>
        </group>
        <text macro="publisher"/>
        <text macro="access"/>
      </group>
    </layout>
  </bibliography>
</style>
`;
	}

	function numeric(opts) {
		return `${header('in-text', opts)}${MACROS_COMMON}
  <citation collapse="citation-number">
    <sort>
      <key variable="citation-number"/>
    </sort>
    <layout prefix="[" suffix="]" delimiter=", ">
      <group delimiter=", ">
        <text variable="citation-number"/>
        <text macro="locator"/>
      </group>
    </layout>
  </citation>
  <bibliography entry-spacing="0" et-al-min="8" et-al-use-first="6">
    <layout suffix=".">
      <group delimiter=" ">
        <text variable="citation-number" prefix="[" suffix="]"/>
        <group delimiter=". ">
          <text macro="author"/>
          <text macro="title"/>
          <text macro="container"/>
          <group delimiter=", ">
            <text variable="volume"/>
            <text variable="page"/>
            <text macro="issued-year"/>
          </group>
          <text macro="publisher"/>
          <text macro="access"/>
        </group>
      </group>
    </layout>
  </bibliography>
</style>
`;
	}

	function note(opts) {
		return `${header('note', opts)}${MACROS_COMMON}${MACRO_AUTHOR_SHORT}
  <macro name="note-full">
    <group delimiter=", ">
      <text macro="author"/>
      <text macro="title"/>
      <text macro="container"/>
      <group delimiter=", ">
        <text variable="volume"/>
        <text macro="publisher"/>
        <text macro="issued-year"/>
      </group>
      <text macro="locator"/>
    </group>
  </macro>
  <macro name="note-short">
    <group delimiter=", ">
      <text macro="author-short"/>
      <text variable="title-short" font-style="italic"/>
      <text macro="locator"/>
    </group>
  </macro>
  <citation et-al-min="4" et-al-use-first="1">
    <layout suffix="." delimiter="; ">
      <choose>
        <if position="ibid-with-locator">
          <group delimiter=", ">
            <text term="ibid" text-case="capitalize-first"/>
            <text macro="locator"/>
          </group>
        </if>
        <else-if position="ibid">
          <text term="ibid" text-case="capitalize-first"/>
        </else-if>
        <else-if position="subsequent">
          <text macro="note-short"/>
        </else-if>
        <else>
          <text macro="note-full"/>
        </else>
      </choose>
    </layout>
  </citation>
  <bibliography hanging-indent="true" subsequent-author-substitute="———" subsequent-author-substitute-rule="complete-all">
    <sort>
      <key macro="author"/>
      <key variable="title"/>
    </sort>
    <layout suffix=".">
      <group delimiter=". ">
        <text macro="author"/>
        <text macro="title"/>
        <text macro="container"/>
        <group delimiter=", ">
          <text variable="volume"/>
          <text variable="page"/>
        </group>
        <group delimiter=", ">
          <text macro="publisher"/>
          <text macro="issued-year"/>
        </group>
        <text macro="access"/>
      </group>
    </layout>
  </bibliography>
</style>
`;
	}

	const BUILDERS = { 'author-date': authorDate, 'numeric': numeric, 'note': note };

	/**
	 * The XML of a new style
	 * @param {String} kind - 'author-date', 'numeric' or 'note'
	 * @param {Object} [options]
	 * @param {String} [options.title='Untitled style']
	 * @param {String} [options.id] - Defaults to one made from the title
	 * @param {String} [options.locale='en-US']
	 * @param {String} [options.updated] - ISO date-time; defaults to now
	 */
	function newStyleXML(kind, options = {}) {
		if (!BUILDERS[kind]) throw new Error(`Unknown style kind: ${kind}`);
		let title = options.title || 'Untitled style';
		return BUILDERS[kind]({
			title,
			id: options.id || makeStyleId(title),
			locale: options.locale || 'en-US',
			updated: options.updated || new Date().toISOString()
		});
	}

	const api = { KINDS, ID_PREFIX, slugify, makeStyleId, newStyleXML };

	if (typeof module !== 'undefined' && module.exports) {
		module.exports = api;
	}
	else if (root) {
		root.CSLTemplates = api;
	}
})(typeof Zotero !== 'undefined' ? Zotero : null);

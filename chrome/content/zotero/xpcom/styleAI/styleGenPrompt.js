"use strict";

/**
 * What to tell Claude when asking it to write a citation style, and how to read what comes back
 *
 * Nothing here makes a network call or touches Zotero, so it can be tested in plain Node
 * (fork/test/styleGenPrompt.test.js). Calling the API is claudeClient.js; the write, check and
 * repair loop is styleGenerator.js.
 *
 * A style is asked for as one complete CSL file in an ```xml block, followed by notes on the
 * assumptions made. Starting every request from a working skeleton (cslTemplates.js) is what keeps
 * the results valid; the model adapts a structure rather than inventing one.
 */
(function (root) {
	const isNode = typeof module !== 'undefined' && module.exports;
	const Schema = isNode ? require('../styleEditor/cslSchema.js') : root.CSLSchema;
	const Tree = isNode ? require('../styleEditor/cslTree.js') : root.CSLTree;
	const Templates = isNode ? require('../styleEditor/cslTemplates.js') : root.CSLTemplates;

	// Limits chosen to keep a request inside what the API accepts, with room for the reply
	const MAX_MANUAL_CHARS = 400000;
	const MAX_PDF_BYTES = 24 * 1024 * 1024;
	const MAX_EXAMPLE_CHARS = 60000;

	class InputError extends Error {
		constructor(message) {
			super(message);
			this.name = 'InputError';
		}
	}

	class NoStyleError extends Error {
		constructor(message) {
			super(message);
			this.name = 'NoStyleError';
		}
	}

	function system() {
		return `You write citation styles in Citation Style Language (CSL) 1.0.2 for a reference manager used by scholars of classical and ancient texts. You are precise and conservative: you follow the rules you are given, and you say so when something cannot be expressed in CSL.

# How to reply

Reply with ONE complete CSL file inside a single \`\`\`xml code block: a whole <style> document, never a fragment or a diff. Say nothing before the code block. After it, add a short list headed "Notes" (at most eight lines) covering assumptions you made, rules from the source material that CSL cannot express, and anything the person should check against their manual.

# How to build the style

- Start from the skeleton you are given and adapt it. Keep its overall structure (info, macros, citation, bibliography) unless the style truly needs something different.
- Use only CSL 1.0.2 elements, attributes and values. Never invent an attribute. The most common mistakes: attributes that don't exist (such as if-missing), the wrong values for form or text-case, a text element with more than one of variable, macro, term and value, and macros that are called but never defined.
- Every macro you call must be defined exactly once, and every macro you define must be used.
- A text element takes exactly one of variable, macro, term or value. Put literal punctuation in prefix, suffix or a group's delimiter; use value only for fixed words.
- Join parts with a group and its delimiter, not with separate punctuation elements. A group that produces no output because all its variables are empty disappears with its punctuation, which is what you want.
- In a names element the children come in this order: name, et-al, label, then substitute (always last). Name options such as and, initialize-with, name-as-sort-order, et-al-min and et-al-use-first go on name or on the citation or bibliography element.
- A choose has an if, then any number of else-if, then at most one else. The if tests are type, variable, is-numeric, locator, position (first, subsequent, ibid, ibid-with-locator, near-note) and disambiguate; match is all, any or none.
- Note styles (footnotes) use class="note" and usually give a full first note and a shortened later note by testing position in the citation layout. Author-date and numeric styles use class="in-text".
- Formatting attributes: font-style (normal, italic, oblique), font-weight (normal, bold, light), font-variant (normal, small-caps), text-decoration (none, underline), vertical-align (baseline, sup, sub); text-case (lowercase, uppercase, capitalize-first, capitalize-all, title, sentence); quotes="true".
- Put the citation sort and bibliography sort in a sort element before the layout, using keys that are macros or variables.
- The pin cite (page, line, section) arrives as the locator variable with a locator label. Render it with a label element (variable="locator", form="short") followed by text variable="locator". Citations to ancient works often have no label (for example "Il. 1.1" or "Rep. 514a"); when the source material shows that, render the locator text alone.
- Ancient and classical works are held as book-type items with the author, title, and any original date, publisher or place; do not invent variables for reference systems.

# Standard CSL variables you may use

Text: ${Schema.VARIABLES.standard.join(', ')}.
Number: ${Schema.VARIABLES.number.join(', ')}.
Date: ${Schema.VARIABLES.date.join(', ')}.
Names: ${Schema.VARIABLES.names.join(', ')}.

Item types: ${Schema.ITEM_TYPES.join(', ')}.

# Reading the source material

- A style manual states rules; examples show results. When they disagree, follow the manual and mention the difference in the Notes.
- From examples, work out each element and the punctuation between elements, systematically: names (order, initials, "and", how many before "et al."), dates, titles (italic or quoted, capitalization), container, volume, issue, pages, publisher and place, and what changes by item type. Then write rules that reproduce every example, not just the first.
- Never copy the content of an example into the style. "Smith" and "Oxford" in an example are data, not text to put in value attributes.
- Italics in pasted examples are marked with *single asterisks* and bold with **double asterisks**; small capitals with ^^double carets^^ if the person uses them.
- If a rule is ambiguous or missing, choose the most common scholarly convention for the discipline and list the choice in the Notes.`;
	}

	/** The skeleton for a new style, with the requested title, as XML text */
	function skeleton(kind, title, locale, id, updated) {
		let useKind = Templates.KINDS[kind] ? kind : 'author-date';
		return Templates.newStyleXML(useKind, { title, locale, id, updated });
	}

	function tag(name, body) {
		return `<${name}>\n${body.trim()}\n</${name}>`;
	}

	/** Why these inputs can't be sent, as a message for the person, or null if they can */
	function checkInputs(inputs) {
		let hasManual = !!(inputs.manualText && inputs.manualText.trim()) || !!inputs.manualPDF;
		let hasExamples = !!((inputs.bibExamples || '').trim() || (inputs.citeExamples || '').trim());
		let hasExtra = !!(inputs.extra || '').trim();
		if (inputs.mode === 'revise') {
			if (!inputs.baseXML) return 'There is no style to revise.';
			if (!hasManual && !hasExamples && !hasExtra) return 'Say what to change: add examples, a manual, or instructions.';
		}
		else if (!hasManual && !hasExamples && !hasExtra) {
			return 'Add a style manual, some example citations, or a description of the style.';
		}
		if (inputs.manualText && inputs.manualText.length > MAX_MANUAL_CHARS) {
			return 'The manual text is too long to send in one go. Paste only the chapters on citations and bibliographies.';
		}
		if (inputs.manualPDF) {
			let bytes = Math.floor(inputs.manualPDF.base64.length * 3 / 4);
			if (bytes > MAX_PDF_BYTES) {
				return 'The PDF is too large to send. Use a copy with only the pages on citations and bibliographies.';
			}
		}
		for (let key of ['bibExamples', 'citeExamples', 'extra']) {
			if ((inputs[key] || '').length > MAX_EXAMPLE_CHARS) return 'The examples are too long. Trim them to a representative set.';
		}
		return null;
	}

	/**
	 * The first user message, as content blocks
	 * @param {Object} inputs
	 * @param {'new'|'revise'} inputs.mode
	 * @param {String} inputs.title - Name of the style
	 * @param {String} [inputs.kind] - 'author-date', 'numeric', 'note', or 'auto'
	 * @param {String} [inputs.locale='en-US']
	 * @param {String} [inputs.manualText]
	 * @param {{ name: String, base64: String }} [inputs.manualPDF]
	 * @param {String} [inputs.bibExamples] - Example bibliography entries
	 * @param {String} [inputs.citeExamples] - Example in-text citations or notes
	 * @param {String} [inputs.extra] - Anything else the person wants
	 * @param {String} [inputs.baseXML] - The style to revise (mode 'revise')
	 * @param {String} [inputs.id]
	 * @param {String} [inputs.updated]
	 */
	function buildUserContent(inputs) {
		let problem = checkInputs(inputs);
		if (problem) throw new InputError(problem);

		let locale = inputs.locale || 'en-US';
		let blocks = [];
		if (inputs.manualPDF) {
			// Documents go before the text that refers to them
			blocks.push({
				type: 'document',
				source: { type: 'base64', media_type: 'application/pdf', data: inputs.manualPDF.base64 },
				title: inputs.manualPDF.name || 'Style manual'
			});
		}

		let parts = [];
		let kindNote = inputs.kind && inputs.kind !== 'auto' && Templates.KINDS[inputs.kind]
			? ` It should be a ${Templates.KINDS[inputs.kind].label.toLowerCase()} style.`
			: ' Decide from the material whether it is an author-date, numeric or note style.';

		if (inputs.mode === 'revise') {
			parts.push(tag('task', `Revise the CSL style below so that it follows the material provided. Keep everything that already matches. Keep its title "${inputs.title}", its id and its locale unless told otherwise. Return the complete revised file.`));
		}
		else {
			parts.push(tag('task', `Write a new CSL style titled "${inputs.title}" (default locale ${locale}) that follows the material provided.${kindNote} Adapt the skeleton below.`));
		}
		if (inputs.manualPDF) parts.push(tag('style_manual_note', 'The style manual is attached as a PDF. The rules about citations and bibliographies are what matter; ignore the rest.'));
		if (inputs.manualText && inputs.manualText.trim()) parts.push(tag('style_manual', inputs.manualText));
		if ((inputs.bibExamples || '').trim()) parts.push(tag('bibliography_examples', inputs.bibExamples));
		if ((inputs.citeExamples || '').trim()) parts.push(tag('citation_examples', inputs.citeExamples));
		if ((inputs.extra || '').trim()) parts.push(tag('additional_instructions', inputs.extra));

		if (inputs.mode === 'revise') {
			parts.push(tag('current_style', inputs.baseXML));
		}
		else {
			parts.push(tag('skeleton', skeleton(inputs.kind, inputs.title, locale, inputs.id, inputs.updated)));
		}
		blocks.push({ type: 'text', text: parts.join('\n\n') });
		return blocks;
	}

	/** A follow-up asking for the problems in the last reply to be fixed */
	function buildRepairMessage(problems) {
		let list = problems.slice(0, 15).map(p => `- ${p}`).join('\n');
		let more = problems.length > 15 ? `\n(${problems.length - 15} more not shown.)` : '';
		return `That file has problems:\n${list}${more}\n\nFix them and send the complete corrected style again in a single \`\`\`xml block, followed by the Notes list. Change nothing else.`;
	}


	//
	// Reading the reply
	//

	/**
	 * Find the style in a reply
	 * @return {{ xml: String, notes: String }}
	 * @throws {NoStyleError}
	 */
	function extractStyle(text) {
		text = String(text || '');
		let xml = null;
		let rest = '';

		let fence = /```(?:xml|csl)?[ \t]*\r?\n([\s\S]*?)```/gi;
		let match;
		while ((match = fence.exec(text))) {
			if (/<style[\s>]/.test(match[1])) {
				xml = match[1].trim();
				rest = text.slice(match.index + match[0].length);
				break;
			}
		}
		if (xml === null) {
			// No fence: take from the XML declaration or <style to the last </style>
			let start = text.search(/<\?xml[\s\S]*?\?>\s*<style[\s>]|<style[\s>]/);
			let endTag = text.lastIndexOf('</style>');
			if (start !== -1 && endTag > start) {
				xml = text.slice(start, endTag + '</style>'.length).trim();
				rest = text.slice(endTag + '</style>'.length);
			}
		}
		if (xml === null) throw new NoStyleError('The reply did not contain a style');

		let notes = rest.replace(/```/g, '').trim().replace(/^#*\s*\**notes\**:?\**\s*/i, '').trim();
		return { xml, notes };
	}

	/**
	 * Problems that the schema validator does not catch but that stop a style working: macros
	 * called but not defined, missing sections, no layout
	 * @return {String[]}
	 */
	function checkSemantics(xml) {
		let doc;
		try {
			doc = Tree.StyleDoc.fromXML(xml);
		}
		catch (e) {
			return [`The XML cannot be read: ${e.message}`];
		}
		let problems = [];
		if (Schema.localName(doc.root.name) !== 'style') problems.push('The root element must be <style>');
		if (!doc.findAll('citation').length) problems.push('The style has no <citation> section');
		let citation = doc.findAll('citation')[0];
		if (citation && !Tree.elementChildren(citation).some(c => c.name === 'layout')) {
			problems.push('The <citation> section has no <layout>');
		}
		for (let name of doc.undefinedMacros()) {
			problems.push(`Macro "${name}" is used but never defined`);
		}
		let seen = new Set();
		for (let m of doc.macros()) {
			if (seen.has(m.name)) problems.push(`Macro "${m.name}" is defined more than once`);
			seen.add(m.name);
		}
		for (let m of doc.unusedMacros()) {
			problems.push(`Macro "${m.name}" is defined but never used`);
		}
		return problems;
	}

	/**
	 * Give a generated style the identity it should have: the requested title, a fresh ID that
	 * does not clash with an installed style, and the current time; and remove links that would
	 * make it claim to be somebody else's style.
	 *
	 * @param {String} xml
	 * @param {Object} options
	 * @param {String} [options.title] - Overrides the title the model chose
	 * @param {String} [options.id] - Keep this id (used when revising)
	 * @param {Iterable<String>} [options.existingIds]
	 * @param {String} [options.now]
	 * @throws {Tree.CSLParseError}
	 */
	function finalizeStyle(xml, options = {}) {
		let doc = Tree.StyleDoc.fromXML(xml);
		if (Schema.localName(doc.root.name) !== 'style') throw new NoStyleError('The reply was not a style');
		if (!doc.findAll('info').length) throw new NoStyleError('The style has no information block');

		if (!doc.root.attrs.some(a => a.name === 'xmlns')) doc.setAttr(doc.root.id, 'xmlns', Schema.CSL_NAMESPACE);

		let title = options.title || doc.getInfo('title') || 'Untitled style';
		doc.setInfo('title', title);
		doc.setInfo('id', options.id || Templates.makeStyleId(title, options.existingIds || []));
		doc.setInfo('updated', options.now || new Date().toISOString());

		let info = doc.findAll('info')[0];
		for (let child of Tree.elementChildren(info).slice()) {
			if (child.name === 'link' && ['self', 'independent-parent', 'template'].includes(Tree.getAttr(child, 'rel'))) {
				doc.remove(child.id);
			}
		}
		return doc.toXML();
	}

	const api = {
		MAX_MANUAL_CHARS,
		MAX_PDF_BYTES,
		InputError,
		NoStyleError,
		system,
		skeleton,
		checkInputs,
		buildUserContent,
		buildRepairMessage,
		extractStyle,
		checkSemantics,
		finalizeStyle
	};

	if (isNode) {
		module.exports = api;
	}
	else if (root) {
		root.StyleGenPrompt = api;
	}
})(typeof Zotero !== 'undefined' ? Zotero : null);

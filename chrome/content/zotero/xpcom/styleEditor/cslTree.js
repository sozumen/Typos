"use strict";

/**
 * An editable model of a CSL style, for the visual style editor
 *
 * The model is a plain tree of JS objects rather than a DOM document, so the same code runs in the
 * application and in Node tests. A small XML reader and writer are included; they cover what CSL
 * files use (elements, attributes, text, comments, CDATA, entities) and report errors with a line
 * and column.
 *
 * Node shapes:
 *
 *   { id, type: 'element', name, attrs: [{ name, value }], children: [...], text }
 *   { id, type: 'comment', value }
 *   { id, type: 'text', value }        only in mixed content, which CSL practically never has
 *
 * `text` is the content of an element that holds only text (cs:term, cs:title, ...).
 *
 * Every edit goes through StyleDoc, which checks that the result is structurally sensible (the
 * parent may contain the child, a choose keeps its if/else order, macros are not orphaned or
 * double-named) and keeps an undo history. It cannot check everything the CSL schema requires;
 * the editor runs Zotero.Styles.validate() on the output for that.
 *
 * Comments outside the root element are dropped when a style is read.
 *
 * Tested in plain Node: fork/test/cslTree.test.js
 */
(function (root) {
	const Schema = (typeof module !== 'undefined' && module.exports)
		? require('./cslSchema.js')
		: root.CSLSchema;
	const { localName } = Schema;

	const MAX_DEPTH = 200;
	const MAX_UNDO = 100;

	class CSLParseError extends Error {
		constructor(reason, line, column) {
			super(`${reason} (line ${line}, column ${column})`);
			this.name = 'CSLParseError';
			this.reason = reason;
			this.line = line;
			this.column = column;
		}
	}

	/** Thrown when an edit would make the style structurally invalid. `code` says why. */
	class CSLEditError extends Error {
		constructor(code, message) {
			super(message);
			this.name = 'CSLEditError';
			this.code = code;
		}
	}


	//
	// Reading
	//

	const NAME_RE = /[^\s\/>=<"'&]+/y;
	const ENTITY_RE = /&(#x[0-9a-fA-F]+|#[0-9]+|[a-zA-Z]+);/g;
	const NAMED_ENTITIES = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };

	function parse(xml) {
		let s = String(xml === null || xml === undefined ? '' : xml);
		if (s.charCodeAt(0) === 0xFEFF) s = s.slice(1);
		let pos = 0;
		let len = s.length;

		function fail(message, at) {
			at = at === undefined ? pos : at;
			let line = 1;
			let column = 1;
			for (let i = 0; i < at && i < len; i++) {
				if (s[i] === '\n') {
					line++;
					column = 1;
				}
				else {
					column++;
				}
			}
			throw new CSLParseError(message, line, column);
		}

		function decode(str, at) {
			let bare = /&(?!(#x[0-9a-fA-F]+|#[0-9]+|[a-zA-Z]+);)/.exec(str);
			if (bare) fail('A bare "&" must be written as &amp;', at);
			return str.replace(ENTITY_RE, (match, ref) => {
				if (ref[0] === '#') {
					let code = ref[1] === 'x' ? parseInt(ref.slice(2), 16) : parseInt(ref.slice(1), 10);
					if (!(code > 0 && code <= 0x10FFFF)) fail(`Invalid character reference ${match}`, at);
					return String.fromCodePoint(code);
				}
				if (!(ref in NAMED_ENTITIES)) fail(`Unknown entity ${match}`, at);
				return NAMED_ENTITIES[ref];
			});
		}

		function skipWhitespace() {
			while (pos < len && /\s/.test(s[pos])) pos++;
		}

		function readName() {
			NAME_RE.lastIndex = pos;
			let m = NAME_RE.exec(s);
			if (!m) return '';
			pos += m[0].length;
			return m[0];
		}

		function skipMisc(allowDoctype) {
			for (;;) {
				skipWhitespace();
				if (s.startsWith('<?', pos)) {
					let end = s.indexOf('?>', pos + 2);
					if (end === -1) fail('Unterminated processing instruction');
					pos = end + 2;
				}
				else if (s.startsWith('<!--', pos)) {
					let end = s.indexOf('-->', pos + 4);
					if (end === -1) fail('Unterminated comment');
					pos = end + 3;
				}
				else if (allowDoctype && s.startsWith('<!DOCTYPE', pos)) {
					let depth = 0;
					while (pos < len) {
						let ch = s[pos++];
						if (ch === '[') depth++;
						else if (ch === ']') depth--;
						else if (ch === '>' && depth <= 0) break;
					}
				}
				else {
					break;
				}
			}
		}

		function parseElement(depth) {
			if (depth > MAX_DEPTH) fail('Elements are nested too deeply');
			if (s[pos] !== '<') fail('Expected "<"');
			let startPos = pos;
			pos++;
			let name = readName();
			if (!name) fail('Expected an element name');
			let node = { id: 0, type: 'element', name, attrs: [], children: [], text: null };

			for (;;) {
				skipWhitespace();
				if (pos >= len) fail(`The <${name}> tag is never finished`, startPos);
				if (s.startsWith('/>', pos)) {
					pos += 2;
					return node;
				}
				if (s[pos] === '>') {
					pos++;
					break;
				}
				let attrStart = pos;
				let attrName = readName();
				if (!attrName) fail('Unexpected character inside a tag');
				skipWhitespace();
				if (s[pos] !== '=') fail(`Attribute "${attrName}" has no value`);
				pos++;
				skipWhitespace();
				let quote = s[pos];
				if (quote !== '"' && quote !== "'") fail('Attribute values must be in quotes');
				let end = s.indexOf(quote, pos + 1);
				if (end === -1) fail('Unterminated attribute value');
				let raw = s.slice(pos + 1, end);
				if (raw.includes('<')) fail('"<" is not allowed inside an attribute value', pos);
				if (node.attrs.some(a => a.name === attrName)) {
					fail(`Attribute "${attrName}" appears twice`, attrStart);
				}
				node.attrs.push({ name: attrName, value: decode(raw, pos) });
				pos = end + 1;
			}

			let items = [];
			for (;;) {
				if (pos >= len) fail(`The <${name}> element is never closed`, startPos);
				if (s.startsWith('</', pos)) {
					pos += 2;
					let closeName = readName();
					skipWhitespace();
					if (s[pos] !== '>') fail('Malformed closing tag');
					pos++;
					if (closeName !== name) {
						fail(`Closing tag </${closeName}> does not match <${name}>`, pos);
					}
					break;
				}
				if (s.startsWith('<!--', pos)) {
					let end = s.indexOf('-->', pos + 4);
					if (end === -1) fail('Unterminated comment');
					items.push({ id: 0, type: 'comment', value: s.slice(pos + 4, end) });
					pos = end + 3;
				}
				else if (s.startsWith('<![CDATA[', pos)) {
					let end = s.indexOf(']]>', pos + 9);
					if (end === -1) fail('Unterminated CDATA section');
					items.push({ id: 0, type: 'text', value: s.slice(pos + 9, end) });
					pos = end + 3;
				}
				else if (s.startsWith('<?', pos)) {
					let end = s.indexOf('?>', pos + 2);
					if (end === -1) fail('Unterminated processing instruction');
					pos = end + 2;
				}
				else if (s[pos] === '<') {
					items.push(parseElement(depth + 1));
				}
				else {
					let end = s.indexOf('<', pos);
					if (end === -1) fail(`The <${name}> element is never closed`, startPos);
					items.push({ id: 0, type: 'text', value: decode(s.slice(pos, end), pos) });
					pos = end;
				}
			}

			let structured = items.some(i => i.type === 'element' || i.type === 'comment');
			if (!structured) {
				let text = items.map(i => i.value).join('');
				// Whitespace that only lays out the file is not content
				if (text === '' || (/^\s*$/.test(text) && text.includes('\n'))) text = null;
				node.text = text;
			}
			else {
				for (let item of items) {
					if (item.type === 'text' && item.value.trim() === '') continue;
					node.children.push(item);
				}
			}
			return node;
		}

		skipMisc(true);
		if (pos >= len) fail('The file is empty');
		let rootNode = parseElement(0);
		skipMisc(false);
		if (pos < len) fail('Unexpected content after the closing tag of the style');
		return rootNode;
	}


	//
	// Writing
	//

	function escapeText(str) {
		return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
	}

	function escapeAttr(str) {
		return String(str)
			.replace(/&/g, '&amp;')
			.replace(/</g, '&lt;')
			.replace(/"/g, '&quot;')
			.replace(/\t/g, '&#9;')
			.replace(/\n/g, '&#10;')
			.replace(/\r/g, '&#13;');
	}

	function openTag(node) {
		let attrs = node.attrs.map(a => ` ${a.name}="${escapeAttr(a.value)}"`).join('');
		return `<${node.name}${attrs}`;
	}

	function serializeInline(node) {
		if (node.type === 'text') return escapeText(node.value);
		if (node.type === 'comment') return `<!--${node.value}-->`;
		let inner = node.children.length
			? node.children.map(serializeInline).join('')
			: (node.text === null ? '' : escapeText(node.text));
		return inner === '' ? `${openTag(node)}/>` : `${openTag(node)}>${inner}</${node.name}>`;
	}

	function write(node, depth, out, lineMap) {
		let pad = '  '.repeat(depth);
		// The line this node starts on (1-based), for mapping validator messages back to nodes
		if (lineMap) lineMap.set(node.id, out.length + 1);
		if (node.type === 'comment') {
			out.push(`${pad}<!--${node.value}-->`);
			return;
		}
		if (node.type === 'text') {
			out.push(pad + escapeText(node.value));
			return;
		}
		if (node.children.length === 0) {
			out.push(pad + serializeInline(node));
			return;
		}
		if (node.children.some(c => c.type === 'text')) {
			// Mixed content: adding indentation would change the text
			out.push(pad + serializeInline(node));
			return;
		}
		out.push(`${pad}${openTag(node)}>`);
		for (let child of node.children) write(child, depth + 1, out, lineMap);
		out.push(`${pad}</${node.name}>`);
	}

	/**
	 * @param {Object} rootNode
	 * @param {Object} [options]
	 * @param {Boolean} [options.declaration=true] - Write the <?xml?> line
	 * @param {Map} [options.lineMap] - Filled with node id -> start line
	 */
	function serialize(rootNode, options = {}) {
		let out = [];
		if (options.declaration !== false) out.push('<?xml version="1.0" encoding="utf-8"?>');
		write(rootNode, 0, out, options.lineMap || null);
		return out.join('\n') + '\n';
	}

	/**
	 * The innermost node that starts on or before `line`, given a lineMap from serialize()
	 * @return {Number|null} - A node id
	 */
	function nodeAtLine(lineMap, line) {
		let best = null;
		let bestLine = 0;
		for (let [id, start] of lineMap) {
			if (start <= line && start >= bestLine) {
				best = id;
				bestLine = start;
			}
		}
		return best;
	}


	//
	// Helpers over nodes
	//

	function elementChildren(node) {
		return node.children.filter(c => c.type === 'element');
	}

	function getAttr(node, name) {
		let a = node.attrs.find(x => x.name === name);
		return a ? a.value : null;
	}

	function cloneNode(node, nextId) {
		let copy = Object.assign({}, node, { id: nextId() });
		if (node.attrs) copy.attrs = node.attrs.map(a => Object.assign({}, a));
		if (node.children) copy.children = node.children.map(c => cloneNode(c, nextId));
		return copy;
	}

	const ORDER_RANK = { info: 0, locale: 1, macro: 2, citation: 3, bibliography: 4 };

	/** Throws CSLEditError if the children of `node` are in an order CSL does not allow */
	function checkOrder(node) {
		if (node.type !== 'element') return;
		checkKinds(localName(node.name), elementChildren(node).map(c => localName(c.name)));
	}

	/** The same check, on a parent's kind and the kinds of its child elements, in order */
	function checkKinds(kind, kids) {
		if (kind === 'choose') {
			if (kids.length && kids[0] !== 'if') {
				throw new CSLEditError('order', 'A choose must start with an "if" branch');
			}
			kids.forEach((k, i) => {
				if (k === 'if' && i !== 0) {
					throw new CSLEditError('order', 'A choose can only have one "if" branch');
				}
				if (k === 'else' && i !== kids.length - 1) {
					throw new CSLEditError('order', 'The "else" branch has to come last');
				}
			});
		}
		else if (kind === 'citation' || kind === 'bibliography') {
			let sort = kids.indexOf('sort');
			let layout = kids.indexOf('layout');
			if (sort !== -1 && layout !== -1 && sort > layout) {
				throw new CSLEditError('order', 'The sort order has to come before the layout');
			}
			if (kids.filter(k => k === 'sort').length > 1) {
				throw new CSLEditError('order', 'Only one sort order is allowed');
			}
			if (kids.filter(k => k === 'layout').length > 1) {
				throw new CSLEditError('order', 'Only one layout is allowed');
			}
		}
		else if (kind === 'style') {
			let last = -1;
			for (let k of kids) {
				let rank = ORDER_RANK[k];
				if (rank === undefined) continue;
				if (rank < last) {
					throw new CSLEditError('order', `The ${k} section is out of order`);
				}
				last = rank;
			}
		}
		else if (kind === 'names') {
			let sub = kids.indexOf('substitute');
			if (sub !== -1 && sub !== kids.length - 1) {
				throw new CSLEditError('order', '"Substitute" has to come last in a names block');
			}
		}
	}

	const DUPLICABLE = Schema.RENDERING.concat(['macro', 'key', 'name-part', 'date-part']);
	const REQUIRED_CHILDREN = ['info', 'citation', 'layout'];
	const MACRO_NAME_RE = /^[A-Za-z][A-Za-z0-9._-]*$/;


	//
	// The document
	//

	class StyleDoc {
		constructor(rootNode) {
			this._root = rootNode;
			this._nextId = 1;
			this._assignIds(rootNode);
			this._undo = [];
			this._redo = [];
			this._listeners = [];
			this._index = null;
			this._savedXML = this.toXML();
		}

		static fromXML(xml) {
			return new StyleDoc(parse(xml));
		}

		toXML(options) {
			return serialize(this._root, options);
		}

		/**
		 * The XML plus a map of node id -> line, so a message about line N of this exact text can
		 * be turned back into the node it concerns with nodeAtLine()
		 */
		toXMLWithLines() {
			let lineMap = new Map();
			let xml = serialize(this._root, { lineMap });
			return { xml, lineMap };
		}

		/**
		 * Replace the whole style with new XML, as one undoable edit. Throws CSLParseError,
		 * leaving the style untouched, if the XML cannot be read.
		 */
		replaceXML(xml) {
			let newRoot = parse(xml);
			return this._edit(() => {
				this._assignIds(newRoot);
				this._root = newRoot;
			});
		}

		get root() {
			return this._root;
		}

		/** Register a function called after every change (including undo and redo) */
		onChange(fn) {
			this._listeners.push(fn);
		}

		_emit() {
			this._index = null;
			for (let fn of this._listeners) fn();
		}

		_assignIds(node) {
			node.id = this._nextId++;
			if (node.children) {
				for (let c of node.children) this._assignIds(c);
			}
		}

		_newId() {
			return this._nextId++;
		}

		_snapshot() {
			return JSON.stringify(this._root);
		}

		/** Whether the style differs from how it was when loaded or last marked saved */
		isDirty() {
			return this.toXML() !== this._savedXML;
		}

		markSaved() {
			this._savedXML = this.toXML();
		}


		//
		// Lookup
		//

		_buildIndex() {
			let nodes = new Map();
			let parents = new Map();
			let visit = (node, parent) => {
				nodes.set(node.id, node);
				parents.set(node.id, parent);
				if (node.children) {
					for (let c of node.children) visit(c, node);
				}
			};
			visit(this._root, null);
			this._index = { nodes, parents };
		}

		find(id) {
			if (!this._index) this._buildIndex();
			return this._index.nodes.get(id) || null;
		}

		parentOf(id) {
			if (!this._index) this._buildIndex();
			return this._index.parents.get(id) || null;
		}

		_require(id) {
			let node = this.find(id);
			if (!node) throw new CSLEditError('not-found', `No such node: ${id}`);
			return node;
		}

		isDescendant(id, ancestorId) {
			let node = this.find(id);
			while (node) {
				if (node.id === ancestorId) return true;
				node = this.parentOf(node.id);
			}
			return false;
		}

		/** Depth-first visit of every element */
		walk(fn, start = this._root) {
			if (start.type === 'element') fn(start);
			for (let c of start.children || []) this.walk(fn, c);
		}

		findAll(name) {
			let out = [];
			this.walk((n) => {
				if (localName(n.name) === name) out.push(n);
			});
			return out;
		}


		//
		// Mutation machinery
		//

		/**
		 * Run `fn` as one undoable edit. If it throws after changing something, the change is
		 * rolled back. A rollback replaces the node objects, so code that holds nodes across an
		 * edit that might fail should keep ids and look nodes up again with find(). A failure
		 * that changed nothing (the usual case: a refused insert) leaves the objects as they were.
		 */
		_edit(fn) {
			let before = this._snapshot();
			try {
				let result = fn();
				if (result === false) return false;
				this._index = null;
				if (this._snapshot() === before) return false;
				this._undo.push(before);
				if (this._undo.length > MAX_UNDO) this._undo.shift();
				this._redo = [];
				this._emit();
				return result === undefined ? true : result;
			}
			catch (e) {
				if (this._snapshot() !== before) {
					this._root = JSON.parse(before);
					this._index = null;
				}
				throw e;
			}
		}

		canUndo() {
			return this._undo.length > 0;
		}

		canRedo() {
			return this._redo.length > 0;
		}

		undo() {
			if (!this._undo.length) return false;
			this._redo.push(this._snapshot());
			this._root = JSON.parse(this._undo.pop());
			this._emit();
			return true;
		}

		redo() {
			if (!this._redo.length) return false;
			this._undo.push(this._snapshot());
			this._root = JSON.parse(this._redo.pop());
			this._emit();
			return true;
		}


		//
		// Attributes and text
		//

		getAttr(id, name) {
			return getAttr(this._require(id), name);
		}

		/**
		 * Set an attribute; null, undefined or '' removes it (whitespace-only values are kept,
		 * since a lone space is a meaningful prefix or delimiter)
		 */
		setAttr(id, name, value) {
			return this._edit(() => {
				let node = this._require(id);
				if (node.type !== 'element') throw new CSLEditError('invalid', 'Not an element');
				return this._applyAttr(node, name, value);
			});
		}

		/** Change several attributes as one undoable edit: { name: value, ... } */
		setAttrs(id, changes) {
			return this._edit(() => {
				let node = this._require(id);
				if (node.type !== 'element') throw new CSLEditError('invalid', 'Not an element');
				let changed = false;
				for (let [name, value] of Object.entries(changes)) {
					if (this._applyAttr(node, name, value) !== false) changed = true;
				}
				return changed ? true : false;
			});
		}

		/** @return {Boolean} Whether anything changed */
		_applyAttr(node, name, value) {
			let i = node.attrs.findIndex(a => a.name === name);
			let remove = value === null || value === undefined || value === '';
			if (remove) {
				if (i === -1) return false;
				node.attrs.splice(i, 1);
			}
			else if (i === -1) {
				node.attrs.push({ name, value: String(value) });
			}
			else {
				if (node.attrs[i].value === String(value)) return false;
				node.attrs[i].value = String(value);
			}
			return true;
		}

		setText(id, text) {
			return this._edit(() => {
				let node = this._require(id);
				if (node.type === 'comment' || node.type === 'text') {
					node.value = String(text);
					return;
				}
				if (node.children.length) {
					throw new CSLEditError('invalid', 'This element holds other elements, not text');
				}
				node.text = text === '' || text === null ? null : String(text);
			});
		}


		//
		// Structure
		//

		_checkCanContain(parent, childName) {
			if (!Schema.canContain(parent.name, childName)) {
				throw new CSLEditError(
					'invalid-parent',
					`A ${localName(childName)} cannot go inside ${Schema.getElement(parent.name)?.label || parent.name}`
				);
			}
		}

		/** Where a new child of this kind should go by default */
		_defaultIndex(parent, childName) {
			let kind = localName(childName);
			let kids = parent.children;
			let parentKind = localName(parent.name);
			if (parentKind === 'style') {
				let rank = ORDER_RANK[kind];
				let at = 0;
				kids.forEach((c, i) => {
					if (c.type === 'element' && (ORDER_RANK[localName(c.name)] ?? 99) <= rank) at = i + 1;
				});
				return at;
			}
			if (parentKind === 'choose') {
				if (kind === 'else') return kids.length;
				let elseAt = kids.findIndex(c => c.type === 'element' && localName(c.name) === 'else');
				return elseAt === -1 ? kids.length : elseAt;
			}
			if (parentKind === 'citation' || parentKind === 'bibliography') {
				if (kind === 'sort') return 0;
			}
			if (parentKind === 'names' && kind !== 'substitute') {
				let subAt = kids.findIndex(c => c.type === 'element' && localName(c.name) === 'substitute');
				return subAt === -1 ? kids.length : subAt;
			}
			return kids.length;
		}

		/**
		 * Add a new element. `spec` is { name, attrs?: {k: v}, text?, children?: [spec] }.
		 * Returns the new node's id.
		 */
		insert(parentId, spec, index) {
			let newId = null;
			this._edit(() => {
				let parent = this._require(parentId);
				this._checkCanContain(parent, spec.name);
				let build = (sp) => ({
					id: this._newId(),
					type: 'element',
					name: sp.name,
					attrs: Object.entries(sp.attrs || {}).map(([name, value]) => ({ name, value: String(value) })),
					children: (sp.children || []).map(build),
					text: sp.text === undefined ? null : sp.text
				});
				let node = build(spec);
				let at = index === undefined ? this._defaultIndex(parent, spec.name) : index;
				parent.children.splice(Math.max(0, Math.min(at, parent.children.length)), 0, node);
				checkOrder(parent);
				newId = node.id;
			});
			return newId;
		}

		/** Add an if / else-if / else branch to a choose block */
		addBranch(chooseId, kind) {
			let choose = this._require(chooseId);
			if (localName(choose.name) !== 'choose') {
				throw new CSLEditError('invalid', 'Branches can only be added to a choose block');
			}
			if (kind === 'else' && elementChildren(choose).some(c => localName(c.name) === 'else')) {
				throw new CSLEditError('order', 'This choose already has an "else" branch');
			}
			return this.insert(chooseId, { name: kind, attrs: kind === 'else' ? {} : { variable: 'title' } });
		}

		/** Move a node to a new place (a different parent and/or position) */
		move(id, newParentId, index) {
			return this._edit(() => {
				let node = this._require(id);
				let parent = this.parentOf(id);
				if (!parent) throw new CSLEditError('root', 'The style itself cannot be moved');
				let target = this._require(newParentId);
				if (this.isDescendant(newParentId, id)) {
					throw new CSLEditError('cycle', 'An element cannot be moved into itself');
				}
				if (node.type === 'element') this._checkCanContain(target, node.name);
				let from = parent.children.indexOf(node);
				parent.children.splice(from, 1);
				let at = index === undefined ? this._defaultIndex(target, node.name) : index;
				if (parent === target && from < at) at--;
				target.children.splice(Math.max(0, Math.min(at, target.children.length)), 0, node);
				checkOrder(parent);
				checkOrder(target);
			});
		}

		/** Swap with a sibling: delta -1 is up, +1 is down. Returns false if already at the end. */
		moveBy(id, delta) {
			return this._edit(() => {
				let node = this._require(id);
				let parent = this.parentOf(id);
				if (!parent) throw new CSLEditError('root', 'The style itself cannot be moved');
				let i = parent.children.indexOf(node);
				let j = i + delta;
				if (j < 0 || j >= parent.children.length) return false;
				parent.children.splice(i, 1);
				parent.children.splice(j, 0, node);
				checkOrder(parent);
			});
		}

		canMoveBy(id, delta) {
			let parent = this.parentOf(id);
			if (!parent) return false;
			let i = parent.children.findIndex(c => c.id === id);
			let j = i + delta;
			if (j < 0 || j >= parent.children.length) return false;
			// Work out the new order without touching the tree
			let order = parent.children.slice();
			let [node] = order.splice(i, 1);
			order.splice(j, 0, node);
			try {
				checkKinds(
					localName(parent.name),
					order.filter(c => c.type === 'element').map(c => localName(c.name))
				);
			}
			catch (e) {
				return false;
			}
			return true;
		}

		remove(id) {
			return this._edit(() => {
				let node = this._require(id);
				let parent = this.parentOf(id);
				if (!parent) throw new CSLEditError('root', 'The style itself cannot be removed');
				let kind = localName(node.name || '');
				if (node.type === 'element' && REQUIRED_CHILDREN.includes(kind)) {
					throw new CSLEditError('required', `A style needs its ${Schema.getElement(kind).label.toLowerCase()}`);
				}
				if (kind === 'if' && localName(parent.name) === 'choose') {
					throw new CSLEditError(
						'required',
						'The first branch of a choose cannot be removed; remove the whole choose instead'
					);
				}
				if (kind === 'macro') {
					let used = this.macroUsages(getAttr(node, 'name'));
					if (used.length) {
						throw new CSLEditError(
							'used-macro',
							`Macro "${getAttr(node, 'name')}" is still used ${used.length} time${used.length === 1 ? '' : 's'}`
						);
					}
				}
				parent.children.splice(parent.children.indexOf(node), 1);
				// A choose with no branches left is meaningless
				if (localName(parent.name) === 'choose' && elementChildren(parent).length === 0) {
					let grand = this.parentOf(parent.id);
					grand.children.splice(grand.children.indexOf(parent), 1);
				}
			});
		}

		canRemove(id) {
			let node = this.find(id);
			let parent = this.parentOf(id);
			if (!node || !parent) return false;
			let kind = localName(node.name || '');
			if (node.type === 'element' && REQUIRED_CHILDREN.includes(kind)) return false;
			if (kind === 'if' && localName(parent.name) === 'choose') return false;
			if (kind === 'macro' && this.macroUsages(getAttr(node, 'name')).length) return false;
			return true;
		}

		canDuplicate(id) {
			let node = this.find(id);
			return !!node && node.type === 'element' && DUPLICABLE.includes(localName(node.name))
				&& !!this.parentOf(id);
		}

		duplicate(id) {
			let newId = null;
			this._edit(() => {
				let node = this._require(id);
				if (!this.canDuplicate(id)) {
					throw new CSLEditError('invalid', 'This element cannot be duplicated');
				}
				let parent = this.parentOf(id);
				let copy = cloneNode(node, () => this._newId());
				if (localName(node.name) === 'macro') {
					let base = getAttr(node, 'name') + '-copy';
					let name = base;
					for (let n = 2; this.macroNode(name); n++) name = `${base}-${n}`;
					copy.attrs.find(a => a.name === 'name').value = name;
				}
				parent.children.splice(parent.children.indexOf(node) + 1, 0, copy);
				newId = copy.id;
			});
			return newId;
		}

		/** Put an element inside a new group, in the same place */
		wrapInGroup(id) {
			let groupId = null;
			this._edit(() => {
				let node = this._require(id);
				let parent = this.parentOf(id);
				if (!parent) throw new CSLEditError('root', 'The style itself cannot be wrapped');
				if (node.type !== 'element' || !Schema.RENDERING.includes(localName(node.name))) {
					throw new CSLEditError('invalid', 'Only text, names, dates and other output elements can be grouped');
				}
				this._checkCanContain(parent, 'group');
				let group = {
					id: this._newId(), type: 'element', name: 'group', attrs: [], children: [node], text: null
				};
				parent.children.splice(parent.children.indexOf(node), 1, group);
				groupId = group.id;
			});
			return groupId;
		}

		/** Replace a group by its contents */
		unwrap(id) {
			return this._edit(() => {
				let node = this._require(id);
				let parent = this.parentOf(id);
				if (!parent || localName(node.name || '') !== 'group') {
					throw new CSLEditError('invalid', 'Only a group can be ungrouped');
				}
				for (let c of node.children) {
					if (c.type === 'element') this._checkCanContain(parent, c.name);
				}
				parent.children.splice(parent.children.indexOf(node), 1, ...node.children);
			});
		}


		//
		// Macros
		//

		macroNode(name) {
			return this.findAll('macro').find(m => getAttr(m, 'name') === name) || null;
		}

		macros() {
			return this.findAll('macro').map(m => ({
				id: m.id,
				name: getAttr(m, 'name'),
				uses: this.macroUsages(getAttr(m, 'name')).length
			}));
		}

		/** Nodes (text or key elements) that call the macro */
		macroUsages(name) {
			let out = [];
			this.walk((n) => {
				let kind = localName(n.name);
				if ((kind === 'text' || kind === 'key') && getAttr(n, 'macro') === name) out.push(n);
			});
			return out;
		}

		unusedMacros() {
			return this.macros().filter(m => m.uses === 0);
		}

		/** Names that are called but not defined */
		undefinedMacros() {
			let defined = new Set(this.macros().map(m => m.name));
			let missing = new Set();
			this.walk((n) => {
				let kind = localName(n.name);
				let ref = getAttr(n, 'macro');
				if ((kind === 'text' || kind === 'key') && ref && !defined.has(ref)) missing.add(ref);
			});
			return [...missing];
		}

		static isValidMacroName(name) {
			return MACRO_NAME_RE.test(name || '');
		}

		addMacro(name) {
			if (!StyleDoc.isValidMacroName(name)) {
				throw new CSLEditError('invalid-name', 'Macro names start with a letter and use only letters, numbers, ".", "_" and "-"');
			}
			if (this.macroNode(name)) {
				throw new CSLEditError('duplicate', `There is already a macro called "${name}"`);
			}
			return this.insert(this._root.id, { name: 'macro', attrs: { name } });
		}

		/** Rename a macro and every place that uses it */
		renameMacro(id, newName) {
			return this._edit(() => {
				let node = this._require(id);
				if (localName(node.name || '') !== 'macro') {
					throw new CSLEditError('invalid', 'Not a macro');
				}
				let old = getAttr(node, 'name');
				if (old === newName) return false;
				if (!StyleDoc.isValidMacroName(newName)) {
					throw new CSLEditError('invalid-name', 'Macro names start with a letter and use only letters, numbers, ".", "_" and "-"');
				}
				if (this.macroNode(newName)) {
					throw new CSLEditError('duplicate', `There is already a macro called "${newName}"`);
				}
				for (let use of this.macroUsages(old)) {
					use.attrs.find(a => a.name === 'macro').value = newName;
				}
				node.attrs.find(a => a.name === 'name').value = newName;
			});
		}


		//
		// Style information
		//

		getInfo(name) {
			let info = this.findAll('info')[0];
			if (!info) return null;
			let el = elementChildren(info).find(c => localName(c.name) === name);
			return el ? el.text : null;
		}

		/**
		 * Set a field of the style's information block. Clearing an optional field removes it;
		 * the title, id and updated time are required, so they are kept even when empty.
		 */
		setInfo(name, value) {
			return this._edit(() => {
				let info = this.findAll('info')[0];
				if (!info) throw new CSLEditError('required', 'This style has no information block');
				let el = elementChildren(info).find(c => localName(c.name) === name);
				let clearing = value === '' || value === null || value === undefined;
				if (clearing && !['title', 'id', 'updated'].includes(name)) {
					if (!el) return false;
					info.children.splice(info.children.indexOf(el), 1);
					return;
				}
				if (value === null || value === undefined) value = '';
				if (el) {
					if (el.text === value) return false;
					el.text = value;
				}
				else {
					info.children.push({
						id: this._newId(), type: 'element', name, attrs: [], children: [], text: value
					});
				}
			});
		}


		//
		// Descriptions for the editor
		//

		/**
		 * A short title and a one-line detail for a node, for the tree view
		 * @return {{ kind: string, title: string, detail: string }}
		 */
		describe(id) {
			let node = this._require(id);
			if (node.type === 'comment') {
				return { kind: 'comment', title: 'Comment', detail: node.value.trim().slice(0, 60) };
			}
			if (node.type === 'text') {
				return { kind: 'text-node', title: 'Text', detail: node.value.trim().slice(0, 60) };
			}
			let kind = localName(node.name);
			let a = name => getAttr(node, name);
			let title = Schema.getElement(kind)?.label || kind;
			let detail = [];

			switch (kind) {
				case 'text':
					if (a('variable')) title = `Variable: ${a('variable')}`;
					else if (a('macro')) title = `Macro: ${a('macro')}`;
					else if (a('term')) title = `Term: ${a('term')}`;
					else if (a('value') !== null) title = `Text: “${a('value')}”`;
					break;
				case 'number':
				case 'label':
				case 'date':
					if (a('variable')) title = `${title}: ${a('variable')}`;
					break;
				case 'names':
					if (a('variable')) title = `Names: ${a('variable').split(/\s+/).join(', ')}`;
					break;
				case 'name-part':
					title = `Name part: ${a('name') || '?'}`;
					break;
				case 'date-part':
					title = `Date part: ${a('name') || '?'}`;
					break;
				case 'macro':
					title = `Macro: ${a('name') || '?'}`;
					break;
				case 'key':
					title = `Sort by ${a('variable') || a('macro') || '?'}`;
					if (a('sort') === 'descending') detail.push('descending');
					break;
				case 'if':
				case 'else-if': {
					let parts = ['type', 'variable', 'is-numeric', 'is-uncertain-date', 'locator', 'position']
						.filter(n => a(n))
						.map(n => `${n} ${a(n)}`);
					title = `${title}${parts.length ? ' ' + parts.join(', ') : ''}`;
					if (parts.length > 1 && a('match') && a('match') !== 'all') detail.push(`match ${a('match')}`);
					break;
				}
				case 'info':
					title = 'Style information';
					break;
				case 'locale':
					title = `Locale${a('xml:lang') ? ': ' + a('xml:lang') : ''}`;
					break;
				default:
					break;
			}

			let formats = [];
			if (a('font-style') && a('font-style') !== 'normal') formats.push(a('font-style'));
			if (a('font-weight') && a('font-weight') !== 'normal') formats.push(a('font-weight'));
			if (a('font-variant') === 'small-caps') formats.push('small caps');
			if (a('text-decoration') === 'underline') formats.push('underline');
			if (a('vertical-align') && a('vertical-align') !== 'baseline') {
				formats.push(a('vertical-align') === 'sup' ? 'superscript' : 'subscript');
			}
			if (a('quotes') === 'true') formats.push('quotes');
			if (a('text-case')) formats.push(a('text-case'));
			if (formats.length) detail.push(formats.join(', '));
			if (a('prefix')) detail.push(`before “${a('prefix')}”`);
			if (a('suffix')) detail.push(`after “${a('suffix')}”`);
			if (a('delimiter') && ['group', 'layout', 'names', 'name', 'date'].includes(kind)) {
				detail.push(`separated by “${a('delimiter')}”`);
			}
			return { kind, title, detail: detail.join(' · ') };
		}

		/**
		 * Problems worth showing next to an attribute, or null. Never blocks an edit; the real
		 * validator has the last word.
		 */
		checkAttr(id, name, value) {
			let node = this._require(id);
			let spec = Schema.getElement(node.name)?.attrs[name];
			if (!spec || value === null || value === undefined || value === '') return null;
			switch (spec.type) {
				case 'enum':
					return spec.values.includes(value) ? null : `Expected one of: ${spec.values.join(', ')}`;
				case 'enum-multi': {
					let bad = value.split(/\s+/).filter(v => v && !spec.values.includes(v));
					return bad.length ? `Unknown value: ${bad.join(', ')}` : null;
				}
				case 'integer':
					return /^\d+$/.test(value) ? null : 'Expected a whole number';
				case 'variable':
				case 'variables': {
					let bad = value.split(/\s+/).filter(v => v && !Schema.ALL_VARIABLES.includes(v));
					return bad.length ? `Not a standard CSL variable: ${bad.join(', ')}` : null;
				}
				case 'item-types': {
					let bad = value.split(/\s+/).filter(v => v && !Schema.ITEM_TYPES.includes(v));
					return bad.length ? `Not a CSL item type: ${bad.join(', ')}` : null;
				}
				case 'macro':
					return this.macroNode(value) ? null : `There is no macro called "${value}"`;
				default:
					return null;
			}
		}
	}

	const api = {
		CSLParseError,
		CSLEditError,
		parse,
		serialize,
		nodeAtLine,
		elementChildren,
		getAttr,
		StyleDoc
	};

	if (typeof module !== 'undefined' && module.exports) {
		module.exports = api;
	}
	else if (root) {
		root.CSLTree = api;
	}
})(typeof Zotero !== 'undefined' ? Zotero : null);

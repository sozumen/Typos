"use strict";

/**
 * The window behind visualStyleEditor.html
 *
 * What gets edited is a Zotero.CSLTree.StyleDoc (see xpcom/styleEditor/cslTree.js), which does the
 * real work and refuses edits that would break the style's structure. This file only draws it:
 *
 *   tree       the style as nested parts, with drag-and-drop and keyboard editing
 *   inspector  a form for the selected part, built from Zotero.CSLSchema
 *   preview    citations and a bibliography from the items selected in the library
 *   status     the CSL validator's verdict on every change
 *
 * Nodes are always referred to by id and looked up again with doc.find(), because a rolled-back
 * edit replaces the node objects.
 */
var Zotero_VisualStyleEditor = new function () {
	const HTML_NS = 'http://www.w3.org/1999/xhtml';
	const MAX_PREVIEW_ITEMS = 8;
	const VALIDATE_DELAY = 500;
	const PREVIEW_DELAY = 300;
	const COMMIT_DELAY = 300;

	let { StyleDoc, CSLParseError, nodeAtLine } = Zotero.CSLTree;
	let Schema = Zotero.CSLSchema;
	let localName = Schema.localName;

	let doc = null;
	let selectedId = null;
	let expanded = new Set();
	let refs = {};
	let strings = {};
	let applyingFromInspector = false;
	let unsavedOrigin = false; // Content that exists nowhere else yet (e.g. written by the AI)
	let validateTimer = null;
	let previewTimer = null;
	let validateToken = 0;
	let lastValidation = null; // { lineMap, errorLine }
	let dragId = null;
	let lastPreviewItemIDs = '';


	//
	// Small helpers
	//

	/** Make an HTML element: h('div', { class: 'x', l10n: ['id', { arg }], on: { click: fn } }, ...children) */
	function h(tag, props = {}, ...children) {
		let el = document.createElementNS(HTML_NS, tag);
		for (let [key, value] of Object.entries(props)) {
			if (value === null || value === undefined || value === false) continue;
			if (key === 'class') {
				el.className = value;
			}
			else if (key === 'text') {
				el.textContent = value;
			}
			else if (key === 'l10n') {
				document.l10n.setAttributes(el, value[0], value[1]);
			}
			else if (key === 'on') {
				for (let [type, fn] of Object.entries(value)) el.addEventListener(type, fn);
			}
			else if (key === 'value' || key === 'checked' || key === 'disabled' || key === 'hidden') {
				el[key] = value;
			}
			else {
				el.setAttribute(key, value === true ? '' : value);
			}
		}
		for (let child of children.flat(Infinity)) {
			if (child === null || child === undefined || child === false) continue;
			el.append(child);
		}
		return el;
	}

	function t(id, args) {
		return document.l10n.formatValue(id, args);
	}

	function debounce(fn, delay) {
		let timer = null;
		let wrapped = (...args) => {
			clearTimeout(timer);
			timer = setTimeout(() => fn(...args), delay);
		};
		wrapped.flush = (...args) => {
			clearTimeout(timer);
			fn(...args);
		};
		return wrapped;
	}

	/** Make spaces at the edges of a value visible: ", " -> ",␣" */
	function showSpaces(value) {
		return value.replace(/^ +| +$/g, m => '␣'.repeat(m.length));
	}

	function showMessage(text, isError = true) {
		refs.message.textContent = text || '';
		refs.message.classList.toggle('error', !!text && isError);
		clearTimeout(showMessage.timer);
		if (text) showMessage.timer = setTimeout(() => showMessage(''), 8000);
	}

	function showError(e) {
		if (e && (e.name === 'CSLEditError' || e.name === 'CSLParseError')) {
			showMessage(e.message);
		}
		else {
			Zotero.logError(e);
			showMessage(String(e && e.message || e));
		}
	}

	function kindOf(node) {
		return node && node.type === 'element' ? localName(node.name) : '';
	}

	function selectedNode() {
		return doc && selectedId !== null ? doc.find(selectedId) : null;
	}


	//
	// Starting up
	//

	this.init = async function () {
		MozXULElement.insertFTLIfNeeded('zotero.ftl');
		await Zotero.Schema.schemaUpdatePromise;
		await Zotero.Styles.init();

		for (let el of document.querySelectorAll('[id^="vse-"]')) {
			refs[el.id.slice(4).replace(/-([a-z])/g, (m, c) => c.toUpperCase())] = el;
		}

		strings = {
			discardTitle: await t('visualStyleEditor-discard-title'),
			discardText: await t('visualStyleEditor-discard-text'),
			discardButton: await t('visualStyleEditor-discard-button')
		};

		buildDatalists();
		populateOpenMenu();
		populatePreviewControls();
		bindEvents();

		let request = Zotero.VisualStyleEditor.takePending() || {};
		await this.openRequest(request, true);
		window.addEventListener('focus', () => refreshPreviewItems());
	};

	/** Open a style as asked by Zotero.VisualStyleEditor.open() */
	this.openRequest = async function (request, initial = false) {
		if (!initial && !confirmDiscard()) return;
		try {
			let xml;
			if (request.xml) {
				xml = request.xml;
			}
			else if (request.kind) {
				xml = Zotero.VisualStyleEditor.makeNewStyle(request.kind, request.title).xml;
			}
			else if (request.styleID) {
				xml = Zotero.VisualStyleEditor.makeWorkingCopy(request.styleID).xml;
			}
			else {
				xml = defaultStyleXML();
			}
			loadXML(xml, { unsaved: !!request.xml && request.unsaved !== false });
			if (request.notice) showMessage(request.notice, false);
		}
		catch (e) {
			if (e && e.name === 'DependentStyleError') {
				let style = request.styleID ? Zotero.Styles.get(request.styleID) : null;
				showMessage(await t('visualStyleEditor-error-dependent', { title: style ? style.title : '' }));
			}
			else if (e && e.name === 'CSLParseError') {
				showMessage(await t('visualStyleEditor-error-unreadable', { message: e.message }));
			}
			else {
				showError(e);
			}
			// Never leave the window empty
			if (!doc) loadXML(Zotero.VisualStyleEditor.makeNewStyle('author-date').xml, {});
		}
	};

	/** The last style the person used in the style editors, as a working copy; else a new style */
	function defaultStyleXML() {
		let lastID = Zotero.Prefs.get('export.lastStyle');
		let last = lastID && Zotero.Styles.get(lastID);
		if (last && !last.source) {
			try {
				return Zotero.VisualStyleEditor.makeWorkingCopy(lastID).xml;
			}
			catch (e) {
				Zotero.debug(e);
			}
		}
		return Zotero.VisualStyleEditor.makeNewStyle('author-date').xml;
	}

	function loadXML(xml, { unsaved = false } = {}) {
		doc = StyleDoc.fromXML(xml);
		doc.onChange(onDocChange);
		unsavedOrigin = unsaved;
		lastValidation = null;
		expanded = new Set();
		doc.walk((node) => {
			if (!['macro', 'info', 'locale'].includes(localName(node.name))) expanded.add(node.id);
		});
		expanded.add(doc.root.id);
		selectedId = doc.root.id;
		refs.xmlView.hidden = true;
		refs.inspector.hidden = false;
		renderAll();
		scheduleValidate(0);
		schedulePreview(0);
	}

	function isDirty() {
		return !!doc && (doc.isDirty() || unsavedOrigin);
	}

	function confirmDiscard() {
		if (!isDirty()) return true;
		let choice = Zotero.Prompt.confirm({
			window,
			title: strings.discardTitle,
			text: strings.discardText,
			button0: strings.discardButton,
			button1: Zotero.Prompt.BUTTON_TITLE_CANCEL
		});
		return choice === 0;
	}


	//
	// Drawing everything
	//

	function onDocChange() {
		ensureSelection();
		renderTree();
		if (!applyingFromInspector) renderInspector();
		updateToolbar();
		updateTitle();
		scheduleValidate();
		schedulePreview();
		if (!refs.xmlView.hidden && !applyingFromInspector) fillXMLView();
	}

	function renderAll() {
		renderTree();
		renderInspector();
		updateToolbar();
		updateTitle();
	}

	/** Keep the selection on a node that exists, e.g. after an undo removed it */
	function ensureSelection() {
		if (selectedId !== null && doc.find(selectedId)) return;
		selectedId = doc.root.id;
	}

	function updateTitle() {
		let name = (doc && doc.getInfo('title')) || '';
		let title = document.querySelector('title');
		document.l10n.setAttributes(
			title,
			isDirty() ? 'visualStyleEditor-title-unsaved' : 'visualStyleEditor-title',
			{ name }
		);
	}


	//
	// The tree
	//

	// Parts whose contents are edited as plain fields, not as a branch of the tree
	const OPAQUE = ['info', 'locale'];

	function visibleChildren(node) {
		if (OPAQUE.includes(kindOf(node))) return [];
		return node.children.filter(c => c.type === 'element');
	}

	function badgeKind(kind) {
		if (['text', 'number', 'label'].includes(kind)) return 'output';
		if (['names', 'name', 'name-part', 'et-al', 'date', 'date-part', 'substitute'].includes(kind)) return 'data';
		if (['group', 'layout'].includes(kind)) return 'structure';
		if (['choose', 'if', 'else-if', 'else'].includes(kind)) return 'logic';
		if (kind === 'macro') return 'macro';
		if (['sort', 'key'].includes(kind)) return 'sort';
		return 'section';
	}

	function renderTree() {
		let scroll = refs.tree.scrollTop;
		refs.tree.replaceChildren(buildTreeNode(doc.root, 1));
		refs.tree.scrollTop = scroll;
	}

	function buildTreeNode(node, level) {
		let kids = visibleChildren(node);
		let kind = kindOf(node);
		let isOpen = expanded.has(node.id);
		let desc = doc.describe(node.id);

		let twisty = h('span', {
			class: 'vse-twisty' + (kids.length ? '' : ' empty'),
			'aria-hidden': 'true',
			text: kids.length ? (isOpen ? '▾' : '▸') : ''
		});
		let row = h('div', {
			class: 'vse-row-node' + (node.id === selectedId ? ' selected' : ''),
			'data-id': node.id,
			draggable: node.id === doc.root.id ? null : 'true'
		},
		twisty,
		h('span', { class: 'vse-badge', 'data-kind': badgeKind(kind), 'aria-hidden': 'true', text: kind }),
		h('span', { class: 'vse-node-label', text: desc.title }),
		desc.detail ? h('span', { class: 'vse-node-detail', text: desc.detail }) : null);

		let item = h('div', {
			role: 'treeitem',
			class: 'vse-node',
			'aria-level': level,
			'aria-selected': node.id === selectedId ? 'true' : 'false',
			'aria-expanded': kids.length ? (isOpen ? 'true' : 'false') : null
		}, row);

		if (kids.length && isOpen) {
			let group = h('div', { role: 'group' });
			for (let child of kids) group.append(buildTreeNode(child, level + 1));
			item.append(group);
		}
		return item;
	}

	function rowIdFromEvent(event) {
		let row = event.target.closest && event.target.closest('.vse-row-node');
		return row ? Number(row.dataset.id) : null;
	}

	function selectNode(id, { reveal = true } = {}) {
		if (!doc.find(id)) return;
		selectedId = id;
		if (reveal) {
			let parent = doc.parentOf(id);
			while (parent) {
				expanded.add(parent.id);
				parent = doc.parentOf(parent.id);
			}
		}
		renderTree();
		renderInspector();
		updateToolbar();
		let row = refs.tree.querySelector('.vse-row-node.selected');
		if (row && row.scrollIntoView) row.scrollIntoView({ block: 'nearest' });
	}

	function toggle(id, open) {
		let isOpen = expanded.has(id);
		if (open === undefined) open = !isOpen;
		if (open) expanded.add(id);
		else expanded.delete(id);
		renderTree();
	}

	function visibleRowIds() {
		return [...refs.tree.querySelectorAll('.vse-row-node')].map(r => Number(r.dataset.id));
	}

	function onTreeClick(event) {
		let id = rowIdFromEvent(event);
		if (id === null) return;
		if (event.target.classList.contains('vse-twisty') && !event.target.classList.contains('empty')) {
			toggle(id);
			return;
		}
		selectNode(id, { reveal: false });
		refs.tree.focus();
	}

	function onTreeKeyDown(event) {
		let node = selectedNode();
		if (!node) return;
		let accel = Zotero.isMac ? event.metaKey : event.ctrlKey;
		let ids = visibleRowIds();
		let at = ids.indexOf(node.id);
		let handled = true;

		if (event.altKey && (event.key === 'ArrowUp' || event.key === 'ArrowDown')) {
			moveSelected(event.key === 'ArrowUp' ? -1 : 1);
		}
		else if (event.key === 'ArrowDown') {
			if (at < ids.length - 1) selectNode(ids[at + 1], { reveal: false });
		}
		else if (event.key === 'ArrowUp') {
			if (at > 0) selectNode(ids[at - 1], { reveal: false });
		}
		else if (event.key === 'ArrowRight') {
			let kids = visibleChildren(node);
			if (kids.length && !expanded.has(node.id)) toggle(node.id, true);
			else if (kids.length) selectNode(kids[0].id, { reveal: false });
		}
		else if (event.key === 'ArrowLeft') {
			if (visibleChildren(node).length && expanded.has(node.id)) {
				toggle(node.id, false);
			}
			else {
				let parent = doc.parentOf(node.id);
				if (parent) selectNode(parent.id, { reveal: false });
			}
		}
		else if (event.key === 'Delete' || event.key === 'Backspace') {
			deleteSelected();
		}
		else if (accel && event.key.toLowerCase() === 'd') {
			duplicateSelected();
		}
		else {
			handled = false;
		}
		if (handled) event.preventDefault();
	}


	//
	// Drag and drop in the tree
	//

	function dropTarget(event) {
		let id = rowIdFromEvent(event);
		if (id === null || dragId === null) return null;
		let row = event.target.closest('.vse-row-node');
		let rect = row.getBoundingClientRect();
		let y = (event.clientY - rect.top) / rect.height;
		let zone = y < 0.25 ? 'before' : (y > 0.75 ? 'after' : 'inside');
		let target = doc.find(id);
		let dragged = doc.find(dragId);
		if (!target || !dragged || id === dragId || doc.isDescendant(id, dragId)) return null;

		let parent = zone === 'inside' ? target : doc.parentOf(id);
		if (!parent || !Schema.canContain(parent.name, dragged.name)) return null;
		return { id, zone, row };
	}

	function clearDropMarks() {
		for (let el of refs.tree.querySelectorAll('.drop-before, .drop-after, .drop-inside')) {
			el.classList.remove('drop-before', 'drop-after', 'drop-inside');
		}
	}

	function onDragStart(event) {
		let id = rowIdFromEvent(event);
		if (id === null) return;
		dragId = id;
		event.dataTransfer.effectAllowed = 'move';
		event.dataTransfer.setData('text/plain', String(id));
	}

	function onDragOver(event) {
		let target = dropTarget(event);
		clearDropMarks();
		if (!target) return;
		event.preventDefault();
		event.dataTransfer.dropEffect = 'move';
		target.row.classList.add('drop-' + target.zone);
	}

	function onDrop(event) {
		let target = dropTarget(event);
		clearDropMarks();
		if (!target) return;
		event.preventDefault();
		let movingId = dragId;
		dragId = null;
		try {
			if (target.zone === 'inside') {
				expanded.add(target.id);
				doc.move(movingId, target.id);
			}
			else {
				let parent = doc.parentOf(target.id);
				let index = parent.children.findIndex(c => c.id === target.id) + (target.zone === 'after' ? 1 : 0);
				doc.move(movingId, parent.id, index);
			}
			selectNode(movingId);
		}
		catch (e) {
			showError(e);
		}
	}

	function onDragEnd() {
		dragId = null;
		clearDropMarks();
	}


	//
	// Toolbar actions
	//

	const NEW_DEFAULTS = {
		text: { name: 'text', attrs: { variable: 'title' } },
		number: { name: 'number', attrs: { variable: 'volume' } },
		label: { name: 'label', attrs: { variable: 'page' } },
		names: { name: 'names', attrs: { variable: 'author' } },
		date: { name: 'date', attrs: { variable: 'issued', form: 'numeric' } },
		group: { name: 'group', attrs: { delimiter: ', ' } },
		choose: { name: 'choose', children: [{ name: 'if', attrs: { variable: 'title' } }] },
		name: { name: 'name' },
		'name-part': { name: 'name-part', attrs: { name: 'family' } },
		'date-part': { name: 'date-part', attrs: { name: 'year' } },
		'et-al': { name: 'et-al' },
		substitute: { name: 'substitute', children: [{ name: 'names', attrs: { variable: 'editor' } }] },
		sort: { name: 'sort', children: [{ name: 'key', attrs: { variable: 'author' } }] },
		key: { name: 'key', attrs: { variable: 'author' } }
	};

	/**
	 * Where an element chosen from the Add menu goes: inside the selected part if that can hold
	 * it, otherwise after the selected part
	 */
	function addTarget(kindToAdd) {
		let node = selectedNode();
		if (!node) return null;
		if (Schema.canContain(node.name, kindToAdd)) return { parent: node, index: undefined };
		let parent = doc.parentOf(node.id);
		if (parent && Schema.canContain(parent.name, kindToAdd)) {
			return { parent, index: parent.children.indexOf(node) + 1 };
		}
		return null;
	}

	function addableKinds() {
		let node = selectedNode();
		if (!node) return [];
		let kinds = new Set(Schema.addableChildren(node.name));
		let parent = doc.parentOf(node.id);
		if (parent) for (let k of Schema.addableChildren(parent.name)) kinds.add(k);
		return [...kinds].filter(k => addTarget(k));
	}

	function populateAddMenu() {
		let select = refs.add;
		select.replaceChildren(h('option', { value: '', l10n: ['visualStyleEditor-add-placeholder'] }));
		for (let kind of addableKinds()) {
			let label = kind === 'macro' ? 'Macro' : (Schema.getElement(kind)?.label || kind);
			select.append(h('option', { value: kind, text: label }));
		}
		select.disabled = select.options.length < 2;
	}

	function addElement(kind) {
		let target = addTarget(kind);
		if (!target) return;
		try {
			let newId;
			if (kind === 'macro') {
				let n = 1;
				while (doc.macroNode('macro-' + n)) n++;
				newId = doc.addMacro('macro-' + n);
			}
			else if (['else-if', 'else'].includes(kind) || (kind === 'if' && localName(target.parent.name) === 'choose')) {
				newId = doc.addBranch(target.parent.id, kind);
			}
			else {
				let spec = NEW_DEFAULTS[kind] || { name: kind };
				newId = doc.insert(target.parent.id, spec, target.index);
			}
			expanded.add(target.parent.id);
			selectNode(newId);
		}
		catch (e) {
			showError(e);
		}
	}

	function moveSelected(delta) {
		let node = selectedNode();
		if (!node) return;
		try {
			doc.moveBy(node.id, delta);
		}
		catch (e) {
			showError(e);
		}
	}

	function deleteSelected() {
		let node = selectedNode();
		if (!node) return;
		let parent = doc.parentOf(node.id);
		let id = node.id;
		let siblings = parent ? visibleChildren(parent) : [];
		let at = siblings.findIndex(c => c.id === id);
		try {
			doc.remove(id);
			let next = siblings[at + 1] || siblings[at - 1] || parent;
			if (next && doc.find(next.id)) selectNode(next.id, { reveal: false });
		}
		catch (e) {
			showError(e);
		}
	}

	function duplicateSelected() {
		let node = selectedNode();
		if (!node) return;
		try {
			let id = doc.duplicate(node.id);
			selectNode(id);
		}
		catch (e) {
			showError(e);
		}
	}

	function groupSelected() {
		let node = selectedNode();
		if (!node) return;
		try {
			let id = doc.wrapInGroup(node.id);
			expanded.add(id);
			selectNode(id);
		}
		catch (e) {
			showError(e);
		}
	}

	function ungroupSelected() {
		let node = selectedNode();
		if (!node) return;
		let parent = doc.parentOf(node.id);
		try {
			doc.unwrap(node.id);
			if (parent) selectNode(parent.id, { reveal: false });
		}
		catch (e) {
			showError(e);
		}
	}

	function updateToolbar() {
		let node = selectedNode();
		let kind = kindOf(node);
		refs.undo.disabled = !doc.canUndo();
		refs.redo.disabled = !doc.canRedo();
		populateAddMenu();
		refs.up.disabled = !node || !doc.canMoveBy(node.id, -1);
		refs.down.disabled = !node || !doc.canMoveBy(node.id, 1);
		refs.duplicate.disabled = !node || !doc.canDuplicate(node.id);
		refs.delete.disabled = !node || !doc.canRemove(node.id);
		let parent = node && doc.parentOf(node.id);
		refs.group.disabled = !node || !parent || !Schema.RENDERING.includes(kind)
			|| !Schema.canContain(parent.name, 'group');
		refs.ungroup.disabled = kind !== 'group';
	}

	function populateOpenMenu() {
		let select = refs.open;
		select.replaceChildren(h('option', { value: '', l10n: ['visualStyleEditor-open-placeholder'] }));
		for (let style of Zotero.VisualStyleEditor.getEditableStyles()) {
			select.append(h('option', { value: style.styleID, text: style.title }));
		}
	}

	async function saveAs() {
		let xml = Zotero.StyleCopy.stampForSave(doc.toXML());
		let { FilePicker } = ChromeUtils.importESModule('chrome://zotero/content/modules/filePicker.mjs');
		let fp = new FilePicker();
		fp.init(window, await t('visualStyleEditor-save-dialog-title'), fp.modeSave);
		fp.appendFilter('Citation Style Language', '*.csl');
		let id = doc.getInfo('id') || '';
		fp.defaultString = (id.replace(/.+\//, '') || 'untitled') + '.csl';
		let result = await fp.show();
		if (result !== fp.returnOK && result !== fp.returnReplace) return;
		try {
			await Zotero.File.putContentsAsync(fp.file, xml);
			doc.markSaved();
			unsavedOrigin = false;
			updateTitle();
			showMessage(await t('visualStyleEditor-message-saved', { path: fp.file }), false);
		}
		catch (e) {
			showError(e);
		}
	}

	async function install() {
		await runValidate();
		if (lastValidation && lastValidation.errors) {
			showMessage(await t('visualStyleEditor-error-install-invalid'));
			return;
		}
		try {
			let result = await Zotero.VisualStyleEditor.install(doc.toXML());
			if (!result) return; // Cancelled, or Zotero already explained the problem
			doc.markSaved();
			unsavedOrigin = false;
			populateOpenMenu();
			updateTitle();
			showMessage(await t('visualStyleEditor-message-installed', { title: result.styleTitle }), false);
		}
		catch (e) {
			showError(e);
		}
	}

	function openAI() {
		if (!Zotero.StyleAI) {
			showMessage('The AI style writer is not available in this build.');
			return;
		}
		Zotero.StyleAI.openDialog({ currentXML: doc.toXML(), parentWindow: window });
	}


	//
	// XML view
	//

	function fillXMLView() {
		refs.xmlText.value = doc.toXML();
		refs.xmlError.textContent = '';
	}

	function toggleXMLView() {
		let show = refs.xmlView.hidden;
		refs.xmlView.hidden = !show;
		refs.inspector.hidden = show;
		if (show) {
			fillXMLView();
			refs.xmlText.focus();
		}
		else {
			renderInspector();
		}
	}

	function applyXML() {
		try {
			doc.replaceXML(refs.xmlText.value);
			refs.xmlError.textContent = '';
			expanded.add(doc.root.id);
			doc.walk((node) => {
				if (!['macro', 'info', 'locale'].includes(localName(node.name))) expanded.add(node.id);
			});
			selectedId = doc.root.id;
			renderAll();
		}
		catch (e) {
			if (e instanceof CSLParseError) {
				refs.xmlError.textContent = e.message;
				// Put the cursor where the problem is
				let lines = refs.xmlText.value.split('\n');
				let offset = lines.slice(0, e.line - 1).reduce((n, l) => n + l.length + 1, 0) + e.column - 1;
				refs.xmlText.focus();
				refs.xmlText.setSelectionRange(offset, offset);
			}
			else {
				showError(e);
			}
		}
	}


	//
	// The inspector
	//

	function buildDatalists() {
		let make = (id, values) => document.body.append(
			h('datalist', { id }, values.map(v => h('option', { value: v })))
		);
		make('vse-dl-variables', Schema.ALL_VARIABLES);
		make('vse-dl-types', Schema.ITEM_TYPES);
		make('vse-dl-terms', Schema.COMMON_TERMS);
	}

	function renderInspector() {
		let box = refs.inspector;
		box.replaceChildren();
		let node = selectedNode();
		if (!node) {
			box.append(h('p', { class: 'vse-empty', l10n: ['visualStyleEditor-inspector-nothing'] }));
			return;
		}
		let desc = doc.describe(node.id);
		box.append(h('h3', { class: 'vse-node-title' },
			h('span', { class: 'vse-badge', 'data-kind': badgeKind(kindOf(node)), text: kindOf(node) }),
			' ', desc.title));

		switch (kindOf(node)) {
			case 'info':
				renderInfoForm(box, node);
				break;
			case 'locale':
				box.append(h('p', { l10n: ['visualStyleEditor-locale-note'] }));
				break;
			case 'macro':
				renderMacroForm(box, node);
				break;
			default:
				renderAttributeForm(box, node);
		}
	}

	function section(titleId, ...children) {
		let kids = children.flat(Infinity).filter(Boolean);
		if (!kids.length) return null;
		return h('fieldset', { class: 'vse-section' },
			h('legend', { l10n: [titleId] }),
			kids);
	}

	/** A labelled control with a line underneath for hints and warnings */
	function field(labelNode, control, hint) {
		let id = 'vse-f-' + Math.random().toString(36).slice(2, 8);
		control.id = id;
		return h('div', { class: 'vse-field' },
			h('label', { for: id }, labelNode),
			control,
			hint || null);
	}

	/** Write an attribute from the inspector without rebuilding the inspector */
	function commit(id, name, value) {
		applyingFromInspector = true;
		try {
			doc.setAttr(id, name, value);
		}
		catch (e) {
			showError(e);
		}
		finally {
			applyingFromInspector = false;
		}
	}

	function commitMany(id, changes) {
		applyingFromInspector = true;
		try {
			doc.setAttrs(id, changes);
		}
		catch (e) {
			showError(e);
		}
		finally {
			applyingFromInspector = false;
		}
	}

	function updateHint(hint, node, spec, value) {
		let warning = doc.checkAttr(node.id, spec.name, value);
		let text = warning || '';
		if (!warning && spec.type === 'text' && value && /^ | $/.test(value)) {
			text = showSpaces(value);
			hint.classList.add('spaces');
		}
		else {
			hint.classList.remove('spaces');
		}
		hint.textContent = text;
		hint.classList.toggle('warning', !!warning);
	}

	/** The right kind of control for one attribute */
	function attributeControl(node, spec, current, onValue) {
		let hint = h('div', { class: 'vse-hint' });
		let control;
		let live = (value) => {
			onValue(value);
			updateHint(hint, node, spec, value);
		};
		let liveDebounced = debounce(live, COMMIT_DELAY);

		switch (spec.type) {
			case 'enum': {
				control = h('select', { on: { change: () => live(control.value) } },
					h('option', { value: '', l10n: ['visualStyleEditor-default-value'] }),
					spec.values.map(v => h('option', { value: v, text: v })));
				if (current && !spec.values.includes(current)) control.append(h('option', { value: current, text: current }));
				control.value = current || '';
				break;
			}
			case 'macro': {
				control = h('select', { on: { change: () => live(control.value) } },
					h('option', { value: '' }),
					doc.macros().map(m => h('option', { value: m.name, text: m.name })));
				if (current && !doc.macroNode(current)) control.append(h('option', { value: current, text: current }));
				control.value = current || '';
				break;
			}
			default: {
				let list = {
					variable: 'vse-dl-variables', variables: 'vse-dl-variables', 'item-types': 'vse-dl-types',
					term: 'vse-dl-terms'
				}[spec.type];
				control = h('input', {
					type: spec.type === 'integer' ? 'number' : 'text',
					min: spec.type === 'integer' ? '0' : null,
					list,
					autocomplete: 'off',
					spellcheck: 'false',
					value: current || '',
					on: {
						input: () => liveDebounced(control.value),
						change: () => liveDebounced.flush(control.value)
					}
				});
			}
		}
		updateHint(hint, node, spec, current || '');
		return { control, hint };
	}

	function attributeField(node, spec) {
		let current = doc.getAttr(node.id, spec.name);
		let { control, hint } = attributeControl(node, spec, current, value => commit(node.id, spec.name, value));
		return field(spec.label, control, hint);
	}

	// Parts of an element's content that are mutually exclusive, and what a fresh one starts as
	const SOURCES = {
		text: ['variable', 'macro', 'term', 'value'],
		key: ['variable', 'macro']
	};
	const SOURCE_DEFAULTS = { variable: 'title', term: 'page', value: 'text' };

	function sourceField(node) {
		let kind = kindOf(node);
		let sources = SOURCES[kind];
		let current = sources.find(s => doc.getAttr(node.id, s) !== null) || sources[0];
		let spec = Schema.getElement(kind).attrs[current];

		let chooser = h('select', {
			on: {
				change: () => {
					let next = chooser.value;
					let changes = {};
					for (let s of sources) changes[s] = null;
					changes[next] = next === 'macro'
						? (doc.macros()[0] || {}).name || null
						: SOURCE_DEFAULTS[next];
					commitMany(node.id, changes);
					renderInspector();
				}
			}
		}, sources.map(s => h('option', { value: s, l10n: ['visualStyleEditor-source-' + s] })));
		chooser.value = current;

		let { control, hint } = attributeControl(
			node,
			Object.assign({ name: current }, spec),
			doc.getAttr(node.id, current),
			value => commit(node.id, current, value)
		);
		return [
			field(h('span', { l10n: ['visualStyleEditor-source-label'] }), chooser),
			field(spec.label, control, hint)
		];
	}

	// Formatting that is simply on or off, as toggle buttons
	const TOGGLES = [
		{ id: 'italic', attr: 'font-style', on: 'italic' },
		{ id: 'bold', attr: 'font-weight', on: 'bold' },
		{ id: 'small-caps', attr: 'font-variant', on: 'small-caps' },
		{ id: 'underline', attr: 'text-decoration', on: 'underline' },
		{ id: 'superscript', attr: 'vertical-align', on: 'sup' },
		{ id: 'subscript', attr: 'vertical-align', on: 'sub' },
		{ id: 'quotes', attr: 'quotes', on: 'true' }
	];

	function toggleRow(node) {
		let attrs = Schema.getElement(node.name).attrs;
		let buttons = TOGGLES.filter(tg => attrs[tg.attr]).map((tg) => {
			let button = h('button', {
				type: 'button',
				class: 'vse-toggle',
				'aria-pressed': doc.getAttr(node.id, tg.attr) === tg.on ? 'true' : 'false',
				l10n: ['visualStyleEditor-format-' + tg.id],
				on: {
					click: () => {
						let pressed = button.getAttribute('aria-pressed') === 'true';
						commit(node.id, tg.attr, pressed ? null : tg.on);
						// Superscript and subscript are one attribute, so refresh the whole row
						renderInspector();
					}
				}
			});
			return button;
		});
		return buttons.length ? h('div', { class: 'vse-toggles', role: 'group' }, buttons) : null;
	}

	function renderAttributeForm(box, node) {
		let kind = kindOf(node);
		let groups = Schema.groupAttrs(node.name);
		let handledBySource = SOURCES[kind] || [];
		let toggled = new Set(TOGGLES.map(tg => tg.attr));

		let main = groups.main.filter(a => !handledBySource.includes(a.name));
		let content = [
			SOURCES[kind] ? sourceField(node) : null,
			main.map(spec => attributeField(node, spec))
		];
		let formatting = [
			toggleRow(node),
			groups.formatting.filter(a => !toggled.has(a.name)).map(spec => attributeField(node, spec))
		];

		box.append(
			section('visualStyleEditor-section-content', content),
			section('visualStyleEditor-section-formatting', formatting),
			section('visualStyleEditor-section-punctuation', groups.affixes.map(spec => attributeField(node, spec))),
			section('visualStyleEditor-section-names', groups.names.map(spec => attributeField(node, spec)))
		);
		if (!box.querySelector('.vse-section')) {
			box.append(h('p', { class: 'vse-empty', l10n: ['visualStyleEditor-no-settings'] }));
		}
		if (kind === 'style') {
			box.append(h('p', { class: 'vse-hint', l10n: ['visualStyleEditor-style-note'] }));
		}
	}

	const INFO_FIELDS = [
		{ name: 'title', label: 'Title' },
		{ name: 'title-short', label: 'Short title' },
		{ name: 'id', label: 'ID (a unique web address)' },
		{ name: 'summary', label: 'Summary' },
		{ name: 'rights', label: 'License' }
	];

	function renderInfoForm(box, node) {
		let fields = INFO_FIELDS.map((info) => {
			let control = h('input', {
				type: 'text',
				spellcheck: 'false',
				value: doc.getInfo(info.name) || '',
				on: {
					input: debounce(() => {
						applyingFromInspector = true;
						try {
							doc.setInfo(info.name, control.value);
						}
						catch (e) {
							showError(e);
						}
						finally {
							applyingFromInspector = false;
						}
					}, COMMIT_DELAY)
				}
			});
			return field(info.label, control);
		});
		let updated = doc.getInfo('updated');
		box.append(
			section('visualStyleEditor-section-about', fields),
			h('p', { class: 'vse-hint', l10n: ['visualStyleEditor-info-note', { updated: updated || '' }] })
		);
	}

	function renderMacroForm(box, node) {
		let name = doc.getAttr(node.id, 'name') || '';
		let control = h('input', {
			type: 'text',
			spellcheck: 'false',
			value: name,
			on: {
				change: () => {
					try {
						doc.renameMacro(node.id, control.value.trim());
					}
					catch (e) {
						showError(e);
						control.value = doc.getAttr(node.id, 'name') || '';
					}
				}
			}
		});
		let uses = doc.macroUsages(name).length;
		box.append(
			section('visualStyleEditor-section-content', field(h('span', { l10n: ['visualStyleEditor-macro-name'] }), control)),
			h('p', {
				class: 'vse-hint',
				l10n: [uses ? 'visualStyleEditor-macro-uses' : 'visualStyleEditor-macro-unused', { count: uses }]
			})
		);
	}


	//
	// Validation
	//

	function scheduleValidate(delay = VALIDATE_DELAY) {
		clearTimeout(validateTimer);
		validateTimer = setTimeout(runValidate, delay);
	}

	async function runValidate() {
		clearTimeout(validateTimer);
		let token = ++validateToken;
		let { xml, lineMap } = doc.toXMLWithLines();
		document.l10n.setAttributes(refs.validity, 'visualStyleEditor-status-checking');
		refs.validity.className = '';
		let errors = await Zotero.VisualStyleEditor.validate(xml);
		if (token !== validateToken) return;

		let errorLine = null;
		let message = '';
		if (errors) {
			// The first message is the root cause; the rest are knock-on effects
			let match = /^[^:]*:(\d+):\d+: error: (.+)/m.exec(errors);
			if (match) {
				errorLine = Number(match[1]);
				message = match[2];
			}
			else {
				message = errors.split('\n')[0];
			}
		}
		lastValidation = { errors, lineMap, errorLine };

		if (errors) {
			document.l10n.setAttributes(refs.validity, 'visualStyleEditor-status-error', { message });
			refs.validity.className = 'invalid';
		}
		else {
			document.l10n.setAttributes(refs.validity, 'visualStyleEditor-status-valid');
			refs.validity.className = 'valid';
		}
		refs.gotoError.hidden = !(errors && errorLine && nodeAtLine(lineMap, errorLine));
	}

	function gotoError() {
		if (!lastValidation || !lastValidation.errorLine) return;
		let id = nodeAtLine(lastValidation.lineMap, lastValidation.errorLine);
		if (id !== null && doc.find(id)) selectNode(id);
	}


	//
	// Preview
	//

	function populatePreviewControls() {
		let locales = Object.entries(Zotero.Styles.locales || {}).sort((a, b) => a[1].localeCompare(b[1]));
		let fallback = Zotero.Styles.resolveLocale(Zotero.locale);
		if (fallback && !locales.some(([code]) => code === fallback)) locales.unshift([fallback, fallback]);
		refs.previewLocale.replaceChildren(...locales.map(([code, name]) => h('option', { value: code, text: name })));
		refs.previewLocale.value = Zotero.Prefs.get('export.lastLocale') || fallback || 'en-US';

		refs.previewPosition.replaceChildren(
			...Zotero.StylePreview.POSITIONS.map(p => h('option', { value: p.id, text: p.id }))
		);

		let labels = Zotero.Cite.labels || ['page'];
		refs.previewLocatorLabel.replaceChildren(
			...labels.map(label => h('option', { value: label, text: Zotero.Cite.getLocatorString(label) }))
		);
		refs.previewLocatorLabel.value = 'page';
	}

	function getPreviewItems() {
		let pane = Zotero.getActiveZoteroPane && Zotero.getActiveZoteroPane();
		let items = pane ? pane.getSelectedItems() : [];
		return items.filter(item => item.isRegularItem()).slice(0, MAX_PREVIEW_ITEMS);
	}

	/** Re-render if the selection in the library changed since the preview was drawn */
	function refreshPreviewItems() {
		let ids = getPreviewItems().map(i => i.id).join(',');
		if (ids !== lastPreviewItemIDs) schedulePreview(0);
	}

	function schedulePreview(delay = PREVIEW_DELAY) {
		clearTimeout(previewTimer);
		previewTimer = setTimeout(renderPreview, delay);
	}

	function renderPreview() {
		if (!doc) return;
		let items = getPreviewItems();
		lastPreviewItemIDs = items.map(i => i.id).join(',');
		document.l10n.setAttributes(
			refs.previewItems,
			items.length ? 'visualStyleEditor-preview-items' : 'visualStyleEditor-preview-no-items',
			{ count: items.length }
		);
		let result = Zotero.StylePreview.render(doc.toXML(), {
			items,
			locale: refs.previewLocale.value,
			locator: refs.previewLocator.value.trim(),
			locatorLabel: refs.previewLocatorLabel.value,
			suppressAuthor: refs.previewSuppress.checked,
			position: refs.previewPosition.value
		});
		refs.preview.srcdoc = Zotero.StylePreview.wrapDocument(result.html);
	}


	//
	// Wiring
	//

	function bindEvents() {
		refs.tree.addEventListener('click', onTreeClick);
		refs.tree.addEventListener('keydown', onTreeKeyDown);
		refs.tree.addEventListener('dragstart', onDragStart);
		refs.tree.addEventListener('dragover', onDragOver);
		refs.tree.addEventListener('dragleave', clearDropMarks);
		refs.tree.addEventListener('drop', onDrop);
		refs.tree.addEventListener('dragend', onDragEnd);

		refs.undo.addEventListener('click', () => doc.undo());
		refs.redo.addEventListener('click', () => doc.redo());
		refs.up.addEventListener('click', () => moveSelected(-1));
		refs.down.addEventListener('click', () => moveSelected(1));
		refs.duplicate.addEventListener('click', duplicateSelected);
		refs.group.addEventListener('click', groupSelected);
		refs.ungroup.addEventListener('click', ungroupSelected);
		refs.delete.addEventListener('click', deleteSelected);
		refs.add.addEventListener('change', () => {
			let kind = refs.add.value;
			refs.add.value = '';
			if (kind) addElement(kind);
		});

		refs.open.addEventListener('change', async () => {
			let styleID = refs.open.value;
			refs.open.value = '';
			if (styleID) await this.openRequest({ styleID });
		});
		refs.new.addEventListener('change', async () => {
			let kind = refs.new.value;
			refs.new.value = '';
			if (kind) await this.openRequest({ kind });
		});

		refs.ai.addEventListener('click', openAI);
		refs.xml.addEventListener('click', toggleXMLView);
		refs.xmlApply.addEventListener('click', applyXML);
		refs.xmlClose.addEventListener('click', toggleXMLView);
		refs.save.addEventListener('click', saveAs);
		refs.install.addEventListener('click', install);
		refs.gotoError.addEventListener('click', gotoError);

		for (let el of [refs.previewLocale, refs.previewPosition, refs.previewLocatorLabel, refs.previewSuppress]) {
			el.addEventListener('change', () => {
				if (el === refs.previewLocale) Zotero.Prefs.set('export.lastLocale', el.value);
				schedulePreview(0);
			});
		}
		refs.previewLocator.addEventListener('input', () => schedulePreview());
		refs.previewRefresh.addEventListener('click', () => schedulePreview(0));

		window.addEventListener('keydown', (event) => {
			let accel = Zotero.isMac ? event.metaKey : event.ctrlKey;
			if (!accel || event.altKey) return;
			// Leave the text fields' own undo alone
			let tag = (event.target.tagName || '').toLowerCase();
			if (['input', 'textarea', 'select'].includes(tag)) return;
			let key = event.key.toLowerCase();
			if (key === 'z' && !event.shiftKey) {
				doc.undo();
				event.preventDefault();
			}
			else if ((key === 'z' && event.shiftKey) || key === 'y') {
				doc.redo();
				event.preventDefault();
			}
		});

		// Closing with unsaved work asks first
		window.addEventListener('close', (event) => {
			if (!confirmDiscard()) event.preventDefault();
		});
	}
}();

window.addEventListener('load', (event) => {
	if (event.target !== document) return;
	Zotero_VisualStyleEditor.init().catch((e) => {
		Zotero.logError(e);
	});
});

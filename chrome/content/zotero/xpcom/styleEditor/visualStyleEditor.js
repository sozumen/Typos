"use strict";

/**
 * Opening the visual style editor and connecting it to the application's list of styles
 *
 * The editor itself is a window (tools/visualStyleEditor.html). This module opens or focuses it,
 * hands it the style to start from, and installs finished styles. Windows can't be passed
 * arguments with window.open(), but every window shares the Zotero object, so a request is parked
 * here and the window collects it as it loads.
 *
 *   Zotero.VisualStyleEditor.open()                              last-used style, as a working copy
 *   Zotero.VisualStyleEditor.open({ styleID })                   a working copy of an installed style
 *   Zotero.VisualStyleEditor.open({ kind: 'note', title: 'X' })  a new style from a template
 *   Zotero.VisualStyleEditor.open({ xml, title })                this CSL (e.g. one written by the AI)
 *
 * Pure logic is in cslTree.js, cslTemplates.js and styleCopy.js (tested in plain Node).
 */
Zotero.VisualStyleEditor = new function () {
	const WINDOW_TYPE = 'zotero:visual-style-editor';
	const WINDOW_URL = 'chrome://zotero/content/tools/visualStyleEditor.html';
	const WINDOW_FEATURES = 'chrome,width=1280,height=800,resizable,centerscreen';

	var _pending = null;

	this.WINDOW_TYPE = WINDOW_TYPE;

	/**
	 * @param {Object} [request]
	 * @param {String} [request.styleID] - Edit a copy of this installed style
	 * @param {String} [request.kind] - 'author-date', 'numeric' or 'note': start from a template
	 * @param {String} [request.title] - Title for a new or imported style
	 * @param {String} [request.xml] - Open exactly this CSL
	 * @param {String} [request.notice] - A message to show on opening (e.g. what the AI changed)
	 */
	this.open = function (request = {}) {
		let existing = Services.wm.getMostRecentWindow(WINDOW_TYPE);
		if (existing && existing.Zotero_VisualStyleEditor) {
			existing.focus();
			existing.Zotero_VisualStyleEditor.openRequest(request);
			return existing;
		}
		_pending = request;
		return Services.ww.openWindow(null, WINDOW_URL, '_blank', WINDOW_FEATURES, null);
	};

	/** Called by the editor window as it loads */
	this.takePending = function () {
		let request = _pending;
		_pending = null;
		return request;
	};

	/** IDs of every installed style, visible or not */
	this.getInstalledStyleIDs = function () {
		return Object.keys(Zotero.Styles.getAll());
	};

	/** Installed styles that have a layout of their own, so can be edited, sorted by title */
	this.getEditableStyles = function () {
		return Zotero.Styles.getVisible()
			.filter(style => !style.source)
			.sort((a, b) => a.title.localeCompare(b.title));
	};

	/** A working copy of an installed style: { xml, id, title, originalID } */
	this.makeWorkingCopy = function (styleID) {
		let style = Zotero.Styles.get(styleID);
		if (!style) throw new Error(`No installed style ${styleID}`);
		return Zotero.StyleCopy.makeWorkingCopy(style.getXML(), {
			existingIds: this.getInstalledStyleIDs()
		});
	};

	/** A new style from a template: { xml, id, title } */
	this.makeNewStyle = function (kind, title) {
		let id = Zotero.CSLTemplates.makeStyleId(title || 'Untitled style', this.getInstalledStyleIDs());
		let xml = Zotero.CSLTemplates.newStyleXML(kind, {
			title: title || 'Untitled style',
			id,
			locale: Zotero.Prefs.get('export.lastLocale') || 'en-US'
		});
		return { xml, id, title: title || 'Untitled style' };
	};

	/**
	 * Check a style against the CSL schema
	 * @return {Promise<String|null>} - The validator's messages, or null if the style is valid
	 */
	this.validate = async function (xml) {
		try {
			await Zotero.Styles.validate(xml);
			return null;
		}
		catch (errors) {
			return String(errors);
		}
	};

	/**
	 * Add a style to the application, stamping it with the current time. Zotero's own install
	 * code asks before replacing a style that is already installed and reports other problems.
	 * @return {Promise<{ styleID: String, styleTitle: String }|null>} - null if it was not installed
	 */
	this.install = async function (xml) {
		let stamped = Zotero.StyleCopy.stampForSave(xml);
		let result = await Zotero.Styles.install({ string: stamped }, 'Visual Style Editor', false);
		return result && result.styleID ? result : null;
	};
}();

"use strict";

/**
 * Preparing styles for the visual editor: making an editable working copy of an installed style,
 * and stamping a style when it is saved
 *
 * Editing an installed style never changes that style. The editor opens a copy with its own ID and
 * title, linked back to the original, so saving it adds a new style next to the one it came from.
 *
 * Tested in plain Node: fork/test/styleCopy.test.js
 */
(function (root) {
	const isNode = typeof module !== 'undefined' && module.exports;
	const Tree = isNode ? require('./cslTree.js') : root.CSLTree;
	const Templates = isNode ? require('./cslTemplates.js') : root.CSLTemplates;
	const { StyleDoc, elementChildren, getAttr } = Tree;

	class DependentStyleError extends Error {
		constructor(message) {
			super(message);
			this.name = 'DependentStyleError';
		}
	}

	/** A dependent style borrows another style's layout, so it has nothing here to edit */
	function isDependent(doc) {
		return doc.findAll('layout').length === 0;
	}

	function infoNode(doc) {
		return doc.findAll('info')[0];
	}

	function linksWithRel(doc, rels) {
		let info = infoNode(doc);
		return elementChildren(info).filter(c => c.name === 'link' && rels.includes(getAttr(c, 'rel')));
	}

	/**
	 * @param {String} xml - The style to copy
	 * @param {Object} [options]
	 * @param {Iterable<String>} [options.existingIds] - IDs already taken
	 * @param {String} [options.titleSuffix=' (custom)']
	 * @param {String} [options.now] - ISO date-time for cs:updated; defaults to now
	 * @return {{ xml: String, id: String, title: String, originalID: String|null }}
	 * @throws {DependentStyleError} if the style has no layout of its own
	 */
	function makeWorkingCopy(xml, options = {}) {
		let doc = StyleDoc.fromXML(xml);
		if (isDependent(doc)) {
			throw new DependentStyleError('This style takes its layout from another style, so there is nothing to edit in it');
		}
		let info = infoNode(doc);
		if (!info) throw new Error('This style has no information block');

		let originalID = doc.getInfo('id');
		let title = (doc.getInfo('title') || 'Untitled style') + (options.titleSuffix === undefined ? ' (custom)' : options.titleSuffix);
		let id = Templates.makeStyleId(title, options.existingIds || []);

		// The new style is not the one at its old address, and is never a dependent
		for (let link of linksWithRel(doc, ['self', 'independent-parent', 'template'])) doc.remove(link.id);

		doc.setInfo('title', title);
		doc.setInfo('id', id);
		doc.setInfo('updated', options.now || new Date().toISOString());
		if (originalID) doc.insert(info.id, { name: 'link', attrs: { href: originalID, rel: 'template' } });

		return { xml: doc.toXML(), id, title, originalID };
	}

	/** The style as it should be written out: the update time refreshed */
	function stampForSave(xml, now) {
		let doc = StyleDoc.fromXML(xml);
		if (!infoNode(doc)) return xml;
		doc.setInfo('updated', now || new Date().toISOString());
		return doc.toXML();
	}

	/** Title and ID of a style, or nulls if it cannot be read */
	function readIdentity(xml) {
		try {
			let doc = StyleDoc.fromXML(xml);
			return { id: doc.getInfo('id'), title: doc.getInfo('title') };
		}
		catch (e) {
			return { id: null, title: null };
		}
	}

	const api = { DependentStyleError, isDependent, makeWorkingCopy, stampForSave, readIdentity };

	if (isNode) {
		module.exports = api;
	}
	else if (root) {
		root.StyleCopy = api;
	}
})(typeof Zotero !== 'undefined' ? Zotero : null);

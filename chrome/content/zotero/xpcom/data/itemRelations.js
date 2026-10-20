"use strict";

/**
 * Typed, directed relationships between items
 *
 * Zotero's built-in "related items" (dc:relation) are symmetric and untyped. This module adds
 * directed, typed relations such as "is a critical edition of" or "is part of". A relation is
 * stored once, on the subject item, as the predicate-object pair (predicate, object item URI),
 * using Zotero's existing relations tables. The inverse direction ("has critical edition") is
 * answered from Zotero.Relations' reverse index, so nothing is stored twice and the two directions
 * cannot disagree.
 *
 * All relation types are acyclic: an item can't, directly or indirectly, be a part of itself,
 * a republication of itself, and so on. Cycles are rejected when a relation is added.
 */
Zotero.ItemRelations = new function () {
	const PREDICATE_PREFIX = 'rm';

	/**
	 * Relation types, keyed by short name
	 *
	 * - predicate: stored predicate (subject -> object)
	 * - l10nID / inverseL10nID: Fluent IDs for the labels shown on the subject and on the object,
	 *       e.g. "Critical edition of" / "Critical editions"
	 * - hierarchical: whether the type describes containment, so a tree view makes sense
	 */
	this.TYPES = {
		partOf: {
			predicate: PREDICATE_PREFIX + ':partOf',
			l10nID: 'item-relation-part-of',
			inverseL10nID: 'item-relation-has-part',
			hierarchical: true
		},
		republicationOf: {
			predicate: PREDICATE_PREFIX + ':republicationOf',
			l10nID: 'item-relation-republication-of',
			inverseL10nID: 'item-relation-republished-as',
			hierarchical: false
		},
		criticalEditionOf: {
			predicate: PREDICATE_PREFIX + ':criticalEditionOf',
			l10nID: 'item-relation-critical-edition-of',
			inverseL10nID: 'item-relation-has-critical-edition',
			hierarchical: false
		},
		translationOf: {
			predicate: PREDICATE_PREFIX + ':translationOf',
			l10nID: 'item-relation-translation-of',
			inverseL10nID: 'item-relation-has-translation',
			hierarchical: false
		},
		commentaryOn: {
			predicate: PREDICATE_PREFIX + ':commentaryOn',
			l10nID: 'item-relation-commentary-on',
			inverseL10nID: 'item-relation-has-commentary',
			hierarchical: false
		}
	};


	this.init = function () {
		// Relations code requires every predicate prefix to be registered
		if (!Zotero.Relations._namespaces[PREDICATE_PREFIX]) {
			throw new Error("Relation namespace '" + PREDICATE_PREFIX + "' is not registered");
		}
	};


	this.getTypeKeys = function () {
		return Object.keys(this.TYPES);
	};


	this.getTypeKeyForPredicate = function (predicate) {
		return this.getTypeKeys().find(key => this.TYPES[key].predicate === predicate) || null;
	};


	this._getType = function (typeKey) {
		let type = this.TYPES[typeKey];
		if (!type) {
			throw new Error("Unknown relation type '" + typeKey + "'");
		}
		return type;
	};


	/**
	 * Validate a proposed relation, throwing Zotero.ItemRelations.InvalidRelationError if it
	 * isn't allowed
	 *
	 * @param {Zotero.Item} subject
	 * @param {String} typeKey
	 * @param {Zotero.Item} object
	 */
	this.validate = async function (subject, typeKey, object) {
		let type = this._getType(typeKey);

		if (!subject || !object) {
			throw new this.InvalidRelationError('missing-item', "Both items are required");
		}
		if (subject.id === object.id) {
			throw new this.InvalidRelationError('self', "An item can't be related to itself");
		}
		if (!subject.isRegularItem() || !object.isRegularItem()) {
			throw new this.InvalidRelationError(
				'not-regular',
				"Only top-level items can have typed relationships"
			);
		}
		if (subject.libraryID !== object.libraryID) {
			throw new this.InvalidRelationError(
				'different-library',
				"Items must be in the same library"
			);
		}

		let objectURI = Zotero.URI.getItemURI(object);
		if (subject.hasRelation(type.predicate, objectURI)) {
			throw new this.InvalidRelationError('exists', "This relationship already exists");
		}

		let subjectURI = Zotero.URI.getItemURI(subject);
		if (await Zotero.RelationGraph.wouldCreateCycle(
			subjectURI,
			objectURI,
			uri => this._getOutgoingURIs(uri, type.predicate)
		)) {
			throw new this.InvalidRelationError(
				'cycle',
				"This relationship would make an item part of its own chain"
			);
		}
	};


	/**
	 * @param {Zotero.Item} subject
	 * @param {String} typeKey
	 * @param {Zotero.Item} object
	 * @param {Object} [options]
	 * @param {Boolean} [options.skipSave=false] - Don't save the subject (the caller is
	 *     responsible for saving)
	 * @return {Promise<void>}
	 */
	this.add = async function (subject, typeKey, object, options = {}) {
		await this.validate(subject, typeKey, object);
		let type = this._getType(typeKey);
		subject.addRelation(type.predicate, Zotero.URI.getItemURI(object));
		if (!options.skipSave) {
			await subject.saveTx({ skipDateModifiedUpdate: true });
		}
	};


	this.remove = async function (subject, typeKey, object, options = {}) {
		let type = this._getType(typeKey);
		let removed = subject.removeRelation(type.predicate, Zotero.URI.getItemURI(object));
		if (removed && !options.skipSave) {
			await subject.saveTx({ skipDateModifiedUpdate: true });
		}
		return removed;
	};


	/**
	 * URIs this item points at with the given predicate
	 */
	this._getOutgoingURIs = async function (uri, predicate) {
		let item = await Zotero.URI.getURIItem(uri);
		if (!item) return [];
		return item.getRelationsByPredicate(predicate);
	};


	/**
	 * Items that point at the given item with the given predicate
	 */
	this._getIncomingURIs = async function (uri, predicate) {
		let subjects = await Zotero.Relations.getByPredicateAndObject('item', predicate, uri);
		return subjects.map(item => Zotero.URI.getItemURI(item));
	};


	/**
	 * Resolve URIs to live (existing, non-trashed) items, dropping the rest
	 */
	async function _resolve(uris) {
		let items = [];
		for (let uri of uris) {
			let item = await Zotero.URI.getURIItem(uri);
			if (item && !item.deleted) {
				items.push(item);
			}
		}
		return items;
	}


	/**
	 * Relations this item is the subject of
	 *
	 * @param {Zotero.Item} item
	 * @return {Promise<{ typeKey: String, items: Zotero.Item[] }[]>} - Only types that have items
	 */
	this.getOutgoing = async function (item) {
		let results = [];
		for (let typeKey of this.getTypeKeys()) {
			let uris = item.getRelationsByPredicate(this.TYPES[typeKey].predicate);
			let items = await _resolve(uris);
			if (items.length) {
				results.push({ typeKey, items });
			}
		}
		return results;
	};


	/**
	 * Relations this item is the object of (the inverse direction)
	 */
	this.getIncoming = async function (item) {
		let uri = Zotero.URI.getItemURI(item);
		let results = [];
		for (let typeKey of this.getTypeKeys()) {
			let uris = await this._getIncomingURIs(uri, this.TYPES[typeKey].predicate);
			let items = await _resolve(uris);
			if (items.length) {
				results.push({ typeKey, items });
			}
		}
		return results;
	};


	/**
	 * Items above this one in the chain, e.g. the book a chapter is part of, nearest first
	 *
	 * @return {Promise<{ item: Zotero.Item, depth: Number }[]>}
	 */
	this.getAncestors = async function (item, typeKey) {
		let type = this._getType(typeKey);
		let found = await Zotero.RelationGraph.collect(
			Zotero.URI.getItemURI(item),
			uri => this._getOutgoingURIs(uri, type.predicate)
		);
		return this._resolveCollected(found);
	};


	/**
	 * Items below this one in the chain, e.g. all chapters in a book, nearest first
	 */
	this.getDescendants = async function (item, typeKey) {
		let type = this._getType(typeKey);
		let found = await Zotero.RelationGraph.collect(
			Zotero.URI.getItemURI(item),
			uri => this._getIncomingURIs(uri, type.predicate)
		);
		return this._resolveCollected(found);
	};


	/**
	 * Tree of descendants rooted at an item
	 *
	 * @return {Promise<{ item: Zotero.Item, children: Object[] }>}
	 */
	this.getDescendantTree = async function (item, typeKey) {
		let type = this._getType(typeKey);
		let tree = await Zotero.RelationGraph.buildTree(
			Zotero.URI.getItemURI(item),
			uri => this._getIncomingURIs(uri, type.predicate)
		);
		let resolve = async (node) => {
			let resolved = await Zotero.URI.getURIItem(node.node);
			let children = [];
			for (let child of node.children) {
				let childNode = await resolve(child);
				if (childNode) children.push(childNode);
			}
			return resolved && !resolved.deleted ? { item: resolved, children } : null;
		};
		return resolve(tree);
	};


	this._resolveCollected = async function (found) {
		let results = [];
		for (let { node, depth } of found) {
			let item = await Zotero.URI.getURIItem(node);
			if (item && !item.deleted) {
				results.push({ item, depth });
			}
		}
		return results;
	};


	this.InvalidRelationError = class InvalidRelationError extends Error {
		constructor(code, message) {
			super(message);
			this.name = 'InvalidRelationError';
			this.code = code;
		}
	};
};

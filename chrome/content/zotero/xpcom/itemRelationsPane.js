"use strict";

/**
 * Item pane section for typed item relationships
 *
 * Registered through the item pane section API, so it appears in the item pane and side nav like
 * any other section.
 */
Zotero.ItemRelationsPane = new function () {
	const PANE_ID = 'item-relations';
	const PLUGIN_ID = 'typos@localhost';

	var _registered = false;

	this.init = function () {
		if (_registered) return;
		let result = Zotero.ItemPaneManager.registerSection({
			paneID: PANE_ID,
			pluginID: PLUGIN_ID,
			header: {
				l10nID: 'item-relations-section-header',
				icon: 'chrome://zotero/skin/16/universal/related.svg'
			},
			sidenav: {
				l10nID: 'item-relations-section-sidenav',
				icon: 'chrome://zotero/skin/16/universal/related.svg'
			},
			onItemChange: ({ body, item, editable, setEnabled }) => {
				setEnabled(!!item && item.isRegularItem());
				body.dataset.editable = editable ? 'true' : 'false';
			},
			onRender: ({ doc, body }) => {
				if (!body.querySelector('.item-relations')) {
					let container = doc.createElement('div');
					container.className = 'item-relations';
					body.append(container);
				}
			},
			onAsyncRender: async ({ doc, body, item }) => {
				await this._render(doc, body, item);
			}
		});
		_registered = !!result;
		if (!_registered) {
			Zotero.logError("Unable to register the item relationships section");
		}
	};


	this._render = async function (doc, body, item) {
		let container = body.querySelector('.item-relations');
		if (!container) return;
		let editable = body.dataset.editable === 'true';

		let outgoing = await Zotero.ItemRelations.getOutgoing(item);
		let incoming = await Zotero.ItemRelations.getIncoming(item);

		let siblings = await Zotero.ItemRelations.getSiblings(item);

		container.replaceChildren();

		for (let { typeKey, items } of outgoing) {
			let l10nID = Zotero.ItemRelations.TYPES[typeKey].l10nID;
			container.append(this._renderGroup(doc, l10nID, items, editable && ((other) => {
				return this._remove(doc, body, item, typeKey, other, 'forward');
			})));
		}
		for (let { typeKey, items } of incoming) {
			let l10nID = Zotero.ItemRelations.TYPES[typeKey].inverseL10nID;
			container.append(this._renderGroup(doc, l10nID, items, editable && ((other) => {
				return this._remove(doc, body, item, typeKey, other, 'inverse');
			})));
		}

		for (let { typeKey, parent, items } of siblings) {
			container.append(this._renderGroup(
				doc,
				Zotero.ItemRelations.TYPES[typeKey].siblingsL10nID,
				items,
				null,
				{ title: parent.getDisplayTitle() }
			));
		}

		if (!outgoing.length && !incoming.length) {
			let empty = doc.createElement('div');
			empty.className = 'empty';
			empty.setAttribute('data-l10n-id', 'item-relations-empty');
			container.append(empty);
		}

		if (editable) {
			container.append(this._renderAddControls(doc, body, item));
		}
	};


	this._renderGroup = function (doc, l10nID, items, onRemove, l10nArgs) {
		let group = doc.createElement('div');
		group.className = 'group';

		let heading = doc.createElement('div');
		heading.className = 'heading';
		heading.setAttribute('data-l10n-id', l10nID);
		if (l10nArgs) {
			heading.setAttribute('data-l10n-args', JSON.stringify(l10nArgs));
		}
		group.append(heading);

		let collation = Zotero.getLocaleCollation();
		let sorted = items.slice().sort((a, b) => collation.compareString(
			1,
			Zotero.Items.getSortTitle(a.getDisplayTitle()),
			Zotero.Items.getSortTitle(b.getDisplayTitle())
		));

		for (let other of sorted) {
			let row = doc.createElement('div');
			row.className = 'row';

			let link = doc.createElement('div');
			link.className = 'box keyboard-clickable';
			link.setAttribute('tabindex', '0');
			link.setAttribute('role', 'button');
			link.textContent = other.getDisplayTitle();
			link.addEventListener('click', () => {
				Zotero.getActiveZoteroPane()?.selectItem(other.id);
			});
			row.append(link);

			if (onRemove) {
				let remove = doc.createXULElement('toolbarbutton');
				remove.className = 'zotero-clicky zotero-clicky-minus';
				remove.setAttribute('data-l10n-id', 'section-button-remove');
				remove.setAttribute('tabindex', '0');
				remove.addEventListener('command', () => onRemove(other));
				row.append(remove);
			}

			group.append(row);
		}
		return group;
	};


	/**
	 * A select listing every relation type in both directions, and a button that opens the item
	 * picker
	 */
	this._renderAddControls = function (doc, body, item) {
		let controls = doc.createElement('div');
		controls.className = 'add-controls';

		let select = doc.createElement('select');
		select.className = 'relation-type';
		for (let typeKey of Zotero.ItemRelations.getTypeKeys()) {
			let type = Zotero.ItemRelations.TYPES[typeKey];
			for (let [direction, l10nID] of [['forward', type.l10nID], ['inverse', type.inverseL10nID]]) {
				let option = doc.createElement('option');
				option.value = typeKey + ':' + direction;
				option.setAttribute('data-l10n-id', l10nID);
				select.append(option);
			}
		}
		controls.append(select);

		let button = doc.createElement('button');
		button.setAttribute('data-l10n-id', 'item-relations-add');
		button.addEventListener('click', async () => {
			let [typeKey, direction] = select.value.split(':');
			await this._add(doc, body, item, typeKey, direction);
		});
		controls.append(button);

		return controls;
	};


	this._add = async function (doc, body, item, typeKey, direction) {
		let win = doc.defaultView;
		let io = {
			dataIn: null,
			dataOut: null,
			deferred: Zotero.Promise.defer(),
			itemTreeID: 'item-relations-select-item-dialog',
			filterLibraryIDs: [item.libraryID]
		};
		win.openDialog(
			'chrome://zotero/content/selectItemsDialog.xhtml',
			'',
			'chrome,dialog=no,centerscreen,resizable=yes',
			io
		);
		await io.deferred.promise;
		if (!io.dataOut || !io.dataOut.length) return;

		let others = await Zotero.Items.getAsync(io.dataOut);
		let failures = [];
		await Zotero.DB.executeTransaction(async () => {
			Zotero.UndoHistory.stageAction('undo-action-add-relationship');
			for (let other of others) {
				let [subject, object] = direction === 'forward' ? [item, other] : [other, item];
				try {
					await Zotero.ItemRelations.add(subject, typeKey, object, { skipSave: true });
					await subject.save({ skipDateModifiedUpdate: true });
				}
				catch (e) {
					if (e instanceof Zotero.ItemRelations.InvalidRelationError) {
						failures.push(other.getDisplayTitle() + ": " + e.message);
					}
					else {
						throw e;
					}
				}
			}
		});
		if (failures.length) {
			Zotero.alert(win, Zotero.getString('general.error'), failures.join('\n'));
		}
		await this._render(doc, body, item);
	};


	this._remove = async function (doc, body, item, typeKey, other, direction) {
		let [subject, object] = direction === 'forward' ? [item, other] : [other, item];
		await Zotero.DB.executeTransaction(async () => {
			Zotero.UndoHistory.stageAction('undo-action-remove-relationship');
			await Zotero.ItemRelations.remove(subject, typeKey, object);
		});
		await this._render(doc, body, item);
	};
};

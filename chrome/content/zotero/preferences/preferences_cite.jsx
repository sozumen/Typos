/*
    ***** BEGIN LICENSE BLOCK *****
    
    Copyright © 2006–2013 Center for History and New Media
                     George Mason University, Fairfax, Virginia, USA
                     http://zotero.org
    
    This file is part of Zotero.
    
    Zotero is free software: you can redistribute it and/or modify
    it under the terms of the GNU Affero General Public License as published by
    the Free Software Foundation, either version 3 of the License, or
    (at your option) any later version.
    
    Zotero is distributed in the hope that it will be useful,
    but WITHOUT ANY WARRANTY; without even the implied warranty of
    MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
    GNU Affero General Public License for more details.
    
    You should have received a copy of the GNU Affero General Public License
    along with Zotero.  If not, see <http://www.gnu.org/licenses/>.
    
    ***** END LICENSE BLOCK *****
*/

"use strict";

var { FilePicker } = ChromeUtils.importESModule('chrome://zotero/content/modules/filePicker.mjs');

var React = require('react');
var ReactDOM = require('react-dom');
var VirtualizedTable = require('components/virtualized-table');
var { makeRowRenderer } = VirtualizedTable;

Zotero_Preferences.Cite = {
	styles: [],
	wordPluginResourcePaths: {
		libreOffice: 'zotero-libreoffice-integration',
		macWord: 'zotero-macword-integration',
		winWord: 'zotero-winword-integration'
	},

	init: async function () {
		// Init word plugin sections
		let wordPlugins = [];
		if (Zotero.isWin) {
			wordPlugins.push('winWord');
		}
		else if (Zotero.isMac) {
			wordPlugins.push('macWord');
		}
		wordPlugins.push('libreOffice');
		await Zotero.Promise.delay();
		for (let wordPlugin of wordPlugins) {
			// This is the weirdest indirect code, but let's not fix what's not broken
			try {
				const { Installer } = ChromeUtils.importESModule(`resource://${this.wordPluginResourcePaths[wordPlugin]}/installer.mjs`);
				(new Installer(true)).showPreferences(document);
			}
			catch (e) {
				Zotero.logError(e);
			}
		}
		await this.refreshAbbreviationLists();
		await this.refreshAbbreviationProfiles();
		await this.refreshStyleAssignments();
		await this.refreshStylesList();
		document.querySelector('#zotero-prefpane-cite').addEventListener('showing', () => {
			this._tree.invalidate();
		});
	},
	
	
	/**
	 * Rebuilds the list of abbreviation lists (the built-in journal table and imported lists)
	 */
	refreshAbbreviationLists: async function () {
		let container = document.getElementById('classical-abbreviations-lists');
		if (!container) return;
		container.replaceChildren();
		
		let lists = Zotero.ClassicalAbbreviations.getAvailableLists();
		for (let list of lists) {
			let row = document.createElement('div');
			row.className = 'classical-abbreviations-row';
			
			let label = document.createElement('label');
			let checkbox = document.createElement('input');
			checkbox.type = 'checkbox';
			checkbox.checked = list.active;
			checkbox.addEventListener('change', () => this.setAbbreviationListActive(list.id, checkbox.checked));
			label.append(checkbox, ' ' + list.name + (list.builtin ? '' : ' (' + list.count + ')'));
			if (list.description || list.source) {
				label.title = [list.description, list.source].filter(Boolean).join('\n');
			}
			row.append(label);
			
			if (!list.builtin) {
				let remove = document.createElement('button');
				remove.setAttribute('data-l10n-id', 'preferences-classical-abbreviations-remove');
				remove.addEventListener('click', () => this.removeAbbreviationList(list));
				row.append(remove);
			}
			
			container.append(row);
		}
		
		// Profile editing and assignments offer these lists too
		await this.refreshAbbreviationProfiles();
	},
	
	
	/**
	 * Rebuilds the list of user-created profiles
	 */
	refreshAbbreviationProfiles: async function () {
		let container = document.getElementById('abbreviation-profiles');
		if (!container) return;
		container.replaceChildren();
		
		let profiles = Zotero.ClassicalAbbreviations.getProfiles();
		if (!profiles.length) {
			let empty = document.createElement('div');
			empty.setAttribute('data-l10n-id', 'preferences-abbreviations-profiles-none');
			container.append(empty);
		}
		for (let profile of profiles) {
			let row = document.createElement('div');
			row.className = 'classical-abbreviations-row';
			
			let summary = await document.l10n.formatValue('preferences-abbreviations-profile-summary', {
				mode: await document.l10n.formatValue('preferences-abbreviations-mode-name-' + profile.mode),
				count: profile.active.length
			});
			let label = document.createElement('label');
			label.append(profile.name + ' \u2014 ' + summary);
			row.append(label);
			
			let edit = document.createElement('button');
			edit.setAttribute('data-l10n-id', 'preferences-abbreviations-profile-edit');
			edit.addEventListener('click', () => this.editAbbreviationProfile(profile));
			row.append(edit);
			
			let remove = document.createElement('button');
			remove.setAttribute('data-l10n-id', 'preferences-classical-abbreviations-remove');
			remove.addEventListener('click', () => this.removeAbbreviationProfile(profile));
			row.append(remove);
			
			container.append(row);
		}
		
		await this.refreshStyleAssignments();
	},
	
	
	/**
	 * Opens the profile editor. With no argument, creates a new profile.
	 */
	editAbbreviationProfile: async function (profile) {
		let io = {
			profile: profile || null,
			lists: Zotero.ClassicalAbbreviations.getAvailableLists(profile ? profile.active : []),
			ok: false
		};
		window.openDialog(
			'chrome://zotero/content/preferences/abbreviationProfileEditor.xhtml',
			'zotero-preferences-abbreviationProfileEditor',
			'chrome,modal,centerscreen,resizable',
			io
		);
		if (!io.ok) return;
		Zotero.ClassicalAbbreviations.saveProfile({ ...io.result, id: profile?.id });
		await this.refreshAbbreviationProfiles();
	},
	
	
	removeAbbreviationProfile: async function (profile) {
		let message = await document.l10n.formatValue(
			'preferences-abbreviations-profile-remove-confirm',
			{ name: profile.name }
		);
		if (!Services.prompt.confirm(window, '', message)) return;
		Zotero.ClassicalAbbreviations.removeProfile(profile.id);
		await this.refreshAbbreviationProfiles();
	},
	
	
	/**
	 * Rebuilds the table of citation styles that have their own abbreviation profile
	 */
	refreshStyleAssignments: async function () {
		let container = document.getElementById('abbreviation-style-assignments');
		if (!container) return;
		container.replaceChildren();
		await Zotero.Styles.init();
		
		let assignments = Zotero.ClassicalAbbreviations.getAssignments();
		let entries = Object.entries(assignments);
		if (!entries.length) {
			let empty = document.createElement('div');
			empty.setAttribute('data-l10n-id', 'preferences-abbreviations-styles-none');
			container.append(empty);
		}
		for (let [styleID, profileID] of entries) {
			let row = document.createElement('div');
			row.className = 'classical-abbreviations-row';
			
			let style = Zotero.Styles.get(styleID);
			let label = document.createElement('label');
			label.append(style ? style.title : styleID);
			if (!style) label.title = styleID;
			row.append(label);
			
			let select = await this._abbreviationProfileSelect(profileID);
			select.addEventListener('change', () => {
				Zotero.ClassicalAbbreviations.setAssignment(styleID, select.value);
			});
			row.append(select);
			
			let remove = document.createElement('button');
			remove.setAttribute('data-l10n-id', 'preferences-classical-abbreviations-remove');
			remove.addEventListener('click', async () => {
				Zotero.ClassicalAbbreviations.setAssignment(styleID, null);
				await this.refreshStyleAssignments();
			});
			row.append(remove);
			
			container.append(row);
		}
		
		// Menu for adding a style: only styles that don't have an assignment yet
		let addMenu = document.getElementById('abbreviation-style-add');
		if (addMenu) {
			let popup = addMenu.querySelector('menupopup');
			popup.replaceChildren();
			addMenu.appendItem(await document.l10n.formatValue('preferences-abbreviations-styles-add'), '');
			for (let style of Zotero.Styles.getVisible()) {
				if (!assignments[style.styleID]) addMenu.appendItem(style.title, style.styleID);
			}
			addMenu.selectedIndex = 0;
		}
	},
	
	
	/**
	 * A <select> for choosing a profile: the general settings, none, or a user-created profile
	 */
	_abbreviationProfileSelect: async function (selected) {
		let select = document.createElement('select');
		let options = [
			['default', await document.l10n.formatValue('preferences-abbreviations-choice-default')],
			['off', await document.l10n.formatValue('preferences-abbreviations-choice-off')]
		];
		for (let profile of Zotero.ClassicalAbbreviations.getProfiles()) {
			options.push([profile.id, profile.name]);
		}
		for (let [value, text] of options) {
			let option = document.createElement('option');
			option.value = value;
			option.textContent = text;
			select.append(option);
		}
		select.value = selected;
		return select;
	},
	
	
	addStyleAssignment: async function (styleID) {
		if (!styleID) return;
		Zotero.ClassicalAbbreviations.setAssignment(styleID, 'default');
		await this.refreshStyleAssignments();
	},
	
	
	/**
	 * Activate or deactivate a list. Active lists are searched in the order they were imported.
	 */
	setAbbreviationListActive: function (id, active) {
		let ids = Zotero.ClassicalAbbreviations.getActiveIDs().filter(x => x !== id);
		if (active) ids.push(id);
		Zotero.ClassicalAbbreviations.setActiveIDs(ids);
	},
	
	
	importAbbreviationList: async function () {
		let title = await document.l10n.formatValue('preferences-classical-abbreviations-import-title');
		let fp = new FilePicker();
		fp.init(window, title, fp.modeOpen);
		fp.appendFilter("Abbreviation lists", "*.json; *.csv; *.tsv; *.txt");
		
		let rv = await fp.show();
		if (rv != fp.returnOK && rv != fp.returnReplace) return;
		
		try {
			let { list, warnings } = await Zotero.ClassicalAbbreviations.importFile(fp.file);
			if (warnings.length) {
				let shown = warnings.slice(0, 10).join('\n');
				if (warnings.length > 10) shown += '\n…';
				Zotero.alert(window, list.name, shown);
			}
		}
		catch (e) {
			Zotero.logError(e);
			Zotero.alert(
				window,
				await document.l10n.formatValue('preferences-classical-abbreviations-import-failed'),
				e.message
			);
		}
		await this.refreshAbbreviationLists();
	},
	
	
	removeAbbreviationList: async function (list) {
		let message = await document.l10n.formatValue(
			'preferences-classical-abbreviations-remove-confirm',
			{ name: list.name }
		);
		if (!Services.prompt.confirm(window, '', message)) return;
		await Zotero.ClassicalAbbreviations.remove(list.id);
		await this.refreshAbbreviationLists();
	},
	
	
	/**
	 * Refreshes the list of styles in the styles pane
	 * @param {String} cslID Style to select
	 * @return {Promise}
	 */
	refreshStylesList: async function (cslID) {
		Zotero.debug("Refreshing styles list");
		
		await Zotero.Styles.init();
		this.styles = Zotero.Styles.getVisible()
			.map((style) => {
				var updated = Zotero.Date.sqlToDate(style.updated, true);
				return {
					title: style.title,
					updated: updated ? updated.toLocaleDateString() : "",
					remove: {
						iconKey: "minus-circle",
						onClick: async (index, event) => {
							// if the clicks happened via keyboard, refocus the next row's button
							if (event.type == "keydown" && document.activeElement == event.target) {
								this._tabIntoIcon = true;
							}
							let cslID = Zotero.Styles.getVisible()[index].styleID;
							this.deleteStyle([cslID]);
						},
						isFocusable: true,
						ariaLabel: Zotero.getString("general.remove")
					}
				};
			});
		
		if (!this._tree) {
			const columns = [
				{
					dataKey: "title",
					label: "zotero.preferences.cite.styles.styleManager.title",
				},
				{
					dataKey: "updated",
					label: "zotero.preferences.cite.styles.styleManager.updated",
					fixedWidth: true,
					width: 100
				},
				{
					dataKey: "remove",
					label: Zotero.getString("preferences-styleManager-remove"),
					htmlLabel: ' ',
					fixedWidth: true,
					width: 24,
					type: "button"
				}
			];
			var handleKeyDown = (event) => {
				if (event.key == 'Delete' || Zotero.isMac && event.key == 'Backspace') {
					Zotero_Preferences.Cite.deleteStyle();
					return false;
				}
			};

			await new Promise((resolve) => {
				ReactDOM.createRoot(document.getElementById("styleManager")).render(
					<VirtualizedTable
						getRowCount={() => this.styles.length}
						id="styleManager-table"
						ref={(ref) => {
							this._tree = ref;
							resolve();
						}}
						renderItem={makeRowRenderer(index => this.styles[index])}
						showHeader={true}
						multiSelect={false}
						columns={columns}
						staticColumns={true}
						disableFontSizeScaling={true}
						onKeyDown={handleKeyDown}
						getRowString={index => this.styles[index].title}
					/>
				);
			});

			// Fix style manager showing partially blank until scrolled
			setTimeout(() => {
				this._tree.invalidate();
				// Pre-select first item if nothing is selected
				if (this._tree.selection.selected.size == 0) {
					this._tree.selection.select(0);
				}
			});
		}
		else {
			this._tree.invalidate();
		}
		if (cslID) {
			var styles = Zotero.Styles.getVisible();
			var index = styles.findIndex(style => style.styleID == cslID);
			if (index != -1) {
				this._tree.selection.select(index);
			}
		}
		else if ([...this._tree.selection.selected].some(i => i >= this.styles.length)) {
			this._tree.selection.select(this.styles.length - 1);
		}
		if (this._tabIntoIcon) {
			document.querySelector("#styleManager-table .row.selected .icon-action").focus();
			this._tabIntoIcon = false;
		}
	},
	
	
	openStylesPage: function () {
		Zotero.openInViewer("https://www.zotero.org/styles/");
	},
	
	
	/**
	 * Adds a new style to the style pane
	 **/
	addStyle: async function () {
		var fp = new FilePicker();
		fp.init(window, Zotero.getString("zotero.preferences.styles.addStyle"), fp.modeOpen);
		
		fp.appendFilter("CSL Style", "*.csl");
		
		var rv = await fp.show();
		if (rv == fp.returnOK || rv == fp.returnReplace) {
			try {
				await Zotero.Styles.install(
					{
						file: Zotero.File.pathToFile(fp.file)
					},
					fp.file,
					true
				);
			}
			catch (e) {
				(new Zotero.Exception.Alert("styles.install.unexpectedError",
					fp.file, "styles.install.title", e)).present()
			}
		}
	},
	
	
	/**
	 * Deletes selected styles from the styles pane
	 * @param {Array} cslIDs Array of CSL IDs to delete
	 **/
	deleteStyle: async function (cslIDs = []) {
		// get selected cslIDs
		var styles = Zotero.Styles.getVisible();
		// if style ids are not provided, get them from the selection
		if (cslIDs.length == 0) {
			for (let index of this._tree.selection.selected.keys()) {
				cslIDs.push(styles[index].styleID);
			}
		}
		
		if(cslIDs.length == 0) {
			return;
		} else if(cslIDs.length == 1) {
			var selectedStyle = Zotero.Styles.get(cslIDs[0])
			var text = Zotero.getString('styles.deleteStyle', selectedStyle.title);
		} else {
			var text = Zotero.getString('styles.deleteStyles');
		}
		
		var ps = Services.prompt;
		if(ps.confirm(null, '', text)) {
			// delete if requested
			if(cslIDs.length == 1) {
				await selectedStyle.remove();
			} else {
				for(var i=0; i<cslIDs.length; i++) {
					await Zotero.Styles.get(cslIDs[i]).remove();
				}
			}
			
			await this.refreshStylesList();
		}
	},
	
	resetStyles: async function () {
		var ps = Services.prompt;
		
		var buttonFlags = (ps.BUTTON_POS_0) * (ps.BUTTON_TITLE_IS_STRING)
			+ (ps.BUTTON_POS_1) * (ps.BUTTON_TITLE_CANCEL);
		
		var index = ps.confirmEx(null,
			Zotero.getString('general.warning'),
			Zotero.getString('zotero.preferences.advanced.resetStyles.changesLost'),
			buttonFlags,
			Zotero.getString('zotero.preferences.advanced.resetStyles'),
			null, null, null, {});
		
		if (index == 0) {
			let button = document.getElementById('reset-styles-button');
			button.disabled = true;
			try {
				await Zotero.Schema.resetStyles()
				if (Zotero_Preferences.Export) {
					Zotero_Preferences.Export.populateQuickCopyList();
				}
			}
			finally {
				button.disabled = false;
			}
			this.refreshStylesList();
		}
	},
	
	/**
	 * Shows an error if import fails
	 **/
	styleImportError: function () {
		alert(Zotero.getString('styles.installError', "This"));
	}
}

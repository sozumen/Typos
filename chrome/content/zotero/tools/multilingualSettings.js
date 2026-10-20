"use strict";

/**
 * The window behind multilingualSettings.html: for each kind of value (titles, names, publishers,
 * everything else), whether citations use the original, a variant, or both, and which languages to
 * try, in order.
 */
var Zotero_MultilingualSettings = new function () {
	let rows = {};

	function make(tag, props = {}, ...children) {
		let node = document.createElement(tag);
		for (let [k, v] of Object.entries(props)) {
			if (k === 'className') node.className = v;
			else if (k === 'text') node.textContent = v;
			else node[k] = v;
		}
		node.append(...children);
		return node;
	}

	this.init = async function () {
		MozXULElement.insertFTLIfNeeded('zotero.ftl');
		await Zotero.Multilingual.waitReady();
		let settings = Zotero.Multilingual.getSettings();
		let container = document.getElementById('ml-categories');
		for (let category of Zotero.MultilingualCore.CATEGORIES) {
			let current = settings[category];
			let box = make('fieldset', { className: 'ml-box' });
			let legend = make('legend');
			document.l10n.setAttributes(legend, `multilingual-settings-category-${category}`);
			box.append(legend);

			let modeSelect = make('select', { id: `ml-mode-${category}` });
			for (let mode of Zotero.MultilingualCore.MODES) {
				// Names are shown one way or the other, never as "Name [Name]"
				if (category == 'creators' && mode == 'both') continue;
				let option = make('option', { value: mode });
				document.l10n.setAttributes(option, `multilingual-settings-mode-${mode}`);
				modeSelect.append(option);
			}
			modeSelect.value = current.mode;

			let languages = make('input', {
				type: 'text',
				id: `ml-languages-${category}`,
				value: current.languages.join(', ')
			});
			document.l10n.setAttributes(languages, 'multilingual-settings-languages-placeholder');

			let modeLabel = make('label');
			document.l10n.setAttributes(modeLabel, 'multilingual-settings-mode');
			modeLabel.append(modeSelect);
			let languagesLabel = make('label');
			document.l10n.setAttributes(languagesLabel, 'multilingual-settings-languages');
			languagesLabel.append(languages);
			box.append(modeLabel, languagesLabel);
			container.append(box);
			rows[category] = { modeSelect, languages };
		}
		document.getElementById('ml-save').addEventListener('click', () => this.save());
		document.getElementById('ml-migrate').addEventListener('click', () => this.migrate());
		document.getElementById('ml-cancel').addEventListener('click', () => window.close());
	};

	this.migrate = async function () {
		let button = document.getElementById('ml-migrate');
		let status = document.getElementById('ml-migrate-status');
		button.disabled = true;
		try {
			let result = await Zotero.Multilingual.migrateFromExtra({
				onProgress: ({ done, total }) => {
					document.l10n.setAttributes(status, 'multilingual-settings-migrate-progress', { done, total });
				}
			});
			document.l10n.setAttributes(status, 'multilingual-settings-migrate-done', {
				items: result.items, skipped: result.skipped.length
			});
		}
		catch (e) {
			Zotero.logError(e);
			status.textContent = String(e.message || e);
		}
		button.disabled = false;
	};

	this.save = async function () {
		let settings = {};
		for (let [category, { modeSelect, languages }] of Object.entries(rows)) {
			settings[category] = {
				mode: modeSelect.value,
				languages: languages.value.split(/[\s,;]+/).filter(Boolean)
			};
		}
		Zotero.Multilingual.setSettings(settings);
		document.getElementById('ml-status').textContent
			= await document.l10n.formatValue('multilingual-settings-saved');
		setTimeout(() => window.close(), 600);
	};
};

window.addEventListener('load', () => Zotero_MultilingualSettings.init(), { once: true });

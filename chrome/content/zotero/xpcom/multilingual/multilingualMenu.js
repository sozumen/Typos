"use strict";

/**
 * The "Add Variant" and "Set Field Language" sections of the Info pane's right-click menu
 *
 * The sections are added to whatever menu is opening and removed again when it closes, because
 * the menus are shared with other things (the field menu, the creator menu, the title
 * transformations).
 */
Zotero.MultilingualMenu = new function () {
	const CLASS = 'multilingual-menu-item';

	/**
	 * @param {XULElement} menupopup
	 * @param {Object} options
	 * @param {String|null} options.current - The language the field or name is in now
	 * @param {String[]} options.variantTags - Languages that already have a variant
	 * @param {Function} options.onAddVariant - (tag) => void
	 * @param {Function} options.onSetLanguage - (tag|null) => void
	 */
	this.decorate = function (menupopup, { current, variantTags, onAddVariant, onSetLanguage }) {
		this.clear(menupopup);
		let doc = menupopup.ownerDocument;
		let tags = Zotero.Multilingual.getLanguageTags();
		let have = new Set(variantTags);

		let add = (el) => {
			el.classList.add(CLASS);
			menupopup.appendChild(el);
			return el;
		};
		let separator = () => add(doc.createXULElement('menuseparator'));
		let header = (l10nID) => {
			let el = add(doc.createXULElement('menuitem'));
			el.setAttribute('disabled', 'true');
			el.classList.add('multilingual-menu-header');
			doc.l10n.setAttributes(el, l10nID);
			return el;
		};
		let other = (l10nID, callback) => {
			let el = add(doc.createXULElement('menuitem'));
			doc.l10n.setAttributes(el, l10nID);
			el.addEventListener('command', async () => {
				let tag = await this.askForTag(doc);
				if (!tag) return;
				try {
					tag = await Zotero.Multilingual.addLanguageTag(tag);
				}
				catch (e) {
					Zotero.alert(doc.defaultView, 'Typos', e.message);
					return;
				}
				callback(tag);
			});
		};

		separator();
		header('multilingual-menu-add-variant');
		for (let { tag, nickname } of tags) {
			let el = add(doc.createXULElement('menuitem'));
			el.setAttribute('label', nickname && nickname !== tag ? `${tag} (${nickname})` : tag);
			el.setAttribute('value', tag);
			if (have.has(tag) || tag === current) {
				el.setAttribute('disabled', 'true');
			}
			el.addEventListener('command', () => onAddVariant(tag));
		}
		other('multilingual-menu-other', onAddVariant);

		separator();
		header('multilingual-menu-set-language');
		let none = add(doc.createXULElement('menuitem'));
		doc.l10n.setAttributes(none, 'multilingual-menu-no-language');
		none.setAttribute('type', 'radio');
		none.setAttribute('name', 'multilingual-language');
		if (!current) none.setAttribute('checked', 'true');
		none.addEventListener('command', () => onSetLanguage(null));
		for (let { tag, nickname } of tags) {
			let el = add(doc.createXULElement('menuitem'));
			el.setAttribute('label', nickname && nickname !== tag ? `${tag} (${nickname})` : tag);
			el.setAttribute('type', 'radio');
			el.setAttribute('name', 'multilingual-language');
			if (tag === current) el.setAttribute('checked', 'true');
			el.addEventListener('command', () => onSetLanguage(tag));
		}
		other('multilingual-menu-other', onSetLanguage);

		menupopup.addEventListener('popuphidden', (event) => {
			if (event.target === menupopup) this.clear(menupopup);
		}, { once: true });
	};


	this.clear = function (menupopup) {
		for (let el of Array.from(menupopup.querySelectorAll(`.${CLASS}`))) {
			el.remove();
		}
	};


	/** @return {Promise<String|null>} - The tag typed, or null if cancelled */
	this.askForTag = async function (doc) {
		let [title, text] = await doc.l10n.formatValues([
			'multilingual-prompt-title', 'multilingual-prompt-text'
		]);
		let input = { value: '' };
		let ok = Services.prompt.prompt(doc.defaultView, title, text, input, null, {});
		return ok && input.value.trim() ? input.value.trim() : null;
	};
};

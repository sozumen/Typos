"use strict";

/**
 * Renders what a style produces, for the live preview in the visual style editor
 *
 * This follows what the built-in text editor (tools/csledit.js) does -- individual citations, a
 * combined citation, and a bibliography -- but returns HTML for a sandboxed frame instead of
 * writing into a document, and escapes error messages.
 *
 * Needs the running application (Zotero.Style, Zotero.Cite). The XML it is given is not
 * installed or saved.
 */
Zotero.StylePreview = new function () {
	// Positions the CSL processor understands; the numbers are its own
	const POSITIONS = [
		{ id: 'first', value: 0 },
		{ id: 'subsequent', value: 1 },
		{ id: 'ibid', value: 2 },
		{ id: 'ibid-with-locator', value: 3 },
		{ id: 'near-note', value: 4 }
	];
	this.POSITIONS = POSITIONS;

	function escapeHTML(str) {
		return String(str)
			.replace(/&/g, '&amp;')
			.replace(/</g, '&lt;')
			.replace(/>/g, '&gt;')
			.replace(/"/g, '&quot;');
	}
	this.escapeHTML = escapeHTML;

	function fail(message, error) {
		return {
			html: `<div class="message error">${escapeHTML(message)}${error ? `<div>${escapeHTML(error)}</div>` : ''}</div>`,
			ok: false
		};
	}

	/**
	 * @param {String} xml - CSL
	 * @param {Object} options
	 * @param {Zotero.Item[]} options.items
	 * @param {String} [options.locale='en-US']
	 * @param {String} [options.locator] - Pin cite, e.g. "45"
	 * @param {String} [options.locatorLabel='page']
	 * @param {Boolean} [options.suppressAuthor=false]
	 * @param {String} [options.position='first'] - One of POSITIONS
	 * @return {{ html: String, ok: Boolean }} - `html` is a fragment to place in the preview frame
	 */
	this.render = function (xml, options = {}) {
		let items = options.items || [];
		let locale = options.locale || 'en-US';
		let position = POSITIONS.find(p => p.id === options.position) || POSITIONS[0];

		let style;
		try {
			style = new Zotero.Style(xml);
		}
		catch (e) {
			return fail(Zotero.getString('styles.editor.warning.parseError'), e);
		}
		if (!items.length) {
			return {
				html: `<div class="message warning">${escapeHTML(Zotero.getString('styles.editor.warning.noItems'))}</div>`,
				ok: false
			};
		}

		let engine;
		try {
			engine = style.getCiteProc(style.locale || locale, 'html');
		}
		catch (e) {
			return fail(Zotero.getString('styles.editor.warning.parseError'), e);
		}

		try {
			let ids = items.map(item => item.id);
			engine.updateItems(ids);

			let cites = ids.map((id) => {
				let cite = { id, 'suppress-author': !!options.suppressAuthor };
				if (options.locator) {
					cite.locator = options.locator;
					cite.label = options.locatorLabel || 'page';
				}
				if (position.id === 'near-note') {
					// A near note is a subsequent citation with near-note set
					cite.position = 1;
					cite['near-note'] = true;
				}
				else {
					cite.position = position.value;
				}
				return cite;
			});

			let html = `<h3>${escapeHTML(Zotero.getString('styles.editor.output.individualCitations'))}</h3>`;
			for (let cite of cites) {
				html += engine.makeCitationCluster([cite]) + '<br />';
			}

			let citation = { citationItems: cites, properties: { noteIndex: 1 } };
			html += `<hr><h3>${escapeHTML(Zotero.getString('styles.editor.output.singleCitation'))}</h3>`
				+ engine.previewCitationCluster(citation, [], [], 'html');

			engine.updateItems(ids);
			html += `<hr><h3>${escapeHTML(Zotero.getString('styles.bibliography'))}</h3>`
				+ Zotero.Cite.makeFormattedBibliography(engine, 'html');
			return { html, ok: true };
		}
		catch (e) {
			Zotero.logError(e);
			return fail(Zotero.getString('styles.editor.warning.renderError'), e);
		}
		finally {
			engine.free();
		}
	};

	/**
	 * A complete, self-contained document for a sandboxed iframe's srcdoc. It carries its own
	 * styles, because a sandboxed frame cannot load the application's stylesheet.
	 */
	this.wrapDocument = function (fragment) {
		return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
			:root { color-scheme: light dark; }
			body { font: 13px/1.45 system-ui, sans-serif; margin: 0; padding: 12px 16px; }
			h3 { font-size: 11px; text-transform: uppercase; letter-spacing: .04em; opacity: .65;
				margin: 14px 0 6px; font-weight: 600; }
			h3:first-child { margin-top: 0; }
			hr { border: 0; border-top: 1px solid rgba(127,127,127,.3); margin: 14px 0 0; }
			.csl-bib-body { margin: 0; }
			.csl-entry { margin-bottom: .6em; }
			.message { padding: 8px 10px; border-radius: 6px; }
			.message.error { background: rgba(200,40,40,.14); }
			.message.warning { background: rgba(200,150,20,.16); }
			.message div { margin-top: 4px; font-family: monospace; font-size: 12px; }
		</style></head><body>${fragment}</body></html>`;
	};
}();

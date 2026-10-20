"use strict";

/**
 * The window behind cleanup.html: runs a cleanup step's scan, shows what it would change with a
 * checkbox on every item and every record it would create, applies the ticked ones, and offers to
 * undo. Also hosts the "merge duplicate works" view.
 */
var Zotero_Cleanup = new function () {
	let refs = {};
	let request = {};
	let currentStep = null;
	let scan = null;
	let lastLogPath = null;
	let mergeRows = [];

	function t(id, args) {
		return document.l10n.formatValue(id, args);
	}

	function el(id) {
		return document.getElementById('lc-' + id);
	}

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
		for (let node of document.querySelectorAll('[id^="lc-"]')) {
			refs[node.id.slice(3)] = node;
		}
		request = Zotero.Cleanup.takePending() || {};

		refs.close.addEventListener('click', () => window.close());

		if (request.mode === 'merge') {
			refs['steps-view'].hidden = true;
			refs['merge-view'].hidden = false;
			await initMerge();
			return;
		}
		await initSteps();
	};


	//
	// Steps view
	//

	async function initSteps() {
		let steps = Zotero.Cleanup.getSteps();
		currentStep = steps[0] || null;
		let list = refs['step-list'];
		for (let step of steps) {
			let radio = make('input', { type: 'radio', name: 'step', value: step.id, checked: step === currentStep });
			radio.addEventListener('change', () => selectStep(step));
			let label = make('label', { className: 'lc-check' }, radio, make('span'));
			document.l10n.setAttributes(label.querySelector('span'), step.l10nID);
			list.append(label);
		}
		await selectStep(currentStep);

		refs.scan.addEventListener('click', () => runScan());
		refs.apply.addEventListener('click', () => runApply());
		refs['undo-now'].addEventListener('click', () => undo(lastLogPath));
		bindSelectAll('suggestions', '#lc-suggestions input');
		bindSelectAll('items', '#lc-items input');
		await refreshHistory();
	}

	function bindSelectAll(name, selector) {
		let set = (value) => {
			for (let box of document.querySelectorAll(selector)) box.checked = value;
			updateApply();
		};
		refs[name + '-all'].addEventListener('click', () => set(true));
		refs[name + '-none'].addEventListener('click', () => set(false));
	}

	async function selectStep(step) {
		currentStep = step;
		if (step) {
			document.l10n.setAttributes(refs['step-description'], step.descriptionL10nID);
		}
		refs.results.hidden = true;
		refs.done.hidden = true;
	}

	function libraryID() {
		return request.libraryID || Zotero.Libraries.userLibraryID;
	}

	async function runScan() {
		refs.scan.disabled = true;
		refs.done.hidden = true;
		refs['scan-status'].textContent = await t('cleanup-scanning');
		try {
			scan = await currentStep.scan(libraryID());
			await showPreview();
			refs['scan-status'].textContent = '';
		}
		catch (e) {
			Zotero.logError(e);
			refs['scan-status'].textContent = await t('cleanup-error', { message: String(e.message || e) });
		}
		finally {
			refs.scan.disabled = false;
		}
	}


	function describeItem(plan) {
		let lines = [];
		let fieldName = f => Zotero.ItemFields.getLocalizedString(f) || f;
		let typeName = ty => Zotero.ItemTypes.getLocalizedString(ty) || ty;
		lines.push(`${typeName('classic')} → ${typeName(plan.newType)}`);
		for (let [field, value] of Object.entries(plan.set)) {
			lines.push(`${fieldName(field)}: ${value}`);
		}
		if (plan.addEditors.length) {
			lines.push(`${Zotero.CreatorTypes.getLocalizedString('editor')}: `
				+ plan.addEditors.map(e => [e.lastName, e.firstName].filter(Boolean).join(', ')).join('; '));
		}
		let moved = Object.keys(plan.workFields).map(fieldName);
		if (moved.length) {
			lines.push(`→ ${moved.join(', ')}`);
		}
		return lines;
	}

	async function showPreview() {
		refs.results.hidden = false;
		let { items, suggestions, nearMisses, titles } = scan;

		refs.summary.textContent = await t('cleanup-summary', {
			items: items.length,
			suggestions: suggestions.length
		});

		let sList = refs.suggestions;
		sList.replaceChildren();
		let kindOrder = ['work', 'volume', 'multiVolume'];
		let sorted = suggestions.slice().sort((a, b) => kindOrder.indexOf(a.kind) - kindOrder.indexOf(b.kind)
			|| a.title.localeCompare(b.title));
		for (let s of sorted) {
			let box = make('input', { type: 'checkbox', checked: true, value: s.id });
			box.addEventListener('change', updateApply);
			let text = make('span');
			document.l10n.setAttributes(text, s.existingID
				? 'cleanup-suggestion-existing'
				: 'cleanup-suggestion-' + s.kind, { title: s.title.replace(/<[^>]*>/g, ''), count: s.itemIDs.length });
			sList.append(make('li', {}, make('label', { className: 'lc-check' }, box, text)));
		}
		refs['suggestions-box'].hidden = !suggestions.length;

		let iList = refs.items;
		iList.replaceChildren();
		for (let plan of items) {
			let box = make('input', { type: 'checkbox', checked: true, value: String(plan.itemID) });
			box.addEventListener('change', updateApply);
			let detail = make('ul', { className: 'lc-detail' },
				...describeItem(plan).map(l => make('li', { text: l })),
				...plan.warnings.map(w => make('li', { className: 'lc-warning', text: w })));
			let title = make('strong', { text: titles[plan.itemID] });
			iList.append(make('li', {}, make('label', { className: 'lc-check' }, box, title), detail));
		}

		refs.nearmiss.hidden = !nearMisses.length;
		if (nearMisses.length) {
			refs.nearmiss.textContent = await t('cleanup-nearmiss', { count: nearMisses.length });
		}
		updateApply();
	}

	function checked(selector) {
		return [...document.querySelectorAll(selector)].filter(b => b.checked).map(b => b.value);
	}

	function updateApply() {
		refs.apply.disabled = !checked('#lc-items input').length;
	}

	async function runApply() {
		let itemIDs = checked('#lc-items input').map(Number);
		let suggestionIDs = checked('#lc-suggestions input');
		if (!itemIDs.length) return;
		refs.apply.disabled = true;
		refs['apply-status'].textContent = await t('cleanup-applying');
		try {
			let result = await currentStep.apply(scan, { itemIDs, suggestionIDs });
			lastLogPath = result.logPath;
			refs.results.hidden = true;
			refs.done.hidden = false;
			refs['done-text'].textContent = await t('cleanup-done', {
				converted: result.converted,
				created: result.created,
				linked: result.linked
			});
			refs.warnings.replaceChildren(...result.warnings.map(w => make('li', { text: w })));
			refs['undo-now'].hidden = !result.logPath;
			refs['undo-now'].disabled = false;
			refs['apply-status'].textContent = '';
			scan = null;
			await refreshHistory();
		}
		catch (e) {
			Zotero.logError(e);
			refs['apply-status'].textContent = await t('cleanup-error', { message: String(e.message || e) });
			refs.apply.disabled = false;
		}
	}

	async function undo(path) {
		if (!path) return;
		let ok = Services.prompt.confirm(window, await t('cleanup-undo-confirm-title'), await t('cleanup-undo-confirm'));
		if (!ok) return;
		try {
			let result = await Zotero.Cleanup.undo(path);
			refs['done-text'].textContent = await t('cleanup-undone', result);
			refs['undo-now'].disabled = true;
		}
		catch (e) {
			Zotero.logError(e);
			refs['done-text'].textContent = await t('cleanup-error', { message: String(e.message || e) });
			refs.done.hidden = false;
		}
		await refreshHistory();
	}

	async function refreshHistory() {
		let logs = await Zotero.Cleanup.listLogs();
		refs['history-box'].hidden = !logs.length;
		let list = refs.history;
		list.replaceChildren();
		for (let log of logs.slice(0, 20)) {
			let when = new Date(log.date).toLocaleString();
			let text = make('span', { text: `${when} — ${await t('cleanup-history-entry', { items: log.items, created: log.created })}` });
			let button = make('button', { type: 'button', disabled: log.undone });
			document.l10n.setAttributes(button, log.undone ? 'cleanup-history-undone' : 'cleanup-undo');
			button.addEventListener('click', () => {
				lastLogPath = log.path;
				refs.done.hidden = false;
				undo(log.path);
			});
			list.append(make('li', { className: 'lc-row' }, text, button));
		}
	}


	//
	// Merge view
	//

	async function initMerge() {
		let items = (request.items || []).filter(i => i.isRegularItem() && i.itemType === 'classic');
		if (items.length < 2) {
			refs['merge-empty'].hidden = false;
			return;
		}
		let rows = await Zotero.Cleanup.describeForMerge(items);
		refs['merge-table'].hidden = false;
		let body = refs['merge-rows'];
		mergeRows = [];
		for (let row of rows) {
			let radio = make('input', { type: 'radio', name: 'keep', value: String(row.id), checked: row.suggestedMaster });
			let lang = make('input', { type: 'text', value: row.language, size: 8, spellcheck: false });
			let name = make('td', {}, make('strong', { text: row.title }));
			if (row.creators) name.append(make('div', { className: 'lc-hint', text: row.creators }));
			radio.addEventListener('change', updateMergePreview);
			lang.addEventListener('input', updateMergePreview);
			body.append(make('tr', {}, make('td', {}, radio), name, make('td', {}, lang)));
			mergeRows.push({ row, radio, lang });
		}
		refs.merge.disabled = false;
		refs.merge.addEventListener('click', () => runMerge());
		await updateMergePreview();
	}

	function mergeSelection() {
		let keep = mergeRows.find(r => r.radio.checked) || mergeRows[0];
		let others = mergeRows.filter(r => r !== keep);
		return { keep, others };
	}

	async function updateMergePreview() {
		let { keep, others } = mergeSelection();
		let result = Zotero.CleanupWorkMerge.mergeTitles(
			{ title: keep.row.title, language: keep.lang.value, extra: '' },
			others.map(o => ({ title: o.row.title, language: o.lang.value }))
		);
		refs['merge-preview'].textContent = await t('cleanup-merge-preview', {
			keep: keep.row.title,
			titles: result.added.map(a => `${a.title} (${a.language})`).join('; ') || '—'
		});
	}

	async function runMerge() {
		let { keep, others } = mergeSelection();
		let ok = Services.prompt.confirm(window, await t('cleanup-merge-confirm-title'),
			await t('cleanup-merge-confirm', { count: others.length + 1 }));
		if (!ok) return;
		refs.merge.disabled = true;
		try {
			let master = await Zotero.Items.getAsync(Number(keep.row.id));
			let rest = await Zotero.Items.getAsync(others.map(o => Number(o.row.id)));
			let languages = Object.fromEntries(others.map(o => [Number(o.row.id), o.lang.value]));
			if (keep.lang.value && !master.getField('language')) {
				master.setField('language', keep.lang.value);
				await master.saveTx();
			}
			let result = await Zotero.Cleanup.mergeWorks(master, rest, languages);
			refs['merge-status'].textContent = await t('cleanup-merge-done', { count: result.added.length });
		}
		catch (e) {
			Zotero.logError(e);
			refs['merge-status'].textContent = await t('cleanup-error', { message: String(e.message || e) });
			refs.merge.disabled = false;
		}
	}
};

window.addEventListener('load', () => Zotero_Cleanup.init(), { once: true });

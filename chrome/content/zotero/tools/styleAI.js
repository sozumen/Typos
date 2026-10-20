"use strict";

/**
 * The window behind styleAI.html: collects the material, runs Zotero.StyleAI.generate(), shows
 * progress, and hands the result to the Visual Style Editor.
 */
var Zotero_StyleAI = new function () {
	const STEPS = ['reading', 'writing', 'checking', 'fixing', 'done'];

	let refs = {};
	let request = {};
	let manual = null; // { kind, name, base64 | text }
	let running = false;
	let cancelled = false;
	let result = null;

	function t(id, args) {
		return document.l10n.formatValue(id, args);
	}

	function el(id) {
		return document.getElementById('sai-' + id);
	}

	this.init = async function () {
		MozXULElement.insertFTLIfNeeded('zotero.ftl');
		for (let node of document.querySelectorAll('[id^="sai-"]')) {
			refs[node.id.slice(4)] = node;
		}
		request = Zotero.StyleAI.takePending() || {};

		refs.model.value = Zotero.StyleAI.getModel();
		refs.privacy.hidden = Zotero.StyleAI.hasAcknowledgedPrivacy();

		// Revising only makes sense when a style is open in the editor
		let canRevise = !!request.currentXML;
		refs['mode-section'].hidden = !canRevise;
		if (canRevise) {
			try {
				let title = Zotero.CSLTree.StyleDoc.fromXML(request.currentXML).getInfo('title');
				if (title) {
					document.l10n.setAttributes(refs['mode-revise-label'], 'styleAI-mode-revise-named', { name: title });
					refs.name.value = title;
				}
			}
			catch (e) {
				canRevise = false;
				refs['mode-section'].hidden = true;
			}
		}

		await refreshKeyStatus();
		bind();
		syncMode();
		refs.write.disabled = !(await canWrite());
	};

	function bind() {
		refs['privacy-ok'].addEventListener('click', () => {
			Zotero.StyleAI.acknowledgePrivacy();
			refs.privacy.hidden = true;
			updateWriteState();
		});
		refs['key-save'].addEventListener('click', saveKey);
		refs['key-remove'].addEventListener('click', removeKey);
		refs.key.addEventListener('keydown', (event) => {
			if (event.key === 'Enter') {
				event.preventDefault();
				saveKey();
			}
		});
		refs['manual-choose'].addEventListener('click', chooseManual);
		refs['manual-clear'].addEventListener('click', clearManual);
		for (let radio of document.querySelectorAll('input[name="sai-mode"]')) {
			radio.addEventListener('change', syncMode);
		}
		refs.form.addEventListener('submit', (event) => {
			event.preventDefault();
			write();
		});
		refs.cancel.addEventListener('click', () => {
			cancelled = true;
			refs.cancel.disabled = true;
		});
		refs.close.addEventListener('click', () => window.close());
		refs.open.addEventListener('click', openInEditor);
		window.addEventListener('keydown', (event) => {
			if (event.key === 'Escape' && !running) window.close();
		});
	}

	async function canWrite() {
		return !running && Zotero.StyleAI.hasAcknowledgedPrivacy() && await Zotero.StyleAI.hasApiKey();
	}

	async function updateWriteState() {
		refs.write.disabled = !(await canWrite());
	}

	function syncMode() {
		let revising = document.getElementById('sai-mode-revise').checked;
		refs.kind.disabled = revising;
	}

	async function refreshKeyStatus() {
		let has = await Zotero.StyleAI.hasApiKey();
		document.l10n.setAttributes(refs['key-status'], has ? 'styleAI-key-saved' : 'styleAI-key-missing');
		refs['key-remove'].hidden = !has;
		refs.key.value = '';
		await updateWriteState();
	}

	async function saveKey() {
		try {
			await Zotero.StyleAI.setApiKey(refs.key.value);
			await refreshKeyStatus();
		}
		catch (e) {
			showError(e.message);
		}
	}

	async function removeKey() {
		await Zotero.StyleAI.clearApiKey();
		await refreshKeyStatus();
	}


	//
	// Material
	//

	async function chooseManual() {
		let { FilePicker } = ChromeUtils.importESModule('chrome://zotero/content/modules/filePicker.mjs');
		let fp = new FilePicker();
		fp.init(window, await t('styleAI-manual-choose-title'), fp.modeOpen);
		fp.appendFilter('PDF, text, Markdown, HTML', '*.pdf; *.txt; *.md; *.markdown; *.html; *.htm');
		fp.appendFilters(fp.filterAll);
		if (await fp.show() !== fp.returnOK) return;
		try {
			manual = await Zotero.StyleAI.readManual(fp.file);
			refs['manual-name'].textContent = manual.name;
			refs['manual-clear'].hidden = false;
			hideError();
		}
		catch (e) {
			manual = null;
			showError(e.message);
		}
	}

	function clearManual() {
		manual = null;
		refs['manual-name'].textContent = '';
		refs['manual-clear'].hidden = true;
	}

	function gatherInputs() {
		let revising = document.getElementById('sai-mode-revise').checked;
		let pasted = refs['manual-text'].value;
		let inputs = {
			mode: revising ? 'revise' : 'new',
			title: refs.name.value.trim() || 'Untitled style',
			kind: refs.kind.value,
			bibExamples: refs.bib.value,
			citeExamples: refs.cite.value,
			extra: refs.extra.value,
			manualText: pasted
		};
		if (revising) inputs.baseXML = request.currentXML;
		if (manual) {
			if (manual.kind === 'pdf') {
				inputs.manualPDF = { name: manual.name, base64: manual.base64 };
			}
			else {
				inputs.manualText = (manual.text + (pasted.trim() ? '\n\n' + pasted : '')).trim();
			}
		}
		return inputs;
	}


	//
	// Running
	//

	function setRunning(value) {
		running = value;
		refs.write.hidden = value;
		refs.cancel.hidden = !value;
		refs.cancel.disabled = false;
		refs.form.querySelectorAll('input, textarea, select, button').forEach((node) => {
			if (node !== refs.cancel) node.disabled = value;
		});
		if (!value) {
			syncMode();
			updateWriteState();
		}
	}

	function showSteps(current, failed) {
		refs.progress.hidden = false;
		let index = STEPS.indexOf(current);
		refs.steps.replaceChildren();
		for (let [n, step] of STEPS.entries()) {
			// "fixing" is only listed once it has happened
			if (step === 'fixing' && current !== 'fixing' && !showSteps.sawFix) continue;
			let li = document.createElement('li');
			document.l10n.setAttributes(li, 'styleAI-step-' + step);
			if (n < index || (step === 'done' && current === 'done' && !failed)) li.className = 'done';
			if (n === index && step !== 'done') li.className = 'current';
			if (n === index && step === 'done') li.className = failed ? 'failed' : 'done';
			refs.steps.append(li);
		}
	}

	function hideError() {
		refs.error.hidden = true;
		refs.error.textContent = '';
	}

	function showError(message) {
		refs.error.textContent = message;
		refs.error.hidden = false;
	}

	async function write() {
		if (running) return;
		hideError();
		refs.result.hidden = true;
		result = null;
		showSteps.sawFix = false;

		let inputs;
		try {
			inputs = gatherInputs();
			let problem = Zotero.StyleGenPrompt.checkInputs(inputs);
			if (problem) throw new Error(problem);
			if (inputs.mode === 'new' && !refs.name.value.trim()) {
				refs.name.focus();
				throw new Error(await t('styleAI-error-name'));
			}
		}
		catch (e) {
			showError(e.message);
			return;
		}

		Zotero.StyleAI.setModel(refs.model.value);
		cancelled = false;
		setRunning(true);
		try {
			let generated = await Zotero.StyleAI.generate(inputs, {
				isCancelled: () => cancelled,
				onProgress: (step, info) => {
					if (step === 'fixing') showSteps.sawFix = true;
					showSteps(step, info && info.failed);
				}
			});
			result = Object.assign({ title: inputs.title, revised: inputs.mode === 'revise' }, generated);
			await showResult();
		}
		catch (e) {
			refs.progress.hidden = true;
			if (e && e.name === 'CancelledError') {
				showError(await t('styleAI-error-cancelled'));
			}
			else {
				Zotero.logError(e);
				showError(Zotero.StyleAI.describeError(e));
			}
		}
		finally {
			setRunning(false);
		}
	}

	async function showResult() {
		refs.result.hidden = false;
		let problems = result.validationErrors;
		document.l10n.setAttributes(
			refs['result-status'],
			problems.length ? 'styleAI-result-problems' : 'styleAI-result-ok',
			{ count: problems.length }
		);
		refs.problems.replaceChildren(...problems.map((p) => {
			let li = document.createElement('li');
			li.textContent = p;
			return li;
		}));
		refs['notes-heading'].hidden = refs.notes.hidden = !result.notes;
		refs.notes.textContent = result.notes || '';
		refs.open.focus();
	}

	async function openInEditor() {
		if (!result) return;
		let count = result.validationErrors.length;
		let notice = count
			? await t('styleAI-notice-problems', { count })
			: await t('styleAI-notice-ok');
		Zotero.VisualStyleEditor.open({
			xml: result.xml,
			title: result.title,
			unsaved: true,
			notice
		});
		window.close();
	}
};

window.addEventListener('load', () => Zotero_StyleAI.init(), { once: true });

"use strict";

/**
 * Ask Claude for a citation style, check it, and ask for fixes until it passes (or we give up)
 *
 * Pure: the client, the validator and the progress callback are passed in, so this runs in
 * plain Node (fork/test/styleGenerator.test.js) as well as in the application.
 *
 *   generateStyle({
 *     client,                 // { send({ system, messages }) -> { text, stopReason, usage } }
 *     inputs,                 // see styleGenPrompt.buildUserContent
 *     validate,               // async (xml) -> null | String | String[]  (schema errors)
 *     existingIds,            // ids already installed, so the new one is unique
 *     onProgress,             // (step, info) where step is reading | writing | checking | fixing | done
 *     isCancelled,            // () -> Boolean, checked between steps
 *     maxRepairs = 2
 *   }) -> { xml, notes, validationErrors, attempts, usage }
 *
 * `validationErrors` is empty when the style passed every check. If it isn't, the style is still
 * returned so the person can open it in the visual editor and fix the rest by hand.
 */
(function (root) {
	const isNode = typeof module !== 'undefined' && module.exports;
	const Prompt = isNode ? require('./styleGenPrompt.js') : root.StyleGenPrompt;

	class CancelledError extends Error {
		constructor() {
			super('Cancelled');
			this.name = 'CancelledError';
		}
	}

	function normalizeErrors(result) {
		if (!result) return [];
		let list = Array.isArray(result) ? result : String(result).split(/\r?\n/);
		return list
			.map(line => String(line).trim())
			// "file:12:3: error: message" -> "line 12: message"
			.map(line => line.replace(/^[^:\s]*:(\d+):\d+:\s*(?:error|warning):\s*/i, 'line $1: '))
			.filter(Boolean);
	}

	function addUsage(total, usage) {
		if (!usage) return total;
		return {
			input_tokens: (total.input_tokens || 0) + (usage.input_tokens || 0),
			output_tokens: (total.output_tokens || 0) + (usage.output_tokens || 0)
		};
	}

	async function generateStyle(options) {
		let {
			client, inputs, validate,
			existingIds = [], onProgress = () => {}, isCancelled = () => false,
			maxRepairs = 2, now
		} = options;

		let check = () => {
			if (isCancelled()) throw new CancelledError();
		};

		onProgress('reading');
		let content = Prompt.buildUserContent(inputs);
		let system = Prompt.system();
		let messages = [{ role: 'user', content }];

		// When revising, the style keeps its identity
		let keepId = null;
		if (inputs.mode === 'revise') {
			try {
				keepId = require_info(inputs.baseXML, 'id');
			}
			catch (e) {
				// Finalizing will make a new one
			}
		}

		let usage = {};
		let best = null;
		let lastProblems = [];
		let attempts = 0;

		for (let round = 0; round <= maxRepairs; round++) {
			check();
			onProgress(round === 0 ? 'writing' : 'fixing', { round });
			let reply = await client.send({ system, messages });
			attempts++;
			usage = addUsage(usage, reply.usage);
			check();

			onProgress('checking', { round });
			let problems = [];
			let xml = null;
			let notes = '';
			try {
				let extracted = Prompt.extractStyle(reply.text);
				notes = extracted.notes;
				xml = Prompt.finalizeStyle(extracted.xml, {
					title: inputs.title,
					id: keepId,
					existingIds,
					now
				});
			}
			catch (e) {
				if (e instanceof Prompt.NoStyleError) {
					problems.push(reply.stopReason === 'max_tokens'
						? 'The reply was cut off before the style was finished. Send the complete style again, keeping it compact.'
						: 'The reply did not contain a complete CSL style in an ```xml block.');
				}
				else {
					problems.push(`The XML cannot be read: ${e.message}`);
				}
			}

			let hard = problems;
			let soft = [];
			if (xml) {
				let semantic = Prompt.checkSemantics(xml);
				soft = semantic.filter(p => /never used/.test(p));
				hard = semantic.filter(p => !/never used/.test(p));
				// The schema validator is slower and can fail on its own; only ask it about a style that parses
				if (!hard.length) {
					try {
						hard = hard.concat(normalizeErrors(await validate(xml)));
					}
					catch (e) {
						// Validation itself failed; treat the style as unchecked rather than wrong
						soft.push(`The style could not be checked against the CSL schema: ${e.message || e}`);
					}
				}
				best = { xml, notes, problems: hard.concat(soft.filter(p => /could not be checked/.test(p))) };
			}
			else if (!best) {
				best = { xml: null, notes: '', problems: hard };
			}
			lastProblems = hard;
			check();

			if (!hard.length) {
				onProgress('done', { round });
				return { xml, notes, validationErrors: soft.filter(p => /could not be checked/.test(p)), unusedMacros: soft.filter(p => /never used/.test(p)), attempts, usage };
			}
			if (round === maxRepairs) break;

			messages.push({ role: 'assistant', content: reply.text || '(no reply)' });
			messages.push({ role: 'user', content: Prompt.buildRepairMessage(hard) });
		}

		if (!best || !best.xml) throw new Prompt.NoStyleError(lastProblems[0] || 'No style was returned');
		onProgress('done', { round: attempts - 1, failed: true });
		return { xml: best.xml, notes: best.notes, validationErrors: lastProblems, unusedMacros: [], attempts, usage };
	}

	// Read one info field from a style without depending on the tree module's load order
	function require_info(xml, field) {
		let Tree = isNode ? require('../styleEditor/cslTree.js') : root.CSLTree;
		return Tree.StyleDoc.fromXML(xml).getInfo(field) || null;
	}

	const api = { generateStyle, normalizeErrors, CancelledError };

	if (isNode) {
		module.exports = api;
	}
	else if (root) {
		root.StyleGenerator = api;
	}
})(typeof Zotero !== 'undefined' ? Zotero : null);

#!/usr/bin/env node
"use strict";

/**
 * Replace the name "Zotero" with the application's name in user-visible locale strings
 *
 * The locale files (chrome/locale/<locale>/**) come from upstream translations, so a merge brings
 * "Zotero" back. This script is idempotent: run it after every merge
 * (`npm run rebrand`; `npm run rebrand -- --check` only reports).
 *
 *   node fork/scripts/rebrand.js           Rewrite files
 *   node fork/scripts/rebrand.js --check   Report files that would change; exit 1 if any
 *   node fork/scripts/rebrand.js --list    Print each changed line (with --check)
 *
 * What is NOT changed, on purpose:
 *  - Identifiers: zotero.org, zotero://, zotero.sqlite, ZoteroPane, extensions.zotero.*, anything
 *    where "Zotero" is part of a longer word, path or address.
 *  - Names of other projects' products and services that this application still talks to:
 *    Zotero Connector, Zotero Storage, a Zotero account, Zotero's web API and servers, the
 *    Zotero Forums, the Zotero Style Repository.
 *  - License headers in source files (not touched at all: only locale files are processed).
 *
 * Non-English translations are rewritten on a best-effort basis. Where a language attaches a
 * suffix directly to the name ("Zoteron") it is left alone, since pasting a new name into an
 * inflected word would be wrong; those strings need a translator.
 */

const fs = require('fs');
const path = require('path');

const NEW_NAME = 'Typos';

// "Zotero" followed by one of these is the name of someone else's product, service or file format
const KEEP_AFTER = [
	'Connectors?',
	'Storage', 'File Storage',
	'[Aa]ccounts?',
	'Web', 'API',
	'servers?', 'Servers?', 'sync server',
	'[Ff]orums?',
	'Style Repository',
	'[Dd]ocumentation',
	'[Ww]ebsite',
	'RDF',
	'for Firefox',
	'Quick Start',
	'login',
	'group',
	'developers',
	'plugins directory',
	'Bib'
];

const KEEP_AFTER_RE = new RegExp(`^ (?:${KEEP_AFTER.join('|')})\\b`);

// Locale files that belong to the browser Connector, which keeps its own name
const SKIP_FILES = new Set(['connector.json']);

/**
 * @param {String} text
 * @return {{ text: String, count: Number }}
 */
function rebrandText(text) {
	let count = 0;
	let out = text.replace(/Zotero/g, (match, offset) => {
		let before = text[offset - 1];
		let after = text.slice(offset + match.length);
		// Part of an identifier, path, address or longer word
		if (before && /[A-Za-z0-9_./:@%$]/.test(before)) return match;
		if (/^[A-Za-z0-9_]/.test(after)) return match;
		if (/^\.[A-Za-z]/.test(after) || /^:\/\//.test(after)) return match;
		if (/^[\u2019']s?[A-Za-z]/.test(after) && !/^[\u2019']s\b/.test(after)) return match;
		if (KEEP_AFTER_RE.test(after)) return match;
		count++;
		return NEW_NAME;
	});
	return { text: out, count };
}

const EXTENSIONS = new Set(['.properties', '.dtd', '.ftl', '.json']);

function* walk(dir) {
	for (let entry of fs.readdirSync(dir, { withFileTypes: true })) {
		let full = path.join(dir, entry.name);
		if (entry.isDirectory()) yield* walk(full);
		else if (EXTENSIONS.has(path.extname(entry.name)) && !SKIP_FILES.has(entry.name)) yield full;
	}
}

function run({ root, check = false, list = false }) {
	let localeDir = path.join(root, 'chrome', 'locale');
	let changed = [];
	let total = 0;
	for (let file of walk(localeDir)) {
		let original = fs.readFileSync(file, 'utf8');
		let { text, count } = rebrandText(original);
		if (!count) continue;
		total += count;
		changed.push({ file: path.relative(root, file), count });
		if (list) {
			let a = original.split('\n');
			let b = text.split('\n');
			a.forEach((line, i) => {
				if (line !== b[i]) console.log(`${path.relative(root, file)}:${i + 1}: ${line.trim()}`);
			});
		}
		if (!check) fs.writeFileSync(file, text);
	}
	return { changed, total };
}

if (require.main === module) {
	let args = process.argv.slice(2);
	let check = args.includes('--check');
	let { changed, total } = run({
		root: path.join(__dirname, '..', '..'),
		check,
		list: args.includes('--list')
	});
	if (check) {
		if (changed.length) {
			console.log(`${total} occurrence(s) of "Zotero" in ${changed.length} locale file(s) `
				+ `would be renamed. Run: node fork/scripts/rebrand.js`);
			process.exit(1);
		}
		console.log('Locale strings are already rebranded');
	}
	else {
		console.log(`Renamed ${total} occurrence(s) in ${changed.length} file(s)`);
	}
}

module.exports = { rebrandText, run, NEW_NAME };

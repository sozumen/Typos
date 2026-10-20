#!/usr/bin/env node
/**
 * Build the fork's global schema by applying fork/schema/overlay.json on top of the upstream
 * Zotero schema (resource/schema/global/schema.json, a git submodule).
 *
 * The result is written to resource/schema/fork/schema.json, which is what the client loads.
 * Keeping our additions in an overlay means upstream schema updates can be merged by updating
 * the submodule and re-running this script.
 *
 * The output version is upstream.version + overlay.versionOffset. The offset ensures a database
 * created by this fork is never downgraded by an upstream schema, and that an upstream schema
 * bump always results in a higher number than before.
 *
 * Usage: node fork/scripts/build-schema.js [--check]
 *   --check  Exit non-zero if the generated file is out of date, without writing
 */

'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const UPSTREAM = path.join(ROOT, 'resource', 'schema', 'global', 'schema.json');
const OVERLAY = path.join(ROOT, 'fork', 'schema', 'overlay.json');
const OUTPUT = path.join(ROOT, 'resource', 'schema', 'fork', 'schema.json');

function readJSON(file) {
	return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function apply(upstream, overlay) {
	let schema = JSON.parse(JSON.stringify(upstream));

	if (!Number.isInteger(overlay.versionOffset) || overlay.versionOffset < 0) {
		throw new Error("overlay.versionOffset must be a non-negative integer");
	}
	schema.version = upstream.version + overlay.versionOffset;

	// Item types
	let existing = new Set(schema.itemTypes.map(t => t.itemType));
	for (let type of overlay.itemTypes || []) {
		if (existing.has(type.itemType)) {
			throw new Error(`Item type ${type.itemType} already exists upstream -- remove it from the overlay`);
		}
		schema.itemTypes.push(type);
		existing.add(type.itemType);
	}
	// Keep item types alphabetical like upstream so diffs stay readable
	schema.itemTypes.sort((a, b) => a.itemType.localeCompare(b.itemType, 'en'));

	// Every field and creator type used by an overlay type must be resolvable
	let knownFields = new Set();
	let knownCreators = new Set();
	for (let type of upstream.itemTypes) {
		type.fields.forEach(f => knownFields.add(f.field));
		type.creatorTypes.forEach(c => knownCreators.add(c.creatorType));
	}
	let newFields = new Set();
	for (let type of overlay.itemTypes || []) {
		for (let f of type.fields) {
			if (!knownFields.has(f.field)) newFields.add(f.field);
		}
		for (let c of type.creatorTypes) {
			if (!knownCreators.has(c.creatorType)) {
				throw new Error(`Unknown creator type ${c.creatorType} in ${type.itemType}`);
			}
		}
	}

	// CSL type mappings
	for (let [cslType, zoteroTypes] of Object.entries((overlay.csl || {}).types || {})) {
		let list = schema.csl.types[cslType];
		if (!list) {
			throw new Error(`Unknown CSL type ${cslType}`);
		}
		for (let t of zoteroTypes) {
			if (!list.includes(t)) list.push(t);
		}
	}
	// CSL text field mappings
	for (let [cslField, zoteroFields] of Object.entries(((overlay.csl || {}).fields || {}).text || {})) {
		let list = schema.csl.fields.text[cslField];
		if (!list) {
			throw new Error(`Unknown CSL text field ${cslField}`);
		}
		for (let f of zoteroFields) {
			if (!list.includes(f)) list.push(f);
		}
	}

	// Locale strings. The overlay supplies strings for some locales; every other locale falls
	// back to the en-US overlay strings so labels are never undefined.
	let fallback = (overlay.locales || {})['en-US'] || {};
	for (let [locale, strings] of Object.entries(schema.locales)) {
		let supplied = (overlay.locales || {})[locale] || {};
		for (let section of ['itemTypes', 'fields', 'creatorTypes']) {
			let merged = Object.assign({}, fallback[section], supplied[section]);
			if (!Object.keys(merged).length) continue;
			strings[section] = Object.assign({}, merged, strings[section], supplied[section]);
		}
	}

	// Sanity check: every new field has an en-US label
	for (let field of newFields) {
		if (!schema.locales['en-US'].fields[field]) {
			throw new Error(`No en-US label for new field ${field}`);
		}
	}

	return schema;
}

function main() {
	let check = process.argv.includes('--check');
	let schema = apply(readJSON(UPSTREAM), readJSON(OVERLAY));
	let output = JSON.stringify(schema);

	if (check) {
		let current = fs.existsSync(OUTPUT) ? fs.readFileSync(OUTPUT, 'utf8') : '';
		if (current !== output) {
			console.error("resource/schema/fork/schema.json is out of date -- run node fork/scripts/build-schema.js");
			process.exit(1);
		}
		console.log("Fork schema is up to date (version " + schema.version + ")");
		return;
	}

	fs.mkdirSync(path.dirname(OUTPUT), { recursive: true });
	fs.writeFileSync(OUTPUT, output);
	console.log(`Wrote ${path.relative(ROOT, OUTPUT)} (version ${schema.version}, `
		+ `${schema.itemTypes.length} item types)`);
}

if (require.main === module) {
	main();
}

module.exports = { apply };

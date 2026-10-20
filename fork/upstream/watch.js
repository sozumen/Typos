#!/usr/bin/env node
'use strict';

/**
 * Look at upstream Zotero and write a report of what Typos would have to deal with.
 *
 *   node fork/upstream/watch.js [--out DIR] [--work DIR] [--track ID]... [--no-trial] [--build]
 *                               [--head REF] [--config FILE] [--repo URL]
 *
 * Writes DIR/report.md and DIR/report.json (default ./upstream-report). Never changes the
 * repository it is run in and never merges anything. Exit code 0 means "ran fine", whatever it found;
 * when GITHUB_OUTPUT is set it also writes changed=, level=, key= for the workflow.
 */

const fs = require('fs');
const path = require('path');
const { gather } = require('./lib/run.js');
const R = require('./lib/report.js');

function parseArgs(argv) {
	let o = { out: 'upstream-report', work: path.join(process.cwd(), '.upstream-work'), only: [], trial: true, build: false, head: 'HEAD' };
	for (let i = 0; i < argv.length; i++) {
		let a = argv[i];
		if (a === '--out') o.out = argv[++i];
		else if (a === '--work') o.work = argv[++i];
		else if (a === '--track') o.only.push(argv[++i]);
		else if (a === '--no-trial') o.trial = false;
		else if (a === '--build') o.build = true;
		else if (a === '--head') o.head = argv[++i];
		else if (a === '--config') o.config = argv[++i];
		else if (a === '--repo') o.repo = argv[++i];
		else if (a === '--help' || a === '-h') o.help = true;
		else throw new Error('Unknown option: ' + a);
	}
	return o;
}

function main() {
	let o = parseArgs(process.argv.slice(2));
	if (o.help) {
		console.log(fs.readFileSync(__filename, 'utf8').split('*/')[0].replace(/^#!.*\n|^'use strict';\n|^\/\*\*\n| \* ?/gm, ''));
		return;
	}
	let report = gather({
		repoDir: process.cwd(), head: o.head, configPath: o.config, workDir: o.work,
		only: o.only, trial: o.trial, build: o.build, repoUrl: o.repo,
		log: msg => console.error(msg)
	});
	fs.mkdirSync(o.out, { recursive: true });
	fs.writeFileSync(path.join(o.out, 'report.md'), R.renderMarkdown(report));
	fs.writeFileSync(path.join(o.out, 'report.json'), JSON.stringify(R.toJSON(report), null, '\t') + '\n');

	let order = ['none', 'low', 'review', 'hold'];
	let level = report.tracks.reduce((best, t) => {
		let l = t.changed && t.verdict ? t.verdict.level : 'none';
		return order.indexOf(l) > order.indexOf(best) ? l : best;
	}, 'none');
	let changed = report.tracks.some(t => t.changed);
	let failed = report.tracks.filter(t => t.error);

	console.log('Upstream check: ' + (changed ? 'changes found (' + level + ')' : 'nothing new')
		+ (failed.length ? '; could not check: ' + failed.map(t => t.id + ' (' + t.error + ')').join(', ') : ''));
	console.log('Report: ' + path.join(o.out, 'report.md'));

	if (process.env.GITHUB_OUTPUT) {
		fs.appendFileSync(process.env.GITHUB_OUTPUT,
			'changed=' + changed + '\nlevel=' + level + '\nkey=' + R.reportKey(report) + '\nerrors=' + failed.length + '\n');
	}
	// If every track failed, the check itself is broken: say so loudly
	if (failed.length === report.tracks.length && report.tracks.length) process.exitCode = 2;
}

try {
	main();
}
catch (e) {
	console.error(e.message);
	process.exitCode = 1;
}

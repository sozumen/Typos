#!/usr/bin/env node
'use strict';

/**
 * Bring chosen upstream Zotero changes into a NEW BRANCH of this repository, for you to build and
 * look at. It never touches your current branch's history and never pushes.
 *
 *   node fork/upstream/apply.js --track ID [--mode safe|all] [--exclude PATH]... [--branch NAME]
 *                               [--advance-base] [--dry-run]
 *
 *   --mode safe   (default) only files Typos never changed, and merges git does without conflicts
 *   --mode all    also files with conflicts, written with <<<<<<< markers for you to resolve
 *   --exclude     leave a path (or folder, or glob) out; repeat as needed
 *   --branch      default upstream/<track>-<date>
 *   --advance-base  record the upstream commit as the new base in config.json. Do this when
 *                 everything has been taken or deliberately skipped; what was skipped is written to
 *                 decisions.json so it isn't forgotten.
 *   --dry-run     say what would happen and change nothing
 *
 * Not applied by this script, ever: submodule pointers (update those with git submodule), and
 * anything under the "ignored" or "forkOwned" lists in config.json.
 */

const fs = require('fs');
const path = require('path');
const E = require('./lib/engine.js');
const C = require('./lib/classify.js');
const { gather, loadConfig, readJSON } = require('./lib/run.js');

function parseArgs(argv) {
	let o = { mode: 'safe', exclude: [], work: path.join(process.cwd(), '.upstream-work') };
	for (let i = 0; i < argv.length; i++) {
		let a = argv[i];
		if (a === '--track') o.track = argv[++i];
		else if (a === '--mode') o.mode = argv[++i];
		else if (a === '--exclude') o.exclude.push(argv[++i]);
		else if (a === '--branch') o.branch = argv[++i];
		else if (a === '--advance-base') o.advance = true;
		else if (a === '--dry-run') o.dry = true;
		else if (a === '--work') o.work = argv[++i];
		else if (a === '--repo') o.repo = argv[++i];
		else if (a === '--config') o.config = argv[++i];
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
	if (!o.track) throw new Error('Say which track: --track line | release | main (see report.md)');
	if (!['safe', 'all'].includes(o.mode)) throw new Error('--mode must be safe or all');
	let repoDir = process.cwd();

	if (!o.dry) {
		let dirty = E.git(['status', '--porcelain'], { cwd: repoDir }).trim();
		if (dirty) throw new Error('The working tree has uncommitted changes. Commit or stash them first, so nothing is mixed up.\n' + dirty.split('\n').slice(0, 8).join('\n'));
	}

	let report = gather({ repoDir, configPath: o.config, workDir: o.work, only: [o.track], trial: false, repoUrl: o.repo, log: m => console.error(m) });
	let t = report.tracks[0];
	if (!t) throw new Error('No track called "' + o.track + '" in config.json');
	if (t.error) throw new Error('Could not check ' + o.track + ': ' + t.error);
	if (!t.changed) {
		console.log('Nothing to apply: ' + o.track + ' has no changes for Typos.');
		return;
	}

	let excluded = C.makeMatcher(o.exclude);
	let applied = null;
	let branch = o.branch || 'upstream/' + o.track + '-' + new Date().toISOString().slice(0, 10);

	if (o.dry) {
		console.log('Would create branch ' + branch + ' and take these (mode ' + o.mode + '):');
		for (let i of t.items) {
			let taken = (i.category === 'clean' || i.category === 'merge-clean' || (o.mode === 'all' && i.category === 'merge-conflict' && !i.binary)) && !excluded(i.path);
			if (taken) console.log('  ' + i.category.padEnd(15) + i.path);
		}
		return;
	}

	E.git(['switch', '-c', branch], { cwd: repoDir });
	applied = E.applyToTree(t, { cache: report.cache, dest: repoDir, include: i => !excluded(i.path), markers: o.mode === 'all' });

	let stillSkipped = applied.skipped;
	let cfgFile = loadConfig(repoDir, o.config).file;
	if (o.advance) {
		let config = readJSON(cfgFile);
		let decisionsFile = path.join(path.dirname(cfgFile), 'decisions.json');
		let decisions = readJSON(decisionsFile);
		decisions.skipped.push({
			track: o.track, upstream: t.target.sha, name: t.target.name || null, date: new Date().toISOString().slice(0, 10),
			mode: o.mode, files: stillSkipped
		});
		decisions.applied.push({ track: o.track, upstream: t.target.sha, date: new Date().toISOString().slice(0, 10), files: applied.written.length + applied.removed.length });
		fs.writeFileSync(decisionsFile, JSON.stringify(decisions, null, '\t') + '\n');
		let tagTrack = config.tracks.find(x => x.id === o.track && x.kind === 'latest-tag');
		if (tagTrack && t.target.name) tagTrack.minTag = t.target.name;
		config.base = { commit: t.target.sha, describe: 'Zotero ' + (t.target.name || o.track) + ' as of ' + new Date().toISOString().slice(0, 10) };
		fs.writeFileSync(cfgFile, JSON.stringify(config, null, '\t') + '\n');
	}

	E.git(['add', '-A'], { cwd: repoDir });
	let msg = 'Bring in upstream Zotero ' + (t.target.name || o.track) + ' (' + t.target.sha.slice(0, 7) + '), mode ' + o.mode + '\n\n'
		+ applied.written.length + ' files written, ' + applied.removed.length + ' removed, ' + stillSkipped.length + ' left out'
		+ (applied.conflicted.length ? ', ' + applied.conflicted.length + ' with conflict markers still to resolve' : '') + '.\n';
	// Use the person's own git identity; fall back to a neutral one (e.g., on a CI runner)
	let hasIdentity = String(E.git(['config', 'user.email'], { cwd: repoDir, allowFail: true }).stdout || '').trim() !== '';
	let identity = hasIdentity ? {} : {
		GIT_AUTHOR_NAME: 'Typos upstream apply', GIT_AUTHOR_EMAIL: 'noreply@users.noreply.github.com',
		GIT_COMMITTER_NAME: 'Typos upstream apply', GIT_COMMITTER_EMAIL: 'noreply@users.noreply.github.com'
	};
	E.git(['commit', '--quiet', '-m', msg], { cwd: repoDir, env: identity });

	console.log('Branch ' + branch + ': ' + applied.written.length + ' files written, ' + applied.removed.length + ' removed.');
	if (applied.conflicted.length) {
		console.log('\nResolve the conflict markers (<<<<<<<) in:');
		for (let p of applied.conflicted) console.log('  ' + p);
	}
	let sub = t.items.filter(i => i.category === 'submodule' || i.category === 'submodule-diverged');
	if (sub.length) {
		console.log('\nSubmodule pointers not touched (update them yourself with git submodule):');
		for (let s of sub) console.log('  ' + s.path);
	}
	let left = stillSkipped.filter(s => s.category !== 'submodule' && s.category !== 'submodule-diverged' && s.category !== 'merge-conflict');
	if (left.length) {
		console.log('\nLeft out, needing a decision:');
		for (let s of left.slice(0, 30)) console.log('  ' + s.category.padEnd(18) + s.path);
	}
	console.log('\nNext: npm run rebrand && npm run build, run the tests, try it on a COPY of your library, then merge the branch (or not).');
}

try {
	main();
}
catch (e) {
	console.error(e.message);
	process.exitCode = 1;
}

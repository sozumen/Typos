'use strict';

/**
 * The git side of the upstream watch: find what upstream has, fetch it, compare it with Typos,
 * try the merge in a scratch folder, and (for apply.js) write chosen changes into a working tree.
 *
 * Nothing here ever changes the repository it is run from, except applyToTree() when it is asked to
 * write into that tree. Upstream is fetched into a separate bare repository (the "cache").
 *
 * Tested against small local repositories in fork/test/upstreamEngine.test.js.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const C = require('./classify.js');

const MAX_BUFFER = 1024 * 1024 * 1024;

function git(args, { cwd, input, allowFail = false, encoding = 'utf8', env } = {}) {
	let r = spawnSync('git', args, {
		cwd,
		input,
		maxBuffer: MAX_BUFFER,
		encoding: encoding === 'buffer' ? null : encoding,
		env: Object.assign({}, process.env, { GIT_TERMINAL_PROMPT: '0', GIT_LFS_SKIP_SMUDGE: '1' }, env || {})
	});
	if (r.error) throw r.error;
	if (r.status !== 0 && !allowFail) {
		let err = encoding === 'buffer' ? String(r.stderr) : r.stderr;
		throw new Error('git ' + args.join(' ') + ' failed (' + r.status + '): ' + String(err).trim());
	}
	return allowFail ? r : r.stdout;
}

//
// Finding upstream's current state
//

function compareTagNames(a, b) {
	let pa = a.split('.').map(Number);
	let pb = b.split('.').map(Number);
	for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
		let d = (pa[i] || 0) - (pb[i] || 0);
		if (d) return d;
	}
	return 0;
}

/**
 * Highest plain release tag ("10.0.6"; no "-beta", no "v") from `git ls-remote --tags` output
 * @param {String} lsRemote
 * @param {String} [minTag] - Ignore tags below this one (anything older than the base)
 */
function pickLatestTag(lsRemote, minTag) {
	let tags = new Map();
	for (let line of lsRemote.split('\n')) {
		let m = /^([0-9a-f]{40})\trefs\/tags\/(\d+\.\d+(?:\.\d+)?)(\^\{\})?$/.exec(line.trim());
		if (!m) continue;
		// An annotated tag is listed twice; the line ending ^{} is the commit it points to
		if (m[3] || !tags.has(m[2])) tags.set(m[2], m[1]);
	}
	let names = [...tags.keys()].filter(n => !minTag || compareTagNames(n, minTag) >= 0).sort(compareTagNames);
	if (!names.length) return null;
	let name = names[names.length - 1];
	return { name, sha: tags.get(name) };
}

function resolveTarget(repoUrl, track) {
	if (track.kind === 'branch') {
		let out = git(['ls-remote', repoUrl, 'refs/heads/' + track.ref]);
		let m = /^([0-9a-f]{40})\t/.exec(out.trim());
		if (!m) throw new Error('Branch ' + track.ref + ' not found in ' + repoUrl);
		return { sha: m[1], name: track.ref };
	}
	if (track.kind === 'latest-tag') {
		// null: no release at or after minTag yet (the base can be newer than the newest tag)
		return pickLatestTag(git(['ls-remote', '--tags', repoUrl]), track.minTag);
	}
	throw new Error('Unknown track kind: ' + track.kind);
}

//
// The cache: a bare repository holding the upstream commits we compare against
//

function prepareCache(workDir) {
	let dir = path.join(workDir, 'cache.git');
	if (!fs.existsSync(path.join(dir, 'HEAD'))) {
		fs.mkdirSync(dir, { recursive: true });
		git(['init', '--bare', '--quiet', dir]);
	}
	return dir;
}

function hasCommit(cache, sha) {
	return git(['cat-file', '-e', sha + '^{commit}'], { cwd: cache, allowFail: true }).status === 0;
}

/** Fetch one commit (and nothing before it) */
function fetchCommit(cache, repoUrl, sha) {
	if (hasCommit(cache, sha)) return;
	git(['fetch', '--quiet', '--depth=1', '--no-tags', '--no-write-fetch-head', repoUrl, sha], { cwd: cache });
	if (!hasCommit(cache, sha)) throw new Error('Could not fetch ' + sha + ' from ' + repoUrl);
}

/** Read many blobs in one go: Map(sha -> Buffer) */
function readBlobs(gitDir, shas) {
	let unique = [...new Set(shas.filter(Boolean))];
	let result = new Map();
	if (!unique.length) return result;
	let out = git(['cat-file', '--batch'], { cwd: gitDir, input: unique.join('\n') + '\n', encoding: 'buffer' });
	let pos = 0;
	while (pos < out.length) {
		let nl = out.indexOf(0x0a, pos);
		if (nl < 0) break;
		let header = out.slice(pos, nl).toString('utf8');
		let m = /^([0-9a-f]{40}) (\w+) (\d+)$/.exec(header);
		if (!m) throw new Error('Unexpected cat-file output: ' + header);
		let size = Number(m[3]);
		result.set(m[1], out.slice(nl + 1, nl + 1 + size));
		pos = nl + 1 + size + 1;
	}
	return result;
}

//
// Comparing
//

function hasNul(buf) {
	return buf.indexOf(0) !== -1;
}

/** Three-way merge of one file: { conflicts: Number, text: Buffer, binary: Boolean } */
function mergeFile(base, ours, theirs) {
	if (hasNul(base) || hasNul(ours) || hasNul(theirs)) {
		return { conflicts: 1, text: ours, binary: true };
	}
	let dir = fs.mkdtempSync(path.join(os.tmpdir(), 'typos-merge-'));
	try {
		let files = { ours: ours, base: base, theirs: theirs };
		for (let [name, buf] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), buf);
		let r = spawnSync('git', ['merge-file', '-p', '-L', 'typos', '-L', 'zotero-base', '-L', 'zotero-new', 'ours', 'base', 'theirs'],
			{ cwd: dir, maxBuffer: MAX_BUFFER });
		if (r.error) throw r.error;
		// Exit status is the number of conflicts (capped at 127); a negative or >127 value is an error
		if (r.status === null || r.status > 127) throw new Error('git merge-file failed: ' + String(r.stderr));
		return { conflicts: r.status, text: r.stdout, binary: false };
	}
	finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
}

/**
 * Compare one upstream commit with Typos
 *
 * @param {Object} o
 * @param {String} o.repoDir - The Typos checkout (only read)
 * @param {String} o.head - The tree-ish Typos is built from (default "HEAD")
 * @param {String} o.cache - From prepareCache
 * @param {String} o.baseSha
 * @param {String} o.targetSha
 * @param {Object} o.config
 * @param {Object} o.touchpoints
 * @return {Object} { entries, items, counts, areas, mergeBlobs }
 */
function analyze({ repoDir, head = 'HEAD', cache, baseSha, targetSha, config, touchpoints }) {
	let raw = git(['diff-tree', '-r', '--no-renames', '-z', baseSha, targetSha], { cwd: cache });
	let entries = C.parseDiffRaw(raw);
	let ours = C.parseTree(git(['ls-tree', '-r', '-z', head], { cwd: repoDir }));
	let items = C.classify(entries, ours, { ignore: config.ignore, forkOwned: config.forkOwned });

	// Three-way merge for files both sides changed
	let toMerge = items.filter(i => i.category === 'merge');
	let baseBlobs = readBlobs(cache, toMerge.map(i => i.oldBlob).concat(toMerge.map(i => i.newBlob)));
	let oursBlobs = readBlobs(repoDir, toMerge.map(i => i.oursBlob));
	for (let item of toMerge) {
		let merged = mergeFile(baseBlobs.get(item.oldBlob), oursBlobs.get(item.oursBlob), baseBlobs.get(item.newBlob));
		item.conflicts = merged.conflicts;
		item.binary = merged.binary;
		item.merged = merged.text;
		item.category = merged.conflicts ? 'merge-conflict' : 'merge-clean';
	}

	let changedLines = path => {
		let r = git(['diff', '-U0', '--no-color', baseSha, targetSha, '--', path], { cwd: cache, allowFail: true });
		if (r.status !== 0) return null;
		return r.stdout.split('\n').filter(l => /^[+-][^+-]/.test(l)).join('\n');
	};
	let annotated = C.annotate(items, touchpoints, changedLines);
	return { entries, items, counts: annotated.counts, areas: annotated.areas };
}

//
// Writing changes into a tree
//

/**
 * Write upstream's changes into a folder
 *
 * @param {Object} analysis - From analyze()
 * @param {Object} o
 * @param {String} o.cache
 * @param {String} o.dest - The folder (a scratch copy or the working tree)
 * @param {Function} [o.include] - (item) -> Boolean; extra filter, e.g. to skip a path
 * @param {Boolean} [o.markers] - Also write conflicted merges, with <<<<<<< markers in them
 * @return {{ written: String[], removed: String[], conflicted: String[], skipped: Object[] }}
 */
function applyToTree(analysis, { cache, dest, include = () => true, markers = false }) {
	let written = [];
	let removed = [];
	let conflicted = [];
	let skipped = [];

	let wanted = analysis.items.filter(i => {
		if (!include(i)) {
			if (i.category !== 'ignored' && i.category !== 'fork-owned' && i.category !== 'already') {
				skipped.push({ path: i.path, category: i.category, reason: 'excluded' });
			}
			return false;
		}
		return true;
	});
	let fetchList = [];
	for (let item of wanted) {
		if (item.category === 'clean' && item.status !== 'D') fetchList.push(item.newBlob);
	}
	let blobs = readBlobs(cache, fetchList);

	for (let item of wanted) {
		let target = path.join(dest, item.path);
		if (item.category === 'clean') {
			if (item.status === 'D') {
				fs.rmSync(target, { force: true });
				removed.push(item.path);
				continue;
			}
			if (item.newMode === '120000') {
				// A symbolic link: its "content" is the link target
				fs.mkdirSync(path.dirname(target), { recursive: true });
				fs.rmSync(target, { force: true });
				fs.symlinkSync(blobs.get(item.newBlob).toString('utf8'), target);
				written.push(item.path);
				continue;
			}
			fs.mkdirSync(path.dirname(target), { recursive: true });
			fs.writeFileSync(target, blobs.get(item.newBlob));
			if (item.newMode === '100755') fs.chmodSync(target, 0o755);
			written.push(item.path);
		}
		else if (item.category === 'merge-clean') {
			fs.writeFileSync(target, item.merged);
			written.push(item.path);
		}
		else if (item.category === 'merge-conflict') {
			if (markers && !item.binary) {
				fs.writeFileSync(target, item.merged);
				written.push(item.path);
				conflicted.push(item.path);
			}
			else {
				skipped.push({ path: item.path, category: item.category, reason: 'conflicts: ' + item.conflicts });
			}
		}
		else if (item.category !== 'ignored' && item.category !== 'fork-owned' && item.category !== 'already') {
			skipped.push({ path: item.path, category: item.category, reason: item.category });
		}
	}
	return { written, removed, conflicted, skipped };
}

//
// The trial: apply the safe part to a scratch copy and see whether Typos still works
//

function tail(text, lines = 25) {
	return String(text || '').trim().split('\n').slice(-lines).join('\n');
}

function run(cmd, args, cwd, timeoutMs) {
	let r = spawnSync(cmd, args, { cwd, encoding: 'utf8', maxBuffer: MAX_BUFFER, timeout: timeoutMs, shell: process.platform === 'win32' });
	return { status: r.status, output: (r.stdout || '') + (r.stderr || ''), timedOut: !!(r.error && r.error.code === 'ETIMEDOUT') };
}

/**
 * @param {Object} analysis
 * @param {Object} o
 * @param {String} o.repoDir
 * @param {String} o.head
 * @param {String} o.cache
 * @param {String} o.workDir
 * @param {String} o.id - Names the scratch folder
 * @param {Boolean} [o.build] - Also run `npm ci && npm run build` (slow; needs network)
 */
function runTrial(analysis, { repoDir, head = 'HEAD', cache, workDir, id, build = false }) {
	let dir = path.join(workDir, 'trial-' + id);
	fs.rmSync(dir, { recursive: true, force: true });
	fs.mkdirSync(dir, { recursive: true });
	if (head === 'HEAD') {
		// Copy the checked-out folder, so submodule contents come along (git archive leaves them out)
		let skip = new Set(['.git', 'node_modules', 'build', '.upstream-work', 'upstream-report']);
		fs.cpSync(repoDir, dir, {
			recursive: true,
			filter: src => !skip.has(path.basename(src)) || path.dirname(src) !== path.resolve(repoDir)
		});
	}
	else {
		let archive = git(['archive', '--format=tar', head], { cwd: repoDir, encoding: 'buffer' });
		let untar = spawnSync('tar', ['-x', '-C', dir], { input: archive, maxBuffer: MAX_BUFFER });
		if (untar.status !== 0) throw new Error('Could not unpack the trial copy: ' + String(untar.stderr));
	}

	let applied = applyToTree(analysis, { cache, dest: dir });
	let result = {
		ran: true,
		dir,
		written: applied.written.length,
		removed: applied.removed.length,
		leftOut: applied.skipped.length,
		testsPassed: null,
		testsTail: '',
		schemaPassed: null,
		schemaTail: '',
		buildPassed: null,
		buildTail: ''
	};

	let testDir = path.join(dir, 'fork', 'test');
	if (fs.existsSync(testDir)) {
		let tests = fs.readdirSync(testDir).filter(f => f.endsWith('.test.js')).map(f => path.join('fork', 'test', f));
		let t = run(process.execPath, ['--test'].concat(tests), dir, 15 * 60 * 1000);
		result.testsPassed = t.status === 0;
		result.testsTail = tail(t.output.split('\n').filter(l => /^# (tests|pass|fail)|^not ok/.test(l)).join('\n') || t.output);
	}
	let schemaScript = path.join(dir, 'fork', 'scripts', 'build-schema.js');
	if (fs.existsSync(schemaScript) && !fs.existsSync(path.join(dir, 'resource', 'schema', 'global', 'schema.json'))) {
		result.schemaTail = 'Not run: the resource/schema/global submodule is not checked out here.';
	}
	else if (fs.existsSync(schemaScript)) {
		let s = run(process.execPath, [schemaScript, '--check'], dir, 5 * 60 * 1000);
		result.schemaPassed = s.status === 0;
		result.schemaTail = tail(s.output, 12);
	}
	if (build) {
		let install = run('npm', ['ci', '--no-audit', '--no-fund'], dir, 20 * 60 * 1000);
		if (install.status !== 0) {
			result.buildPassed = false;
			result.buildTail = 'npm ci failed:\n' + tail(install.output);
		}
		else {
			let b = run('npm', ['run', 'build'], dir, 30 * 60 * 1000);
			result.buildPassed = b.status === 0;
			result.buildTail = tail(b.output);
		}
	}
	return result;
}

module.exports = {
	git,
	pickLatestTag,
	resolveTarget,
	prepareCache,
	fetchCommit,
	readBlobs,
	mergeFile,
	analyze,
	applyToTree,
	runTrial
};

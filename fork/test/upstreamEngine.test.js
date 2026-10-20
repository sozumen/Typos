'use strict';

// End to end: a pretend upstream and a pretend fork, in temporary folders, driven through the real
// watch.js and apply.js. Needs git on the PATH.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..', '..');
const WATCH = path.join(ROOT, 'fork', 'upstream', 'watch.js');
const APPLY = path.join(ROOT, 'fork', 'upstream', 'apply.js');

function git(cwd, ...args) {
	let env = process.env;
	if (args[0] === 'commit') {
		// Commits need distinct times: "is this older than the base?" is decided by date
		let date = cwd.endsWith('upstream') && COMMITS++ > 0 ? '2020-02-01T00:00:00Z' : '2020-01-01T00:00:00Z';
		env = Object.assign({}, process.env, { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date });
	}
	let r = spawnSync('git', ['-c', 'user.name=Test', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8', env });
	if (r.status !== 0) throw new Error('git ' + args.join(' ') + ': ' + r.stderr);
	return r.stdout.trim();
}

let COMMITS = 0;

function write(dir, files) {
	for (let [name, content] of Object.entries(files)) {
		let p = path.join(dir, name);
		if (content === null) {
			fs.rmSync(p, { force: true });
			continue;
		}
		fs.mkdirSync(path.dirname(p), { recursive: true });
		fs.writeFileSync(p, content);
	}
}

const lines = (...n) => n.map(x => 'line ' + x).join('\n') + '\n';
const BIN_A = Buffer.from([0, 1, 2, 3, 4]);
const BIN_B = Buffer.from([0, 9, 9, 9, 9]);
const BIN_C = Buffer.from([0, 7, 7, 7, 7]);

function build() {
	COMMITS = 0;
	let tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'typos-upstream-'));
	let up = path.join(tmp, 'upstream');
	let fork = path.join(tmp, 'fork');
	fs.mkdirSync(up);
	git(up, 'init', '-q', '-b', 'main');

	let base = {
		'clean.js': lines(1, 2, 3),
		'both-clean.js': lines(1, 2, 3, 4, 5, 6, 7, 8, 9, 10),
		'both-conflict.js': lines(1, 2, 3),
		'deleted.js': lines(1),
		'README.md': 'upstream readme\n',
		'.github/ci.yml': 'ci: 1\n',
		'binary.dat': BIN_A,
		'untouched.js': 'x\n'
	};
	write(up, base);
	git(up, 'add', '-A');
	git(up, 'commit', '-q', '-m', 'base');
	let baseSha = git(up, 'rev-parse', 'HEAD');
	git(up, 'tag', '1.0.0');
	git(up, 'branch', 'line');

	write(up, {
		'clean.js': lines(1, 2, 3, 4),
		'both-clean.js': lines(1, 2, 3, 4, 5, 6, 7, 8, 9, 10).replace('line 9', 'line 9 UPSTREAM'),
		'both-conflict.js': lines(1, 'upstream', 3),
		'deleted.js': null,
		'README.md': 'upstream readme v2\n',
		'.github/ci.yml': 'ci: 2\n',
		'binary.dat': BIN_B,
		'added.js': 'new upstream file\n',
		'collide.js': 'upstream version\n'
	});
	git(up, 'add', '-A');
	git(up, 'commit', '-q', '-m', 'next');
	let nextSha = git(up, 'rev-parse', 'HEAD');
	git(up, 'tag', '1.0.1');

	// The fork starts as a copy of the base and changes some things
	fs.mkdirSync(fork);
	git(fork, 'init', '-q', '-b', 'main');
	write(fork, base);
	write(fork, {
		'both-clean.js': lines(1, 2, 3, 4, 5, 6, 7, 8, 9, 10).replace('line 2', 'line 2 FORK'),
		'both-conflict.js': lines(1, 'fork', 3),
		'README.md': 'the fork readme\n',
		'binary.dat': BIN_C,
		'collide.js': 'fork version\n',
		'fork-only.js': 'mine\n',
		'fork/upstream/config.json': JSON.stringify({
			repo: up,
			base: { commit: baseSha, describe: 'test base' },
			tracks: [
				{ id: 'line', label: 'Line', kind: 'branch', ref: 'line' },
				{ id: 'release', label: 'Release', kind: 'latest-tag', minTag: '1.0.0' },
				{ id: 'main', label: 'Main', kind: 'branch', ref: 'main' }
			],
			ignore: ['.github/**'],
			forkOwned: ['README.md', 'fork/**']
		}),
		'fork/upstream/touchpoints.json': JSON.stringify({ areas: [{ id: 'core', risk: 'medium', paths: ['both-clean.js'], note: 'Careful.' }] }),
		'fork/upstream/decisions.json': JSON.stringify({ applied: [], skipped: [] })
	});
	git(fork, 'add', '-A');
	git(fork, 'commit', '-q', '-m', 'fork');
	return { tmp, up, fork, baseSha, nextSha };
}

function node(cwd, script, ...args) {
	return spawnSync(process.execPath, [script, ...args], { cwd, encoding: 'utf8' });
}

test('watch: classifies a pretend upstream, tries the merge, and changes nothing', () => {
	let { tmp, fork, nextSha } = build();
	try {
		let before = git(fork, 'status', '--porcelain');
		let r = node(fork, WATCH, '--out', 'out', '--work', path.join(tmp, 'work'), '--no-trial');
		assert.equal(r.status, 0, r.stderr);
		let report = JSON.parse(fs.readFileSync(path.join(fork, 'out', 'report.json'), 'utf8'));
		let by = id => report.tracks.find(t => t.id === id);

		assert.equal(by('line').changed, false);
		assert.equal(by('release').target.name, '1.0.1');
		let main = by('main');
		assert.equal(main.target.sha, nextSha);
		assert.equal(main.changed, true);
		let cat = Object.fromEntries(main.files.map(f => [f.path, f.category]));
		assert.deepEqual(cat, {
			'clean.js': 'clean',
			'both-clean.js': 'merge-clean',
			'both-conflict.js': 'merge-conflict',
			'deleted.js': 'clean',
			'README.md': 'fork-owned',
			'.github/ci.yml': 'ignored',
			'binary.dat': 'merge-conflict',
			'added.js': 'clean',
			'collide.js': 'collision'
		});
		assert.equal(main.files.find(f => f.path === 'both-conflict.js').conflicts, 1);
		assert.equal(main.files.find(f => f.path === 'both-clean.js').risk, 'medium');
		assert.equal(main.verdict.level, 'review');
		assert.ok(fs.readFileSync(path.join(fork, 'out', 'report.md'), 'utf8').includes('Needs review'));

		// The repository itself is only touched by the report folder (untracked) and nothing else
		let after = git(fork, 'status', '--porcelain').split('\n').filter(l => !l.includes('out/'));
		assert.deepEqual(after.filter(Boolean), before ? before.split('\n') : []);
	}
	finally {
		fs.rmSync(tmp, { recursive: true, force: true });
	}
});

test('watch: nothing to report when the fork already has upstream\'s state', () => {
	let { tmp, up, fork, baseSha } = build();
	try {
		// Point the base at the newest commit, with a fork that already has those files
		let cfgPath = path.join(fork, 'fork/upstream/config.json');
		let cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
		cfg.base.commit = git(up, 'rev-parse', 'main');
		cfg.tracks[1].minTag = '1.0.1';
		fs.writeFileSync(cfgPath, JSON.stringify(cfg));
		git(fork, 'commit', '-qam', 'move base');
		let r = node(fork, WATCH, '--out', 'out', '--work', path.join(tmp, 'work'), '--no-trial');
		assert.equal(r.status, 0, r.stderr);
		let report = JSON.parse(fs.readFileSync(path.join(fork, 'out', 'report.json'), 'utf8'));
		assert.equal(report.tracks.filter(t => t.changed).length, 0);
		assert.match(r.stdout, /nothing new/);
	}
	finally {
		fs.rmSync(tmp, { recursive: true, force: true });
	}
});

test('watch: a track that cannot be reached is reported, not fatal', () => {
	let { tmp, fork } = build();
	try {
		let cfgPath = path.join(fork, 'fork/upstream/config.json');
		let cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
		cfg.tracks.push({ id: 'gone', label: 'Gone', kind: 'branch', ref: 'no-such-branch' });
		fs.writeFileSync(cfgPath, JSON.stringify(cfg));
		git(fork, 'commit', '-qam', 'add track');
		let r = node(fork, WATCH, '--out', 'out', '--work', path.join(tmp, 'work'), '--no-trial');
		assert.equal(r.status, 0, r.stderr);
		let report = JSON.parse(fs.readFileSync(path.join(fork, 'out', 'report.json'), 'utf8'));
		assert.match(report.tracks.find(t => t.id === 'gone').error, /no-such-branch/);
		assert.equal(report.tracks.find(t => t.id === 'main').changed, true);
	}
	finally {
		fs.rmSync(tmp, { recursive: true, force: true });
	}
});

test('apply --mode safe: a new branch with the safe changes only', () => {
	let { tmp, fork } = build();
	try {
		let r = node(fork, APPLY, '--track', 'main', '--work', path.join(tmp, 'work'), '--branch', 'upstream/test');
		assert.equal(r.status, 0, r.stdout + r.stderr);
		assert.equal(git(fork, 'rev-parse', '--abbrev-ref', 'HEAD'), 'upstream/test');
		let read = f => fs.existsSync(path.join(fork, f)) ? fs.readFileSync(path.join(fork, f), 'utf8') : null;
		assert.equal(read('clean.js'), lines(1, 2, 3, 4));
		assert.equal(read('added.js'), 'new upstream file\n');
		assert.equal(read('deleted.js'), null);
		assert.match(read('both-clean.js'), /line 9 UPSTREAM/);
		assert.match(read('both-clean.js'), /line 2 FORK/);
		// Conflicts, collisions, the fork's own README and upstream's CI are left alone
		assert.equal(read('both-conflict.js'), lines(1, 'fork', 3));
		assert.equal(read('collide.js'), 'fork version\n');
		assert.equal(read('README.md'), 'the fork readme\n');
		assert.equal(read('.github/ci.yml'), 'ci: 1\n'); // upstream's CI change is not taken
		assert.equal(read('fork-only.js'), 'mine\n');
		assert.equal(git(fork, 'status', '--porcelain'), '');
		// The original branch is untouched
		assert.equal(git(fork, 'show', 'main:clean.js'), lines(1, 2, 3).trim());
		assert.match(r.stdout, /Left out, needing a decision/);
	}
	finally {
		fs.rmSync(tmp, { recursive: true, force: true });
	}
});

test('apply --mode all --exclude: markers for conflicts, and excluded paths stay', () => {
	let { tmp, fork } = build();
	try {
		let r = node(fork, APPLY, '--track', 'main', '--mode', 'all', '--exclude', 'clean.js', '--work', path.join(tmp, 'work'));
		assert.equal(r.status, 0, r.stdout + r.stderr);
		let read = f => fs.readFileSync(path.join(fork, f), 'utf8');
		assert.equal(read('clean.js'), lines(1, 2, 3));
		let conflicted = read('both-conflict.js');
		assert.match(conflicted, /<<<<<<< typos/);
		assert.match(conflicted, /line fork/);
		assert.match(conflicted, /line upstream/);
		assert.match(conflicted, />>>>>>> zotero-new/);
		// A binary conflict can't carry markers, so it is left for a human
		assert.deepEqual(fs.readFileSync(path.join(fork, 'binary.dat')), BIN_C);
		assert.match(r.stdout, /both-conflict\.js/);
	}
	finally {
		fs.rmSync(tmp, { recursive: true, force: true });
	}
});

test('apply --advance-base: moves the base, remembers what was skipped, and then everything is "already"', () => {
	let { tmp, fork, nextSha } = build();
	try {
		let r = node(fork, APPLY, '--track', 'main', '--advance-base', '--work', path.join(tmp, 'work'));
		assert.equal(r.status, 0, r.stdout + r.stderr);
		let cfg = JSON.parse(fs.readFileSync(path.join(fork, 'fork/upstream/config.json'), 'utf8'));
		assert.equal(cfg.base.commit, nextSha);
		let decisions = JSON.parse(fs.readFileSync(path.join(fork, 'fork/upstream/decisions.json'), 'utf8'));
		assert.equal(decisions.skipped.length, 1);
		assert.ok(decisions.skipped[0].files.some(f => f.path === 'collide.js'));
		let w = node(fork, WATCH, '--out', 'out2', '--work', path.join(tmp, 'work'), '--no-trial', '--track', 'main');
		assert.match(w.stdout, /nothing new/);
	}
	finally {
		fs.rmSync(tmp, { recursive: true, force: true });
	}
});

test('apply: refuses to start on a dirty tree, and --dry-run changes nothing', () => {
	let { tmp, fork } = build();
	try {
		fs.writeFileSync(path.join(fork, 'fork-only.js'), 'edited\n');
		let r = node(fork, APPLY, '--track', 'main', '--work', path.join(tmp, 'work'));
		assert.notEqual(r.status, 0);
		assert.match(r.stderr, /uncommitted changes/);
		let d = node(fork, APPLY, '--track', 'main', '--dry-run', '--work', path.join(tmp, 'work'));
		assert.equal(d.status, 0, d.stderr);
		assert.match(d.stdout, /Would create branch/);
		assert.equal(git(fork, 'rev-parse', '--abbrev-ref', 'HEAD'), 'main');
	}
	finally {
		fs.rmSync(tmp, { recursive: true, force: true });
	}
});

test('watch: the trial applies the safe changes to a scratch copy and runs the fork tests there', () => {
	let { tmp, fork } = build();
	try {
		// A fork test that passes only if upstream's clean change arrived
		write(fork, {
			'fork/test/probe.test.js': "const test = require('node:test'); const assert = require('assert');\n"
				+ "test('probe', () => { assert.equal(require('fs').existsSync(require('path').join(__dirname, '..', '..', 'added.js')), true); });\n"
		});
		git(fork, 'add', '-A');
		git(fork, 'commit', '-qm', 'probe');
		let r = node(fork, WATCH, '--out', 'out', '--work', path.join(tmp, 'work'), '--track', 'main');
		assert.equal(r.status, 0, r.stderr);
		let report = JSON.parse(fs.readFileSync(path.join(fork, 'out', 'report.json'), 'utf8'));
		let trial = report.tracks[0].trial;
		assert.equal(trial.ran, true);
		assert.equal(trial.testsPassed, true, trial.testsTail);
		assert.ok(trial.written >= 3);
		// ...and the real tree never got added.js
		assert.equal(fs.existsSync(path.join(fork, 'added.js')), false);
		// The scratch copy has it
		assert.equal(fs.existsSync(path.join(tmp, 'work', 'trial-main', 'added.js')), true);
	}
	finally {
		fs.rmSync(tmp, { recursive: true, force: true });
	}
});

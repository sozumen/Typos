'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const C = require('../upstream/lib/classify.js');
const R = require('../upstream/lib/report.js');
const E = require('../upstream/lib/engine.js');

const sha = ch => ch.repeat(40);
const ZERO = '0'.repeat(40);

function raw(entries) {
	return entries.map(e => ':' + e.join(' ').replace(/\t/, '\0')).join('\0') + '\0';
}

test('parseDiffRaw reads git diff-tree -z output', () => {
	let text = ':100644 100644 ' + sha('a') + ' ' + sha('b') + ' M\0src/a.js\0'
		+ ':000000 100644 ' + ZERO + ' ' + sha('c') + ' A\0new file.txt\0'
		+ ':100644 000000 ' + sha('d') + ' ' + ZERO + ' D\0gone.txt\0'
		+ ':160000 160000 ' + sha('e') + ' ' + sha('f') + ' M\0translators\0';
	let e = C.parseDiffRaw(text);
	assert.equal(e.length, 4);
	assert.deepEqual([e[0].status, e[0].path, e[0].oldBlob, e[0].newBlob], ['M', 'src/a.js', sha('a'), sha('b')]);
	assert.deepEqual([e[1].status, e[1].path, e[1].oldBlob], ['A', 'new file.txt', null]);
	assert.deepEqual([e[2].status, e[2].newBlob], ['D', null]);
	assert.equal(e[3].oldMode, C.GITLINK);
	assert.deepEqual(C.parseDiffRaw(''), []);
});

test('parseTree reads git ls-tree -r -z output, including odd file names', () => {
	let text = '100644 blob ' + sha('a') + '\tREADME.md\0'
		+ '100755 blob ' + sha('b') + '\tapp/run it.sh\0'
		+ '160000 commit ' + sha('c') + '\ttranslators\0';
	let t = C.parseTree(text);
	assert.equal(t.size, 3);
	assert.deepEqual(t.get('app/run it.sh'), { mode: '100755', blob: sha('b') });
	assert.equal(t.get('translators').mode, C.GITLINK);
});

test('globs: ** crosses folders, * does not, plain names match folders', () => {
	let m = C.makeMatcher(['.github/**', 'docs/*.md', 'fork', '**/*.ico', 'NOTICE']);
	assert.equal(m('.github/workflows/a.yml'), true);
	assert.equal(m('docs/a.md'), true);
	assert.equal(m('docs/sub/a.md'), false);
	assert.equal(m('fork/test/x.js'), true);
	assert.equal(m('forkish/x.js'), false);
	assert.equal(m('app/win/zotero.ico'), true);
	assert.equal(m('zotero.ico'), true);
	assert.equal(m('NOTICE'), true);
	assert.equal(m('NOTICES'), false);
	assert.equal(m('a.githubx'), false);
});

function entry(status, path, oldBlob, newBlob, modes = ['100644', '100644']) {
	return { status, path, oldBlob, newBlob, oldMode: status === 'A' ? '000000' : modes[0], newMode: status === 'D' ? '000000' : modes[1] };
}
function tree(obj) {
	let m = new Map();
	for (let [p, b] of Object.entries(obj)) m.set(p, { mode: Array.isArray(b) ? b[1] : '100644', blob: Array.isArray(b) ? b[0] : b });
	return m;
}

test('classify: every case', () => {
	let entries = [
		entry('M', 'clean.js', sha('1'), sha('2')),
		entry('M', 'both.js', sha('1'), sha('2')),
		entry('M', 'already.js', sha('1'), sha('2')),
		entry('M', 'forkdeleted.js', sha('1'), sha('2')),
		entry('A', 'new.js', null, sha('3')),
		entry('A', 'collide.js', null, sha('3')),
		entry('A', 'same.js', null, sha('3')),
		entry('D', 'del-clean.js', sha('4'), null),
		entry('D', 'del-conflict.js', sha('4'), null),
		entry('D', 'del-already.js', sha('4'), null),
		entry('M', '.github/ci.yml', sha('1'), sha('2')),
		entry('M', 'README.md', sha('1'), sha('2')),
		entry('M', 'fork/x.js', sha('1'), sha('2')),
		entry('M', 'translators', sha('5'), sha('6'), [C.GITLINK, C.GITLINK]),
		entry('M', 'styles', sha('5'), sha('6'), [C.GITLINK, C.GITLINK]),
		entry('M', 'mode.sh', sha('1'), sha('1'), ['100644', '100755'])
	];
	let ours = tree({
		'clean.js': sha('1'),
		'both.js': sha('9'),
		'already.js': sha('2'),
		'collide.js': sha('8'),
		'same.js': sha('3'),
		'del-clean.js': sha('4'),
		'del-conflict.js': sha('9'),
		'README.md': sha('9'),
		'translators': [sha('5'), C.GITLINK],
		'styles': [sha('7'), C.GITLINK],
		'mode.sh': sha('1')
	});
	let items = C.classify(entries, ours, { ignore: ['.github/**'], forkOwned: ['README.md', 'fork/**'] });
	let by = Object.fromEntries(items.map(i => [i.path, i.category]));
	assert.deepEqual(by, {
		'clean.js': 'clean',
		'both.js': 'merge',
		'already.js': 'already',
		'forkdeleted.js': 'fork-deleted',
		'new.js': 'clean',
		'collide.js': 'collision',
		'same.js': 'already',
		'del-clean.js': 'clean',
		'del-conflict.js': 'deleted-conflict',
		'del-already.js': 'already',
		'.github/ci.yml': 'ignored',
		'README.md': 'fork-owned',
		'fork/x.js': 'fork-owned',
		'translators': 'submodule',
		'styles': 'submodule-diverged',
		'mode.sh': 'mode-change'
	});
});

const TOUCH = {
	areas: [
		{ id: 'schema', risk: 'high', paths: ['resource/schema/**'], note: 'n1' },
		{ id: 'gecko', risk: 'high', paths: ['app/config.sh'], contentPattern: 'GECKO_VERSION', note: 'n2' },
		{ id: 'build', risk: 'medium', paths: ['app/**'], note: 'n3' },
		{ id: 'locale', risk: 'low', paths: ['chrome/locale/**'], note: 'n4' }
	]
};

test('touchpoints: path areas, content-pattern areas, and risk ordering', () => {
	assert.deepEqual(C.touchpointsFor('resource/schema/global/schema.json', TOUCH).map(h => h.id), ['schema']);
	assert.deepEqual(C.touchpointsFor('app/build.sh', TOUCH).map(h => h.id), ['build']);
	let gecko = C.touchpointsFor('app/config.sh', TOUCH, () => '+GECKO_VERSION_WIN="141.0esr"');
	assert.deepEqual(gecko.map(h => h.id).sort(), ['build', 'gecko']);
	let notGecko = C.touchpointsFor('app/config.sh', TOUCH, () => '+SOMETHING_ELSE=1');
	assert.deepEqual(notGecko.map(h => h.id), ['build']);
	// If the diff can't be read, be cautious and count it
	assert.ok(C.touchpointsFor('app/config.sh', TOUCH, () => null).some(h => h.id === 'gecko'));
	assert.equal(C.maxRisk(gecko), 'high');
	assert.equal(C.maxRisk([]), null);
});

test('annotate: counts, areas, and that ignored / own / already files are no risk', () => {
	let items = [
		{ path: 'resource/schema/global/schema.json', category: 'clean' },
		{ path: 'app/build.sh', category: 'merge-conflict', conflicts: 2 },
		{ path: 'app/win/installer/x.nsi', category: 'already' },
		{ path: 'chrome/locale/de/a.ftl', category: 'clean' },
		{ path: 'resource/schema/other.json', category: 'fork-owned' }
	];
	let a = C.annotate(items, TOUCH, () => '');
	assert.deepEqual(a.counts, { clean: 2, 'merge-conflict': 1, already: 1, 'fork-owned': 1 });
	assert.deepEqual(a.areas.map(x => x.id), ['schema', 'build', 'locale']);
	assert.equal(a.items[2].risk, null);
	assert.equal(a.items[4].risk, null);
});

test('verdict: none, low, review, hold', () => {
	let passed = { ran: true, testsPassed: true, schemaPassed: null, buildPassed: null };
	assert.equal(C.verdict({ counts: { already: 4, ignored: 1 }, areas: [], trial: passed }).level, 'none');
	assert.equal(C.verdict({ counts: { clean: 3 }, areas: [], trial: passed }).level, 'low');
	assert.equal(C.verdict({ counts: { clean: 3 }, areas: [{ id: 'build', risk: 'medium', paths: ['x'] }], trial: passed }).level, 'review');
	assert.equal(C.verdict({ counts: { clean: 3, 'merge-conflict': 1 }, areas: [], trial: passed }).level, 'review');
	assert.equal(C.verdict({ counts: { clean: 3, submodule: 1 }, areas: [], trial: passed }).level, 'review');
	assert.equal(C.verdict({ counts: { clean: 3 }, areas: [{ id: 'schema', risk: 'high', paths: ['x'] }], trial: passed }).level, 'hold');
	assert.equal(C.verdict({ counts: { clean: 3 }, areas: [], trial: { ran: true, testsPassed: false } }).level, 'hold');
	assert.equal(C.verdict({ counts: { clean: 3 }, areas: [], trial: { ran: true, testsPassed: true, schemaPassed: false } }).level, 'hold');
	assert.equal(C.verdict({ counts: { clean: 3 }, areas: [], trial: { ran: true, testsPassed: true, buildPassed: false } }).level, 'hold');
	// Not having tried it is never "low"
	let v = C.verdict({ counts: { clean: 3 }, areas: [], trial: { ran: false } });
	assert.equal(v.level, 'review');
	assert.match(v.reasons.join(' '), /No trial/);
});

test('pickLatestTag: plain release tags only, peeled commit preferred, minTag honoured', () => {
	let ls = [
		sha('1') + '\trefs/tags/9.0.6',
		sha('2') + '\trefs/tags/10.0.6',
		sha('3') + '\trefs/tags/10.0.10',
		sha('4') + '\trefs/tags/10.1-beta.1',
		sha('5') + '\trefs/tags/v10.2.0',
		sha('6') + '\trefs/tags/10.0.9',
		sha('7') + '\trefs/tags/10.0.9^{}'
	].join('\n');
	assert.deepEqual(E.pickLatestTag(ls), { name: '10.0.10', sha: sha('3') });
	assert.deepEqual(E.pickLatestTag(ls.split('\n').slice(0, 2).join('\n') + '\n' + sha('6') + '\trefs/tags/10.0.9\n' + sha('7') + '\trefs/tags/10.0.9^{}'), { name: '10.0.9', sha: sha('7') });
	assert.equal(E.pickLatestTag(ls, '10.0.11'), null);
	assert.equal(E.pickLatestTag(''), null);
});

function sampleReport(over = {}) {
	let items = [
		{ path: 'a.js', category: 'clean', risk: null },
		{ path: 'b.js', category: 'merge-conflict', conflicts: 2, risk: 'medium' },
		{ path: 'translators', category: 'submodule', oldBlob: sha('5'), newBlob: sha('6') }
	];
	return {
		checkedAt: '2026-10-20T00:00:00Z',
		config: { base: { commit: sha('a'), describe: 'Zotero 10.0' }, repo: 'https://github.com/zotero/zotero.git' },
		tracks: [
			{
				id: 'main', label: 'Zotero main (the next major)', target: { sha: sha('b'), name: 'main' },
				changed: true, counts: { clean: 1, 'merge-conflict': 1, submodule: 1 },
				areas: [{ id: 'build', risk: 'medium', note: 'Careful.', paths: ['b.js'] }],
				items, verdict: { level: 'review', reasons: ['One thing.'] },
				trial: { ran: true, dir: '/x', written: 1, removed: 0, leftOut: 2, testsPassed: false, testsTail: 'not ok 1 - thing', schemaPassed: null, buildPassed: null, buildTail: '' },
				compareURL: R.compareURL('https://github.com/zotero/zotero.git', sha('a'), sha('b'))
			},
			{ id: 'line', label: 'Zotero 10.0 line', target: { sha: sha('a'), name: '10.0' }, changed: false, counts: {}, areas: [], items: [], verdict: { level: 'none', reasons: [] } },
			{ id: 'release', label: 'Newest tagged release', noTarget: true, changed: false, counts: {}, areas: [], items: [], verdict: { level: 'none', reasons: [] } }
		]
	};
}

test('report: markdown mentions what matters and stays under the GitHub issue size limit', () => {
	let md = R.renderMarkdown(sampleReport());
	assert.match(md, /^# Upstream Zotero: Zotero main has changes/);
	assert.match(md, /Needs review/);
	assert.match(md, /compare\/a{40}\.\.\.b{40}/);
	assert.match(md, /`b\.js` \| changed on both sides, conflict \| 2/);
	assert.match(md, /`translators`: `5555555` → `6666666`/);
	assert.match(md, /Typos' own tests: \*\*FAILED\*\*/);
	assert.match(md, /not ok 1 - thing/);
	assert.match(md, /apply\.js --track main --mode safe/);
	assert.match(md, /up to date/);
	assert.match(md, /No release at or after the base/);
	assert.ok(md.length < 60000);

	// Lots of files: lists are cut, not the whole report
	let big = sampleReport();
	big.tracks[0].items = Array.from({ length: 3000 }, (_, i) => ({ path: 'f' + i + '.js', category: 'merge-conflict', conflicts: 1 }));
	big.tracks[0].areas[0].paths = big.tracks[0].items.map(i => i.path);
	let bigMd = R.renderMarkdown(big);
	assert.ok(bigMd.length < 60000, 'length ' + bigMd.length);
	assert.match(bigMd, /and 2960 more/);
});

test('report: nothing new', () => {
	let r = sampleReport();
	r.tracks = r.tracks.slice(1);
	assert.match(R.renderMarkdown(r), /^# Upstream Zotero: nothing new/);
});

test('report: JSON has decisions, no file contents, and a key that changes only when upstream does', () => {
	let r = sampleReport();
	let j = R.toJSON(r);
	assert.equal(j.tracks[0].files.length, 3);
	assert.equal(j.tracks[0].files[1].conflicts, 2);
	assert.equal(j.tracks[0].trial.dir, undefined);
	assert.equal(R.reportKey(r), 'main:' + sha('b') + ',line:' + sha('a') + ',release:none');
	r.checkedAt = 'later';
	assert.equal(R.toJSON(r).key, j.key);
});

'use strict';

/**
 * Sorting upstream Zotero changes into "safe to take", "needs a decision" and "leave alone"
 *
 * Pure functions, no git and no file system: engine.js feeds them data, report.js prints what they
 * return. Tested in fork/test/upstreamClassify.test.js.
 *
 * Vocabulary. For one path, three versions exist:
 *   base    what upstream had when Typos was last brought up to date (config.json "base")
 *   theirs  what upstream has now
 *   ours    what Typos has
 * Upstream changed it if theirs != base. Typos changed it if ours != base.
 */

const GITLINK = '160000';
const ZERO = /^0+$/;

/** Parse `git diff-tree -r --no-renames -z <base> <target>` output */
function parseDiffRaw(text) {
	let entries = [];
	let parts = text.split('\0');
	for (let i = 0; i + 1 < parts.length; i += 2) {
		let m = /^:(\d{6}) (\d{6}) ([0-9a-f]+) ([0-9a-f]+) ([A-Z])\d*$/.exec(parts[i]);
		if (!m) continue;
		entries.push({
			oldMode: m[1],
			newMode: m[2],
			oldBlob: ZERO.test(m[3]) ? null : m[3],
			newBlob: ZERO.test(m[4]) ? null : m[4],
			status: m[5],
			path: parts[i + 1]
		});
	}
	return entries;
}

/** Parse `git ls-tree -r -z <tree>` output into Map(path -> { mode, blob }) */
function parseTree(text) {
	let map = new Map();
	for (let record of text.split('\0')) {
		let m = /^(\d{6}) (\w+) ([0-9a-f]+)\t([\s\S]+)$/.exec(record);
		if (m) map.set(m[4], { mode: m[1], blob: m[3] });
	}
	return map;
}

/** Glob to RegExp: ** crosses folders, * and ? do not. A pattern without * or ? also matches inside a folder of that name. */
function globToRegExp(glob) {
	let re = '';
	for (let i = 0; i < glob.length; i++) {
		let c = glob[i];
		if (c === '*') {
			if (glob[i + 1] === '*') {
				i++;
				if (glob[i + 1] === '/') {
					i++;
					re += '(?:.*/)?';
				}
				else {
					re += '.*';
				}
			}
			else {
				re += '[^/]*';
			}
		}
		else if (c === '?') {
			re += '[^/]';
		}
		else {
			re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
		}
	}
	let plain = !/[*?]/.test(glob);
	return new RegExp('^' + re + (plain ? '(?:/.*)?' : '') + '$');
}

function makeMatcher(globs) {
	let res = (globs || []).map(globToRegExp);
	return path => res.some(r => r.test(path));
}

/**
 * @param {Object[]} entries - From parseDiffRaw
 * @param {Map} ours - From parseTree, for the tree Typos is built from
 * @param {Object} options
 * @param {String[]} options.ignore - Upstream files Typos never takes (CI settings, ...)
 * @param {String[]} options.forkOwned - Files that are Typos' own versions of upstream files (README, ...)
 * @return {Object[]} items: { path, status, category, ... }
 *
 * categories:
 *   ignored        upstream CI/meta; not taken
 *   fork-owned     Typos' version wins; not taken
 *   already        Typos already has exactly upstream's new version
 *   clean          upstream changed it, Typos didn't: can be taken as is
 *   merge          both changed it: needs a three-way merge (engine.js tries it; becomes
 *                  merge-clean or merge-conflict)
 *   collision      upstream added a file at a path where Typos has a different file
 *   fork-deleted   upstream changed a file that Typos deleted
 *   deleted-conflict  upstream deleted a file that Typos changed
 *   submodule      a pointer to another repository moved
 *   submodule-diverged  ... and Typos' pointer isn't where upstream's old one was
 *   mode-change    only the file's mode (executable bit, symlink) changed; reported, not applied
 */
function classify(entries, ours, { ignore = [], forkOwned = [] } = {}) {
	let isIgnored = makeMatcher(ignore);
	let isForkOwned = makeMatcher(forkOwned);
	return entries.map(e => {
		let mine = ours.get(e.path) || null;
		let item = {
			path: e.path,
			status: e.status,
			oldBlob: e.oldBlob,
			newBlob: e.newBlob,
			oldMode: e.oldMode,
			newMode: e.newMode,
			oursBlob: mine ? mine.blob : null,
			oursMode: mine ? mine.mode : null
		};

		if (isIgnored(e.path)) return Object.assign(item, { category: 'ignored' });
		if (isForkOwned(e.path)) return Object.assign(item, { category: 'fork-owned' });

		if (e.oldMode === GITLINK || e.newMode === GITLINK) {
			let diverged = mine && mine.blob !== e.oldBlob && mine.blob !== e.newBlob;
			return Object.assign(item, { category: diverged ? 'submodule-diverged' : 'submodule' });
		}

		if (e.status === 'A') {
			if (!mine) return Object.assign(item, { category: 'clean' });
			if (mine.blob === e.newBlob) return Object.assign(item, { category: 'already' });
			return Object.assign(item, { category: 'collision' });
		}
		if (e.status === 'D') {
			if (!mine) return Object.assign(item, { category: 'already' });
			if (mine.blob === e.oldBlob) return Object.assign(item, { category: 'clean' });
			return Object.assign(item, { category: 'deleted-conflict' });
		}
		// Modified (or type-changed)
		if (!mine) return Object.assign(item, { category: 'fork-deleted' });
		if (e.oldBlob === e.newBlob) {
			return Object.assign(item, { category: mine.mode === e.newMode ? 'already' : 'mode-change' });
		}
		if (mine.blob === e.newBlob) return Object.assign(item, { category: 'already' });
		if (mine.blob === e.oldBlob) return Object.assign(item, { category: 'clean' });
		return Object.assign(item, { category: 'merge' });
	});
}

/**
 * Which of the touch-point areas an upstream change falls in
 * @param {String} path
 * @param {Object} touchpoints - touchpoints.json
 * @param {Function} [changedText] - (path) -> the changed lines of the diff, for areas with a
 *   contentPattern. If it returns null the pattern is treated as matching (be cautious).
 */
function touchpointsFor(path, touchpoints, changedText) {
	let hits = [];
	for (let area of touchpoints.areas || []) {
		if (!makeMatcher(area.paths)(path)) continue;
		if (area.contentPattern) {
			let text = changedText ? changedText(path) : null;
			if (text !== null && text !== undefined && !new RegExp(area.contentPattern).test(text)) continue;
		}
		hits.push({ id: area.id, risk: area.risk, note: area.note });
	}
	return hits;
}

const RISK_ORDER = { low: 1, medium: 2, high: 3 };

function maxRisk(hits) {
	let best = null;
	for (let h of hits) {
		if (!best || RISK_ORDER[h.risk] > RISK_ORDER[best]) best = h.risk;
	}
	return best;
}

/**
 * Add `touchpoints` and `risk` to each item, and summarise
 * @return {{ counts: Object, areas: Object[], items: Object[] }}
 */
function annotate(items, touchpoints, changedText) {
	let areas = new Map();
	let counts = {};
	for (let item of items) {
		counts[item.category] = (counts[item.category] || 0) + 1;
		// Things we won't take are not a risk to Typos
		if (item.category === 'ignored' || item.category === 'fork-owned' || item.category === 'already') {
			item.touchpoints = [];
			item.risk = null;
			continue;
		}
		item.touchpoints = touchpointsFor(item.path, touchpoints, changedText);
		item.risk = maxRisk(item.touchpoints);
		for (let hit of item.touchpoints) {
			if (!areas.has(hit.id)) areas.set(hit.id, { id: hit.id, risk: hit.risk, note: hit.note, paths: [] });
			areas.get(hit.id).paths.push(item.path);
		}
	}
	let areaList = [...areas.values()].sort((a, b) => RISK_ORDER[b.risk] - RISK_ORDER[a.risk] || a.id.localeCompare(b.id));
	return { counts, areas: areaList, items };
}

/**
 * One-word advice. Deliberately conservative: it says "hold" rather than "go".
 *
 * @param {Object} a
 * @param {Object} a.counts - By category (merge is replaced by merge-clean / merge-conflict after the trial)
 * @param {Object[]} a.areas
 * @param {Object|null} a.trial - { ran, testsPassed, buildPassed|null, ... } or null if no trial ran
 * @return {{ level: 'none'|'low'|'review'|'hold', reasons: String[] }}
 */
function verdict({ counts, areas, trial }) {
	let n = c => counts[c] || 0;
	let takeable = n('clean') + n('merge') + n('merge-clean') + n('merge-conflict') + n('collision')
		+ n('fork-deleted') + n('deleted-conflict') + n('submodule') + n('submodule-diverged');
	if (takeable === 0) return { level: 'none', reasons: ['Nothing to take.'] };

	let hold = [];
	let review = [];
	for (let area of areas) {
		if (area.risk === 'high') hold.push('Touches ' + area.id + ' (' + area.paths.length + ' file' + (area.paths.length === 1 ? '' : 's') + ').');
		else if (area.risk === 'medium') review.push('Touches ' + area.id + ' (' + area.paths.length + ').');
	}
	if (trial && trial.ran && trial.testsPassed === false) hold.push('Typos\' own tests fail with these changes applied.');
	if (trial && trial.ran && trial.schemaPassed === false) hold.push('The fork schema check fails with these changes applied.');
	if (trial && trial.ran && trial.buildPassed === false) hold.push('The build fails with these changes applied.');
	let conflicts = n('merge-conflict') + n('merge') + n('collision') + n('deleted-conflict') + n('fork-deleted');
	if (conflicts) review.push(conflicts + ' file' + (conflicts === 1 ? '' : 's') + ' changed on both sides and need a decision.');
	if (n('submodule-diverged')) review.push('A submodule pointer differs from both upstream\'s old and new.');
	if (n('submodule')) review.push(n('submodule') + ' submodule pointer' + (n('submodule') === 1 ? '' : 's') + ' moved.');
	if (!trial || !trial.ran) review.push('No trial was run, so nothing has been tested against these changes.');

	if (hold.length) return { level: 'hold', reasons: hold.concat(review) };
	if (review.length) return { level: 'review', reasons: review };
	return { level: 'low', reasons: ['Only changes Typos never touched, and Typos\' tests pass with them applied.'] };
}

module.exports = {
	GITLINK,
	parseDiffRaw,
	parseTree,
	globToRegExp,
	makeMatcher,
	classify,
	touchpointsFor,
	maxRisk,
	annotate,
	verdict
};

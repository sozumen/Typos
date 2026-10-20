'use strict';

/**
 * Turns an analysis into the report people read: Markdown for an issue or a PR, and JSON.
 * Pure (no git, no files). Tested in fork/test/upstreamClassify.test.js.
 */

const MAX_LISTED = 40;
const CATEGORY_TEXT = {
	clean: 'safe to take (Typos never touched these)',
	'merge-clean': 'changed on both sides, merge without conflict',
	'merge-conflict': 'changed on both sides, conflict',
	collision: 'new upstream file where Typos has a different file',
	'fork-deleted': 'changed upstream, but Typos deleted it',
	'deleted-conflict': 'deleted upstream, but Typos changed it',
	submodule: 'submodule pointer moved',
	'submodule-diverged': 'submodule pointer moved, and Typos\' differs from both',
	'mode-change': 'only the file mode changed',
	already: 'Typos already has this',
	'fork-owned': 'Typos\' own version kept (README, docs, fork/ ...)',
	ignored: 'upstream CI and meta files, not taken'
};
const ORDER = ['clean', 'merge-clean', 'merge-conflict', 'collision', 'fork-deleted', 'deleted-conflict',
	'submodule', 'submodule-diverged', 'mode-change', 'already', 'fork-owned', 'ignored'];
const LEVEL_TEXT = {
	none: 'Nothing new',
	low: 'Low risk',
	review: 'Needs review',
	hold: 'Hold: read before applying'
};

function short(sha) {
	return sha ? sha.slice(0, 7) : '';
}

function compareURL(repoUrl, base, target) {
	let m = /^https:\/\/github\.com\/([^/]+\/[^/.]+)(?:\.git)?\/?$/.exec(repoUrl || '');
	return m ? 'https://github.com/' + m[1] + '/compare/' + base + '...' + target : null;
}

function listFiles(paths, limit = MAX_LISTED) {
	let lines = paths.slice(0, limit).map(p => '- `' + p + '`');
	if (paths.length > limit) lines.push('- …and ' + (paths.length - limit) + ' more (all of them are in report.json)');
	return lines.join('\n');
}

function trackSection(t, config) {
	let out = [];
	out.push('## ' + t.label);
	out.push('');
	if (t.error) {
		out.push('Could not be checked: ' + t.error);
		out.push('');
		return out.join('\n');
	}
	if (t.noTarget) {
		out.push('**No change.** No release at or after the base has been tagged yet.');
		out.push('');
		return out.join('\n');
	}
	out.push('Upstream is at `' + short(t.target.sha) + '`' + (t.target.name ? ' (' + t.target.name + ')' : '')
		+ '. Typos is built from `' + short(config.base.commit) + '`.'
		+ (t.changed && t.compareURL ? ' [See every change on GitHub](' + t.compareURL + ').' : ''));
	out.push('');
	if (t.behind) {
		out.push('**No changes.** Typos is built from something newer than this.');
		out.push('');
		return out.join('\n');
	}
	if (!t.changed) {
		out.push('**No changes.** Typos is up to date with this line.');
		out.push('');
		return out.join('\n');
	}

	out.push('**' + LEVEL_TEXT[t.verdict.level] + '.**');
	out.push('');
	for (let r of t.verdict.reasons) out.push('- ' + r);
	out.push('');

	out.push('| What | Files |');
	out.push('|---|---:|');
	for (let c of ORDER) {
		if (t.counts[c]) out.push('| ' + CATEGORY_TEXT[c] + ' | ' + t.counts[c] + ' |');
	}
	out.push('');

	if (t.areas.length) {
		out.push('### Areas that need care');
		out.push('');
		for (let a of t.areas) {
			out.push('**' + a.id + '** (' + a.risk + ' risk, ' + a.paths.length + ' file' + (a.paths.length === 1 ? '' : 's') + ')');
			out.push('');
			out.push(a.note);
			out.push('');
			out.push(listFiles(a.paths, 8));
			out.push('');
		}
	}

	let needsDecision = t.items.filter(i => ['merge-conflict', 'collision', 'fork-deleted', 'deleted-conflict', 'submodule-diverged'].includes(i.category));
	if (needsDecision.length) {
		out.push('### Needs a decision');
		out.push('');
		out.push('| File | Why | Conflicts |');
		out.push('|---|---|---:|');
		for (let i of needsDecision.slice(0, MAX_LISTED)) {
			out.push('| `' + i.path + '` | ' + CATEGORY_TEXT[i.category] + (i.binary ? ' (binary)' : '') + ' | ' + (i.conflicts || '') + ' |');
		}
		if (needsDecision.length > MAX_LISTED) out.push('| …and ' + (needsDecision.length - MAX_LISTED) + ' more | | |');
		out.push('');
	}

	let subs = t.items.filter(i => i.category === 'submodule' || i.category === 'submodule-diverged');
	if (subs.length) {
		out.push('### Submodules');
		out.push('');
		for (let s of subs) out.push('- `' + s.path + '`: `' + short(s.oldBlob) + '` → `' + short(s.newBlob) + '`');
		out.push('');
	}

	if (t.trial && t.trial.ran) {
		let tr = t.trial;
		let yn = v => v === null ? 'not run' : v ? 'passed' : '**FAILED**';
		out.push('### Trial on a scratch copy');
		out.push('');
		out.push('The safe changes (' + tr.written + ' files written, ' + tr.removed + ' removed; ' + tr.leftOut + ' left out) were applied to a throw-away copy. Your repository was not touched.');
		out.push('');
		out.push('- Typos\' own tests: ' + yn(tr.testsPassed));
		out.push('- Fork schema check: ' + yn(tr.schemaPassed));
		out.push('- Full build: ' + yn(tr.buildPassed));
		for (let [label, text, ok] of [['Test output', tr.testsTail, tr.testsPassed], ['Schema check output', tr.schemaTail, tr.schemaPassed], ['Build output', tr.buildTail, tr.buildPassed]]) {
			if (text && ok !== true) {
				out.push('');
				out.push('<details><summary>' + label + '</summary>');
				out.push('');
				out.push('```');
				out.push(text.replace(/```/g, "'''"));
				out.push('```');
				out.push('</details>');
			}
		}
		out.push('');
	}

	out.push('### What you can do');
	out.push('');
	out.push('Nothing has been merged, and nothing will be unless you ask. In a session with Claude, or from a checkout:');
	out.push('');
	out.push('```');
	out.push('node fork/upstream/apply.js --track ' + t.id + ' --mode safe        # only the changes Typos never touched');
	out.push('node fork/upstream/apply.js --track ' + t.id + ' --mode all         # plus conflicted files, with markers to resolve by hand');
	out.push('node fork/upstream/apply.js --track ' + t.id + ' --mode safe --exclude <path>   # leave something out');
	out.push('```');
	out.push('');
	out.push('Each makes a new branch (`upstream/...`) for you to build and look at. Skip this one and the report simply appears again when upstream moves.');
	out.push('');
	return out.join('\n');
}

/**
 * @param {Object} report - { checkedAt, config, tracks: [...] }
 * @return {String} Markdown
 */
function renderMarkdown(report) {
	let out = [];
	let actionable = report.tracks.filter(t => t.changed && t.verdict && t.verdict.level !== 'none');
	out.push('# Upstream Zotero: ' + (actionable.length
		? actionable.map(t => t.label.split(' (')[0] + ' has changes').join('; ')
		: 'nothing new'));
	out.push('');
	out.push('Checked ' + report.checkedAt + '. Typos is built from Zotero commit `' + short(report.config.base.commit)
		+ '` (' + report.config.base.describe + ').');
	out.push('');
	out.push('| Track | Upstream | Files changed | Advice |');
	out.push('|---|---|---:|---|');
	for (let t of report.tracks) {
		if (t.error) {
			out.push('| ' + t.label.split(' (')[0] + ' | | | could not check |');
			continue;
		}
		if (t.noTarget) {
			out.push('| ' + t.label.split(' (')[0] + ' | no newer tag | 0 | up to date |');
			continue;
		}
		if (t.behind) {
			out.push('| ' + t.label.split(' (')[0] + ' | `' + short(t.target.sha) + '`' + (t.target.name ? ' ' + t.target.name : '') + ' | 0 | older than Typos\' base |');
			continue;
		}
		let total = t.changed ? Object.entries(t.counts).filter(([c]) => !['ignored', 'fork-owned', 'already'].includes(c)).reduce((n, [, v]) => n + v, 0) : 0;
		out.push('| ' + t.label.split(' (')[0] + ' | `' + short(t.target.sha) + '`' + (t.target.name && t.target.name !== t.id ? ' ' + t.target.name : '') + ' | ' + total + ' | ' + (t.changed ? LEVEL_TEXT[t.verdict.level] : 'up to date') + ' |');
	}
	out.push('');
	for (let t of report.tracks) out.push(trackSection(t, report.config));
	out.push('---');
	out.push('Made by `fork/upstream/watch.js`. See `docs/UPSTREAM.md`.');
	out.push('');
	return out.join('\n');
}

/** Small, stable text that changes only when upstream does. For "have I reported this already?" */
function reportKey(report) {
	return report.tracks.map(t => t.id + ':' + (t.target ? t.target.sha : t.noTarget ? 'none' : 'error')).join(',');
}

/** The JSON form: no file contents, just decisions */
function toJSON(report) {
	return {
		checkedAt: report.checkedAt,
		base: report.config.base,
		key: reportKey(report),
		tracks: report.tracks.map(t => ({
			id: t.id,
			label: t.label,
			error: t.error || null,
			target: t.target || null,
			changed: !!t.changed,
			verdict: t.verdict || null,
			counts: t.counts || {},
			areas: t.areas || [],
			trial: t.trial ? Object.assign({}, t.trial, { dir: undefined }) : null,
			files: (t.items || []).map(i => ({
				path: i.path, status: i.status, category: i.category, risk: i.risk || null,
				conflicts: i.conflicts || 0
			}))
		}))
	};
}

module.exports = { renderMarkdown, reportKey, toJSON, compareURL, LEVEL_TEXT };

'use strict';

/** Shared by watch.js and apply.js: read the config, look at upstream, analyze each track */

const fs = require('fs');
const path = require('path');
const E = require('./engine.js');
const C = require('./classify.js');
const R = require('./report.js');

function readJSON(file) {
	return JSON.parse(fs.readFileSync(file, 'utf8'));
}

/**
 * Is `sha` older than the base? Without the history we can't ask git whether one is an ancestor of
 * the other, so this compares commit dates: good enough for lines that only move forward.
 */
function isBehind(cache, baseSha, url, sha) {
	E.fetchCommit(cache, url, sha);
	let time = id => Number(E.git(['show', '-s', '--format=%ct', id], { cwd: cache }).trim());
	return time(sha) < time(baseSha);
}

function loadConfig(repoDir, configPath) {
	let file = configPath || path.join(repoDir, 'fork', 'upstream', 'config.json');
	let config = readJSON(file);
	let touchpoints = readJSON(path.join(path.dirname(file), 'touchpoints.json'));
	if (!/^[0-9a-f]{40}$/.test(config.base && config.base.commit)) {
		throw new Error('config.json: base.commit must be a full 40-character commit id');
	}
	return { config, touchpoints, file };
}

/**
 * @param {Object} o
 * @param {String} o.repoDir
 * @param {String} [o.head]
 * @param {String} [o.configPath]
 * @param {String} o.workDir
 * @param {String[]} [o.only] - Track ids to look at
 * @param {Boolean} [o.trial]
 * @param {Boolean} [o.build]
 * @param {String} [o.repoUrl] - Override config.repo (tests use a local path)
 * @param {Function} [o.log]
 * @return {Object} report: { checkedAt, config, tracks }
 */
function gather({ repoDir, head = 'HEAD', configPath, workDir, only, trial = true, build = false, repoUrl, log = () => {} }) {
	let { config, touchpoints } = loadConfig(repoDir, configPath);
	let url = repoUrl || config.repo;
	fs.mkdirSync(workDir, { recursive: true });
	let cache = E.prepareCache(workDir);

	log('Fetching the base commit ' + config.base.commit.slice(0, 7));
	E.fetchCommit(cache, url, config.base.commit);

	let tracks = [];
	for (let track of config.tracks) {
		if (only && only.length && !only.includes(track.id)) continue;
		let t = { id: track.id, label: track.label };
		try {
			t.target = E.resolveTarget(url, track);
			if (!t.target) {
				t.noTarget = true;
				t.changed = false;
				t.counts = {};
				t.areas = [];
				t.items = [];
				t.verdict = { level: 'none', reasons: ['No release newer than the base yet.'] };
				log(track.id + ': no release at or after ' + (track.minTag || 'any') + ' yet');
				tracks.push(t);
				continue;
			}
			log(track.id + ': upstream is at ' + t.target.sha.slice(0, 7) + (t.target.name ? ' (' + t.target.name + ')' : ''));
			t.compareURL = R.compareURL(config.repo, config.base.commit, t.target.sha);
			if (t.target.sha === config.base.commit) {
				t.changed = false;
				t.counts = {};
				t.areas = [];
				t.items = [];
				t.verdict = { level: 'none', reasons: ['Nothing to take.'] };
			}
			else if (isBehind(cache, config.base.commit, url, t.target.sha)) {
				// e.g. the newest tag is older than the snapshot Typos was built from
				t.changed = false;
				t.behind = true;
				t.counts = {};
				t.areas = [];
				t.items = [];
				t.verdict = { level: 'none', reasons: ['Typos is built from something newer than this.'] };
			}
			else {
				let analysis = E.analyze({ repoDir, head, cache, baseSha: config.base.commit, targetSha: t.target.sha, config, touchpoints });
				Object.assign(t, analysis);
				// A file can be touched by upstream and yet be nothing for Typos to do (all "already", "ignored", ...)
				t.changed = analysis.items.some(i => !['ignored', 'fork-owned', 'already'].includes(i.category));
				t.trial = null;
				if (t.changed && trial) {
					log(track.id + ': trying the safe changes on a scratch copy');
					t.trial = E.runTrial(analysis, { repoDir, head, cache, workDir, id: track.id, build });
				}
				t.verdict = C.verdict({ counts: t.counts, areas: t.areas, trial: t.trial || { ran: false } });
				if (!t.changed) t.verdict = { level: 'none', reasons: ['Nothing to take.'] };
			}
		}
		catch (e) {
			t.error = e.message;
			t.changed = false;
		}
		tracks.push(t);
	}
	return { checkedAt: new Date().toISOString().replace(/\.\d+Z$/, 'Z'), config, tracks, cache, touchpoints };
}

module.exports = { loadConfig, gather, readJSON };

"use strict";

const test = require('node:test');
const assert = require('node:assert/strict');
const P = require('../../chrome/content/zotero/xpcom/abbreviationProfiles.js');

const defaultProfile = {
	id: 'default', name: 'Default', mode: 'abbreviated', active: ['a'],
	types: ['work', 'author', 'journal', 'series'], scope: 'classic', preferItemAbbreviations: true
};
const sbl = P.normalizeProfile({ id: 'sbl', name: 'SBL', mode: 'abbreviated', active: ['a', 'b'], types: ['journal'] });
const full = P.normalizeProfile({ id: 'full', name: 'Full', mode: 'short-title', active: [] });
const profiles = [sbl, full];

test('normalizeProfile fills defaults and cleans fields', () => {
	let p = P.normalizeProfile({
		id: 'x', name: ' Mine ', mode: 'nonsense', active: ['a', 'a', '', 5, 'b'],
		types: ['journal', 'journal', 'bogus', 'place'], scope: 'weird'
	});
	assert.deepEqual(p, {
		id: 'x', name: 'Mine', mode: 'abbreviated', active: ['a', 'b'],
		types: ['journal', 'place'], scope: 'classic', preferItemAbbreviations: true
	});
	assert.deepEqual(P.normalizeProfile({ id: 'y', name: 'n' }).types, ['work', 'author', 'journal', 'series']);
	assert.equal(P.normalizeProfile({ id: 'y', name: 'n', preferItemAbbreviations: false }).preferItemAbbreviations, false);
});

test('normalizeProfile rejects missing names and reserved IDs', () => {
	assert.throws(() => P.normalizeProfile({ id: 'x', name: '  ' }), /needs a name/);
	assert.throws(() => P.normalizeProfile({ id: 'default', name: 'x' }), /not a valid profile ID/);
	assert.throws(() => P.normalizeProfile({ id: 'off', name: 'x' }), /not a valid profile ID/);
	assert.throws(() => P.normalizeProfile({ id: '', name: 'x' }), /not a valid profile ID/);
	assert.throws(() => P.normalizeProfile(null), /must be an object/);
});

test('uniqueProfileID avoids reserved and existing IDs', () => {
	assert.equal(P.uniqueProfileID('My Profile', []), 'my-profile');
	assert.equal(P.uniqueProfileID('My Profile', ['my-profile']), 'my-profile-2');
	assert.equal(P.uniqueProfileID('Default', []), 'default-2');
	assert.equal(P.uniqueProfileID('Off', []), 'off-2');
	assert.equal(P.uniqueProfileID('!!!', []), 'profile');
	assert.equal(P.uniqueProfileID('Études', []), 'etudes');
});

test('profiles round-trip through serialization', () => {
	let { profiles: back, warnings } = P.parseProfiles(P.serializeProfiles(profiles));
	assert.deepEqual(back, profiles);
	assert.deepEqual(warnings, []);
});

test('parseProfiles never throws and skips bad entries', () => {
	assert.deepEqual(P.parseProfiles('').profiles, []);
	assert.match(P.parseProfiles('{bad').warnings[0], /not valid JSON/);
	assert.match(P.parseProfiles('{}').warnings[0], /not a list/);
	let { profiles: ps, warnings } = P.parseProfiles(JSON.stringify([
		{ id: 'ok', name: 'OK' },
		{ id: 'ok', name: 'Dup' },
		{ id: 'default', name: 'Reserved' },
		{ id: 'noname' },
		'junk'
	]));
	assert.deepEqual(ps.map(p => p.id), ['ok']);
	assert.equal(warnings.length, 4);
});

test('parseAssignments keeps only string-to-string pairs', () => {
	assert.deepEqual(P.parseAssignments(JSON.stringify({ s1: 'sbl', s2: '', s3: 5, s4: null })), { s1: 'sbl' });
	assert.deepEqual(P.parseAssignments('nope'), {});
	assert.deepEqual(P.parseAssignments('[]'), {});
	assert.deepEqual(P.parseAssignments(''), {});
});

test('removeProfileFromAssignments drops only that profile', () => {
	assert.deepEqual(
		P.removeProfileFromAssignments({ a: 'sbl', b: 'full', c: 'sbl' }, 'sbl'),
		{ b: 'full' }
	);
});

const resolve = (o) => P.resolveProfile({ profiles, defaultProfile, assignments: { 'style-1': 'sbl', 'style-2': 'off' }, ...o });

test('resolution order: document, then style, then default', () => {
	assert.deepEqual(
		[resolve({ documentProfileID: 'full', styleID: 'style-1' }).source, resolve({ documentProfileID: 'full', styleID: 'style-1' }).profile.id],
		['document', 'full']
	);
	assert.deepEqual(
		[resolve({ styleID: 'style-1' }).source, resolve({ styleID: 'style-1' }).profile.id],
		['style', 'sbl']
	);
	assert.deepEqual(
		[resolve({ styleID: 'other' }).source, resolve({ styleID: 'other' }).profile.id],
		['default', 'default']
	);
	assert.equal(resolve({}).profile, defaultProfile);
});

test('"" for a document means no choice; "default" and "off" are real choices', () => {
	assert.equal(resolve({ documentProfileID: '', styleID: 'style-1' }).profile.id, 'sbl');
	// A document can ask for the global default even though the style is assigned something else
	let d = resolve({ documentProfileID: 'default', styleID: 'style-1' });
	assert.equal(d.profile, defaultProfile);
	assert.equal(d.source, 'document');
	// A document can turn abbreviations off, whatever the style says
	let off = resolve({ documentProfileID: 'off', styleID: 'style-1' });
	assert.equal(off.profile.mode, 'off');
	assert.equal(off.source, 'document');
});

test('a style can be assigned "off"', () => {
	let r = resolve({ styleID: 'style-2' });
	assert.equal(r.profile.mode, 'off');
	assert.equal(r.source, 'style');
});

test('unknown profile IDs are skipped, not errors', () => {
	// Document names a profile from another computer: fall through to the style
	assert.equal(resolve({ documentProfileID: 'gone', styleID: 'style-1' }).profile.id, 'sbl');
	assert.equal(resolve({ documentProfileID: 'gone', styleID: 'other' }).source, 'default');
	// Style assigned to a deleted profile: fall through to default
	let r = P.resolveProfile({ profiles: [], defaultProfile, assignments: { s: 'deleted' }, styleID: 's' });
	assert.equal(r.source, 'default');
});

test('profileSignature changes with anything that affects output', () => {
	let base = P.profileSignature(sbl, { a: 1, b: 1 });
	assert.equal(P.profileSignature(sbl, { a: 1, b: 1 }), base);
	assert.notEqual(P.profileSignature(sbl, { a: 2, b: 1 }), base, 'list edited');
	assert.notEqual(P.profileSignature({ ...sbl, mode: 'short-title' }, { a: 1, b: 1 }), base);
	assert.notEqual(P.profileSignature({ ...sbl, active: ['b', 'a'] }, { a: 1, b: 1 }), base, 'order matters');
	assert.notEqual(P.profileSignature({ ...sbl, types: ['journal', 'place'] }, { a: 1, b: 1 }), base);
	assert.equal(P.profileSignature({ ...sbl, types: ['journal'] }, { a: 1, b: 1 }), base);
	assert.equal(P.profileSignature({ mode: 'off' }), 'off');
	assert.equal(P.profileSignature(null), 'off');
});

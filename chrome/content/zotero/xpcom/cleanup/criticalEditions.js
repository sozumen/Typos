"use strict";

/**
 * Cleanup step: critical editions imported as Classic Work items
 *
 * Some libraries hold a modern critical edition (a volume in a series such as Corpus
 * Christianorum or Sources chrétiennes) as a Classic Work item, with the editor, the volume and the
 * series squeezed into Extra. This step finds those items and proposes to turn each into a proper
 * Book or Book Section, linked to records for the ancient work, the volume and the multi-volume
 * set it belongs to.
 *
 * Pure functions with no Zotero dependencies, so they can be tested in plain Node (see
 * fork/test/criticalEditions.test.js). The caller passes plain snapshots of items in, and gets
 * a plan back; nothing here writes anything.
 *
 * Snapshot of an item (what the caller supplies):
 *   { id, itemType, fields: { title, series, ... }, creators: [{ creatorType, firstName,
 *     lastName, fieldMode }] }
 * Only non-empty fields need to be present. `fields.extra` is the Extra field.
 *
 * Schema (what the caller supplies, so validity matches the running application):
 *   { isValidField(itemType, field), isValidCreatorType(itemType, creatorType) }
 */
(function (root) {
	const X = typeof module !== 'undefined' && module.exports
		? require('./cleanupExtra.js')
		: root.CleanupExtra;

	const STEP_ID = 'criticalEditions';

	// Fields that describe the ancient work, not the edition. They move to the Work record.
	const WORK_FIELDS = ['referenceSystem', 'corpusId', 'compositionDate', 'originalLanguage'];

	const FIELD_LABELS = {
		referenceSystem: 'Reference System',
		corpusId: 'Corpus ID',
		compositionDate: 'Composition Date',
		originalLanguage: 'Original Language',
		manuscriptType: 'Type'
	};

	// "Livre 1", "Vol. 2", "Band 3", "Tome II": a volume designation, not a title in its own right
	const DESIGNATION = /^(?:vol(?:ume)?\.?|bd\.?|band|tomes?|t\.|livre|liber|book|buch|teil|part|pars|fasc(?:icle)?\.?|heft|no\.?|n°)\s*[0-9ivxlc]+[a-z]?(?:\s*[-–,.]\s*[0-9ivxlc]+)?\.?$/i;


	function looksLikeDesignation(text) {
		let t = String(text || '').trim();
		return /^[0-9]+$/.test(t) || DESIGNATION.test(t);
	}


	function _authors(snapshot) {
		return (snapshot.creators || []).filter(c => c.creatorType === 'author');
	}


	function _field(snapshot, name) {
		let value = snapshot.fields && snapshot.fields[name];
		return value === undefined || value === null ? '' : String(value).trim();
	}


	/**
	 * What Extra says about the edition, plus the Volume Title field
	 *
	 * Zotero moves "Volume Title:" lines out of Extra into the Volume Title field once the item
	 * type has that field, so a volume title can be in either place.
	 */
	function _edition(snapshot) {
		let extra = X.extractEdition(_field(snapshot, 'extra'));
		let fieldValue = _field(snapshot, 'volumeTitle');
		if (fieldValue) {
			if (!extra.volumeTitle) {
				extra.volumeTitle = fieldValue;
			}
			else if (!X.sameText(extra.volumeTitle, fieldValue)) {
				extra.conflicts.push(`Volume Title: ${fieldValue} (the field; Extra says "${extra.volumeTitle}")`);
			}
			extra.volumeTitleInField = true;
		}
		return extra;
	}


	/**
	 * Does this item look like a critical edition imported as a Classic Work?
	 *
	 * Required: Classic Work type; an author; a title (the work); at least one editor in Extra; and
	 * a container, book or volume title in Extra.
	 *
	 * @return {{ matches: Boolean, missing: String[], nearMiss: Boolean }} - nearMiss: it has
	 *     editors in Extra but lacks something else, so it may be worth a look
	 */
	function test(snapshot) {
		let missing = [];
		if (snapshot.itemType !== 'classic') {
			return { matches: false, missing: ['classic type'], nearMiss: false };
		}
		let extra = _edition(snapshot);
		if (!_authors(snapshot).length) missing.push('author');
		if (!_field(snapshot, 'title')) missing.push('title');
		if (!extra.editors.length) missing.push('editor in Extra');
		if (!extra.container && !extra.volumeTitle) missing.push('container, book or volume title in Extra or Volume Title');
		return {
			matches: !missing.length,
			missing,
			nearMiss: !!missing.length && extra.editors.length > 0
		};
	}


	/**
	 * Work out the title of the publication the item sits in
	 *
	 * @return {{ publication: String, multiVolume: String|null, volume: String|null }}
	 *     publication: the volume (or the book) the edition is printed in, as one title.
	 *     multiVolume: the set the volume belongs to, when there is both a container and a volume
	 *     title that isn't just a number.
	 *     volume: when there is a set, the volume's own title or designation (for Volume Title)
	 */
	function _publicationTitles(extra, workTitle) {
		let container = extra.container;
		let volume = extra.volumeTitle;
		if (container && volume) {
			if (looksLikeDesignation(volume)) {
				return { publication: `${container}, ${volume}`, multiVolume: container, volume };
			}
			if (X.sameText(container, volume)) {
				return { publication: volume, multiVolume: null, volume: null };
			}
			return { publication: volume, multiVolume: container, volume };
		}
		return { publication: volume || container || workTitle, multiVolume: null, volume: null };
	}


	function _workKey(title, authors) {
		let first = authors[0];
		return 'work:' + X.foldText(title) + '|' + X.foldText(first ? first.lastName : '');
	}


	function _volumeKey(title, series) {
		return 'volume:' + X.foldText(title) + '|' + X.foldText(series);
	}


	function _multiVolumeKey(title, series) {
		return 'multiVolume:' + X.foldText(title) + '|' + X.foldText(series);
	}


	function _copy(obj) {
		return JSON.parse(JSON.stringify(obj));
	}


	/**
	 * Plan for one item
	 *
	 * @return {Object|null} - null if the item doesn't match
	 */
	function planItem(snapshot, schema) {
		if (!test(snapshot).matches) return null;
		let extra = _edition(snapshot);
		let workTitle = _field(snapshot, 'title');
		let authors = _authors(snapshot);
		let { publication, multiVolume, volume } = _publicationTitles(extra, workTitle);
		let hasPages = !!extra.pages || !!_field(snapshot, 'pages');
		let newType = hasPages ? 'bookSection' : 'book';

		let warnings = [];
		for (let c of extra.conflicts) {
			warnings.push(`Left in Extra because it differs from another line: ${c}`);
		}

		// Fields to set on the converted item. When the volume is part of a set and the type has a
		// Volume Title field, the set's title and the volume's title go in separate fields (as CSL's
		// container-title / title and volume-title); otherwise they are joined into one title.
		let set = {};
		let clear = [];
		let split = !!(multiVolume && volume && schema.isValidField(newType, 'volumeTitle'));
		let mainTitle = split ? multiVolume : publication;
		if (newType === 'book') {
			if (X.foldText(mainTitle) !== X.foldText(workTitle)) set.title = mainTitle;
		}
		else {
			set.bookTitle = mainTitle;
			set.pages = extra.pages || _field(snapshot, 'pages');
		}
		if (split) {
			set.volumeTitle = volume;
		}
		else if (extra.volumeTitleInField) {
			// The volume title is now part of the title above; don't keep it twice
			clear.push('volumeTitle');
		}
		let series = _field(snapshot, 'series');
		if (extra.series) {
			if (!series) {
				set.series = extra.series;
			}
			else if (!X.sameText(series, extra.series)) {
				warnings.push(`The series field says "${series}" but Extra says "${extra.series}"; kept the field`);
				// Extra says something different from the field, so its lines stay
				for (let i of extra.lines.series) extra.used.delete(i);
			}
		}
		let effectiveSeries = series || extra.series || '';

		// Editors from Extra, minus any the item already has
		let haveEditors = (snapshot.creators || []).filter(c => c.creatorType === 'editor');
		let editors = extra.editors.filter(e => !haveEditors.some(h => X.sameText(h.lastName, e.lastName)
			&& X.sameText(h.firstName || '', e.firstName || '')));

		// Fields of the work that move to the Work record
		let workFields = {};
		for (let f of WORK_FIELDS) {
			let v = _field(snapshot, f);
			if (v) workFields[f] = v;
		}

		// Fields the new type can't hold and that aren't moving to the Work: they go to Extra
		let toExtra = [];
		for (let [field, value] of Object.entries(snapshot.fields || {})) {
			if (field === 'extra' || !String(value).trim() || WORK_FIELDS.includes(field)) continue;
			if (!schema.isValidField(newType, field)) {
				toExtra.push(`${FIELD_LABELS[field] || field}: ${value}`);
			}
		}

		let workKey = _workKey(workTitle, authors);
		let volumeKey = newType === 'bookSection' ? _volumeKey(publication, effectiveSeries) : null;
		let multiKey = multiVolume ? _multiVolumeKey(multiVolume, effectiveSeries) : null;

		return {
			step: STEP_ID,
			itemID: snapshot.id,
			workTitle,
			newType,
			set,
			clear,
			addEditors: editors,
			workFields,
			toExtra,
			removeExtraLines: [...extra.used],
			warnings,
			// Records this item can be linked to (entity keys; see planAll)
			workKey,
			volumeKey,
			multiKey,
			// What the entities would look like, used by planAll to build the suggestions
			entity: {
				work: {
					title: workTitle,
					authors: _copy(authors),
					fields: workFields,
					language: _field(snapshot, 'language')
				},
				volume: volumeKey ? {
					title: mainTitle,
					// What the preview calls it: the set and the volume together
					label: publication,
					editors: _copy(extra.editors),
					fields: Object.assign(
						_pick(snapshot, ['series', 'seriesNumber', 'publisher', 'place', 'date', 'edition', 'language', 'ISBN'], set),
						split ? { volumeTitle: volume } : {}
					)
				} : null,
				multiVolume: multiKey ? {
					title: multiVolume,
					fields: effectiveSeries ? { series: effectiveSeries } : {}
				} : null
			},
			// The item itself is the volume when it is a whole book that sits in a set
			itemIsVolume: newType === 'book'
		};
	}


	function _pick(snapshot, names, overrides) {
		let out = {};
		for (let n of names) {
			let v = overrides[n] !== undefined ? overrides[n] : _field(snapshot, n);
			if (v) out[n] = v;
		}
		return out;
	}


	/**
	 * Plan for a set of items
	 *
	 * @param {Object[]} snapshots - All Classic Work items (and any other items that might be
	 *     existing works are not needed; works are matched among Classic items only)
	 * @param {Object} schema
	 * @return {{ items: Object[], suggestions: Object[], nearMisses: Number[] }}
	 *     suggestions: records that could be created, one per distinct work/volume/set, each with
	 *     `id`, `kind` ('work', 'volume', 'multiVolume'), `title`, `existingID` (if a matching
	 *     record is already in the library), and `itemIDs` (the items that would link to it).
	 */
	function planAll(snapshots, schema) {
		let items = [];
		let nearMisses = [];
		let candidates = new Set();
		for (let snap of snapshots) {
			let t = test(snap);
			if (t.matches) {
				items.push(planItem(snap, schema));
				candidates.add(snap.id);
			}
			else if (t.nearMiss) {
				nearMisses.push(snap.id);
			}
		}

		// Existing Classic records that could already be the work: classic items that are not
		// themselves candidates and carry no edition data in Extra
		let existingWorks = new Map();
		for (let snap of snapshots) {
			if (snap.itemType !== 'classic' || candidates.has(snap.id)) continue;
			let extra = _edition(snap);
			if (extra.editors.length || extra.container || extra.volumeTitle) continue;
			let key = _workKey(_field(snap, 'title'), _authors(snap));
			if (!existingWorks.has(key)) existingWorks.set(key, snap.id);
		}

		let byId = new Map();
		let suggestions = [];
		let suggest = (id, kind, title, itemID, build, existingID = null) => {
			let s = byId.get(id);
			if (!s) {
				s = { id, kind, title, existingID, itemIDs: [], build };
				byId.set(id, s);
				suggestions.push(s);
			}
			s.itemIDs.push(itemID);
			// Several items share one record: fill in what the first one lacked from the others
			for (let [name, value] of Object.entries(build.fields || {})) {
				if (!s.build.fields[name]) s.build.fields[name] = value;
			}
			return s;
		};

		for (let plan of items) {
			suggest(plan.workKey, 'work', plan.entity.work.title, plan.itemID, plan.entity.work,
				existingWorks.get(plan.workKey) || null);
			if (plan.volumeKey) {
				suggest(plan.volumeKey, 'volume', plan.entity.volume.label || plan.entity.volume.title, plan.itemID,
					plan.entity.volume);
			}
			if (plan.multiKey) {
				suggest(plan.multiKey, 'multiVolume', plan.entity.multiVolume.title, plan.itemID,
					plan.entity.multiVolume);
			}
		}

		return { items, suggestions, nearMisses };
	}


	/**
	 * Turn an item plan into the concrete changes to make, given which suggestions are ticked
	 *
	 * Nothing is lost when a suggestion is switched off: the Work fields that would have moved to a
	 * Work record go to Extra instead.
	 *
	 * @param {Object} plan - from planItem
	 * @param {Set<String>} selected - ids of the suggestions that will be created or linked to
	 * @param {Object} snapshot - the item's current snapshot
	 * @param {Object} schema
	 * @return {{ itemType: String, fields: Object, creators: Object[], links: Object[] }}
	 *     fields: new values (a value of null clears the field); creators: the full creator list;
	 *     links: [{ type: 'criticalEditionOf'|'partOf', from: 'item'|<suggestion id>, to: <suggestion id> }]
	 */
	function resolve(plan, selected, snapshot, schema) {
		let fields = {};
		let extra = _field(snapshot, 'extra');
		extra = X.removeLines(extra, new Set(plan.removeExtraLines));

		let extraLines = [...plan.toExtra];
		for (let [f, v] of Object.entries(plan.workFields)) {
			if (!selected.has(plan.workKey)) {
				extraLines.push(`${FIELD_LABELS[f] || f}: ${v}`);
			}
		}
		extra = X.appendLines(extra, extraLines);

		for (let [f, v] of Object.entries(plan.set)) {
			if (v && schema.isValidField(plan.newType, f)) fields[f] = v;
		}
		for (let f of WORK_FIELDS) fields[f] = null;
		for (let f of plan.clear || []) fields[f] = null;
		fields.extra = extra;

		let creators = _copy(snapshot.creators || []);
		for (let e of plan.addEditors) {
			creators.push({ creatorType: 'editor', firstName: e.firstName, lastName: e.lastName, fieldMode: e.fieldMode });
		}
		// A creator type the new type doesn't have becomes "contributor"
		creators = creators.map(c => schema.isValidCreatorType(plan.newType, c.creatorType)
			? c
			: Object.assign({}, c, { creatorType: 'contributor' }));

		// Links: item -> work; item -> volume (sections) -> set; or item (a book) -> set
		let links = [];
		if (selected.has(plan.workKey)) {
			links.push({ type: 'criticalEditionOf', from: 'item', to: plan.workKey });
		}
		let volumeOn = plan.volumeKey && selected.has(plan.volumeKey);
		let multiOn = plan.multiKey && selected.has(plan.multiKey);
		if (volumeOn) {
			links.push({ type: 'partOf', from: 'item', to: plan.volumeKey });
			if (multiOn) {
				links.push({ type: 'partOf', from: plan.volumeKey, to: plan.multiKey });
			}
		}
		else if (multiOn) {
			links.push({ type: 'partOf', from: 'item', to: plan.multiKey });
		}
		return { itemType: plan.newType, fields, creators, links };
	}


	/**
	 * Fields and creators for a record the step creates
	 *
	 * @param {Object} suggestion - one of planAll's suggestions
	 * @param {Object} [schema] - to check that the Multi-Volume Work type exists; without it, or
	 *     without that type, a set is created as a Book
	 * @return {{ itemType: String, fields: Object, creators: Object[] }}
	 */
	function entityData(suggestion, schema) {
		let b = suggestion.build;
		if (suggestion.kind === 'work') {
			let fields = Object.assign({ title: b.title }, b.fields);
			return { itemType: 'classic', fields, creators: _copy(b.authors) };
		}
		let fields = Object.assign({ title: b.title }, b.fields);
		let creators = suggestion.kind === 'volume'
			? b.editors.map(e => ({ creatorType: 'editor', firstName: e.firstName, lastName: e.lastName, fieldMode: e.fieldMode }))
			: [];
		let itemType = 'book';
		if (suggestion.kind === 'multiVolume' && schema && schema.isValidField('multiVolumeWork', 'title')) {
			itemType = 'multiVolumeWork';
		}
		if (schema) {
			for (let f of Object.keys(fields)) {
				if (!schema.isValidField(itemType, f)) delete fields[f];
			}
		}
		return { itemType, fields, creators };
	}


	let api = {
		STEP_ID,
		WORK_FIELDS,
		looksLikeDesignation,
		test,
		planItem,
		planAll,
		resolve,
		entityData
	};

	if (typeof module !== 'undefined' && module.exports) {
		module.exports = api;
	}
	else if (root) {
		root.CleanupCriticalEditions = api;
	}
})(typeof Zotero !== 'undefined' ? Zotero : null);

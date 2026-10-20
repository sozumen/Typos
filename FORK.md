# Typos

A reference manager for people who work with ancient and classical texts, built on **Zotero 10.0.7**
with features ported from **Juris-M / Jurism** and new features that neither has.

## Name and branding

The application is called **Typos**. Zotero's name and logo are trademarks of the Corporation for
Digital Scholarship, and this code is licensed AGPL-3.0 (see `COPYING`, `NOTICE`). Typos is not
affiliated with or endorsed by either project.

**Renamed:** everything a person sees. The window and About dialog, menus, preferences and
messages (`app/assets/branding/`, and the English and translated strings in `chrome/locale/`,
rewritten by `fork/scripts/rebrand.js`), the default data folder (`~/Typos`), the profile
location, installer/bundle/archive names in `app/` scripts, the desktop entry, backup folder
names, and the identifiers this fork added (`typos-abbreviations`, `typos@localhost`,
the relation namespace URI).

**Deliberately not renamed**, because renaming would break things or misrepresent them:

- The `Zotero` JavaScript global, `chrome://zotero/…` paths, `ZoteroPane`, `extensions.zotero.*`
  preferences, `zotero.sqlite`, the `zotero://` scheme and the `zotero@zotero.org` add-on ID.
  Every module, plugin and translator is written against these names. Renaming them is a
  large, risky change with no user-visible benefit; the data file name `zotero.sqlite` is also what
  existing tools expect. (A library that uses Classic Work items won't open in official Zotero.)
- Names of other people's services: *Zotero Connector*, *Zotero Storage*, *Zotero account*,
  the Zotero API/sync servers, the Zotero Forums, the Style Repository. Typos still talks to
  them (translators, styles, the browser connector).
- License headers and copyright notices in source files.
- `app/win/installer/*` (the Windows installer) and `app/update-packaging/`. See below.
- The Mac bundle identifier `org.zotero.zotero` (it also names the macOS profile folder), the
  executable names `zotero`, `zotero-bin`, `zotero.exe` (prebuilt binaries), and the
  `Zotero_*_Integration` word-processor plugin names.
- The repository folder name and some test-fixture strings.

**Things you still need to do yourself:**

1. **Logo and icons.** The artwork under `app/assets/branding/` and `chrome/skin/` is still
   Zotero's. Replace it before distributing.
2. **Windows installer.** `app/win/installer/*.nsi` still say "Zotero", and its cleanup code
   removes an existing Zotero installation. Renaming it needs a different install directory,
   registry keys and uninstall logic, which can't be tested without Windows. Don't ship the
   installer as is next to a real Zotero.
3. **Updates are switched off** (`app/assets/prefs.js`, `application.ini`, the "Check for
   Updates" menu item is hidden). Otherwise the official Zotero update server would replace
   Typos with Zotero. Add your own update server and re-enable it deliberately.
4. **Support and website links.** Help, Feedback, Forums and Report Error menu entries still go
   to zotero.org. Point them at your own pages (`chrome/content/zotero/`, `ZOTERO_CONFIG` in
   `resource/config.mjs`).
5. **Running next to Zotero.** The data folder and profile no longer overlap with Zotero's, but
   both apps register the `zotero://` scheme and the RIS/BibTeX file types, so whichever
   was installed last handles them. The browser Connector talks to the first app that answers
   on port 23119.
6. **Other languages.** Non-English strings were rebranded mechanically. A translation that
   attaches endings to the name (for example "Zotero-" in German compounds) may read oddly.
   After merging upstream, run `npm run rebrand` again; `-- --check` lists what it would change.

## What you asked for, and where it stands

| # | Requirement | Status | Where |
|---|---|---|---|
| 1 | **Classic** item type | Done. Not runnable-tested here | `fork/schema/overlay.json`, `fork/scripts/build-schema.js` |
| 2 | Item relationships and hierarchies | Done. Not runnable-tested here | `xpcom/data/relationGraph.js`, `itemRelations.js`, `itemRelationsPane.js` |
| 3 | Import from a Jurism library | Done (database and JSON). Not tested against a real Jurism profile | `xpcom/import/jurism*.js`, File → Import from Juris-M… |
| 4 | Local storage + cloud backup | Done: folder and Google Drive. Not runnable-tested here | `xpcom/backup/`, `docs/BACKUP.md` |
| 5 | Abbreviation lists (classics, journals, series…), selectable per style and per document | Done. Not runnable-tested here | `xpcom/abbreviationIndex.js`, `abbreviationProfiles.js`, `classicalAbbreviations.js`, Preferences → Cite |
| 6 | **Visual Style Editor**: edit any CSL style as a tree, with live preview | Done. Engine tested; UI only in a simulated browser | `xpcom/styleEditor/`, `tools/visualStyleEditor.*`, `docs/STYLE-EDITOR.md` |
| 7 | **Write a Style with AI** from a style manual or example citations (Claude, your own API key) | Done. Never called the real API | `xpcom/styleAI/`, `tools/styleAI.*`, `docs/STYLE-EDITOR.md` |
| 9 | **Per-field languages** (Jurism/MLZ style): language and variants for any text field and name, used in the Info pane and in citations | Data layer and its in-app tests pass in CI. The Info pane menus, rows and settings window have never been looked at | `xpcom/multilingual/`, `tools/multilingualSettings.*`, `elements/itemBox.js`, Tools → Citation Languages…, `docs/MULTILINGUAL.md` |
| 8 | **Library cleanup**: critical editions imported as Classic Works → proper records and relationships; merge duplicate works keeping titles as languages | Done. See in-app test status below | `xpcom/cleanup/`, `tools/cleanup.*`, Tools → Library Cleanup…, `docs/CLEANUP.md` |

Dropped from Juris-M, as requested: legal citation (jurisdiction/court tables, legal item
types' special fields). Multilingual: languages and variants are stored in tables shaped like
Jurism's (see 9 below).

### 1. Classic Work item type

Added without editing the upstream schema submodule: `build-schema.js` applies
`fork/schema/overlay.json` to `resource/schema/global/schema.json` and writes
`resource/schema/fork/schema.json` (its version is the upstream version + 100000, which keeps the
app's schema-update check working).

Fields include title, Reference System, Corpus ID, Composition Date, Original Language, series,
volume, edition, date, publisher/place, **original date/publisher/place** (for republications),
ISBN, DOI, citation key, URL, archive, Extra. Creators: author, editor, translator, contributor,
series editor.

**Your sentence was cut off.** You wrote the Classic type is for "ancient texts that aren't
cited as…" and never finished. I assumed *"cited by page number; cited by canonical reference"*
(e.g. *Il.* 1.1–10, Plato *Rep.* 514a). That is what **Reference System** and **Corpus ID** are
for. Citing "Iliad 1.1" itself comes from the locator you type when citing, using the label
"line", "section", etc. If you meant something else, tell me and I'll change it.

For CSL it maps to type `book`, so every existing style works. Styles that want a distinct
classic type would need a CSL addition.

### 2. Relationships

Five typed, directed relations, each with an inverse label in the UI: **part of**,
**republication of**, **critical edition of**, **translation of**, **commentary on**. Shown in
a new "Relationships" section in the item pane (add, remove, follow).

- Stored as ordinary Zotero relations (predicates `rm:partOf`, `rm:republicationOf`, …; the `rm:` prefix expands to the `typos:` namespace URI), so
  they are in the database, backups and use the existing relation machinery. Only the forward
  direction is stored; the inverse is computed.
- Hierarchical ones are acyclic: adding one that would create a cycle is refused
  (`InvalidRelationError`, code `cycle`). Same-library, regular items only.
- `Zotero.ItemRelations.getAncestors / getDescendants / getDescendantTree` for traversal.
  Chapter-in-book is "part of"; critical edition → classic work is "critical edition of".

### 3. Juris-M import

File → **Import from Juris-M…** accepts either:
- a Jurism `jurism.sqlite` (or `zotero.sqlite`) database file (it's copied first; the original is
  never opened for writing), or
- a Zotero-API-shaped JSON file.

Preserves item keys, collections, tags, notes, attachments (copies `storage/` files),
annotations and relations; skips items whose keys already exist (so it is safe to run twice).
Juris-M-only types are mapped (gazette/regulation → statute, treaty → document,
legal commentary → book section). Any field that doesn't exist on the target type goes into
**Extra** as `Label: value`, never dropped. Alternate-language values and creators are kept in a
single `mlz-alternates:` JSON line in Extra for a future multilingual feature.

Not imported: group libraries, feeds, saved searches, jurisdiction/court tables.

### 4. Backup

See `docs/BACKUP.md`. Short version: your library is stored locally (the data directory). Backup
makes timestamped database snapshots and uploads attachment files incrementally to a folder or
to Google Drive (your own OAuth client; scope `drive.file`). Restore goes to a new empty folder.

**This does not sync with zotero.org.** The Classic type is not in the official schema, so the
Zotero server would reject those items. Leave sync disabled for any library containing
Classic Work items or relations from this fork, and use backup instead.

### 5. Abbreviations

Preferences → Cite → *Abbreviations*. Details in `docs/ABBREVIATIONS.md`. Short version:

- Import **any number of lists** (JSON or CSV/TSV) of **classical works, authors, journals,
  series, publishers and places**. Zotero's built-in MEDLINE journal table is also available as
  a selectable list.
- Group lists into **profiles** (lists in priority order + output mode + which kinds of entry).
- Choose the profile **per citation style** (Preferences) and **per Word / LibreOffice
  document** (Document Preferences → Abbreviations). Order: document, then style, then the
  general settings.
- Output per profile: *abbreviated* (forced, whatever the style does), *short forms only*
  (styles that use short forms show them, others show full text), or *full*.
- An item's own Journal Abbr wins over a list, unless you turn that off.
- Applied where items reach the citation engine, so it works with every CSL style and both
  citeproc engines.

No real authority's list is bundled apart from Zotero's journal table. The sample files in
`fork/examples/` contain a few illustrative entries; import your own (e.g. the OCD, LSJ, TLL or
SBL lists).

Profiles, style assignments and general settings live in preferences, so backups don't include
them (the list files themselves are included).

### 6 and 7. Visual Style Editor and AI style writer

Tools → Visual Style Editor… and Tools → Write a Style with AI…; see `docs/STYLE-EDITOR.md`. Short
version: a tree editor that works on every CSL style (with undo, an XML view, schema validation on
each change and a live preview), and a dialog that sends a style manual and/or example citations
to Claude, checks and repairs what comes back, and opens it in the editor as an unsaved style.

**Privacy:** the AI feature sends the material you add (a PDF whole) to Anthropic with your own API
key; nothing from your library is sent. The key is stored encrypted via the login manager.

### 8. Library cleanup

Tools → **Library Cleanup…** runs a list of cleanup steps; each one finds items, shows a preview with
a checkbox on every item and every record it would create, and applies only what is ticked, in
one transaction, with an undo file. The first step turns Classic Work items that are really critical
editions (author, work title, editor and container/volume title in Extra) into Book / Book Section
records linked to a new Classic Work, volume and multi-volume record. "Siblings" (items related the same
way to the same item) are listed in the Relationships section. Tools → **Merge Selected Works…**
merges duplicate works and keeps the other titles as alternate-language titles. Details and
limits: `docs/CLEANUP.md`.

### 9. Per-field languages

Right-click a text field or a name in the Info pane: **Add Variant** adds a row for the value in
another language; **Set Field Language** marks which language the main value is in. The same
languages and variants live in tables with Jurism's names (`itemDataMain`, `itemDataAlt`,
`itemCreatorsMain`, `itemCreatorsAlt`, `zlsTags`), created when Typos starts without changing
Zotero's schema version. Tools → **Citation Languages…** chooses, for titles, names, publishers
and everything else, whether citations use the original, a variant, or both, and in which
language order; the default is the original, so nothing changes until you choose. Juris-M imports
now store languages in the tables, and the same window can move language data an earlier import
left in Extra. Details and limits: `docs/MULTILINGUAL.md`.

## Building and testing

```
git submodule update --init --recursive   # many submodules are NOT checked out yet
npm ci
npm run build                              # also regenerates the fork schema
npm start                                  # build + watch
npm run ftl-to-json                        # if the build complains about missing locale JSON
node --test fork/test/*.test.js            # fast tests, no app needed
test/runtests.sh classicItem itemRelations classicalAbbreviations jurismImport backup
```

## What has NOT been verified

Everything here was written in a sandbox without a built Zotero runtime. In particular:

- **The app builds and starts** (Linux runner for the tests; Windows runner for the installer).
- **Windows build, tested on a GitHub runner (not on your PC):** the workflow builds the app, builds
  the installer, installs it silently for one user, checks the files and version info, starts the
  app (window title "My Library - Typos", local port answering), and uninstalls it. This passed.
  Not tried: the installer's click-through screens, the all-users install, the in-app update
  check/prompt/install against a real release, the upstream watcher against real GitHub, anything
  with an actual library, a word processor or a second monitor. See `docs/WINDOWS.md` for what is
  deliberately not done (code signing, Mac installer).
- **In-app Mocha tests now run in CI** (`.github/workflows/app-tests.yml`, started by hand from the
  Actions tab; arguments are the same as `test/runtests.sh`). They ran against a Linux build, with
  no display, so nothing that needs a real window, a word processor or Windows-specific behavior was
  exercised. The first run found three real bugs, now fixed: an item's own Journal Abbr never won over an
  abbreviation list (Zotero's CSL JSON calls the variable `journalAbbreviation`); the Juris-M JSON
  import failed on every item; and every document got an `abbreviationProfile` setting written into it.
  It also showed that four of upstream's tests assume the stock item types and sample data; those
  were updated for the Classic Work type (`cachedTypesTest.js`, `data/allTypesAndFields.js`).
  At the last run, all four shards of upstream's own suite (`ci.yml`) and every test added by this
  fork passed: Classic type, relations (including siblings), abbreviations, Juris-M import, backup,
  local server (including port fallback) and library cleanup. When item types change, regenerate the
  generated sample data with the app-tests workflow (`args: sampleDataGenerator`, `regenerate`
  ticked); it pushes the files to a branch called `sample-data`.
- **The Node tests do pass** (`node --test fork/test/*.test.js`) and cover the pure logic: relation
  graph, abbreviation parsing/lookup/profiles/resolution (including the storage module against a
  stubbed Zotero), Jurism field mapping and SQL (against Jurism's real DDL), backup planning and
  retention, the Drive client against a simulated Drive, and the folder backend.
- **Not tried against a real Jurism profile.** The SQL was checked against Jurism's schema SQL
  and fixtures, not live data. Try it on a *copy* of your library first.
- **Google Drive was never called for real.** The client follows the v3 REST docs and is tested
  against an in-memory imitation. Expect to debug one thing on first real use (most likely the
  redirect/consent screen configuration, not code).
- UI (item pane section, preferences panels including the abbreviation profile editor, the
  document-preferences menu, import menu item) is unlooked-at: layout and styling need an eye.
  The Word / LibreOffice per-document choice was written against Zotero's own plumbing for the
  existing journal-abbreviation option but never run with a word processor.
- **Visual Style Editor and AI dialog**: the editing engine, prompt building, reply handling and
  repair loop are tested in Node (against the official CSL schema and nine real styles from the CSL
  repository, up to 2,400 elements). The two windows were driven in a simulated browser (jsdom, with
  `Zotero` stubbed) through add, delete, move, drag, undo, rename, XML view, validation, install, key
  storage, PDF and text manuals and error cases. They have **not run in the real application**:
  layout, styling, keyboard behavior, the file picker, the close-with-unsaved-changes prompt, the
  preview iframe and the login-manager key storage are unlooked-at.
- **The Claude API was never called for real.** The client follows the documented Messages API (headers,
  base64 PDF document block) and is tested against a fake. Whether a particular manual yields a good
  style is untested; always check generated styles against the manual.
- Labels for CSL elements and attributes in the editor (the schema data) are English only.
- Only `en-US` strings exist for new UI; other locales fall back.
- The new Classic icon is a recolor of the Book icon.

## Installing, updating, releasing (Windows)

See `docs/WINDOWS.md`. Short version: GitHub Actions builds `Typos-<version>_x64_setup.exe`; the
installer offers "just me" (no administrator) or "everyone"; Typos checks GitHub Releases and asks
before it updates itself; a release is made by pushing a tag like `v10.0.7.3` or running the
**Build Windows installer** workflow.

## Keeping up with upstream Zotero

A weekly workflow compares Typos with upstream Zotero and reports what following it would involve;
a second workflow brings chosen changes in on a new branch and opens a draft pull request. Nothing
is merged automatically. See `docs/UPSTREAM.md`.

By hand, the older way still works:
The fork changes upstream files in a few small places (listed below). To update:

1. Bump the submodules and merge upstream Zotero changes (`git remote add upstream
   https://github.com/zotero/zotero`, `git merge upstream/main` — expect conflicts mainly in
   `zotero.mjs` and `zotero.js`).
2. `npm run rebrand` re-applies the name to any new upstream locale strings.
3. `npm run build` regenerates the fork schema from the new global schema automatically; to
   check by hand, `node fork/scripts/build-schema.js --check`.
4. Re-run both test suites.

Touch points in upstream files: `zotero.mjs` (module list), `xpcom/zotero.js` (init calls), `xpcom/server/server.js` (port fallback) and the Advanced preferences pane (port notice),
`xpcom/schema.js` (reads the fork schema), `xpcom/data/cachedTypes.js` (icon + primary types),
`xpcom/data/relations.js` (the `typos:` namespace, prefix `rm:`), `xpcom/cite.js` and `xpcom/style.js`
(abbreviation hooks), `xpcom/integration.js`, `bibliography.js` and
`integration/integrationDocPrefs.xhtml` (per-document abbreviation profile), `defaults/preferences/zotero.js`, preferences panes (`cite`, `advanced`),
`zoteroPane.xhtml` + `fileInterface.js` (import and Tools menus), `preferences_cite.xhtml` (editor button), `scss/components/_item-tree.scss`, and
the `.ftl` files. Everything else is new files under `xpcom/backup/`, `xpcom/import/`, `xpcom/styleEditor/`, `xpcom/styleAI/`, `tools/`, `fork/`,
`docs/`, `test/tests/`.

Upstream is currently at Zotero 11; this is based on 10.0.7 as you chose. A move to 11 is a
merge plus the checklist above.

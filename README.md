Typos
=====

Typos is a free reference manager for people who work with ancient, classical and historical
texts. It collects, organizes and cites research sources, and adds things those scholars need:

- A **Classic Work** item type, for texts cited by canonical reference rather than by page
- **Typed relationships** between items: part of, republication of, critical edition of,
  translation of, commentary on
- **Import from a Juris-M / Jurism library** (database file or JSON)
- **Local storage with backup** to a folder or Google Drive
- **Abbreviation lists** for classical works, authors, journals, series, publishers and
  places, selectable per citation style and per word-processor document

Typos is based on [Zotero](https://www.zotero.org/) 10.0.7 and ports features from
[Juris-M](https://juris-m.github.io/). It is not affiliated with or endorsed by either project.
Zotero is a trademark of the Corporation for Digital Scholarship. See `NOTICE`.

Documentation
-------------

- `FORK.md` -- what was added, how to build and test, what is unverified, what is still named
  "Zotero" and why
- `docs/ABBREVIATIONS.md` -- abbreviation lists and profiles
- `docs/BACKUP.md` -- backup and restore, Google Drive setup

Building
--------

```
git submodule update --init --recursive
npm ci
npm run build
node --test fork/test/*.test.js
```

License
-------

GNU Affero General Public License v3.0 (`COPYING`).

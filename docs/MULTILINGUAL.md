# Per-field languages

Any text field and any name can have a **language** and **variants**: the same value in other
languages or scripts. This is the idea behind Jurism/MLZ's multilingual feature, with the same
table layout, so data from a Jurism library keeps its meaning.

## In the Info pane

Right-click a field that has a value, or a name:

- **Add Variant → (language)** adds a row under the field for that language. Type the value and
  press Enter or leave the row. Empty rows disappear. A variant's `−` button removes it.
  Names are typed as `Last, First`; a name without a comma is a single-field name.
- **Set Field Language → (language)** records which language the main value is in. It shows as a
  small badge after the value.
- **Other…** in either section adds a language tag (for example `ja-Latn`) to the list.

Dates, identifiers (URL, DOI, ISBN…), numbers (volume, pages…) and Extra have no languages.

## In citations

Tools → **Citation Languages…** has four groups: titles, names, publishers and places, and
everything else. For each: use *the original*, *a variant*, or (not for names) *the original
with the variant in brackets*, and the languages to try, in order. If an item has no variant in
any of those languages the original is used. The default is the original, so nothing changes
until you choose otherwise.

This applies wherever Typos builds citations from the library: citations and bibliographies in
word processors, quick copy and bibliographies made from the library.

## Where the data is

| Table | Holds |
|---|---|
| `zlsTags` | the languages offered in the menus |
| `itemDataMain` | the language of a field's main value |
| `itemDataAlt` | a variant of a field (points at `itemDataValues`) |
| `itemCreatorsMain` | the language of a name's main form |
| `itemCreatorsAlt` | a variant of a name (points at `creators`) |

They are created at start-up with `CREATE TABLE IF NOT EXISTS`; Zotero's own schema version is not
changed. Zotero's routine that removes unused values and creators keeps the ones variants use.
Everything is also held in memory, because citation code is synchronous.

## Importing from Juris-M

The import now stores languages and variants in these tables. Items imported **before** that kept
them as one `mlz-alternates:` line in Extra: the Citation Languages window has a button, *Move
language data out of Extra*, that stores them and removes the line. A record of each item's Extra
as it was is written to `typos-multilingual/` in the data folder.

## Limits (read these)

- **Not looked at in the running app.** The data layer and citation substitution have in-app
  tests that pass in CI; the menus, variant rows, badge and settings window were written without
  being seen. Expect layout and focus problems.
- Variants are **not** copied when an item is duplicated or cloned, and not combined by *Merge
  Items*: the kept item keeps its own.
- **Not synced.** Zotero's sync server knows nothing about these tables. Changing a variant marks
  the item modified locally, but other devices will not receive the variants.
- Not searchable or sortable by variant, and the item tree shows the main value only.
- Creator variants are tied to the creator's position. Moving or deleting creators in the Info
  pane keeps them in step; changing the list some other way (scripts, other tools) does not.
- Exports (RIS, BibTeX, CSL JSON from the translators) carry the main value only.
- Only the main item's fields: attachments and notes have no languages.

# Abbreviations

Preferences → Cite → **Abbreviations**.

You can import any number of abbreviation lists, group them into **profiles**, and choose which
profile applies to a **citation style** or to a **Word / LibreOffice document**.

## What can be abbreviated

| Entry type | Abbreviates | CSL variable | Notes |
|---|---|---|---|
| `work` | Classical work titles | `title` | Can be limited to one author ("Politics" by Aristotle only) |
| `author` | Author names | `author` | Replaces a matching author, e.g. Homer → Hom. |
| `journal` | Journals, and any other container (the book a chapter is in) | `container-title` | |
| `series` | Series | `collection-title` | |
| `publisher` | Publishers | `publisher` | Off by default |
| `place` | Places of publication | `publisher-place` | Off by default |

Matching ignores case, accents, punctuation and spacing. For journals, series, publishers and
places it also ignores a leading "The" and treats "&" as "and", so *The Classical Quarterly* and
*Classical Quarterly* find the same entry. Add other spellings as `aliases`.

## Lists

**Import…** accepts JSON or CSV/TSV (examples in `fork/examples/`):

```json
{
  "format": "typos-abbreviations", "version": 1,
  "name": "My list",
  "entries": [
    { "type": "journal", "full": "Journal of Hellenic Studies", "abbreviation": "JHS" },
    { "type": "series",  "full": "Loeb Classical Library",      "abbreviation": "LCL" },
    { "type": "work",    "full": "Iliad", "abbreviation": "Il.", "author": "Homer", "aliases": ["Ilias"] },
    { "type": "author",  "full": "Homer", "abbreviation": "Hom." }
  ]
}
```

```
type,full,abbreviation,author,aliases
journal,Journal of Hellenic Studies,JHS,,
work,Iliad,Il.,Homer,Ilias|Ilias Homeri
```

CSL-style abbreviation files (the format used by Zotero's `abbreviations.json` and by Jurism) also
import: `title`, `container-title`, `collection-title`, `publisher`, `place` and `author`
sections become the matching entry types. Their word-by-word rules (`container-title-word`) can't
be represented in a list and are skipped with a warning; only whole titles are matched.

### The built-in journal list

The first row in the list of lists is **Zotero journal abbreviations (MEDLINE)**: the table that
ships with the application (about 2,800 journal titles plus word-by-word rules that cover many
more), including your own `abbreviations.json` in the data directory if you have one. It is an
ordinary choice: tick it in a profile, put it above or below your own lists, or leave it out.

### Order

When two active lists abbreviate the same thing, the one higher in the order wins. In the
general settings, the order is the order you ticked the lists; in a profile you can move lists
up and down.

## Output modes

- **Abbreviated titles and names**: the abbreviation replaces the full text *whatever the style
  does*. Use this to force "CQ" even in a style that would print full journal names.
- **Full, with abbreviation as short title** ("Short forms only"): the full text stays, and the
  abbreviation is supplied as the item's short form. Styles that ask for short forms
  (`form="short"`) then show it; others show the full name. Use this to let each style decide.
  Publishers and places have no short form in CSL, so this mode doesn't affect them.
- **Full titles and names**: no abbreviations.

An item's own **Journal Abbr** field wins over a list, so a one-off correction on an item is
respected. Untick "Use an item's own Journal Abbr instead of a list" to have lists always win.

**Apply to:** "Classic Work items only" limits *classical work titles and authors* to Classic Work
items, so a modern book called *Politics* isn't turned into *Pol.* Journals, series, publishers
and places always apply to every item type.

## Profiles

A profile is a saved combination of: lists (in order), output mode, which entry types to apply,
the Classic-only scope, and the Journal Abbr preference. Examples: "SBL: journals and classics
abbreviated", "Journal article: journals short only", "Everything in full".

Two profiles always exist:

- **General settings**: what's in Preferences → Cite → Abbreviations above the profile list.
- **No abbreviations**.

Create more with **New Profile…**; edit or remove them from the list. Removing a profile sends
styles that used it back to the general settings; removing a *list* takes it out of every
profile that used it.

## Which profile applies

1. The profile chosen in the **document's preferences** (Word / LibreOffice: Document
   Preferences → Abbreviations), if the document has one: "General settings", "None", or a
   profile.
2. Otherwise the profile assigned to the **citation style** (Preferences → Cite → Abbreviations →
   Citation styles).
3. Otherwise the **general settings**.

"Style default" in the document dialog means "no choice for this document", so a document
follows its style's profile and picks up later changes to it. A document that names a profile
which doesn't exist on this computer (it was made on another one) quietly falls back to steps 2
and 3, and the dialog shows the missing name so the choice isn't lost.

Changing a document's profile refreshes its citations and bibliography.

## Interaction with "Use MEDLINE journal abbreviations"

Zotero's own checkbox in Document Preferences still exists and works as before. The two don't
fight: a list or profile runs first, and only journals it doesn't abbreviate are then left to the
built-in automatic feature (which applies only in styles that use short forms). If you want the
MEDLINE table inside the same system, tick the built-in list in a profile instead.

## Where it applies

Everything that formats citations: the Word / LibreOffice plugins, Create Bibliography, Copy
Citation / Quick Copy, drag-and-drop, the item pane's citation preview, and the local API. All of
these follow rules 2 and 3 above. Only the word-processor plugins have a per-document choice.

## Limits

- **Profiles, style assignments and general settings are stored in preferences, not in the data
  directory.** Backups include the imported list files but not those choices; on a new computer
  you'd re-create profiles and assignments.
- Word-by-word journal rules exist only in the built-in table. Imported lists match whole titles
  and aliases.
- Create Bibliography and Quick Copy have no per-output profile picker.
- Cached bibliography text inside a Word document is refreshed the next time you refresh the
  document after changing a list or profile.
- No real-world list is bundled apart from Zotero's journal table. The sample files are
  illustrative. Import your own authority's list.

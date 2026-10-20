# Library cleanup

**Tools → Library Cleanup…** runs cleanup steps over your library. Each step finds items that
need tidying, shows what it would change, and changes only what you tick. A run happens in one
database transaction (all or nothing) and writes an undo file to `typos-cleanup/` in your data
folder. **Tools → Merge Selected Works…** merges duplicate works (see below).

Steps are a list (`Zotero.Cleanup.registerStep`), so more can be added: put the decisions in a pure
module under `chrome/content/zotero/xpcom/cleanup/`, write `scan` and `apply`, register it in
`Zotero.Cleanup.init()`, and add its strings to `zotero.ftl`.

## Step: critical editions imported as Classic Works

**Which items.** A Classic Work item that has *all* of: an author; a title (the work); at least
one editor in Extra; and a container, book or volume title in Extra. Classic Works with an editor
in Extra but missing one of the others are counted and left alone.

**What is read from Extra** (labels are case-insensitive; `Volume Title`, `volume-title` and
`Volume_Title` are the same):

| Extra line | Goes to |
|---|---|
| `collection`, `collection-title`, `series`, `series-title` | Series |
| `container-title`, `book-title` | the set the volume belongs to |
| `volume-title` | the title of the volume (the publication) |
| `Pages` | Pages (makes the item a Book Section) |
| `Editor: Last \|\| First` (one per line) | Editor creators |

Lines that were moved are removed from Extra; every other line is kept. If Extra and the Series
field disagree, the field wins and the Extra line stays, with a warning in the preview.

**What the item becomes.**

- With Pages: a **Book Section**. Title stays the work title; Book Title = the volume title;
  Pages and Series filled in.
- Without Pages: a **Book**. Title = the volume title.
- A volume title that is only a number ("Livre 1", "Vol. 2", "Band 3") is joined to the container
  title: "Le pédagogue, Livre 1".
- Authors stay on the item; editors from Extra are added. Fields the new type can't hold go to
  Extra as `Label: value`, never dropped.

**Records it suggests creating** (a checkbox on each, all ticked by default):

1. **Classic Work** for the ancient work (title, author, and the fields that describe the work
   rather than the edition: Reference System, Corpus ID, Composition Date, Original Language).
   The item gets *Critical edition of* → this work. If a plain Classic Work with the same title
   and author already exists, it is offered instead of a new one.
2. **Volume** (Book Sections only): the Book the section is in, with the editors and series. The
   item gets *Part of* → the volume.
3. **Multi-volume work**: a Book titled with the container title ("Epiphanius", "Le pédagogue"),
   with the series. The volume (or the item itself, for a whole book) gets *Part of* → it.

Items that share a work, volume or set share one record. If you untick a record, the items are
still converted, the data that would have moved to it goes to Extra, and no link is made.

**Siblings.** Nothing extra is stored. Two items related the same way to the same item are
siblings: two critical editions of one work, two volumes of one multi-volume work, two
republications of one work. The Relationships section lists them ("Other critical editions of
…"). They appear as soon as both items are linked, so the step makes them for you.

**Undo.** *Undo this run* (right after, or from *Earlier runs*) puts each converted item back as
it was and deletes the records the run created. Edits made to those items since are replaced.

## Merge Selected Works

Select two or more Classic Work items, then Tools → Merge Selected Works…. Choose the one to keep
and the language of each title. The other titles are kept on the survivor as alternate-language
titles (the `mlz-alternates` line in Extra, the same as the Juris-M import uses), and the others'
relationships, tags, collections, notes and attachments move to it; they go to the trash. It
does not guess which works are the same: you choose.

## Not done

- Duplicate *detection* across languages. A title in Latin and one in English can't be matched
  by text; the merge is manual.
- Alternate-language titles are stored in Extra, not in a field of their own, and are not shown
  in the item pane or used in citations.
- Converting item types uses Zotero's own type change. The in-app tests (`test/tests/cleanupTest.js`)
  cover scanning, converting, linking, siblings, undo and merging, and pass. The two windows have
  not been looked at on screen, and no real library has been cleaned yet. Make a backup first.

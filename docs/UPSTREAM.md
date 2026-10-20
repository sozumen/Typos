# Following upstream Zotero without breaking Typos

Typos is built on Zotero 10.0.7. Zotero keeps changing: bug fixes on the 10.0 line, new releases,
and a next major version in development on `main`. Typos watches those and tells you what
following them would involve. **It never changes your code on its own.** You decide, and anything it
brings in arrives on a separate branch for you to build and look at first.

## The weekly report

The **Upstream watch** workflow runs every Monday (and when you run it by hand under Actions). It
keeps one open GitHub issue (label `upstream-watch`, titled by how serious the news is) up to date. The report covers three
tracks (set in `fork/upstream/config.json`):

| Track | What it is |
| --- | --- |
| `line` | The Zotero 10.0 branch: bug fixes for the version Typos is built on. Usually the easy one. |
| `release` | The newest tagged Zotero release. |
| `main` | Zotero's development branch (the next major version). Read it, don't follow it yet. |

For each track it sorts every changed file into:

- **Already in Typos / nothing to do**
- **Only upstream changed it**: safe to take.
- **Typos changed it too, git can merge them cleanly**: probably fine, still needs a look.
- **Both changed the same lines**: you have to decide by hand.
- **Touches something Typos depends on**: the list in `fork/upstream/touchpoints.json` (the database
  schema, item types, module loading, the Gecko version, the installer, ...). These are flagged even
  when git sees no conflict, because that is where "merges fine but breaks" happens.

Then it tries the merge on a scratch copy, runs the fast tests on it, and gives a verdict:
**none** (nothing new), **low**, **review**, or **hold** (don't take this yet, and why).

## Taking changes

Run **Actions > Upstream apply** and give the track (for example `line`). Choices:

- *safe* (default): only files Typos never changed, plus clean merges.
- *all*: also the conflicted files, written with `<<<<<<<` markers for you to fix.
- *exclude*: paths or patterns to leave out.

It creates a branch `upstream/<track>-<date>` and opens a **draft pull request**. Then:

1. Run **Build Windows installer** on that branch (leave *Publish* off) and try the installer.
2. Look at the checks on the pull request.
3. Merge it, or close it. Nothing is lost either way.

The same thing from a terminal: `node fork/upstream/apply.js --track line --mode safe --dry-run`
(drop `--dry-run` to do it). What you skip is written to `fork/upstream/decisions.json` so the same
question isn't asked every week.

## Honest limits

- Typos has no common git history with Zotero (it was imported as a snapshot), so "how far behind" is
  estimated from commit dates and file contents, not from git ancestry. The comparison is by file
  contents against the recorded base commit (`config.json`), which is reliable; the "N commits behind"
  figure is approximate.
- The merge trial and tests catch what the 306 fast tests cover. They do not run the app. A branch
  that passes can still misbehave in the window, which is why the step before merging is to build and
  open it.
- Gecko upgrades (a new Firefox engine version) are always flagged "hold". They need new prebuilt
  components, the installer re-checked and the launcher re-fetched.
- Database changes cannot be undone on a real library. After taking any, test against a *copy* of a
  library.
- Submodule pointers (the translators, styles, reader, ...) are never changed by the script; update
  those with `git submodule update --remote` when you want newer ones.

# Visual Style Editor and AI style writer

**Tools → Visual Style Editor…** and **Tools → Write a Style with AI…**
(also: Preferences → Cite → *Visual Style Editor…*).

## The editor

A window with three panes:

- **Structure**: the style as a tree of its parts (macros, citation, bibliography, layouts,
  groups, text, names, dates, choose/if/else, sort keys). Select a part, then use the toolbar or the
  keyboard to add, move, duplicate, wrap in a group, unwrap, or delete it. Parts can be dragged.
  The editor will not let you make a change that breaks the style's structure (for example
  putting `else` before `if`, or anything after `substitute`); it tells you why.
- **Details**: a form for the selected part, built from the CSL specification. Text can be a
  variable, a macro, a term or fixed text; formatting (italic, bold, small caps…) is one click; prefix,
  suffix and delimiter show a visible marker for spaces. Renaming a macro updates every place that
  uses it. The *XML* button switches this pane to the raw CSL, which you can edit directly.
- **Preview**: citations and a bibliography from the items selected in your library, using the
  style as you edit it. Choose the locale, first/subsequent/ibid position, a locator, and whether
  to suppress the author.

Every change is checked against the CSL schema; the status bar shows the verdict, and **Show in
structure** selects the part at fault. Undo and redo cover everything.

Editing never changes an installed style in place. Opening one makes a **working copy** with its
own ID and a title ending "(custom)", linked to the original as its template. **Install** adds it
to the application (asking before replacing one with the same ID). **Save as…** writes a `.csl`
file. Styles that only point to a parent style (dependent styles) have no layout of their own;
the editor says so and offers the parent.

**New style…** starts from an author-date, numeric or note template.

## The AI style writer

Give Claude a style manual (PDF, text, Markdown, HTML, or pasted text), example citations, extra
instructions, or any mix. It writes a complete CSL file, the application checks it against the CSL
schema and for macros that are called but not defined, and any problems are sent back to Claude to
fix (up to two rounds). The result opens in the editor as an **unsaved** style with Claude's notes
(assumptions, rules CSL can't express), so you review it and fix whatever's left by hand before
installing. It can also **revise** the style open in the editor.

Tips:

- Examples of every kind of source you cite, with the in-text form next to the bibliography
  form, work best. Mark italics with `*asterisks*`.
- For a long manual, give it only the chapters on citations and bibliographies. Limits: about 24 MB
  or 100 pages of PDF, 400,000 characters of text.
- **Always check the output against your manual.** A style can be valid CSL and still wrong.

### Privacy and cost

- It uses **your own Claude API key** (created at console.anthropic.com). You pay Anthropic directly.
- What is sent to Anthropic: the manual, examples and notes you add (a PDF is sent whole), and, when
  revising, the style being revised. **Nothing from your library is sent.** The dialog says this the
  first time and asks you to acknowledge it.
- The key is stored in the login manager, encrypted with your operating system's key store (like the
  sync key). It is sent only to `api.anthropic.com` and is never written to the debug log. Request
  bodies aren't logged either.
- The model is `claude-sonnet-5-5` by default; change it under *Advanced* in the dialog (preference
  `extensions.zotero.styleAI.model`).

## Code map

| Piece | File |
|---|---|
| CSL grammar data (elements, attributes, variables) | `xpcom/styleEditor/cslSchema.js` |
| Parse, serialize, and every edit operation, with undo | `xpcom/styleEditor/cslTree.js` |
| Starter templates | `xpcom/styleEditor/cslTemplates.js` |
| Working copies of installed styles | `xpcom/styleEditor/styleCopy.js` |
| Preview rendering | `xpcom/styleEditor/stylePreview.js` |
| Opening the editor, installing | `xpcom/styleEditor/visualStyleEditor.js` |
| Editor window | `tools/visualStyleEditor.{html,js}`, `scss/components/_visualStyleEditor.scss` |
| Claude Messages API client | `xpcom/styleAI/claudeClient.js` |
| Prompt, reply parsing, style cleanup | `xpcom/styleAI/styleGenPrompt.js` |
| Write, check, repair loop | `xpcom/styleAI/styleGenerator.js` |
| Key storage, file reading, requests | `xpcom/styleAI/styleAI.js` |
| AI dialog | `tools/styleAI.{html,js}`, `scss/components/_styleAI.scss` |
| Strings | `zotero.ftl` (`visualStyleEditor-*`, `styleAI-*`) |

Tests: `node --test fork/test/*.test.js` (`cslTree`, `cslSchema`, `styleCopy`, `claudeClient`,
`styleGenPrompt`, `styleGenerator`, `styleEditorL10n`).

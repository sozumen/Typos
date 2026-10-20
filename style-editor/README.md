# Visual Style Editor and AI style writer

Adds Tools → Visual Style Editor… and Tools → Write a Style with AI… to Typos. See
`docs/STYLE-EDITOR.md` inside the patch for how it works, what the AI feature sends to Anthropic,
and what has and has not been verified (the windows have not run in a real Typos build).

The change is on top of commit `31fa29f` ("Rename the application to Typos"), the head of
`typos.bundle`. Two equivalent ways to apply it:

```
# 1. From the bundle (keeps the commit)
git clone typos.bundle typos && cd typos
git fetch ../style-editor/style-editor.bundle style-editor:style-editor
git checkout style-editor

# 2. From the patch
git am style-editor/0001-style-editor.patch
```

Check: `node --test fork/test/*.test.js` (236 tests pass).

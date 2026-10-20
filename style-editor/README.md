# Visual Style Editor and AI style writer

Adds Tools → Visual Style Editor… and Tools → Write a Style with AI… to Typos. The patch includes
`docs/STYLE-EDITOR.md`, which explains how it works, what the AI feature sends to Anthropic, and
what has and has not been verified (the windows have not run in a real Typos build).

The change is on top of commit `31fa29f` ("Rename the application to Typos"), the head of
`typos.bundle`. In a Typos working copy at that commit:

```
git checkout -b style-editor
git am path/to/style-editor/0001-style-editor.patch
node --test fork/test/*.test.js     # 236 tests pass
```

`style-editor.bundle` holds the same commit (it needs `31fa29f` to already be in the repository you
fetch it into: `git fetch style-editor.bundle style-editor:style-editor`). Note that
`git clone typos.bundle` does not work directly, because the bundle was made from a shallow copy;
unpack it with `git init && git bundle unbundle typos.bundle`, then mark the shallow boundary.

# Typos on Windows: installing, updating, releasing

## Installing

Run `Typos-<version>_x64_setup.exe` (from the repository's Releases page). It asks one question:

- **Just for me**: installs to `%LOCALAPPDATA%\Typos`. Needs no administrator permission, so it works
  on a locked-down machine.
- **Everyone who uses this computer**: installs to `C:\Program Files\Typos`. Windows asks for
  administrator permission.

Your library and settings are in your own user profile either way, so the choice is only about where
the program files go. You can use a different choice on each machine.

For a script or a silent install:

```
Typos-10.0.7.3_x64_setup.exe /S /CurrentUser
Typos-10.0.7.3_x64_setup.exe /S /AllUsers
```

`/AllUsers` with `/S` and no administrator rights stops with exit code 740 rather than quietly
installing somewhere else. `/D=C:\some\folder` (last on the line) picks the folder.

Typos installs next to Zotero without replacing it (own name, own Start-menu entry, own uninstall
entry, own data folder). Two things are still shared and can collide if both are installed:
the program file is still called `zotero.exe` and the `zotero://` link handler can point at only one
of them. See "Not done" below.

Windows SmartScreen will say the publisher is unknown, because the installer is not code-signed
(signing needs a purchased certificate). Choose **More info, then Run anyway**. Each release has a
`SHA256SUMS` file if you want to check the download.

## Updating

Typos checks GitHub for a newer release about once a day, and any time you choose
**Help > Check for Typos Updates...** (or **Check Now** in Settings > General > Updates). When there
is a newer one it asks first. If you say yes it downloads the installer, checks it against
`SHA256SUMS`, runs it with the same choice (just me / everyone) you installed with, and restarts.
Nothing is downloaded or installed without your yes. The once-a-day check can be switched off in
Settings; "Check Now" always works.

What the check protects against: a damaged or truncated download. What it does not protect against:
someone who gets control of the GitHub repository and uploads a bad installer with a matching
checksum. That would need code signing and a signature check, which is not set up.

**The repository must be public for this to work.** The app asks GitHub for the latest release
without logging in, and a private repository answers "not found". Either make `sozumen/typos`
public, or keep the code private and publish only the installers to a second public repository
(then change the default for the preference `extensions.zotero.typosUpdate.repo` in
`defaults/preferences/zotero.js` to that repository).

## Making a release ("updating from here")

Version numbers are `10.0.7.N`: the first three numbers are the Zotero release Typos is based on, and
`N` counts Typos releases (10.0.7.1, 10.0.7.2, ...).

1. Merge the changes you want into `main`.
2. Either push a tag, `git tag v10.0.7.3 && git push origin v10.0.7.3`, or open
   **Actions > Build Windows installer > Run workflow**, type the release number, and tick
   *Publish*. Leave *Publish* off for a test build you only download from the run.
3. The workflow runs the fast tests, builds the app, builds the installer, installs it on the Windows
   runner, starts the app, checks that it answers on its local port, and uninstalls it. Only if all
   of that passes does it publish the release (installer plus `SHA256SUMS`).
4. Everyone running Typos is offered the update the next time their copy checks.

The workflow can also build `arm64` and `win32` installers: in the run form set *archs* to
`["x64","arm64"]`. Those two are built but not test-installed (the runners are x64).

### What the build does, and where it can break

`app/build.sh` is Zotero's own Windows build with these changes: the installer scripts are renamed
and have the install-scope choice; `app/win/rebrand_exe` gives `zotero.exe`, `updater.exe` and the
installer stub the Typos icon and version strings; `app/scripts/prepare_build --revision N` makes the
four-part version. Two inputs are downloaded rather than stored in this repository:

- Zotero's prebuilt launcher and updater (`app/win/zotero.exe.tar.xz`, `updater.exe.tar.xz`) come
  from Zotero's public Git LFS store (`app/scripts/fetch_lfs_upstream`, listed with checksums in
  `app/lfs-files.json`). They are not kept in this repository because GitHub refuses Git LFS pointers
  whose files aren't stored with it.
- Firefox/Gecko 140 and Zotero's custom Gecko components come from Mozilla's and Zotero's download
  servers, as in Zotero's own build, with checksums.

If a build fails, the first places to look are the "Download build tools", "Install NSIS plug-ins" and
"Build" steps in the run log. Failures there are usually a download URL that moved.

## Not done

- **No code signing** (SmartScreen warning; the update check is integrity-only, see above).
- **Still named `zotero.exe`.** The launcher is a prebuilt program from Zotero. Renaming it means
  checking everything that looks for that name (the Word plug-in, the updater, window class,
  the NSIS uninstall logic). Until then, don't run Typos and Zotero at the same moment, and expect
  `zotero://` links to go to whichever was installed or started last.
- **No Mac installer.** The icon source for a `.icns` file isn't built, and nothing here was run on a Mac.
- Update prompts and installer text are English only.
- Per-machine installs updated by a user without administrator rights will ask Windows for
  permission each time (that is Windows, not Typos).

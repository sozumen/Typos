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
entry, own data folder, and the program is `typos.exe`, so the two don't share a file name or a
Windows "App Paths" entry). Some things are still shared and can collide if both are installed and
running; see "Running next to Zotero" below.

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

**Where installers are published.** From 10.0.7.4, installers go to a separate public
repository, `sozumen/typos-releases`, which holds nothing but releases; the code repository
(`sozumen/typos`) can then be private. The app asks that repository for the latest release without
logging in (preference `extensions.zotero.typosUpdate.repo`). Releases up to 10.0.7.3 were published
in the code repository, and copies of those look there; 10.0.7.4 was published in both places so
they find it, and after that they look in the releases repository.

Only installers are published, not source code. Typos is built from Zotero, which is under the
AGPL, so anyone who receives an installer can ask for the source of that version; answering such
requests is up to you.

### One-time setup for the releases repository

1. Create the public repository `sozumen/typos-releases` on GitHub, with a README (a release needs
   at least one commit to point at).
2. Create a fine-grained personal access token (GitHub > Settings > Developer settings > Personal
   access tokens > Fine-grained tokens) with access to **only** `sozumen/typos-releases` and the
   permission **Contents: Read and write**. Choose an expiry date and note it.
3. In `sozumen/typos`, add it under Settings > Secrets and variables > Actions as a repository
   secret named `RELEASES_TOKEN`.

When the token expires, publishing fails with "RELEASES_TOKEN can't publish"; make a new one and
replace the secret. Builds that don't publish don't need it.

## Making a release ("updating from here")

Version numbers are `10.0.7.N`: the first three numbers are the Zotero release Typos is based on, and
`N` counts Typos releases (10.0.7.1, 10.0.7.2, ...).

1. Merge the changes you want into `main`.
2. Either push a tag, `git tag v10.0.7.3 && git push origin v10.0.7.3`, or open
   **Actions > Build Windows installer > Run workflow**, type the release number, and tick
   *Publish*. Leave *Publish* off for a test build you only download from the run.
3. The workflow runs the fast tests, builds the app, builds the installer, installs it on the Windows
   runner, starts the app, checks that it answers on its local port, and uninstalls it. Only if all
   of that passes does it publish the release (installer plus `SHA256SUMS`) in
   `sozumen/typos-releases`. The run stops at the start if `RELEASES_TOKEN` is missing or can't
   write there. *Also publish in this repository* is only for moving old copies over (10.0.7.4).
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

## Running next to Zotero

You can have both installed. Running both at the same moment is not fully supported:

- **The local port.** Typos listens on port 23119, like Zotero, because the browser connector, the
  Word and LibreOffice plug-ins and local-API tools look there. If another program already has it, Typos
  takes the next free port (23120 to 23129) instead of running with no server, and Settings > Advanced
  says which port it got. Anything that looks only on 23119 (the browser connector, the plug-ins) will
  then reach the other program, not Typos.
- **The `zotero://` link handler** can point at only one program.
- **Word integration** has one "Zotero" add-in, shared by whatever is installed. It has not been tried with Typos.
- The window class Gecko uses to find a running copy is compiled into the prebuilt program, so it is
  still called `ZoteroMessageWindow` for both.

Upgrading from 10.0.7.1 or earlier: those releases installed the program as `zotero.exe`. The newer
installer removes that file and its "App Paths" entry (only if they belong to the Typos install being
upgraded) and creates `typos.exe`. A taskbar pin made from the old shortcut will need to be re-pinned.

## Not done

- **No code signing** (SmartScreen warning; the update check is integrity-only, see above).
- **No Mac installer.** The icon source for a `.icns` file isn't built, and nothing here was run on a Mac.
- Update prompts and installer text are English only.
- Per-machine installs updated by a user without administrator rights will ask Windows for
  permission each time (that is Windows, not Typos).

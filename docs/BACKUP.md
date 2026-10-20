# Backup

Preferences → Advanced → Backup.

The backup feature keeps a second copy of your library at a destination you choose: a **folder**
(an external drive, a NAS mount, or a folder that Dropbox / iCloud / OneDrive already syncs) or
**Google Drive**. Your library itself is always stored locally in the data directory.

It is a backup, not sync. It only ever writes to the destination; it never merges anything back.
Restoring is a separate, explicit action that writes into a **new empty folder** and leaves your
current library untouched.

## What gets backed up

| Part | How | Retention |
|---|---|---|
| Database (`zotero.sqlite`), abbreviation lists, `snapshot.json` | One ZIP "snapshot" per backup, taken with SQLite's online backup so it is consistent while the app is running | Newest *N* kept (default 10, minimum 1) |
| Attachment files (`storage/`) | Uploaded incrementally; only new or changed files are sent | Never deleted from the backup, even if deleted locally |

Not backed up: the `translators/` and `styles/` folders (re-downloadable), full-text caches
(regenerated), and preferences/profile settings (the backup covers library data, not app config).

Files deleted from your library stay in the backup on purpose. A backup that mirrors deletions
doesn't protect against deleting something by mistake.

### Folder layout at the destination

```
<chosen folder>/Typos Backup/
    snapshots/library-YYYYMMDD-HHMMSS.zip     (UTC timestamps)
    files/<ITEMKEY>/<attachment file>
```

Google Drive uses the same layout under a folder named "Typos Backup".

## Schedule

*Daily*, *Weekly* or *Only when I choose*. Scheduled backups run in the background while the app
is open (checked every 30 minutes, first check two minutes after startup). If the app wasn't
open at the scheduled time, the backup runs the next time it is. "Back Up Now" always works.

## Setting up Google Drive

The app doesn't ship with Google credentials. You create your own, which means no third party
ever holds your Drive access and there is no shared quota. This takes about five minutes, once.

1. Go to <https://console.cloud.google.com/> and create a project (any name).
2. **APIs & Services → Library →** search "Google Drive API" → **Enable**.
3. **APIs & Services → OAuth consent screen** (may be called "Google Auth Platform"):
   - User type **External**; fill in an app name and your email.
   - Under *Audience*, either add your own Google account as a **Test user**, or publish the app
     ("In production"). Apps left in *Testing* work, but **Google expires their refresh tokens
     after 7 days**, which means signing in again weekly. Publishing a personal app that only you
     use doesn't require verification when it only requests the `drive.file` scope; Google shows
     an "unverified app" screen at sign-in that you can click through.
   - Scope: add `https://www.googleapis.com/auth/drive.file` (non-sensitive).
4. **APIs & Services → Credentials → Create credentials → OAuth client ID**, application type
   **Desktop app**. Copy the **Client ID** and **Client secret**.
5. In the app: Backup → **Google Drive**, paste both values, click **Sign In to Google…**.
   Your browser opens; approve access. The page redirects to `http://127.0.0.1:23119/…` (the app's
   local server, so the app must be running and its local server port must be the default 23119)
   and shows "Signed in".

The client secret and the refresh token are kept in the system login manager, encrypted with the
OS key store when available. The client ID is stored in preferences.

### Scope and privacy

The app requests only `drive.file`, which lets it see **only files it created**. It can't read
anything else in your Drive. A consequence: the app can't see a backup folder made by a different
Google Cloud project, so to restore on a new computer, sign in using the **same client ID**.

To revoke access: <https://myaccount.google.com/permissions>. "Sign Out" in the app only forgets
the token locally.

## Restoring

Backup → **Restore…** → choose a snapshot → choose a new or empty folder. The snapshot is
unpacked there, and all backed-up attachment files are downloaded into `storage/`. Then the app
offers to switch to the restored folder as the data directory (requires restart). You can decline
and inspect it first; switch later under Advanced → Data Directory Location.

After switching, the first backup has no record of what was uploaded before, so it compares
against what is already at the destination: files that are already there with the same size are
recognised and not re-sent, and changed ones update the existing copy instead of creating a
duplicate. (A file edited without changing its size would be missed by that first comparison; it
is picked up on its next change.)

## Limitations

- Large attachment libraries on Google Drive are slow on the first run (it is a sequence of
  upload requests, one file at a time). Subsequent runs only send changes.
- Single files are uploaded in 8 MB chunks and retried on transient errors; a file that keeps
  failing is reported and skipped, and the rest of the backup continues.
- Backup runs one at a time. There is no bandwidth limit.
- Only the personal library is backed up; there is no group-library or feed handling.
- The Google client secret for a "Desktop app" client isn't truly secret (Google documents
  this); it is stored encrypted anyway.

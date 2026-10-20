preferences-window =
    .title = { -app-name } Settings

preferences-appearance-title = Appearance and Language

preferences-auto-recognize-files =
    .label = Automatically retrieve metadata for PDFs and ebooks

preferences-typos-updates-header = Updates
preferences-typos-updates-auto =
    .label = Check for new versions of Typos once a day
preferences-typos-updates-note = Typos only looks. It asks before it downloads or installs anything.
preferences-typos-updates-check-now =
    .label = Check Now

preferences-file-renaming-title = File Renaming
preferences-file-renaming-intro =
    { -app-name } can automatically rename files based on the details of the parent item (title, author, etc.) and keep the filenames in sync as you make changes. Downloaded files are always initially named based on the parent item.
preferences-file-renaming-configure-button =
    .label = Configure File Renaming…

preferences-attachment-titles-title = Attachment Titles
preferences-attachment-titles-intro = Attachment titles are <label data-l10n-name="wiki-link">different from filenames</label>. To support some workflows, { -app-name } can show filenames instead of attachment titles in the items list.
preferences-attachment-titles-show-filenames =
    .label = Show attachment filenames in the items list

preferences-reader-title = Reader
preferences-reader-open-epubs-using = Open EPUBs using
preferences-reader-open-snapshots-using = Open snapshots using
preferences-reader-open-in-new-window =
    .label = Open files in new windows instead of tabs
preferences-reader-auto-disable-tool =
    .label = Turn off note, text, and image annotation tools after each use
preferences-reader-ebook-font = Ebook font:
preferences-reader-ebook-hyphenate =
    .label = Enable automatic hyphenation

preferences-read-aloud-title = Read Aloud
preferences-read-aloud-highlight-granularity = Highlight current
preferences-read-aloud-highlight-granularity-paragraph =
    .label = paragraph
preferences-read-aloud-highlight-granularity-sentence =
    .label = sentence
preferences-read-aloud-highlight-granularity-word =
    .label = word

preferences-note-title = Notes
preferences-note-open-in-new-window =
    .label = Open notes in new windows instead of tabs

preferences-color-scheme = Color Scheme:
preferences-color-scheme-auto =
    .label = Automatic
preferences-color-scheme-light =
    .label = Light
preferences-color-scheme-dark =
    .label = Dark

preferences-item-pane-header = Item Pane Header:
preferences-item-pane-header-style = Header Citation Style:
preferences-item-pane-header-locale = Header Language:
preferences-item-pane-header-missing-style = Missing style: <{ $shortName }>

preferences-locate-library-lookup-intro = Library Lookup can find a resource online using your library’s OpenURL resolver.
preferences-locate-resolver = Resolver:
preferences-locate-base-url = Base URL:

preferences-quickCopy-minus =
    .aria-label = { general-remove }
    .label = { $label }
preferences-quickCopy-plus =
    .aria-label = { general-add }
    .label = { $label }

preferences-styleManager-intro = { -app-name } can generate citations and bibliographies in over 10,000 citation styles. Add styles here to make them available when selecting styles throughout { -app-name }.
preferences-styleManager-get-additional-styles =
    .label = Get Additional Styles…
preferences-styleManager-restore-default =
    .label = Restore Default Styles…
preferences-styleManager-add-from-file =
    .tooltiptext = Add a style from a file
    .label = Add from File…
preferences-styleManager-remove = Press { delete-or-backspace } to remove this style.
preferences-citation-dialog = Citation Dialog
preferences-citation-dialog-mode = Citation Dialog Mode:
preferences-citation-dialog-mode-last-used =
    .label = Last Used
preferences-citation-dialog-mode-list =
    .label = List Mode
preferences-citation-dialog-mode-library =
    .label = Library Mode

preferences-advanced-enable-local-api =
    .label = Allow other applications on this computer to communicate with { -app-name }
preferences-advanced-local-api-available = Available at <code data-l10n-name="url">{ $url }</span>
preferences-advanced-local-api-clear-authorizations =
    .label = Clear Write Authorizations
preferences-advanced-server-disabled = The { -app-name } HTTP server is disabled.
preferences-advanced-server-enable-and-restart =
    .label = Enable and Restart
preferences-advanced-language-and-region-title = Language and Region
preferences-advanced-enable-bidi-ui =
    .label = Enable bidirectional text editing utilities
preferences-advanced-data-dir =
    .value = Data Directory:
preferences-advanced-reset-data-dir =
    .label = Revert to Default Location…
preferences-advanced-custom-data-dir =
    .label = Use Custom Location…
preferences-advanced-default-data-dir =
    .value = (Default: { $directory })
    .aria-label = Default location

preferences-pane-account = Account

-preferences-sync-data-syncing = Data Syncing
preferences-sync-data-syncing-groupbox =
    .aria-label = { -preferences-sync-data-syncing }
preferences-sync-data-syncing-heading = { -preferences-sync-data-syncing }
preferences-sync-data-syncing-description = Log in with your { -app-name } account to sync your data between devices, collaborate with others, and more.
preferences-sync-settings-heading = Sync
preferences-sync-settings-intro = { -app-name } can sync your library data and files across devices. <label data-l10n-name="sync-link">Learn more</label>
preferences-sync-reset-heading = Sync Reset
preferences-sync-fileSyncing-groups =
    .label = Sync attachment files in group libraries using { -app-name } Storage
preferences-sync-fileSyncing-tos = By using { -app-name } Storage, you agree to become bound by its <label data-l10n-name="terms-link">terms and conditions</label>.
preferences-account-log-out =
    .label = Log Out…

preferences-sync-reset-restore-to-server-body = { -app-name } will replace “{ $libraryName }” on { $domain } with data from this computer.
preferences-sync-reset-restore-to-server-deleted-items-text = { $remoteItemsDeletedCount } { $remoteItemsDeletedCount ->
        [one] item
        *[other] items
    } in the online library will be permanently deleted.
preferences-sync-reset-restore-to-server-remaining-items-text = { general-sentence-separator }{ $localItemsCount ->
        [0] The library on this computer and the online library will be empty.
        [one] 1 item will remain on this computer and in the online library.
        *[other] { $localItemsCount } items will remain on this computer and in the online library.
    }
preferences-sync-reset-restore-to-server-checkbox-label = { $remoteItemsDeletedCount ->
        [one] Delete 1 item
        *[other] Delete { $remoteItemsDeletedCount } items
    }
preferences-sync-reset-restore-to-server-confirmation-text = delete online library
preferences-sync-reset-restore-to-server-yes = Replace Data in Online Library

preferences-account-log-in =
    .label = Log In
preferences-account-waiting-for-login =
    .value = Waiting for login…
preferences-account-cancel-button =
    .label = { general-cancel }

preferences-account-logged-out-status =
    .value = (logged out)

preferences-account-email-label =
    .value = Email:

preferences-account-switch-accounts =
    .label = Switch Accounts…
preferences-account-switch-text =
    Switching to a different account will remove all { -app-name } data on this computer. Before continuing, make sure all data and files you wish to keep have been synced with the “{ $username }” account or you have a backup of your { -app-name } data directory.
preferences-account-switch-confirmation-text = remove local data
preferences-account-switch-accept = Remove Data and Restart

fulltext-index-status-indexing = Indexing { $indexed } of { $total }…
fulltext-index-status-complete = Search index is up to date
fulltext-stats-attachments-indexed = Attachments indexed:
fulltext-stats-partially-indexed = Partially indexed:
fulltext-stats-not-available = Full-text content or file not available:
fulltext-stats-notes-indexed = Notes indexed:

## Classical abbreviations

preferences-classical-abbreviations = Abbreviations
preferences-classical-abbreviations-intro = Import lists of abbreviations for classical works and authors, journals, series, publishers and places. Choose which lists to use and how they appear in citations and bibliographies, with different choices for different citation styles or Word / LibreOffice documents.
preferences-classical-abbreviations-mode = Output:
preferences-classical-abbreviations-mode-off =
    .label = Full titles and names
preferences-classical-abbreviations-mode-abbreviated =
    .label = Abbreviated titles and names
preferences-classical-abbreviations-mode-short-title =
    .label = Full, with abbreviation as short title
preferences-classical-abbreviations-scope = Apply to:
preferences-classical-abbreviations-scope-classic =
    .label = Classic Work items only
preferences-classical-abbreviations-scope-all =
    .label = All items
preferences-classical-abbreviations-works =
    .label = Classical work titles
preferences-classical-abbreviations-authors =
    .label = Author names
preferences-classical-abbreviations-none = No abbreviation lists imported.
preferences-classical-abbreviations-import =
    .label = Import List…
preferences-classical-abbreviations-import-title = Import Abbreviation List
preferences-classical-abbreviations-import-failed = Import Failed
preferences-classical-abbreviations-remove =
    .label = Remove
preferences-classical-abbreviations-remove-confirm = Remove the list “{ $name }”?

## Backup

preferences-backup = Backup
preferences-backup-intro = Keep a second copy of your library in a folder or on Google Drive. This is a backup, not sync: changes are only ever copied to the backup, never back from it.
preferences-backup-destination = Back up to:
preferences-backup-destination-none =
    .label = Nowhere
preferences-backup-destination-folder =
    .label = A folder
preferences-backup-destination-gdrive =
    .label = Google Drive
preferences-backup-choose-folder =
    .label = Choose Folder…
preferences-backup-choose-folder-title = Choose Backup Folder
preferences-backup-google-intro = Google Drive access uses your own Google Cloud OAuth client, so no one else holds your credentials. Backups can only see files this app created. See docs/BACKUP.md for setup.
preferences-backup-google-client-id = Client ID:
preferences-backup-google-client-secret = Client secret:
preferences-backup-google-signin =
    .label = Sign In to Google…
preferences-backup-google-signout =
    .label = Sign Out
preferences-backup-google-signed-in = Signed in
preferences-backup-google-signed-out = Not signed in
preferences-backup-google-error = Google Sign-In Failed
preferences-backup-frequency = Back up:
preferences-backup-frequency-manual =
    .label = Only when I choose
preferences-backup-frequency-daily =
    .label = Daily
preferences-backup-frequency-weekly =
    .label = Weekly
preferences-backup-keep = Database snapshots to keep:
preferences-backup-include-files =
    .label = Also back up attachment files
preferences-backup-now =
    .label = Back Up Now
preferences-backup-cancel =
    .label = Cancel
preferences-backup-restore =
    .label = Restore…
preferences-backup-running = Backing up…
preferences-backup-progress = { $phase }: { $done } of { $total }
preferences-backup-never = No backup has been made yet.
preferences-backup-last-ok = Last backup: { $time }. { $uploaded } file(s) uploaded.
preferences-backup-last-problem = Last backup: { $time }. Problem: { $message }
preferences-backup-failed-title = Backup Failed
preferences-backup-restore-title = Restore From Backup
preferences-backup-restore-choose = Choose the snapshot to restore. Your current library won’t be changed: it is restored into a new folder.
preferences-backup-restore-none = No snapshots were found at the backup destination.
preferences-backup-restore-folder-title = Choose an Empty Folder to Restore Into
preferences-backup-restore-done = Restored the library and { $files } attachment file(s) to { $path }.
preferences-backup-restore-partial = { $failed } file(s) couldn’t be restored.
preferences-backup-restore-use = Use the restored library as your data directory? The app will need to restart.
preferences-backup-restore-failed = Restore Failed

## Abbreviations: lists, general settings, profiles, per-style choices

preferences-abbreviations-lists-heading = Lists
preferences-abbreviations-lists-description = Imported lists are searched in the order they are checked. A journal, series or work an item says is abbreviated in its own Journal Abbr field is not looked up in these lists unless you turn that off below.
preferences-abbreviations-general-heading = General settings
preferences-abbreviations-general-description = Used for every citation style and document that doesn’t have its own choice.
preferences-abbreviations-types = Abbreviate:
preferences-abbreviations-journals =
    .label = Journals and other containers
preferences-abbreviations-series =
    .label = Series
preferences-abbreviations-publishers =
    .label = Publishers
preferences-abbreviations-places =
    .label = Places of publication
preferences-abbreviations-prefer-item =
    .label = Use an item’s own Journal Abbr instead of a list
preferences-abbreviations-profiles-heading = Profiles
preferences-abbreviations-profiles-description = A profile is a saved combination of lists and settings, for example “Journals abbreviated, classics in full”. Choose one for a citation style below, or for a document in its document preferences.
preferences-abbreviations-profiles-none = No profiles yet.
preferences-abbreviations-profile-new =
    .label = New Profile…
preferences-abbreviations-profile-edit =
    .label = Edit…
preferences-abbreviations-profile-remove-confirm = Remove the profile “{ $name }”? Styles that used it will go back to the general settings.
preferences-abbreviations-profile-summary = { $mode }, { $count ->
        [one] 1 list
       *[other] { $count } lists
    }
preferences-abbreviations-mode-name-off = No abbreviations
preferences-abbreviations-mode-name-abbreviated = Abbreviated
preferences-abbreviations-mode-name-short-title = Short forms only
preferences-abbreviations-styles-heading = Citation styles
preferences-abbreviations-styles-description = Give a citation style its own profile. A document can still choose a different one.
preferences-abbreviations-styles-none = No styles have their own profile.
preferences-abbreviations-styles-add = Choose a style…
preferences-abbreviations-choice-default = General settings
preferences-abbreviations-choice-off = No abbreviations

## Abbreviation profile editor

preferences-abbreviations-profile-editor-window =
    .title = Abbreviation Profile
preferences-abbreviations-profile-name = Name:
preferences-abbreviations-type-work = Classical work titles
preferences-abbreviations-type-author = Author names
preferences-abbreviations-type-journal = Journals and other containers
preferences-abbreviations-type-series = Series
preferences-abbreviations-type-publisher = Publishers
preferences-abbreviations-type-place = Places of publication
preferences-abbreviations-prefer-item-text = Use an item’s own Journal Abbr instead of a list
preferences-abbreviations-profile-lists = Lists, in order of priority:
preferences-abbreviations-profile-lists-description = Check the lists this profile uses. When two lists abbreviate the same title, the one higher up wins.

preferences-visual-style-editor =
    .label = Visual Style Editor…

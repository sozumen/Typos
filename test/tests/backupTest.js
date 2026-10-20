"use strict";

describe("Zotero.Backup", function () {
	var destDir, restoreDir, storageDir, attachment;

	before(async function () {
		destDir = await getTempDirectory();
		restoreDir = PathUtils.join(await getTempDirectory(), 'restored');
	});

	beforeEach(function () {
		Zotero.Prefs.set('cloudBackup.destination', 'folder');
		Zotero.Prefs.set('cloudBackup.folder', destDir);
		Zotero.Prefs.set('cloudBackup.includeFiles', true);
		Zotero.Prefs.set('cloudBackup.keepSnapshots', 3);
	});

	after(async function () {
		for (let pref of ['destination', 'folder', 'includeFiles', 'keepSnapshots', 'lastRun', 'lastStatus']) {
			Zotero.Prefs.clear('cloudBackup.' + pref);
		}
		if (attachment) await attachment.eraseTx();
	});

	it("should back up a snapshot and attachment files to a folder", async function () {
		let item = await createDataObject('item');
		attachment = await importFileAttachment('test.pdf', { parentItemID: item.id });

		let report = await Zotero.Backup.run();

		assert.ok(report.snapshot);
		assert.isAtLeast(report.files.uploaded, 1);
		assert.isEmpty(report.files.failed);

		let snapshotPath = PathUtils.join(destDir, 'Typos Backup', 'snapshots', report.snapshot.name);
		assert.isTrue(await IOUtils.exists(snapshotPath));

		let stored = PathUtils.join(
			destDir, 'Typos Backup', 'files', attachment.key, 'test.pdf'
		);
		assert.isTrue(await IOUtils.exists(stored));

		let status = Zotero.Backup.getLastStatus();
		assert.isTrue(status.ok);
	});

	it("should not re-upload unchanged files", async function () {
		let report = await Zotero.Backup.run();
		assert.equal(report.files.uploaded, 0);
		assert.isAbove(report.files.unchanged, 0);
	});

	it("should contain the database and settings in a snapshot", async function () {
		let snapshots = await Zotero.Backup.listSnapshots();
		assert.isAtLeast(snapshots.length, 1);

		let zipPath = PathUtils.join(await getTempDirectory(), 'snap.zip');
		let { backend } = await Zotero.Backup._createBackend();
		await backend.downloadSnapshot(snapshots[0].id, zipPath);

		let reader = Cc["@mozilla.org/libjar/zip-reader;1"].createInstance(Ci.nsIZipReader);
		reader.open(Zotero.File.pathToFile(zipPath));
		try {
			assert.isTrue(reader.hasEntry('zotero.sqlite'));
			assert.isTrue(reader.hasEntry('snapshot.json'));
		}
		finally {
			reader.close();
		}
	});

	it("should prune old snapshots", async function () {
		for (let i = 0; i < 4; i++) {
			// Snapshot names have one-second resolution
			await Zotero.Promise.delay(1100);
			await Zotero.Backup.run();
		}
		assert.isAtMost((await Zotero.Backup.listSnapshots()).length, 3);
	});

	it("should restore into a new folder without touching the current library", async function () {
		let snapshots = await Zotero.Backup.listSnapshots();
		let result = await Zotero.Backup.restore({
			snapshotId: snapshots[0].id,
			targetDir: restoreDir
		});
		assert.isEmpty(result.failed);
		assert.isTrue(await IOUtils.exists(PathUtils.join(restoreDir, 'zotero.sqlite')));
		assert.isTrue(await IOUtils.exists(
			PathUtils.join(restoreDir, 'storage', attachment.key, 'test.pdf')
		));
		assert.equal(Zotero.DataDirectory.dir === restoreDir, false);
	});

	it("should refuse to restore into a non-empty folder", async function () {
		let snapshots = await Zotero.Backup.listSnapshots();
		let e = await getPromiseError(Zotero.Backup.restore({
			snapshotId: snapshots[0].id,
			targetDir: restoreDir
		}));
		assert.ok(e);
		assert.include(e.message, 'empty');
	});

	it("should fail clearly when the backup folder is missing", async function () {
		Zotero.Prefs.set('cloudBackup.folder', PathUtils.join(destDir, 'nope'));
		let e = await getPromiseError(Zotero.Backup.run());
		assert.ok(e);
		assert.include(e.message, 'not found');
		assert.isFalse(Zotero.Backup.getLastStatus().ok);
	});
});

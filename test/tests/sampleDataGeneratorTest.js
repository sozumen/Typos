"use strict";

// Rewrites the generated sample data files in test/tests/data/ (itemJSON.js, translatorExport.js
// and translatorExportLegacy.js) from the running application. It does nothing unless the
// environment variable TYPOS_SAMPLE_DATA_DIR names the folder to write to; the app-tests
// workflow sets it when asked to regenerate. Run it when item types or fields change (for
// example, after adding a type to the schema overlay), then commit the files.
describe("Sample data generator", function () {
	let dir = Services.env.exists('TYPOS_SAMPLE_DATA_DIR')
		? Services.env.get('TYPOS_SAMPLE_DATA_DIR')
		: null;
	
	async function write(name, data) {
		let path = PathUtils.join(dir, name + '.js');
		await IOUtils.writeUTF8(path, stableStringify(data));
	}
	
	it("should write the generated sample data files", async function () {
		if (!dir) {
			this.skip();
		}
		this.timeout(60000);
		await write('itemJSON', await generateItemJSONData({}, loadSampleData('itemJSON')));
		await write(
			'translatorExportLegacy',
			await generateTranslatorExportData(true, loadSampleData('translatorExportLegacy'))
		);
		await write(
			'translatorExport',
			await generateTranslatorExportData(false, loadSampleData('translatorExport'))
		);
	});
});

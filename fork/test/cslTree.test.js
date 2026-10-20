'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Tree = require('../../chrome/content/zotero/xpcom/styleEditor/cslTree.js');
const Templates = require('../../chrome/content/zotero/xpcom/styleEditor/cslTemplates.js');
const { StyleDoc, CSLParseError, CSLEditError } = Tree;

const SMALL = `<?xml version="1.0" encoding="utf-8"?>
<!-- a comment before the root is dropped -->
<style xmlns="http://purl.org/net/xbiblio/csl" class="in-text" version="1.0">
  <info>
    <title>Small &amp; simple</title>
    <id>http://example.org/small</id>
    <updated>2026-01-01T00:00:00Z</updated>
  </info>
  <locale xml:lang="en">
    <terms>
      <term name="page"><single>page</single><multiple>pages</multiple></term>
    </terms>
  </locale>
  <macro name="author">
    <names variable="author">
      <name and="text" delimiter=", "/>
    </names>
  </macro>
  <macro name="year">
    <date variable="issued"><date-part name="year"/></date>
  </macro>
  <citation>
    <layout prefix="(" suffix=")" delimiter="; ">
      <!-- inside a layout -->
      <group delimiter=", ">
        <text macro="author"/>
        <text macro="year"/>
      </group>
    </layout>
  </citation>
  <bibliography>
    <sort><key macro="author"/></sort>
    <layout>
      <text macro="author"/>
      <choose>
        <if type="book"><text variable="title" font-style="italic"/></if>
        <else-if variable="container-title"><text variable="title" quotes="true"/></else-if>
        <else><text value="untitled"/></else>
      </choose>
    </layout>
  </bibliography>
</style>
`;

function doc() {
	return StyleDoc.fromXML(SMALL);
}

function first(d, name) {
	return d.findAll(name)[0];
}


//
// Reading and writing
//

test('parse reads elements, attributes, entities and text', () => {
	let d = doc();
	assert.equal(d.root.name, 'style');
	assert.equal(d.getAttr(d.root.id, 'class'), 'in-text');
	assert.equal(d.getInfo('title'), 'Small & simple');
	assert.equal(first(d, 'single').text, 'page');
});

test('whitespace that only lays out the file is not kept as content', () => {
	let d = doc();
	assert.equal(first(d, 'info').text, null);
	assert.ok(first(d, 'info').children.every(c => c.type === 'element'));
});

test('serialize then parse gives the same tree', () => {
	let d = doc();
	let again = StyleDoc.fromXML(d.toXML());
	assert.equal(again.toXML(), d.toXML());
	assert.equal(again.findAll('text').length, d.findAll('text').length);
});

test('serialize escapes special characters in text and attributes', () => {
	let d = doc();
	let t = d.findAll('text').find(n => n.attrs.some(a => a.name === 'value'));
	d.setAttr(t.id, 'value', 'a < b & "c"');
	d.setInfo('summary', 'x < y & z');
	let xml = d.toXML();
	assert.match(xml, /value="a &lt; b &amp; &quot;c&quot;"/);
	assert.match(xml, /<summary>x &lt; y &amp; z<\/summary>/);
	let back = StyleDoc.fromXML(xml);
	assert.equal(back.getAttr(back.findAll('text').find(n => n.attrs.some(a => a.name === 'value')).id, 'value'), 'a < b & "c"');
	assert.equal(back.getInfo('summary'), 'x < y & z');
});

test('comments inside the style are kept', () => {
	let d = doc();
	assert.match(d.toXML(), /<!-- inside a layout -->/);
});

test('a lone space in an attribute survives a round trip', () => {
	let d = doc();
	let grp = first(d, 'group');
	d.setAttr(grp.id, 'suffix', ' ');
	let back = StyleDoc.fromXML(d.toXML());
	assert.equal(back.getAttr(first(back, 'group').id, 'suffix'), ' ');
});

test('parse errors name the problem and the position', () => {
	assert.throws(() => StyleDoc.fromXML(''), CSLParseError);
	assert.throws(() => StyleDoc.fromXML('<style><info></style>'), /does not match/);
	assert.throws(() => StyleDoc.fromXML('<style a="1" a="2"/>'), /appears twice/);
	assert.throws(() => StyleDoc.fromXML('<style a=1/>'), /in quotes/);
	assert.throws(() => StyleDoc.fromXML('<style>&bogus;</style>'), /Unknown entity/);
	assert.throws(() => StyleDoc.fromXML('<style>a & b</style>'), /bare "&"/);
	assert.throws(() => StyleDoc.fromXML('<style/><style/>'), /after the closing tag/);
	try {
		StyleDoc.fromXML('<style>\n<info>\n</style>');
		assert.fail('should have thrown');
	}
	catch (e) {
		assert.equal(e.name, 'CSLParseError');
		assert.equal(e.line, 3);
	}
});

test('numeric character references and CDATA are read', () => {
	let d = StyleDoc.fromXML('<style><info><title>caf&#233; &#x2014; <![CDATA[<raw>]]></title></info></style>');
	assert.equal(d.getInfo('title'), 'café — <raw>');
});

test('every template parses and round-trips', () => {
	for (let kind of Object.keys(Templates.KINDS)) {
		let xml = Templates.newStyleXML(kind, { title: 'T', updated: '2026-01-01T00:00:00Z' });
		let d = StyleDoc.fromXML(xml);
		assert.equal(StyleDoc.fromXML(d.toXML()).toXML(), d.toXML(), kind);
		assert.equal(d.undefinedMacros().length, 0, `${kind} calls a macro it does not define`);
		assert.equal(d.unusedMacros().length, 0, `${kind} defines a macro it never uses`);
	}
});


//
// Attributes
//

test('setAttr adds, changes and removes', () => {
	let d = doc();
	let g = first(d, 'group');
	assert.equal(d.setAttr(g.id, 'prefix', '['), true);
	assert.equal(d.getAttr(g.id, 'prefix'), '[');
	assert.equal(d.setAttr(g.id, 'prefix', '('), true);
	assert.equal(d.getAttr(g.id, 'prefix'), '(');
	assert.equal(d.setAttr(g.id, 'prefix', ''), true);
	assert.equal(d.getAttr(g.id, 'prefix'), null);
});

test('setting an attribute to its current value is not an edit', () => {
	let d = doc();
	let g = first(d, 'group');
	assert.equal(d.setAttr(g.id, 'delimiter', ', '), false);
	assert.equal(d.canUndo(), false);
	assert.equal(d.setAttr(g.id, 'prefix', ''), false);
});

test('checkAttr warns about odd values but does not block them', () => {
	let d = doc();
	let t = d.findAll('text').find(n => n.attrs.some(a => a.name === 'variable'));
	assert.equal(d.checkAttr(t.id, 'variable', 'title'), null);
	assert.match(d.checkAttr(t.id, 'variable', 'titel'), /Not a standard CSL variable/);
	assert.match(d.checkAttr(t.id, 'font-style', 'slanted'), /Expected one of/);
	assert.match(d.checkAttr(t.id, 'macro', 'nope'), /no macro called/);
	assert.equal(d.setAttr(t.id, 'font-style', 'slanted'), true);
});


//
// Structure
//

test('insert checks what the parent may contain', () => {
	let d = doc();
	let layout = d.findAll('layout')[0];
	assert.throws(() => d.insert(layout.id, { name: 'info' }), (e) => e.code === 'invalid-parent');
	assert.throws(() => d.insert(first(d, 'name').id, { name: 'text' }), CSLEditError);
	let id = d.insert(layout.id, { name: 'text', attrs: { variable: 'title' } });
	assert.equal(layout.children.at(-1).id, id);
});

test('a failed insert leaves the style untouched', () => {
	let d = doc();
	let before = d.toXML();
	assert.throws(() => d.insert(first(d, 'layout').id, { name: 'info' }));
	assert.equal(d.toXML(), before);
	assert.equal(d.canUndo(), false);
});

test('new macros are placed with the other macros, before the citation', () => {
	let d = doc();
	d.addMacro('title');
	let kinds = d.root.children.filter(c => c.type === 'element').map(c => c.name);
	assert.deepEqual(kinds, ['info', 'locale', 'macro', 'macro', 'macro', 'citation', 'bibliography']);
	assert.equal(d.root.children.filter(c => c.name === 'macro').at(-1).attrs[0].value, 'title');
});

test('macro names must be valid and unique', () => {
	let d = doc();
	assert.throws(() => d.addMacro('author'), (e) => e.code === 'duplicate');
	assert.throws(() => d.addMacro('1bad'), (e) => e.code === 'invalid-name');
	assert.throws(() => d.addMacro('has space'), (e) => e.code === 'invalid-name');
});

test('addBranch keeps a choose in order', () => {
	let d = doc();
	let choose = first(d, 'choose');
	d.addBranch(choose.id, 'else-if');
	let names = choose.children.map(c => c.name);
	assert.deepEqual(names, ['if', 'else-if', 'else-if', 'else']);
	assert.throws(() => d.addBranch(choose.id, 'else'), (e) => e.code === 'order');
});

test('an else branch cannot be moved above other branches', () => {
	let d = doc();
	let choose = first(d, 'choose');
	let els = choose.children.find(c => c.name === 'else');
	assert.equal(d.canMoveBy(els.id, -1), false);
	let before = d.toXML();
	assert.throws(() => d.moveBy(els.id, -1), (e) => e.code === 'order');
	// The failed move rolled back, so look the node up again by id
	assert.deepEqual(d.find(choose.id).children.map(c => c.name), ['if', 'else-if', 'else']);
	assert.equal(d.toXML(), before);
	assert.equal(d.canUndo(), false);
});

test('canMoveBy is a pure question: it never disturbs the tree', () => {
	let d = doc();
	let choose = first(d, 'choose');
	let ifNode = choose.children[0];
	assert.equal(d.canMoveBy(ifNode.id, 1), false); // would put else-if first
	assert.equal(d.canMoveBy(choose.children[1].id, 1), false); // would pass the else
	assert.equal(first(d, 'choose'), choose);
	assert.equal(choose.children[0], ifNode);
	assert.equal(d.canMoveBy(first(d, 'group').children[0].id, 1), true);
	assert.equal(d.canMoveBy(first(d, 'group').children[1].id, 1), false);
});

test('moveBy reorders siblings', () => {
	let d = doc();
	let grp = first(d, 'group');
	let [a, b] = grp.children;
	assert.equal(d.moveBy(a.id, 1), true);
	assert.deepEqual(grp.children.map(c => c.id), [b.id, a.id]);
	assert.equal(d.moveBy(a.id, 1), false);
});

test('move can change parent and refuses cycles', () => {
	let d = doc();
	let grp = first(d, 'group');
	let layout = first(d, 'layout');
	let author = grp.children[0];
	d.move(author.id, layout.id, 0);
	assert.equal(layout.children[0].id, author.id);
	assert.equal(grp.children.length, 1);
	assert.throws(() => d.move(grp.id, grp.id), (e) => e.code === 'cycle');
	assert.throws(() => d.move(first(d, 'if').id, layout.id), (e) => e.code === 'invalid-parent');
});

test('moving a node later within its parent lands where asked', () => {
	let d = doc();
	let layout = d.findAll('layout')[1];
	let [text, choose] = layout.children;
	d.move(text.id, layout.id, 2);
	assert.deepEqual(layout.children.map(c => c.id), [choose.id, text.id]);
});

test('required parts cannot be removed', () => {
	let d = doc();
	assert.throws(() => d.remove(first(d, 'info').id), (e) => e.code === 'required');
	assert.throws(() => d.remove(first(d, 'layout').id), (e) => e.code === 'required');
	assert.throws(() => d.remove(first(d, 'citation').id), (e) => e.code === 'required');
	assert.throws(() => d.remove(first(d, 'if').id), (e) => e.code === 'required');
	assert.throws(() => d.remove(d.root.id), (e) => e.code === 'root');
	assert.equal(d.canRemove(first(d, 'info').id), false);
});

test('remove deletes an element and its contents', () => {
	let d = doc();
	let before = d.findAll('text').length;
	d.remove(first(d, 'group').id);
	assert.equal(first(d, 'group'), undefined);
	assert.equal(d.findAll('text').length, before - 2);
});

test('duplicate copies with fresh ids', () => {
	let d = doc();
	let grp = first(d, 'group');
	let copyId = d.duplicate(grp.id);
	let copy = d.find(copyId);
	assert.notEqual(copyId, grp.id);
	assert.equal(copy.children.length, 2);
	assert.ok(copy.children.every((c, i) => c.id !== grp.children[i].id));
	let ids = [];
	d.walk(n => ids.push(n.id));
	assert.equal(new Set(ids).size, ids.length);
});

test('duplicating a macro gives it a new name', () => {
	let d = doc();
	d.duplicate(first(d, 'macro').id);
	d.duplicate(first(d, 'macro').id);
	let names = d.macros().map(m => m.name);
	assert.deepEqual(names, ['author', 'author-copy-2', 'author-copy', 'year']);
});

test('wrapInGroup and unwrap are inverses', () => {
	let d = doc();
	let before = d.toXML();
	let layout = d.findAll('layout')[1];
	let t = layout.children[0];
	let gid = d.wrapInGroup(t.id);
	assert.equal(layout.children[0].id, gid);
	assert.equal(layout.children[0].children[0].id, t.id);
	d.unwrap(gid);
	assert.equal(d.toXML(), before);
	assert.throws(() => d.wrapInGroup(first(d, 'info').id), (e) => e.code === 'invalid');
	assert.throws(() => d.unwrap(t.id), (e) => e.code === 'invalid');
});


//
// Macros
//

test('renaming a macro updates everything that calls it', () => {
	let d = doc();
	let m = first(d, 'macro');
	assert.equal(d.macroUsages('author').length, 3); // citation, bibliography layout, sort key
	d.renameMacro(m.id, 'creators');
	assert.equal(d.macroUsages('author').length, 0);
	assert.equal(d.macroUsages('creators').length, 3);
	assert.deepEqual(d.undefinedMacros(), []);
});

test('renaming a macro refuses duplicates and bad names', () => {
	let d = doc();
	let m = first(d, 'macro');
	assert.throws(() => d.renameMacro(m.id, 'year'), (e) => e.code === 'duplicate');
	assert.throws(() => d.renameMacro(m.id, 'no good'), (e) => e.code === 'invalid-name');
	assert.equal(d.macroNode('author') !== null, true);
});

test('a macro that is still used cannot be removed; an unused one can', () => {
	let d = doc();
	assert.throws(() => d.remove(first(d, 'macro').id), (e) => e.code === 'used-macro');
	let id = d.addMacro('spare');
	assert.deepEqual(d.unusedMacros().map(m => m.name), ['spare']);
	d.remove(id);
	assert.equal(d.macroNode('spare'), null);
});

test('undefinedMacros reports calls with no definition', () => {
	let d = doc();
	d.setAttr(d.macroUsages('year')[0].id, 'macro', 'yeer');
	assert.deepEqual(d.undefinedMacros(), ['yeer']);
});


//
// History and state
//

test('undo and redo walk back and forth', () => {
	let d = doc();
	let original = d.toXML();
	let g = first(d, 'group');
	d.setAttr(g.id, 'prefix', '[');
	d.remove(d.findAll('text')[0].id);
	let edited = d.toXML();
	assert.notEqual(edited, original);
	assert.equal(d.undo(), true);
	assert.equal(d.undo(), true);
	assert.equal(d.toXML(), original);
	assert.equal(d.undo(), false);
	assert.equal(d.redo(), true);
	assert.equal(d.redo(), true);
	assert.equal(d.toXML(), edited);
	assert.equal(d.canRedo(), false);
});

test('a new edit clears the redo history', () => {
	let d = doc();
	let g = first(d, 'group');
	d.setAttr(g.id, 'prefix', '[');
	d.undo();
	assert.equal(d.canRedo(), true);
	d.setAttr(g.id, 'prefix', '(');
	assert.equal(d.canRedo(), false);
});

test('ids stay valid across undo', () => {
	let d = doc();
	let g = first(d, 'group');
	let id = g.id;
	d.setAttr(id, 'prefix', '[');
	d.undo();
	assert.equal(d.find(id).name, 'group');
	d.redo();
	assert.equal(d.getAttr(id, 'prefix'), '[');
});

test('ids are not reused after an undone insert', () => {
	let d = doc();
	let a = d.insert(first(d, 'layout').id, { name: 'text', attrs: { variable: 'title' } });
	d.undo();
	let b = d.insert(first(d, 'layout').id, { name: 'text', attrs: { variable: 'title' } });
	assert.notEqual(a, b);
});

test('isDirty tracks changes since the last save', () => {
	let d = doc();
	assert.equal(d.isDirty(), false);
	d.setAttr(first(d, 'group').id, 'prefix', '[');
	assert.equal(d.isDirty(), true);
	d.markSaved();
	assert.equal(d.isDirty(), false);
	d.undo();
	assert.equal(d.isDirty(), true);
});

test('onChange fires for edits, undo and redo, but not for failed edits', () => {
	let d = doc();
	let calls = 0;
	d.onChange(() => calls++);
	d.setAttr(first(d, 'group').id, 'prefix', '[');
	assert.equal(calls, 1);
	assert.throws(() => d.insert(first(d, 'layout').id, { name: 'info' }));
	assert.equal(calls, 1);
	d.undo();
	d.redo();
	assert.equal(calls, 3);
});

test('info fields can be read and written', () => {
	let d = doc();
	assert.equal(d.getInfo('id'), 'http://example.org/small');
	d.setInfo('title', 'Renamed');
	d.setInfo('summary', 'New field');
	assert.equal(d.getInfo('title'), 'Renamed');
	assert.equal(d.getInfo('summary'), 'New field');
	assert.equal(d.getInfo('rights'), null);
});


//
// Descriptions for the tree view
//

test('describe gives readable titles', () => {
	let d = doc();
	let desc = id => d.describe(id);
	let textWith = (attr) => d.findAll('text').find(n => n.attrs.some(a => a.name === attr));
	assert.equal(desc(textWith('macro').id).title, 'Macro: author');
	assert.equal(desc(textWith('value').id).title, 'Text: “untitled”');
	let italic = d.findAll('text').find(n => n.attrs.some(a => a.name === 'font-style'));
	assert.equal(desc(italic.id).title, 'Variable: title');
	assert.equal(desc(italic.id).detail, 'italic');
	assert.equal(desc(first(d, 'if').id).title, 'If type book');
	assert.equal(desc(first(d, 'else-if').id).title, 'Else if variable container-title');
	assert.equal(desc(first(d, 'else').id).title, 'Else');
	assert.equal(desc(first(d, 'layout').id).detail, 'before “(” · after “)” · separated by “; ”');
	assert.equal(desc(first(d, 'names').id).title, 'Names: author');
});


//
// Line mapping and whole-document replacement
//

test('toXMLWithLines maps each node to the line it starts on', () => {
	let d = doc();
	let { xml, lineMap } = d.toXMLWithLines();
	let lines = xml.split('\n');
	let group = first(d, 'group');
	assert.match(lines[lineMap.get(group.id) - 1], /^\s*<group delimiter=", ">$/);
	let macroText = d.findAll('text')[0];
	assert.match(lines[lineMap.get(macroText.id) - 1], /<text macro="author"\/>/);
	assert.match(lines[lineMap.get(d.root.id) - 1], /^<style /);
});

test('nodeAtLine finds the innermost node for a line', () => {
	let d = doc();
	let { xml, lineMap } = d.toXMLWithLines();
	let lines = xml.split('\n');
	let at = (re) => lines.findIndex(l => re.test(l)) + 1;
	let t = d.find(Tree.nodeAtLine(lineMap, at(/<text variable="title" quotes="true"\/>/)));
	assert.equal(t.name, 'text');
	assert.equal(d.getAttr(t.id, 'quotes'), 'true');
	let g = d.find(Tree.nodeAtLine(lineMap, at(/<group delimiter/)));
	assert.equal(g.name, 'group');
	// A line inside a block but not at a child start belongs to the block
	assert.equal(d.find(Tree.nodeAtLine(lineMap, at(/<\/group>/))).name, 'text');
	assert.equal(Tree.nodeAtLine(new Map(), 5), null);
});

test('replaceXML swaps the whole style and can be undone', () => {
	let d = doc();
	let original = d.toXML();
	let other = Templates.newStyleXML('numeric', { title: 'Other', updated: '2026-01-01T00:00:00Z' });
	assert.equal(d.replaceXML(other), true);
	assert.equal(d.getInfo('title'), 'Other');
	assert.equal(d.root.attrs.find(a => a.name === 'class').value, 'in-text');
	d.undo();
	assert.equal(d.toXML(), original);
	d.redo();
	assert.equal(d.getInfo('title'), 'Other');
});

test('replaceXML with unreadable XML changes nothing', () => {
	let d = doc();
	let before = d.toXML();
	let kept = first(d, 'group');
	assert.throws(() => d.replaceXML('<style><oops></style>'), CSLParseError);
	assert.equal(d.toXML(), before);
	assert.equal(first(d, 'group'), kept);
	assert.equal(d.canUndo(), false);
});

test('replaceXML gives every new node a fresh id', () => {
	let d = doc();
	let old = new Set();
	d.walk(n => old.add(n.id));
	d.replaceXML(SMALL);
	let ids = [];
	d.walk(n => ids.push(n.id));
	assert.equal(new Set(ids).size, ids.length);
	assert.ok(ids.every(id => !old.has(id)));
});

test('isDirty is about content, not node identity', () => {
	let d = doc();
	d.replaceXML(d.toXML());
	assert.equal(d.isDirty(), false);
});


//
// Multi-attribute edits and optional info fields
//

test('setAttrs applies several changes as one undoable step', () => {
	let d = doc();
	let t = d.findAll('text').find(n => n.attrs.some(a => a.name === 'macro'));
	assert.equal(d.setAttrs(t.id, { macro: null, variable: 'title', 'font-style': 'italic' }), true);
	assert.equal(d.getAttr(t.id, 'macro'), null);
	assert.equal(d.getAttr(t.id, 'variable'), 'title');
	assert.equal(d.getAttr(t.id, 'font-style'), 'italic');
	d.undo();
	assert.equal(d.getAttr(t.id, 'macro'), 'author');
	assert.equal(d.getAttr(t.id, 'variable'), null);
	assert.equal(d.getAttr(t.id, 'font-style'), null);
	assert.equal(d.canUndo(), false);
});

test('setAttrs with nothing to change is not an edit', () => {
	let d = doc();
	let g = first(d, 'group');
	assert.equal(d.setAttrs(g.id, { delimiter: ', ', prefix: '' }), false);
	assert.equal(d.canUndo(), false);
});

test('clearing an optional info field removes it; required ones are kept', () => {
	let d = doc();
	d.setInfo('summary', 'something');
	assert.equal(d.getInfo('summary'), 'something');
	d.setInfo('summary', '');
	assert.equal(d.getInfo('summary'), null);
	assert.doesNotMatch(d.toXML(), /<summary/);
	assert.equal(d.setInfo('summary', ''), false);
	d.setInfo('title', '');
	assert.equal(d.getInfo('title'), '');
	assert.match(d.toXML(), /<title\/>/);
});

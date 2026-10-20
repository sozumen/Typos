'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const RelationGraph = require('../../chrome/content/zotero/xpcom/data/relationGraph.js');

// Build a neighbors() callback from [from, to] pairs; async to match real usage
function graph(edges) {
	let map = new Map();
	for (let [a, b] of edges) {
		if (!map.has(a)) map.set(a, []);
		map.get(a).push(b);
	}
	return async node => map.get(node) || [];
}

test('reaches follows chains', async () => {
	let n = graph([['chapter', 'book'], ['book', 'series']]);
	assert.equal(await RelationGraph.reaches('chapter', 'series', n), true);
	assert.equal(await RelationGraph.reaches('series', 'chapter', n), false);
});

test('wouldCreateCycle rejects self edges and closing edges', async () => {
	let n = graph([['chapter', 'book'], ['book', 'series']]);
	assert.equal(await RelationGraph.wouldCreateCycle('a', 'a', n), true);
	// series -> chapter would close chapter -> book -> series
	assert.equal(await RelationGraph.wouldCreateCycle('series', 'chapter', n), true);
	// Adding a second parent is fine (DAG)
	assert.equal(await RelationGraph.wouldCreateCycle('chapter', 'reprint', n), false);
});

test('reaches terminates on data that already contains a cycle', async () => {
	let n = graph([['a', 'b'], ['b', 'a']]);
	assert.equal(await RelationGraph.reaches('a', 'z', n), false);
});

test('reaches throws when the graph exceeds the node limit', async () => {
	let n = async node => [node + 'x', node + 'y'];
	await assert.rejects(() => RelationGraph.reaches('r', 'never', n, 50), /too large/);
});

test('collect returns nearest first with depths and no duplicates', async () => {
	let n = graph([['root', 'a'], ['root', 'b'], ['a', 'c'], ['b', 'c'], ['c', 'd']]);
	let result = await RelationGraph.collect('root', n);
	assert.deepEqual(result, [
		{ node: 'a', depth: 1 },
		{ node: 'b', depth: 1 },
		{ node: 'c', depth: 2 },
		{ node: 'd', depth: 3 }
	]);
});

test('collect respects maxDepth and excludes the start node even in cycles', async () => {
	let n = graph([['a', 'b'], ['b', 'c'], ['c', 'a']]);
	assert.deepEqual(
		await RelationGraph.collect('a', n, { maxDepth: 1 }),
		[{ node: 'b', depth: 1 }]
	);
	let all = await RelationGraph.collect('a', n);
	assert.deepEqual(all.map(x => x.node), ['b', 'c']);
});

test('buildTree nests children, repeats DAG nodes, and skips cycle back-edges', async () => {
	let n = graph([['book', 'ch1'], ['book', 'ch2'], ['ch1', 'sec'], ['ch2', 'sec'], ['sec', 'book']]);
	let tree = await RelationGraph.buildTree('book', n);
	assert.equal(tree.node, 'book');
	assert.deepEqual(tree.children.map(c => c.node), ['ch1', 'ch2']);
	// sec appears under both chapters; its edge back to book is not followed
	assert.deepEqual(tree.children[0].children, [{ node: 'sec', children: [] }]);
	assert.deepEqual(tree.children[1].children, [{ node: 'sec', children: [] }]);
});

test('buildTree stops at maxDepth', async () => {
	let n = async node => [node + '1'];
	let tree = await RelationGraph.buildTree('x', n, { maxDepth: 3 });
	let depth = 0;
	for (let t = tree; t.children.length; t = t.children[0]) depth++;
	assert.equal(depth, 3);
});

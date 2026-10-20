"use strict";

/**
 * Pure graph helpers for typed item relationships
 *
 * Nothing here touches the database or the Zotero object model. Nodes are opaque strings (item
 * URIs in practice) and edges are supplied through a `neighbors(node)` callback that returns an
 * array (or a promise for an array) of the nodes reachable from `node` along a single relation
 * type. That keeps the traversal logic testable in plain Node (see fork/test/relationGraph.test.js).
 */
(function (root) {
	const DEFAULT_MAX_NODES = 10000;

	const RelationGraph = {
		/**
		 * Whether `to` can be reached from `from` by following `neighbors`
		 *
		 * @param {String} from
		 * @param {String} to
		 * @param {Function} neighbors - node => (String[] | Promise<String[]>)
		 * @param {Number} [maxNodes] - Safety limit on visited nodes
		 * @return {Promise<Boolean>}
		 */
		async reaches(from, to, neighbors, maxNodes = DEFAULT_MAX_NODES) {
			if (from === to) return true;
			let visited = new Set([from]);
			let queue = [from];
			while (queue.length) {
				let node = queue.shift();
				for (let next of (await neighbors(node)) || []) {
					if (next === to) return true;
					if (visited.has(next)) continue;
					if (visited.size >= maxNodes) {
						throw new Error("Relation graph too large to traverse");
					}
					visited.add(next);
					queue.push(next);
				}
			}
			return false;
		},


		/**
		 * Whether adding the edge subject -> object would create a cycle
		 *
		 * The edge closes a cycle exactly when `subject` is already reachable from `object`.
		 * Self-edges are cycles.
		 */
		async wouldCreateCycle(subject, object, neighbors, maxNodes) {
			return this.reaches(object, subject, neighbors, maxNodes);
		},


		/**
		 * All nodes reachable from `start` (excluding `start`), nearest first
		 *
		 * @return {Promise<{ node: String, depth: Number }[]>}
		 */
		async collect(start, neighbors, { maxDepth = Infinity, maxNodes = DEFAULT_MAX_NODES } = {}) {
			let visited = new Set([start]);
			let results = [];
			let level = [start];
			for (let depth = 1; level.length && depth <= maxDepth; depth++) {
				let nextLevel = [];
				for (let node of level) {
					for (let next of (await neighbors(node)) || []) {
						if (visited.has(next)) continue;
						if (visited.size >= maxNodes) {
							throw new Error("Relation graph too large to traverse");
						}
						visited.add(next);
						results.push({ node: next, depth });
						nextLevel.push(next);
					}
				}
				level = nextLevel;
			}
			return results;
		},


		/**
		 * Build a tree rooted at `root`
		 *
		 * A node that already appears on the path from the root is not expanded again, so data
		 * that somehow contains a cycle still produces a finite tree. A node reachable by two
		 * different paths (a DAG) appears under each parent.
		 *
		 * @return {Promise<{ node: String, children: Object[] }>}
		 */
		async buildTree(rootNode, neighbors, { maxDepth = 20 } = {}) {
			let count = 0;
			let build = async (node, path) => {
				if (++count > DEFAULT_MAX_NODES) {
					throw new Error("Relation graph too large to traverse");
				}
				let result = { node, children: [] };
				if (path.length >= maxDepth) return result;
				let nextPath = path.concat(node);
				for (let next of (await neighbors(node)) || []) {
					if (nextPath.includes(next)) continue;
					result.children.push(await build(next, nextPath));
				}
				return result;
			};
			return build(rootNode, []);
		}
	};

	if (typeof module !== 'undefined' && module.exports) {
		module.exports = RelationGraph;
	}
	else if (root) {
		root.RelationGraph = RelationGraph;
	}
})(typeof Zotero !== 'undefined' ? Zotero : null);

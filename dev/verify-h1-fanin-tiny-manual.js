'use strict';
// H1 adversarial sanity check: a hand-computable tiny fan-in DAG (W=2,
// 3 layers) run through the REAL parser+resolver pipeline, with the
// expected node shape worked out by hand below, to confirm the low node
// counts from verify-h1-fanin-independent.js reflect correct DAG
// memoization (each identity's SUBTREE expanded once, seenElsewhere refs
// for later occurrences) rather than some other bug that just happens to
// produce small numbers (e.g. silently dropping children).
//
// Corpus: L0Cls0 (leaf). L1Cls0, L1Cls1 each call L0Cls0.doWork().
// L2Cls0, L2Cls1 each call BOTH L1Cls0.doWork() and L1Cls1.doWork().
// Trace target: L0Cls0.doWork.
//
// Expected tree (maxDepth default 8, not hit; no cycles):
//   root (L0Cls0.doWork)                              -- ctx.nodeCount starts at 1 for this
//     depth1: L1Cls0 (expand), L1Cls1 (expand)         -- 2 new nodes, both first-seen
//       depth2 under L1Cls0: L2Cls0 (expand), L2Cls1 (expand)   -- 2 new nodes, first-seen
//       depth2 under L1Cls1: L2Cls0 (seenElsewhere, children=[]), L2Cls1 (seenElsewhere, children=[])
//         -- 2 MORE node objects (still materialized, just children forced empty)
// Total nodeCount = 1 (root) + 2 (depth1) + 2 (depth2 real) + 2 (depth2 seenElsewhere) = 7
// uniqueMethods (distinct classLower#methodLower across children) = L1Cls0, L1Cls1, L2Cls0, L2Cls1 = 4
// capped = false (7 << default maxNodes 2000)

const path = require('path');
const parser = require(path.join(__dirname, '..', 'parser.js'));
const resolver = require(path.join(__dirname, '..', 'resolver.js'));

const files = [
  { path: '/ws/force-app/main/default/classes/L0Cls0.cls', text: 'public class L0Cls0 {\n  public void doWork() {\n    Integer x = 1;\n  }\n}\n' },
  { path: '/ws/force-app/main/default/classes/L1Cls0.cls', text: 'public class L1Cls0 {\n  public void doWork() {\n    new L0Cls0().doWork();\n  }\n}\n' },
  { path: '/ws/force-app/main/default/classes/L1Cls1.cls', text: 'public class L1Cls1 {\n  public void doWork() {\n    new L0Cls0().doWork();\n  }\n}\n' },
  { path: '/ws/force-app/main/default/classes/L2Cls0.cls', text: 'public class L2Cls0 {\n  public void doWork() {\n    new L1Cls0().doWork();\n    new L1Cls1().doWork();\n  }\n}\n' },
  { path: '/ws/force-app/main/default/classes/L2Cls1.cls', text: 'public class L2Cls1 {\n  public void doWork() {\n    new L1Cls0().doWork();\n    new L1Cls1().doWork();\n  }\n}\n' },
];

const factsList = files.map((f) => parser.parseFile(f));
const index = resolver.buildSemanticIndex(factsList);
const tree = resolver.buildCallerTree(index, { classLower: 'l0cls0', methodLower: 'dowork' }, {});

function dump(node, depth) {
  const indent = '  '.repeat(depth);
  console.log(`${indent}${node.label} seenElsewhere=${!!node.seenElsewhere} cyclic=${!!node.cyclic} children=${node.children.length}`);
  for (const c of node.children) dump(c, depth + 1);
}

console.log('=== tree dump ===');
dump(tree.root, 0);
console.log('\n=== stats ===');
console.log(JSON.stringify(tree.stats, null, 2));

const expected = { nodes: 7, uniqueMethods: 4, capped: false };
const actual = tree.stats;
let pass = true;
for (const k of Object.keys(expected)) {
  if (actual[k] !== expected[k]) {
    pass = false;
    console.log(`MISMATCH on ${k}: expected ${expected[k]}, got ${actual[k]}`);
  }
}

// Structural check: exactly 2 nodes with seenElsewhere=true at depth2, and
// their children arrays must be empty (dedup applies to subtree only).
let seenElsewhereCount = 0;
let seenElsewhereChildrenNonEmpty = 0;
function walk(node) {
  if (node.seenElsewhere) {
    seenElsewhereCount++;
    if (node.children.length !== 0) seenElsewhereChildrenNonEmpty++;
  }
  for (const c of node.children) walk(c);
}
walk(tree.root);
if (seenElsewhereCount !== 2) {
  pass = false;
  console.log(`MISMATCH: expected 2 seenElsewhere nodes, got ${seenElsewhereCount}`);
}
if (seenElsewhereChildrenNonEmpty !== 0) {
  pass = false;
  console.log(`MISMATCH: ${seenElsewhereChildrenNonEmpty} seenElsewhere node(s) have non-empty children (dedup leaking into subtree)`);
}

console.log(`\nOVERALL: ${pass ? 'PASS' : 'FAIL'}`);
process.exitCode = pass ? 0 : 1;

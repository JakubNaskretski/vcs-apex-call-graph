'use strict';
// H1 adversarial check: "cyclic flag still wins over seenElsewhere on
// ancestor-path hits" -- constructs a case where a node's identity is BOTH
// (a) already in ctx.expandedKeys (expanded once already, which would
// normally trigger seenElsewhere) AND (b) present on the CURRENT
// root-to-node ancestor path (which triggers cyclic) at the same time, and
// asserts cyclic wins (seenElsewhere must be false on that occurrence).
//
// Corpus: Target = T. P calls T (P is T's depth-1 caller). Q calls P (Q is
// P's caller, depth-2). P ALSO calls Q (so P recurs at depth-3, forming
// cycle T<-P<-Q<-P). By the time P is revisited at depth 3:
//   - P's identity was already added to ctx.expandedKeys when P was FIRST
//     built at depth 1 (marked expanded immediately, before recursion).
//   - P's identity ('p#dowork') is ALSO on the current ancestor path
//     (T -> P -> Q -> P), so it is a genuine cycle.
// Expected: the depth-3 P node has cyclic=true, seenElsewhere=false,
// children=[].

const path = require('path');
const parser = require(path.join(__dirname, '..', 'parser.js'));
const resolver = require(path.join(__dirname, '..', 'resolver.js'));

const files = [
  { path: '/ws/force-app/main/default/classes/T.cls', text: 'public class T {\n  public void doWork() {\n    Integer x = 1;\n  }\n}\n' },
  { path: '/ws/force-app/main/default/classes/P.cls', text: 'public class P {\n  public void doWork() {\n    new T().doWork();\n    new Q().doWork();\n  }\n}\n' },
  { path: '/ws/force-app/main/default/classes/Q.cls', text: 'public class Q {\n  public void doWork() {\n    new P().doWork();\n  }\n}\n' },
];

const factsList = files.map((f) => parser.parseFile(f));
const index = resolver.buildSemanticIndex(factsList);
const tree = resolver.buildCallerTree(index, { classLower: 't', methodLower: 'dowork' }, {});

function dump(node, depth) {
  const indent = '  '.repeat(depth);
  console.log(`${indent}${node.label} cyclic=${!!node.cyclic} seenElsewhere=${!!node.seenElsewhere} children=${node.children.length}`);
  for (const c of node.children) dump(c, depth + 1);
}
console.log('=== tree dump ===');
dump(tree.root, 0);
console.log('\n=== stats ===');
console.log(JSON.stringify(tree.stats, null, 2));

// Walk to find the depth-3 P node (root -> P -> Q -> P).
const pLevel1 = tree.root.children.find((c) => c.label === 'P.doWork');
let pass = true;
if (!pLevel1) { pass = false; console.log('MISSING depth-1 P node'); }
const qLevel2 = pLevel1 && pLevel1.children.find((c) => c.label === 'Q.doWork');
if (!qLevel2) { pass = false; console.log('MISSING depth-2 Q node'); }
const pLevel3 = qLevel2 && qLevel2.children.find((c) => c.label === 'P.doWork');
if (!pLevel3) { pass = false; console.log('MISSING depth-3 P node (cycle site)'); }

if (pLevel3) {
  if (pLevel3.cyclic !== true) { pass = false; console.log(`MISMATCH: depth-3 P.cyclic expected true, got ${pLevel3.cyclic}`); }
  if (pLevel3.seenElsewhere !== false) { pass = false; console.log(`MISMATCH: depth-3 P.seenElsewhere expected false (cyclic must win), got ${pLevel3.seenElsewhere}`); }
  if (pLevel3.children.length !== 0) { pass = false; console.log(`MISMATCH: depth-3 P.children expected [], got ${pLevel3.children.length}`); }
}

console.log(`\nOVERALL: ${pass ? 'PASS' : 'FAIL'}`);
process.exitCode = pass ? 0 : 1;

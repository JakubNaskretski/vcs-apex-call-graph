'use strict';
// H1 adversarial check: maxNodes cap must be breadth-first-fair (shallow
// nodes across ALL branches get built before any branch is walked deep)
// and must never silently drop a branch without stats.capped=true.
//
// Corpus: target R is called by 3 SYMMETRIC single-caller chains A, B, C
// (A<-A1<-A2<-..., B<-B1<-B2<-..., same for C), each chain 5 deep. With
// opts.maxNodes=7 (1 root + 3 level-1 siblings A/B/C + budget for exactly
// 3 more nodes), a correct breadth-first cap should let ALL THREE chains
// advance one extra level (A1, B1, C1) rather than let one chain (e.g. A)
// consume the remaining budget diving to A2/A3/A4 while B/C get nothing
// past their level-1 node. Predicted result: nodes=7, capped=true, and
// A1/B1/C1 each present with children=[] (cap fired on their own
// expansion, not deeper on any single one of them).

const path = require('path');
const parser = require(path.join(__dirname, '..', 'parser.js'));
const resolver = require(path.join(__dirname, '..', 'resolver.js'));

function chainFiles(prefix, depth, calleeName) {
  // prefix0 calls calleeName; prefix1 calls prefix0; prefix2 calls prefix1; ...
  const files = [];
  let prevCallee = calleeName;
  let prevIsRootTarget = true;
  for (let i = 0; i < depth; i++) {
    const name = `${prefix}${i}`;
    files.push({
      path: `/ws/force-app/main/default/classes/${name}.cls`,
      text: `public class ${name} {\n  public void doWork() {\n    new ${prevCallee}().doWork();\n  }\n}\n`,
    });
    prevCallee = name;
  }
  return files;
}

const files = [
  { path: '/ws/force-app/main/default/classes/RootTarget.cls', text: 'public class RootTarget {\n  public void doWork() {\n    Integer x = 1;\n  }\n}\n' },
  ...chainFiles('ChainA', 5, 'RootTarget'),
  ...chainFiles('ChainB', 5, 'RootTarget'),
  ...chainFiles('ChainC', 5, 'RootTarget'),
];

const factsList = files.map((f) => parser.parseFile(f));
const index = resolver.buildSemanticIndex(factsList);
const tree = resolver.buildCallerTree(index, { classLower: 'roottarget', methodLower: 'dowork' }, { maxNodes: 7 });

function dump(node, depth) {
  const indent = '  '.repeat(depth);
  console.log(`${indent}${node.label} children=${node.children.length}`);
  for (const c of node.children) dump(c, depth + 1);
}
console.log('=== tree dump (maxNodes=7) ===');
dump(tree.root, 0);
console.log('\n=== stats ===');
console.log(JSON.stringify(tree.stats, null, 2));

let pass = true;
if (tree.stats.nodes !== 7) { pass = false; console.log(`MISMATCH nodes: expected 7 got ${tree.stats.nodes}`); }
if (tree.stats.capped !== true) { pass = false; console.log(`MISMATCH capped: expected true got ${tree.stats.capped}`); }

// Fairness check: level1 must have exactly 3 children (ChainA0, ChainB0, ChainC0)
const level1Labels = tree.root.children.map((c) => c.label).sort();
const expectedLevel1 = ['ChainA0.doWork', 'ChainB0.doWork', 'ChainC0.doWork'];
if (JSON.stringify(level1Labels) !== JSON.stringify(expectedLevel1)) {
  pass = false;
  console.log(`MISMATCH level1: expected ${JSON.stringify(expectedLevel1)} got ${JSON.stringify(level1Labels)}`);
}

// Fairness check: EVERY level-1 node must have exactly 1 child (its own
// level-2 chain link) -- NOT one chain getting 2+ while another gets 0.
// This is the actual "breadth-first-fair" claim under adversarial test.
let unfair = false;
for (const c of tree.root.children) {
  if (c.children.length !== 1) {
    unfair = true;
    console.log(`UNFAIR: ${c.label} has ${c.children.length} children (expected exactly 1 -- all three chains should advance equally under a fair BFS cap)`);
  }
}
if (unfair) pass = false;

console.log(`\nOVERALL: ${pass ? 'PASS' : 'FAIL'}`);
process.exitCode = pass ? 0 : 1;

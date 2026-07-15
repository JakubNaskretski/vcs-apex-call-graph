'use strict';
// Adversarial integrity check: a hand-built fixture org (dev/fixture-org/)
// with a WRITTEN ground-truth call graph (independent of parser.js/resolver.js
// — line/col positions below are found via plain String.indexOf on the raw
// source text, not by re-running the engine under test). buildCallerTree is
// run for 3 targets and every node/site is diffed against the ground truth.
// Only reports REPRODUCED mismatches. Read-only: does not touch engine files.

const fs = require('fs');
const path = require('path');
const parser = require('../parser');
const resolver = require('../resolver');

const FIXTURE_DIR = path.join(__dirname, 'fixture-org');
const FILES = [
  'classes/WorkerService.cls',
  'classes/CallerOne.cls',
  'classes/CallerTwo.cls',
  'classes/CallerOneTest.cls',
  'classes/WorkerServiceBatch.cls',
  'classes/TriggerHandlerService.cls',
  'triggers/ExampleTrigger.trigger',
];

const mismatches = [];
function check(label, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) {
    mismatches.push({ label, actual, expected });
  }
}

// --- independent ground-truth position lookup (plain string search, no parser) ---
const sourceCache = new Map();
function srcLines(relPath) {
  if (!sourceCache.has(relPath)) {
    sourceCache.set(relPath, fs.readFileSync(path.join(FIXTURE_DIR, relPath), 'utf8').split('\n'));
  }
  return sourceCache.get(relPath);
}
// 1-based line, needle substring -> {line, col(0-based)}
function findPos(relPath, line1, needle) {
  const lines = srcLines(relPath);
  const text = lines[line1 - 1] || '';
  const col = text.indexOf(needle);
  if (col === -1) throw new Error(`ground-truth setup error: "${needle}" not found on ${relPath}:${line1}: "${text}"`);
  return { line: line1, col, lineText: text.trim().slice(0, 160) };
}

// --- load + index -----------------------------------------------------
const factsList = FILES.map((rel) => {
  const abs = path.join(FIXTURE_DIR, rel);
  const text = fs.readFileSync(abs, 'utf8');
  return parser.parseFile({ path: abs, text });
});

for (const f of factsList) {
  if (f.parseError) {
    console.error('UNEXPECTED PARSE ERROR in fixture:', f.path, f.parseError);
    process.exitCode = 1;
  }
}

const index = resolver.buildSemanticIndex(factsList);

function abs(rel) {
  return path.join(FIXTURE_DIR, rel);
}

// =========================================================================
// TARGET 1: WorkerService.process (method-level)
// =========================================================================
{
  const tree = resolver.buildCallerTree(index, { classLower: 'workerservice', methodLower: 'process' }, {});
  const root = tree.root;

  check('T1 root.label', root.label, 'WorkerService.process');
  check('T1 root.kind', root.kind, 'method');
  check('T1 root.className', root.className, 'WorkerService');
  check('T1 root.path', root.path, abs('classes/WorkerService.cls'));
  check('T1 root.line', root.line, 7);
  check('T1 root.entries', root.entries, ['@AuraEnabled (LWC/Aura)']);
  check('T1 root.isTest', root.isTest, false);
  check('T1 root.cyclic/truncated/approximate', [root.cyclic, root.truncated, root.approximate], [false, false, false]);
  check('T1 root.children.length', root.children.length, 5);

  const byLabel = {};
  for (const c of root.children) byLabel[c.label] = c;

  const expectedLabels = [
    'CallerOne.run',
    'CallerTwo.runBadArity',
    'CallerTwo.runStatic',
    'WorkerServiceBatch.execute',
    'CallerOneTest.testProcess', // test -> last
  ];
  check('T1 children order', root.children.map((c) => c.label), expectedLabels);

  // --- CallerOne.run ---
  {
    const n = byLabel['CallerOne.run'];
    check('T1 CallerOne.run kind/via/isTest', [n.kind, n.via, n.isTest], ['method', 'typed', false]);
    check('T1 CallerOne.run entries', n.entries, []);
    check('T1 CallerOne.run line (decl line 3)', n.line, 3);
    check('T1 CallerOne.run path', n.path, abs('classes/CallerOne.cls'));
    check('T1 CallerOne.run sites.length', n.sites.length, 1);
    const pos = findPos('classes/CallerOne.cls', 5, "svc.process('001000000000001', 3);");
    check('T1 CallerOne.run site[0] line/col/lineText', [n.sites[0].line, n.sites[0].col, n.sites[0].lineText], [pos.line, pos.col, pos.lineText]);
    check('T1 CallerOne.run site[0] argsRendered', n.sites[0].argsRendered, "recordId: '001000000000001', qty: 3");
    check('T1 CallerOne.run site[0] via', n.sites[0].via, 'typed');
    check('T1 CallerOne.run cyclic/truncated', [n.cyclic, n.truncated], [false, false]);

    // depth 2: cycle back to WorkerService.process via c.run()
    check('T1 CallerOne.run children.length', n.children.length, 1);
    const grandchild = n.children[0];
    check('T1 grandchild label', grandchild.label, 'WorkerService.process');
    check('T1 grandchild cyclic', grandchild.cyclic, true);
    check('T1 grandchild children (cyclic -> none)', grandchild.children, []);
    check('T1 grandchild via', grandchild.via, 'typed');
    check('T1 grandchild entries', grandchild.entries, ['@AuraEnabled (LWC/Aura)']);
    check('T1 grandchild sites.length', grandchild.sites.length, 1);
    const gcPos = findPos('classes/WorkerService.cls', 9, 'c.run();');
    check('T1 grandchild site line/col', [grandchild.sites[0].line, grandchild.sites[0].col], [gcPos.line, gcPos.col]);
    check('T1 grandchild site argsRendered (zero-arg call)', grandchild.sites[0].argsRendered, '');
  }

  // --- CallerTwo.runStatic ---
  {
    const n = byLabel['CallerTwo.runStatic'];
    check('T1 CallerTwo.runStatic via', n.via, 'static');
    check('T1 CallerTwo.runStatic children', n.children, []);
    const pos = findPos('classes/CallerTwo.cls', 4, "WorkerService.process('001000000000002', 7);");
    check('T1 CallerTwo.runStatic site pos', [n.sites[0].line, n.sites[0].col], [pos.line, pos.col]);
    check('T1 CallerTwo.runStatic argsRendered', n.sites[0].argsRendered, "recordId: '001000000000002', qty: 7");
  }

  // --- CallerTwo.runBadArity (arity mismatch -> raw joined argTexts) ---
  {
    const n = byLabel['CallerTwo.runBadArity'];
    check('T1 CallerTwo.runBadArity via', n.via, 'static');
    check('T1 CallerTwo.runBadArity argsRendered (fallback, no arity match)', n.sites[0].argsRendered, '1');
  }

  // --- WorkerServiceBatch.execute (Batchable entry badge) ---
  {
    const n = byLabel['WorkerServiceBatch.execute'];
    check('T1 WorkerServiceBatch.execute via', n.via, 'static');
    check('T1 WorkerServiceBatch.execute entries (Batchable attached)', n.entries, ['Batchable']);
    check('T1 WorkerServiceBatch.execute isTest', n.isTest, false);
    const pos = findPos('classes/WorkerServiceBatch.cls', 8, 'WorkerService.process(scope[0].Id, scope.size());');
    check('T1 WorkerServiceBatch.execute site pos', [n.sites[0].line, n.sites[0].col], [pos.line, pos.col]);
    check('T1 WorkerServiceBatch.execute argsRendered (complex exprs, arity match)', n.sites[0].argsRendered, 'recordId: scope[0].Id, qty: scope.size()');
  }

  // --- CallerOneTest.testProcess (tests-last, isTest cascade) ---
  {
    const n = byLabel['CallerOneTest.testProcess'];
    check('T1 CallerOneTest.testProcess isTest', n.isTest, true);
    check('T1 CallerOneTest.testProcess via', n.via, 'typed');
    const pos = findPos('classes/CallerOneTest.cls', 7, "svc.process('001000000000003', 1);");
    check('T1 CallerOneTest.testProcess site pos', [n.sites[0].line, n.sites[0].col], [pos.line, pos.col]);
    check('T1 CallerOneTest.testProcess argsRendered', n.sites[0].argsRendered, "recordId: '001000000000003', qty: 1");
  }

  // --- truncation: same target, maxDepth=1 -> all depth-1 nodes truncated,
  // no depth-2 expansion (so the cycle is never reached at this depth).
  const treeShallow = resolver.buildCallerTree(index, { classLower: 'workerservice', methodLower: 'process' }, { maxDepth: 1 });
  for (const c of treeShallow.root.children) {
    check(`T1-shallow ${c.label} truncated`, c.truncated, true);
    check(`T1-shallow ${c.label} cyclic`, c.cyclic, false);
    check(`T1-shallow ${c.label} children`, c.children, []);
  }
}

// =========================================================================
// TARGET 2: WorkerService (class-level)
// =========================================================================
{
  const tree = resolver.buildCallerTree(index, { classLower: 'workerservice', methodLower: null }, {});
  const root = tree.root;

  check('T2 root.label', root.label, 'WorkerService');
  check('T2 root.kind', root.kind, 'class');
  check('T2 root.line', root.line, 0);
  check('T2 root.entries', root.entries, ['@AuraEnabled (LWC/Aura)']);
  check('T2 root.isTest', root.isTest, false);
  check('T2 root.children.length', root.children.length, 5);

  const expectedLabels = [
    'CallerOne.run',
    'CallerTwo.runBadArity',
    'CallerTwo.runStatic',
    'WorkerServiceBatch.execute',
    'CallerOneTest.testProcess',
  ];
  check('T2 children order', root.children.map((c) => c.label), expectedLabels);

  const byLabel = {};
  for (const c of root.children) byLabel[c.label] = c;

  // --- CallerOne.run: merges BOTH the 'new' ctor call and the 'process' call
  // into ONE child node (grouped by caller class+method, not by target).
  {
    const n = byLabel['CallerOne.run'];
    check('T2 CallerOne.run sites.length (new + process merged)', n.sites.length, 2);
    check('T2 CallerOne.run via (first item = new)', n.via, 'new');
    const posNew = findPos('classes/CallerOne.cls', 4, 'new WorkerService();');
    const posProc = findPos('classes/CallerOne.cls', 5, "svc.process('001000000000001', 3);");
    check('T2 CallerOne.run site[0] (ctor) pos', [n.sites[0].line, n.sites[0].col, n.sites[0].via], [posNew.line, posNew.col, 'new']);
    check('T2 CallerOne.run site[0] argsRendered (0-arg ctor)', n.sites[0].argsRendered, '');
    check('T2 CallerOne.run site[1] (process) pos', [n.sites[1].line, n.sites[1].col, n.sites[1].via], [posProc.line, posProc.col, 'typed']);
    check('T2 CallerOne.run site[1] argsRendered', n.sites[1].argsRendered, "recordId: '001000000000001', qty: 3");
  }

  // --- CallerOneTest.testProcess: same merge pattern, plus isTest true ---
  {
    const n = byLabel['CallerOneTest.testProcess'];
    check('T2 CallerOneTest.testProcess sites.length', n.sites.length, 2);
    check('T2 CallerOneTest.testProcess isTest', n.isTest, true);
    const posNew = findPos('classes/CallerOneTest.cls', 6, 'new WorkerService();');
    const posProc = findPos('classes/CallerOneTest.cls', 7, "svc.process('001000000000003', 1);");
    check('T2 CallerOneTest.testProcess site[0] pos', [n.sites[0].line, n.sites[0].col], [posNew.line, posNew.col]);
    check('T2 CallerOneTest.testProcess site[1] pos', [n.sites[1].line, n.sites[1].col], [posProc.line, posProc.col]);
  }

  // --- single-item nodes (no 'new' call, so exactly 1 site each) ---
  for (const label of ['CallerTwo.runStatic', 'CallerTwo.runBadArity', 'WorkerServiceBatch.execute']) {
    const n = byLabel[label];
    check(`T2 ${label} sites.length`, n.sites.length, 1);
    check(`T2 ${label} via`, n.via, 'static');
  }
  check('T2 WorkerServiceBatch.execute entries', byLabel['WorkerServiceBatch.execute'].entries, ['Batchable']);
}

// =========================================================================
// TARGET 3: TriggerHandlerService.handle (trigger-reachable service)
// =========================================================================
{
  const tree = resolver.buildCallerTree(index, { classLower: 'triggerhandlerservice', methodLower: 'handle' }, {});
  const root = tree.root;

  check('T3 root.label', root.label, 'TriggerHandlerService.handle');
  check('T3 root.kind', root.kind, 'method');
  check('T3 root.line', root.line, 3);
  check('T3 root.entries', root.entries, []);
  check('T3 root.children.length', root.children.length, 1);

  const n = root.children[0];
  check('T3 trigger child label', n.label, 'ExampleTrigger');
  check('T3 trigger child kind', n.kind, 'trigger');
  check('T3 trigger child path', n.path, abs('triggers/ExampleTrigger.trigger'));
  check('T3 trigger child line (triggerUnit start line)', n.line, 1);
  check('T3 trigger child entries', n.entries, ['trigger on Account (after insert)']);
  check('T3 trigger child isTest', n.isTest, false);
  check('T3 trigger child via', n.via, 'static');
  check('T3 trigger child cyclic/truncated/approximate', [n.cyclic, n.truncated, n.approximate], [false, false, false]);
  check('T3 trigger child children (nobody calls the trigger body)', n.children, []);

  check('T3 trigger child sites.length', n.sites.length, 1);
  const pos = findPos('triggers/ExampleTrigger.trigger', 2, 'TriggerHandlerService.handle(Trigger.new);');
  check('T3 trigger child site pos', [n.sites[0].line, n.sites[0].col], [pos.line, pos.col]);
  check('T3 trigger child site argsRendered', n.sites[0].argsRendered, 'accounts: Trigger.new');

  // Negative check: System.debug(...) inside TriggerHandlerService.handle must
  // produce NO edge at all (platform denylist, rule "Denylist gate"). If it
  // did, System would show up as an indexed class or 'system#debug' would
  // exist as a methodCallers key.
  check('T3 System is not indexed as a user class', index.classes.has('system'), false);
  check('T3 no methodCallers edge for system#debug', index.methodCallers.has('system#debug'), false);
}

// =========================================================================
if (mismatches.length) {
  console.error(`\n${mismatches.length} REPRODUCED MISMATCH(ES):\n`);
  for (const m of mismatches) {
    console.error(`--- ${m.label} ---`);
    console.error('  expected:', JSON.stringify(m.expected));
    console.error('  actual:  ', JSON.stringify(m.actual));
  }
  process.exitCode = 1;
} else {
  console.log('ground-truth-check: all node-by-node assertions passed (3 targets, ' + mismatches.length + ' mismatches)');
}

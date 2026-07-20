#!/usr/bin/env node
'use strict';
// v0.7 integrator regression: "CALLERS-DIRECTION OUTPUT MUST NOT CHANGE"
// (pinned bar). Both v0.7 features (forward tracing, multi-package
// awareness) are additive per the GOAL -- this script proves the reverse
// (callers) direction is byte-for-byte identical, edge for edge, before
// and after the v0.7 changes, on 10 FIXED targets against the full
// (now-larger, post-Corpus-phase) adv-org corpus.
//
// Method: same technique as dev/verify-h1-manifest-edge-diff.js (v0.6
// integrator) -- run buildCallerTree for each target through the REAL,
// previously-published resolver.js (extracted from
// apex-call-graph-0.6.0.vsix, the last release before this v0.7 round) and
// through the CURRENT (v0.7-dev) resolver.js, using the SAME parser.js
// (byte-identical between the two -- parser.js is frozen this round, no
// cache version bump) and the SAME (current, v0.7 Corpus-phase) file set,
// so the only variable is the resolver.js source itself.
//
// Bar: for every target, the edge set must be IDENTICAL -- missing.length
// === 0 AND added.length === 0 (stricter than v0.6's H1 check, which only
// required no information LOSS; v0.7 requires no drift at all in either
// direction, since callers-direction is pinned unchanged, not merely
// "correct").
//
// Usage: node dev/regress-callers-v07.js

const path = require('path');
const fs = require('fs');

const REPO_ROOT = path.join(__dirname, '..');
const parser = require(path.join(REPO_ROOT, 'parser.js'));
const newResolver = require(path.join(REPO_ROOT, 'resolver.js'));

const OLD_RESOLVER_PATH = '/private/tmp/claude-502/-Users-agent-work-code-vcs-plugins/97303195-81fd-481b-8a8f-5439dcdbafa3/scratchpad/v060extract/extension/resolver.js';
if (!fs.existsSync(OLD_RESOLVER_PATH)) {
  console.error(`v0.6.0 resolver.js not found at ${OLD_RESOLVER_PATH} -- extract apex-call-graph-0.6.0.vsix first.`);
  process.exit(2);
}
const oldParserPath = OLD_RESOLVER_PATH.replace(/resolver\.js$/, 'parser.js');
const parserDiffers = fs.existsSync(oldParserPath) && fs.readFileSync(oldParserPath, 'utf8') !== fs.readFileSync(path.join(REPO_ROOT, 'parser.js'), 'utf8');
if (parserDiffers) {
  console.error('parser.js differs between v0.6.0 and current tree -- this script assumes a frozen parser.js this round. Aborting.');
  process.exit(2);
}
const oldResolver = require(OLD_RESOLVER_PATH);

// Walk the WHOLE adv-org root (not just force-app) -- v0.7's Corpus phase
// added pkg-billing/ and pkg-shared/ as sibling packageDirectory roots, and
// the regression must prove callers-direction is unchanged against the
// FULL post-Corpus-phase file set, not a stale force-app-only subset.
const ADV_ORG_ROOT = 'test-fixtures/adv-org';

function walkFiles(dir, out) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (ent.name === '__tests__' || ent.name === 'node_modules' || ent.name === 'scripts') continue;
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) walkFiles(p, out);
    else out.push(p);
  }
}
const allFiles = [];
walkFiles(ADV_ORG_ROOT, allFiles);
const apexFiles = allFiles.filter((f) => /\.(cls|trigger|apex)$/.test(f));
console.log(`Loaded ${apexFiles.length} apex files from the full adv-org tree (post v0.7 Corpus phase).`);

const factsList = apexFiles.map((p) => parser.parseFile({ path: p, text: fs.readFileSync(p, 'utf8') }));

// Old resolver.js predates opts.packageOf entirely -- call it exactly as
// v0.6.0 always did (no opts). New resolver.js is ALSO called with no opts
// here deliberately: this script isolates the "no sfdx-project.json
// awareness" baseline behavior (B1's own "no opts -> byte-identical"
// contract is covered separately by the B-owner's packageless-workspace
// identity check) -- it is purely about whether the CALLERS walker itself
// drifted, independent of the new opts.packageOf plumbing.
const oldIndex = oldResolver.buildSemanticIndex(factsList);
const newIndex = newResolver.buildSemanticIndex(factsList);

// 10 FIXED targets, spanning the shapes most likely to expose drift:
// heavy fan-in, overload collapse, interface fan-out, inheritance/override
// chains, cycles, class-level (ctor) targets, and trigger-handler edges.
const TARGETS = [
  { classLower: 'acmeorderservice', methodLower: 'processorders', label: 'AcmeOrderService.processOrders' },
  { classLower: 'acmenotificationdispatcher', methodLower: 'dispatchtoall', label: 'AcmeNotificationDispatcher.dispatchToAll' },
  { classLower: 'acmepricingengine', methodLower: 'calculateprice', label: 'AcmePricingEngine.calculatePrice' },
  { classLower: 'acmeordervalidator', methodLower: 'validate', label: 'AcmeOrderValidator.validate (cycle member)' },
  { classLower: 'acmeshipmentservice', methodLower: 'processshipments', label: 'AcmeShipmentService.processShipments' },
  { classLower: 'acmeorderutil', methodLower: 'normalize', label: 'AcmeOrderUtil.normalize' },
  { classLower: 'acmeordertriggerhandler', methodLower: 'handle', label: 'AcmeOrderTriggerHandler.handle' },
  { classLower: 'acmeshapeintermediate', methodLower: 'surchargefactor', label: 'AcmeShapeIntermediate.surchargeFactor (override chain)' },
  { classLower: 'acmeorderbatchprocessor', methodLower: 'execute', label: 'AcmeOrderBatchProcessor.execute (async target)' },
  { classLower: 'acmequotebuilder', methodLower: 'build', label: 'AcmeQuoteBuilder.build' },
];

function nodeIdentity(node) {
  if (node.via === 'lexical') return `LEX#${(node.className || '').toLowerCase()}`;
  const cls = (node.className || '').toLowerCase();
  const m = node.methodLower || '(class)';
  return `${cls}#${m}`;
}

function collectEdges(root) {
  const edges = new Set();
  function walk(node, parentIdentity) {
    if (parentIdentity !== null) {
      edges.add(`${parentIdentity}|||${nodeIdentity(node)}|||${node.via}`);
    }
    const myIdentity = nodeIdentity(node);
    for (const c of node.children || []) walk(c, myIdentity);
  }
  walk(root, null);
  return edges;
}

let overallPass = true;
const summary = [];

for (const target of TARGETS) {
  const oldTree = oldResolver.buildCallerTree(oldIndex, target, {});
  const newTree = newResolver.buildCallerTree(newIndex, target, {});

  const oldEdges = collectEdges(oldTree.root);
  const newEdges = collectEdges(newTree.root);

  const missing = [...oldEdges].filter((e) => !newEdges.has(e));
  const added = [...newEdges].filter((e) => !oldEdges.has(e));
  const identical = missing.length === 0 && added.length === 0;

  console.log(`\n=== ${target.label} ===`);
  console.log(`OLD (v0.6.0): ${oldEdges.size} edges`);
  console.log(`NEW (v0.7-dev): ${newEdges.size} edges, stats=${JSON.stringify(newTree.stats)}`);
  console.log(`identical: ${identical ? 'YES' : 'NO'} (missing=${missing.length}, added=${added.length})`);

  if (!identical) {
    overallPass = false;
    if (missing.length > 0) {
      console.log('MISSING EDGES (in OLD, not in NEW):');
      for (const e of missing.slice(0, 30)) console.log('  ' + e.replace(/\|\|\|/g, ' -> '));
      if (missing.length > 30) console.log(`  ... and ${missing.length - 30} more`);
    }
    if (added.length > 0) {
      console.log('ADDED EDGES (in NEW, not in OLD):');
      for (const e of added.slice(0, 30)) console.log('  ' + e.replace(/\|\|\|/g, ' -> '));
      if (added.length > 30) console.log(`  ... and ${added.length - 30} more`);
    }
  }

  summary.push({ label: target.label, oldCount: oldEdges.size, newCount: newEdges.size, missing: missing.length, added: added.length, identical });
}

console.log('\n=== SUMMARY ===');
console.log('target'.padEnd(58) + 'old'.padEnd(6) + 'new'.padEnd(6) + 'missing'.padEnd(9) + 'added'.padEnd(7) + 'identical');
for (const s of summary) {
  console.log(
    s.label.slice(0, 56).padEnd(58) +
    String(s.oldCount).padEnd(6) +
    String(s.newCount).padEnd(6) +
    String(s.missing).padEnd(9) +
    String(s.added).padEnd(7) +
    (s.identical ? 'YES' : 'NO')
  );
}

console.log(`\nOVERALL: ${overallPass ? 'PASS -- callers direction byte-for-byte identical on all 10 fixed targets' : 'FAIL'}`);
process.exitCode = overallPass ? 0 : 1;

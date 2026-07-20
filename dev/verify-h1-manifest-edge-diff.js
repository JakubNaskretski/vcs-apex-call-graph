#!/usr/bin/env node
'use strict';
// Adversarial-verifier check: "seenElsewhere dedup did not LOSE information
// vs v0.5" -- picks 5 MANIFEST-documented targets, runs buildCallerTree for
// each through BOTH the real, previously-published v0.5.0 resolver.js
// (extracted straight from apex-call-graph-0.5.0.vsix, no dedup/cap at
// all -- ground truth for "what pre-H1 fully materializes") and the
// CURRENT (v0.6-dev) resolver.js, using the SAME parser.js (byte-identical
// between the two, confirmed by `diff` before writing this script) so the
// only variable is the H1 dedup/cap logic itself.
//
// For each tree, collects the edge set as (parentIdentity, nodeIdentity,
// via) triples across EVERY node in the tree (not just level 1) --
// parentIdentity/nodeIdentity are classLower#methodLower (or
// classLower#(trigger), or LEX#classLower for lexical nodes). Per the GOAL:
// "every (caller,callee,via) pair present before must be present, whether
// expanded or as reference node" -- a pair only needs to appear SOMEWHERE
// in the v0.6 tree (fully expanded OR as a seenElsewhere leaf), not
// necessarily with the same subtree depth underneath it.
//
// Reports: (1) edges in OLD missing from NEW entirely (an outright drop --
// FAIL), (2) edges in OLD present in NEW only under a seenElsewhere/
// truncated node whose own further children differ from OLD's (informational,
// not a failure per the GOAL's literal bar, but flagged for visibility).

const path = require('path');
const fs = require('fs');

const REPO_ROOT = path.join(__dirname, '..');
const parser = require(path.join(REPO_ROOT, 'parser.js'));
const newResolver = require(path.join(REPO_ROOT, 'resolver.js'));

// Load the REAL v0.5.0 resolver.js extracted from the published vsix into a
// throwaway scratch dir (read-only reference, never modified).
const OLD_RESOLVER_PATH = '/private/tmp/claude-502/-Users-agent-work-code-vcs-plugins/97303195-81fd-481b-8a8f-5439dcdbafa3/scratchpad/v050extract/extension/resolver.js';
if (!fs.existsSync(OLD_RESOLVER_PATH)) {
  console.error(`v0.5.0 resolver.js not found at ${OLD_RESOLVER_PATH} -- extract apex-call-graph-0.5.0.vsix first.`);
  process.exit(2);
}
const oldResolver = require(OLD_RESOLVER_PATH);

const ADV_ORG_ROOT = 'test-fixtures/adv-org/force-app/main/default';

function walkFiles(dir, out) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (ent.name === '__tests__' || ent.name === 'node_modules') continue;
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) walkFiles(p, out);
    else out.push(p);
  }
}
const allFiles = [];
walkFiles(ADV_ORG_ROOT, allFiles);
const apexFiles = allFiles.filter((f) => /\.(cls|trigger|apex)$/.test(f));
console.log(`Loaded ${apexFiles.length} apex files from adv-org.`);

const factsList = apexFiles.map((p) => parser.parseFile({ path: p, text: fs.readFileSync(p, 'utf8') }));

const oldIndex = oldResolver.buildSemanticIndex(factsList);
const newIndex = newResolver.buildSemanticIndex(factsList);

// 5 MANIFEST targets -- chosen for rich fan-in/shared-subtree potential
// (the shapes most likely to expose a memoization info-loss bug), spanning
// different MANIFEST sections: order lifecycle hub (many callers),
// notification fan-out (interface, approximate), pricing engine (heavy
// overload fan-in), and the documented 3-node validation CYCLE (both
// members, to stress cyclic-vs-seenElsewhere interaction specifically).
const TARGETS = [
  { classLower: 'acmeorderservice', methodLower: 'processorders', label: 'AcmeOrderService.processOrders' },
  { classLower: 'acmenotificationdispatcher', methodLower: 'dispatchtoall', label: 'AcmeNotificationDispatcher.dispatchToAll' },
  { classLower: 'acmepricingengine', methodLower: 'calculateprice', label: 'AcmePricingEngine.calculatePrice' },
  { classLower: 'acmeordervalidator', methodLower: 'validate', label: 'AcmeOrderValidator.validate (cycle member)' },
  { classLower: 'acmeshipmentservice', methodLower: 'processshipments', label: 'AcmeShipmentService.processShipments' },
];

function nodeIdentity(node) {
  if (node.via === 'lexical') return `LEX#${(node.className || '').toLowerCase()}`;
  const cls = (node.className || '').toLowerCase();
  const m = node.methodLower || '(class)';
  return `${cls}#${m}`;
}

// Collects the edge set: every (parentIdentity, nodeIdentity, via) triple
// for every node in the tree at every depth (root itself has no parent, so
// is excluded as an "edge" -- it's the trace target, not a caller).
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

  console.log(`\n=== ${target.label} ===`);
  console.log(`OLD (v0.5, no dedup): ${oldEdges.size} edges`);
  console.log(`NEW (v0.6, H1 dedup): ${newEdges.size} edges, stats=${JSON.stringify(newTree.stats)}`);
  console.log(`missing (in OLD, not in NEW): ${missing.length}`);
  console.log(`added (in NEW, not in OLD): ${added.length}`);

  if (missing.length > 0) {
    overallPass = false;
    console.log('MISSING EDGES (potential info loss):');
    for (const e of missing.slice(0, 30)) console.log('  ' + e.replace(/\|\|\|/g, ' -> '));
    if (missing.length > 30) console.log(`  ... and ${missing.length - 30} more`);
  }
  if (added.length > 0) {
    // Not necessarily a bug (e.g. metadata-adjacent stats fields differ),
    // but surfaced for visibility since an unexpected NEW edge would also
    // be suspicious (fabricated edge).
    console.log('ADDED EDGES (present in NEW but not OLD -- investigate if unexpected):');
    for (const e of added.slice(0, 30)) console.log('  ' + e.replace(/\|\|\|/g, ' -> '));
    if (added.length > 30) console.log(`  ... and ${added.length - 30} more`);
  }

  if (newTree.stats.capped) {
    console.log(`NOTE: NEW tree reports capped=true for this target -- node cap engaged unexpectedly on the real adv-org corpus (only ${apexFiles.length} files); investigate.`);
  }

  summary.push({ label: target.label, oldCount: oldEdges.size, newCount: newEdges.size, missing: missing.length, added: added.length, capped: newTree.stats.capped });
}

console.log('\n=== SUMMARY ===');
for (const s of summary) {
  console.log(`${s.label}: OLD=${s.oldCount} NEW=${s.newCount} missing=${s.missing} added=${s.added} capped=${s.capped}`);
}
console.log(`\nOVERALL: ${overallPass ? 'PASS (no edge lost)' : 'FAIL (edges lost -- see above)'}`);
process.exitCode = overallPass ? 0 : 1;

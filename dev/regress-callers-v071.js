#!/usr/bin/env node
'use strict';
// v0.7.1 integrator regression: enforces the round's REGRESSION POLICY
// verbatim --
//
//   "Callers-direction output must be identical to v0.7.0 EXCEPT:
//    (a) R4 adds override-fanout edges for self-dispatched virtual hooks
//        (approximate, via 'override') -- these are the ONLY permitted
//        additions;
//    (b) R1/R2/R3 REMOVE edges that were false (each removal must match a
//        documented gauntlet false-edge)."
//
// on 12 FIXED targets: the same 10 adv-org targets dev/regress-callers-v07.js
// pinned last round (expected fully unchanged -- none of the v0.7.1 findings
// were sourced from adv-org), plus 2 NEW gauntlet-org targets that each
// exercise exactly one permitted-change category:
//
//   - Billing.charge (callers)              -- (b) R1 removal: the false
//     `zenq.Billing.charge(...)` site (VertexLedgerBridge.cls:19) must
//     disappear; the genuine local `Billing.charge(...)` site (line 3) must
//     remain untouched.
//   - KappaOrderTriggerHandler.afterInsert (callers) -- (a) R4 addition: a
//     brand-new `KappaTriggerHandler.run` caller node, via='override' (the
//     template-method self-dispatch fan-out fix -- VALIDATION-REPORT.md
//     Tier-3 #6 / fix backlog #7).
//
// Method: same technique as dev/regress-callers-v07.js -- run buildCallerTree
// through the REAL, previously-PUBLISHED resolver.js (extracted from
// apex-call-graph-0.7.0.vsix, the last release before this v0.7.1 round) and
// through the CURRENT (v0.7.1-dev) resolver.js, using the SAME parser.js
// (byte-identical between the two -- parser.js is FROZEN this round) and the
// SAME file set for each corpus, so the only variable is resolver.js itself.
//
// Edge identity is SITE-level, not just node-level: a node persisting with
// one fewer site (the R1/R2/R3 shape -- the false site vanishes, a genuine
// sibling site on the SAME caller node survives) must be caught just as
// surely as a node appearing/disappearing outright. Each edge key encodes
// (parent identity, child identity, via, child's site line) so a single
// dropped site under an otherwise-unchanged node registers as one REMOVED
// edge, not zero.
//
// Usage: node dev/regress-callers-v071.js

const path = require('path');
const fs = require('fs');

const REPO_ROOT = path.join(__dirname, '..');
const parser = require(path.join(REPO_ROOT, 'parser.js'));
const newResolver = require(path.join(REPO_ROOT, 'resolver.js'));

const OLD_RESOLVER_PATH = '/private/tmp/claude-502/-Users-agent-work-code-vcs-plugins/97303195-81fd-481b-8a8f-5439dcdbafa3/scratchpad/v070extract/extension/resolver.js';
if (!fs.existsSync(OLD_RESOLVER_PATH)) {
  console.error(`v0.7.0 resolver.js not found at ${OLD_RESOLVER_PATH} -- extract apex-call-graph-0.7.0.vsix first.`);
  process.exit(2);
}
const oldParserPath = OLD_RESOLVER_PATH.replace(/resolver\.js$/, 'parser.js');
const parserDiffers = fs.existsSync(oldParserPath) && fs.readFileSync(oldParserPath, 'utf8') !== fs.readFileSync(path.join(REPO_ROOT, 'parser.js'), 'utf8');
if (parserDiffers) {
  console.error('parser.js differs between v0.7.0 and current tree -- this script assumes a frozen parser.js this round. Aborting.');
  process.exit(2);
}
const oldResolver = require(OLD_RESOLVER_PATH);

function walkFiles(dir, out) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (ent.name === '__tests__' || ent.name === 'node_modules' || ent.name === 'scripts' || ent.name === '.git' || ent.name === '.sfdx' || ent.name === '.sf') continue;
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) walkFiles(p, out);
    else out.push(p);
  }
}

function loadIndex(resolverMod, rootDir, apexOnly) {
  const allFiles = [];
  walkFiles(rootDir, allFiles);
  const apexFiles = allFiles.filter((f) => /\.(cls|trigger|apex)$/i.test(f));
  const factsList = apexFiles.map((p) => parser.parseFile({ path: p, text: fs.readFileSync(p, 'utf8') }));
  return { index: resolverMod.buildSemanticIndex(factsList), fileCount: apexFiles.length };
}

// ---------------------------------------------------------------------
// Edge collection: SITE-level identity (see header note above).
// ---------------------------------------------------------------------
function nodeIdentity(node) {
  if (node.via === 'lexical') return `LEX#${(node.className || '').toLowerCase()}`;
  const cls = (node.className || '').toLowerCase();
  const m = node.methodLower || '(class)';
  return `${cls}#${m}`;
}

// `directOnly`: when true, only collects edges ONE hop from the root (the
// target's own direct callers) -- used to scope the "additions must be
// via='override'" policy check to the actual new-edge claim itself, not to
// every ancestor-of-an-ancestor edge that becomes reachable purely as a
// side effect of a brand-new root-level node existing (those deeper edges
// were already legitimate, pre-existing resolutions on THEIR OWN callers'
// trees -- R4 only ever adds the one direct fan-out edge; anything above
// that is ordinary tree expansion, not a second "addition" to police).
function collectSiteEdges(root, directOnly) {
  const edges = new Set();
  function walk(node, parentIdentity, depth) {
    const myIdentity = nodeIdentity(node);
    if (parentIdentity !== null) {
      const sites = Array.isArray(node.sites) && node.sites.length ? node.sites : [{ line: 0 }];
      for (const s of sites) {
        edges.add(`${parentIdentity}|||${myIdentity}|||${node.via}|||L${s.line}`);
      }
    }
    if (directOnly && depth >= 1) return;
    for (const c of node.children || []) walk(c, myIdentity, depth + 1);
  }
  walk(root, null, 0);
  return edges;
}

function diffTargets(oldIndex, newIndex, targets, corpusLabel) {
  const results = [];
  for (const target of targets) {
    const oldTree = oldResolver.buildCallerTree(oldIndex, target, {});
    const newTree = newResolver.buildCallerTree(newIndex, target, {});
    const oldEdges = collectSiteEdges(oldTree.root, false);
    const newEdges = collectSiteEdges(newTree.root, false);
    const missing = [...oldEdges].filter((e) => !newEdges.has(e)); // removed
    const added = [...newEdges].filter((e) => !oldEdges.has(e)); // added
    const oldDirect = collectSiteEdges(oldTree.root, true);
    const newDirect = collectSiteEdges(newTree.root, true);
    const missingDirect = [...oldDirect].filter((e) => !newDirect.has(e));
    const addedDirect = [...newDirect].filter((e) => !oldDirect.has(e));
    results.push({ corpusLabel, target, oldEdges, newEdges, missing, added, missingDirect, addedDirect });
  }
  return results;
}

// ---------------------------------------------------------------------
// 1. adv-org: 10 FIXED targets pinned unchanged (byte-identical bar, exactly
//    as dev/regress-callers-v07.js required last round -- none of the
//    v0.7.1 findings were sourced from this corpus).
// ---------------------------------------------------------------------
const ADV_ORG_ROOT = '/Users/agent/work/code/example-data/adv-org';
const advOld = loadIndex(oldResolver, ADV_ORG_ROOT);
const advNew = loadIndex(newResolver, ADV_ORG_ROOT);
console.log(`adv-org: loaded ${advOld.fileCount} apex files (old) / ${advNew.fileCount} (new).`);

const ADV_ORG_TARGETS = [
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

// ---------------------------------------------------------------------
// 2. gauntlet-org: 2 NEW targets, one per permitted-change category.
// ---------------------------------------------------------------------
const GAUNTLET_ORG_ROOT = '/Users/agent/work/code/example-data/gauntlet-org/force-app';
const gauntletOld = loadIndex(oldResolver, GAUNTLET_ORG_ROOT);
const gauntletNew = loadIndex(newResolver, GAUNTLET_ORG_ROOT);
console.log(`gauntlet-org: loaded ${gauntletOld.fileCount} apex files (old) / ${gauntletNew.fileCount} (new).`);

const GAUNTLET_TARGETS = [
  { classLower: 'billing', methodLower: 'charge', label: 'Billing.charge (R1 removal case)', expect: 'removal' },
  { classLower: 'kappaordertriggerhandler', methodLower: 'afterinsert', label: 'KappaOrderTriggerHandler.afterInsert (R4 addition case)', expect: 'addition' },
];

const allResults = [
  ...diffTargets(advOld.index, advNew.index, ADV_ORG_TARGETS, 'adv-org'),
  ...diffTargets(gauntletOld.index, gauntletNew.index, GAUNTLET_TARGETS, 'gauntlet-org'),
];

// ---------------------------------------------------------------------
// 3. Policy enforcement.
// ---------------------------------------------------------------------
let overallPass = true;
const summary = [];

for (const r of allResults) {
  const { corpusLabel, target, missing, added } = r;
  console.log(`\n=== [${corpusLabel}] ${target.label} ===`);
  console.log(`OLD (v0.7.0): ${r.oldEdges.size} site-edges`);
  console.log(`NEW (v0.7.1-dev): ${r.newEdges.size} site-edges`);
  console.log(`missing (removed): ${missing.length}, added: ${added.length}`);

  let targetOk = true;
  const notes = [];

  if (corpusLabel === 'adv-org') {
    // Byte-identical bar: zero drift permitted.
    if (missing.length || added.length) {
      targetOk = false;
      notes.push('adv-org target drifted -- POLICY VIOLATION (adv-org MANIFEST edges must be unaffected).');
      for (const e of missing) notes.push('  REMOVED: ' + e.replace(/\|\|\|/g, ' -> '));
      for (const e of added) notes.push('  ADDED:   ' + e.replace(/\|\|\|/g, ' -> '));
    } else {
      notes.push('byte-identical to v0.7.0: OK.');
    }
  } else if (target.expect === 'removal') {
    // (b) R1/R2/R3: only REMOVALS permitted, zero additions -- checked at
    // the DIRECT (root's own children) level, which is where the false
    // edge actually lived; the whole-tree numbers above are printed for
    // visibility only.
    if (r.addedDirect.length) {
      targetOk = false;
      notes.push(`unexpected ADDED direct edge(s) on a removal-only target -- POLICY VIOLATION: ${JSON.stringify(r.addedDirect)}`);
    }
    if (r.missingDirect.length !== 1) {
      targetOk = false;
      notes.push(`expected exactly 1 removed direct edge (the documented false zenq.Billing.charge site, VertexLedgerBridge.cls:19), got ${r.missingDirect.length}: ${JSON.stringify(r.missingDirect)}`);
    } else if (!/\bL19\b/.test(r.missingDirect[0])) {
      targetOk = false;
      notes.push(`removed edge is not the documented false edge (expected line 19): ${r.missingDirect[0]}`);
    } else {
      notes.push('removed edge matches the documented gauntlet false-edge (VertexLedgerBridge.cls:19, zenq.Billing.charge): OK.');
    }
    // The genuine local Billing.charge(...) site (line 3) must survive untouched.
    const genuineSurvives = [...r.newEdges].some((e) => e.includes('vertexledgerbridge#posttoledger') && /\bL3\b/.test(e));
    if (!genuineSurvives) {
      targetOk = false;
      notes.push('genuine local Billing.charge(...) call site (line 3) is missing from the NEW tree -- over-removal.');
    } else {
      notes.push('genuine local call site (line 3) survives: OK.');
    }
  } else if (target.expect === 'addition') {
    // (a) R4: only ADDITIONS permitted, zero removals anywhere in the tree,
    // and the DIRECT (root-level) addition specifically must be
    // via='override' -- deeper (ancestor-of-ancestor) edges that become
    // reachable purely because the new root node exists are ordinary tree
    // expansion, not additional "additions" to police (see collectSiteEdges'
    // directOnly header note).
    if (missing.length) {
      targetOk = false;
      notes.push(`unexpected REMOVED edge(s) anywhere in the tree on an addition-only target -- POLICY VIOLATION: ${JSON.stringify(missing)}`);
    }
    if (r.addedDirect.length < 1) {
      targetOk = false;
      notes.push('expected at least 1 added DIRECT edge (KappaTriggerHandler.run override fan-out), got none.');
    }
    const nonOverride = r.addedDirect.filter((e) => !/\|\|\|override\|\|\|/.test(e));
    if (nonOverride.length) {
      targetOk = false;
      notes.push(`added direct edge(s) not via='override' -- POLICY VIOLATION (R4 is the only permitted addition path): ${JSON.stringify(nonOverride)}`);
    }
    const hasHandlerRun = r.addedDirect.some((e) => e.includes('kappatriggerhandler#run'));
    if (!hasHandlerRun) {
      targetOk = false;
      notes.push('expected added direct edge to reference kappatriggerhandler#run specifically.');
    }
    if (targetOk) notes.push(`added direct edge(s) match the documented R4 override fan-out: OK (${JSON.stringify(r.addedDirect)}); ${added.length - r.addedDirect.length} deeper ancestor edge(s) also newly reachable (expected, not policed).`);
  }

  for (const n of notes) console.log(n);
  if (!targetOk) overallPass = false;
  summary.push({ corpusLabel, label: target.label, oldCount: r.oldEdges.size, newCount: r.newEdges.size, missing: missing.length, added: added.length, ok: targetOk });
}

console.log('\n=== SUMMARY ===');
console.log('corpus'.padEnd(14) + 'target'.padEnd(58) + 'old'.padEnd(6) + 'new'.padEnd(6) + 'missing'.padEnd(9) + 'added'.padEnd(7) + 'result');
for (const s of summary) {
  console.log(
    s.corpusLabel.padEnd(14) +
    s.label.slice(0, 56).padEnd(58) +
    String(s.oldCount).padEnd(6) +
    String(s.newCount).padEnd(6) +
    String(s.missing).padEnd(9) +
    String(s.added).padEnd(7) +
    (s.ok ? 'PASS' : 'FAIL')
  );
}

console.log(`\nOVERALL: ${overallPass ? 'PASS -- REGRESSION POLICY satisfied on all 12 targets (10 adv-org unchanged + 2 gauntlet-org permitted-change cases)' : 'FAIL'}`);
process.exitCode = overallPass ? 0 : 1;

#!/usr/bin/env node
'use strict';
// v0.8 integrator regression: enforces the round's REGRESSION POLICY
// verbatim --
//
//   "Only permitted deltas vs v0.7.1: (a) references previously counted
//    unresolved/metaUnresolved that match N1 shapes become external
//    edges/nodes; (b) header wording per N5; (c) own-namespace fixtures
//    resolve locally (new corpus only). EVERYTHING else byte-identical:
//    enforce with a site-level diff script on 12 fixed targets (10 adv-org
//    -- which has NO namespaced refs, so must be 100% byte-identical incl.
//    headers except stats field additions -- + 2 gauntlet namespace
//    targets showing exactly the documented category-(a) deltas)."
//
// Method: same technique as dev/regress-callers-v071.js -- run
// buildCallerTree/buildCalleeTree through the REAL, previously-PUBLISHED
// engine (extracted from apex-call-graph-0.7.1.vsix, the last release
// before this v0.8 round) and through the CURRENT engine, using the SAME
// parser.js for both (loadIndex below takes a resolverMod parameter but
// always calls the ONE `parser` required at top of this file -- there has
// never been a second, old parser.js instance in play here) and the SAME
// file set for each corpus, so the only variable is
// resolver.js/metascan.js/uitree.js themselves.
//
// v0.11 Round B NOTE: parser.js is IN SCOPE this round for the first time
// since v0.5 (MethodFacts.locals[].literal / TypeFacts.constants[], both
// purely additive per the round's CONTRACT). The guard below used to hard-
// abort on ANY parser.js text delta ("parser.js is FROZEN this round" was
// true for v0.8/v0.9/v0.10, not v0.11) -- that would make this script
// permanently unrunnable this round even though nothing it actually
// EXERCISES has changed: this script never loads a second, old parser.js
// (see above), so an additive-only parser.js change can't affect anything
// this diff checks. The precise "parser output is unchanged except the two
// additive fields" claim is independently proven by the dedicated FileFacts
// snapshot pin test (test-parser.js), which IS a real byte-for-byte check
// of the shape this comment used to (incorrectly) delegate to a raw file
// diff. This script now only WARNS when parser.js has moved, rather than
// aborting -- the warning is a breadcrumb for the next round that also
// expects parser.js frozen, not a claim that this script itself re-verifies
// parser.js's additive-only contract.
//
// Edge identity is SITE-level (parent identity, child identity, via, kind,
// child's site line), same as dev/regress-callers-v071.js, PLUS a header-
// line diff (uitree.shapeHeaderLines) with an explicit, narrow allowance
// for the N5 wording swap ("N call sites ... could not be resolved" ->
// "N unresolved * M managed-package refs (ns...)") and the additive
// stats.externalRefs/externalNamespaces fields.
//
// Usage: node dev/regress-v08.js

const path = require('path');
const fs = require('fs');

const REPO_ROOT = path.join(__dirname, '..');
const parser = require(path.join(REPO_ROOT, 'parser.js'));
const newResolver = require(path.join(REPO_ROOT, 'resolver.js'));
const newUitree = require(path.join(REPO_ROOT, 'uitree.js'));

const OLD_ROOT = '/private/tmp/claude-502/-Users-agent-work-code-vcs-plugins/97303195-81fd-481b-8a8f-5439dcdbafa3/scratchpad/v071extract/extension';
const OLD_RESOLVER_PATH = path.join(OLD_ROOT, 'resolver.js');
if (!fs.existsSync(OLD_RESOLVER_PATH)) {
  console.error(`v0.7.1 resolver.js not found at ${OLD_RESOLVER_PATH} -- extract apex-call-graph-0.7.1.vsix first (unzip -o apex-call-graph-0.7.1.vsix -d <that dir>).`);
  process.exit(2);
}
const oldParserPath = path.join(OLD_ROOT, 'parser.js');
const parserDiffers = fs.existsSync(oldParserPath) && fs.readFileSync(oldParserPath, 'utf8') !== fs.readFileSync(path.join(REPO_ROOT, 'parser.js'), 'utf8');
if (parserDiffers) {
  // v0.11 Round B: parser.js is explicitly in scope this round (additive
  // MethodFacts.locals[].literal / TypeFacts.constants[] only) -- see this
  // file's own header NOTE for why a text delta here no longer aborts the
  // script. Not an error condition this round; still worth surfacing.
  console.log('NOTE: parser.js differs from the v0.7.1 baseline (expected this round -- v0.11 Round B\'s additive locals[].literal/TypeFacts.constants[] fields; see test-parser.js\'s FileFacts snapshot pin for the byte-for-byte proof that nothing else moved). Continuing.');
}
const oldResolver = require(OLD_RESOLVER_PATH);
const oldUitreePath = path.join(OLD_ROOT, 'uitree.js');
const oldUitree = fs.existsSync(oldUitreePath) ? require(oldUitreePath) : null;

function walkFiles(dir, out) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (ent.name === '__tests__' || ent.name === 'node_modules' || ent.name === 'scripts' || ent.name === '.git' || ent.name === '.sfdx' || ent.name === '.sf') continue;
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) walkFiles(p, out);
    else out.push(p);
  }
}

function loadIndex(resolverMod, rootDir) {
  const allFiles = [];
  walkFiles(rootDir, allFiles);
  const apexFiles = allFiles.filter((f) => /\.(cls|trigger|apex)$/i.test(f));
  const factsList = apexFiles.map((p) => parser.parseFile({ path: p, text: fs.readFileSync(p, 'utf8') }));
  return { index: resolverMod.buildSemanticIndex(factsList), fileCount: apexFiles.length };
}

// ---------------------------------------------------------------------
// Edge collection: SITE-level identity, includes `kind` (v0.8 adds a new
// discriminator -- 'external' -- that a pure via-based identity could
// otherwise miss if a future bug ever mislabeled an external node's via as
// something pre-existing).
// ---------------------------------------------------------------------
function nodeIdentity(node) {
  if (node.via === 'lexical') return `LEX#${(node.className || '').toLowerCase()}`;
  const cls = (node.className || node.label || '').toLowerCase();
  const m = node.methodLower || '(class)';
  const kind = node.kind || '';
  return `${cls}#${m}#${kind}`;
}

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

// Header-line diff, gated by the ONE permitted N5 wording swap. Every other
// header line must be byte-identical.
function diffHeaderLines(oldLines, newLines) {
  if (!Array.isArray(oldLines) || !Array.isArray(newLines)) return { ok: true, notes: ['header lines unavailable on one side -- skipped'] };
  if (oldLines.length !== newLines.length) {
    return { ok: false, notes: [`header line COUNT differs: old=${JSON.stringify(oldLines)} new=${JSON.stringify(newLines)}`] };
  }
  const notes = [];
  let ok = true;
  const N5_OLD_RE = /^(\d+) call sites workspace-wide could not be resolved \(dynamic\/platform\/deep-chain\)\.$/;
  const N5_NEW_RE = /^(\d+) unresolved · (\d+) managed-package refs? \([^)]*\)\.$/;
  for (let i = 0; i < oldLines.length; i++) {
    if (oldLines[i] === newLines[i]) continue;
    const oldM = N5_OLD_RE.exec(oldLines[i]);
    const newM = N5_NEW_RE.exec(newLines[i]);
    if (oldM && newM) {
      notes.push(`header line ${i} permitted N5 wording swap: "${oldLines[i]}" -> "${newLines[i]}" (OK per REGRESSION POLICY (b))`);
      continue;
    }
    ok = false;
    notes.push(`header line ${i} UNEXPECTED CHANGE: "${oldLines[i]}" -> "${newLines[i]}"`);
  }
  return { ok, notes };
}

function diffTargets(oldIndex, newIndex, targets, corpusLabel, direction) {
  const buildOld = direction === 'callees' ? oldResolver.buildCalleeTree : oldResolver.buildCallerTree;
  const buildNew = direction === 'callees' ? newResolver.buildCalleeTree : newResolver.buildCallerTree;
  const results = [];
  for (const target of targets) {
    const oldTree = buildOld(oldIndex, target, {});
    const newTree = buildNew(newIndex, target, {});
    const oldEdges = collectSiteEdges(oldTree.root, false);
    const newEdges = collectSiteEdges(newTree.root, false);
    const missing = [...oldEdges].filter((e) => !newEdges.has(e));
    const added = [...newEdges].filter((e) => !oldEdges.has(e));
    const oldDirect = collectSiteEdges(oldTree.root, true);
    const newDirect = collectSiteEdges(newTree.root, true);
    const missingDirect = [...oldDirect].filter((e) => !newDirect.has(e));
    const addedDirect = [...newDirect].filter((e) => !oldDirect.has(e));
    const oldHeader = oldUitree ? oldUitree.shapeHeaderLines(oldTree) : null;
    const newHeader = newUitree.shapeHeaderLines(newTree);
    const headerDiff = diffHeaderLines(oldHeader, newHeader);
    results.push({ corpusLabel, target, oldEdges, newEdges, missing, added, missingDirect, addedDirect, headerDiff, oldHeader, newHeader });
  }
  return results;
}

// ---------------------------------------------------------------------
// 1. adv-org: 10 FIXED targets pinned unchanged (byte-identical bar -- the
//    SAME 10 targets dev/regress-callers-v071.js pinned; adv-org has NO
//    namespaced refs anywhere, per REGRESSION POLICY).
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
// 2. gauntlet-org: 2 NEW targets, callee direction, each showing exactly
//    the documented category-(a) delta ("references previously counted
//    unresolved/metaUnresolved that match N1 shapes become external
//    edges/nodes") -- per GROUND-TRUTH.md v0.8-A1/A2. Deliberately built
//    WITHOUT opts.ownNamespace on both sides (byte-identical opts to
//    dev/regress-callers-v071.js's own gauntlet-org load) so the v0.8-B
//    corpus additions (VtxOwnNamespaceProbe etc., own-namespace='vtx')
//    cannot perturb this specific diff -- ownNamespace plumbing is
//    covered separately by test.js's v0.8/N3 e2e and dev/gauntlet/run.js's
//    v0.8-B1 section.
// ---------------------------------------------------------------------
const GAUNTLET_ORG_ROOT = '/Users/agent/work/code/example-data/gauntlet-org/force-app';
const gauntletOld = loadIndex(oldResolver, GAUNTLET_ORG_ROOT);
const gauntletNew = loadIndex(newResolver, GAUNTLET_ORG_ROOT);
console.log(`gauntlet-org: loaded ${gauntletOld.fileCount} apex files (old) / ${gauntletNew.fileCount} (new).`);

const GAUNTLET_TARGETS = [
  { classLower: 'vertexledgerbridge', methodLower: 'posttoledger', label: 'VertexLedgerBridge.postToLedger (callees) -- v0.8-A1', expectAddedExternal: ['zenq.billing', 'kwx__ledger__c'] },
  { classLower: 'kappagatewaycaller', methodLower: 'routecommands', label: 'KappaGatewayCaller.routeCommands (callees) -- v0.8-A2', expectAddedExternal: ['zenq.kappagateway', 'kwx.kappagateway', 'zenq.kappagatewey'] },
];

const allResults = [
  ...diffTargets(advOld.index, advNew.index, ADV_ORG_TARGETS, 'adv-org', 'callers'),
  ...diffTargets(gauntletOld.index, gauntletNew.index, GAUNTLET_TARGETS, 'gauntlet-org', 'callees'),
];

// ---------------------------------------------------------------------
// 3. Policy enforcement.
// ---------------------------------------------------------------------
let overallPass = true;
const summary = [];

for (const r of allResults) {
  const { corpusLabel, target, missing, added, headerDiff } = r;
  console.log(`\n=== [${corpusLabel}] ${target.label} ===`);
  console.log(`OLD (v0.7.1): ${r.oldEdges.size} site-edges`);
  console.log(`NEW (v0.8-dev): ${r.newEdges.size} site-edges`);
  console.log(`missing (removed): ${missing.length}, added: ${added.length}`);
  console.log(`OLD header: ${JSON.stringify(r.oldHeader)}`);
  console.log(`NEW header: ${JSON.stringify(r.newHeader)}`);

  let targetOk = true;
  const notes = [];

  if (corpusLabel === 'adv-org') {
    // Byte-identical bar: zero drift permitted, incl. headers (except the
    // additive stats fields, which shapeHeaderLines never renders as text
    // unless externalRefs > 0 -- adv-org has none, so this corpus's header
    // wording cannot even reach the N5 branch).
    if (missing.length || added.length) {
      targetOk = false;
      notes.push('adv-org target drifted -- POLICY VIOLATION (adv-org must be 100% byte-identical, no namespaced refs exist here).');
      for (const e of missing) notes.push('  REMOVED: ' + e.replace(/\|\|\|/g, ' -> '));
      for (const e of added) notes.push('  ADDED:   ' + e.replace(/\|\|\|/g, ' -> '));
    } else {
      notes.push('site-edges byte-identical to v0.7.1: OK.');
    }
    if (!headerDiff.ok) {
      targetOk = false;
      notes.push('adv-org header line drifted -- POLICY VIOLATION:');
    }
    for (const n of headerDiff.notes) notes.push('  ' + n);
  } else {
    // gauntlet-org category-(a): only ADDITIONS permitted, zero removals
    // anywhere, and every added DIRECT edge must be kind='external'
    // (via='external', not approximate) matching the documented (ns,class)
    // pairs for this target.
    if (missing.length) {
      targetOk = false;
      notes.push(`unexpected REMOVED edge(s) -- POLICY VIOLATION (category-(a) is purely additive): ${JSON.stringify(missing)}`);
    }
    const nonExternalDirectAdds = r.addedDirect.filter((e) => !/#external\|\|\|external\|\|\|/.test(e));
    if (nonExternalDirectAdds.length) {
      targetOk = false;
      notes.push(`added direct edge(s) not kind='external'/via='external' -- POLICY VIOLATION (category-(a) only permits promoting unresolved refs to external nodes): ${JSON.stringify(nonExternalDirectAdds)}`);
    }
    const addedExternalKeys = r.addedDirect
      .map((e) => e.split('|||')[1])
      .filter((id) => id.endsWith('#external'))
      .map((id) => id.split('#')[0]);
    const missingExpected = (target.expectAddedExternal || []).filter((k) => !addedExternalKeys.includes(k.toLowerCase()));
    if (missingExpected.length) {
      targetOk = false;
      notes.push(`expected external node(s) not found among added direct edges: ${JSON.stringify(missingExpected)} (got ${JSON.stringify(addedExternalKeys)})`);
    } else {
      notes.push(`all documented external node(s) promoted as expected: ${JSON.stringify(target.expectAddedExternal)}: OK.`);
    }
    if (!headerDiff.ok) {
      targetOk = false;
      notes.push('gauntlet-org header line changed in an UNPERMITTED way -- POLICY VIOLATION:');
    }
    for (const n of headerDiff.notes) notes.push('  ' + n);
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

console.log(`\nOVERALL: ${overallPass ? 'PASS -- REGRESSION POLICY satisfied on all 12 targets (10 adv-org byte-identical + 2 gauntlet-org category-(a) promotions)' : 'FAIL'}`);
process.exitCode = overallPass ? 0 : 1;

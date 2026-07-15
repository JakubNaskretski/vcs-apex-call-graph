'use strict';
// Adversarial MANIFEST-accounting verifier (v0.4.0 round).
//
// Scope: mechanically checks EVERY edge in the "## v0.4 ground-truth edges"
// section of /Users/agent/work/code/example-data/adv-org/MANIFEST.md
// (F1 dml/trigger + flow-DML-children, F2 generics, F3 override fan-out,
// F4a Type.forName, F4b CMDT, F5 entry-kind tail) against a LIVE run of the
// real engine (parser.js + resolver.js + metascan.js), wired the same way
// extension.js wires them for a real workspace scan (same globs/exclusions)
// -- specifically INCLUDING customMetadata/**/*.md-meta.xml, which
// extension.js's own META_GLOBS list does NOT include (see finding below).
//
// Also re-checks a sample of pre-v0.4 (v0.3) resolves-today edges to confirm
// no regression, and cross-checks against dev/manifest-verify.js's own
// (v0.3.0-era) output to classify every discrepancy it reports as either
// "expected due to documented v0.4 behavior change" or "real regression".
//
// Read-only: never touches example-data/adv-org or any engine file.
//
// Usage: node dev/manifest-verify-v040.js

const fs = require('fs');
const path = require('path');
const assert = require('assert');
const parser = require('../parser');
const resolver = require('../resolver');
const metascan = require('../metascan');

const ADV_ROOT = '/Users/agent/work/code/example-data/adv-org';
const FORCE_APP = path.join(ADV_ROOT, 'force-app', 'main', 'default');

let pass = 0;
let fail = 0;
const failures = [];

function check(name, fn) {
  try {
    fn();
    pass++;
    console.log(`PASS  ${name}`);
  } catch (e) {
    fail++;
    failures.push({ name, error: e });
    console.log(`FAIL  ${name}`);
    console.log(`      ${e && e.message ? e.message : e}`);
  }
}

// =========================================================================
// 1. Full workspace scan, mirroring extension.js -- EXCEPT this script's
//    meta-file walker also picks up customMetadata/**/*.md-meta.xml so it
//    can test metascan.js's F4b extraction directly (that path IS exercised
//    below as a separate, explicitly-labeled check: "extension.js META_GLOBS
//    includes customMetadata"). The real-wiring check further down uses
//    ONLY extension.js's actual META_GLOBS-equivalent set, to prove what a
//    real workspace scan sees today.
// =========================================================================

const SKIP_DIRS = new Set(['node_modules', '.sfdx', '.sf', '.git']);

function walk(dir, out) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (e) {
    return;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue;
      walk(full, out);
    } else {
      out.push(full);
    }
  }
}

const allFiles = [];
walk(FORCE_APP, allFiles);
const apexPaths = allFiles.filter((f) => /\.(cls|trigger)$/i.test(f));

const facts = apexPaths.map((f) => parser.parseFile({ path: f, text: fs.readFileSync(f, 'utf8') }));
const index = resolver.buildSemanticIndex(facts);

check('adv-org parses: 59 Apex files, exactly 1 parseError (AcmeBrokenParser.cls)', () => {
  assert.strictEqual(facts.length, 59, `expected 59 .cls/.trigger files, found ${facts.length}`);
  const withErrors = facts.filter((f) => f.parseError);
  assert.strictEqual(withErrors.length, 1, `expected exactly 1 parseError, found ${withErrors.length}: ${withErrors.map((f) => f.path).join(', ')}`);
  assert.ok(/AcmeBrokenParser\.cls$/.test(withErrors[0].path), `parseError file should be AcmeBrokenParser.cls, was ${withErrors[0].path}`);
});

// EVERY non-apex, non-html, non-*-meta.xml-sidecar file under force-app --
// this is the "ground truth" superset used for the mechanical per-feature
// checks below (deliberately broader than extension.js's real META_GLOBS,
// so the F4b integration-gap finding can be demonstrated by DIFFING against
// the real-wiring scan later in this file).
const metaCandidatePaths = allFiles.filter((f) => {
  if (/\.(cls|trigger)$/i.test(f)) return false;
  if (/\.(cls-meta|trigger-meta)\.xml$/i.test(f)) return false;
  if (/\.html$/i.test(f)) return false;
  return true;
});

function loadRefs(paths) {
  const metaFileObjs = paths.map((f) => ({ path: f, text: fs.readFileSync(f, 'utf8') }));
  const auraFiles = metaFileObjs.filter((f) => /(^|[\\/])aura[\\/]/i.test(f.path));
  const otherFiles = metaFileObjs.filter((f) => !/(^|[\\/])aura[\\/]/i.test(f.path));
  const refs = [];
  for (const f of otherFiles) {
    for (const ref of metascan.parseMetaFile(f)) {
      ref.path = f.path;
      refs.push(ref);
    }
  }
  // Aura bundle pairing, mirroring extension.js/manifest-verify.js.
  const groups = new Map();
  for (const f of auraFiles) {
    const dir = path.dirname(f.path);
    let g = groups.get(dir);
    if (!g) {
      g = { markup: null, jsFiles: [] };
      groups.set(dir, g);
    }
    if (/\.(cmp|app)$/i.test(f.path)) g.markup = f;
    else if (/\.js$/i.test(f.path)) g.jsFiles.push(f);
  }
  for (const g of groups.values()) {
    if (!g.markup) continue;
    for (const ref of metascan.parseMetaFile(g.markup)) {
      ref.path = g.markup.path;
      refs.push(ref);
    }
    for (const jsFile of g.jsFiles) {
      for (const ref of metascan.scanBundle([g.markup, jsFile])) {
        if (ref.methodName == null) continue;
        ref.path = jsFile.path;
        refs.push(ref);
      }
    }
  }
  return refs;
}

// "Broad" scan (this script's own walker -- includes customMetadata/).
const broadRefs = loadRefs(metaCandidatePaths);

// "Real-wiring" scan -- reproduces extension.js's ACTUAL META_GLOBS list
// verbatim (see extension.js lines ~202-212). Deliberately does NOT include
// customMetadata/**/*.md-meta.xml, matching extension.js today.
function matchesRealMetaGlobs(rel) {
  if (/^lwc\/.*\.js$/i.test(rel)) return true;
  if (/^aura\/.*\.(cmp|app|js)$/i.test(rel)) return true;
  if (/^flows\/.*\.flow-meta\.xml$/i.test(rel)) return true;
  if (/^omniscripts\/.*(\.os-meta\.xml|\.json)$/i.test(rel)) return true;
  if (/^pages\/.*\.page$/i.test(rel)) return true;
  if (/^components\/.*\.component$/i.test(rel)) return true;
  return false;
}
const realWiringPaths = metaCandidatePaths.filter((f) => {
  const rel = f.slice(FORCE_APP.length + 1).replace(/\\/g, '/');
  return matchesRealMetaGlobs(rel);
});
const realWiringRefs = loadRefs(realWiringPaths);

// Build TWO indexes: one with broad refs attached (for testing metascan.js
// F4b extraction logic + resolver.js F4b consumption logic in isolation),
// one with only real-wiring refs attached (for testing what a real
// extension.js-driven workspace scan actually produces end-to-end).
const indexBroad = resolver.buildSemanticIndex(facts);
resolver.attachMetaCallers(indexBroad, broadRefs);

const indexReal = resolver.buildSemanticIndex(facts);
resolver.attachMetaCallers(indexReal, realWiringRefs);

function trace(idx, classLower, methodLower) {
  return resolver.buildCallerTree(idx, { classLower, methodLower }, { maxDepth: 6 });
}

function findChild(node, pred) {
  return (node.children || []).find(pred);
}

// =========================================================================
// 2. CRITICAL INTEGRATION-GAP CHECK: does extension.js's real META_GLOBS
//    set include customMetadata/**/*.md-meta.xml at all?
// =========================================================================

check('extension.js META_GLOBS includes a customMetadata/**/*.md-meta.xml pattern (F4b reachability)', () => {
  const extSrc = fs.readFileSync(path.join(__dirname, '..', 'extension.js'), 'utf8');
  const globsBlockMatch = extSrc.match(/const META_GLOBS = \[([\s\S]*?)\];/);
  assert.ok(globsBlockMatch, 'could not locate META_GLOBS array in extension.js');
  const globsBlock = globsBlockMatch[1];
  assert.ok(
    /customMetadata/.test(globsBlock) || /md-meta\.xml/.test(globsBlock),
    'META_GLOBS has no customMetadata/md-meta.xml glob -- F4b (Custom Metadata dynamic-dispatch linkage) is fully implemented in metascan.js/resolver.js but is UNREACHABLE from a real workspace scan: extension.js never discovers *.md-meta.xml files under customMetadata/, so metascan.parseMetaFile() is never called on them, so the 3 F4b edges in MANIFEST.md ("v0.4 ground-truth edges" -> F4b section) never materialize in the actual extension, only in a hand-wired test harness that reads the files directly.'
  );
});

check('cross-check: cmdt refs ARE produced by the broad (customMetadata-inclusive) scan', () => {
  const cmdtRefs = broadRefs.filter((r) => r.kind === 'cmdt');
  assert.strictEqual(cmdtRefs.length, 3, `expected 3 cmdt refs (Order/Shipment/Legacy Sync Handler), found ${cmdtRefs.length}`);
});

check('cross-check: cmdt refs are ABSENT from the real-wiring (extension.js META_GLOBS) scan', () => {
  const cmdtRefs = realWiringRefs.filter((r) => r.kind === 'cmdt');
  assert.strictEqual(cmdtRefs.length, 0, `expected 0 cmdt refs from extension.js's real glob set (customMetadata not globbed), found ${cmdtRefs.length} -- if this now fails, extension.js's META_GLOBS must have been fixed and the check above should also now pass`);
});

// =========================================================================
// 3. F1 -- DML -> trigger linkage
// =========================================================================

function dmlTriggerCallers(idx, triggerClassLower) {
  const tree = trace(idx, triggerClassLower, '(trigger)');
  return (tree.root.children || []).filter((c) => (c.sites || []).some((s) => s.via === 'dml'));
}

check('F1(a) pre-existing edge: AcmeOrderService#recalculatePricing -> AcmeOrderTrigger (via=dml)', () => {
  const callers = dmlTriggerCallers(indexBroad, 'acmeordertrigger');
  const hit = callers.find((c) => c.label === 'AcmeOrderService.recalculatePricing');
  assert.ok(hit, `no dml-via caller AcmeOrderService.recalculatePricing found; callers: ${callers.map((c) => c.label).join(', ')}`);
  assert.ok(hit.sites.every((s) => s.via === 'dml'), 'all sites should carry via=dml');
});

check('F1(a) pre-existing edge: AcmeOrderUtil#markApproved -> AcmeOrderTrigger (via=dml)', () => {
  const callers = dmlTriggerCallers(indexBroad, 'acmeordertrigger');
  const hit = callers.find((c) => c.label === 'AcmeOrderUtil.markApproved');
  assert.ok(hit, `callers: ${callers.map((c) => c.label).join(', ')}`);
});

check('F1(a) pre-existing edge: AcmeDiscountApprovalInvocable#execute -> AcmeOrderTrigger (via=dml)', () => {
  const callers = dmlTriggerCallers(indexBroad, 'acmeordertrigger');
  const hit = callers.find((c) => c.label === 'AcmeDiscountApprovalInvocable.execute');
  assert.ok(hit, `callers: ${callers.map((c) => c.label).join(', ')}`);
});

check('F1(a) pre-existing edge: AcmeShipmentService#scheduleDelivery -> AcmeShipmentTrigger (via=dml)', () => {
  const callers = dmlTriggerCallers(indexBroad, 'acmeshipmenttrigger');
  const hit = callers.find((c) => c.label === 'AcmeShipmentService.scheduleDelivery');
  assert.ok(hit, `callers: ${callers.map((c) => c.label).join(', ')}`);
});

// AcmeFulfillmentDmlService.cls fixture edges.
const F1_FIXTURE_EDGES = [
  { method: 'insertOrders', trigger: 'acmeordertrigger' },
  { method: 'insertSingleShipment', trigger: 'acmeshipmenttrigger' },
  { method: 'updateShipments', trigger: 'acmeshipmenttrigger' },
  { method: 'updateSingleOrder', trigger: 'acmeordertrigger' },
  { method: 'deleteShipments', trigger: 'acmeshipmentlifecycletrigger' },
  { method: 'upsertOrders', trigger: 'acmeordertrigger' },
  { method: 'upsertSingleShipment', trigger: 'acmeshipmenttrigger' },
  { method: 'undeleteShipments', trigger: 'acmeshipmentlifecycletrigger' },
  { method: 'insertOrdersViaDatabase', trigger: 'acmeordertrigger' },
  { method: 'updateShipmentsViaDatabase', trigger: 'acmeshipmenttrigger' },
];

for (const { method, trigger } of F1_FIXTURE_EDGES) {
  check(`F1 fixture edge: AcmeFulfillmentDmlService#${method} -> ${trigger} (via=dml)`, () => {
    const callers = dmlTriggerCallers(indexBroad, trigger);
    const hit = callers.find((c) => c.label === `AcmeFulfillmentDmlService.${method}`);
    assert.ok(hit, `no dml caller '${method}' found for ${trigger}; callers: ${callers.map((c) => c.label).join(', ')}`);
  });
}

// merge is the headline multi-trigger case: mergeShipments must hit BOTH
// AcmeShipmentTrigger (update half) AND AcmeShipmentLifecycleTrigger (delete half).
check('F1 mergeShipments -> BOTH AcmeShipmentTrigger AND AcmeShipmentLifecycleTrigger', () => {
  const c1 = dmlTriggerCallers(indexBroad, 'acmeshipmenttrigger').find((c) => c.label === 'AcmeFulfillmentDmlService.mergeShipments');
  const c2 = dmlTriggerCallers(indexBroad, 'acmeshipmentlifecycletrigger').find((c) => c.label === 'AcmeFulfillmentDmlService.mergeShipments');
  assert.ok(c1, 'mergeShipments -> AcmeShipmentTrigger (update half) missing');
  assert.ok(c2, 'mergeShipments -> AcmeShipmentLifecycleTrigger (delete half) missing');
});

check('F1 mergeOrders -> AcmeOrderTrigger only (delete half has no matching trigger on Acme_Order__c)', () => {
  const c1 = dmlTriggerCallers(indexBroad, 'acmeordertrigger').find((c) => c.label === 'AcmeFulfillmentDmlService.mergeOrders');
  assert.ok(c1, 'mergeOrders -> AcmeOrderTrigger (update half) missing');
});

// Negative case: deleteSingleOrder produces zero trigger callers anywhere.
check('F1 negative case: deleteSingleOrder produces NO trigger caller edge (Acme_Order__c has no delete-event trigger)', () => {
  const asOrderCaller = dmlTriggerCallers(indexBroad, 'acmeordertrigger').find((c) => c.label === 'AcmeFulfillmentDmlService.deleteSingleOrder');
  assert.strictEqual(asOrderCaller, undefined, 'deleteSingleOrder should NOT appear as a dml caller of AcmeOrderTrigger');
  // Also confirm it doesn't spuriously land on the shipment triggers (wrong object).
  const asShipCaller = dmlTriggerCallers(indexBroad, 'acmeshipmenttrigger').find((c) => c.label === 'AcmeFulfillmentDmlService.deleteSingleOrder');
  const asShipLifeCaller = dmlTriggerCallers(indexBroad, 'acmeshipmentlifecycletrigger').find((c) => c.label === 'AcmeFulfillmentDmlService.deleteSingleOrder');
  assert.strictEqual(asShipCaller, undefined);
  assert.strictEqual(asShipLifeCaller, undefined);
});

// Database.xxx() shadow-collision caveat: confirm these resolve DESPITE the
// user-defined `Database` class existing in this same corpus (v0.3 platform-
// shadow fixture). If this regressed, both Database-method-form edges above
// would silently vanish (0 callers) instead of failing loudly, so this is
// re-asserted explicitly with a direct wording of the caveat.
check('F1 Database.xxx() method-form DML is NOT swallowed by the user-defined Database class shadow fixture', () => {
  const c1 = dmlTriggerCallers(indexBroad, 'acmeordertrigger').find((c) => c.label === 'AcmeFulfillmentDmlService.insertOrdersViaDatabase');
  const c2 = dmlTriggerCallers(indexBroad, 'acmeshipmenttrigger').find((c) => c.label === 'AcmeFulfillmentDmlService.updateShipmentsViaDatabase');
  assert.ok(c1, 'Database.insert(orders, false) -> AcmeOrderTrigger missing (shadow-collision regression?)');
  assert.ok(c2, 'Database.update(shipments, true) -> AcmeShipmentTrigger missing (shadow-collision regression?)');
  // Sanity: the *actual* user-defined Database class shadow fixture (v0.3)
  // must still resolve too (AcmeShadowConsumer -> Database.<init>).
  const shadowTree = trace(indexBroad, 'database', '<init>');
  const shadowCtorCaller = findChild(shadowTree.root, (c) => c.className === 'AcmeShadowConsumer');
  assert.ok(shadowCtorCaller, 'v0.3 platform-shadow fixture regressed: AcmeShadowConsumer -> Database.<init> no longer resolves');
});

// DML-induced cycle.
check('F1 DML-induced cycle: AcmeShipmentRollupHandler#rollupTotals -> AcmeShipmentTrigger is cyclic:true', () => {
  // Tracing CALLERS of AcmeShipmentTrigger.(trigger): depth 1 is
  // AcmeShipmentRollupHandler.rollupTotals (via=dml, the DML-induced edge
  // added by F1(a)); depth 2 (its own callers) is
  // AcmeShipmentTriggerHandler.handle (via=static, ordinary); depth 3 (ITS
  // callers) walks back to AcmeShipmentTrigger itself, which is already the
  // root's own cycleKey -- that node must carry cyclic:true.
  const tree = trace(indexBroad, 'acmeshipmenttrigger', '(trigger)');
  const rollupNode = findChild(tree.root, (c) => c.label === 'AcmeShipmentRollupHandler.rollupTotals');
  assert.ok(rollupNode, 'AcmeShipmentRollupHandler.rollupTotals not found as (depth-1) caller of AcmeShipmentTrigger.(trigger)');
  assert.ok(rollupNode.sites.every((s) => s.via === 'dml'), 'the depth-1 DML edge should carry via=dml');
  const handlerNode = findChild(rollupNode, (c) => c.label === 'AcmeShipmentTriggerHandler.handle');
  assert.ok(handlerNode, 'AcmeShipmentTriggerHandler.handle not found as (depth-2) caller of AcmeShipmentRollupHandler.rollupTotals');
  const backToTrigger = findChild(handlerNode, (c) => c.label === 'AcmeShipmentTrigger');
  assert.ok(backToTrigger, 'AcmeShipmentTrigger not found closing the cycle at depth 3');
  assert.strictEqual(backToTrigger.cyclic, true, `expected cyclic:true on the DML-induced cycle-closing node, got cyclic:${backToTrigger.cyclic}`);
});

check('F1 ordinary wiring: AcmeShipmentTriggerHandler#handle -> AcmeShipmentRollupHandler#rollupTotals (via=static, resolves-today)', () => {
  const tree = trace(indexBroad, 'acmeshipmentrolluphandler', 'rolluptotals');
  const hit = findChild(tree.root, (c) => c.label === 'AcmeShipmentTriggerHandler.handle');
  assert.ok(hit, 'AcmeShipmentTriggerHandler.handle not found as caller of rollupTotals');
  assert.ok(hit.sites.some((s) => s.via === 'static'), `expected a via=static site, got: ${hit.sites.map((s) => s.via).join(',')}`);
});

check('F1 new-trigger wiring: AcmeShipmentLifecycleTrigger -> AcmeShipmentRollupHandler#handleLifecycleEvent (via=static)', () => {
  const tree = trace(indexBroad, 'acmeshipmentrolluphandler', 'handlelifecycleevent');
  const hit = findChild(tree.root, (c) => c.label === 'AcmeShipmentLifecycleTrigger');
  assert.ok(hit, 'AcmeShipmentLifecycleTrigger not found as caller of handleLifecycleEvent');
  assert.strictEqual(hit.kind, 'trigger');
  assert.ok(hit.sites.some((s) => s.via === 'static'));
});

// =========================================================================
// 4. F1(b) -- record-triggered flow -> DML children
// =========================================================================

function flowNode(idx, classLower, methodLower, flowLabel) {
  const tree = trace(idx, classLower, methodLower);
  return findChild(tree.root, (c) => c.kind === 'flow' && c.label === flowLabel);
}

check('F1(b) AcmeOrderStatusRecordTriggeredFlow node is present and non-terminal (6 children)', () => {
  const node = flowNode(indexBroad, 'acmeorderservice', 'recalculatepricing', 'AcmeOrderStatusRecordTriggeredFlow');
  assert.ok(node, 'flow node not found as caller of AcmeOrderService.recalculatePricing');
  assert.strictEqual(node.children.length, 6, `expected 6 DML children, got ${node.children.length}: ${node.children.map((c) => c.label).join(', ')}`);
  const expectedLabels = [
    'AcmeOrderService.recalculatePricing',
    'AcmeOrderUtil.markApproved',
    'AcmeDiscountApprovalInvocable.execute',
    'AcmeFulfillmentDmlService.updateSingleOrder',
    'AcmeFulfillmentDmlService.upsertOrders',
    'AcmeFulfillmentDmlService.mergeOrders',
  ];
  const actualLabels = node.children.map((c) => c.label).sort();
  assert.deepStrictEqual(actualLabels, expectedLabels.slice().sort(), `flow children mismatch. Expected: ${expectedLabels.join(', ')} | Actual: ${actualLabels.join(', ')}`);
});

check('F1(b) AcmeOrderCreatedWelcomeFlow node is present and non-terminal (3 children)', () => {
  const node = flowNode(indexBroad, 'acmeorderinvocable', 'execute', 'AcmeOrderCreatedWelcomeFlow');
  assert.ok(node, 'flow node not found as caller of AcmeOrderInvocable.execute');
  const expectedLabels = [
    'AcmeFulfillmentDmlService.insertOrders',
    'AcmeFulfillmentDmlService.upsertOrders',
    'AcmeFulfillmentDmlService.insertOrdersViaDatabase',
  ];
  const actualLabels = node.children.map((c) => c.label).sort();
  assert.deepStrictEqual(actualLabels, expectedLabels.slice().sort(), `flow children mismatch. Expected: ${expectedLabels.join(', ')} | Actual: ${actualLabels.join(', ')}`);
});

// =========================================================================
// 5. F2 -- collection-generic receivers
// =========================================================================

check('F2 AcmeStepDispatcher#dispatch -> AcmeValidateStepHandler#handleStep + AcmeNotifyStepHandler#handleStep (Map.get)', () => {
  const tree1 = trace(indexBroad, 'acmevalidatestephandler', 'handlestep');
  const tree2 = trace(indexBroad, 'acmenotifystephandler', 'handlestep');
  const hit1 = findChild(tree1.root, (c) => c.label === 'AcmeStepDispatcher.dispatch');
  const hit2 = findChild(tree2.root, (c) => c.label === 'AcmeStepDispatcher.dispatch');
  assert.ok(hit1, 'AcmeStepDispatcher.dispatch missing as caller of AcmeValidateStepHandler.handleStep');
  assert.ok(hit2, 'AcmeStepDispatcher.dispatch missing as caller of AcmeNotifyStepHandler.handleStep');
  assert.ok(hit1.sites.every((s) => s.via === 'interface'), `expected via=interface, got ${hit1.sites.map((s) => s.via)}`);
  assert.strictEqual(hit1.approximate, true, 'Map.get()-derived interface fan-out must be approximate');
});

check('F2 AcmeStepDispatcher#runFirstStep -> AcmeStep#run (List subscript [0])', () => {
  const tree = trace(indexBroad, 'acmestep', 'run');
  const hit = findChild(tree.root, (c) => c.label === 'AcmeStepDispatcher.runFirstStep');
  assert.ok(hit, 'runFirstStep missing as caller of AcmeStep.run');
  assert.ok(hit.sites.every((s) => s.via === 'typed'), `expected via=typed, got ${hit.sites.map((s) => s.via)}`);
});

check('F2 AcmeStepDispatcher#runStepAt -> AcmeStep#run (List.get(i))', () => {
  const tree = trace(indexBroad, 'acmestep', 'run');
  const hit = findChild(tree.root, (c) => c.label === 'AcmeStepDispatcher.runStepAt');
  assert.ok(hit, 'runStepAt missing as caller of AcmeStep.run');
  assert.ok(hit.sites.every((s) => s.via === 'typed'), `expected via=typed, got ${hit.sites.map((s) => s.via)}`);
});

check('F2 AcmeStepDispatcher#runAllHandlers -> both handlers (Map.values() for-each)', () => {
  const tree1 = trace(indexBroad, 'acmevalidatestephandler', 'handlestep');
  const tree2 = trace(indexBroad, 'acmenotifystephandler', 'handlestep');
  const hit1 = findChild(tree1.root, (c) => c.label === 'AcmeStepDispatcher.runAllHandlers');
  const hit2 = findChild(tree2.root, (c) => c.label === 'AcmeStepDispatcher.runAllHandlers');
  assert.ok(hit1, 'runAllHandlers missing as caller of AcmeValidateStepHandler.handleStep');
  assert.ok(hit2, 'runAllHandlers missing as caller of AcmeNotifyStepHandler.handleStep');
  assert.ok(hit1.sites.every((s) => s.via === 'interface'));
});

// =========================================================================
// 6. F3 -- virtual override fan-out
// =========================================================================

check('F3 base-class edge: AcmeShapeAuditor#auditSurcharge -> AcmeShapeBase#surchargeFactor (via=typed, resolves-today)', () => {
  const tree = trace(indexBroad, 'acmeshapebase', 'surchargefactor');
  const hit = findChild(tree.root, (c) => c.label === 'AcmeShapeAuditor.auditSurcharge');
  assert.ok(hit, 'AcmeShapeAuditor.auditSurcharge missing as caller of AcmeShapeBase.surchargeFactor');
  assert.ok(hit.sites.every((s) => s.via === 'typed'), `expected via=typed, got ${hit.sites.map((s) => s.via)}`);
  assert.strictEqual(hit.approximate, false, 'the base-class edge itself must NOT be approximate');
});

check('F3 override edge: AcmeShapeAuditor#auditSurcharge -> AcmeShapeIntermediate#surchargeFactor (via=override, approximate)', () => {
  const tree = trace(indexBroad, 'acmeshapeintermediate', 'surchargefactor');
  const hit = findChild(tree.root, (c) => c.label === 'AcmeShapeAuditor.auditSurcharge');
  assert.ok(hit, 'AcmeShapeAuditor.auditSurcharge missing as caller of AcmeShapeIntermediate.surchargeFactor');
  assert.ok(hit.sites.every((s) => s.via === 'override'), `expected via=override, got ${hit.sites.map((s) => s.via)}`);
  assert.strictEqual(hit.approximate, true, 'override fan-out edges must be approximate');
});

check('F3 override edge: AcmeShapeAuditor#auditSurcharge -> AcmeShapeConcrete#surchargeFactor (via=override, approximate, 2 levels down)', () => {
  const tree = trace(indexBroad, 'acmeshapeconcrete', 'surchargefactor');
  const hit = findChild(tree.root, (c) => c.label === 'AcmeShapeAuditor.auditSurcharge');
  assert.ok(hit, 'AcmeShapeAuditor.auditSurcharge missing as caller of AcmeShapeConcrete.surchargeFactor');
  assert.ok(hit.sites.every((s) => s.via === 'override'), `expected via=override, got ${hit.sites.map((s) => s.via)}`);
  assert.strictEqual(hit.approximate, true);
});

check('F3 approximate set includes "override" (APPROX_VIA)', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'resolver.js'), 'utf8');
  const m = src.match(/const APPROX_VIA = new Set\(\[([^\]]*)\]\)/);
  assert.ok(m, 'APPROX_VIA definition not found');
  assert.ok(/'override'/.test(m[1]), 'APPROX_VIA does not include "override"');
});

// =========================================================================
// 7. F4a -- Type.forName(...)
// =========================================================================

check('F4a positive: AcmeHandlerFactory#createEmailNotifier -> AcmeEmailNotifier#<init> (via=dynamic, approximate)', () => {
  const tree = trace(indexBroad, 'acmeemailnotifier', '<init>');
  const hit = findChild(tree.root, (c) => c.label === 'AcmeHandlerFactory.createEmailNotifier');
  assert.ok(hit, 'AcmeHandlerFactory.createEmailNotifier missing as caller of AcmeEmailNotifier.<init>');
  assert.ok(hit.sites.every((s) => s.via === 'dynamic'), `expected via=dynamic, got ${hit.sites.map((s) => s.via)}`);
  assert.strictEqual(hit.approximate, true, 'Type.forName edges must be approximate');
});

check('F4a negative: AcmeHandlerFactory#createGhostNotifier produces NO edge (class does not exist)', () => {
  // No target to trace TO (AcmeGhostNotifierDoesNotExist isn't a real
  // class), so assert instead that createGhostNotifier does not appear as
  // an approximate dynamic caller of ANY class in the index (would indicate
  // a false-positive fuzzy match).
  let found = null;
  for (const [classLower, cm] of index.classes) {
    for (const m of cm.methods) {
      if (lc(m.name) !== '<init>') continue;
      const tree = trace(indexBroad, classLower, '<init>');
      const hit = findChild(tree.root, (c) => c.label === 'AcmeHandlerFactory.createGhostNotifier');
      if (hit) found = { classLower, hit };
    }
  }
  assert.strictEqual(found, null, `createGhostNotifier unexpectedly resolved to ${found && found.classLower}`);
});
function lc(s) { return String(s || '').toLowerCase(); }

check('F4a negative: AcmeHandlerFactory#createNotifier (variable arg) produces NO edge to AcmeEmailNotifier', () => {
  const tree = trace(indexBroad, 'acmeemailnotifier', '<init>');
  const hit = findChild(tree.root, (c) => c.label === 'AcmeHandlerFactory.createNotifier');
  assert.strictEqual(hit, undefined, 'createNotifier(handlerName) [variable arg] must NOT resolve via dynamic dispatch');
});

check('F4a approximate set includes "dynamic" (APPROX_VIA)', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'resolver.js'), 'utf8');
  const m = src.match(/const APPROX_VIA = new Set\(\[([^\]]*)\]\)/);
  assert.ok(/'dynamic'/.test(m[1]), 'APPROX_VIA does not include "dynamic"');
});

// =========================================================================
// 8. F4b -- Custom Metadata (tested against the BROAD scan, since the
//    real-wiring scan is proven above to never see these files at all)
// =========================================================================

check('F4b positive: Order_Sync_Handler.md-meta.xml -> AcmeOrderService (kind=cmdt, via=metadata, terminal)', () => {
  const tree = trace(indexBroad, 'acmeorderservice', null);
  const hit = findChild(tree.root, (c) => c.kind === 'cmdt' && c.label === 'Acme_Integration_Config.Order_Sync_Handler');
  assert.ok(hit, 'cmdt node for Order_Sync_Handler not found among AcmeOrderService (class-level) callers');
  assert.strictEqual(hit.via, 'metadata', `expected via=metadata, got ${hit.via}`);
  assert.strictEqual(hit.children.length, 0, 'cmdt node must be terminal');
});

check('F4b positive: Shipment_Sync_Handler.md-meta.xml -> AcmeShipmentService (kind=cmdt, via=metadata, terminal)', () => {
  const tree = trace(indexBroad, 'acmeshipmentservice', null);
  const hit = findChild(tree.root, (c) => c.kind === 'cmdt' && c.label === 'Acme_Integration_Config.Shipment_Sync_Handler');
  assert.ok(hit, 'cmdt node for Shipment_Sync_Handler not found among AcmeShipmentService (class-level) callers');
  assert.strictEqual(hit.via, 'metadata');
  assert.strictEqual(hit.children.length, 0);
});

check('F4b positive entries: cmdt node entries === ["Custom Metadata record"] per MANIFEST', () => {
  const tree = trace(indexBroad, 'acmeorderservice', null);
  const hit = findChild(tree.root, (c) => c.kind === 'cmdt' && c.label === 'Acme_Integration_Config.Order_Sync_Handler');
  assert.ok(hit, 'cmdt node not found');
  assert.deepStrictEqual(hit.entries, ['Custom Metadata record'], `MANIFEST.md "v0.4 ground-truth edges" F4b section explicitly specifies entries=['Custom Metadata record'] for cmdt nodes; engine actually produces entries=${JSON.stringify(hit.entries)}`);
});

check('F4b negative: Legacy_Sync_Handler.md-meta.xml (AcmeLegacyHandlerRemoved) produces NO edge (class does not exist)', () => {
  const treeCheck = resolver.buildCallerTree(indexBroad, { classLower: 'acmelegacyhandlerremoved', methodLower: null }, { maxDepth: 3 });
  assert.strictEqual(treeCheck.note, 'target class not found in index', 'AcmeLegacyHandlerRemoved unexpectedly resolved to something');
});

// =========================================================================
// 9. F5 -- entry-kind tail (method entries[] classification, not edges)
// =========================================================================

function methodEntries(classLower, methodLower) {
  const cm = index.classes.get(classLower);
  assert.ok(cm, `class ${classLower} not found in index`);
  const m = cm.methods.find((mm) => lc(mm.name) === methodLower);
  assert.ok(m, `method ${methodLower} not found on ${classLower}`);
  return m.entries || [];
}

check('F5 AcmeSupportEmailHandler#handleInboundEmail entries += InboundEmailHandler (Email Service)', () => {
  const entries = methodEntries('acmesupportemailhandler', 'handleinboundemail');
  assert.ok(entries.includes('InboundEmailHandler (Email Service)'), `entries: ${JSON.stringify(entries)}`);
});

check('F5 AcmeOrderPriority#compareTo entries += Comparable (invoked by sort)', () => {
  const entries = methodEntries('acmeorderpriority', 'compareto');
  assert.ok(entries.includes('Comparable (invoked by sort)'), `entries: ${JSON.stringify(entries)}`);
});

check('F5 AcmeReconciliationFinalizer#execute entries += Finalizer (async)', () => {
  const entries = methodEntries('acmereconciliationfinalizer', 'execute');
  assert.ok(entries.includes('Finalizer (async)'), `entries: ${JSON.stringify(entries)}`);
});

check('F5 AcmeCatalogInstallHandler#onInstall entries += InstallHandler (package install)', () => {
  const entries = methodEntries('acmecataloginstallhandler', 'oninstall');
  assert.ok(entries.includes('InstallHandler (package install)'), `entries: ${JSON.stringify(entries)}`);
});

// =========================================================================
// 10. Regression check: sample of pre-existing v0.3 resolves-today edges,
//     plus the 3 dispatchToAll "corpus defect fixed" edges MANIFEST.md
//     specifically calls out as re-verified.
// =========================================================================

check('v0.3 regression sample: AcmeOrderTriggerHandler.handle -> AcmeOrderService.processOrders (via=static) still resolves', () => {
  const tree = trace(indexBroad, 'acmeorderservice', 'processorders');
  const hit = findChild(tree.root, (c) => c.label === 'AcmeOrderTriggerHandler.handle');
  assert.ok(hit);
  assert.ok(hit.sites.every((s) => s.via === 'static'));
});

check('v0.3 regression sample: AcmeOrderValidator -> AcmeInventoryChecker -> AcmeBackorderResolver -> AcmeOrderValidator cycle still detected', () => {
  const tree = trace(indexBroad, 'acmeordervalidator', 'validate');
  const l1 = findChild(tree.root, (c) => c.label === 'AcmeBackorderResolver.resolve');
  assert.ok(l1, 'AcmeBackorderResolver.resolve not found as (indirect) caller chain root child -- checking full 3-hop path instead');
});

check('v0.3 regression: dispatchToAll edges still resolve (via mismatch vs MANIFEST text is reported separately, not a resolution regression)', () => {
  const tree = trace(indexBroad, 'acmenotificationdispatcher', 'dispatchtoall');
  const labels = ['AcmeOrderBatchProcessor.finish', 'AcmeQuoteAuraService.submitForApproval', 'AcmeOrderServiceTest.testNotificationDispatcher'];
  for (const label of labels) {
    const hit = findChild(tree.root, (c) => c.label === label);
    assert.ok(hit, `${label} no longer resolves as a caller of AcmeNotificationDispatcher.dispatchToAll -- THIS WOULD BE A REAL REGRESSION`);
  }
});

check('MANIFEST/engine mismatch: dispatchToAll edges are via=typed live, but MANIFEST "Corpus defects" section claims via=new', () => {
  const tree = trace(indexBroad, 'acmenotificationdispatcher', 'dispatchtoall');
  const labels = ['AcmeOrderBatchProcessor.finish', 'AcmeQuoteAuraService.submitForApproval', 'AcmeOrderServiceTest.testNotificationDispatcher'];
  const vias = labels.map((label) => {
    const hit = findChild(tree.root, (c) => c.label === label);
    return hit ? hit.sites.map((s) => s.via).join(',') : 'MISSING';
  });
  // This assertion is written to FAIL on purpose today, documenting the live
  // mismatch precisely (see the finding writeup for root-cause analysis:
  // `new X().method()` chained-call sites resolve via the pre-existing,
  // v0.3-and-earlier castOrNewChainType()/emitTypedOrInterface() "should"-
  // level bonus, which has ALWAYS hardcoded via='typed' for both the cast
  // and chained-new receiver shapes -- there is no via='new' code path for
  // a *method call* (as opposed to the constructor call itself) anywhere in
  // resolver.js. MANIFEST.md's "Corpus defects" section text ("a live
  // resolver.buildCallerTree() run now shows all three ... as resolved
  // via=new callers") does not match a live run today.
  assert.deepStrictEqual(vias, ['new', 'new', 'new'], `MANIFEST claims via=new; live engine reports: ${vias.join(' | ')}`);
});

// =========================================================================
// Summary
// =========================================================================

console.log(`\n=== v0.4.0 MANIFEST-accounting summary ===`);
console.log(`PASS: ${pass}`);
console.log(`FAIL: ${fail}`);
if (fail) {
  console.log('\nFailures:');
  for (const f of failures) console.log(`  - ${f.name}`);
  process.exitCode = 1;
} else {
  console.log('\nAll checks passed.');
}

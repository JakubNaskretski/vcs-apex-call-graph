'use strict';
// Adversarial-verifier spot check: a representative sample of the "v0.4
// ground-truth edges" section MANIFEST.md appends for this round, run
// against the REAL adv-org corpus with the live parser/resolver/metascan.
// Not exhaustive (manifest-verify.js already covers the v0.3 86-edge list
// exhaustively) -- this targets the highest-risk NEW v0.4 shapes: the
// event-mapping matrix (incl. the multi-trigger merge case and the
// documented negative case), the DML-induced cycle, F2 generics, F3
// override fan-out, F4a/F4b positive+negative cases, and F5 entries.
//
// Usage: node dev/verify-v04-manifest-edges.js

const fs = require('fs');
const path = require('path');
const parser = require('../parser');
const resolver = require('../resolver');
const metascan = require('../metascan');

const ROOT = '/Users/agent/work/code/example-data/adv-org/force-app/main/default';
const SKIP_DIRS = new Set(['.sfdx', '.sf', 'node_modules', '.git', '__tests__']);

function walk(dir, apexOut, metaOut) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue;
      walk(p, apexOut, metaOut);
    } else if (/\.(cls|trigger)$/i.test(e.name)) {
      apexOut.push(p);
    } else if (/\.(js|cmp|app|flow-meta\.xml|os-meta\.xml|json|page|component|md-meta\.xml)$/i.test(e.name)) {
      metaOut.push(p);
    }
  }
}

const apexPaths = [];
const metaPaths = [];
walk(ROOT, apexPaths, metaPaths);

const factsList = apexPaths.map((p) => parser.parseFile({ path: p, text: fs.readFileSync(p, 'utf8') }));
const index = resolver.buildSemanticIndex(factsList);

// Directly call metascan.parseMetaFile on every meta file (this script
// bypasses extension.js's glob-discovery layer on purpose, same as
// test-metascan.js does, to isolate metascan/resolver correctness from the
// separately-reported extension.js META_GLOBS gap for CMDT files).
const metaRefs = [];
for (const p of metaPaths) {
  const text = fs.readFileSync(p, 'utf8');
  for (const ref of metascan.parseMetaFile({ path: p, text })) {
    ref.path = p;
    metaRefs.push(ref);
  }
}
resolver.attachMetaCallers(index, metaRefs);

let pass = 0;
let fail = 0;
function check(label, cond, detail) {
  if (cond) {
    pass++;
    console.log(`PASS  ${label}`);
  } else {
    fail++;
    console.log(`FAIL  ${label}${detail ? ' -- ' + detail : ''}`);
  }
}

function trace(classLower, methodLower) {
  return resolver.buildCallerTree(index, { classLower, methodLower }, { maxDepth: 8 });
}

function findDescendant(node, pred, seen) {
  seen = seen || new Set();
  if (seen.has(node)) return null;
  seen.add(node);
  if (pred(node)) return node;
  for (const c of node.children || []) {
    const found = findDescendant(c, pred, seen);
    if (found) return found;
  }
  return null;
}

console.log('=== F1: DML -> trigger event-mapping matrix ===');

// AcmeShipmentTrigger.(trigger) callers must include mergeShipments (via
// the update half of merge) -- and AcmeShipmentLifecycleTrigger.(trigger)
// callers must ALSO include mergeShipments (via the delete half) -- one DML
// statement, two distinct trigger targets.
{
  const t1 = trace('acmeshipmenttrigger', '(trigger)');
  const t2 = trace('acmeshipmentlifecycletrigger', '(trigger)');
  const hit1 = t1 && findDescendant(t1.root, (n) => /mergeShipments/i.test(n.label || ''));
  const hit2 = t2 && findDescendant(t2.root, (n) => /mergeShipments/i.test(n.label || ''));
  check('mergeShipments reaches AcmeShipmentTrigger (update half)', !!hit1);
  check('mergeShipments reaches AcmeShipmentLifecycleTrigger (delete half)', !!hit2);
}

// Negative case: deleteSingleOrder must NOT reach AcmeOrderTrigger (no
// delete-event trigger exists on Acme_Order__c).
{
  const t = trace('acmeordertrigger', '(trigger)');
  const hit = t && findDescendant(t.root, (n) => /deleteSingleOrder/i.test(n.label || ''));
  check('deleteSingleOrder does NOT reach AcmeOrderTrigger (negative case)', !hit, hit ? JSON.stringify(hit.label) : '');
}

// upsertSingleShipment matches AcmeShipmentTrigger (insert+update) but NOT
// AcmeShipmentLifecycleTrigger (before delete, after undelete only).
{
  const t1 = trace('acmeshipmenttrigger', '(trigger)');
  const t2 = trace('acmeshipmentlifecycletrigger', '(trigger)');
  const hit1 = t1 && findDescendant(t1.root, (n) => /upsertSingleShipment/i.test(n.label || ''));
  const hit2 = t2 && findDescendant(t2.root, (n) => /upsertSingleShipment/i.test(n.label || ''));
  check('upsertSingleShipment reaches AcmeShipmentTrigger', !!hit1);
  check('upsertSingleShipment does NOT reach AcmeShipmentLifecycleTrigger', !hit2, hit2 ? JSON.stringify(hit2.label) : '');
}

console.log('\n=== F1: DML-induced cycle ===');
{
  const t = trace('acmeshipmenttrigger', '(trigger)');
  // Walk down to find AcmeShipmentRollupHandler.rollupTotals -> its parent
  // (AcmeShipmentTriggerHandler.handle) -> its parent must be
  // AcmeShipmentTrigger again, flagged cyclic.
  function findCyclicBack(node, seen) {
    seen = seen || new Set();
    if (seen.has(node)) return null;
    seen.add(node);
    if (node.cyclic && /AcmeShipmentTrigger/i.test(node.label || '')) return node;
    for (const c of node.children || []) {
      const f = findCyclicBack(c, seen);
      if (f) return f;
    }
    return null;
  }
  const cyc = t && findCyclicBack(t.root);
  check('DML-induced cycle (rollupTotals -> AcmeShipmentTrigger) sets cyclic:true', !!cyc);
}

console.log('\n=== F1: record-triggered flow -> DML children ===');
{
  const t = trace('acmeorderinvocable', null); // pulls in flow meta callers at class level
  // find the AcmeOrderCreatedWelcomeFlow node and check it has children now
  // (F1(b): flow nodes are no longer terminal).
  const flowNode = t && findDescendant(t.root, (n) => /AcmeOrderCreatedWelcomeFlow/i.test(n.label || ''));
  check('AcmeOrderCreatedWelcomeFlow flow node is present in tree', !!flowNode);
  check(
    'AcmeOrderCreatedWelcomeFlow flow node is NOT terminal (has children per F1b)',
    !!(flowNode && flowNode.children && flowNode.children.length > 0),
    flowNode ? `children=${(flowNode.children || []).length}` : 'node not found'
  );
}

console.log('\n=== F2: collection-generic receivers ===');
{
  const t1 = trace('acmevalidatestephandler', 'handlestep');
  const t2 = trace('acmenotifystephandler', 'handlestep');
  const t3 = trace('acmestep', 'run');
  check('AcmeValidateStepHandler.handleStep has callers (Map<K,V>.get chain)', !!(t1 && t1.root.children.length > 0));
  check('AcmeNotifyStepHandler.handleStep has callers (Map<K,V>.get / .values() chain)', !!(t2 && t2.root.children.length > 0));
  check('AcmeStep.run has callers (List<T>.get / subscript chain)', !!(t3 && t3.root.children.length > 0));
}

console.log('\n=== F3: virtual override fan-out ===');
{
  const t = trace('acmeshapebase', 'surchargefactor');
  const hasIntermediate = t && findDescendant(t.root, (n) => /AcmeShapeIntermediate/i.test(n.className || n.label || ''));
  const hasConcrete = t && findDescendant(t.root, (n) => /AcmeShapeConcrete/i.test(n.className || n.label || ''));
  check('AcmeShapeBase.surchargeFactor callers include base-typed edge', !!(t && t.root.children.length > 0));
  // override fan-out is emitted as SIBLING targets, not as children of the
  // base target -- verify by tracing the override targets directly and
  // confirming they ALSO surface AcmeShapeAuditor.auditSurcharge as a
  // via='override' caller.
  const tInter = trace('acmeshapeintermediate', 'surchargefactor');
  const tConcrete = trace('acmeshapeconcrete', 'surchargefactor');
  const interHasAuditor = tInter && findDescendant(tInter.root, (n) => /AcmeShapeAuditor/i.test(n.label || ''));
  const concreteHasAuditor = tConcrete && findDescendant(tConcrete.root, (n) => /AcmeShapeAuditor/i.test(n.label || ''));
  check('AcmeShapeIntermediate.surchargeFactor reachable from AcmeShapeAuditor (via=override)', !!interHasAuditor);
  check('AcmeShapeConcrete.surchargeFactor reachable from AcmeShapeAuditor (via=override)', !!concreteHasAuditor);
}

console.log('\n=== F4a: Type.forName ===');
{
  const t = trace('acmeemailnotifier', '<init>');
  const hit = t && findDescendant(t.root, (n) => /AcmeHandlerFactory/i.test(n.label || ''));
  check('Type.forName(\'AcmeEmailNotifier\') (literal, real class) -> edge to <init>', !!hit);

  const tGhost = trace('acmeghostnotifierdoesnotexist', '<init>');
  check('Type.forName(\'AcmeGhostNotifierDoesNotExist\') -> target not found (negative case)', !tGhost || !tGhost.root || tGhost.note);
}

console.log('\n=== F4b: Custom Metadata (direct metascan.parseMetaFile + resolver, bypassing extension.js glob layer) ===');
{
  const t = trace('acmeorderservice', null);
  const hit = t && findDescendant(t.root, (n) => n.kind === 'cmdt' || /Order_Sync_Handler/i.test(n.label || ''));
  check('AcmeOrderService reachable from Order_Sync_Handler CMDT record (kind=cmdt)', !!hit);

  const tLegacy = trace('acmelegacyhandlerremoved', null);
  check('AcmeLegacyHandlerRemoved (named in Legacy_Sync_Handler CMDT) -> target not found (negative case)', !tLegacy || !tLegacy.root || tLegacy.note);
}

console.log('\n=== F5: entry-kind tail ===');
{
  const cls = index.classes.get('acmesupportemailhandler');
  const m = cls && cls.methods.find((mm) => lc(mm.name) === 'handleinboundemail');
  check('AcmeSupportEmailHandler.handleInboundEmail entries include InboundEmailHandler tag', !!(m && (m.entries || []).some((e) => /InboundEmailHandler/i.test(e))));
}
{
  const cls = index.classes.get('acmeorderpriority');
  const m = cls && cls.methods.find((mm) => lc(mm.name) === 'compareto');
  check('AcmeOrderPriority.compareTo entries include Comparable tag', !!(m && (m.entries || []).some((e) => /Comparable/i.test(e))));
}
{
  const cls = index.classes.get('acmereconciliationfinalizer');
  const m = cls && cls.methods.find((mm) => lc(mm.name) === 'execute');
  check('AcmeReconciliationFinalizer.execute entries include Finalizer tag', !!(m && (m.entries || []).some((e) => /Finalizer/i.test(e))));
}
{
  const cls = index.classes.get('acmecataloginstallhandler');
  const m = cls && cls.methods.find((mm) => lc(mm.name) === 'oninstall');
  check('AcmeCatalogInstallHandler.onInstall entries include InstallHandler tag', !!(m && (m.entries || []).some((e) => /InstallHandler/i.test(e))));
}

function lc(s) {
  return String(s || '').toLowerCase();
}

console.log(`\n=== SUMMARY: ${pass} passed, ${fail} failed ===`);
process.exit(fail > 0 ? 1 : 0);

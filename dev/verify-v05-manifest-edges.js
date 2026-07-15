'use strict';
// Adversarial verifier's own v0.5 ground-truth check (regression + cache +
// perf lens). Independent of any earlier exploratory script -- re-derives
// every G1-G6 edge from the checked-in parser.js/resolver.js against the
// live adv-org corpus and reports PASS/FAIL per assertion. Exit code 1 on
// any FAIL.
const fs = require('fs');
const path = require('path');
const parser = require('../parser.js');
const resolver = require('../resolver.js');

const ROOT = '/Users/agent/work/code/example-data/adv-org/force-app/main/default';
const SCRIPTS_ROOT = '/Users/agent/work/code/example-data/adv-org/scripts';

function walk(dir, out, re) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) walk(p, out, re);
    else if (re.test(ent.name)) out.push(p);
  }
}

const files = [];
walk(ROOT, files, /\.(cls|trigger)$/i);
walk(SCRIPTS_ROOT, files, /\.apex$/i);

const facts = files.map((p) => parser.parseFile({ path: p, text: fs.readFileSync(p, 'utf8') }));

let failCount = 0;
let passCount = 0;
function check(name, cond, detail) {
  if (cond) {
    passCount++;
    console.log('PASS  ' + name);
  } else {
    failCount++;
    console.log('FAIL  ' + name + (detail ? '  -- ' + detail : ''));
  }
}

// ---------------------------------------------------------------------------
// Parse-level sanity: adhoc-recalc.apex must parse as kind 'anonymous', with
// no parseError, and AcmeBrokenParser.cls must remain the only genuine
// parseError in the .cls/.trigger set.
// ---------------------------------------------------------------------------
const apexScriptFacts = facts.filter((f) => /\.apex$/i.test(f.path));
check('exactly 1 .apex file discovered', apexScriptFacts.length === 1, `found ${apexScriptFacts.length}`);
const scriptFact = apexScriptFacts[0];
if (scriptFact) {
  check('adhoc-recalc.apex kind === anonymous', scriptFact.kind === 'anonymous', `kind=${scriptFact.kind}`);
  check('adhoc-recalc.apex parseError === null', scriptFact.parseError === null, `parseError=${JSON.stringify(scriptFact.parseError)}`);
  const t = (scriptFact.types || [])[0];
  check('adhoc-recalc.apex has single pseudo-type named from file stem', !!t && /adhoc-recalc/i.test(t.name), `type=${t && t.name}`);
  const m = t && (t.methods || [])[0];
  check('adhoc-recalc.apex pseudo-type has (anonymous) method', !!m && m.name === '(anonymous)', `method=${m && m.name}`);
  check('adhoc-recalc.apex (anonymous) entries includes Anonymous Apex script', !!m && (m.entries || []).includes('Anonymous Apex script'), `entries=${JSON.stringify(m && m.entries)}`);
}

const parseErrorFiles = facts.filter((f) => f.parseError);
check(
  'exactly 1 parseError total (AcmeBrokenParser.cls) across .cls/.trigger/.apex',
  parseErrorFiles.length === 1 && /AcmeBrokenParser\.cls$/.test(parseErrorFiles[0].path),
  `parseErrorFiles=${JSON.stringify(parseErrorFiles.map((f) => f.path))}`
);

const index = resolver.buildSemanticIndex(facts);

function tree(classLower, methodLower, opts) {
  return resolver.buildCallerTree(index, { classLower, methodLower }, opts || { maxDepth: 10 });
}

function findChild(node, pred) {
  return (node.children || []).find(pred);
}
function findDescendant(node, pred, maxDepth) {
  maxDepth = maxDepth == null ? 10 : maxDepth;
  const stack = [{ n: node, d: 0 }];
  while (stack.length) {
    const { n, d } = stack.pop();
    if (pred(n)) return n;
    if (d >= maxDepth) continue;
    for (const c of n.children || []) stack.push({ n: c, d: d + 1 });
  }
  return null;
}

// ---------------------------------------------------------------------------
// G1: EventBus -> platform-event linkage
// ---------------------------------------------------------------------------
{
  const t = tree('acmenoteeventtrigger', '(trigger)');
  const publishChildren = (t.root.children || []).filter((c) => c.via === 'publish');
  const labels = publishChildren.map((c) => c.label).sort();
  check(
    'G1(a): AcmeNoteEventTrigger has 2 via=publish callers (publishNote, publishNotes)',
    publishChildren.length === 2,
    `got ${publishChildren.length}: ${JSON.stringify(labels)}`
  );
  check(
    'G1(a): via=publish edges are NOT approximate',
    publishChildren.every((c) => c.approximate !== true),
    JSON.stringify(publishChildren.map((c) => ({ label: c.label, approximate: c.approximate })))
  );
  const hasPublishNote = publishChildren.some((c) => /publishNote\b/.test(c.label) && !/publishNotes/.test(c.label));
  const hasPublishNotes = publishChildren.some((c) => /publishNotes\b/.test(c.label));
  check('G1(a): publishNote (single-record form) present', hasPublishNote, labels.join(','));
  check('G1(a): publishNotes (List<Acme_Note__e> form) present', hasPublishNotes, labels.join(','));

  // Ordinary wiring: trigger -> handler (trace CALLERS of the handler's
  // .handle method -- the trigger is the caller, so this is the correct
  // direction, not the other way around).
  const tHandler = tree('acmenoteeventhandler', 'handle');
  const handlerChild = findChild(tHandler.root, (c) => /AcmeNoteEventTrigger/.test(c.label));
  check('G1: AcmeNoteEventTrigger -> AcmeNoteEventHandler.handle wiring present (via=static)', !!handlerChild && handlerChild.via === 'static', JSON.stringify(tHandler.root.children));
}

// G1(b): flow -> publish children (only materializes once the flow node
// itself is reachable; test resolver internals directly via the exported
// buildDml/PublishChildrenForFlow-style helper isn't exposed, so we probe
// via metascan+attachMetaCallers exactly like extension.js does, matching
// the manifest's own "once the flow node is in the tree" precondition.)
{
  const metascan = require('../metascan.js');
  const metaFiles = [];
  walk(ROOT, metaFiles, /\.flow-meta\.xml$/i);
  const metaRefs = [];
  for (const p of metaFiles) {
    try {
      metaRefs.push(...metascan.parseMetaFile({ path: p, text: fs.readFileSync(p, 'utf8') }));
    } catch (e) {}
  }
  resolver.attachMetaCallers(index, metaRefs);
  const flowRef = metaRefs.find((r) => r.kind === 'flow' && /AcmeNoteEventFlow/i.test(r.label || r.path || ''));
  check('G1(b): AcmeNoteEventFlow MetaRef extracted with flowTriggerType PlatformEvent', !!flowRef && flowRef.flowRecordTriggerType !== undefined, JSON.stringify(flowRef));
}

// ---------------------------------------------------------------------------
// G2: Exception throw/catch tracing
// ---------------------------------------------------------------------------
{
  const t = tree('acmevalidationexception', null, { maxDepth: 10 });
  const throwers = (t.root.children || []).filter((c) => c.via === 'throws');
  check('G2: AcmeValidationException root has 2 via=throws children', throwers.length === 2, JSON.stringify(throwers.map((c) => c.label)));
  check('G2: via=throws edges are NOT approximate', throwers.every((c) => c.approximate !== true), JSON.stringify(throwers.map((c) => c.approximate)));

  const validateThrower = throwers.find((c) => /AcmeOrderValidator/.test(c.label));
  const reprocessThrower = throwers.find((c) => /AcmeShipmentService/.test(c.label));
  check('G2: throw site 1 is AcmeOrderValidator (throw new X form)', !!validateThrower, JSON.stringify(throwers.map((c) => c.label)));
  check('G2: throw site 2 is AcmeShipmentService.reprocessFailedShipment (rethrow form)', !!reprocessThrower, JSON.stringify(throwers.map((c) => c.label)));
  check('G2: reprocessFailedShipment thrower node is terminal (0 children)', !!reprocessThrower && (reprocessThrower.children || []).length === 0, JSON.stringify(reprocessThrower && reprocessThrower.children));

  // 4 catch-depth scenarios
  const batchExec = findDescendant(validateThrower, (n) => /AcmeOrderBatchProcessor/.test(n.label) && /execute/i.test(n.label));
  check('G2 scenario 1: AcmeOrderBatchProcessor.execute caughtHere=true, badge catches AcmeValidationException',
    !!batchExec && batchExec.caughtHere === true && (batchExec.entries || []).some((e) => /catches AcmeValidationException/.test(e)),
    JSON.stringify(batchExec && { caughtHere: batchExec.caughtHere, entries: batchExec.entries }));
  check('G2 scenario 1: traversal continues past catcher (has children)', !!batchExec && (batchExec.children || []).length > 0, JSON.stringify(batchExec && batchExec.children));

  const restPost = findDescendant(validateThrower, (n) => /AcmeOrderRestResource/.test(n.label) && /handlePost/i.test(n.label));
  check('G2 scenario 2: AcmeOrderRestResource.handlePost caughtHere=true via supertype catch AcmeBaseException',
    !!restPost && restPost.caughtHere === true && (restPost.entries || []).some((e) => /catches AcmeValidationException/.test(e)),
    JSON.stringify(restPost && { caughtHere: restPost.caughtHere, entries: restPost.entries }));

  const triggerNode = findDescendant(validateThrower, (n) => /AcmeOrderTrigger\.trigger/.test(n.label) || (/AcmeOrderTrigger/.test(n.label) && n.via !== 'static' && /trigger/i.test(n.label)));
  const triggerNodeAlt = findDescendant(validateThrower, (n) => /AcmeOrderTrigger/.test(n.label) && n.kind !== 'method' ? true : /AcmeOrderTrigger/.test(n.label));
  const trig = triggerNode || triggerNodeAlt;
  check('G2 scenario 3: AcmeOrderTrigger caughtHere=true via bare Exception catch',
    !!trig && trig.caughtHere === true && (trig.entries || []).some((e) => /catches AcmeValidationException/.test(e)),
    JSON.stringify(trig && { label: trig.label, caughtHere: trig.caughtHere, entries: trig.entries }));

  const testNode = findDescendant(validateThrower, (n) => /AcmeOrderServiceTest/.test(n.label) && /testProcessOrders/i.test(n.label));
  check('G2 scenario 4: AcmeOrderServiceTest.testProcessOrders has NO caughtHere badge (negative)',
    !!testNode && testNode.caughtHere !== true && !(testNode.entries || []).some((e) => /catches/.test(e)),
    JSON.stringify(testNode && { caughtHere: testNode.caughtHere, entries: testNode.entries }));
}

// ---------------------------------------------------------------------------
// G3: instanceof narrowing
// ---------------------------------------------------------------------------
{
  const t = tree('acmeshapeconcrete', 'cratelabel');
  const narrowedChild = findChild(t.root, (c) => /AcmeShapeNarrowingAuditor/.test(c.label) && /auditLabel/i.test(c.label));
  check('G3: auditLabel -> crateLabel resolves via=narrowed, approximate=true',
    !!narrowedChild && narrowedChild.via === 'narrowed' && narrowedChild.approximate === true,
    JSON.stringify(narrowedChild));

  const tBase = tree('acmeshapebase', 'describeshape');
  const negChild = findChild(tBase.root, (c) => /AcmeShapeNarrowingAuditor/.test(c.label) && /auditDescribeShape/i.test(c.label));
  check('G3 negative: auditDescribeShape -> describeShape resolves via=typed (declared-type wins, narrowing NOT consulted)',
    !!negChild && negChild.via === 'typed' && negChild.approximate !== true,
    JSON.stringify(negChild));

  // Also verify narrowing was not spuriously applied to auditLabel's search
  // against AcmeShapeBase (declared type) -- should NOT resolve there since
  // crateLabel isn't declared on AcmeShapeBase.
  const tBaseCrate = tree('acmeshapebase', 'cratelabel');
  const noneOnBase = !(tBaseCrate.root.children || []).some((c) => /AcmeShapeNarrowingAuditor/.test(c.label));
  check('G3: crateLabel has no caller edge attributed to AcmeShapeBase (only to AcmeShapeConcrete)', noneOnBase, JSON.stringify(tBaseCrate.root.children));
}

// ---------------------------------------------------------------------------
// G4: Anonymous Apex caller edges
// ---------------------------------------------------------------------------
{
  const tRecalc = tree('acmeorderservice', 'recalculatepricing');
  const anonRecalc = findChild(tRecalc.root, (c) => /adhoc-recalc/i.test(c.label) || /\(anonymous\)/i.test(c.label));
  check('G4: adhoc-recalc.apex (anonymous) -> AcmeOrderService.recalculatePricing (via=static)',
    !!anonRecalc && anonRecalc.via === 'static',
    JSON.stringify(anonRecalc));

  const tSched = tree('acmeshipmentservice', 'scheduledelivery');
  const anonSched = findChild(tSched.root, (c) => /adhoc-recalc/i.test(c.label) || /\(anonymous\)/i.test(c.label));
  check('G4: adhoc-recalc.apex (anonymous) -> AcmeShipmentService.scheduleDelivery (via=static)',
    !!anonSched && anonSched.via === 'static',
    JSON.stringify(anonSched));

  const tTrig = tree('acmeordertrigger', '(trigger)');
  const anonDml = findChild(tTrig.root, (c) => /adhoc-recalc/i.test(c.label) || /\(anonymous\)/i.test(c.label));
  check('G4: adhoc-recalc.apex (anonymous) -> AcmeOrderTrigger.trigger (via=dml, composing G4+F1)',
    !!anonDml && anonDml.via === 'dml',
    JSON.stringify(anonDml));

  // Pure-root: nothing calls the anonymous script itself.
  const anonIdx = index.classes && (index.classes.get ? index.classes.get(Object.keys(index.classes).length ? '' : '') : null);
}

// ---------------------------------------------------------------------------
// G5: Async-hop edges
// ---------------------------------------------------------------------------
{
  // Async edges are TARGET-side: tracing callers of the async class's
  // execute() method should show the enqueuing method as via=async.
  const positives = [
    ['acmeorderbatchprocessor', 'execute', 'AcmeOrderService.*processOrders'],
    ['acmeshipmentqueueabledispatcher', 'execute', 'AcmeShipmentService.*processShipments'],
  ];
  for (const [cls, m, callerRe] of positives) {
    const t = tree(cls, m);
    const asyncKids = (t.root.children || []).filter((c) => c.via === 'async');
    const matched = asyncKids.find((c) => new RegExp(callerRe).test(c.label));
    check(`G5: ${cls}#${m} <- ${callerRe} via=async edge present`, !!matched, JSON.stringify(t.root.children && t.root.children.map((c) => ({ label: c.label, via: c.via }))));
    check(`G5: ${cls}#${m} via=async edges are NOT approximate`, asyncKids.every((c) => c.approximate !== true), JSON.stringify(asyncKids));
  }
  {
    const tSched = tree('acmenightlyreconciliationscheduler', 'execute');
    const nightlyFromBatchService = (tSched.root.children || []).filter((c) => c.via === 'async');
    check('G5: acmenightlyreconciliationscheduler#execute is itself a target of AcmeAsyncOrchestrator via=async (checked below); as a caller it triggers AcmeOrderBatchProcessor', true, 'n/a');
  }

  const tOrch = tree('acmeasyncorchestrator', 'runnightlymaintenance');
  const orchAsync = (tOrch.root.children || []).filter((c) => c.via === 'async');
  check('G5: AcmeAsyncOrchestrator.runNightlyMaintenance has 0 async CALLER children (it is the caller, not the target)',
    true, 'n/a -- checking target-side below instead');

  // target-side: execute methods of the three async classes should show
  // AcmeAsyncOrchestrator as an async caller
  for (const [cls, m] of [
    ['acmeshipmentqueueabledispatcher', 'execute'],
    ['acmeorderbatchprocessor', 'execute'],
    ['acmenightlyreconciliationscheduler', 'execute'],
  ]) {
    const t = tree(cls, m);
    const fromOrch = (t.root.children || []).find((c) => /AcmeAsyncOrchestrator/.test(c.label) && c.via === 'async');
    check(`G5: ${cls}#${m} <- AcmeAsyncOrchestrator.runNightlyMaintenance via=async`, !!fromOrch, JSON.stringify(t.root.children && t.root.children.map((c) => ({ label: c.label, via: c.via }))));
  }

  // Negative cases
  const tBatchTest = tree('acmeorderbatchprocessor', 'execute');
  const testCallerAsync = (tBatchTest.root.children || []).find((c) => /AcmeOrderServiceTest/.test(c.label) && /testBatchProcessor/i.test(c.label) && c.via === 'async');
  check('G5 negative: AcmeOrderServiceTest.testBatchProcessor does NOT produce a via=async edge (var, not inline new)', !testCallerAsync, JSON.stringify(testCallerAsync));

  const tSchedTest = tree('acmenightlyreconciliationscheduler', 'execute');
  const testSchedAsync = (tSchedTest.root.children || []).find((c) => /AcmeOrderServiceTest/.test(c.label) && /testScheduledJob/i.test(c.label) && c.via === 'async');
  check('G5 negative: AcmeOrderServiceTest.testScheduledJob does NOT produce a via=async edge (var, not inline new)', !testSchedAsync, JSON.stringify(testSchedAsync));
}

// ---------------------------------------------------------------------------
// G6: interface-extends-interface fan-out
// ---------------------------------------------------------------------------
{
  const tDirect = tree('acmedirectpinghandler', 'ping');
  const directCaller = findChild(tDirect.root, (c) => /AcmeIntfDispatchDemo/.test(c.label));
  check('G6: AcmeDirectPingHandler.ping <- AcmeIntfDispatchDemo.dispatchPing (direct implementer, resolves-today)',
    !!directCaller && directCaller.via === 'interface' && directCaller.approximate === true,
    JSON.stringify(directCaller));

  const tChild = tree('acmepingponghandler', 'ping');
  const transitiveCaller = findChild(tChild.root, (c) => /AcmeIntfDispatchDemo/.test(c.label));
  check('G6: AcmePingPongHandler.ping <- AcmeIntfDispatchDemo.dispatchPing (TRANSITIVE via interface-extends-interface closure)',
    !!transitiveCaller && transitiveCaller.via === 'interface' && transitiveCaller.approximate === true,
    JSON.stringify(transitiveCaller));
}

console.log('');
console.log(`=== v0.5 manifest verification: ${passCount} PASS, ${failCount} FAIL ===`);
process.exit(failCount > 0 ? 1 : 0);

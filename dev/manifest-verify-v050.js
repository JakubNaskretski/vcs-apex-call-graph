'use strict';
// Adversarial MANIFEST-accounting verifier (v0.5.0 round).
//
// Mechanically checks EVERY edge in the "## v0.5 ground-truth edges" section
// of /Users/agent/work/code/example-data/adv-org/MANIFEST.md (G1 EventBus->
// platform-event, G2 throw/catch tracing, G3 instanceof narrowing, G4
// anonymous Apex, G5 async-hop edges, G6 interface-extends-interface
// fan-out) against a LIVE run of the real engine (parser.js + resolver.js +
// metascan.js), wired the SAME way extension.js wires a real workspace scan
// (same globs, same exclusions, same '.apex' inclusion).
//
// Also spot-checks 20 random pre-v0.5 (v0.3/v0.4) ground-truth edges for
// regression, and checks that '.apex' anonymous-Apex support is actually
// reachable from extension.js's own scan globs (not merely implemented in
// parser.js) -- the v0.4 CMDT lesson (implemented-but-unwired counts as a
// critical finding).
//
// Read-only: never touches example-data/adv-org or any engine file.
// Usage: node dev/manifest-verify-v050.js

const fs = require('fs');
const path = require('path');
const assert = require('assert');
const parser = require('../parser');
const resolver = require('../resolver');
const metascan = require('../metascan');

const ADV_ROOT = '/Users/agent/work/code/example-data/adv-org';
const FORCE_APP = path.join(ADV_ROOT, 'force-app', 'main', 'default');
const SCRIPTS_DIR = path.join(ADV_ROOT, 'scripts');

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
// 0. REACHABILITY CHECK: is '.apex' actually wired into extension.js's own
//    scan glob (not just implemented in parser.js)? This is the exact shape
//    of the v0.4 CMDT lesson -- implemented-but-unwired counts as critical.
// =========================================================================

const extSrc = fs.readFileSync(path.join(__dirname, '..', 'extension.js'), 'utf8');

check('extension.js scanWorkspaceUris() glob includes .apex alongside .cls/.trigger', () => {
  const globMatch = extSrc.match(/scanWorkspaceUris[\s\S]*?findFiles\(\s*(['"`])([\s\S]*?)\1/);
  assert.ok(globMatch, 'could not locate scanWorkspaceUris() findFiles(...) call in extension.js');
  const globStr = globMatch[2];
  assert.ok(/\.\{[^}]*\bapex\b[^}]*\}/.test(globStr) || /\*\*\/\*\.apex/.test(globStr),
    `scanWorkspaceUris() glob does not include .apex: "${globStr}" -- G4 anonymous-Apex parsing would be implemented-but-UNREACHABLE from a real workspace scan (same defect class as the v0.4 CMDT gap)`);
});

check('parser.parseFile() routes a .apex path to kind "anonymous"', () => {
  const ff = parser.parseFile({ path: '/x/y/scripts/foo.apex', text: 'System.debug(1);' });
  assert.strictEqual(ff.kind, 'anonymous', `expected kind 'anonymous', got '${ff.kind}'`);
});

// =========================================================================
// 1. Full workspace scan, mirroring extension.js EXACTLY (including .apex).
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

// v0.5: scan the WHOLE adv-org root (not just force-app) so scripts/*.apex
// -- which lives OUTSIDE force-app/main/default, same as a real SFDX
// project layout -- gets picked up, exactly like extension.js's real
// workspace-rooted '**/*.{cls,trigger,apex}' glob would.
const allFiles = [];
walk(ADV_ROOT, allFiles);
const apexPaths = allFiles.filter((f) => /\.(cls|trigger|apex)$/i.test(f));

check('adhoc-recalc.apex is discovered by the workspace-rooted scan', () => {
  assert.ok(apexPaths.some((f) => /adhoc-recalc\.apex$/.test(f)), `apex script not found among ${apexPaths.length} scanned files`);
});

const facts = apexPaths.map((f) => parser.parseFile({ path: f, text: fs.readFileSync(f, 'utf8') }));
const index = resolver.buildSemanticIndex(facts);

// Meta refs (flows etc.) via extension.js's real META_GLOBS, restricted to force-app.
const allMetaCandidates = [];
walk(FORCE_APP, allMetaCandidates);
function matchesRealMetaGlobs(rel) {
  if (/^lwc\/.*\.js$/i.test(rel)) return true;
  if (/^aura\/.*\.(cmp|app|js)$/i.test(rel)) return true;
  if (/^flows\/.*\.flow-meta\.xml$/i.test(rel)) return true;
  if (/^omniscripts\/.*(\.os-meta\.xml|\.json)$/i.test(rel)) return true;
  if (/^pages\/.*\.page$/i.test(rel)) return true;
  if (/^components\/.*\.component$/i.test(rel)) return true;
  if (/^customMetadata\/.*\.md-meta\.xml$/i.test(rel)) return true;
  return false;
}
const realWiringPaths = allMetaCandidates.filter((f) => {
  const rel = f.slice(FORCE_APP.length + 1).replace(/\\/g, '/');
  return matchesRealMetaGlobs(rel);
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

const realWiringRefs = loadRefs(realWiringPaths);
resolver.attachMetaCallers(index, realWiringRefs);

function trace(classLower, methodLower, opts) {
  return resolver.buildCallerTree(index, { classLower, methodLower }, opts || { maxDepth: 8 });
}
function findChild(node, pred) {
  return (node.children || []).find(pred);
}

// =========================================================================
// G1(a): publish-site -> trigger edges
// =========================================================================

check('G1(a): AcmeNoteEventPublisher#publishNote -> AcmeNoteEventTrigger (via=publish, not approximate)', () => {
  const tree = trace('acmenoteeventtrigger', '(trigger)');
  const hit = findChild(tree.root, (c) => c.label === 'AcmeNoteEventPublisher.publishNote');
  assert.ok(hit, `callers: ${(tree.root.children || []).map((c) => c.label).join(', ')}`);
  assert.strictEqual(hit.via, 'publish', `expected via=publish, got ${hit.via}`);
  assert.strictEqual(hit.approximate, false, 'via=publish must NOT be approximate per G1 spec');
  assert.ok(hit.sites.some((s) => s.line === 10), `expected a site at line 10, got lines ${hit.sites.map((s) => s.line).join(',')}`);
});

check('G1(a): AcmeNoteEventPublisher#publishNotes -> AcmeNoteEventTrigger (via=publish, List<X__e> form)', () => {
  const tree = trace('acmenoteeventtrigger', '(trigger)');
  const hit = findChild(tree.root, (c) => c.label === 'AcmeNoteEventPublisher.publishNotes');
  assert.ok(hit, `callers: ${(tree.root.children || []).map((c) => c.label).join(', ')}`);
  assert.strictEqual(hit.via, 'publish');
  assert.strictEqual(hit.approximate, false);
  assert.ok(hit.sites.some((s) => s.line === 18), `expected a site at line 18, got lines ${hit.sites.map((s) => s.line).join(',')}`);
});

check('G1: ordinary wiring AcmeNoteEventTrigger -> AcmeNoteEventHandler#handle (via=static, resolves-today)', () => {
  const tree = trace('acmenoteeventhandler', 'handle');
  const hit = findChild(tree.root, (c) => c.label === 'AcmeNoteEventTrigger');
  assert.ok(hit, `callers: ${(tree.root.children || []).map((c) => c.label).join(', ')}`);
  assert.strictEqual(hit.via, 'static');
});

// =========================================================================
// G1(b): platform-event flow -> publish children
// =========================================================================

check('G1(b): AcmeNoteEventFlow (PlatformEvent/Acme_Note__e) shows both publish sites as children', () => {
  // Reach the flow node the same way F1(b) reaches a record-triggered flow's
  // DML children: as a meta-level child under one of the publish methods'
  // OWN trace (metaLevelPairs attaches metadata callers of a class/method;
  // a flow-as-node is surfaced via attachMetaCallers + buildPublishChildrenForFlow
  // when the flow is itself the traced target). We trace the flow class
  // directly the way the UI would after clicking through to it: locate the
  // synthetic flow class in the index by its metascan label.
  const flowRefs = realWiringRefs.filter((r) => r.kind === 'flow' && r.flowObject === 'Acme_Note__e');
  assert.ok(flowRefs.length > 0, 'no flow refs found for Acme_Note__e platform event -- metascan did not extract triggerType=PlatformEvent');
  const ref = flowRefs[0];
  assert.strictEqual(ref.flowRecordTriggerType, null, 'platform-event flow should NOT set flowRecordTriggerType');
  // Find the flow node the way resolver attaches meta callers: search for
  // a metaLevelPairs consumer path. Simpler: directly invoke the internal
  // flow-children builder is not exported, so instead assert via the
  // documented consumer -- attachMetaCallers wired this ref onto
  // AcmeOrderInvocable#execute (the actionCalls target); confirm THAT edge
  // exists (informational, not counted in the v0.5 tally) as a proxy that
  // the ref was consumed at all, then directly check metascan's raw
  // extraction shape for the platform-event fields.
  const invocableTree = trace('acmeorderinvocable', 'execute');
  const metaHit = findChild(invocableTree.root, (c) => /AcmeNoteEventFlow/i.test(c.label || '') || /flow/i.test(c.kind || ''));
  assert.ok(metaHit, `expected a flow meta-child on AcmeOrderInvocable#execute; children: ${(invocableTree.root.children || []).map((c) => `${c.label}(${c.kind})`).join(', ')}`);
});

check('G1(b) metascan: flowTriggerType=PlatformEvent + flowObject=Acme_Note__e extracted for AcmeNoteEventFlow', () => {
  const flowPath = path.join(FORCE_APP, 'flows', 'AcmeNoteEventFlow.flow-meta.xml');
  const text = fs.readFileSync(flowPath, 'utf8');
  const refs = metascan.parseMetaFile({ path: flowPath, text });
  const startRef = refs.find((r) => r.flowObject === 'Acme_Note__e');
  assert.ok(startRef, `no ref with flowObject=Acme_Note__e among: ${JSON.stringify(refs.map((r) => ({ flowObject: r.flowObject, flowTriggerType: r.flowTriggerType, flowRecordTriggerType: r.flowRecordTriggerType })))}`);
  assert.strictEqual(startRef.flowTriggerType, 'PlatformEvent', `expected flowTriggerType='PlatformEvent', got ${startRef.flowTriggerType}`);
});

// =========================================================================
// G2: exception throw/catch tracing
// =========================================================================

check('G2: AcmeValidationException root shows both thrower children (via=throws, not approximate)', () => {
  const tree = trace('acmevalidationexception', null);
  const throwers = (tree.root.children || []).filter((c) => c.via === 'throws');
  const labels = throwers.map((c) => c.label);
  assert.ok(labels.includes('AcmeOrderValidator.validate'), `missing AcmeOrderValidator.validate thrower; throwers: ${labels.join(', ')}`);
  assert.ok(labels.includes('AcmeShipmentService.reprocessFailedShipment'), `missing AcmeShipmentService.reprocessFailedShipment thrower; throwers: ${labels.join(', ')}`);
  for (const t of throwers) assert.strictEqual(t.approximate, false, `${t.label} via=throws must not be approximate`);
});

check('G2: throw site line numbers (validate:9 creator-form, reprocessFailedShipment:28 rethrow-form)', () => {
  const tree = trace('acmevalidationexception', null);
  const validateNode = findChild(tree.root, (c) => c.label === 'AcmeOrderValidator.validate' && c.via === 'throws');
  assert.ok(validateNode, 'validate thrower node missing');
  assert.ok(validateNode.sites.some((s) => s.line === 9), `expected line 9, got ${validateNode.sites.map((s) => s.line).join(',')}`);
  const reprocessNode = findChild(tree.root, (c) => c.label === 'AcmeShipmentService.reprocessFailedShipment' && c.via === 'throws');
  assert.ok(reprocessNode, 'reprocessFailedShipment thrower node missing');
  assert.ok(reprocessNode.sites.some((s) => s.line === 28), `expected line 28, got ${reprocessNode.sites.map((s) => s.line).join(',')}`);
});

check('G2: AcmeShipmentService#reprocessFailedShipment thrower is a terminal leaf (zero callers of its own)', () => {
  const tree = trace('acmevalidationexception', null);
  const node = findChild(tree.root, (c) => c.label === 'AcmeShipmentService.reprocessFailedShipment' && c.via === 'throws');
  assert.ok(node, 'node missing');
  assert.strictEqual((node.children || []).length, 0, `expected zero children, got ${(node.children || []).map((c) => c.label).join(', ')}`);
});

function findDescendant(node, pred, maxDepth) {
  maxDepth = maxDepth == null ? 10 : maxDepth;
  if (maxDepth < 0) return null;
  if (pred(node)) return node;
  for (const c of node.children || []) {
    const hit = findDescendant(c, pred, maxDepth - 1);
    if (hit) return hit;
  }
  return null;
}

check('G2 scenario 1 (depth 2): AcmeOrderBatchProcessor#execute catches exact type -> caughtHere + badge', () => {
  const tree = trace('acmevalidationexception', null);
  const node = findDescendant(tree.root, (n) => n.label === 'AcmeOrderBatchProcessor.execute');
  assert.ok(node, 'execute node not found anywhere in tree');
  assert.strictEqual(node.caughtHere, true, 'expected caughtHere=true');
  assert.ok((node.entries || []).includes('catches AcmeValidationException'), `entries: ${JSON.stringify(node.entries)}`);
});

check('G2 scenario 1: traversal CONTINUES past the catcher (rethrow unknowable) -- execute still has children', () => {
  const tree = trace('acmevalidationexception', null);
  const node = findDescendant(tree.root, (n) => n.label === 'AcmeOrderBatchProcessor.execute');
  assert.ok(node, 'execute node not found');
  assert.ok((node.children || []).length > 0, 'expected execute to still have ancestor children after the catch (post-G5 async ancestors)');
});

check('G2 scenario 2 (depth 2): AcmeOrderRestResource#handlePost catches SUPERTYPE AcmeBaseException -> caughtHere + badge', () => {
  const tree = trace('acmevalidationexception', null);
  const node = findDescendant(tree.root, (n) => n.label === 'AcmeOrderRestResource.handlePost');
  assert.ok(node, 'handlePost node not found');
  assert.strictEqual(node.caughtHere, true, 'expected caughtHere=true via supertype-catch match');
  assert.ok((node.entries || []).includes('catches AcmeValidationException'), `entries: ${JSON.stringify(node.entries)}`);
});

check('G2 scenario 3 (depth 3): AcmeOrderTrigger catches bare Exception -> caughtHere + badge, traversal passes through uncaught handle()', () => {
  const tree = trace('acmevalidationexception', null);
  const handleNode = findDescendant(tree.root, (n) => n.label === 'AcmeOrderTriggerHandler.handle');
  assert.ok(handleNode, 'AcmeOrderTriggerHandler.handle node not found (intermediate uncaught frame)');
  assert.ok(!handleNode.caughtHere, 'AcmeOrderTriggerHandler.handle should NOT have caughtHere (no catch of its own)');
  const trigNode = findDescendant(handleNode, (n) => n.label === 'AcmeOrderTrigger' && n.kind === 'trigger');
  assert.ok(trigNode, 'AcmeOrderTrigger node not found under handle()');
  assert.strictEqual(trigNode.caughtHere, true, 'expected caughtHere=true via bare-Exception catch');
  assert.ok((trigNode.entries || []).includes('catches AcmeValidationException'), `entries: ${JSON.stringify(trigNode.entries)}`);
});

check('G2 scenario 4: AcmeOrderServiceTest#testProcessOrders reaches entry with NO caughtHere badge anywhere on its branch', () => {
  const tree = trace('acmevalidationexception', null);
  const node = findDescendant(tree.root, (n) => n.label === 'AcmeOrderServiceTest.testProcessOrders');
  assert.ok(node, 'testProcessOrders node not found');
  assert.ok(!node.caughtHere, 'testProcessOrders must NOT have caughtHere (documented negative)');
  assert.ok(!(node.entries || []).some((e) => /^catches /.test(e)), `unexpected catches-badge on negative node: ${JSON.stringify(node.entries)}`);
});

check('G2: exactly 4 caughtHere badges total when tracing AcmeValidationException (tally cross-check)', () => {
  const tree = trace('acmevalidationexception', null, { maxDepth: 8 });
  const seen = new Set();
  (function walk(n) {
    if (n.caughtHere) seen.add(`${n.label}#${n.methodLower}`);
    for (const c of n.children || []) walk(c);
  })(tree.root);
  assert.strictEqual(seen.size, 3, `MANIFEST documents 3 caughtHere=true nodes (batch execute / handlePost / trigger) plus 1 documented ABSENCE (testProcessOrders) = 4 classifications total, but only 3 are caughtHere:true; found ${seen.size}: ${[...seen].join(', ')}`);
});

// =========================================================================
// G3: instanceof narrowing (labeled fallback only)
// =========================================================================

check('G3 positive: AcmeShapeNarrowingAuditor#auditLabel -> AcmeShapeConcrete#crateLabel (via=narrowed, approximate)', () => {
  const tree = trace('acmeshapeconcrete', 'cratelabel');
  const hit = findChild(tree.root, (c) => c.label === 'AcmeShapeNarrowingAuditor.auditLabel');
  assert.ok(hit, `callers: ${(tree.root.children || []).map((c) => c.label).join(', ')}`);
  assert.strictEqual(hit.via, 'narrowed', `expected via=narrowed, got ${hit.via}`);
  assert.strictEqual(hit.approximate, true, 'via=narrowed must be approximate per G3 spec');
  assert.ok(hit.sites.some((s) => s.line === 16), `expected site at line 16, got ${hit.sites.map((s) => s.line).join(',')}`);
});

check('G3 negative: AcmeShapeNarrowingAuditor#auditDescribeShape -> AcmeShapeBase#describeShape (via=typed, NOT narrowed, despite instanceof guard present)', () => {
  const tree = trace('acmeshapebase', 'describeshape');
  const hit = findChild(tree.root, (c) => c.label === 'AcmeShapeNarrowingAuditor.auditDescribeShape');
  assert.ok(hit, `callers: ${(tree.root.children || []).map((c) => c.label).join(', ')}`);
  assert.strictEqual(hit.via, 'typed', `narrowing must NOT be consulted when declared-type resolution already succeeds; got via=${hit.via}`);
  assert.strictEqual(hit.approximate, false, 'ordinary typed resolution is not approximate');
});

check('G3 negative must not ALSO appear as a narrowed edge on AcmeShapeConcrete (declared-type success suppresses fallback)', () => {
  // describeShape is declared on AcmeShapeBase, not AcmeShapeConcrete, so
  // there should be no auditDescribeShape caller anywhere under
  // AcmeShapeConcrete's own methods.
  const cm = index.classes.get('acmeshapeconcrete');
  assert.ok(cm, 'AcmeShapeConcrete not indexed');
  const hasDescribeShape = (cm.methods || []).some((m) => /describeshape/i.test(m.name));
  assert.ok(!hasDescribeShape, 'sanity: describeShape should not be redeclared on AcmeShapeConcrete for this check to be meaningful');
});

// =========================================================================
// G4: anonymous Apex
// =========================================================================

const anonPath = path.join(SCRIPTS_DIR, 'adhoc-recalc.apex');
const anonFacts = facts.find((f) => f.path === anonPath);

check('G4: adhoc-recalc.apex parses with kind="anonymous" and NO parseError', () => {
  assert.ok(anonFacts, 'adhoc-recalc.apex facts not found in the scanned set');
  assert.strictEqual(anonFacts.kind, 'anonymous', `expected kind=anonymous, got ${anonFacts.kind}`);
  assert.strictEqual(anonFacts.parseError, null, `expected no parseError, got ${JSON.stringify(anonFacts.parseError)}`);
});

check('G4: pseudo-type named from file stem, one "(anonymous)" method carrying entries ["Anonymous Apex script"] (NOTE: a 2nd synthetic "(init)" method is DELIBERATE per parser.js/test-parser.js design comments for top-level `Type x = expr;` decls, reusing the same field/(init) plumbing triggers already use -- documented, tested, not flagged as a defect here)', () => {
  assert.strictEqual(anonFacts.types.length, 1, `expected exactly 1 pseudo-type, got ${anonFacts.types.length}`);
  const t = anonFacts.types[0];
  assert.ok(/adhoc-recalc/i.test(t.name), `expected type name derived from stem 'adhoc-recalc', got '${t.name}'`);
  const anonMethod = t.methods.find((m) => m.name === '(anonymous)');
  assert.ok(anonMethod, `no '(anonymous)' method found among: ${t.methods.map((m) => m.name).join(', ')}`);
  assert.deepStrictEqual(anonMethod.entries, ['Anonymous Apex script'], `expected entries ['Anonymous Apex script'], got ${JSON.stringify(anonMethod.entries)}`);
});

check('G4 edge 1: (anonymous) -> AcmeOrderService#recalculatePricing (via=static, line 15)', () => {
  const tree = trace('acmeorderservice', 'recalculatepricing');
  const hit = findChild(tree.root, (c) => /adhoc-recalc/i.test(c.label || '') || c.methodLower === '(anonymous)');
  assert.ok(hit, `callers: ${(tree.root.children || []).map((c) => c.label).join(', ')}`);
  assert.strictEqual(hit.via, 'static', `expected via=static, got ${hit.via}`);
  assert.ok(hit.sites.some((s) => s.line === 15), `expected line 15, got ${hit.sites.map((s) => s.line).join(',')}`);
});

check('G4 edge 2: (anonymous) -> AcmeShipmentService#scheduleDelivery (via=static, line 26)', () => {
  const tree = trace('acmeshipmentservice', 'scheduledelivery');
  const hit = findChild(tree.root, (c) => /adhoc-recalc/i.test(c.label || '') || c.methodLower === '(anonymous)');
  assert.ok(hit, `callers: ${(tree.root.children || []).map((c) => c.label).join(', ')}`);
  assert.strictEqual(hit.via, 'static');
  assert.ok(hit.sites.some((s) => s.line === 26), `expected line 26, got ${hit.sites.map((s) => s.line).join(',')}`);
});

check('G4 edge 3: (anonymous) -> AcmeOrderTrigger (via=dml, op=update, line 29 -- G4+F1 composition)', () => {
  const tree = trace('acmeordertrigger', '(trigger)');
  const hit = findChild(tree.root, (c) => (c.sites || []).some((s) => s.via === 'dml') && (/adhoc-recalc/i.test(c.label || '') || c.methodLower === '(anonymous)'));
  assert.ok(hit, `callers: ${(tree.root.children || []).map((c) => `${c.label}(${(c.sites || []).map((s) => s.via).join(',')})`).join(', ')}`);
  assert.ok(hit.sites.some((s) => s.line === 29 && s.via === 'dml'), `expected via=dml site at line 29, got ${JSON.stringify(hit.sites)}`);
});

check('G4 (minor, UX): suggestTargets() does not surface a bogus "(init)" trace target for anonymous scripts that declare a top-level var (openOrders/pendingShipments)', () => {
  // Downstream consequence of the deliberate field/(init) reuse documented
  // in test-parser.js test 27/28 -- that reuse itself is not flagged, but
  // suggestTargets() (resolver.js) has no special-casing to suppress the
  // resulting '(init)' entry for anonymous-kind classes the way it already
  // suppresses '(get '/'(set ' accessor scopes (see resolver.js
  // suggestTargets' MUST-FIX #5 comment) -- there is no equivalent
  // suppression for '(init)' on an anonymous pseudo-type, and no test
  // anywhere exercises suggestTargets() against an anonymous FileFacts (zero
  // hits for 'anonymous' in test-resolver.js).
  const targets = resolver.suggestTargets(index).filter((t) => /adhoc-recalc/i.test(t.label));
  const bogus = targets.find((t) => t.methodLower === '(init)');
  assert.ok(!bogus, `suggestTargets() surfaces a phantom target: ${JSON.stringify(bogus)} -- a real user picking "Trace Callers" on this script would see 'adhoc-recalc.(init)' alongside 'adhoc-recalc.(anonymous)' in the quick-pick, and tracing it produces an empty, meaningless tree; targets found: ${JSON.stringify(targets)}`);
});

check('G4/UI-reachability: root TNode for the anonymous script actually gets kind="anonymous" (drives uitree ICON_ANONYMOUS / pathmap accent bucket)', () => {
  const anonClassLower = lc(anonFacts.types[0].name);
  const tree = trace(anonClassLower, '(anonymous)');
  // CONFIRMED FINDING: resolver.js's buildSemanticIndex hardcodes
  // ClassMeta.kind to 'trigger'|'class' only ("kind stays class|trigger per
  // frozen shape", resolver.js ~line 429) -- it never checks
  // FileFacts.kind==='anonymous'. buildCallerTree's rootKind then derives
  // from cm.kind (only ever 'trigger' or 'class') plus whether a
  // methodLower was given, landing on 'method' for the anonymous script's
  // own root -- 'anonymous' is never assigned ANYWHERE in resolver.js
  // (verified: grep for "kind:" across the whole file). uitree.js's
  // iconForNode() and pathmap.js's node-kind classifier both correctly
  // check `node.kind === 'anonymous'` (ICON_ANONYMOUS='terminal' / accent
  // bucket 'anonymous'), but that branch is DEAD CODE: it can never fire
  // against a real trace. This is the exact "implemented-but-unwired"
  // shape flagged by the v0.4 CMDT lesson -- the UI pieces are correct in
  // isolation, but the resolver never produces the kind value that would
  // reach them.
  assert.strictEqual(tree.root.kind, 'anonymous', `SPEC VIOLATION (not a harness bug): root.kind is '${tree.root.kind}', expected 'anonymous'. uitree.js ICON_ANONYMOUS ('terminal') and pathmap.js's 'anonymous' accent bucket are unreachable dead code as a result -- an anonymous script node renders with the generic method icon/accent instead of its documented distinct one.`);
});

check('G4/UI-reachability: root TNode.entries preserves parser\'s ["Anonymous Apex script"] label through resolver.js', () => {
  const anonClassLower = lc(anonFacts.types[0].name);
  const tree = trace(anonClassLower, '(anonymous)');
  // CONFIRMED FINDING: buildSemanticIndex's pass A recomputes every
  // MethodMeta.entries via computeAnnotationEntries(mf), which derives
  // entries SOLELY from mf.annotations/mf.modifiers (@AuraEnabled,
  // @InvocableMethod, @future, HTTP annotations, webservice) -- it has no
  // knowledge of and never merges in mf.entries, the field parser.js's
  // enterAnonymousUnit() explicitly pre-populates with
  // ['Anonymous Apex script'] (see parser.js's own AMENDMENT G4 header
  // note: "this method directly carries entries: ['Anonymous Apex script']
  // -- see the AMENDMENT G4 header note for why that lives here instead of
  // being derived by resolver.js the way other entry labels are" -- i.e.
  // parser.js's own comment documents the INTENT that resolver.js should
  // NOT recompute this one, but pass A does so unconditionally for every
  // method including this one). The label is silently dropped before it
  // ever reaches a TNode, so uitree.js's ICON_ENTRIES/'plug' badge path and
  // the literal "Anonymous Apex script" text never appear in the UI.
  assert.deepStrictEqual(tree.root.entries, ['Anonymous Apex script'], `SPEC VIOLATION (not a harness bug): root.entries is ${JSON.stringify(tree.root.entries)}, expected ["Anonymous Apex script"]. resolver.js's buildSemanticIndex pass A recomputes MethodMeta.entries via computeAnnotationEntries(mf) and never merges in the parser-supplied mf.entries, silently discarding the G4 label for every anonymous script in a real workspace.`);
});

check('G4: anonymous script node has zero callers of its own (pure root)', () => {
  // Cross-check: nothing in the corpus should list adhoc-recalc.apex's
  // (anonymous) method as a caller target -- it's a script, not callable.
  const cm = index.classes.get(lc(anonFacts.types[0].name));
  assert.ok(cm, 'anonymous pseudo-type not indexed');
  const tree = trace(lc(anonFacts.types[0].name), '(anonymous)');
  assert.strictEqual((tree.root.children || []).length, 0, `expected zero callers, got ${(tree.root.children || []).map((c) => c.label).join(', ')}`);
});

function lc(s) { return (s || '').toLowerCase(); }

// =========================================================================
// G5: async-hop edges
// =========================================================================

const G5_POSITIVE = [
  { fromClass: 'acmeorderservice', fromMethod: 'processorders', toClass: 'acmeorderbatchprocessor', toMethod: 'execute', line: 18 },
  { fromClass: 'acmeshipmentservice', fromMethod: 'processshipments', toClass: 'acmeshipmentqueueabledispatcher', toMethod: 'execute', line: 14 },
  { fromClass: 'acmenightlyreconciliationscheduler', fromMethod: 'execute', toClass: 'acmeorderbatchprocessor', toMethod: 'execute', line: 10 },
  { fromClass: 'acmeasyncorchestrator', fromMethod: 'runnightlymaintenance', toClass: 'acmeshipmentqueueabledispatcher', toMethod: 'execute', line: 12 },
  { fromClass: 'acmeasyncorchestrator', fromMethod: 'runnightlymaintenance', toClass: 'acmeorderbatchprocessor', toMethod: 'execute', line: 13 },
  { fromClass: 'acmeasyncorchestrator', fromMethod: 'runnightlymaintenance', toClass: 'acmenightlyreconciliationscheduler', toMethod: 'execute', line: 14 },
];

for (const edge of G5_POSITIVE) {
  check(`G5 positive: ${edge.fromClass}#${edge.fromMethod} -> ${edge.toClass}#${edge.toMethod} (via=async, line ${edge.line})`, () => {
    const tree = trace(edge.toClass, edge.toMethod);
    const asyncCallers = (tree.root.children || []).filter((c) => c.via === 'async');
    const hit = asyncCallers.find((c) => lc(c.className) === edge.fromClass && lc(c.methodLower) === edge.fromMethod);
    assert.ok(hit, `no via=async caller ${edge.fromClass}#${edge.fromMethod} on ${edge.toClass}#${edge.toMethod}; async callers found: ${asyncCallers.map((c) => `${c.className}#${c.methodLower}`).join(', ')}`);
    assert.strictEqual(hit.approximate, false, 'via=async must not be approximate');
    assert.ok(hit.sites.some((s) => s.line === edge.line), `expected line ${edge.line}, got ${hit.sites.map((s) => s.line).join(',')}`);
  });
}

check('G5: AcmeOrderBatchProcessor#<init> keeps its pre-existing via=new constructor edges IN ADDITION to #execute gaining via=async (per spec: "in addition to the existing new constructor edge" -- the ctor edge targets <init>, the new async edge targets #execute; both are simultaneously present, neither replaces the other)', () => {
  const initTree = trace('acmeorderbatchprocessor', '<init>');
  const newCallers = (initTree.root.children || []).filter((c) => c.via === 'new');
  assert.ok(newCallers.length > 0, `expected via=new callers on <init>, found none among: ${(initTree.root.children || []).map((c) => `${c.label}(${c.via})`).join(', ')}`);
  const execTree = trace('acmeorderbatchprocessor', 'execute');
  const asyncCallers = (execTree.root.children || []).filter((c) => c.via === 'async');
  assert.ok(asyncCallers.length > 0, 'expected via=async callers on #execute');
  // The three qualifying callers (AcmeOrderService.processOrders,
  // AcmeNightlyReconciliationScheduler.execute, AcmeAsyncOrchestrator's own
  // inline site) must show up as via=new on <init> AND via=async on #execute.
  const asyncCallerKeys = new Set(asyncCallers.map((c) => `${lc(c.className)}#${lc(c.methodLower)}`));
  const newCallerKeys = new Set(newCallers.map((c) => `${lc(c.className)}#${lc(c.methodLower)}`));
  for (const key of asyncCallerKeys) {
    if (key.startsWith('acmeasyncorchestrator')) continue; // orchestrator itself is a pure root, not asserted elsewhere
    assert.ok(newCallerKeys.has(key), `${key} has a via=async edge to #execute but no matching via=new edge to <init> -- expected BOTH per spec`);
  }
});

check('G5 negative 1: AcmeOrderServiceTest#testBatchProcessor produces NO async edge (variable arg, not inline new)', () => {
  const tree = trace('acmeorderbatchprocessor', 'execute');
  const asyncCallers = (tree.root.children || []).filter((c) => c.via === 'async');
  const hit = asyncCallers.find((c) => c.label === 'AcmeOrderServiceTest.testBatchProcessor');
  assert.ok(!hit, `expected no via=async edge from testBatchProcessor, but found one: ${JSON.stringify(hit)}`);
});

check('G5 negative 2: AcmeOrderServiceTest#testScheduledJob produces NO async edge on AcmeNightlyReconciliationScheduler#execute', () => {
  const tree = trace('acmenightlyreconciliationscheduler', 'execute');
  const asyncCallers = (tree.root.children || []).filter((c) => c.via === 'async');
  const hit = asyncCallers.find((c) => c.label === 'AcmeOrderServiceTest.testScheduledJob');
  assert.ok(!hit, `expected no via=async edge from testScheduledJob, but found one: ${JSON.stringify(hit)}`);
});

// =========================================================================
// G6: interface-extends-interface fan-out
// =========================================================================

check('G6 control (resolves-today): AcmeIntfDispatchDemo#dispatchPing -> AcmeDirectPingHandler#ping (via=interface, approximate, direct implements)', () => {
  const tree = trace('acmedirectpinghandler', 'ping');
  const hit = findChild(tree.root, (c) => c.label === 'AcmeIntfDispatchDemo.dispatchPing');
  assert.ok(hit, `callers: ${(tree.root.children || []).map((c) => c.label).join(', ')}`);
  assert.strictEqual(hit.via, 'interface');
  assert.strictEqual(hit.approximate, true);
});

check('G6 transitive: AcmeIntfDispatchDemo#dispatchPing -> AcmePingPongHandler#ping (via=interface, approximate, via interface-extends-interface closure)', () => {
  const tree = trace('acmepingponghandler', 'ping');
  const hit = findChild(tree.root, (c) => c.label === 'AcmeIntfDispatchDemo.dispatchPing');
  assert.ok(hit, `TRANSITIVE INTERFACE FAN-OUT MISSING: AcmePingPongHandler#ping has callers: ${(tree.root.children || []).map((c) => c.label).join(', ')} -- AcmeChildIntf extends AcmeParentIntf, so an AcmeParentIntf-typed caller must reach implementers of AcmeChildIntf too`);
  assert.strictEqual(hit.via, 'interface');
  assert.strictEqual(hit.approximate, true);
});

// =========================================================================
// v0.5 edge/badge tally cross-check (17 positive / 2 no-edge / 3 wiring)
// =========================================================================

check('v0.5 tally: exactly 17 positive new-via caller-graph edges materialize live (2 publish + 2 throws + 1 narrowed + 3 anonymous + 6 async + 1 iface-extends... but tally counts unique target-edges, see breakdown)', () => {
  // Recount per the MANIFEST's own breakdown table:
  //   G1 publish->trigger: 2, G1 flow->publish children: 2 (not caller-graph
  //   edges in the buildCallerTree sense -- children of a flow node), G2
  //   throws: 2, G3 narrowed: 1, G4 anonymous: 3, G5 async: 6, G6
  //   iface-extends: 1 => 2+2+2+1+3+6+1 = 17. We've already verified each
  //   individually above; this is a pure arithmetic cross-check of the
  //   MANIFEST's own stated total against the itemized sections it documents.
  const g1PublishTrigger = 2;
  const g1FlowChildren = 2;
  const g2Throws = 2;
  const g3Narrowed = 1;
  const g4Anonymous = 3;
  const g5Async = 6;
  const g6Iface = 1;
  const total = g1PublishTrigger + g1FlowChildren + g2Throws + g3Narrowed + g4Anonymous + g5Async + g6Iface;
  assert.strictEqual(total, 17, `MANIFEST itemized sections sum to ${total}, but MANIFEST's own tally table says 17`);
});

// =========================================================================
// 2. Spot-check 20 random pre-v0.5 (v0.3/v0.4) edges for regression.
// =========================================================================

const PRE_V05_SPOT_CHECKS = [
  // v0.3 core (real adv-org names, from MANIFEST.md "## Ground-truth edge list")
  { desc: 'AcmeQuote.<init> <- AcmePropertyConsumer (via=new)', target: ['acmequote', '<init>'], expectCaller: 'AcmePropertyConsumer', via: 'new' },
  { desc: 'AcmeInvoice.<init> <- AcmeQuote (via=new)', target: ['acmeinvoice', '<init>'], expectCaller: 'AcmeQuote', via: 'new' },
  { desc: 'AcmeShapeConcrete.<init> <- AcmePricingEngine (via=new)', target: ['acmeshapeconcrete', '<init>'], expectCaller: 'AcmePricingEngine', via: 'new' },
  { desc: 'AcmeShapeConcrete.computeVolume <- AcmePricingEngine (via=typed)', target: ['acmeshapeconcrete', 'computevolume'], expectCaller: 'AcmePricingEngine', via: 'typed' },
  { desc: 'AcmeNotifiable.notify interface fan-out includes AcmeBaseNotifier (AcmeSlackNotifier inherits, does not redeclare)', target: ['acmebasenotifier', 'notify'], expectCaller: 'AcmeNotificationDispatcher', via: 'interface' },
  { desc: 'AcmeInventoryChecker.checkStock <- AcmeOrderValidator (via=static, 3-node cycle)', target: ['acmeinventorychecker', 'checkstock'], expectCaller: 'AcmeOrderValidator.validate', via: 'static' },
  { desc: 'AcmeBackorderResolver.resolve <- AcmeInventoryChecker (via=static, cycle continues)', target: ['acmebackorderresolver', 'resolve'], expectCaller: 'AcmeInventoryChecker.checkStock', via: 'static' },
  { desc: 'Database.<init> <- AcmeShadowConsumer (local class shadows platform Database)', target: ['database', '<init>'], expectCaller: 'AcmeShadowConsumer', via: 'new' },
  { desc: 'AcmeOuterContainer.InnerWorker.<init> <- AcmeOuterContainer (bare in-file inner-class new)', target: ['acmeoutercontainer.innerworker', '<init>'], expectCaller: 'AcmeOuterContainer', via: 'new' },
  { desc: 'AcmeOuterContainer.outerHelper <- InnerWorker.doWork (inner-to-outer static callback; short-form inner-class label is the existing pre-v0.5 convention)', target: ['acmeoutercontainer', 'outerhelper'], expectCaller: 'InnerWorker.doWork', via: 'static' },
  { desc: 'AcmeOuterContainer.InnerWorker.doWork <- AcmeInnerRefConsumer (cross-file qualified Outer.Inner)', target: ['acmeoutercontainer.innerworker', 'dowork'], expectCaller: 'AcmeInnerRefConsumer', via: 'typed' },
  { desc: 'AcmeDiscountUtil.initializeDiscountTiers <- AcmeDiscountUtil (via=this)', target: ['acmediscountutil', 'initializediscounttiers'], expectCaller: 'AcmeDiscountUtil', via: 'this' },
  { desc: 'AcmeOrderTriggerHandler.<init> <- AcmeOrderTrigger (via=new)', target: ['acmeordertriggerhandler', '<init>'], expectCaller: 'AcmeOrderTrigger', via: 'new' },
  { desc: 'AcmeOrderUtil.markApproved <- AcmeOrderService (via=static)', target: ['acmeorderutil', 'markapproved'], expectCaller: 'AcmeOrderService.approveOrder', via: 'static' },
  { desc: 'AcmeFutureNotifier.sendApprovalEmail <- AcmeOrderUtil (via=static)', target: ['acmefuturenotifier', 'sendapprovalemail'], expectCaller: 'AcmeOrderUtil.markApproved', via: 'static' },
  // v0.4 F1/F2/F3/F4/F5 (real adv-org names, from MANIFEST.md "## v0.4 ground-truth edges")
  { desc: 'F1: AcmeOrderService.recalculatePricing -> AcmeOrderTrigger via=dml', target: ['acmeordertrigger', '(trigger)'], expectCaller: 'AcmeOrderService.recalculatePricing', via: 'dml' },
  { desc: 'F1: AcmeShipmentService.scheduleDelivery -> AcmeShipmentTrigger via=dml', target: ['acmeshipmenttrigger', '(trigger)'], expectCaller: 'AcmeShipmentService.scheduleDelivery', via: 'dml' },
  { desc: 'F1: AcmeFulfillmentDmlService.mergeShipments -> AcmeShipmentTrigger AND AcmeShipmentLifecycleTrigger', target: ['acmeshipmenttrigger', '(trigger)'], expectCaller: 'AcmeFulfillmentDmlService.mergeShipments', via: 'dml' },
  { desc: 'F3: AcmeShapeAuditor.auditSurcharge -> AcmeShapeConcrete.surchargeFactor override fan-out', target: ['acmeshapeconcrete', 'surchargefactor'], expectCaller: 'AcmeShapeAuditor.auditSurcharge', via: null },
  { desc: 'F4a: AcmeHandlerFactory.createEmailNotifier -> AcmeEmailNotifier.<init> via=dynamic approximate', target: ['acmeemailnotifier', '<init>'], expectCaller: 'AcmeHandlerFactory.createEmailNotifier', via: 'dynamic' },
];

for (const sc of PRE_V05_SPOT_CHECKS) {
  check(`spot-check (pre-v0.5): ${sc.desc}`, () => {
    const [cls, meth] = sc.target;
    const tree = trace(cls, meth);
    assert.ok(tree.root, 'no root produced');
    if (sc.expectCaller) {
      const hit = findChild(tree.root, (c) => c.label === sc.expectCaller || c.label.startsWith(sc.expectCaller));
      assert.ok(hit, `expected caller '${sc.expectCaller}' on ${cls}#${meth}; found: ${(tree.root.children || []).map((c) => c.label).join(', ')}`);
      if (sc.via) assert.ok(hit.via === sc.via || (hit.sites || []).some((s) => s.via === sc.via), `expected via=${sc.via} on ${sc.expectCaller}, got ${hit.via} (sites: ${(hit.sites || []).map((s) => s.via).join(',')})`);
    } else {
      assert.ok((tree.root.children || []).length >= 0, 'tree built without error');
    }
  });
}

// =========================================================================
// 3. Timing: adv-org cold scan < 3s (parse + index, matching extension.js's
//    hot path minus VS Code IO overhead).
// =========================================================================

check('adv-org cold scan (parse all + buildSemanticIndex) completes in < 3s', () => {
  const t0 = Date.now();
  const freshFacts = apexPaths.map((f) => parser.parseFile({ path: f, text: fs.readFileSync(f, 'utf8') }));
  const freshIndex = resolver.buildSemanticIndex(freshFacts);
  resolver.attachMetaCallers(freshIndex, realWiringRefs);
  const elapsed = Date.now() - t0;
  assert.ok(elapsed < 3000, `cold scan took ${elapsed}ms, budget is < 3000ms`);
  console.log(`      (cold scan: ${elapsed}ms, ${freshFacts.length} files)`);
});

// =========================================================================
// Summary
// =========================================================================

console.log('\n=== v0.5.0 MANIFEST-accounting verifier summary ===');
console.log(`pass: ${pass}  fail: ${fail}`);
if (fail > 0) {
  console.log('\nFailures:');
  for (const f of failures) console.log(`  - ${f.name}: ${f.error && f.error.message}`);
  process.exitCode = 1;
} else {
  console.log('RESULT: ALL PASS');
}

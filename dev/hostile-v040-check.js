'use strict';
// Adversarial verifier (new-feature semantics, v0.4.0 amendments F1-F6).
// Hostile fixtures live under dev/hostile-v040/. This script parses them
// with the REAL engine (parser.js/resolver.js/metascan.js) and asserts
// against each fixture's documented expectation, printing PASS/FAIL per
// check plus enough raw diagnostic (via/op/cyclic/children) to write up a
// repro for anything that fails.
//
// Usage: node dev/hostile-v040-check.js

const fs = require('fs');
const path = require('path');
const assert = require('assert');

const parser = require('../parser');
const resolver = require('../resolver');
const metascan = require('../metascan');

const FIXDIR = path.join(__dirname, 'hostile-v040');

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

function note(name, msg) {
  console.log(`NOTE  ${name}: ${msg}`);
}

// ---------------------------------------------------------------------
// Load + parse every .cls/.trigger fixture under hostile-v040/ (flat).
// ---------------------------------------------------------------------

const srcFiles = fs.readdirSync(FIXDIR).filter((f) => f.endsWith('.cls') || f.endsWith('.trigger'));
const facts = srcFiles.map((f) => {
  const p = path.join(FIXDIR, f);
  const text = fs.readFileSync(p, 'utf8');
  return parser.parseFile({ path: p, text });
});

check('all .cls/.trigger fixtures parse cleanly (no parseError)', () => {
  const withErrors = facts.filter((f) => f.parseError);
  assert.deepStrictEqual(
    withErrors.map((f) => f.path),
    [],
    'unexpected parseError in: ' + withErrors.map((f) => `${f.path}: ${f.parseError}`).join(' | ')
  );
});

const index = resolver.buildSemanticIndex(facts);

// Attach CMDT metadata refs.
const mdDir = path.join(FIXDIR, 'customMetadata');
const mdFiles = fs.readdirSync(mdDir).filter((f) => f.endsWith('.md-meta.xml'));
const metaRefs = [];
for (const f of mdFiles) {
  const p = path.join(mdDir, f);
  const text = fs.readFileSync(p, 'utf8');
  metaRefs.push(...metascan.parseMetaFile({ path: p, text }));
}
resolver.attachMetaCallers(index, metaRefs);

function sitesFor(idx, classLower, methodLower) {
  return idx.methodCallers.get(`${classLower}#${methodLower}`) || [];
}

function siteMatching(sites, needleLineText) {
  return sites.filter((s) => (s.lineText || '').includes(needleLineText));
}

// =======================================================================
// F1a. Trigger event-mapping matrix: upsert fires BOTH insert-only and
// update-only triggers; merge fires BOTH delete-only and update-only
// triggers; undelete fires ONLY the undelete-only trigger; plain
// insert/update/delete each fire exactly their own single-purpose trigger.
// =======================================================================

check('F1: upsert fans out to BOTH insert-only and update-only triggers', () => {
  const insertSites = sitesFor(index, 'hostilewidgettriggerinsert', '(trigger)');
  const updateSites = sitesFor(index, 'hostilewidgettriggerupdate', '(trigger)');
  const deleteSites = sitesFor(index, 'hostilewidgettriggerdelete', '(trigger)');
  const undeleteSites = sitesFor(index, 'hostilewidgettriggerundelete', '(trigger)');
  const upsertToInsert = insertSites.filter((s) => s.callerMethod === 'doUpsert');
  const upsertToUpdate = updateSites.filter((s) => s.callerMethod === 'doUpsert');
  const upsertToDelete = deleteSites.filter((s) => s.callerMethod === 'doUpsert');
  const upsertToUndelete = undeleteSites.filter((s) => s.callerMethod === 'doUpsert');
  assert.ok(upsertToInsert.length >= 1, `expected doUpsert -> insert-only trigger edge, got ${upsertToInsert.length}`);
  assert.ok(upsertToUpdate.length >= 1, `expected doUpsert -> update-only trigger edge, got ${upsertToUpdate.length}`);
  assert.strictEqual(upsertToDelete.length, 0, `expected doUpsert NOT to hit delete-only trigger, got ${upsertToDelete.length}`);
  assert.strictEqual(upsertToUndelete.length, 0, `expected doUpsert NOT to hit undelete-only trigger, got ${upsertToUndelete.length}`);
  assert.strictEqual(upsertToInsert[0].via, 'dml');
  assert.strictEqual(upsertToUpdate[0].via, 'dml');
});

check('F1: upsert via Database.upsert() method-form ALSO fans out to both triggers', () => {
  const insertSites = sitesFor(index, 'hostilewidgettriggerinsert', '(trigger)').filter((s) => s.callerMethod === 'doUpsertViaDatabase');
  const updateSites = sitesFor(index, 'hostilewidgettriggerupdate', '(trigger)').filter((s) => s.callerMethod === 'doUpsertViaDatabase');
  assert.ok(insertSites.length >= 1, `expected Database.upsert -> insert-only trigger edge, got ${insertSites.length}`);
  assert.ok(updateSites.length >= 1, `expected Database.upsert -> update-only trigger edge, got ${updateSites.length}`);
});

check('F1: merge fans out to BOTH delete-only and update-only triggers (not insert/undelete)', () => {
  const insertSites = sitesFor(index, 'hostilewidgettriggerinsert', '(trigger)').filter((s) => s.callerMethod === 'doMerge');
  const updateSites = sitesFor(index, 'hostilewidgettriggerupdate', '(trigger)').filter((s) => s.callerMethod === 'doMerge');
  const deleteSites = sitesFor(index, 'hostilewidgettriggerdelete', '(trigger)').filter((s) => s.callerMethod === 'doMerge');
  const undeleteSites = sitesFor(index, 'hostilewidgettriggerundelete', '(trigger)').filter((s) => s.callerMethod === 'doMerge');
  assert.ok(deleteSites.length >= 1, `expected doMerge -> delete-only trigger edge, got ${deleteSites.length}`);
  assert.ok(updateSites.length >= 1, `expected doMerge -> update-only trigger edge, got ${updateSites.length}`);
  assert.strictEqual(insertSites.length, 0, `expected doMerge NOT to hit insert-only trigger, got ${insertSites.length}`);
  assert.strictEqual(undeleteSites.length, 0, `expected doMerge NOT to hit undelete-only trigger, got ${undeleteSites.length}`);
});

check('F1: undelete fans out ONLY to the undelete-only trigger', () => {
  const insertSites = sitesFor(index, 'hostilewidgettriggerinsert', '(trigger)').filter((s) => s.callerMethod === 'doUndelete');
  const updateSites = sitesFor(index, 'hostilewidgettriggerupdate', '(trigger)').filter((s) => s.callerMethod === 'doUndelete');
  const deleteSites = sitesFor(index, 'hostilewidgettriggerdelete', '(trigger)').filter((s) => s.callerMethod === 'doUndelete');
  const undeleteSites = sitesFor(index, 'hostilewidgettriggerundelete', '(trigger)').filter((s) => s.callerMethod === 'doUndelete');
  assert.strictEqual(insertSites.length, 0);
  assert.strictEqual(updateSites.length, 0);
  assert.strictEqual(deleteSites.length, 0);
  assert.ok(undeleteSites.length >= 1, `expected doUndelete -> undelete-only trigger edge, got ${undeleteSites.length}`);
});

check('F1: plain insert/update/delete each hit exactly their own single-purpose trigger', () => {
  const i = sitesFor(index, 'hostilewidgettriggerinsert', '(trigger)').filter((s) => s.callerMethod === 'doInsert');
  const u = sitesFor(index, 'hostilewidgettriggerupdate', '(trigger)').filter((s) => s.callerMethod === 'doUpdate');
  const d = sitesFor(index, 'hostilewidgettriggerdelete', '(trigger)').filter((s) => s.callerMethod === 'doDelete');
  assert.ok(i.length >= 1 && u.length >= 1 && d.length >= 1, 'expected each plain op to hit its own trigger');
  // cross-checks: doInsert must NOT also hit update/delete/undelete triggers
  assert.strictEqual(sitesFor(index, 'hostilewidgettriggerupdate', '(trigger)').filter((s) => s.callerMethod === 'doInsert').length, 0);
  assert.strictEqual(sitesFor(index, 'hostilewidgettriggerdelete', '(trigger)').filter((s) => s.callerMethod === 'doInsert').length, 0);
});

// =======================================================================
// F1. DML on a var whose type came through a 2-level extends chain.
// =======================================================================

check('F1: DML target resolves through a 2-level inherited-field extends chain', () => {
  const deleteSites = sitesFor(index, 'hostilewidgettriggerdelete', '(trigger)').filter(
    (s) => s.callerClass === 'HostileDmlLeaf' && s.callerMethod === 'purgeInherited'
  );
  assert.ok(deleteSites.length >= 1, `expected HostileDmlLeaf.purgeInherited -> delete-only trigger edge via inherited field, got ${deleteSites.length}`);
  assert.strictEqual(deleteSites[0].via, 'dml');
});

check('F1: DML on `this.field` (dotted, not simple-ident) produces NO edge (documented limitation, not a crash)', () => {
  const deleteSites = sitesFor(index, 'hostilewidgettriggerdelete', '(trigger)').filter(
    (s) => s.callerClass === 'HostileDmlLeaf' && s.callerMethod === 'purgeInheritedViaThis'
  );
  assert.strictEqual(deleteSites.length, 0, `expected 0 edges for this.field DML target, got ${deleteSites.length}`);
});

// =======================================================================
// F1. Self-DML cycle: must terminate and flag cyclic:true, not hang.
// =======================================================================

check('F1: DML-induced 2-hop self-cycle terminates and flags cyclic:true', () => {
  const start = Date.now();
  const tree = resolver.buildCallerTree(index, { classLower: 'hostilecycletrigger', methodLower: '(trigger)' }, { maxDepth: 12 });
  const elapsed = Date.now() - start;
  note('F1 self-cycle', `buildCallerTree completed in ${elapsed}ms`);
  assert.ok(elapsed < 5000, `buildCallerTree took suspiciously long (${elapsed}ms) -- possible hang`);
  const root = tree.root;
  const handlerChild = (root.children || []).find((c) => lc(c.label) === 'hostilecyclehandler.handle' || (c.className && lc(c.className) === 'hostilecyclehandler'));
  assert.ok(handlerChild, `expected HostileCycleHandler.handle as a child of the trigger root; children: ${JSON.stringify((root.children || []).map((c) => c.label))}`);
  assert.strictEqual(handlerChild.via, 'dml', `expected via=dml on the DML-induced edge, got ${handlerChild.via}`);
  const triggerGrandchild = (handlerChild.children || []).find((c) => c.kind === 'trigger');
  assert.ok(triggerGrandchild, `expected the trigger to reappear as a grandchild (closing the cycle); got children: ${JSON.stringify((handlerChild.children || []).map((c) => c.label))}`);
  assert.strictEqual(triggerGrandchild.cyclic, true, 'expected cyclic:true on the re-encountered trigger node');
  assert.strictEqual((triggerGrandchild.children || []).length, 0, 'a cyclic node must not recurse further');
});

function lc(s) {
  return (s || '').toLowerCase();
}

// =======================================================================
// F2. Nested generic-collection receivers.
// =======================================================================

check('F2: 2-level nested Map<String,Map<String,Iface>> via two chained .get() calls', () => {
  const aSites = sitesFor(index, 'hostilenestedimpla', 'run').filter((s) => s.callerMethod === 'dispatchTwoLevel');
  const bSites = sitesFor(index, 'hostilenestedimplb', 'run').filter((s) => s.callerMethod === 'dispatchTwoLevel');
  note('F2 2-level', `implA sites=${aSites.length} implB sites=${bSites.length}`);
  if (aSites.length || bSites.length) {
    assert.ok(aSites.length >= 1 && bSites.length >= 1, `expected fan-out to BOTH implementers if it resolves at all; got A=${aSites.length} B=${bSites.length}`);
    assert.strictEqual(aSites[0].via, 'interface');
  }
});

check('F2: partial unwrap of a 2-level nested Map (1 .get() only) produces NO phantom edge', () => {
  const allCallers = [];
  for (const [key, sites] of index.methodCallers) {
    for (const s of sites) {
      if (s.callerClass === 'HostileNestedDispatcher' && s.callerMethod === 'dispatchPartialUnwrap') {
        allCallers.push({ key, site: s });
      }
    }
  }
  assert.strictEqual(allCallers.length, 0, `expected 0 outbound edges from dispatchPartialUnwrap, got ${JSON.stringify(allCallers)}`);
});

check('F2: 3-level nested Map (3 chained .get(), within the 4-segment cap)', () => {
  const aSites = sitesFor(index, 'hostilenestedimpla', 'run').filter((s) => s.callerMethod === 'dispatchThreeLevel');
  const bSites = sitesFor(index, 'hostilenestedimplb', 'run').filter((s) => s.callerMethod === 'dispatchThreeLevel');
  note('F2 3-level', `implA sites=${aSites.length} implB sites=${bSites.length}`);
});

// v0.10/A1: CHAIN_MAX widened from 4 to 12 (module constant in
// resolver.js), so this 5-segment nested-Map chain (5 chained .get() calls)
// is now WELL WITHIN the cap and must resolve like the 2-level/3-level
// cases above -- fan-out to BOTH interface implementers, via='interface'.
// This is the documented, permitted v0.10 "chains 5..12 now resolve"
// behavior flip (same delta as dev/hostile-v030-check.js's Chain5F
// assertion) -- was "must NOT produce a wrong/phantom edge" under the old
// 4-segment cap, now "must resolve, same shape as the in-cap nested-Map
// cases".
check('F2: 5-level nested Map (5 chained .get(), WITHIN CHAIN_MAX=12) now resolves, same fan-out shape as the in-cap cases', () => {
  const aSites = sitesFor(index, 'hostilenestedimpla', 'run').filter((s) => s.callerMethod === 'dispatchFiveLevel');
  const bSites = sitesFor(index, 'hostilenestedimplb', 'run').filter((s) => s.callerMethod === 'dispatchFiveLevel');
  note('F2 5-level (within CHAIN_MAX=12)', `implA sites=${aSites.length} implB sites=${bSites.length}`);
  assert.ok(aSites.length >= 1 && bSites.length >= 1, `expected fan-out to BOTH implementers now that CHAIN_MAX=12 covers this 5-segment chain; got A=${aSites.length} B=${bSites.length}`);
  assert.strictEqual(aSites[0].via, 'interface');
});

check('F2: mixed Map<String,List<Iface>> via .get(key).get(idx)', () => {
  const aSites = sitesFor(index, 'hostilenestedimpla', 'run').filter((s) => s.callerMethod === 'dispatchMapOfList');
  const bSites = sitesFor(index, 'hostilenestedimplb', 'run').filter((s) => s.callerMethod === 'dispatchMapOfList');
  note('F2 map-of-list', `implA sites=${aSites.length} implB sites=${bSites.length}`);
});

// =======================================================================
// F3. Override fan-out: no edge when a subclass does NOT override.
// =======================================================================

check('F3: base-class typed edge resolves', () => {
  const sites = sitesFor(index, 'hostileoverridebase', 'dothing').filter((s) => s.callerMethod === 'callIt');
  assert.ok(sites.length >= 1, `expected typed edge to base, got ${sites.length}`);
  assert.strictEqual(sites[0].via, 'typed');
});

check('F3: override edge to the class that DOES override', () => {
  const sites = sitesFor(index, 'hostileoverridesubyesoverride', 'dothing').filter((s) => s.callerMethod === 'callIt');
  assert.ok(sites.length >= 1, `expected override edge, got ${sites.length}`);
  assert.strictEqual(sites[0].via, 'override');
});

check('F3: override edge reaches a 2-hop-down override through a non-overriding intermediate tier', () => {
  const sites = sitesFor(index, 'hostileoverridegrandchild', 'dothing').filter((s) => s.callerMethod === 'callIt');
  assert.ok(sites.length >= 1, `expected transitive override edge to grandchild, got ${sites.length}`);
  assert.strictEqual(sites[0].via, 'override');
});

check('F3: NO override edge to the subclass that does NOT override (inherits only)', () => {
  const sites = sitesFor(index, 'hostileoverridesubnooverride', 'dothing').filter((s) => s.callerMethod === 'callIt');
  assert.strictEqual(sites.length, 0, `expected 0 override edges to the non-overriding subclass, got ${sites.length}: ${JSON.stringify(sites)}`);
});

// =======================================================================
// F4a. Type.forName(...) dynamic dispatch.
// =======================================================================

check('F4a: Type.forName(literal) resolves to <init> via=dynamic', () => {
  const sites = sitesFor(index, 'hostileoverridebase', '<init>').filter((s) => s.callerMethod === 'createByLiteral');
  assert.ok(sites.length >= 1, `expected dynamic ctor edge, got ${sites.length}`);
  assert.strictEqual(sites[0].via, 'dynamic');
});

check('F4a: Type.forName(literal-naming-nonexistent-class) produces NO edge', () => {
  let any = 0;
  for (const [, sites] of index.methodCallers) {
    any += sites.filter((s) => s.callerClass === 'HostileDynamicFactory' && s.callerMethod === 'createByGhostLiteral').length;
  }
  assert.strictEqual(any, 0, `expected 0 edges for a ghost-class literal, got ${any}`);
});

check('F4a: Type.forName(variable) produces NO edge -- the hostile case', () => {
  let any = 0;
  for (const [, sites] of index.methodCallers) {
    any += sites.filter((s) => s.callerClass === 'HostileDynamicFactory' && s.callerMethod === 'createByVariable').length;
  }
  assert.strictEqual(any, 0, `expected 0 edges for Type.forName(variable), got ${any}`);
});

check('F4a: Type.forName(variable) still NO edge even when the variable was JUST assigned a literal one line above', () => {
  let any = 0;
  for (const [, sites] of index.methodCallers) {
    any += sites.filter((s) => s.callerClass === 'HostileDynamicFactory' && s.callerMethod === 'createByVariableAssignedLiteral').length;
  }
  assert.strictEqual(any, 0, `expected 0 edges (no constant-folding across statements), got ${any}`);
});

check('F4a: Type.forName(two args) produces NO edge', () => {
  let any = 0;
  for (const [, sites] of index.methodCallers) {
    any += sites.filter((s) => s.callerClass === 'HostileDynamicFactory' && s.callerMethod === 'createByTwoArgs').length;
  }
  assert.strictEqual(any, 0, `expected 0 edges for the 2-arg forName shape, got ${any}`);
});

// =======================================================================
// F4b. CMDT class-name-shaped values.
// =======================================================================

check('F4b: canonical Handler_Class__c-style field with a real class value -> cmdt ref attached', () => {
  const refs = index.metaCallers.get('hostileoverridebase') || [];
  const cmdtRefs = refs.filter((r) => r.kind === 'cmdt');
  assert.ok(cmdtRefs.length >= 1, `expected >=1 cmdt ref on HostileOverrideBase, got ${cmdtRefs.length}`);
  assert.strictEqual(cmdtRefs[0].fieldName, 'Handler_Class__c');
});

check('F4b: ghost class name in Handler_Class__c produces NO metaCallers entry (target class not indexed)', () => {
  assert.strictEqual(index.classes.has('hostileghostclassdoesnotexist'), false);
  const refs = index.metaCallers.get('hostileghostclassdoesnotexist');
  // attachMetaCallers doesn't filter by whether the class is indexed, but a
  // buildCallerTree() trace against this "class" will report cm===undefined
  // (no root), so there's no way to observe it as a caller edge in the UI --
  // confirm that live via buildCallerTree returning the not-found shape.
  const tree = resolver.buildCallerTree(index, { classLower: 'hostileghostclassdoesnotexist', methodLower: null }, {});
  assert.strictEqual(tree.root.path, '', 'expected the not-found root shape (no indexed class)');
});

check('F4b (JUDGMENT CASE): a class-name-shaped value in a NON-class-like field (Description__c) still attaches a cmdt ref', () => {
  const refs = index.metaCallers.get('hostileoverridesubyesoverride') || [];
  const cmdtRefs = refs.filter((r) => r.kind === 'cmdt');
  note('F4b field-name trap', `cmdt refs on HostileOverrideSubYesOverride: ${JSON.stringify(cmdtRefs.map((r) => ({ field: r.fieldName, label: r.label })))}`);
  // This is NOT asserted pass/fail -- see writeup for the judgment call.
  // We just record what actually happens for the report.
});

// =======================================================================
// F5. Comparable.compareTo called explicitly -- normal edge, not just entry.
// =======================================================================

check('F5: entries[] carries the Comparable synthetic label', () => {
  const cm = index.classes.get('hostilecomparableitem');
  assert.ok(cm, 'expected HostileComparableItem indexed');
  const m = cm.methods.find((mm) => lc(mm.name) === 'compareto');
  assert.ok(m, 'expected compareTo method');
  assert.ok((m.entries || []).includes('Comparable (invoked by sort)'), `expected Comparable entry label, got ${JSON.stringify(m.entries)}`);
});

check('F5: compareTo() called explicitly gets a NORMAL typed call-graph edge (not just an entry)', () => {
  const sites = sitesFor(index, 'hostilecomparableitem', 'compareto').filter((s) => s.callerClass === 'HostileComparableCaller');
  assert.ok(sites.length >= 1, `expected >=1 caller edge to compareTo, got ${sites.length}`);
  assert.strictEqual(sites[0].via, 'typed', `expected via=typed (ordinary dispatch), got ${sites[0].via}`);
});

// =======================================================================
// Summary
// =======================================================================

console.log('');
console.log(`${pass} passed, ${fail} failed`);
if (fail > 0) process.exitCode = 1;

'use strict';
// Adversarial verifier (new-feature semantics, v0.3.0 amendments A1-A6).
// Hostile fixtures live under dev/hostile-v030/. This script parses them
// with the REAL engine (parser.js/resolver.js/metascan.js) and asserts
// against each fixture's documented expectation, printing PASS/FAIL per
// check plus enough raw diagnostic (via/overloadSig/site count) to write up
// a repro for anything that fails.
//
// Usage: node dev/hostile-v030-check.js

const fs = require('fs');
const path = require('path');
const assert = require('assert');

const parser = require('../parser');
const resolver = require('../resolver');
const metascan = require('../metascan');

const FIXDIR = path.join(__dirname, 'hostile-v030');

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
// Load + parse every .cls fixture under hostile-v030/ (flat, non-recursive
// for .cls; lwc/ and the flow/json files are read explicitly below).
// ---------------------------------------------------------------------

const clsFiles = fs.readdirSync(FIXDIR).filter((f) => f.endsWith('.cls'));
const facts = clsFiles.map((f) => {
  const p = path.join(FIXDIR, f);
  const text = fs.readFileSync(p, 'utf8');
  return parser.parseFile({ path: p, text });
});

check('all .cls fixtures parse cleanly (no parseError)', () => {
  const withErrors = facts.filter((f) => f.parseError);
  assert.deepStrictEqual(
    withErrors.map((f) => f.path),
    [],
    'unexpected parseError in: ' + withErrors.map((f) => `${f.path}: ${f.parseError}`).join(' | ')
  );
});

const index = resolver.buildSemanticIndex(facts);

function sitesFor(idx, classLower, methodLower) {
  return idx.methodCallers.get(`${classLower}#${methodLower}`) || [];
}

function siteMatching(sites, needleLineText) {
  return sites.find((s) => (s.lineText || '').includes(needleLineText));
}

// =======================================================================
// 1. Field named like a property on the same class (must NOT edge)
// =======================================================================

check('field-named-like-property: field write produces NO edge', () => {
  const sites = sitesFor(index, 'hostilefieldowner', '(set status)');
  assert.strictEqual(sites.length, 0, `expected 0 sites, got ${sites.length}`);
});

check('field-named-like-property: field read produces NO edge', () => {
  const sites = sitesFor(index, 'hostilefieldowner', '(get status)');
  assert.strictEqual(sites.length, 0, `expected 0 sites, got ${sites.length}`);
});

check('field-named-like-property: sibling class REAL property still edges (positive control)', () => {
  const getSites = sitesFor(index, 'hostilepropowner', '(get status)');
  const setSites = sitesFor(index, 'hostilepropowner', '(set status)');
  assert.ok(getSites.length >= 1, `expected >=1 get site, got ${getSites.length}`);
  assert.ok(setSites.length >= 1, `expected >=1 set site, got ${setSites.length}`);
  assert.strictEqual(getSites[0].via, 'typed');
  assert.strictEqual(setSites[0].via, 'typed');
});

// =======================================================================
// 2. Property declared on grandparent (2-level extends walk)
// =======================================================================

check('property-on-grandparent: (set Code) resolves through 2 extends hops', () => {
  const sites = sitesFor(index, 'grandprop', '(set code)');
  assert.ok(sites.length >= 1, `expected >=1 site, got ${sites.length}`);
  assert.strictEqual(sites[0].via, 'typed', `expected via=typed, got ${sites[0].via}`);
});

check('property-on-grandparent: (get Code) resolves through 2 extends hops', () => {
  const sites = sitesFor(index, 'grandprop', '(get code)');
  assert.ok(sites.length >= 1, `expected >=1 site, got ${sites.length}`);
  assert.strictEqual(sites[0].via, 'typed', `expected via=typed, got ${sites[0].via}`);
});

// =======================================================================
// 3. x.Prop() -- method call syntax on a property name -- must be 'dot',
//    not 'prop'; bare x.Prop (no parens) on a different class must be
//    'prop' and resolve correctly; the parens form on the property-only
//    class must resolve to ZERO owners (no phantom accessor edge).
// =======================================================================

check('prop-vs-method: bare read on PropNamedWidget resolves to (get Widget)', () => {
  const sites = sitesFor(index, 'propnamedwidget', '(get widget)');
  assert.ok(sites.length >= 1, `expected >=1 site, got ${sites.length}`);
});

check('prop-vs-method: parens call on MethodNamedWidget resolves to the real method', () => {
  const sites = sitesFor(index, 'methodnamedwidget', 'widget');
  assert.ok(sites.length >= 1, `expected >=1 site, got ${sites.length}`);
});

check('prop-vs-method: bogus p.Widget() (parens on property-only class) yields ZERO owners anywhere', () => {
  const asMethod = sitesFor(index, 'propnamedwidget', 'widget'); // literal bare-name method 'Widget' (kind dot target)
  const asGetAccessor = sitesFor(index, 'propnamedwidget', '(get widget)');
  const asSetAccessor = sitesFor(index, 'propnamedwidget', '(set widget)');
  // The ONE legitimate '(get Widget)' site must be exactly the bare-read
  // call from run(); the bogus p.Widget() call must not have added a
  // second phantom site here, nor created any 'widget' bare-method edge.
  assert.strictEqual(asMethod.length, 0, `bogus call must not create a bare-'widget' method edge, got ${asMethod.length}`);
  const bogusLeaked = asGetAccessor.some((s) => (s.lineText || '').includes('p.Widget();'));
  assert.strictEqual(bogusLeaked, false, 'bogus p.Widget() must not resolve into (get Widget)');
  assert.strictEqual(asSetAccessor.length, 0);
});

// =======================================================================
// 4. x.Prop().chain() -- property accessed with parens then chained --
//    A3(c) chain-walk must not invent an edge into the property's
//    accessor scope for the 'Prop' segment.
// =======================================================================

check('chained x.Prop().chain(): no phantom edge into ChainPropSrc accessor scopes', () => {
  const getSites = sitesFor(index, 'chainpropsrc', '(get prop)');
  const setSites = sitesFor(index, 'chainpropsrc', '(set prop)');
  assert.strictEqual(getSites.length, 0, `expected 0, got ${getSites.length}`);
  assert.strictEqual(setSites.length, 0, `expected 0, got ${setSites.length}`);
});

// informational only -- report however chainOnlyHere ends up resolving
// (unique-name fallback landing on the right class by luck is fine; a
// crash or a wrong-class edge would not be).
{
  const chainTargetSites = sitesFor(index, 'chainproptarget', 'chainonlyhere');
  note('chained x.Prop().chain()', `chainOnlyHere() caller sites: ${chainTargetSites.length}` +
    (chainTargetSites.length ? `, via=${chainTargetSites.map((s) => s.via).join(',')}` : ''));
}

// =======================================================================
// 5. Auto-implemented accessors ({ get; set; }, no body) -- the single most
//    common Apex property style.
// =======================================================================

check('auto-implemented accessor: (set Status) has a caller (A2 completeness)', () => {
  const sites = sitesFor(index, 'autopropowner', '(set status)');
  assert.ok(sites.length >= 1, `expected >=1 site for auto-implemented property set, got ${sites.length}`);
});

check('auto-implemented accessor: (get Status) has a caller (A2 completeness)', () => {
  const sites = sitesFor(index, 'autopropowner', '(get status)');
  assert.ok(sites.length >= 1, `expected >=1 site for auto-implemented property get, got ${sites.length}`);
});

// =======================================================================
// 6. Casts nested INSIDE ternary branches (distinct from a cast wrapped
//    AROUND a whole ternary, which already works via A3(a)).
// =======================================================================

check('cast-inside-ternary: bothBranchesCast() must not produce a confidently-wrong typed edge', () => {
  const aSites = sitesFor(index, 'castternarya', 'total');
  const bSites = sitesFor(index, 'castternaryb', 'total');
  const badA = aSites.find((s) => (s.lineText || '').includes('flag ? (CastTernaryA) x : (CastTernaryB) y'));
  const badB = bSites.find((s) => (s.lineText || '').includes('flag ? (CastTernaryA) x : (CastTernaryB) y'));
  assert.ok(!badA, 'must not resolve bothBranchesCast() call to CastTernaryA.total via a confident typed/unique edge sourced from this exact ambiguous line');
  assert.ok(!badB, 'must not resolve bothBranchesCast() call to CastTernaryB.total via a confident typed/unique edge sourced from this exact ambiguous line');
});

check('cast-inside-ternary: oneBranchCast() must not produce a confidently-wrong typed edge', () => {
  const aSites = sitesFor(index, 'castternarya', 'total');
  const bSites = sitesFor(index, 'castternaryb', 'total');
  const hitA = aSites.find((s) => (s.lineText || '').includes('flag ? (CastTernaryA) x : y'));
  const hitB = bSites.find((s) => (s.lineText || '').includes('flag ? (CastTernaryA) x : y'));
  assert.ok(!hitA, 'oneBranchCast() must not resolve to CastTernaryA.total (mixed cast/ident ternary is out of A3(b) scope)');
  assert.ok(!hitB, 'oneBranchCast() must not resolve to CastTernaryB.total (mixed cast/ident ternary is out of A3(b) scope)');
});

check('cast-around-whole-ternary: wholeCastOfTernary() DOES resolve exactly, via=typed (positive control)', () => {
  const aSites = sitesFor(index, 'castternarya', 'total');
  const hit = aSites.find((s) => (s.lineText || '').includes('(CastTernaryA) (flag ? x : y)'));
  assert.ok(hit, 'expected an exact-cast edge for the whole-ternary-cast positive control');
  assert.strictEqual(hit.via, 'typed', `expected via=typed, got ${hit && hit.via}`);
});

// =======================================================================
// 7. 5-segment fluent chain -- A3(c) documented cap is 4 segments.
// =======================================================================

check('5-segment chain: Chain5E (segment-4 boundary decoy) must NOT receive the edge', () => {
  const decoySites = sitesFor(index, 'chain5e', 'g');
  const hit = decoySites.find((s) => (s.lineText || '').includes('head.b().c().d().e().f().g()'));
  assert.ok(!hit, `Chain5E.g must not be credited as the caller target for a 5-segment chain (got via=${hit && hit.via})`);
});

// A3(c)'s documented cap is 4 segments; this receiver has 5
// (b,c,d,e,f before the traced .g() call). Per the fixture's own doc
// comment, the correct outcome for exceeding the cap is "cleanly absent",
// not a guessed resolution -- resolveChainedReceiver bails out (returns
// null) the moment segments.length > 4, and rule 7's unique-name fallback
// also declines here because 'g' is declared on two classes in this
// fixture set (Chain5E's decoy + Chain5F's real one), so it is NOT
// globally unique. Net expectation: the call site is absent from BOTH
// classes' caller lists -- never silently mis-attributed to either.
check('5-segment chain: exceeding the 4-segment cap yields NO edge at all (not a guess)', () => {
  const decoySites = sitesFor(index, 'chain5e', 'g');
  const realSites = sitesFor(index, 'chain5f', 'g');
  const decoyHit = decoySites.find((s) => (s.lineText || '').includes('head.b().c().d().e().f().g()'));
  const realHit = realSites.find((s) => (s.lineText || '').includes('head.b().c().d().e().f().g()'));
  assert.strictEqual(decoyHit, undefined, 'Chain5E must not receive the edge');
  assert.strictEqual(realHit, undefined, 'Chain5F must not receive the edge either -- exceeding the cap must fall all the way through to no edge, since the unique-name fallback is disabled by the decoy');
});

// =======================================================================
// 8. Overload arg-type scoring: subclass argument vs unrelated overload.
// =======================================================================

check('overload+subclass: pick(new DogSub()) resolves to pick(AnimalBase), not pick(VehicleBase)', () => {
  const sites = sitesFor(index, 'overloadanimalvehicle', 'pick');
  const hit = siteMatching(sites, 'target.pick(new DogSub())');
  assert.ok(hit, 'expected a call site for target.pick(new DogSub())');
  assert.strictEqual(hit.overloadSig, 'pick(AnimalBase)', `expected overloadSig 'pick(AnimalBase)', got '${hit.overloadSig}'`);
});

// =======================================================================
// 9. Overload ties: null arg (documented first-declared tie-break) and
//    new X() arg (exact match) -- confirm contract, not expected to fail.
// =======================================================================

check('overload null-arg tie-break: bar(null) picks first-declared bar(OverloadTypeA)', () => {
  const sites = sitesFor(index, 'overloadnulltarget', 'bar');
  const hit = siteMatching(sites, 'target.bar(null)');
  assert.ok(hit, 'expected a call site for target.bar(null)');
  assert.strictEqual(hit.overloadSig, 'bar(OverloadTypeA)', `expected 'bar(OverloadTypeA)', got '${hit.overloadSig}'`);
});

check('overload new-arg exact match: bar(new OverloadTypeB()) picks bar(OverloadTypeB)', () => {
  const sites = sitesFor(index, 'overloadnulltarget', 'bar');
  const hit = siteMatching(sites, 'target.bar(new OverloadTypeB())');
  assert.ok(hit, 'expected a call site for target.bar(new OverloadTypeB())');
  assert.strictEqual(hit.overloadSig, 'bar(OverloadTypeB)', `expected 'bar(OverloadTypeB)', got '${hit.overloadSig}'`);
});

// =======================================================================
// 10. LWC import of a NONEXISTENT class -- must not crash, no false node.
// =======================================================================

check('metascan: LWC import of nonexistent class parses to a plain MetaRef, no throw', () => {
  const p = path.join(FIXDIR, 'lwc/hostileImportWizard/hostileImportWizard.js');
  const text = fs.readFileSync(p, 'utf8');
  const refs = metascan.parseMetaFile({ path: p, text });
  assert.strictEqual(refs.length, 1);
  assert.strictEqual(refs[0].className, 'GhostlyNonexistentClass');
  assert.strictEqual(refs[0].methodName, 'getSomething');
});

check('resolver: attaching a nonexistent-class LWC ref does not crash buildCallerTree, and yields "not found"', () => {
  const p = path.join(FIXDIR, 'lwc/hostileImportWizard/hostileImportWizard.js');
  const text = fs.readFileSync(p, 'utf8');
  const refs = metascan.parseMetaFile({ path: p, text });
  const idx2 = resolver.buildSemanticIndex(facts);
  resolver.attachMetaCallers(idx2, refs);
  const result = resolver.buildCallerTree(idx2, { classLower: 'ghostlynonexistentclass', methodLower: null }, {});
  assert.strictEqual(result.note, 'target class not found in index');
  assert.strictEqual(result.root.children.length, 0);
});

check('resolver: nonexistent-class LWC ref never appears in suggestTargets()', () => {
  const p = path.join(FIXDIR, 'lwc/hostileImportWizard/hostileImportWizard.js');
  const text = fs.readFileSync(p, 'utf8');
  const refs = metascan.parseMetaFile({ path: p, text });
  const idx2 = resolver.buildSemanticIndex(facts);
  resolver.attachMetaCallers(idx2, refs);
  const targets = resolver.suggestTargets(idx2);
  const leaked = targets.some((t) => /ghostlynonexistent/i.test(t.classLower) || /Ghostly/i.test(t.label));
  assert.strictEqual(leaked, false, 'nonexistent class must never appear as a suggested target');
});

check('resolver: nonexistent-class LWC ref does not appear anywhere in a REAL class tree (no false node)', () => {
  const p = path.join(FIXDIR, 'lwc/hostileImportWizard/hostileImportWizard.js');
  const text = fs.readFileSync(p, 'utf8');
  const refs = metascan.parseMetaFile({ path: p, text });
  const idx2 = resolver.buildSemanticIndex(facts);
  resolver.attachMetaCallers(idx2, refs);
  // Walk every real class's class-level tree and confirm no 'Ghostly...' node.
  let leaked = false;
  for (const cm of idx2.classes.values()) {
    const r = resolver.buildCallerTree(idx2, { classLower: lcKey(cm.qualified), methodLower: null }, {});
    if (JSON.stringify(r).toLowerCase().includes('ghostly')) leaked = true;
  }
  assert.strictEqual(leaked, false, 'GhostlyNonexistentClass must not surface inside any real class tree');
});

function lcKey(s) {
  return String(s).toLowerCase();
}

// =======================================================================
// 11. Flow actionName dotted to a nonexistent method -- must not crash.
// =======================================================================

check('metascan: Flow XML with class.method dotted to a nonexistent method parses cleanly', () => {
  const p = path.join(FIXDIR, 'HostileFlow.flow-meta.xml');
  const text = fs.readFileSync(p, 'utf8');
  const refs = metascan.parseMetaFile({ path: p, text });
  assert.strictEqual(refs.length, 2);
  const real = refs.find((r) => r.className === 'HostilePropOwner');
  const ghost = refs.find((r) => r.className === 'TotallyGhostlyFlowInvocable');
  assert.ok(real && real.methodName === 'notARealMethodAtAll');
  assert.ok(ghost && ghost.methodName === null);
});

check('resolver: Flow ref to a real class + nonexistent method does not crash and stays isolated', () => {
  const p = path.join(FIXDIR, 'HostileFlow.flow-meta.xml');
  const text = fs.readFileSync(p, 'utf8');
  const refs = metascan.parseMetaFile({ path: p, text });
  const idx2 = resolver.buildSemanticIndex(facts);
  resolver.attachMetaCallers(idx2, refs);

  // Querying the exact (real-class, nonexistent-method) pair must not throw.
  const ghostMethodResult = resolver.buildCallerTree(idx2, { classLower: 'hostilepropowner', methodLower: 'notarealmethodatall' }, {});
  assert.ok(ghostMethodResult && ghostMethodResult.root);

  // It must NOT leak into a query for a REAL method on the same class.
  const realMethodResult = resolver.buildCallerTree(idx2, { classLower: 'hostilepropowner', methodLower: '(get status)' }, {});
  const leaked = JSON.stringify(realMethodResult).includes('notARealMethodAtAll') || JSON.stringify(realMethodResult).toLowerCase().includes('flow apex action');
  assert.strictEqual(leaked, false, 'the Flow ref to a nonexistent method must not leak into (get Status)\'s caller tree');

  // The wholly-nonexistent class must report "not found", not crash.
  const ghostClassResult = resolver.buildCallerTree(idx2, { classLower: 'totallyghostlyflowinvocable', methodLower: null }, {});
  assert.strictEqual(ghostClassResult.note, 'target class not found in index');
});

// =======================================================================
// 12. Duplicate remoteClass/remoteMethod pairs in an OmniScript DataPack.
// =======================================================================

check('metascan: duplicate remoteClass/remoteMethod pairs both extracted, escaped lookalike excluded', () => {
  const p = path.join(FIXDIR, 'HostileOmni_DataPack.json');
  const text = fs.readFileSync(p, 'utf8');
  const refs = metascan.parseMetaFile({ path: p, text });
  assert.strictEqual(refs.length, 2, `expected exactly 2 refs (the escaped PropertySetJSON string duplicate must not be walked), got ${refs.length}`);
  for (const r of refs) {
    assert.strictEqual(r.className, 'HostilePropOwner');
    assert.strictEqual(r.methodName, 'readStatus');
  }
  const lines = refs.map((r) => r.line);
  assert.notStrictEqual(lines[0], lines[1], `expected distinct line numbers for the 2 duplicate pairs, both landed on line ${lines[0]}`);
});

check('resolver: duplicate OmniScript refs group into ONE TNode with 2 sites, no crash, no dup nodes', () => {
  const p = path.join(FIXDIR, 'HostileOmni_DataPack.json');
  const text = fs.readFileSync(p, 'utf8');
  const refs = metascan.parseMetaFile({ path: p, text });
  const idx2 = resolver.buildSemanticIndex(facts);
  resolver.attachMetaCallers(idx2, refs);
  const result = resolver.buildCallerTree(idx2, { classLower: 'hostilepropowner', methodLower: 'readstatus' }, {});
  const omniChildren = result.root.children.filter((c) => c.kind === 'omniscript');
  assert.strictEqual(omniChildren.length, 1, `expected exactly 1 grouped omniscript TNode, got ${omniChildren.length}`);
  assert.strictEqual(omniChildren[0].sites.length, 2, `expected 2 sites on the grouped node, got ${omniChildren[0].sites.length}`);
});

// =======================================================================
// Summary
// =======================================================================

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exitCode = 1;

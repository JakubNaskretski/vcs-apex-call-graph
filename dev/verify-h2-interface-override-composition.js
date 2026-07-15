#!/usr/bin/env node
'use strict';
// Adversarial-verifier repro for H2 (interface x override composition).
// (a) exact audit repro from the goal spec
// (b) a 3-level override variant (Impl -> SubImpl -> SubSubImpl)
// (c) diamond interfaces (I1, I2 both extend I0; Impl implements I1, I2)
//
// Files under dev/ only -- does not touch resolver.js/parser.js.

const path = require('path');
const parser = require(path.join(__dirname, '..', 'parser.js'));
const resolver = require(path.join(__dirname, '..', 'resolver.js'));

function build(files) {
  const facts = files.map(({ name, text }) => parser.parseFile({ path: `${name}.cls`, text }));
  const index = resolver.buildSemanticIndex(facts);
  return { facts, index };
}

function trace(index, classLower, methodLower) {
  return resolver.buildCallerTree(index, { classLower, methodLower }, {});
}

function collectVia(node, out) {
  if (!out) out = [];
  if (node.via) out.push({ label: node.label, via: node.via, approximate: node.approximate });
  for (const c of node.children || []) collectVia(c, out);
  return out;
}

let failures = 0;
function assert(cond, msg) {
  if (!cond) { failures++; console.error('FAIL: ' + msg); } else { console.log('PASS: ' + msg); }
}

// ---------------------------------------------------------------------------
// (a) exact repro from goal spec
// ---------------------------------------------------------------------------
{
  const files = [
    { name: 'I', text: `public interface I { void m(); }` },
    { name: 'Impl', text: `public virtual class Impl implements I { public virtual void m(){} }` },
    { name: 'SubImpl', text: `public class SubImpl extends Impl { public override void m(){} }` },
    { name: 'Disp', text: `public class Disp { void fan(I i){ i.m(); } }` },
  ];
  const { index } = build(files);
  const tree = trace(index, 'subimpl', 'm');
  console.log('--- (a) exact repro: SubImpl.m callers ---');
  console.log(JSON.stringify({ note: tree.note, rootChildren: (tree.root.children || []).map(c => ({ label: c.label, via: c.via, approximate: c.approximate })) }, null, 2));

  const hasDispFan = (tree.root.children || []).some(c => /disp/i.test(c.label) && /fan/i.test(c.label));
  assert(hasDispFan, '(a) SubImpl.m callers include Disp.fan');
  const dispNode = (tree.root.children || []).find(c => /disp/i.test(c.label) && /fan/i.test(c.label));
  assert(dispNode && dispNode.via === 'interface', '(a) Disp.fan edge labeled via=interface');
  assert(dispNode && dispNode.approximate === true, '(a) Disp.fan edge is approximate');
}

// ---------------------------------------------------------------------------
// (b) 3-level variant: Impl -> SubImpl (override) -> SubSubImpl (override again)
//     tracing SubSubImpl.m must ALSO show Disp.fan via interface, AND tracing
//     SubImpl.m must still show Disp.fan (fan-down must not stop at one level).
// ---------------------------------------------------------------------------
{
  const files = [
    { name: 'I', text: `public interface I { void m(); }` },
    { name: 'Impl', text: `public virtual class Impl implements I { public virtual void m(){} }` },
    { name: 'SubImpl', text: `public virtual class SubImpl extends Impl { public override void m(){} }` },
    { name: 'SubSubImpl', text: `public class SubSubImpl extends SubImpl { public override void m(){} }` },
    { name: 'Disp', text: `public class Disp { void fan(I i){ i.m(); } }` },
  ];
  const { index } = build(files);

  const treeSub = trace(index, 'subimpl', 'm');
  const treeSubSub = trace(index, 'subsubimpl', 'm');
  console.log('--- (b) 3-level: SubImpl.m callers ---');
  console.log(JSON.stringify((treeSub.root.children || []).map(c => ({ label: c.label, via: c.via })), null, 2));
  console.log('--- (b) 3-level: SubSubImpl.m callers ---');
  console.log(JSON.stringify((treeSubSub.root.children || []).map(c => ({ label: c.label, via: c.via })), null, 2));

  assert((treeSub.root.children || []).some(c => /disp/i.test(c.label) && c.via === 'interface'), '(b) SubImpl.m (mid-level override) still shows Disp.fan via interface');
  assert((treeSubSub.root.children || []).some(c => /disp/i.test(c.label) && c.via === 'interface'), '(b) SubSubImpl.m (leaf, 2 levels down) shows Disp.fan via interface');
}

// ---------------------------------------------------------------------------
// (c) diamond interfaces: I0 <- I1, I0 <- I2 (both extend I0); Impl implements
//     I1 AND I2; SubImpl extends Impl overrides m(). Dispatch through EITHER
//     I1-typed or I2-typed parameter must reach SubImpl.m's override fan-down,
//     with no duplicate edges from the diamond.
// ---------------------------------------------------------------------------
{
  const files = [
    { name: 'I0', text: `public interface I0 { void m(); }` },
    { name: 'I1', text: `public interface I1 extends I0 { }` },
    { name: 'I2', text: `public interface I2 extends I0 { }` },
    { name: 'Impl', text: `public virtual class Impl implements I1, I2 { public virtual void m(){} }` },
    { name: 'SubImpl', text: `public class SubImpl extends Impl { public override void m(){} }` },
    { name: 'DispV1', text: `public class DispV1 { void fan(I1 i){ i.m(); } }` },
    { name: 'DispV2', text: `public class DispV2 { void fan(I2 i){ i.m(); } }` },
    { name: 'DispV0', text: `public class DispV0 { void fan(I0 i){ i.m(); } }` },
  ];
  const { index } = build(files);
  const tree = trace(index, 'subimpl', 'm');
  const labels = (tree.root.children || []).map(c => c.label);
  console.log('--- (c) diamond interfaces: SubImpl.m callers ---');
  console.log(JSON.stringify((tree.root.children || []).map(c => ({ label: c.label, via: c.via })), null, 2));

  const hasV1 = labels.some(l => /dispv1/i.test(l) && /fan/i.test(l));
  const hasV2 = labels.some(l => /dispv2/i.test(l) && /fan/i.test(l));
  const hasV0 = labels.some(l => /dispv0/i.test(l) && /fan/i.test(l));
  assert(hasV1, '(c) diamond: DispV1.fan (via I1) reaches SubImpl.m');
  assert(hasV2, '(c) diamond: DispV2.fan (via I2) reaches SubImpl.m');
  assert(hasV0, '(c) diamond: DispV0.fan (via I0, transitive ancestor) reaches SubImpl.m');

  // no duplicate edges: each Disp*.fan should appear exactly once in root.children
  const counts = {};
  for (const l of labels) counts[l] = (counts[l] || 0) + 1;
  const dupes = Object.entries(counts).filter(([, n]) => n > 1);
  assert(dupes.length === 0, '(c) diamond: no duplicate caller edges (dupes=' + JSON.stringify(dupes) + ')');
}

console.log('\n=== H2 verify summary ===');
console.log(failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);

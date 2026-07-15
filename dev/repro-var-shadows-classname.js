'use strict';
// Repro: resolveDotOther() checks rule 5 (receiver text matches a known
// user CLASS name -> static dispatch) BEFORE rule 6 (receiver is a simple
// identifier -> TYPE ENV lookup of local/param/field). Per standard
// Java/Apex shadowing semantics, a local variable (or param/field) whose
// name happens to collide with an existing class's simple name shadows
// that class name for identifier resolution within its scope -- so
// `x.method()` must resolve against the LOCAL VARIABLE's declared type,
// not the class of the same name, whenever such a local exists.
//
// resolver.js's rule-5-before-rule-6 ordering gets this backwards: it
// treats ANY receiver text that happens to match a known class name as a
// static call, even when a local variable of that same name is in scope
// and shadows it -- producing a false edge to the (irrelevant) class's
// static-looking neighbor and completely missing the real instance-method
// callee.
//
// Fixture: class FooTarget { static void bar() } ; class OtherType
// { void bar() (instance) } ; ShadowCaller.run() declares
// `OtherType FooTarget = new OtherType(); FooTarget.bar();` -- real Apex
// must call OtherType.bar() (the local variable's declared type), never
// FooTarget.bar().
//
// Usage: node dev/repro-var-shadows-classname.js

const fs = require('fs');
const path = require('path');
const parserMod = require('../parser');
const resolver = require('../resolver');

const files = ['FooTarget.cls', 'OtherType.cls', 'ShadowCaller.cls'].map((f) => {
  const p = path.join(__dirname, f);
  return parserMod.parseFile({ path: p, text: fs.readFileSync(p, 'utf8') });
});

for (const f of files) {
  if (f.parseError) console.log('PARSE ERROR in', f.path, ':', f.parseError);
}

const index = resolver.buildSemanticIndex(files);

const fooTargetSites = index.methodCallers.get('footarget#bar') || [];
const otherTypeSites = index.methodCallers.get('othertype#bar') || [];

console.log('footarget#bar (WRONG target if populated):', JSON.stringify(fooTargetSites.map((s) => ({ caller: s.callerClass + '.' + s.callerMethod, via: s.via }))));
console.log('othertype#bar (CORRECT target):', JSON.stringify(otherTypeSites.map((s) => ({ caller: s.callerClass + '.' + s.callerMethod, via: s.via }))));

if (fooTargetSites.length > 0) {
  console.log('\nCONFIRMED BUG: call site attached to FooTarget.bar (via ' + fooTargetSites[0].via + ') even though a local variable named FooTarget (typed OtherType) shadows the class in this scope; real Apex resolves this call to OtherType.bar() (instance dispatch), not the static class method.');
  process.exitCode = 1;
} else if (otherTypeSites.length > 0) {
  console.log('\nNo bug: correctly resolved to OtherType.bar via the shadowing local variable.');
} else {
  console.log('\nUNEXPECTED: no edge recorded anywhere.');
}

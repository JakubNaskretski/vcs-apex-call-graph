'use strict';
// Repro: rule 6 (typed instance dispatch) spec says overload resolution
// should "prefer matching arity" across the receiver's class or its
// extends chain. resolver.js's findMethodOwner() instead stops climbing
// the chain as soon as it finds ANY method with a matching NAME in a given
// class, regardless of arity -- so when a subclass declares an overload
// with a *different* arity than the call site, and the arity-matching
// overload actually lives in an ancestor class, the edge gets attached to
// the WRONG class (the subclass) instead of the real target (the ancestor).
//
// Fixture: Base.log(String) ; Mid extends Base, Mid.log(String,Integer)
// (different arity, NOT an override). OverloadCaller.run() does
// `m.log('hi')` on a `Mid`-typed local with ONE arg -- real Apex resolves
// this to the inherited Base.log(String). resolver.js should therefore
// register this call site under `base#log`, not `mid#log`.
//
// Usage: node dev/repro-overload-arity.js

const fs = require('fs');
const path = require('path');
const parserMod = require('../parser');
const resolver = require('../resolver');

const files = ['Base.cls', 'Mid.cls', 'OverloadCaller.cls'].map((f) => {
  const p = path.join(__dirname, f);
  return parserMod.parseFile({ path: p, text: fs.readFileSync(p, 'utf8') });
});

for (const f of files) {
  if (f.parseError) {
    console.log('PARSE ERROR in', f.path, ':', f.parseError);
  }
}

const index = resolver.buildSemanticIndex(files);

const baseSites = index.methodCallers.get('base#log') || [];
const midSites = index.methodCallers.get('mid#log') || [];

console.log('base#log call sites:', JSON.stringify(baseSites.map((s) => ({ callerClass: s.callerClass, callerMethod: s.callerMethod, args: s.args, via: s.via, targetMethod: s.targetMethod })), null, 2));
console.log('mid#log call sites:', JSON.stringify(midSites.map((s) => ({ callerClass: s.callerClass, callerMethod: s.callerMethod, args: s.args, via: s.via, targetMethod: s.targetMethod })), null, 2));

const tree = resolver.buildCallerTree(index, { classLower: 'mid', methodLower: 'log' }, { maxDepth: 8 });
console.log('\nTree for Mid.log:');
console.log(JSON.stringify(tree.root.children.map((c) => ({ label: c.label, via: c.via, sites: c.sites })), null, 2));

const treeBase = resolver.buildCallerTree(index, { classLower: 'base', methodLower: 'log' }, { maxDepth: 8 });
console.log('\nTree for Base.log:');
console.log(JSON.stringify(treeBase.root.children.map((c) => ({ label: c.label, via: c.via, sites: c.sites })), null, 2));

if (midSites.length > 0 && baseSites.length === 0) {
  console.log('\nCONFIRMED BUG: call site attached to Mid.log (wrong owner) instead of inherited Base.log (correct owner).');
  process.exitCode = 1;
} else if (baseSites.length > 0) {
  console.log('\nNo bug: correctly attached to Base.log.');
} else {
  console.log('\nUNEXPECTED: no edge recorded anywhere.');
}

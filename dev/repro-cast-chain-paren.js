'use strict';
// Repro: resolver.js's castOrNewChainType() cast heuristic uses the regex
// /^\(\s*([A-Za-z_][\w.]*)\s*\)/ against the receiver's raw source text,
// expecting it to start directly with `(Type)`. But the only legal Apex
// syntax for invoking a method on a cast result requires an EXTRA outer
// paren layer -- `((Type) expr).method()` -- so the receiver text is
// actually `((Type) expr)`, which starts with `((`, not `(Type`. The
// regex never matches this (only a single stray `(Foo) x` prefix, which
// isn't valid syntax for a subsequent `.method()` chain in the first
// place), so the cast-chain heuristic is effectively dead code for the
// only syntax that could ever trigger it in real Apex.
//
// Consequence: a cast-then-call site silently falls through past the
// (never-firing) cast heuristic straight to the denylist check and then
// the unique-name fallback. When the called method's simple name is NOT
// globally unique across the indexed codebase (a very common situation --
// e.g. `ping()`/`process()`/`execute()` declared on more than one class),
// the unique-name fallback also fails (owners.size !== 1), and NO EDGE IS
// WRITTEN AT ALL -- a real, syntactically-unambiguous call site (the cast
// explicitly names the type!) is completely missed.
//
// Fixture: CastTargetA.ping() and CastTargetB.ping() (same method name,
// two different classes -> non-unique). CastChainCaller does
// `((CastTargetA) getSomething()).ping();` -- the cast makes the target
// 100% unambiguous to a human/compiler, but the resolver drops it.
//
// Usage: node dev/repro-cast-chain-paren.js

const fs = require('fs');
const path = require('path');
const parserMod = require('../parser');
const resolver = require('../resolver');

const files = ['CastTargetA.cls', 'CastTargetB.cls', 'CastChainCaller.cls'].map((f) => {
  const p = path.join(__dirname, f);
  return parserMod.parseFile({ path: p, text: fs.readFileSync(p, 'utf8') });
});
for (const f of files) if (f.parseError) console.log('PARSE ERROR', f.path, f.parseError);

const index = resolver.buildSemanticIndex(files);
const aSites = index.methodCallers.get('casttargeta#ping') || [];
const bSites = index.methodCallers.get('casttargetb#ping') || [];

console.log('casttargeta#ping:', JSON.stringify(aSites.map((s) => ({ caller: s.callerClass + '.' + s.callerMethod, via: s.via }))));
console.log('casttargetb#ping:', JSON.stringify(bSites.map((s) => ({ caller: s.callerClass + '.' + s.callerMethod, via: s.via }))));

if (aSites.length === 0 && bSites.length === 0) {
  console.log('\nCONFIRMED BUG: the explicitly-cast call site `((CastTargetA) getSomething()).ping()` produced NO EDGE AT ALL -- a syntactically-unambiguous caller is completely missed because the cast-chain regex heuristic never matches real double-paren cast-call syntax, and the method name is not unique so the fallback also fails.');
  process.exitCode = 1;
} else if (aSites.length === 1 && aSites[0].via === 'typed') {
  console.log('\nNo bug: cast-chain resolved deterministically via typed dispatch.');
} else {
  console.log('\nPARTIAL: some edge exists but not the expected deterministic typed one. aSites=' + JSON.stringify(aSites) + ' bSites=' + JSON.stringify(bSites));
  process.exitCode = 1;
}

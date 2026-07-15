'use strict';
// Sanity check (NOT expected to be a bug -- verifying decision #6 in
// resolver.js's header actually holds): two unrelated outer classes each
// declare their own inner class named `Inner` with a `greet()` method.
// From within OuterA.run(), `new Inner()` / `Inner i` must resolve to
// OuterA.Inner (not OuterB.Inner, and not fail as globally ambiguous)
// because the enclosing-scope-chain check happens before the global
// once-only bare-simple-name table.
//
// Usage: node dev/repro-inner-class-ambiguity.js

const fs = require('fs');
const path = require('path');
const parserMod = require('../parser');
const resolver = require('../resolver');

const files = ['OuterA.cls', 'OuterB.cls'].map((f) => {
  const p = path.join(__dirname, f);
  return parserMod.parseFile({ path: p, text: fs.readFileSync(p, 'utf8') });
});

for (const f of files) {
  if (f.parseError) console.log('PARSE ERROR in', f.path, ':', f.parseError);
}

const index = resolver.buildSemanticIndex(files);

const aInitSites = index.methodCallers.get('outera.inner#<init>') || [];
const bInitSites = index.methodCallers.get('outerb.inner#<init>') || [];
const aGreetSites = index.methodCallers.get('outera.inner#greet') || [];
const bGreetSites = index.methodCallers.get('outerb.inner#greet') || [];

console.log('outera.inner#<init> callers:', JSON.stringify(aInitSites.map((s) => s.callerClass + '.' + s.callerMethod)));
console.log('outerb.inner#<init> callers:', JSON.stringify(bInitSites.map((s) => s.callerClass + '.' + s.callerMethod)));
console.log('outera.inner#greet callers:', JSON.stringify(aGreetSites.map((s) => s.callerClass + '.' + s.callerMethod)));
console.log('outerb.inner#greet callers:', JSON.stringify(bGreetSites.map((s) => s.callerClass + '.' + s.callerMethod)));

const aOk = aInitSites.some((s) => s.callerClass === 'OuterA') && aGreetSites.some((s) => s.callerClass === 'OuterA')
  && !bInitSites.some((s) => s.callerClass === 'OuterA') && !bGreetSites.some((s) => s.callerClass === 'OuterA');
const bOk = bInitSites.some((s) => s.callerClass === 'OuterB') && bGreetSites.some((s) => s.callerClass === 'OuterB')
  && !aInitSites.some((s) => s.callerClass === 'OuterB') && !aGreetSites.some((s) => s.callerClass === 'OuterB');

if (aOk && bOk) {
  console.log('\nNo bug: same-named inner classes correctly resolved to their own enclosing outer class.');
} else {
  console.log('\nCONFIRMED BUG: inner-class self-reference cross-contaminated between OuterA.Inner and OuterB.Inner.');
  process.exitCode = 1;
}

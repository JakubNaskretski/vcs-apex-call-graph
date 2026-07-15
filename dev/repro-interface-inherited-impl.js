'use strict';
// Repro: rule 6's interface-dispatch fan-out is supposed to edge to "every
// implementer's same-name method". resolver.js's implementer lookup uses
// findMethodOwner(implLower, nameLower, /*walkSuper=*/false) -- i.e. it
// only looks at methods the implementer declares DIRECTLY, never walking
// the implementer's OWN extends chain. When a class implements an
// interface but satisfies it via an INHERITED method from a non-interface
// abstract base class (legal, common Apex pattern), the implementer's
// participation in the interface fan-out is silently dropped entirely --
// not approximated, not attached to the base class either: the call site
// just vanishes from the index.
//
// Fixture: Greeter (interface, greet()) ; BaseGreeter (abstract class,
// declares greet()) ; ConcreteGreeter extends BaseGreeter implements
// Greeter (does NOT redeclare greet()) ; GreeterCaller does
// `Greeter g = new ConcreteGreeter(); g.greet();`
//
// Usage: node dev/repro-interface-inherited-impl.js

const fs = require('fs');
const path = require('path');
const parserMod = require('../parser');
const resolver = require('../resolver');

const files = ['Greeter.cls', 'BaseGreeter.cls', 'ConcreteGreeter.cls', 'GreeterCaller.cls'].map((f) => {
  const p = path.join(__dirname, f);
  return parserMod.parseFile({ path: p, text: fs.readFileSync(p, 'utf8') });
});

for (const f of files) {
  if (f.parseError) console.log('PARSE ERROR in', f.path, ':', f.parseError);
}

const index = resolver.buildSemanticIndex(files);

const greeterSites = index.methodCallers.get('greeter#greet') || [];
const baseSites = index.methodCallers.get('basegreeter#greet') || [];
const concreteSites = index.methodCallers.get('concretegreeter#greet') || [];

console.log('greeter#greet:', JSON.stringify(greeterSites.map((s) => s.callerClass + '.' + s.callerMethod)));
console.log('basegreeter#greet:', JSON.stringify(baseSites.map((s) => s.callerClass + '.' + s.callerMethod)));
console.log('concretegreeter#greet:', JSON.stringify(concreteSites.map((s) => s.callerClass + '.' + s.callerMethod)));

const totalEdgesToRealImpl = baseSites.length + concreteSites.length;
if (totalEdgesToRealImpl === 0 && greeterSites.length > 0) {
  console.log('\nCONFIRMED BUG: the call site through the Greeter interface is only attached to the abstract interface method itself; the concrete implementer (ConcreteGreeter, via its inherited BaseGreeter.greet()) never receives the edge at all -- a real caller is completely missed, not just approximated.');
  process.exitCode = 1;
} else {
  console.log('\nNo bug: implementer received the edge.');
}

'use strict';
// Sanity check: chained `new Foo().bar()` and cast-chained
// `((Foo) expr()).bar()` receivers should resolve via the castOrNewChainType
// heuristic (rule 6 bonus). Usage: node dev/repro-chained-calls.js
const fs = require('fs');
const path = require('path');
const parserMod = require('../parser');
const resolver = require('../resolver');

const files = ['ChainTarget.cls', 'ChainCaller.cls'].map((f) => {
  const p = path.join(__dirname, f);
  return parserMod.parseFile({ path: p, text: fs.readFileSync(p, 'utf8') });
});
for (const f of files) if (f.parseError) console.log('PARSE ERROR', f.path, f.parseError);

const index = resolver.buildSemanticIndex(files);
const sites = index.methodCallers.get('chaintarget#process') || [];
console.log('chaintarget#process:', JSON.stringify(sites.map((s) => ({ via: s.via, lineText: s.lineText })), null, 2));
if (sites.length === 2) {
  console.log('\nNo bug: both chained-new and cast-chained calls resolved.');
} else {
  console.log('\nCONFIRMED BUG / GAP: expected 2 call sites (new-chain + cast-chain), got ' + sites.length + '.');
  process.exitCode = 1;
}

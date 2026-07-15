'use strict';
// Sanity check: safe-navigation operator (`t?.ping()`) call resolution.
// Usage: node dev/repro-safe-nav.js
const fs = require('fs');
const path = require('path');
const parserMod = require('../parser');
const resolver = require('../resolver');

const files = ['SafeNavTarget.cls', 'SafeNavCaller.cls'].map((f) => {
  const p = path.join(__dirname, f);
  return parserMod.parseFile({ path: p, text: fs.readFileSync(p, 'utf8') });
});
for (const f of files) if (f.parseError) console.log('PARSE ERROR', f.path, f.parseError);

const index = resolver.buildSemanticIndex(files);
const sites = index.methodCallers.get('safenavtarget#ping') || [];
console.log('safenavtarget#ping:', JSON.stringify(sites.map((s) => ({ caller: s.callerClass + '.' + s.callerMethod, via: s.via, lineText: s.lineText }))));
if (sites.length === 1 && sites[0].callerClass === 'SafeNavCaller') {
  console.log('\nNo bug: safe-navigation call resolved correctly.');
} else {
  console.log('\nCONFIRMED BUG: safe-navigation call not resolved correctly.');
  process.exitCode = 1;
}

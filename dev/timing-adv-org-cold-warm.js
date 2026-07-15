'use strict';
/* Verifier-only timing probe (not part of the shipped test suite).
 * Cold run = fresh `node` process, first parse+index+metascan of adv-org.
 * Warm run = second pass in the SAME process (JIT warmed, caches populated).
 * Bars: cold parse+index < 3000ms, metascan < 300ms.
 */
const fs = require('fs');
const path = require('path');
const parser = require('../parser.js');
const resolver = require('../resolver.js');
const metascan = require('../metascan.js');

const ROOT = '/Users/agent/work/code/example-data/adv-org/force-app/main/default';

function walk(dir, out) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (ent.name === '__tests__' || ent.name === 'node_modules') continue;
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) walk(p, out);
    else out.push(p);
  }
}

function classify(files) {
  const apex = files.filter(f => /\.(cls|trigger)$/.test(f));
  const meta = files.filter(f => /\.(js|cmp|app|flow-meta\.xml|os-meta\.xml|json|page|component|md-meta\.xml)$/.test(f) && !/__tests__/.test(f));
  return { apex, meta };
}

function runOnce(label, files) {
  const { apex, meta } = classify(files);
  const t0 = process.hrtime.bigint();
  const facts = apex.map(p => parser.parseFile({ path: p, text: fs.readFileSync(p, 'utf8') }));
  const t1 = process.hrtime.bigint();
  const index = resolver.buildSemanticIndex(facts);
  const t2 = process.hrtime.bigint();
  const metaRefs = [];
  for (const p of meta) {
    try {
      metaRefs.push(...metascan.parseMetaFile({ path: p, text: fs.readFileSync(p, 'utf8') }));
    } catch (e) { /* fuzz elsewhere; here just don't crash the timing run */ }
  }
  resolver.attachMetaCallers(index, metaRefs);
  const t3 = process.hrtime.bigint();

  const parseMs = Number(t1 - t0) / 1e6;
  const indexMs = Number(t2 - t1) / 1e6;
  const parseIndexMs = Number(t2 - t0) / 1e6;
  const metaMs = Number(t3 - t2) / 1e6;

  const parseErrors = facts.filter(f => f.parseError).length;
  console.log(`[${label}] apex files: ${apex.length}, meta files: ${meta.length}, metaRefs: ${metaRefs.length}, parseErrors: ${parseErrors}`);
  console.log(`[${label}] parse: ${parseMs.toFixed(2)}ms, index: ${indexMs.toFixed(2)}ms, parse+index: ${parseIndexMs.toFixed(2)}ms (bar <3000ms) -> ${parseIndexMs < 3000 ? 'PASS' : 'FAIL'}`);
  console.log(`[${label}] metascan: ${metaMs.toFixed(2)}ms (bar <300ms) -> ${metaMs < 300 ? 'PASS' : 'FAIL'}`);
  return { parseIndexMs, metaMs };
}

const files = [];
walk(ROOT, files);
console.log(`Discovered ${files.length} files under adv-org.`);

const cold = runOnce('COLD', files);
const warm = runOnce('WARM', files);

console.log('\n=== SUMMARY ===');
console.log(`COLD parse+index: ${cold.parseIndexMs.toFixed(2)}ms (bar <3000) -> ${cold.parseIndexMs < 3000 ? 'PASS' : 'FAIL'}`);
console.log(`COLD metascan:    ${cold.metaMs.toFixed(2)}ms (bar <300)  -> ${cold.metaMs < 300 ? 'PASS' : 'FAIL'}`);
console.log(`WARM parse+index: ${warm.parseIndexMs.toFixed(2)}ms`);
console.log(`WARM metascan:    ${warm.metaMs.toFixed(2)}ms`);

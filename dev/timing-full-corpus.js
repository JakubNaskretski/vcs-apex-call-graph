'use strict';
// Adversarial-verifier perf script: parses inz-org force-app (19 files) AND
// the full .sfdx StandardApexLibrary stub corpus (~2.3k files), separately
// and combined, and checks against the PERF TARGETS in the frozen spec:
//   - 19-file force-app cold index < 1s
//   - 2.3k-file stub corpus < 60s
// Also asserts parseFile() never throws (wrapped defensively anyway, but we
// specifically watch for any exception escaping the call).
//
// Usage: node dev/timing-full-corpus.js

const fs = require('fs');
const path = require('path');
const parser = require('../parser');
const resolver = require('../resolver');

const ORG_ROOT = '/Users/agent/work/code/example-data/inz-org';
const FORCE_APP = path.join(ORG_ROOT, 'force-app');
const SFDX_STUBS = path.join(ORG_ROOT, '.sfdx');

function walk(dir, out) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (e) {
    return;
  }
  for (const e of entries) {
    if (e.isDirectory()) {
      walk(path.join(dir, e.name), out);
    } else if (/\.(cls|trigger)$/i.test(e.name)) {
      out.push(path.join(dir, e.name));
    }
  }
}

function parseAll(filePaths, label) {
  let throwCount = 0;
  const throwSamples = [];
  const t0 = Date.now();
  const factsList = [];
  for (const p of filePaths) {
    let text;
    try {
      text = fs.readFileSync(p, 'utf8');
    } catch (e) {
      continue;
    }
    try {
      const facts = parser.parseFile({ path: p, text });
      factsList.push(facts);
    } catch (e) {
      throwCount++;
      if (throwSamples.length < 5) throwSamples.push({ path: p, error: String(e && e.stack || e) });
    }
  }
  const t1 = Date.now();
  const parseMs = t1 - t0;
  console.log(`\n=== ${label} ===`);
  console.log(`Files: ${filePaths.length}, parsed OK (no throw): ${factsList.length}, parseFile() THREW: ${throwCount}`);
  console.log(`Parse time: ${parseMs}ms (${(parseMs / Math.max(1, filePaths.length)).toFixed(3)}ms/file avg)`);
  const errCount = factsList.filter((f) => f.parseError).length;
  console.log(`FileFacts.parseError set: ${errCount}/${factsList.length}`);
  if (throwSamples.length) {
    console.log('THROW SAMPLES:');
    for (const s of throwSamples) console.log(`  ${s.path}\n  ${s.error}`);
  }
  return { factsList, parseMs, throwCount, throwSamples };
}

function main() {
  const forceAppFiles = [];
  walk(FORCE_APP, forceAppFiles);
  const stubFiles = [];
  walk(SFDX_STUBS, stubFiles);

  console.log(`force-app files: ${forceAppFiles.length}`);
  console.log(`.sfdx stub files: ${stubFiles.length}`);

  // --- 19-file force-app cold index, target < 1s (parse + resolver build) ---
  const t0 = Date.now();
  const fa = parseAll(forceAppFiles, 'force-app (19-file target)');
  const idxT0 = Date.now();
  const forceAppIndex = resolver.buildSemanticIndex(fa.factsList);
  const idxT1 = Date.now();
  const t1 = Date.now();
  const forceAppColdTotal = t1 - t0;
  console.log(`force-app resolver index build: ${idxT1 - idxT0}ms`);
  console.log(`force-app COLD TOTAL (parse+index): ${forceAppColdTotal}ms  -- target < 1000ms -- ${forceAppColdTotal < 1000 ? 'PASS' : 'FAIL'}`);
  if (forceAppIndex.duplicates.length) console.log('Duplicates (force-app): ' + forceAppIndex.duplicates.join(', '));

  // --- 2.3k-file stub corpus, target < 60s (parse only, per spec wording) ---
  const stubResult = parseAll(stubFiles, '.sfdx StandardApexLibrary stub corpus (~2.3k-file target)');
  console.log(`stub corpus PARSE ONLY: ${stubResult.parseMs}ms -- target < 60000ms -- ${stubResult.parseMs < 60000 ? 'PASS' : 'FAIL'}`);

  const stubIdxT0 = Date.now();
  const stubIndex = resolver.buildSemanticIndex(stubResult.factsList);
  const stubIdxT1 = Date.now();
  console.log(`stub corpus resolver index build: ${stubIdxT1 - stubIdxT0}ms`);
  console.log(`stub corpus PARSE+INDEX total: ${stubResult.parseMs + (stubIdxT1 - stubIdxT0)}ms`);
  if (stubIndex.duplicates.length) console.log(`Duplicates (stub corpus): ${stubIndex.duplicates.length} -- e.g. ${stubIndex.duplicates.slice(0, 10).join(', ')}`);

  // --- combined corpus (force-app + stubs together), informational ---
  const allFiles = forceAppFiles.concat(stubFiles);
  const combined = parseAll(allFiles, `combined force-app + stubs (${allFiles.length} files)`);
  const combIdxT0 = Date.now();
  const combinedIndex = resolver.buildSemanticIndex(combined.factsList);
  const combIdxT1 = Date.now();
  console.log(`combined resolver index build: ${combIdxT1 - combIdxT0}ms`);
  console.log(`combined PARSE+INDEX total: ${combined.parseMs + (combIdxT1 - combIdxT0)}ms`);

  console.log('\n=== SUMMARY ===');
  console.log(`force-app (19 files) cold total: ${forceAppColdTotal}ms (target <1000ms) -> ${forceAppColdTotal < 1000 ? 'PASS' : 'FAIL'}`);
  console.log(`stub corpus (${stubFiles.length} files) parse: ${stubResult.parseMs}ms (target <60000ms) -> ${stubResult.parseMs < 60000 ? 'PASS' : 'FAIL'}`);
  console.log(`Total parseFile() throws across ALL files (force-app+stubs+combined re-parse): ${fa.throwCount + stubResult.throwCount + combined.throwCount}`);
}

main();

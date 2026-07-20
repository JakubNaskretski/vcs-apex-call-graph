'use strict';
// Adversarial-verifier perf script: parses the adv-org force-app (77 files)
// AND, if present, a local .sfdx StandardApexLibrary stub corpus (~2.3k
// files when generated), separately and combined, and checks against the
// PERF TARGETS in the frozen spec:
//   - force-app cold index < 1s
//   - ~2.3k-file stub corpus < 60s
// Also asserts parseFile() never throws (wrapped defensively anyway, but we
// specifically watch for any exception escaping the call).
//
// The StandardApexLibrary stub corpus is Salesforce's own generic platform
// stub library, not org-specific data -- but it's only materialized locally
// by an actual `sf`/`sfdx` CLI run against a real org (e.g. `sf project
// retrieve start` after `sf org login`), so it isn't checked into this repo
// and ADV_ORG_ROOT/.sfdx is empty by default. If you want the large-corpus
// leg of this perf check, point SFDX_STUBS (2nd CLI arg) at any local
// .sfdx/tools/... stub directory you already have (e.g. by running the CLI
// once against test-fixtures/adv-org, which has its own sfdx-project.json);
// absent that, this script reports 0 files for that leg rather than
// fabricating a result.
//
// Usage: node dev/timing-full-corpus.js [path-to-force-app] [path-to-.sfdx-stubs]

const fs = require('fs');
const path = require('path');
const parser = require('../parser');
const resolver = require('../resolver');

const ADV_ORG_ROOT = 'test-fixtures/adv-org';
const FORCE_APP = process.argv[2] || path.join(ADV_ORG_ROOT, 'force-app');
const SFDX_STUBS = process.argv[3] || path.join(ADV_ORG_ROOT, '.sfdx');

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
  if (!stubFiles.length) {
    console.log(`(no .sfdx stub corpus found at ${SFDX_STUBS} -- the ~2.3k-file perf leg below is a no-op until one is generated locally; see this file's header comment)`);
  }

  // --- force-app cold index, target < 1s (parse + resolver build) ---
  const t0 = Date.now();
  const fa = parseAll(forceAppFiles, `force-app (${forceAppFiles.length}-file target)`);
  const idxT0 = Date.now();
  const forceAppIndex = resolver.buildSemanticIndex(fa.factsList);
  const idxT1 = Date.now();
  const t1 = Date.now();
  const forceAppColdTotal = t1 - t0;
  console.log(`force-app resolver index build: ${idxT1 - idxT0}ms`);
  console.log(`force-app COLD TOTAL (parse+index): ${forceAppColdTotal}ms  -- target < 1000ms -- ${forceAppColdTotal < 1000 ? 'PASS' : 'FAIL'}`);
  if (forceAppIndex.duplicates.length) console.log('Duplicates (force-app): ' + forceAppIndex.duplicates.join(', '));

  // --- ~2.3k-file stub corpus (when present), target < 60s (parse only, per
  // spec wording) -- SKIP (not PASS/FAIL) when no stub corpus is available.
  const stubResult = parseAll(stubFiles, `.sfdx StandardApexLibrary stub corpus (${stubFiles.length} file(s))`);
  console.log(stubFiles.length
    ? `stub corpus PARSE ONLY: ${stubResult.parseMs}ms -- target < 60000ms -- ${stubResult.parseMs < 60000 ? 'PASS' : 'FAIL'}`
    : 'stub corpus PARSE ONLY: SKIPPED (0 files found)');

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
  console.log(`force-app (${forceAppFiles.length} files) cold total: ${forceAppColdTotal}ms (target <1000ms) -> ${forceAppColdTotal < 1000 ? 'PASS' : 'FAIL'}`);
  console.log(stubFiles.length
    ? `stub corpus (${stubFiles.length} files) parse: ${stubResult.parseMs}ms (target <60000ms) -> ${stubResult.parseMs < 60000 ? 'PASS' : 'FAIL'}`
    : 'stub corpus (0 files) parse: SKIPPED (no local .sfdx stub corpus found)');
  console.log(`Total parseFile() throws across ALL files (force-app+stubs+combined re-parse): ${fa.throwCount + stubResult.throwCount + combined.throwCount}`);
}

main();

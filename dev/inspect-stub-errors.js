'use strict';
// Inspect which .sfdx stub files get parseError set, and why, to distinguish
// real parser robustness issues from expected stub-file quirks (interfaces-
// only headers, reserved words used as identifiers in old stub code, etc).
//
// The StandardApexLibrary stub corpus is Salesforce's own generic platform
// stub library (not org-specific data), but it's only materialized locally
// by an actual `sf`/`sfdx` CLI run against a real org, so none of the
// fictional example corpora ship one. Point this at any local
// .sfdx/tools/... stub directory you have (1st CLI arg); with none given
// and none found under adv-org, this reports 0 files rather than
// fabricating a result -- see dev/timing-full-corpus.js's header comment
// for how to generate one locally.
const fs = require('fs');
const path = require('path');
const parser = require('../parser');

const SFDX_STUBS = process.argv[2] || '/Users/agent/work/code/example-data/adv-org/.sfdx';

function walk(dir, out) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
  for (const e of entries) {
    if (e.isDirectory()) walk(path.join(dir, e.name), out);
    else if (/\.(cls|trigger)$/i.test(e.name)) out.push(path.join(dir, e.name));
  }
}

const files = [];
walk(SFDX_STUBS, files);
if (!files.length) {
  console.log(`No .sfdx stub files found at ${SFDX_STUBS}. Pass a local stub directory as an argument (see this file's header comment).`);
}
const errored = [];
for (const p of files) {
  const text = fs.readFileSync(p, 'utf8');
  const facts = parser.parseFile({ path: p, text });
  if (facts.parseError) errored.push({ path: p, err: facts.parseError, hasText: 'text' in facts, len: text.length, types: facts.types.length });
}
console.log(`Total errored: ${errored.length}/${files.length}`);
for (const e of errored.slice(0, 15)) {
  console.log(`\n${e.path}`);
  console.log(`  parseError: ${e.err}`);
  console.log(`  has fallback .text: ${e.hasText}, srcLen: ${e.len}, partial types recovered: ${e.types}`);
}

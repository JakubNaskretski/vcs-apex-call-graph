'use strict';
// Inspect which .sfdx stub files get parseError set, and why, to distinguish
// real parser robustness issues from expected stub-file quirks (interfaces-
// only headers, reserved words used as identifiers in old stub code, etc).
const fs = require('fs');
const path = require('path');
const parser = require('../parser');

const SFDX_STUBS = '/Users/agent/work/code/example-data/inz-org/.sfdx';

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

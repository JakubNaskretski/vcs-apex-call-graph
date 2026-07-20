'use strict';
// Round 2.5 / H7 cold-parse benchmark. Reads the complete fictional
// gauntlet corpus once, then compares the exact same in-memory file payload
// through the inline parser and the worker pool. Timing excludes disk I/O;
// the extension also reads files on the main thread before dispatching.
//
// Usage: node dev/perf-coldparse.js [path-to-force-app]

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { performance } = require('perf_hooks');
const parser = require('../parser');
const workerpool = require('../workerpool');

const CORPUS_ROOT = process.argv[2]
  || 'test-fixtures/gauntlet-org/force-app';
const SKIP_DIRS = new Set(['.git', '.sfdx', '.sf', 'node_modules']);

function walk(dir, out) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (e) {
    return;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) walk(full, out);
    } else if (/\.(cls|trigger|apex)$/i.test(entry.name)) {
      out.push(full);
    }
  }
}

async function main() {
  const paths = [];
  walk(CORPUS_ROOT, paths);
  paths.sort();
  if (!paths.length) throw new Error(`No Apex files found under ${CORPUS_ROOT}`);
  const files = paths.map((fsPath) => ({ path: fsPath, text: fs.readFileSync(fsPath, 'utf8') }));

  const inlineStart = performance.now();
  const inlineFacts = files.map((file) => parser.parseFile(file));
  const inlineMs = performance.now() - inlineStart;

  const poolStart = performance.now();
  const pooled = await workerpool.parseFiles(files);
  const poolMs = performance.now() - poolStart;

  assert.strictEqual(pooled.cancelled, false, 'benchmark pool run must complete');
  assert.deepStrictEqual(
    pooled.facts,
    inlineFacts,
    'worker-pool FileFacts must be byte-identical to inline parsing, in input order'
  );
  assert.strictEqual(pooled.stats.workerErrors, 0, 'benchmark must not use an error fallback');
  assert.strictEqual(pooled.stats.chunksInlineFallback, 0, 'benchmark must parse every chunk in a worker');

  const speedup = inlineMs / Math.max(poolMs, 0.001);
  console.log('Round 2.5 cold-parse benchmark (disk I/O excluded)');
  console.log(`files: ${files.length}`);
  console.log(`inline: ${inlineMs.toFixed(1)}ms`);
  console.log(`worker pool: ${poolMs.toFixed(1)}ms (size ${pooled.stats.poolSize}, chunks ${pooled.stats.chunksViaWorker}/${pooled.stats.chunksTotal})`);
  console.log(`inline / pool: ${speedup.toFixed(2)}x`);
  console.log('facts: byte-identical PASS');
  if (files.length <= 200) {
    console.log('threshold note: the extension intentionally keeps 200-or-fewer cold files inline.');
  } else if (poolMs <= inlineMs) {
    console.log('performance: worker pool wins/ties on the full cold corpus.');
  } else {
    console.log('performance: worker startup exceeded the parse saving on this run; correctness is unchanged and the measured timings are retained for threshold tuning.');
  }
}

main().catch((error) => {
  console.error(error && error.stack ? error.stack : error);
  process.exitCode = 1;
});

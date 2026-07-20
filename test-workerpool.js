'use strict';
// test-workerpool.js -- H7 self-check for workerpool.js/parseworker.js.
// Runs under plain `node test-workerpool.js` (no vscode, no test runner) --
// same standalone-self-check convention as this repo's other test-*.js
// files (see e.g. test-parser.js's tail: a final console.log on success,
// `assert` throwing/exiting non-zero on failure).
//
// Corpus note: the 20-file byte-identity fixture below reads real files
// from the gauntlet-org corpus (example-data/
// gauntlet-org) -- an entirely fictional test org (Vertex/Vtx/Kappa/Bolt
// class-name families), never touched or modified by this file, read-only.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const parser = require('./parser');
const workerpool = require('./workerpool');
const parseworker = require('./parseworker');

// --- computePoolSize -----------------------------------------------------
{
  assert.strictEqual(workerpool.computePoolSize(1), 1, 'floors at 1 for a 1-core box');
  assert.strictEqual(workerpool.computePoolSize(2), 1, 'floors at 1 for a 2-core box (2-2=0 -> floor 1)');
  assert.strictEqual(workerpool.computePoolSize(3), 1, '3-2=1');
  assert.strictEqual(workerpool.computePoolSize(6), 4, '6-2=4, capped at 4');
  assert.strictEqual(workerpool.computePoolSize(10), 4, '10-core input: 10-2=8, capped at 4');
  assert.strictEqual(workerpool.computePoolSize(64), 4, 'a huge box still caps at 4');
  assert.strictEqual(
    workerpool.computePoolSize(undefined),
    Math.max(1, Math.min(4, os.cpus().length - 2)),
    'no override falls back to os.cpus().length'
  );
}

// --- chunkArray: contiguous, ordered, count-correct -----------------------
{
  assert.deepStrictEqual(workerpool.chunkArray([], 4), [], 'empty in -> empty out');
  const items = Array.from({ length: 10 }, (_, i) => i);
  const chunks3 = workerpool.chunkArray(items, 3);
  assert.strictEqual(chunks3.length <= 3, true, 'never more chunks than requested');
  assert.deepStrictEqual(chunks3.flat(), items, 'flattening chunks reproduces the original order exactly');
  const chunks1 = workerpool.chunkArray(items, 1);
  assert.deepStrictEqual(chunks1, [items], 'chunkCount 1 -> one chunk holding everything');
  const chunksOver = workerpool.chunkArray([1, 2], 10);
  assert.strictEqual(chunksOver.length <= 2, true, 'never more chunks than items');
  assert.deepStrictEqual(chunksOver.flat(), [1, 2]);
}

// --- inlineParseChunk matches parser.parseFile called directly -----------
{
  const files = [
    { path: 'Foo.cls', text: 'public class Foo { void m() {} }' },
    { path: 'Bar.cls', text: 'public class Bar { void n() { new Foo().m(); } }' },
  ];
  const viaHelper = workerpool.inlineParseChunk(files);
  const direct = files.map((f) => parser.parseFile({ path: f.path, text: f.text }));
  assert.deepStrictEqual(viaHelper, direct, 'inlineParseChunk is byte-identical to calling parser.parseFile per file');
}

// --- parseworker.js's pure chunk-parsing (in-process, no real Worker) ----
{
  const files = [{ path: 'Baz.cls', text: 'public class Baz {}' }];
  const viaWorkerModule = parseworker.parseChunk(files);
  const direct = files.map((f) => parser.parseFile({ path: f.path, text: f.text }));
  assert.deepStrictEqual(viaWorkerModule, direct, 'parseworker.parseChunk matches inline parseFile');
  assert.doesNotThrow(() => parseworker.parseChunk(undefined), 'parseChunk defends against a malformed/missing chunk');
  assert.deepStrictEqual(parseworker.parseChunk(undefined), [], 'malformed chunk -> empty facts, never throws');
}

// --- gauntlet-org corpus fixture: 20 real files -----------------------------
const CORPUS_DIR = 'test-fixtures/gauntlet-org/force-app/main/default/classes';
function load20CorpusFiles() {
  const names = fs
    .readdirSync(CORPUS_DIR)
    .filter((f) => f.endsWith('.cls'))
    .sort()
    .slice(0, 20);
  assert.strictEqual(names.length, 20, 'expected the gauntlet-org corpus to have at least 20 .cls files to sample');
  return names.map((name) => {
    const fsPath = path.join(CORPUS_DIR, name);
    return { path: fsPath, text: fs.readFileSync(fsPath, 'utf8') };
  });
}

async function run() {
  const corpusFiles = load20CorpusFiles();
  const inlineFacts = corpusFiles.map((f) => parser.parseFile({ path: f.path, text: f.text }));

  // --- real worker-pool parse, default settings (real worker_threads) ----
  {
    const { facts, stats } = await workerpool.parseFiles(corpusFiles, { poolSize: 4 });
    assert.strictEqual(facts.length, corpusFiles.length, 'pool returns one FileFacts per input file');
    assert.deepStrictEqual(
      facts,
      inlineFacts,
      'H7 byte-identity: pool-parsed FileFacts[] deep-equal inline parser.parseFile FileFacts[], in the same order, over 20 real corpus files'
    );
    assert.strictEqual(stats.usedPool, true, 'real Worker is available in this environment, so the pool should be used');
    assert.strictEqual(stats.workerErrors, 0, 'no worker errors expected on this happy path');
    assert.strictEqual(stats.chunksInlineFallback, 0, 'no chunks should have fallen back on this happy path');
    assert.ok(stats.chunksViaWorker > 0 && stats.chunksViaWorker === stats.chunksTotal, 'every chunk went through a worker');
  }

  // --- ordering holds with a pool size that does NOT evenly divide -------
  {
    const { facts } = await workerpool.parseFiles(corpusFiles, { poolSize: 3 });
    assert.deepStrictEqual(facts, inlineFacts, 'ordering is preserved even when chunk count does not evenly divide file count');
  }

  // --- single-file / empty-input edge cases -------------------------------
  {
    const { facts: oneFacts, stats: oneStats } = await workerpool.parseFiles([corpusFiles[0]], { poolSize: 4 });
    assert.deepStrictEqual(oneFacts, [inlineFacts[0]], 'a single file still parses correctly through the pool');
    assert.strictEqual(oneStats.chunksTotal, 1);

    const { facts: emptyFacts, stats: emptyStats } = await workerpool.parseFiles([], { poolSize: 4 });
    assert.deepStrictEqual(emptyFacts, [], 'empty input -> empty output, no crash');
    assert.strictEqual(emptyStats.usedPool, false, 'nothing to parse -> pool is not considered "used"');
  }

  // --- full worker unavailability -> inline path --------------------------
  {
    const { facts, stats } = await workerpool.parseFiles(corpusFiles, { forceNoWorkers: true });
    assert.strictEqual(stats.usedPool, false, 'forceNoWorkers -> pool never engaged');
    assert.strictEqual(stats.chunksTotal, 0, 'no chunks dispatched at all when the pool path is skipped entirely');
    assert.deepStrictEqual(facts, inlineFacts, 'full-unavailability inline path is still byte-identical to direct parseFile');
  }

  // --- cancellation before dispatch returns no partial facts -------------
  {
    const { facts, stats, cancelled } = await workerpool.parseFiles(corpusFiles, {
      poolSize: 4,
      shouldCancel: () => true,
    });
    assert.strictEqual(cancelled, true);
    assert.strictEqual(stats.chunksViaWorker, 0, 'shouldCancel() true for every chunk -> no worker dispatch at all');
    assert.strictEqual(stats.chunksInlineFallback, 0, 'cancellation never burns CPU on an inline fallback');
    assert.deepStrictEqual(facts, [], 'a cancelled parse exposes no partial FileFacts for a caller to accidentally cache');
  }

  // --- cancellation while workers are active terminates every chunk ------
  {
    const slowScriptPath = path.join(os.tmpdir(), 'apex-call-graph-test-slow-worker.js');
    fs.writeFileSync(
      slowScriptPath,
      "const { parentPort } = require('worker_threads');\n" +
        "if (parentPort) parentPort.on('message', () => setTimeout(() => parentPort.postMessage({ ok: true, facts: [] }), 1000));\n"
    );
    let cancel = false;
    const timer = setTimeout(() => { cancel = true; }, 30);
    try {
      const { facts, stats, cancelled } = await workerpool.parseFiles(corpusFiles, {
        poolSize: 4,
        workerScript: slowScriptPath,
        shouldCancel: () => cancel,
        cancelPollMs: 5,
      });
      assert.strictEqual(cancelled, true, 'a token flipping while workers run cancels the pool');
      assert.deepStrictEqual(facts, [], 'mid-flight cancellation never returns a partial ordered result');
      assert.strictEqual(stats.chunksCancelled, stats.chunksTotal, 'all active worker chunks were terminated');
      assert.strictEqual(stats.chunksInlineFallback, 0, 'cancelled workers do not fall back inline');
    } finally {
      clearTimeout(timer);
      fs.unlinkSync(slowScriptPath);
    }
  }

  // --- per-worker error -> that chunk falls back to inline, others unaffected
  {
    // A deliberately broken "worker script" -- requireable, but its
    // parentPort.on('message', ...) handler always replies with ok:false,
    // simulating a worker that started fine but failed mid-parse (e.g. a
    // pathological input it chokes on) rather than a spawn-time failure.
    const brokenScriptPath = path.join(os.tmpdir(), 'apex-call-graph-test-broken-worker.js');
    fs.writeFileSync(
      brokenScriptPath,
      "const { parentPort } = require('worker_threads');\n" +
        "if (parentPort) parentPort.on('message', () => parentPort.postMessage({ ok: false, error: 'deliberate test failure' }));\n"
    );
    try {
      const { facts, stats } = await workerpool.parseFiles(corpusFiles, {
        poolSize: 4,
        workerScript: brokenScriptPath,
      });
      assert.strictEqual(stats.workerErrors, stats.chunksTotal, 'every chunk failed via the broken worker script');
      assert.strictEqual(stats.chunksInlineFallback, stats.chunksTotal, 'every chunk fell back to inline parsing');
      assert.strictEqual(stats.chunksViaWorker, 0, 'no chunk succeeded via a worker');
      assert.deepStrictEqual(
        facts,
        inlineFacts,
        'worker-error fallback still produces byte-identical, complete, correctly-ordered facts'
      );
    } finally {
      fs.unlinkSync(brokenScriptPath);
    }
  }

  // --- nonexistent worker script -> spawn failure also falls back --------
  {
    const missingScriptPath = path.join(os.tmpdir(), 'apex-call-graph-test-does-not-exist-worker.js');
    const { facts, stats } = await workerpool.parseFiles(corpusFiles, {
      poolSize: 2,
      workerScript: missingScriptPath,
    });
    assert.strictEqual(stats.chunksInlineFallback, stats.chunksTotal, 'a spawn failure falls back to inline for that chunk too');
    assert.deepStrictEqual(facts, inlineFacts, 'spawn-failure fallback is still byte-identical/complete');
  }

  // --- a worker that exits cleanly without replying must not hang --------
  {
    const silentExitScriptPath = path.join(os.tmpdir(), 'apex-call-graph-test-silent-exit-worker.js');
    fs.writeFileSync(
      silentExitScriptPath,
      "const { parentPort } = require('worker_threads');\n" +
        "if (parentPort) parentPort.on('message', () => process.exit(0));\n"
    );
    let timeout;
    try {
      const result = await Promise.race([
        workerpool.parseFiles(corpusFiles, { poolSize: 2, workerScript: silentExitScriptPath }),
        new Promise((_, reject) => {
          timeout = setTimeout(() => reject(new Error('silent code-0 worker exit left parseFiles pending')), 1500);
        }),
      ]);
      assert.strictEqual(result.stats.workerErrors, result.stats.chunksTotal, 'every silent exit is counted as a worker error');
      assert.strictEqual(result.stats.chunksInlineFallback, result.stats.chunksTotal, 'every silent exit falls back inline');
      assert.deepStrictEqual(result.facts, inlineFacts, 'silent-exit fallback remains byte-identical and ordered');
    } finally {
      if (timeout) clearTimeout(timeout);
      fs.unlinkSync(silentExitScriptPath);
    }
  }

  console.log('apex-call-graph workerpool.js/parseworker.js self-check: all assertions passed');
}

run().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});

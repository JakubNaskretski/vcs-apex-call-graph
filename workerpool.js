'use strict';
// workerpool.js -- H7's pure-testable pool manager. Used by extension.js
// ONLY when a cold parse needs to handle >200 files (see extension.js's
// scanAndParse); small/warm-cache scans stay on today's single-threaded
// inline path unchanged. Nothing here imports `vscode` -- it is plain,
// requireable-under-plain-`node` JS (worker_threads is a Node core module),
// which is what makes it independently unit-testable (test-workerpool.js)
// without a VS Code extension host.
//
// Contract:
//   parseFiles(files, opts) -> Promise<{ facts, stats }>
//     files: [{ path, text }], in the order the caller wants FileFacts back
//            in (ordered reassembly -- see chunkArray's contiguous-slice
//            chunking, which is what makes simple concatenation correct).
//     opts.cpuCount: override for os.cpus().length (test-only knob).
//     opts.poolSize: override the size computation entirely (test-only knob).
//     opts.shouldCancel(): optional -- checked before dispatch, between
//            inline files, and while workers are active. Cancellation
//            terminates active workers and returns { cancelled:true,
//            facts:[] }; callers must discard the cancelled result.
//   facts: FileFacts[] in the SAME order as `files`, BYTE-IDENTICAL (per
//          test-workerpool.js's corpus proof) to calling parser.parseFile
//          per file inline in this same order.
//   stats: counts-only (H8-shaped) -- see buildDiagnosticsPayload in
//          scanflow.js, which folds `workers` straight from this shape.
//
// Failure modes, both degrading to inline parsing rather than losing facts:
//   - worker_threads unavailable at all (require throws, or Worker is
//     falsy) -> `usedPool: false`, everything parsed inline, no workers ever
//     spawned.
//   - ONE worker's chunk errors (spawn failure, 'error' event, non-zero
//     'exit', or a `{ ok:false }` reply) -> ONLY that chunk falls back to
//     inline parsing; every other chunk's worker result is kept as-is.
const os = require('os');
const path = require('path');
const parser = require('./parser');

let WorkerCtor = null;
try {
  WorkerCtor = require('worker_threads').Worker;
} catch (e) {
  WorkerCtor = null;
}

const WORKER_SCRIPT = path.join(__dirname, 'parseworker.js');

// size = min(4, os.cpus().length - 2), floored at 1 -- a 1-2 core sandbox/CI
// box still gets exactly one worker rather than zero (zero would silently
// defeat the whole pool for no benefit. This is the extension's bounded
// parse budget and is independent of whatever else is running on the host.
function computePoolSize(cpuCount) {
  const n = typeof cpuCount === 'number' && cpuCount > 0 ? cpuCount : os.cpus().length;
  return Math.max(1, Math.min(4, n - 2));
}

// Contiguous slices (not round-robin) -- `chunks.flat()` in the original
// `files` order is then always correct, no per-item index bookkeeping
// needed for reassembly.
function chunkArray(items, chunkCount) {
  if (!Array.isArray(items) || items.length === 0) return [];
  const n = Math.max(1, Math.min(chunkCount, items.length));
  const size = Math.ceil(items.length / n);
  const chunks = [];
  for (let i = 0; i < items.length; i += size) chunks.push(items.slice(i, i + size));
  return chunks;
}

function inlineParseChunk(chunk) {
  return chunk.map((f) => parser.parseFile({ path: f.path, text: f.text }));
}

// One worker per chunk, one message in / one message out, then terminated --
// deliberately not a long-lived worker pool that recycles threads across
// chunks (H7's own "chunked dispatch" framing plus the >200-file threshold
// this is only ever invoked at makes per-chunk spin-up cost negligible next
// to parse time, and keeps this function's error handling trivial: exactly
// one settle path per chunk, no thread-reuse state to reset on error).
function runWorkerChunk(chunk, workerScript, opts) {
  opts = opts || {};
  const shouldCancel = typeof opts.shouldCancel === 'function' ? opts.shouldCancel : null;
  const cancelPollMs = Math.max(5, Number(opts.cancelPollMs) || 20);
  return new Promise((resolve) => {
    let worker;
    let settled = false;
    let cancelTimer = null;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      if (cancelTimer) clearInterval(cancelTimer);
      try {
        if (worker) worker.terminate();
      } catch (e) {
        // already exited / terminate racing exit -- fine, we already have our result
      }
      resolve(result);
    };
    if (shouldCancel && shouldCancel()) {
      finish({ ok: false, cancelled: true });
      return;
    }
    try {
      worker = new WorkerCtor(workerScript || WORKER_SCRIPT);
    } catch (e) {
      finish({ ok: false, error: e });
      return;
    }
    worker.once('message', (msg) => {
      if (msg && msg.ok) finish({ ok: true, facts: msg.facts });
      else finish({ ok: false, error: new Error((msg && msg.error) || 'worker parse error') });
    });
    worker.once('error', (err) => finish({ ok: false, error: err }));
    worker.once('exit', (code) => {
      if (!settled) finish({ ok: false, error: new Error('worker exited before replying (code ' + code + ')') });
    });
    worker.postMessage(chunk);
    if (shouldCancel) {
      cancelTimer = setInterval(() => {
        if (shouldCancel()) finish({ ok: false, cancelled: true });
      }, cancelPollMs);
    }
  });
}

async function parseFiles(files, opts) {
  opts = opts || {};
  const list = Array.isArray(files) ? files : [];
  const poolSize =
    typeof opts.poolSize === 'number' && opts.poolSize > 0
      ? Math.floor(opts.poolSize)
      : computePoolSize(opts.cpuCount);
  const workerScript = opts.workerScript || WORKER_SCRIPT;
  const canUseWorkers = !!WorkerCtor && !(opts.forceNoWorkers === true);

  const stats = {
    usedPool: canUseWorkers && list.length > 0,
    poolSize,
    chunksTotal: 0,
    chunksViaWorker: 0,
    chunksInlineFallback: 0,
    chunksCancelled: 0,
    workerErrors: 0,
  };

  const shouldCancel = typeof opts.shouldCancel === 'function' ? opts.shouldCancel : null;
  if (shouldCancel && shouldCancel()) {
    stats.usedPool = false;
    return { facts: [], stats, cancelled: true };
  }

  if (list.length === 0) {
    stats.usedPool = false;
    return { facts: [], stats, cancelled: false };
  }

  if (!canUseWorkers) {
    stats.usedPool = false;
    const facts = [];
    for (const file of list) {
      if (shouldCancel && shouldCancel()) return { facts: [], stats, cancelled: true };
      facts.push(parser.parseFile({ path: file.path, text: file.text }));
    }
    return { facts, stats, cancelled: false };
  }

  const chunks = chunkArray(list, poolSize);
  stats.chunksTotal = chunks.length;

  const results = await Promise.all(
    chunks.map(async (chunk) => {
      const r = await runWorkerChunk(chunk, workerScript, { shouldCancel, cancelPollMs: opts.cancelPollMs });
      if (r.cancelled) {
        stats.chunksCancelled++;
        return { facts: [], cancelled: true };
      }
      if (r.ok) {
        stats.chunksViaWorker++;
        return { facts: r.facts, cancelled: false };
      }
      stats.workerErrors++;
      if (shouldCancel && shouldCancel()) {
        stats.chunksCancelled++;
        return { facts: [], cancelled: true };
      }
      stats.chunksInlineFallback++;
      return { facts: inlineParseChunk(chunk), cancelled: false }; // per-chunk fallback -- never lose facts
    })
  );

  const cancelled = results.some((r) => r.cancelled);
  return {
    facts: cancelled ? [] : results.flatMap((r) => r.facts),
    stats,
    cancelled,
  };
}

module.exports = {
  parseFiles,
  computePoolSize,
  chunkArray,
  inlineParseChunk,
  runWorkerChunk,
  WORKER_SCRIPT,
};

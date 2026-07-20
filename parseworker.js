'use strict';
// parseworker.js -- H7's worker_threads ENTRY point. Spawned by
// workerpool.js's runWorkerChunk() (new Worker(WORKER_SCRIPT, ...)); never
// require()'d directly by extension.js. Receives exactly one message per
// worker lifetime: a chunk `[{ path, text }]` array. Requires the SAME
// parser.js this file lives next to (frozen this round -- never touched,
// just called) and returns FileFacts[] in the SAME order the chunk arrived
// in, so workerpool.js's caller can reassemble the full ordered facts list
// by simple chunk concatenation.
//
// parser.parseFile's own contract is "never throws" (see extension.js's
// header note), but this wraps the whole chunk in try/catch anyway --
// something in the worker_threads message-passing boundary itself (a
// pathological `text` value structured-clone can't handle, though a plain
// string always can) failing should degrade to workerpool.js's per-chunk
// inline-fallback path, never crash the worker silently with no reply at
// all (which would hang the caller's `once('message', ...)` listener
// forever; workerpool treats any pre-reply exit (including code 0) as a
// per-chunk failure and falls back inline.
const { parentPort } = require('worker_threads');
const parser = require('./parser');

function parseChunk(chunk) {
  const files = Array.isArray(chunk) ? chunk : [];
  return files.map((f) => parser.parseFile({ path: f && f.path, text: f && f.text }));
}

if (parentPort) {
  parentPort.on('message', (chunk) => {
    try {
      const facts = parseChunk(chunk);
      parentPort.postMessage({ ok: true, facts });
    } catch (e) {
      parentPort.postMessage({ ok: false, error: (e && e.message) || String(e) });
    }
  });
}

// Exported (not just for worker_threads use) so test-workerpool.js can also
// unit-test the pure chunk-parsing logic in-process, without paying for an
// actual Worker spin-up, in addition to its real-worker byte-identity test.
module.exports = { parseChunk };

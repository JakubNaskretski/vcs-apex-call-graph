'use strict';
// scanflow.js -- pure, vscode-free control-flow helpers for Round 2.5's H5
// (single-flight + same-target coalescing + one-pending-queue) and H6
// (watcher dirty-set with fullSweepNeeded fallback). Also carries H8's
// counts-only diagnostics payload builder, since it is pure data shaping
// with no vscode dependency either.
//
// Nothing in this file touches `vscode`, the filesystem, or worker_threads --
// it is plain, synchronous-except-for-Promises JS, runnable (and unit-tested,
// see test-scanflow.js) under plain `node`. extension.js is the only caller
// that wires real vscode.FileSystemWatcher events / vscode.window.withProgress
// tokens into the shapes this module defines.

// =========================================================================
// H5: single-flight + same-key coalescing + one-pending-queue ("latest wins")
// =========================================================================
//
// Contract:
//   const flow = createScanFlow();
//   const promise = flow.request(key, workFn);
//
// - No in-flight run: `workFn()` starts immediately (family pattern:
//   `inflight ??= workFn().finally(() => inflight = undefined)`), and its
//   result is what `promise` resolves to.
// - An in-flight run with the SAME key: `promise` is the EXACT SAME promise
//   instance as the in-flight run's -- no second invocation of `workFn`,
//   pure coalescing.
// - An in-flight run with a DIFFERENT key: this request is queued (at most
//   ONE pending slot). If a different-key request was already queued, it is
//   superseded -- its own callers' promises resolve to `{ superseded: true }`
//   rather than hanging forever, and its `workFn` is discarded, never
//   invoked. The newest queued request's `workFn` runs automatically the
//   moment the current in-flight run settles.
// - A caller whose request lands on an EXISTING queued slot with the SAME
//   key as what's already queued simply joins it (another promise that
//   resolves once that queued run eventually executes and completes) --
//   still only one pending slot, never two queued workFns for the same key.
//
// "Cancel cancels the shared scan for all joiners" (H5's own text) falls out
// of this for free: every joiner shares the literal same Promise, so if
// `workFn` itself is cancellable (e.g. it wraps a vscode.CancellationToken
// and resolves early with a cancelled-sentinel once the user hits Cancel on
// the progress notification), every joiner observes that identical
// settlement -- there is no separate "cancel" API on this module because
// there is nothing separate to cancel.
function createScanFlow() {
  let inflight = null; // { key, promise }
  let queued = null; // { key, workFn, waiters: [{resolve, reject}] }

  function start(key, workFn) {
    const promise = Promise.resolve()
      .then(workFn)
      .finally(() => {
        if (inflight && inflight.key === key && inflight.promise === promise) {
          inflight = null;
        }
        if (queued) {
          const next = queued;
          queued = null;
          const nextPromise = start(next.key, next.workFn);
          next.waiters.forEach((w) => nextPromise.then(w.resolve, w.reject));
        }
      });
    inflight = { key, promise };
    return promise;
  }

  function request(key, workFn) {
    if (!inflight) {
      return start(key, workFn);
    }
    if (inflight.key === key) {
      return inflight.promise; // same-target coalescing: no second run
    }
    // Different target while busy: at most one pending slot, latest wins.
    if (queued && queued.key !== key) {
      const superseded = queued.waiters;
      queued = null;
      superseded.forEach((w) => w.resolve({ superseded: true }));
    }
    if (!queued) {
      queued = { key, workFn, waiters: [] };
    }
    return new Promise((resolve, reject) => {
      queued.waiters.push({ resolve, reject });
    });
  }

  return {
    request,
    get isBusy() {
      return !!inflight;
    },
    get inflightKey() {
      return inflight ? inflight.key : null;
    },
    get queuedKey() {
      return queued ? queued.key : null;
    },
  };
}

// Captures the editor identity that an interactive request was made from.
// The extension takes this snapshot BEFORE entering the single-flight queue,
// then passes the same snapshot through target resolution after indexing.
// Including the document version prevents a save/edit at the same cursor
// position from joining a scan that started against older contents.
function interactiveRequestKey(kind, identity, fallbackNonce) {
  const family = typeof kind === 'string' && kind ? kind : 'trace';
  if (
    identity &&
    typeof identity.uri === 'string' &&
    identity.uri &&
    Number.isInteger(identity.line) &&
    Number.isInteger(identity.character)
  ) {
    const version = Number.isInteger(identity.version) ? identity.version : 0;
    return `interactive:${family}:${JSON.stringify([identity.uri, version, identity.line, identity.character])}`;
  }
  // With no active editor the eventual QuickPick selection is unknowable at
  // request time. A per-request nonce therefore queues it independently
  // instead of incorrectly coalescing two separate picker interactions.
  return `interactive:${family}:picker:${String(fallbackNonce == null ? '' : fallbackNonce)}`;
}

// =========================================================================
// H6: watcher dirty-set tracker (+ fullSweepNeeded fallback)
// =========================================================================
//
// Pure bookkeeping only -- extension.js's vscode.FileSystemWatcher event
// handlers call markChanged/markDeleted/markFullSweepNeeded as events
// arrive; scanAndParse/scanMetaFiles read a snapshot (via peek(), non-
// destructive) to decide whether they can skip findFiles+stat, then the
// scan orchestrator calls snapshotAndReset() exactly once per completed
// scan to atomically consume what was accumulated and start the next
// window clean. Starts with fullSweepNeeded true: there is no "previous
// successful scan" yet to make a dirty set meaningful against, so the very
// first trace in a session always does a full sweep, matching H6's own
// "After the first successful scan..." framing.
function createDirtyTracker() {
  let dirty = new Map(); // fsPath -> event generation
  let deleted = new Map(); // fsPath -> event generation
  let generation = 0;
  let fullSweepNeeded = true;
  let fullSweepGeneration = 0;
  let watcherUnavailable = false;

  function markChanged(fsPath) {
    if (!fsPath) return;
    deleted.delete(fsPath);
    dirty.set(fsPath, ++generation);
  }
  function markCreated(fsPath) {
    markChanged(fsPath);
  }
  function markDeleted(fsPath) {
    if (!fsPath) return;
    dirty.delete(fsPath);
    deleted.set(fsPath, ++generation);
  }
  // Watcher failure/overflow -> never trust a possibly-stale dirty set
  // silently; this is a one-way latch until the next snapshotAndReset()
  // (i.e. until the next full sweep actually runs and clears it).
  function markFullSweepNeeded() {
    fullSweepNeeded = true;
    fullSweepGeneration++;
  }
  // Watcher creation failed permanently for this extension-host session.
  // Unlike an individual handler error/overflow, one successful full sweep
  // cannot make future dirty sets trustworthy: no watcher exists to observe
  // subsequent edits. This state is deliberately one-way.
  function markWatcherUnavailable() {
    watcherUnavailable = true;
    fullSweepNeeded = true;
    fullSweepGeneration++;
  }
  function peek() {
    return {
      dirty: new Set(dirty.keys()),
      deleted: new Set(deleted.keys()),
      fullSweepNeeded: fullSweepNeeded || watcherUnavailable,
      _dirtyVersions: new Map(dirty),
      _deletedVersions: new Map(deleted),
      _fullSweepGeneration: fullSweepGeneration,
    };
  }
  function snapshotAndReset() {
    const snap = peek();
    dirty = new Map();
    deleted = new Map();
    fullSweepNeeded = false;
    return snap;
  }
  // Consumes exactly the paths a completed scan actually accounted for
  // (normally the very `dirty`/`deleted` sets from a peek() taken before
  // that scan started), leaving anything ELSE untouched -- in particular,
  // any watcher event that arrived DURING the scan (after the peek(), for a
  // path not in that peek's own sets) is deliberately NOT cleared here, so
  // it survives to be picked up by the NEXT trace instead of being silently
  // dropped by an over-eager full reset. Per-path generations also preserve
  // a SECOND event for the same path that arrives while the scan is using
  // its earlier snapshot.
  function consume(snapshotOrDirty, consumedDeleted) {
    if (snapshotOrDirty && snapshotOrDirty.dirty instanceof Set) {
      const snap = snapshotOrDirty;
      for (const p of snap.dirty) {
        const expected = snap._dirtyVersions && snap._dirtyVersions.get(p);
        if (expected === undefined || dirty.get(p) === expected) dirty.delete(p);
      }
      for (const p of snap.deleted || []) {
        const expected = snap._deletedVersions && snap._deletedVersions.get(p);
        if (expected === undefined || deleted.get(p) === expected) deleted.delete(p);
      }
      return;
    }
    // Backwards-compatible set-pair form used by older pure callers.
    if (snapshotOrDirty) for (const p of snapshotOrDirty) dirty.delete(p);
    if (consumedDeleted) for (const p of consumedDeleted) deleted.delete(p);
  }
  // Called only once an ACTUAL full sweep has completed -- clears the
  // fullSweepNeeded latch (a fast/incremental path never sets it, so never
  // needs to clear it either).
  function markSweepDone(snapshot) {
    // A workspace-folder or watcher invalidation may arrive while a full
    // sweep is in flight. Only clear the latch when this completed sweep
    // started after the most recent invalidation; otherwise the event must
    // survive and force the following scan to rebuild its path inventory.
    if (snapshot && snapshot._fullSweepGeneration !== fullSweepGeneration) return;
    fullSweepNeeded = false;
  }
  return {
    markChanged,
    markCreated,
    markDeleted,
    markFullSweepNeeded,
    markWatcherUnavailable,
    peek,
    snapshotAndReset,
    consume,
    markSweepDone,
    get isEmpty() {
      return !fullSweepNeeded && !watcherUnavailable && dirty.size === 0 && deleted.size === 0;
    },
  };
}

// Produces the callback passed to vscode.workspace.onDidChangeWorkspaceFolders
// without importing vscode into this pure module. Workspace membership
// changes invalidate the cached path inventory even when no individual file
// watcher event fires (especially when a whole folder is removed), so either
// an addition or a removal forces the next scan to be a full sweep.
function createWorkspaceFolderChangeHandler(invalidate) {
  if (typeof invalidate !== 'function') {
    throw new TypeError('createWorkspaceFolderChangeHandler requires an invalidation callback');
  }
  return (event) => {
    const added = event && event.added && typeof event.added.length === 'number' ? event.added.length : 0;
    const removed = event && event.removed && typeof event.removed.length === 'number' ? event.removed.length : 0;
    if (added > 0 || removed > 0) invalidate();
  };
}

// =========================================================================
// H6 hardening: user exclude-glob matching + settings invalidation
// =========================================================================

function normalizeExcludeGlobs(globs) {
  if (!Array.isArray(globs)) return [];
  return Array.from(
    new Set(
      globs
        .filter((glob) => typeof glob === 'string')
        .map((glob) => glob.trim().replace(/\\/g, '/').replace(/^\.\//, ''))
        .filter(Boolean)
    )
  ).sort();
}

function expandGlobBraces(pattern) {
  const open = pattern.indexOf('{');
  if (open === -1) return [pattern];
  const close = pattern.indexOf('}', open + 1);
  if (close === -1) return [pattern];
  const choices = pattern.slice(open + 1, close).split(',');
  if (choices.length < 2) return [pattern];
  const prefix = pattern.slice(0, open);
  const suffix = pattern.slice(close + 1);
  return choices.flatMap((choice) => expandGlobBraces(prefix + choice + suffix));
}

function globToRegExp(glob) {
  let source = '^';
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i];
    if (ch === '*') {
      if (glob[i + 1] === '*') {
        i++;
        if (glob[i + 1] === '/') {
          i++;
          source += '(?:[^/]+/)*';
        } else {
          source += '.*';
        }
      } else {
        source += '[^/]*';
      }
      continue;
    }
    if (ch === '?') {
      source += '[^/]';
      continue;
    }
    if (ch === '[') {
      const close = glob.indexOf(']', i + 1);
      if (close !== -1) {
        let body = glob.slice(i + 1, close);
        if (body[0] === '!') body = '^' + body.slice(1);
        source += '[' + body.replace(/\\/g, '\\\\') + ']';
        i = close;
        continue;
      }
    }
    source += /[\\^$.*+?()[\]{}|]/.test(ch) ? '\\' + ch : ch;
  }
  return new RegExp(source + '$');
}

// `relativePath` must be relative to the containing workspace folder, which
// mirrors how vscode.workspace.findFiles evaluates string glob patterns.
function matchesExcludeGlobs(relativePath, globs) {
  if (typeof relativePath !== 'string') return false;
  const candidate = relativePath.replace(/\\/g, '/').replace(/^\.\//, '');
  if (!candidate || candidate === '..' || candidate.startsWith('../')) return false;
  for (const glob of normalizeExcludeGlobs(globs)) {
    for (const expanded of expandGlobBraces(glob)) {
      try {
        if (globToRegExp(expanded).test(candidate)) return true;
      } catch (_) {
        // A hand-edited malformed setting must not break all incremental
        // scans. vscode's full-scan matcher remains the authority for that
        // pattern; the settings fingerprint still forces a full sweep when
        // it changes.
      }
    }
  }
  return false;
}

function excludeGlobsFingerprint(globs) {
  return JSON.stringify(normalizeExcludeGlobs(globs));
}

function createExcludeTracker() {
  let committedFingerprint = null;
  return {
    requiresFullSweep(globs) {
      const next = excludeGlobsFingerprint(globs);
      return committedFingerprint !== null && next !== committedFingerprint;
    },
    commit(globs) {
      committedFingerprint = excludeGlobsFingerprint(globs);
    },
    get fingerprint() {
      return committedFingerprint;
    },
  };
}

// =========================================================================
// H8: counts-only diagnostics payload (apexTrace.copyDiagnostics)
// =========================================================================
//
// Builds the EXACT object that gets JSON.stringify'd to the clipboard.
// Every value here must be a number, boolean, null, or a small fixed enum
// string this module itself defines (never a class/method/file/namespace
// name pulled from the scanned workspace) -- see assertCountsOnly below,
// which extension.js's copyDiagnostics command runs before ever touching
// the clipboard, and test-scanflow.js exercises directly.
//
// `raw` is a best-effort, duck-typed grab-bag of whatever the rest of the
// engine (resolver.js's index, workerpool.js's stats, extension.js's own
// phase timers) happened to produce this run -- every field is read
// defensively with a fallback so a resolver.js build that hasn't landed
// H1/H2/H3's own stats fields yet still produces a valid (just sparser)
// payload instead of throwing.
// Fixed, small, engine-internal vocabularies -- never workspace-derived --
// for the two duck-typed count-by-key maps below. Anything outside these
// sets is DROPPED (not merely flagged) by buildDiagnosticsPayload itself,
// and assertCountsOnly re-checks the same vocabularies as a second,
// independent line of defense against a stray real identifier ever ending
// up as an object KEY in the payload (a name-shaped value is already
// caught generically; a name-shaped KEY needs its own check, since
// Object.keys() are exactly where a careless caller could leak one).
// unresolved-by-reason: H8's own spec text names these five reasons.
const KNOWN_UNRESOLVED_REASONS = new Set([
  'unknown-receiver',
  'deep-chain',
  'non-literal-dynamic',
  'parse-fallback',
  'name-too-common',
]);
// via-kind histogram: resolver.js's own existing `via` value vocabulary
// (static/ambiguous/external/override/dml/interface/typed/unique-name/
// dynamic/publish/throws/lexical/new) plus this round's additions
// (narrowed via B2, rollup via H2).
const KNOWN_VIA_KINDS = new Set([
  'static',
  'this',
  'super',
  'ambiguous',
  'external',
  'override',
  'dml',
  'dml-unresolved',
  'interface',
  'typed',
  'unique-name',
  'dynamic',
  'publish',
  'throws',
  'async',
  'lexical',
  'new',
  'narrowed',
  'metadata',
  'subflow',
  'unresolved',
  'rollup',
]);

function buildDiagnosticsPayload(raw) {
  raw = raw || {};
  const files = raw.files || {};
  const workers = raw.workers || {};
  const timingMs = raw.timingMs || {};
  const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
  const boolOrNull = (v) => (typeof v === 'boolean' ? v : null);
  const enumOrNull = (v, allowed) => (typeof v === 'string' && allowed.indexOf(v) !== -1 ? v : null);

  // unresolvedByReason / viaHistogram / magnetSuppressed: read whatever
  // resolver.js's index exposes (H1/H3, a different phase this round) via
  // duck typing, but re-emit ONLY as a reason-string -> count map, and ONLY
  // for keys in the known vocabularies above -- never passing through any
  // key or nested object that might carry a workspace-derived name.
  const reasonCounts = {};
  if (raw.unresolvedByReason && typeof raw.unresolvedByReason === 'object') {
    for (const k of Object.keys(raw.unresolvedByReason)) {
      const v = raw.unresolvedByReason[k];
      if (KNOWN_UNRESOLVED_REASONS.has(k) && typeof v === 'number' && Number.isFinite(v)) {
        reasonCounts[k] = v;
      }
    }
  }
  const viaHistogram = {};
  if (raw.viaHistogram && typeof raw.viaHistogram === 'object') {
    for (const k of Object.keys(raw.viaHistogram)) {
      const v = raw.viaHistogram[k];
      if (KNOWN_VIA_KINDS.has(k) && typeof v === 'number' && Number.isFinite(v)) {
        viaHistogram[k] = v;
      }
    }
  }

  return {
    schema: 1,
    engineCacheVersion: num(raw.engineCacheVersion),
    extensionVersion: typeof raw.extensionVersion === 'string' ? raw.extensionVersion : null,
    files: {
      apexTotal: num(files.apexTotal),
      apexParsed: num(files.apexParsed),
      apexCached: num(files.apexCached),
      apexUnreadable: num(files.apexUnreadable),
      metaTotal: num(files.metaTotal),
      metaRead: num(files.metaRead),
      metaCached: num(files.metaCached),
      metaUnreadable: num(files.metaUnreadable),
    },
    sweep: enumOrNull(raw.sweepKind, ['full', 'incremental', 'skipped']),
    workers: {
      // workerpool.js exposes `usedPool`; accept the older generic `used`
      // spelling too so the pure builder remains backwards compatible.
      used: boolOrNull(typeof workers.usedPool === 'boolean' ? workers.usedPool : workers.used),
      poolSize: num(workers.poolSize),
      chunksTotal: num(workers.chunksTotal),
      chunksViaWorker: num(workers.chunksViaWorker),
      chunksInlineFallback: num(workers.chunksInlineFallback),
      chunksCancelled: num(workers.chunksCancelled),
      workerErrors: num(workers.workerErrors),
    },
    timingMs: {
      glob: num(timingMs.glob),
      stat: num(timingMs.stat),
      parse: num(timingMs.parse),
      metascan: num(timingMs.metascan),
      index: num(timingMs.index),
      tree: num(timingMs.tree),
    },
    unresolvedByReason: reasonCounts,
    viaHistogram: viaHistogram,
    magnetSuppressedAttachments: num(raw.magnetSuppressedAttachments),
    showUnconfirmed: enumOrNull(raw.showUnconfirmed, ['rollup', 'hide', 'expand']),
    cancelled: boolOrNull(raw.cancelled),
  };
}

// Defensive self-check: throws if `payload` (as produced by
// buildDiagnosticsPayload, or anything shaped like it) contains any string
// value that is not one of the small fixed enum vocabularies this module
// knows about -- i.e. proof-by-construction that nothing name-shaped ever
// reaches the clipboard. extension.js's copyDiagnostics command calls this
// on the payload it is about to stringify, as a last-line-of-defense
// assertion (never trust "I built it correctly" alone for a hard privacy
// rule); test-scanflow.js exercises both the pass and fail cases directly.
const ALLOWED_ENUM_STRINGS = new Set(['full', 'incremental', 'skipped', 'rollup', 'hide', 'expand']);
// keyPaths whose own object KEYS (not just values) are constrained to a
// known vocabulary -- see KNOWN_UNRESOLVED_REASONS/KNOWN_VIA_KINDS above.
// Every other object in the payload has a FIXED, code-defined key set
// (buildDiagnosticsPayload always writes the same literal property names),
// so only these two dynamic, duck-typed maps need their keys checked here.
const KEY_VOCAB_BY_PATH = {
  unresolvedByReason: KNOWN_UNRESOLVED_REASONS,
  viaHistogram: KNOWN_VIA_KINDS,
};
function assertCountsOnly(payload) {
  const offenders = [];
  function walk(value, keyPath) {
    if (value === null || value === undefined) return;
    if (typeof value === 'number' || typeof value === 'boolean') return;
    if (typeof value === 'string') {
      // extensionVersion is the one deliberately free-form (but still
      // non-identifier) string field -- a semver-ish version string, never
      // a class/method/file/namespace name. Everything else must be one of
      // the fixed enum vocabularies.
      if (keyPath === 'extensionVersion') return;
      if (ALLOWED_ENUM_STRINGS.has(value)) return;
      offenders.push({ path: keyPath, value });
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((v, i) => walk(v, `${keyPath}[${i}]`));
      return;
    }
    if (typeof value === 'object') {
      const keyVocab = KEY_VOCAB_BY_PATH[keyPath];
      for (const k of Object.keys(value)) {
        if (keyVocab && !keyVocab.has(k)) {
          offenders.push({ path: keyPath, value: k, reason: 'key not in known vocabulary' });
          continue;
        }
        walk(value[k], keyPath ? `${keyPath}.${k}` : k);
      }
      return;
    }
    offenders.push({ path: keyPath, value });
  }
  walk(payload, '');
  if (offenders.length) {
    const err = new Error('assertCountsOnly: non-numeric/non-enum value(s) found: ' + JSON.stringify(offenders));
    err.offenders = offenders;
    throw err;
  }
  return true;
}

module.exports = {
  createScanFlow,
  interactiveRequestKey,
  createDirtyTracker,
  createWorkspaceFolderChangeHandler,
  normalizeExcludeGlobs,
  matchesExcludeGlobs,
  excludeGlobsFingerprint,
  createExcludeTracker,
  buildDiagnosticsPayload,
  assertCountsOnly,
};

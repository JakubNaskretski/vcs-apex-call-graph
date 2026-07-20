'use strict';
// test-scanflow.js -- self-check for scanflow.js (H5 single-flight/
// coalescing/one-pending-queue, H6 dirty tracker, H8 counts-only
// diagnostics payload builder). Plain `node test-scanflow.js`, same
// standalone convention as this repo's other test-*.js files.

const assert = require('assert');
const {
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
} = require('./scanflow');


// Small helper: a controllable "deferred" promise for driving scanFlow's
// workFn resolution order deterministically in tests.
function deferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function run() {
  // === H5: createScanFlow ==================================================

  // --- no in-flight run: workFn starts immediately, resolves normally -----
  {
    const flow = createScanFlow();
    let calls = 0;
    const p = flow.request('A', async () => {
      calls++;
      return 'result-A';
    });
    assert.strictEqual(flow.isBusy, true, 'a request with nothing in-flight starts immediately (isBusy true synchronously)');
    const result = await p;
    assert.strictEqual(result, 'result-A');
    assert.strictEqual(calls, 1);
    assert.strictEqual(flow.isBusy, false, 'busy flag clears once the run settles and nothing was queued');
  }

  // --- same-key coalescing: second request joins the SAME promise --------
  {
    const flow = createScanFlow();
    let calls = 0;
    const d = deferred();
    const p1 = flow.request('A', () => {
      calls++;
      return d.promise;
    });
    const p2 = flow.request('A', () => {
      calls++;
      return Promise.resolve('should-never-run');
    });
    assert.strictEqual(p1, p2, 'same-key request while in-flight returns the literal same Promise instance (no second run)');
    d.resolve('first-result');
    const [r1, r2] = await Promise.all([p1, p2]);
    assert.strictEqual(r1, 'first-result');
    assert.strictEqual(r2, 'first-result');
    assert.strictEqual(calls, 1, 'workFn for the SAME key must only ever run once while coalesced');
  }

  // --- different-key request queues (at most one pending slot) -----------
  {
    const flow = createScanFlow();
    const order = [];
    const dA = deferred();
    const pA = flow.request('A', () => {
      order.push('start-A');
      return dA.promise.then(() => 'result-A');
    });
    const pB = flow.request('B', () => {
      order.push('start-B');
      return Promise.resolve('result-B');
    });
    assert.strictEqual(flow.queuedKey, 'B', 'a different-key request while busy is queued, not started immediately');
    await Promise.resolve(); // let A's microtask-scheduled workFn actually start
    await Promise.resolve();
    assert.strictEqual(order.length, 1, 'the queued workFn has NOT run yet -- only A has started');
    dA.resolve();
    const [rA, rB] = await Promise.all([pA, pB]);
    assert.strictEqual(rA, 'result-A');
    assert.strictEqual(rB, 'result-B');
    assert.deepStrictEqual(order, ['start-A', 'start-B'], 'B only starts AFTER A settles -- one scan at a time, never concurrent');
    assert.strictEqual(flow.isBusy, false);
  }

  // --- latest-wins: a THIRD different key while A busy + B queued --------
  // supersedes B (B's own callers get { superseded: true }, B's workFn is
  // NEVER invoked), and C runs after A completes.
  {
    const flow = createScanFlow();
    const ran = [];
    const dA = deferred();
    const pA = flow.request('A', () => {
      ran.push('A');
      return dA.promise;
    });
    const pB = flow.request('B', () => {
      ran.push('B'); // must never actually run
      return Promise.resolve('result-B');
    });
    const pC = flow.request('C', () => {
      ran.push('C');
      return Promise.resolve('result-C');
    });
    assert.strictEqual(flow.queuedKey, 'C', 'C supersedes the previously-queued B -- only one pending slot, latest wins');
    dA.resolve('result-A');
    const [rA, rB, rC] = await Promise.all([pA, pB, pC]);
    assert.strictEqual(rA, 'result-A');
    assert.deepStrictEqual(rB, { superseded: true }, "B's caller resolves to a superseded sentinel instead of hanging forever");
    assert.strictEqual(rC, 'result-C');
    assert.deepStrictEqual(ran, ['A', 'C'], "B's workFn must NEVER be invoked -- it was superseded before it ever got to run");
  }

  // --- a second request for the SAME already-queued key joins the queue --
  {
    const flow = createScanFlow();
    let bRuns = 0;
    const dA = deferred();
    const pA = flow.request('A', () => dA.promise);
    const pB1 = flow.request('B', () => {
      bRuns++;
      return Promise.resolve('result-B');
    });
    const pB2 = flow.request('B', () => {
      bRuns++;
      return Promise.resolve('should-never-run-either');
    });
    dA.resolve();
    const [rB1, rB2] = await Promise.all([pB1, pB2]);
    assert.strictEqual(rB1, 'result-B');
    assert.strictEqual(rB2, 'result-B');
    assert.strictEqual(bRuns, 1, 'two same-key queued requests still only execute the queued workFn once');
  }

  // --- shared cancellation: all joiners observe the identical settlement -
  {
    const flow = createScanFlow();
    const d = deferred();
    const p1 = flow.request('A', () => d.promise);
    const p2 = flow.request('A', () => Promise.resolve('unused'));
    d.resolve({ cancelled: true }); // simulating a workFn that resolved early on cancellation
    const [r1, r2] = await Promise.all([p1, p2]);
    assert.deepStrictEqual(r1, { cancelled: true });
    assert.deepStrictEqual(r2, { cancelled: true }, 'a cancelled shared run settles identically for every joiner');
  }

  // --- rejection propagates to all joiners, and clears inflight ----------
  {
    const flow = createScanFlow();
    const d = deferred();
    const p1 = flow.request('A', () => d.promise);
    const p2 = flow.request('A', () => Promise.resolve('unused'));
    d.reject(new Error('boom'));
    await assert.rejects(p1, /boom/);
    await assert.rejects(p2, /boom/);
    assert.strictEqual(flow.isBusy, false, 'a rejected run still clears the busy/inflight state for the next request');
  }

  // --- interactive keys include the initiating document + cursor --------
  {
    const a = { uri: 'file:///workspace/AcmeOrder.cls', version: 7, line: 10, character: 4 };
    assert.strictEqual(
      interactiveRequestKey('callers', a),
      interactiveRequestKey('callers', { ...a }),
      'the same document version and cursor identity still coalesces'
    );
    assert.notStrictEqual(
      interactiveRequestKey('callers', a),
      interactiveRequestKey('callers', { ...a, line: 11 }),
      'different cursor targets never share a direction-only key'
    );
    assert.notStrictEqual(
      interactiveRequestKey('callers', a),
      interactiveRequestKey('callers', { ...a, version: 8 }),
      'an edit at the same cursor position creates a fresh request identity'
    );
    assert.notStrictEqual(
      interactiveRequestKey('callers', null, 1),
      interactiveRequestKey('callers', null, 2),
      'two no-editor QuickPick requests remain independent'
    );
  }

  // === H6: createDirtyTracker ==============================================

  // --- starts needing a full sweep (no prior scan to be incremental over) -
  {
    const t = createDirtyTracker();
    assert.strictEqual(t.isEmpty, false, 'fullSweepNeeded starts true -- never "empty" before the first scan');
    const snap0 = t.peek();
    assert.strictEqual(snap0.fullSweepNeeded, true);
    assert.strictEqual(snap0.dirty.size, 0);
    assert.strictEqual(snap0.deleted.size, 0);
  }

  // --- after a successful scan (snapshotAndReset), a quiet workspace is empty
  {
    const t = createDirtyTracker();
    const snap = t.snapshotAndReset();
    assert.strictEqual(snap.fullSweepNeeded, true, "the snapshot consumed by the FIRST scan still reports fullSweepNeeded true (it WAS a full sweep)");
    assert.strictEqual(t.isEmpty, true, 'after snapshotAndReset, a quiet tracker (no new events) reports isEmpty true');
  }

  // --- changed/created files land in dirty, deleted files in deleted -----
  {
    const t = createDirtyTracker();
    t.snapshotAndReset(); // consume the initial full-sweep-needed state
    t.markChanged('/ws/Foo.cls');
    t.markCreated('/ws/NewOne.cls');
    t.markDeleted('/ws/Gone.cls');
    assert.strictEqual(t.isEmpty, false);
    const snap = t.peek();
    assert.strictEqual(snap.fullSweepNeeded, false);
    assert.deepStrictEqual([...snap.dirty].sort(), ['/ws/Foo.cls', '/ws/NewOne.cls']);
    assert.deepStrictEqual([...snap.deleted], ['/ws/Gone.cls']);
  }

  // --- a delete-then-change (or change-then-delete) on the SAME path is ---
  // mutually exclusive in the final snapshot -- whichever happened LAST wins,
  // since a path cannot simultaneously be "reuse cached facts" and "purge
  // from cache".
  {
    const t = createDirtyTracker();
    t.snapshotAndReset();
    t.markChanged('/ws/Flip.cls');
    t.markDeleted('/ws/Flip.cls'); // deleted after being marked changed
    let snap = t.peek();
    assert.strictEqual(snap.dirty.has('/ws/Flip.cls'), false);
    assert.strictEqual(snap.deleted.has('/ws/Flip.cls'), true);

    t.markChanged('/ws/Flip.cls'); // re-created/changed after the delete
    snap = t.peek();
    assert.strictEqual(snap.dirty.has('/ws/Flip.cls'), true);
    assert.strictEqual(snap.deleted.has('/ws/Flip.cls'), false);
  }

  // --- watcher failure/overflow latches fullSweepNeeded until consumed ----
  {
    const t = createDirtyTracker();
    t.snapshotAndReset();
    t.markChanged('/ws/Foo.cls');
    t.markFullSweepNeeded(); // simulating a watcher error/overflow event
    assert.strictEqual(t.isEmpty, false, 'fullSweepNeeded latched -> never reports isEmpty, regardless of dirty-set size');
    const snap = t.snapshotAndReset();
    assert.strictEqual(snap.fullSweepNeeded, true, 'the consuming scan sees fullSweepNeeded true and must do a full sweep');
    assert.strictEqual(t.isEmpty, true, 'once consumed (and no new events since), the tracker is clean again');
  }

  // --- snapshotAndReset is atomic: events after the snapshot are NOT lost -
  {
    const t = createDirtyTracker();
    t.snapshotAndReset();
    t.markChanged('/ws/Old.cls');
    const snap1 = t.snapshotAndReset();
    assert.deepStrictEqual([...snap1.dirty], ['/ws/Old.cls']);
    t.markChanged('/ws/New.cls'); // arrives AFTER snap1 was taken
    const snap2 = t.peek();
    assert.deepStrictEqual([...snap2.dirty], ['/ws/New.cls'], 'a later event is not conflated with an already-consumed snapshot');
  }

  // --- consume() clears only the paths a completed scan accounted for, ---
  // never a mid-scan arrival for a DIFFERENT path.
  {
    const t = createDirtyTracker();
    t.snapshotAndReset();
    t.markChanged('/ws/A.cls');
    t.markChanged('/ws/B.cls');
    t.markDeleted('/ws/C.cls');
    const snap = t.peek(); // what a scan starting now would act on
    // Simulate a watcher event landing WHILE the scan (using `snap`) is
    // still running, for a path NOT in `snap` at all.
    t.markChanged('/ws/D.cls');
    t.consume(snap.dirty, snap.deleted); // the scan finishes, consumes exactly what it saw
    const after = t.peek();
    assert.deepStrictEqual([...after.dirty], ['/ws/D.cls'], 'a mid-scan arrival for a path outside the consumed snapshot survives');
    assert.strictEqual(after.deleted.size, 0, 'the deleted path from the snapshot was consumed');
  }

  // --- a second event for the SAME path during a scan survives -----------
  {
    const t = createDirtyTracker();
    t.snapshotAndReset();
    t.markChanged('/ws/A.cls');
    const snap = t.peek();
    t.markChanged('/ws/A.cls'); // a later save while the first is being scanned
    t.consume(snap);
    assert.deepStrictEqual(
      [...t.peek().dirty],
      ['/ws/A.cls'],
      'generation-aware consume never clears a same-path event newer than the scan snapshot'
    );
  }

  // --- consume() does not clear fullSweepNeeded; only markSweepDone() does
  {
    const t = createDirtyTracker();
    t.markFullSweepNeeded(); // starts true anyway, but be explicit
    t.consume(new Set(), new Set());
    assert.strictEqual(t.peek().fullSweepNeeded, true, 'consume() alone never clears the fullSweepNeeded latch');
    t.markSweepDone();
    assert.strictEqual(t.peek().fullSweepNeeded, false, 'markSweepDone() clears it once an actual full sweep has completed');
  }

  // --- invalidation during a full sweep survives that sweep's completion
  {
    const t = createDirtyTracker();
    const inFlightSnapshot = t.peek();
    t.markFullSweepNeeded(); // e.g. workspace-folder membership changed mid-scan
    t.markSweepDone(inFlightSnapshot);
    assert.strictEqual(
      t.peek().fullSweepNeeded,
      true,
      'a newer invalidation is never cleared by an older in-flight full sweep'
    );
    const nextSnapshot = t.peek();
    t.markSweepDone(nextSnapshot);
    assert.strictEqual(t.peek().fullSweepNeeded, false, 'the full sweep started after that invalidation may clear it');
  }

  // --- workspace additions and removals both invalidate the path inventory
  {
    let invalidations = 0;
    const onWorkspaceFoldersChanged = createWorkspaceFolderChangeHandler(() => invalidations++);
    onWorkspaceFoldersChanged({ added: [], removed: [] });
    assert.strictEqual(invalidations, 0, 'an empty/malformed notification is inert');
    onWorkspaceFoldersChanged({ added: [{ name: 'added' }], removed: [] });
    assert.strictEqual(invalidations, 1, 'adding a workspace folder forces the next full sweep');
    onWorkspaceFoldersChanged({ added: [], removed: [{ name: 'removed' }] });
    assert.strictEqual(invalidations, 2, 'removing a workspace folder forces the next full sweep');
    onWorkspaceFoldersChanged({ added: [{ name: 'replacement' }], removed: [{ name: 'old' }] });
    assert.strictEqual(invalidations, 3, 'a replacement event invalidates once even when it includes both arrays');
    assert.throws(
      () => createWorkspaceFolderChangeHandler(null),
      /invalidation callback/,
      'invalid wiring fails during activation instead of silently skipping invalidation'
    );
  }

  // --- watcher setup failure remains permanent across successful sweeps --
  {
    const t = createDirtyTracker();
    t.markWatcherUnavailable();
    assert.strictEqual(t.peek().fullSweepNeeded, true);
    t.markSweepDone();
    assert.strictEqual(
      t.peek().fullSweepNeeded,
      true,
      'a completed fallback sweep cannot make a missing watcher trustworthy'
    );
    t.consume(t.peek());
    t.markSweepDone();
    assert.strictEqual(t.peek().fullSweepNeeded, true, 'every later scan is still forced full');
    assert.strictEqual(t.isEmpty, false, 'persistent watcher failure never advertises a clean incremental state');
  }

  // --- incremental user-exclude matching mirrors workspace-relative globs
  {
    const globs = [' **/generated/** ', '**/*.{test,spec}.cls', 'scripts/?.apex'];
    assert.deepStrictEqual(
      normalizeExcludeGlobs(globs),
      ['**/*.{test,spec}.cls', '**/generated/**', 'scripts/?.apex'],
      'exclude globs are trimmed and canonicalized'
    );
    assert.strictEqual(matchesExcludeGlobs('force-app/generated/Foo.cls', globs), true);
    assert.strictEqual(matchesExcludeGlobs('generated/Foo.cls', globs), true, '**/ matches zero leading directories');
    assert.strictEqual(matchesExcludeGlobs('force-app/classes/Order.test.cls', globs), true, 'brace alternatives match');
    assert.strictEqual(matchesExcludeGlobs('scripts/a.apex', globs), true, 'question mark matches one path character');
    assert.strictEqual(matchesExcludeGlobs('scripts/deep/a.apex', globs), false, 'single-star/question patterns never cross directories');
    assert.strictEqual(matchesExcludeGlobs('../outside/Foo.cls', ['**/*.cls']), false, 'paths outside the workspace never match');
    assert.doesNotThrow(
      () => matchesExcludeGlobs('force-app/Foo.cls', ['[z-a].cls']),
      'a malformed hand-edited glob never breaks incremental scanning'
    );
  }

  // --- exclude policy changes force exactly the next successful full scan
  {
    const tracker = createExcludeTracker();
    assert.strictEqual(tracker.requiresFullSweep([]), false, 'the initial dirty-tracker sweep already covers first settings');
    tracker.commit(['**/generated/**', '**/*.spec.cls']);
    assert.strictEqual(tracker.requiresFullSweep(['**/*.spec.cls', '**/generated/**']), false, 'order-only changes are equivalent');
    assert.strictEqual(
      excludeGlobsFingerprint(['**/generated/**', '**/generated/**']),
      excludeGlobsFingerprint(['**/generated/**']),
      'duplicate patterns do not change the policy fingerprint'
    );
    assert.strictEqual(tracker.requiresFullSweep(['**/generated/**']), true, 'a real policy change invalidates cached path sets');
    tracker.commit(['**/generated/**']);
    assert.strictEqual(tracker.requiresFullSweep(['**/generated/**']), false, 'a successful full sweep commits the new policy');
  }

  // === H8: buildDiagnosticsPayload / assertCountsOnly ======================

  // --- empty/undefined input still produces a valid, all-zero payload ----
  {
    const payload = buildDiagnosticsPayload();
    assert.strictEqual(payload.schema, 1);
    assert.strictEqual(payload.files.apexTotal, 0);
    assert.strictEqual(payload.sweep, null);
    assert.strictEqual(payload.showUnconfirmed, null);
    assert.doesNotThrow(() => assertCountsOnly(payload), 'a default/empty payload must pass the counts-only assertion');
  }

  // --- a fully populated, well-formed payload passes assertCountsOnly -----
  {
    const raw = {
      engineCacheVersion: 7,
      extensionVersion: '0.13.0',
      files: { apexTotal: 260, apexParsed: 21, apexCached: 239, apexUnreadable: 0, metaTotal: 40, metaRead: 2, metaCached: 38, metaUnreadable: 0 },
      sweepKind: 'incremental',
      workers: { usedPool: true, poolSize: 4, chunksTotal: 4, chunksViaWorker: 4, chunksInlineFallback: 0, chunksCancelled: 0, workerErrors: 0 },
      timingMs: { glob: 12, stat: 8, parse: 340, metascan: 15, index: 22, tree: 4 },
      unresolvedByReason: { 'unknown-receiver': 12, 'deep-chain': 3, 'name-too-common': 30 },
      viaHistogram: { static: 100, interface: 4, 'unique-name': 2, metadata: 3, subflow: 1 },
      magnetSuppressedAttachments: 40,
      showUnconfirmed: 'rollup',
      cancelled: false,
    };
    const payload = buildDiagnosticsPayload(raw);
    assert.strictEqual(payload.sweep, 'incremental');
    assert.strictEqual(payload.showUnconfirmed, 'rollup');
    assert.strictEqual(payload.workers.used, true, 'workerpool.js usedPool spelling reaches diagnostics as a boolean');
    assert.strictEqual(payload.unresolvedByReason['unknown-receiver'], 12);
    assert.strictEqual(payload.viaHistogram.static, 100);
    assert.strictEqual(payload.viaHistogram['unique-name'], 2);
    assert.strictEqual(payload.viaHistogram.metadata, 3);
    assert.strictEqual(payload.magnetSuppressedAttachments, 40);
    assert.doesNotThrow(() => assertCountsOnly(payload));
  }

  // --- garbage/name-shaped input is coerced away, never passed through ----
  {
    const raw = {
      files: { apexTotal: 'VertexPricingService' }, // a name where a number belongs
      sweepKind: 'AcmeCorpSweep', // not one of the fixed enum values
      unresolvedByReason: { 'VertexBindTarget.bind': 12 }, // a real-looking key -- must be DROPPED entirely, not merged in
      showUnconfirmed: 'definitely-not-an-enum-value',
    };
    const payload = buildDiagnosticsPayload(raw);
    assert.strictEqual(payload.files.apexTotal, 0, 'a non-numeric value is coerced to 0, never passed through as a string');
    assert.strictEqual(payload.sweep, null, 'an out-of-vocabulary enum string is coerced to null, never passed through raw');
    assert.strictEqual(payload.showUnconfirmed, null);
    assert.deepStrictEqual(
      payload.unresolvedByReason,
      {},
      'a reason KEY outside the known vocabulary is dropped entirely by buildDiagnosticsPayload, never merged in as-is'
    );
    assert.doesNotThrow(() => assertCountsOnly(payload), 'buildDiagnosticsPayload already scrubbed the bad key -- the resulting payload is clean');
  }

  // --- assertCountsOnly independently rejects an out-of-vocabulary KEY ----
  // (a defense-in-depth check on a HAND-CRAFTED payload that bypasses
  // buildDiagnosticsPayload's own filtering -- proves the assertion itself
  // inspects nested object KEYS, not just values, rather than relying
  // solely on buildDiagnosticsPayload having done its job correctly).
  {
    const handCrafted = { unresolvedByReason: { 'VertexBindTarget.bind': 12 } };
    assert.throws(() => assertCountsOnly(handCrafted), /non-numeric\/non-enum/, 'a name-shaped object KEY must fail the counts-only assertion');
    const handCraftedVia = { viaHistogram: { AcmeCorpCustomVia: 3 } };
    assert.throws(() => assertCountsOnly(handCraftedVia), /non-numeric\/non-enum/, 'an out-of-vocabulary via-kind key must also fail');
  }

  // --- assertCountsOnly rejects a hand-crafted payload with a name value --
  {
    const bad = { files: { apexTotal: 5 }, note: 'AcmeCorp leaked a name here' };
    assert.throws(() => assertCountsOnly(bad), /non-numeric\/non-enum/);
  }

  console.log('apex-call-graph scanflow.js self-check: all assertions passed');
}

run().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});

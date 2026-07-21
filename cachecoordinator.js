'use strict';

// Coordinates the three asynchronous users of the extension cache:
// workspace scans, debounced persistence, and an explicit cache reset.
// The module is deliberately VS Code-independent so the ordering guarantees
// can be exercised with deferred promises in a normal Node test.
function createCacheCoordinator() {
  let epoch = 0;
  let persistTail = Promise.resolve();
  let resetTail = Promise.resolve();
  const activeOperations = new Set();

  function currentEpoch() {
    return epoch;
  }

  function isCurrent(capturedEpoch) {
    return capturedEpoch === epoch;
  }

  function registerOperation() {
    let finish;
    const done = new Promise((resolve) => { finish = resolve; });
    activeOperations.add(done);
    let ended = false;
    return {
      epoch,
      end() {
        if (ended) return;
        ended = true;
        activeOperations.delete(done);
        finish();
      },
    };
  }

  // Waiting and registering must be one atomic protocol. An `await` always
  // yields, even for an already-resolved promise; reset() can replace
  // resetTail during that yield. Recheck the exact tail after every wait and
  // register synchronously only when it is still current.
  async function beginOperationAfterReset() {
    while (true) {
      const observedReset = resetTail;
      await observedReset;
      if (observedReset !== resetTail) continue;
      return registerOperation();
    }
  }

  // Persistence is serialized. A job whose epoch was invalidated before it
  // starts is skipped; a job already in flight is allowed to finish, and a
  // following reset waits for it before deleting the resulting file.
  function enqueuePersist(capturedEpoch, work) {
    const run = persistTail
      .catch(() => undefined)
      .then(async () => {
        if (!isCurrent(capturedEpoch)) return { skipped: true };
        await work();
        return { skipped: false };
      });
    // One failed best-effort write must not poison later writes or resets.
    persistTail = run.catch(() => undefined);
    return run;
  }

  // Invalidate synchronously, then wait for older reset/persist/scan work.
  // New scans observe resetTail and cannot begin until `work` completes.
  function reset(work) {
    epoch += 1;
    const priorReset = resetTail;
    const priorPersist = persistTail;
    const blockers = [...activeOperations];
    const run = (async () => {
      await Promise.allSettled([priorReset, priorPersist, ...blockers]);
      return work();
    })();
    resetTail = run.then(() => undefined, () => undefined);
    return run;
  }

  return {
    currentEpoch,
    isCurrent,
    beginOperationAfterReset,
    enqueuePersist,
    reset,
  };
}

module.exports = { createCacheCoordinator };

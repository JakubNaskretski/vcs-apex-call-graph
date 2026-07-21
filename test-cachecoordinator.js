'use strict';

const assert = require('assert');
const { createCacheCoordinator } = require('./cachecoordinator');

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function flushMicrotasks() {
  await Promise.resolve();
  await Promise.resolve();
}

async function run() {
  // An in-flight write finishes before reset cleanup, so even a late write is
  // deleted rather than landing after Clear Cache reports success.
  {
    const coordinator = createCacheCoordinator();
    const write = deferred();
    const order = [];
    const persist = coordinator.enqueuePersist(0, async () => {
      order.push('write-start');
      await write.promise;
      order.push('write-end');
    });
    await flushMicrotasks();
    const reset = coordinator.reset(async () => { order.push('cleanup'); });
    await flushMicrotasks();
    assert.deepStrictEqual(order, ['write-start'], 'cleanup waits while the write is in flight');
    write.resolve();
    await Promise.all([persist, reset]);
    assert.deepStrictEqual(order, ['write-start', 'write-end', 'cleanup']);
  }

  // A queued old-epoch write never starts after reset invalidation.
  {
    const coordinator = createCacheCoordinator();
    const first = deferred();
    let staleWrites = 0;
    const p1 = coordinator.enqueuePersist(0, () => first.promise);
    await flushMicrotasks();
    const p2 = coordinator.enqueuePersist(0, async () => { staleWrites++; });
    const reset = coordinator.reset(async () => undefined);
    first.resolve();
    const [, staleResult] = await Promise.all([p1, p2, reset]);
    assert.strictEqual(staleWrites, 0);
    assert.deepStrictEqual(staleResult, { skipped: true });
  }

  // Reset waits for a scan active at invalidation time, while later scans
  // wait behind resetTail and capture the new epoch only after cleanup.
  {
    const coordinator = createCacheCoordinator();
    const oldScan = await coordinator.beginOperationAfterReset();
    const order = [];
    const reset = coordinator.reset(async () => { order.push('cleanup'); });
    let newScanStarted = false;
    const newScan = (async () => {
      const operation = await coordinator.beginOperationAfterReset();
      newScanStarted = true;
      assert.strictEqual(operation.epoch, 1);
      operation.end();
    })();
    await flushMicrotasks();
    assert.strictEqual(coordinator.isCurrent(oldScan.epoch), false);
    assert.strictEqual(newScanStarted, false);
    assert.deepStrictEqual(order, []);
    oldScan.end();
    await Promise.all([reset, newScan]);
    assert.deepStrictEqual(order, ['cleanup']);
    assert.strictEqual(newScanStarted, true);
  }

  // Exact same-tick TOCTOU regression: beginOperationAfterReset() first
  // observes an already-resolved tail and yields; reset() then replaces that
  // tail before the continuation registers. The operation must re-wait for
  // cleanup instead of starting inside it.
  {
    const coordinator = createCacheCoordinator();
    const cleanup = deferred();
    let operationStarted = false;
    const startingOperation = coordinator.beginOperationAfterReset().then((operation) => {
      operationStarted = true;
      return operation;
    });
    let cleanupStarted = false;
    const reset = coordinator.reset(async () => {
      cleanupStarted = true;
      await cleanup.promise;
    });
    await flushMicrotasks();
    assert.strictEqual(cleanupStarted, true);
    assert.strictEqual(operationStarted, false, 'operation rechecks the replaced reset tail before registering');
    cleanup.resolve();
    await reset;
    const operation = await startingOperation;
    assert.strictEqual(operation.epoch, 1);
    operation.end();
  }

  // Failed best-effort persistence does not poison reset or the next write.
  {
    const coordinator = createCacheCoordinator();
    await assert.rejects(coordinator.enqueuePersist(0, async () => { throw new Error('write failed'); }));
    let cleaned = false;
    await coordinator.reset(async () => { cleaned = true; });
    assert.strictEqual(cleaned, true);
    let wrote = false;
    await coordinator.enqueuePersist(1, async () => { wrote = true; });
    assert.strictEqual(wrote, true);
  }

  console.log('apex-call-graph cachecoordinator.js self-check: all assertions passed');
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

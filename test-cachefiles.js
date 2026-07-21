'use strict';

const assert = require('assert');
const { cleanupCacheFiles, persistSafeFactsCache } = require('./cachefiles');

const storageUri = { path: '/storage' };
const uriApi = {
  joinPath(base, name) { return { path: `${base.path}/${name}` }; },
};

function fakeFs(files, opts) {
  opts = opts || {};
  const state = new Map(Object.entries(files));
  const deleted = [];
  const deleteAttempts = new Map();
  const writes = [];
  let readAttempts = 0;
  return {
    state,
    deleted,
    deleteAttempts,
    writes,
    api: {
      async readDirectory() {
        readAttempts++;
        if (opts.readFailures && readAttempts <= opts.readFailures) {
          const error = new Error('storage unavailable');
          error.code = opts.readErrorCode || 'EIO';
          throw error;
        }
        return [...state.keys()].map((name) => [name, 1]);
      },
      async stat(uri) {
        const name = uri.path.split('/').pop();
        if (opts.statErrors && opts.statErrors.has(name)) throw new Error('stat failed');
        const value = state.get(name);
        if (!value) throw new Error('missing');
        return { mtime: value.mtime };
      },
      async delete(uri) {
        const name = uri.path.split('/').pop();
        const attempts = (deleteAttempts.get(name) || 0) + 1;
        deleteAttempts.set(name, attempts);
        const failures = opts.deleteFailures && opts.deleteFailures.get(name);
        if (failures && attempts <= failures) throw new Error('delete failed');
        state.delete(name);
        deleted.push(name);
      },
      async createDirectory() {},
      async writeFile(uri, bytes) {
        writes.push({ uri, text: Buffer.from(bytes).toString('utf8') });
      },
    },
  };
}

async function run() {
  const legacyFacts = 'facts-0123456789abcdef.json';
  const legacyMeta = 'meta-fedcba9876543210.json';
  const sourceBearingV8 = 'facts-v8-0000000000000008.json';
  const oldSafe = 'facts-v9-1111111111111111.json';
  const freshSafe = 'facts-v9-2222222222222222.json';
  const unreadableSafe = 'facts-v9-3333333333333333.json';
  const unrelated = 'settings.json';
  const fs1 = fakeFs(
    {
      [legacyFacts]: { mtime: 9_900 },
      [legacyMeta]: { mtime: 9_900 },
      [sourceBearingV8]: { mtime: 9_900 },
      [oldSafe]: { mtime: 8_000 },
      [freshSafe]: { mtime: 9_500 },
      [unreadableSafe]: { mtime: 1 },
      [unrelated]: { mtime: 1 },
    },
    { statErrors: new Set([legacyMeta, unreadableSafe]) }
  );
  const report = await cleanupCacheFiles(fs1.api, uriApi, storageUri, {
    nowMs: 10_000,
    retentionMs: 1_000,
  });
  assert.deepStrictEqual(report, { removed: 4, failed: 0, inspectionFailed: false });
  assert.deepStrictEqual(fs1.deleted.sort(), [legacyFacts, legacyMeta, sourceBearingV8, oldSafe].sort());
  assert.ok(fs1.state.has(freshSafe), 'fresh safe facts cache is retained');
  assert.ok(fs1.state.has(unreadableSafe), 'safe cache with unknown age is retained rather than guessed stale');
  assert.ok(fs1.state.has(unrelated), 'unrelated global-storage file is untouched');

  const fs2 = fakeFs({
    [legacyFacts]: { mtime: 1 },
    [oldSafe]: { mtime: 1 },
    [freshSafe]: { mtime: 1 },
    [unrelated]: { mtime: 1 },
  });
  assert.deepStrictEqual(
    await cleanupCacheFiles(fs2.api, uriApi, storageUri, { clearAll: true, retentionMs: 1_000 }),
    { removed: 3, failed: 0, inspectionFailed: false }
  );
  assert.deepStrictEqual([...fs2.state.keys()], [unrelated]);

  const fs3 = fakeFs({}, { readFailures: 1, readErrorCode: 'FileNotFound' });
  assert.deepStrictEqual(
    await cleanupCacheFiles(fs3.api, uriApi, storageUri, { retentionMs: 1_000 }),
    { removed: 0, failed: 0, inspectionFailed: false },
    'a missing global-storage directory is a clean no-op'
  );

  const fs4 = fakeFs(
    { [legacyFacts]: { mtime: 1 }, [oldSafe]: { mtime: 1 } },
    { deleteFailures: new Map([[legacyFacts, Infinity]]) }
  );
  assert.deepStrictEqual(
    await cleanupCacheFiles(fs4.api, uriApi, storageUri, { clearAll: true, retentionMs: 1_000 }),
    { removed: 1, failed: 1, inspectionFailed: false },
    'a permanent failure is reported without preventing remaining cleanup'
  );
  assert.strictEqual(fs4.deleteAttempts.get(legacyFacts), 2, 'a failed legacy deletion is retried once');

  const fs5 = fakeFs(
    { [legacyFacts]: { mtime: 1 } },
    { deleteFailures: new Map([[legacyFacts, 1]]) }
  );
  assert.deepStrictEqual(
    await cleanupCacheFiles(fs5.api, uriApi, storageUri, { clearAll: true, retentionMs: 1_000 }),
    { removed: 1, failed: 0, inspectionFailed: false },
    'a transient first-delete failure succeeds on retry'
  );

  // Exercise the actual I/O boundary, not only the pure filter: neither raw
  // parse-error Apex source nor metadata-shaped text reaches written bytes.
  const fs6 = fakeFs({});
  const factsUri = { path: '/storage/facts-v9-4444444444444444.json' };
  const fileCache = new Map([
    ['/ws/Clean.cls', { mtimeMs: 1, size: 10, facts: { path: '/ws/Clean.cls', parseError: null, types: [] } }],
    ['/ws/Broken.cls', { mtimeMs: 2, size: 11, facts: { parseError: 'bad syntax', text: 'RAW_APEX_SENTINEL' } }],
    ['/ws/Metadata.js', { mtimeMs: 3, size: 12, metaText: 'RAW_METADATA_SENTINEL' }],
  ]);
  assert.strictEqual(await persistSafeFactsCache(fs6.api, storageUri, factsUri, 9, fileCache), true);
  assert.strictEqual(fs6.writes.length, 1);
  assert.ok(!fs6.writes[0].text.includes('RAW_APEX_SENTINEL'));
  assert.ok(!fs6.writes[0].text.includes('RAW_METADATA_SENTINEL'));
  assert.deepStrictEqual(JSON.parse(fs6.writes[0].text).entries.map((entry) => entry.fsPath), ['/ws/Clean.cls']);

  const fs7 = fakeFs({ [legacyFacts]: { mtime: 1 } }, { readFailures: Infinity, readErrorCode: 'EACCES' });
  assert.deepStrictEqual(
    await cleanupCacheFiles(fs7.api, uriApi, storageUri, { clearAll: true, retentionMs: 1_000 }),
    { removed: 0, failed: 0, inspectionFailed: true },
    'a permission/provider failure is reported rather than mistaken for empty storage'
  );
  assert.ok(fs7.state.has(legacyFacts), 'an uninspected legacy file is not falsely reported as deleted');

  const fs8 = fakeFs({ [legacyFacts]: { mtime: 1 } }, { readFailures: 1, readErrorCode: 'EIO' });
  assert.deepStrictEqual(
    await cleanupCacheFiles(fs8.api, uriApi, storageUri, { clearAll: true, retentionMs: 1_000 }),
    { removed: 1, failed: 0, inspectionFailed: false },
    'a transient directory-read failure is retried once and then cleaned'
  );

  console.log('apex-call-graph cachefiles.js self-check: all assertions passed');
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

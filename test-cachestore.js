'use strict';
// Self-check for cachestore.js (F6): node test-cachestore.js
// Pure data-in/data-out — no vscode, no fs. Every assertion here works
// against serialize()/deserialize()/mapToEntries()/entriesToMap() directly.
const assert = require('assert');
const parser = require('./parser');
const {
  serialize,
  deserialize,
  mapToEntries,
  entriesToMap,
  safeFactsEntries,
  containsSourceFragments,
  serializeSafeFactsCache,
  cacheFileKind,
  shouldDeleteCacheFile,
} = require('./cachestore');

// This local constant is independent test scaffolding, decoupled from
// extension.js's real ENGINE_CACHE_VERSION (which extension.js owns and
// bumps to 6 as part of H6(b) -- out of scope here). cachestore.js's
// deserialize() takes `expectedEngineVersion` as a plain parameter and does
// a strict-equality check against whatever the caller passes -- it has no
// opinion on what the "real" number is, so any value exercises the same
// code path. Test 22 below additionally exercises the literal value 6 to
// make that version-number-agnosticism explicit.
const ENGINE_VERSION = 4;

// ===========================================================================
// serialize / deserialize round-trip
// ===========================================================================

// 1. Basic round-trip: facts-shaped entries survive serialize -> deserialize
// with the exact same values (deep equality), for the current engine version.
// H6(b): every entry now also carries `size`.
{
  const payload = {
    engineVersion: ENGINE_VERSION,
    entries: [
      { fsPath: '/ws/AcmeOrderService.cls', mtimeMs: 1700000000123, size: 4096, facts: { path: '/ws/AcmeOrderService.cls', kind: 'class', parseError: null, types: [] } },
      { fsPath: '/ws/AcmeOrderTrigger.trigger', mtimeMs: 1700000000456, size: 2048, facts: { path: '/ws/AcmeOrderTrigger.trigger', kind: 'trigger', parseError: null, types: [] } },
    ],
  };
  const text = serialize(payload);
  assert.strictEqual(typeof text, 'string');
  assert.ok(text.length > 0);
  const roundtripped = deserialize(text, ENGINE_VERSION);
  assert.deepStrictEqual(roundtripped, payload, 'facts payload (incl. size) round-trips exactly');
}

// 3. Empty entries array round-trips to an empty array, not null/undefined.
{
  const payload = { engineVersion: ENGINE_VERSION, entries: [] };
  const roundtripped = deserialize(serialize(payload), ENGINE_VERSION);
  assert.deepStrictEqual(roundtripped, payload);
}

// ===========================================================================
// Version-mismatch handling — must return null, never throw, never partially trust
// ===========================================================================

// 4. Stored engineVersion older than expected -> null (whole cache invalidated).
{
  const stale = serialize({ engineVersion: 3, entries: [{ fsPath: '/ws/A.cls', mtimeMs: 1, facts: {} }] });
  assert.strictEqual(deserialize(stale, ENGINE_VERSION), null, 'older engineVersion must invalidate the whole cache');
}

// 5. Stored engineVersion newer than expected (e.g. rolled back to an older
// extension build) -> also null, not "compatible enough".
{
  const fromFuture = serialize({ engineVersion: 99, entries: [{ fsPath: '/ws/A.cls', mtimeMs: 1, facts: {} }] });
  assert.strictEqual(deserialize(fromFuture, ENGINE_VERSION), null, 'newer engineVersion must also invalidate (strict equality, not >=)');
}

// 6. engineVersion present but wrong TYPE (string instead of number) -> null.
{
  const badType = JSON.stringify({ engineVersion: '4', entries: [] });
  assert.strictEqual(deserialize(badType, ENGINE_VERSION), null, 'non-numeric engineVersion must be rejected even if it stringifies to the right value');
}

// 7. engineVersion missing entirely -> null.
{
  const noVersion = JSON.stringify({ entries: [] });
  assert.strictEqual(deserialize(noVersion, ENGINE_VERSION), null);
}

// ===========================================================================
// Corruption handling — must return null, never throw
// ===========================================================================

// 8. Truncated / syntactically invalid JSON.
{
  assert.doesNotThrow(() => deserialize('{ "engineVersion": 4, "entries": [', ENGINE_VERSION));
  assert.strictEqual(deserialize('{ "engineVersion": 4, "entries": [', ENGINE_VERSION), null);
  assert.strictEqual(deserialize('not json at all', ENGINE_VERSION), null);
  assert.strictEqual(deserialize('', ENGINE_VERSION), null);
  assert.strictEqual(deserialize(undefined, ENGINE_VERSION), null);
  assert.strictEqual(deserialize(null, ENGINE_VERSION), null);
}

// 9. Valid JSON but the wrong top-level shape (array, primitive, or an
// object missing `entries`) -> null.
{
  assert.strictEqual(deserialize('[]', ENGINE_VERSION), null, 'top-level array is not a CachePayload');
  assert.strictEqual(deserialize('42', ENGINE_VERSION), null, 'top-level number is not a CachePayload');
  assert.strictEqual(deserialize('"hello"', ENGINE_VERSION), null, 'top-level string is not a CachePayload');
  assert.strictEqual(deserialize('null', ENGINE_VERSION), null, 'JSON null is not a CachePayload');
  assert.strictEqual(deserialize(JSON.stringify({ engineVersion: ENGINE_VERSION }), ENGINE_VERSION), null, 'missing entries array');
  assert.strictEqual(
    deserialize(JSON.stringify({ engineVersion: ENGINE_VERSION, entries: 'not-an-array' }), ENGINE_VERSION),
    null,
    'entries must be an array'
  );
}

// 10. A completely unrelated JSON document (e.g. a package.json-shaped file
// living at the same path by accident) never throws and yields null.
{
  const unrelated = JSON.stringify({ name: 'apex-trace', version: '0.3.0', dependencies: {} });
  assert.doesNotThrow(() => deserialize(unrelated, ENGINE_VERSION));
  assert.strictEqual(deserialize(unrelated, ENGINE_VERSION), null);
}

// 11. Individual malformed entries are dropped, not fatal to the whole file:
// missing fsPath, non-finite mtimeMs, missing/malformed size (H6(b)), and a
// well-formed sibling all coexist.
{
  const text = JSON.stringify({
    engineVersion: ENGINE_VERSION,
    entries: [
      { fsPath: '/ws/Good.cls', mtimeMs: 100, size: 512, facts: { ok: true } },
      { mtimeMs: 200, size: 512, facts: { ok: false } }, // missing fsPath
      { fsPath: '/ws/Bad.cls', mtimeMs: 'not-a-number', size: 512, facts: {} }, // bad mtimeMs
      { fsPath: '', mtimeMs: 300, size: 512, facts: {} }, // empty fsPath
      { fsPath: '/ws/NaN.cls', mtimeMs: NaN, size: 512, facts: {} }, // NaN survives JSON as null, still invalid
      { fsPath: '/ws/NoSize.cls', mtimeMs: 100, facts: {} }, // missing size
      { fsPath: '/ws/StringSize.cls', mtimeMs: 100, size: '512', facts: {} }, // wrong type
      { fsPath: '/ws/NegativeSize.cls', mtimeMs: 100, size: -1, facts: {} }, // negative -- never a real file size
      null,
      'not-an-object',
      42,
    ],
  });
  const result = deserialize(text, ENGINE_VERSION);
  assert.ok(result, 'payload with some malformed entries is still a valid cache, not null');
  assert.strictEqual(result.entries.length, 1, 'only the one well-formed entry survives');
  assert.strictEqual(result.entries[0].fsPath, '/ws/Good.cls');
}

// 11b. H6(b) size validation, isolated: size is required exactly like
// mtimeMs is -- missing, wrong-typed, NaN/Infinity (which JSON round-trips
// as `null`), or negative all drop the entry; zero is a legitimate size
// (an empty file) and must survive.
{
  const text = JSON.stringify({
    engineVersion: ENGINE_VERSION,
    entries: [
      { fsPath: '/ws/Good.cls', mtimeMs: 100, size: 512, facts: {} },
      { fsPath: '/ws/EmptyFile.cls', mtimeMs: 100, size: 0, facts: {} }, // 0 is valid (empty file)
      { fsPath: '/ws/NoSize.cls', mtimeMs: 100, facts: {} },
      { fsPath: '/ws/StringSize.cls', mtimeMs: 100, size: '512', facts: {} },
      { fsPath: '/ws/NaNSize.cls', mtimeMs: 100, size: NaN, facts: {} },
      { fsPath: '/ws/InfiniteSize.cls', mtimeMs: 100, size: Infinity, facts: {} },
      { fsPath: '/ws/NegativeSize.cls', mtimeMs: 100, size: -1, facts: {} },
    ],
  });
  const result = deserialize(text, ENGINE_VERSION);
  assert.ok(result);
  assert.strictEqual(result.entries.length, 2, 'only Good.cls and EmptyFile.cls (size 0) survive');
  assert.deepStrictEqual(
    result.entries.map((e) => e.fsPath).sort(),
    ['/ws/EmptyFile.cls', '/ws/Good.cls']
  );
}

// ===========================================================================
// serialize(): defensive on bad input, never throws
// ===========================================================================

// 12. Non-object / missing-engineVersion payloads degrade to ''.
{
  assert.doesNotThrow(() => serialize(undefined));
  assert.strictEqual(serialize(undefined), '');
  assert.strictEqual(serialize(null), '');
  assert.strictEqual(serialize('not an object'), '');
  assert.strictEqual(serialize(42), '');
  assert.strictEqual(serialize([]), '', 'a bare array is not a CachePayload (Array.isArray excluded by isPlainObject)');
  assert.strictEqual(serialize({}), '', 'missing engineVersion');
  assert.strictEqual(serialize({ engineVersion: 'four', entries: [] }), '', 'non-numeric engineVersion');
}

// 13. Missing `entries` on an otherwise-valid payload defaults to [] rather than throwing.
{
  const text = serialize({ engineVersion: ENGINE_VERSION });
  const result = deserialize(text, ENGINE_VERSION);
  assert.deepStrictEqual(result, { engineVersion: ENGINE_VERSION, entries: [] });
}

// 14. Circular structures never throw -- degrade to ''.
{
  const circular = { engineVersion: ENGINE_VERSION, entries: [] };
  circular.entries.push({ fsPath: '/ws/X.cls', mtimeMs: 1, facts: circular });
  assert.doesNotThrow(() => serialize(circular));
  assert.strictEqual(serialize(circular), '');
}

// ===========================================================================
// mapToEntries / entriesToMap — the Map<->array plumbing extension.js uses
// ===========================================================================

// 15. mapToEntries basic facts shape.
// H6(b): value objects now carry `size`, and it must survive into the entry.
{
  const fileCache = new Map();
  fileCache.set('/ws/A.cls', { mtimeMs: 10, size: 100, facts: { name: 'A' } });
  fileCache.set('/ws/B.cls', { mtimeMs: 20, size: 200, facts: { name: 'B' } });
  const entries = mapToEntries(fileCache, 'facts');
  assert.strictEqual(entries.length, 2);
  const byPath = Object.fromEntries(entries.map((e) => [e.fsPath, e]));
  assert.deepStrictEqual(byPath['/ws/A.cls'], { fsPath: '/ws/A.cls', mtimeMs: 10, size: 100, facts: { name: 'A' } });
  assert.deepStrictEqual(byPath['/ws/B.cls'], { fsPath: '/ws/B.cls', mtimeMs: 20, size: 200, facts: { name: 'B' } });
}

// 16. mapToEntries tolerates missing/malformed input, including H6(b)'s new
// missing/non-finite/negative `size` cases.
{
  assert.deepStrictEqual(mapToEntries(undefined, 'facts'), []);
  assert.deepStrictEqual(mapToEntries(null, 'facts'), []);
  assert.deepStrictEqual(mapToEntries(new Map(), 'facts'), []);
  assert.deepStrictEqual(mapToEntries(new Map(), undefined), []);

  const mixed = new Map();
  mixed.set('/ws/Good.cls', { mtimeMs: 1, size: 10, facts: {} });
  mixed.set('/ws/NoMtime.cls', { size: 10, facts: {} }); // no mtimeMs -- skipped
  mixed.set('/ws/NoSize.cls', { mtimeMs: 1, facts: {} }); // no size -- skipped
  mixed.set('/ws/BadSize.cls', { mtimeMs: 1, size: 'ten', facts: {} }); // non-numeric size -- skipped
  mixed.set('/ws/NegativeSize.cls', { mtimeMs: 1, size: -5, facts: {} }); // negative size -- skipped
  mixed.set('/ws/WrongKey.cls', { mtimeMs: 1, size: 10, other: 'x' }); // asking for 'facts' -- skipped
  mixed.set('/ws/NullValue.cls', null); // skipped, never throws
  assert.doesNotThrow(() => mapToEntries(mixed, 'facts'));
  const entries = mapToEntries(mixed, 'facts');
  assert.strictEqual(entries.length, 1);
  assert.strictEqual(entries[0].fsPath, '/ws/Good.cls');
}

// 17. entriesToMap basic shape + inverse round-trip through mapToEntries.
{
  const original = new Map();
  original.set('/ws/A.cls', { mtimeMs: 10, size: 100, facts: { name: 'A' } });
  original.set('/ws/B.cls', { mtimeMs: 20, size: 200, facts: { name: 'B' } });
  const restored = entriesToMap(mapToEntries(original, 'facts'), 'facts');
  assert.strictEqual(restored.size, 2);
  assert.deepStrictEqual(restored.get('/ws/A.cls'), { mtimeMs: 10, size: 100, facts: { name: 'A' } });
  assert.deepStrictEqual(restored.get('/ws/B.cls'), { mtimeMs: 20, size: 200, facts: { name: 'B' } });
}

// 18. entriesToMap tolerates missing/malformed input and drops bad rows,
// including H6(b)'s new missing-`size` case.
{
  assert.deepStrictEqual(entriesToMap(undefined, 'facts'), new Map());
  assert.deepStrictEqual(entriesToMap(null, 'facts'), new Map());
  assert.deepStrictEqual(entriesToMap('not-an-array', 'facts'), new Map());
  assert.deepStrictEqual(entriesToMap([], 'facts'), new Map());

  const entries = [
    { fsPath: '/ws/Good.cls', mtimeMs: 1, size: 10, facts: { ok: true } },
    { fsPath: '/ws/NoFacts.cls', mtimeMs: 1, size: 10 }, // missing the dataKey -- skipped
    { fsPath: '/ws/NoSize.cls', mtimeMs: 1, facts: {} }, // missing size -- skipped
    { mtimeMs: 1, size: 10, facts: {} }, // missing fsPath -- skipped
    null,
    'garbage',
  ];
  assert.doesNotThrow(() => entriesToMap(entries, 'facts'));
  const map = entriesToMap(entries, 'facts');
  assert.strictEqual(map.size, 1);
  assert.deepStrictEqual(map.get('/ws/Good.cls'), { mtimeMs: 1, size: 10, facts: { ok: true } });
}

// ===========================================================================
// End-to-end: Map -> serialize -> deserialize -> Map, the exact path
// extension.js's persist/hydrate cycle exercises.
// ===========================================================================

// 19. Full round-trip through JSON text and back. H6(b): size is part of
// the value shape end-to-end, same as mtimeMs.
{
  const fileCache = new Map();
  fileCache.set('/ws/AcmeOrderService.cls', { mtimeMs: 1700000000000, size: 4096, facts: { path: '/ws/AcmeOrderService.cls', parseError: null } });
  fileCache.set('/ws/AcmeOrderTrigger.trigger', { mtimeMs: 1700000000999, size: 2048, facts: { path: '/ws/AcmeOrderTrigger.trigger', parseError: null } });

  const text = serialize({ engineVersion: ENGINE_VERSION, entries: mapToEntries(fileCache, 'facts') });
  const payload = deserialize(text, ENGINE_VERSION);
  assert.ok(payload);
  const restored = entriesToMap(payload.entries, 'facts');

  assert.strictEqual(restored.size, fileCache.size);
  for (const [fsPath, value] of fileCache) {
    assert.deepStrictEqual(restored.get(fsPath), value, `entry for ${fsPath} (incl. size) round-trips exactly`);
  }
}

// 20. A version bump between persist and hydrate (simulating an extension
// update that changed parser.js's output shape) drops the ENTIRE cache, even
// though every individual entry is well-formed -- the whole point of F6's
// load-validation.
{
  const fileCache = new Map();
  fileCache.set('/ws/A.cls', { mtimeMs: 1, size: 10, facts: { shape: 'v3' } });
  const textFromOldEngine = serialize({ engineVersion: 3, entries: mapToEntries(fileCache, 'facts') });
  const payload = deserialize(textFromOldEngine, ENGINE_VERSION /* now 4 */);
  assert.strictEqual(payload, null, 'a v3-authored cache file must never hydrate under engine v4');
}

// ===========================================================================
// H6(b): size is now a required, strictly-validated sibling of mtimeMs
// ===========================================================================

// 21. A pre-H6(b) cache entry shape (mtimeMs only, no size at all -- e.g. a
// cache file left on disk by an older build that shared the SAME
// engineVersion number by coincidence in a test harness) is dropped at the
// entry level, not hydrated with size silently missing/undefined. This is
// the entry-shape half of H6(b); the version-number half (a real prior
// build's cache file gets a HIGHER engineVersion and is invalidated whole-
// file by test 20's mechanism) is extension.js's job when it bumps
// ENGINE_CACHE_VERSION to 6 (out of scope here).
{
  const legacyShapeText = JSON.stringify({
    engineVersion: ENGINE_VERSION,
    entries: [{ fsPath: '/ws/Legacy.cls', mtimeMs: 100, facts: { shape: 'pre-size' } }],
  });
  const payload = deserialize(legacyShapeText, ENGINE_VERSION);
  assert.ok(payload, 'the payload itself is still valid JSON with a matching engineVersion');
  assert.strictEqual(payload.entries.length, 0, 'the size-less entry must not survive entry-shape validation');
}

// 22. cachestore is version-number-agnostic -- it validates whatever
// expectedEngineVersion the caller passes, it does not hardcode any number
// itself (ENGINE_CACHE_VERSION's home stays extension.js per H6(b)). This
// locks in that a payload authored under the real target version (6, the
// literal H6(b) bump target) round-trips exactly like any other version
// number, and that a mismatch against it is still rejected the same way.
{
  const payload = {
    engineVersion: 6,
    entries: [{ fsPath: '/ws/A.cls', mtimeMs: 1, size: 10, facts: { v: 6 } }],
  };
  const text = serialize(payload);
  assert.deepStrictEqual(deserialize(text, 6), payload);
  assert.strictEqual(deserialize(text, 5), null, 'a v6-authored cache must not hydrate under a v5 (or any other) expectation');
  assert.strictEqual(deserialize(text, 7), null, 'nor under a v7 expectation -- strict equality, not >=');
}

// 23. Source-bearing facts are never eligible for persistence, including a
// successful parse whose nested calls/literals contain raw source slices.
{
  const cache = new Map();
  cache.set('/ws/Clean.cls', {
    mtimeMs: 1,
    size: 20,
    facts: { path: '/ws/Clean.cls', parseError: null, types: [] },
  });
  cache.set('/ws/Broken.cls', {
    mtimeMs: 2,
    size: 21,
    facts: { path: '/ws/Broken.cls', parseError: 'unexpected token', text: 'PRIVATE_SOURCE_SENTINEL' },
  });
  cache.set('/ws/UnexpectedText.cls', {
    mtimeMs: 3,
    size: 22,
    facts: { path: '/ws/UnexpectedText.cls', parseError: null, text: 'FUTURE_RAW_TEXT_SENTINEL' },
  });
  const successfulSource =
    "public class ParsedFixture { public static final String VALUE = 'CACHE_VALUE_SENTINEL'; " +
    "public static void run() { Other.call('CACHE_ARG_SENTINEL'); } }";
  const successfulFacts = parser.parseFile({ path: '/ws/ParsedFixture.cls', text: successfulSource });
  assert.strictEqual(successfulFacts.parseError, null);
  assert.strictEqual(containsSourceFragments(successfulFacts), true);
  cache.set('/ws/ParsedFixture.cls', {
    mtimeMs: 4,
    size: Buffer.byteLength(successfulSource),
    facts: successfulFacts,
  });
  const entries = safeFactsEntries(cache);
  assert.deepStrictEqual(entries.map((entry) => entry.fsPath), ['/ws/Clean.cls']);
  const serialized = serializeSafeFactsCache(9, cache);
  assert.ok(!serialized.includes('PRIVATE_SOURCE_SENTINEL'));
  assert.ok(!serialized.includes('FUTURE_RAW_TEXT_SENTINEL'));
  assert.ok(!serialized.includes('CACHE_VALUE_SENTINEL'));
  assert.ok(!serialized.includes('CACHE_ARG_SENTINEL'));
  assert.ok(!serialized.includes('Other.call'));
  assert.deepStrictEqual(deserialize(serialized, 9).entries, entries);
}

// 24. Cache cleanup recognizes only extension-owned cache filenames.
{
  const nowMs = 10_000;
  const retentionMs = 1_000;
  assert.strictEqual(cacheFileKind('facts-0123456789abcdef.json'), 'legacy');
  assert.strictEqual(cacheFileKind('meta-0123456789abcdef.json'), 'legacy');
  assert.strictEqual(cacheFileKind('facts-v8-0123456789abcdef.json'), 'legacy');
  assert.strictEqual(cacheFileKind('facts-v9-0123456789abcdef.json'), 'facts');
  assert.strictEqual(cacheFileKind('facts-v8-not-a-hash.json'), null);
  assert.strictEqual(cacheFileKind('unrelated.json'), null);
  assert.strictEqual(
    shouldDeleteCacheFile('facts-0123456789abcdef.json', { nowMs, retentionMs, mtimeMs: nowMs }),
    true,
    'legacy source-bearing caches are removed regardless of age'
  );
  assert.strictEqual(
    shouldDeleteCacheFile('facts-v8-0123456789abcdef.json', { nowMs, retentionMs, mtimeMs: 9_999 }),
    true,
    'pre-v9 versioned caches may contain successful-parse source and are always removed'
  );
  assert.strictEqual(
    shouldDeleteCacheFile('facts-v9-0123456789abcdef.json', { nowMs, retentionMs, mtimeMs: 8_999 }),
    true,
    'safe facts caches older than the retention window expire'
  );
  assert.strictEqual(
    shouldDeleteCacheFile('facts-v9-0123456789abcdef.json', { nowMs, retentionMs, mtimeMs: 9_001 }),
    false,
    'recent safe facts caches remain available'
  );
  assert.strictEqual(
    shouldDeleteCacheFile('facts-v9-0123456789abcdef.json', { clearAll: true }),
    true,
    'clear-all removes current safe cache files too'
  );
  assert.strictEqual(
    shouldDeleteCacheFile('unrelated.json', { clearAll: true }),
    false,
    'clear-all never touches unrelated global-storage files'
  );
}

console.log('apex-trace cachestore self-check: all assertions passed');

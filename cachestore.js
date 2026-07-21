'use strict';
// cachestore.js — F6 disk-persisted facts cache: pure serialize/deserialize,
// no vscode import, no fs import, no dependency on parser.js/metascan.js.
// extension.js (out of scope here) owns all the I/O — reading/writing
// context.globalStorageUri, debouncing writes, comparing mtimes against the
// live filesystem; this module only knows how to turn an in-memory cache Map
// into a JSON-safe string and back, defensively.
//
// Persistence contract:
//
//   CachePayload = { engineVersion: number, entries: [CacheEntry] }
//   CacheEntry   = { fsPath: string, mtimeMs: number, size: number, facts: <FileFacts> }
//     -- only declaration-only Apex FileFacts with no verbatim expression,
//        source-line, or literal-value fields may cross the live disk-write
//        boundary. Metadata source, parse-error Apex source, and successful
//        facts containing source fragments remain memory-only.
//     -- H6(b): `size` (the file's byte length, i.e. Node `fs.Stats.size`)
//        is now a REQUIRED sibling of `mtimeMs` on every entry, exactly as
//        strictly validated as `mtimeMs` is. extension.js (out of scope
//        here, owns ENGINE_CACHE_VERSION and all fs.stat() I/O) now treats a
//        cache entry as fresh only when BOTH `mtimeMs === stat.mtimeMs` AND
//        `size === stat.size` -- an mtime-only check can miss a same-second
//        edit on filesystems with coarse mtime resolution, or a content
//        change that happens to round-trip through a tool that preserves
//        mtime. This module doesn't perform that comparison itself (it has
//        no fs access, per the frozen contract above) -- it only makes sure
//        `size` survives serialize/deserialize/mapToEntries/entriesToMap
//        with the same defensive rigor as every other required field, so a
//        cache entry missing/malformed `size` degrades to "drop this one
//        entry" rather than silently being treated as valid with size
//        unset.
//
//   serialize(payload) -> string
//     Never throws. Returns '' for input that cannot be turned into the
//     documented shape (missing/non-object payload) or that JSON.stringify
//     itself cannot handle (circular references, BigInt, ...).
//
//   deserialize(text, expectedEngineVersion) -> CachePayload | null
//     Never throws. Returns null when:
//       - `text` is not a non-empty string
//       - `text` is not valid JSON
//       - the parsed value isn't a plain object, or has no numeric
//         `engineVersion` / no array `entries`
//       - `engineVersion` does not STRICTLY equal `expectedEngineVersion`
//         (a version mismatch invalidates the WHOLE cache file — a
//         half-old/half-new mix of FileFacts shapes is worse than a cold
//         scan, never partially trusted)
//     Individual malformed entries inside an otherwise-valid payload are
//     silently dropped rather than invalidating the whole file — one bad
//     row shouldn't cost every other file its cache hit.
//
//   mapToEntries(map, dataKey) -> [plain entry]
//     map: Map<fsPath, { mtimeMs, size, [dataKey]: value }> (extension.js's
//     in-memory cache shape) -> a plain array. This generic conversion helper
//     is retained for defensive load/migration tests; it is NOT a safe disk-
//     persistence boundary by itself. Tolerates a missing/non-Map `map`
//     (returns []) and skips any entry missing fsPath/mtimeMs/size/dataKey
//     (size must additionally be finite and non-negative).
//
//   entriesToMap(entries, dataKey) -> Map<fsPath, { mtimeMs, size, [dataKey]: value }>
//     Inverse of mapToEntries. Skips (never throws on) malformed entries —
//     missing/empty fsPath, non-finite mtimeMs, missing/non-finite/negative
//     size, or a missing dataKey value.
//
// Why load-validation matters: a stale cache file from a prior engine
// version (different CallFacts/MethodFacts shape) must never be silently
// hydrated into a live run — resolver.js would either choke on an
// unexpected shape or, worse, silently produce wrong call-graph edges from
// half-old/half-new FileFacts. ENGINE_CACHE_VERSION (bumped in extension.js
// whenever parser.js's/metascan.js's output shape changes) is therefore
// checked with strict equality, and ANY parse failure (truncated file, bit
// rot, a user hand-editing the cache file, an interrupted write, a
// completely different JSON document living at that path) degrades to null
// rather than throwing — extension.js's hydration path can then simply
// treat null the same as "no cache file existed yet" and fall back to a
// full cold scan.

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function isPlainEntry(e) {
  return (
    isPlainObject(e) &&
    typeof e.fsPath === 'string' &&
    e.fsPath.length > 0 &&
    typeof e.mtimeMs === 'number' &&
    Number.isFinite(e.mtimeMs) &&
    typeof e.size === 'number' &&
    Number.isFinite(e.size) &&
    e.size >= 0
  );
}

function serialize(payload) {
  try {
    if (!isPlainObject(payload)) return '';
    if (typeof payload.engineVersion !== 'number') return '';
    const entries = Array.isArray(payload.entries) ? payload.entries : [];
    return JSON.stringify({ engineVersion: payload.engineVersion, entries });
  } catch (e) {
    // circular structure, BigInt, or any other JSON.stringify failure --
    // never throw, degrade to "nothing to persist this round".
    return '';
  }
}

function deserialize(text, expectedEngineVersion) {
  if (typeof text !== 'string' || text.length === 0) return null;

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    return null; // corrupt JSON
  }

  if (!isPlainObject(parsed)) return null;
  if (typeof parsed.engineVersion !== 'number') return null;
  if (parsed.engineVersion !== expectedEngineVersion) return null; // version mismatch
  if (!Array.isArray(parsed.entries)) return null;

  const entries = [];
  for (const e of parsed.entries) {
    if (isPlainEntry(e)) entries.push(e);
  }
  return { engineVersion: parsed.engineVersion, entries };
}

function mapToEntries(map, dataKey) {
  const out = [];
  if (!map || typeof map.forEach !== 'function' || typeof dataKey !== 'string') return out;
  map.forEach((value, fsPath) => {
    if (typeof fsPath !== 'string' || !fsPath) return;
    if (!isPlainObject(value)) return;
    if (typeof value.mtimeMs !== 'number' || !Number.isFinite(value.mtimeMs)) return;
    // H6(b): size is validated exactly like mtimeMs -- missing/non-finite/
    // negative size skips the whole entry rather than persisting a
    // cache-validity check extension.js can't actually perform on hydrate.
    if (typeof value.size !== 'number' || !Number.isFinite(value.size) || value.size < 0) return;
    if (!(dataKey in value)) return;
    const entry = { fsPath, mtimeMs: value.mtimeMs, size: value.size };
    entry[dataKey] = value[dataKey];
    out.push(entry);
  });
  return out;
}

function entriesToMap(entries, dataKey) {
  const map = new Map();
  if (!Array.isArray(entries) || typeof dataKey !== 'string') return map;
  for (const e of entries) {
    if (!isPlainEntry(e)) continue;
    if (!(dataKey in e)) continue;
    const value = { mtimeMs: e.mtimeMs, size: e.size };
    value[dataKey] = e[dataKey];
    map.set(e.fsPath, value);
  }
  return map;
}

// These fields are source-faithful slices or literal values, even on a
// successful parse. Do not recursively delete them and hydrate an incomplete
// FileFacts object: resolver.js consumes them for overload, DML, dynamic-flow,
// and UI behavior. Instead fail closed and omit the entire file from the disk
// cache; the next session reparses it normally.
const SOURCE_FRAGMENT_FACT_KEYS = new Set([
  'text',
  'lineText',
  'argTexts',
  'receiver',
  'targetText',
  'literal',
]);

function containsSourceFragments(value, seen) {
  if (value === null || typeof value !== 'object') return false;
  seen = seen || new Set();
  if (seen.has(value)) return true; // unexpected cycles fail closed
  seen.add(value);
  for (const [key, child] of Object.entries(value)) {
    if (SOURCE_FRAGMENT_FACT_KEYS.has(key)) return true;
    if (containsSourceFragments(child, seen)) return true;
  }
  seen.delete(value);
  return false;
}

// Only clean, declaration-only derived facts are eligible for persistence.
// Parse-error facts always carry raw `text`; successful facts with calls,
// DML, throws, or literal-flow evidence carry one of the guarded fields
// above. Whole-entry omission preserves correctness and confidentiality.
function safeFactsEntries(map) {
  return mapToEntries(map, 'facts').filter((entry) => {
    const facts = entry.facts;
    return isPlainObject(facts) && !facts.parseError && !containsSourceFragments(facts);
  });
}

// The production serializer: callers cannot supply arbitrary entries or a
// data-key name, so raw metadata text and parse-error source cannot be
// accidentally included by using the generic helpers incorrectly.
function serializeSafeFactsCache(engineVersion, map) {
  return serialize({ engineVersion, entries: safeFactsEntries(map) });
}

const LEGACY_CACHE_FILE_RE = /^(?:facts|meta)-[0-9a-f]{16}\.json$/;
const VERSIONED_FACTS_CACHE_FILE_RE = /^facts-v(\d+)-[0-9a-f]{16}\.json$/;
const FIRST_SOURCE_FRAGMENT_SAFE_VERSION = 9;

function cacheFileKind(name) {
  if (typeof name !== 'string') return null;
  if (LEGACY_CACHE_FILE_RE.test(name)) return 'legacy';
  const versioned = VERSIONED_FACTS_CACHE_FILE_RE.exec(name);
  if (versioned) {
    return Number(versioned[1]) >= FIRST_SOURCE_FRAGMENT_SAFE_VERSION ? 'facts' : 'legacy';
  }
  return null;
}

// Pure retention policy used by extension.js's global-storage cleanup.
// Legacy files are always removed because old facts files may contain raw
// parse-error source and old metadata files always contain raw metadata text.
function shouldDeleteCacheFile(name, opts) {
  opts = opts || {};
  const kind = cacheFileKind(name);
  if (!kind) return false;
  if (opts.clearAll) return true;
  if (kind === 'legacy') return true;
  const mtimeMs = Number(opts.mtimeMs);
  const nowMs = Number(opts.nowMs);
  const retentionMs = Number(opts.retentionMs);
  if (!Number.isFinite(mtimeMs) || !Number.isFinite(nowMs) || !Number.isFinite(retentionMs) || retentionMs < 0) {
    return false;
  }
  return nowMs - mtimeMs > retentionMs;
}

module.exports = {
  serialize,
  deserialize,
  mapToEntries,
  entriesToMap,
  safeFactsEntries,
  containsSourceFragments,
  serializeSafeFactsCache,
  cacheFileKind,
  shouldDeleteCacheFile,
};

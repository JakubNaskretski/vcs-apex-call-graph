'use strict';

// VS Code-independent cache-file cleanup. The caller supplies the small
// workspace.fs/Uri surface so retention and clear-all behavior can be tested
// without an extension host or touching real global storage.
const cachestore = require('./cachestore');

function isFileNotFoundError(error) {
  if (!error) return false;
  if (error.code === 'ENOENT' || error.code === 'FileNotFound') return true;
  return typeof error.name === 'string' && /(?:^|\b)(?:ENOENT|FileNotFound)(?:\b|$)/.test(error.name);
}

async function cleanupCacheFiles(fsApi, uriApi, storageUri, opts) {
  opts = opts || {};
  let rows;
  let readError = null;
  // Retry once for transient virtual-filesystem/provider failures. A truly
  // absent directory is the normal first-run case; every other final error
  // must be reported because persisted source-bearing legacy files may exist.
  for (let attempt = 0; attempt < 2 && !rows; attempt++) {
    try {
      rows = await fsApi.readDirectory(storageUri);
      readError = null;
    } catch (error) {
      if (isFileNotFoundError(error)) return { removed: 0, failed: 0, inspectionFailed: false };
      readError = error;
    }
  }
  if (readError) return { removed: 0, failed: 0, inspectionFailed: true };
  let removed = 0;
  let failed = 0;
  const nowMs = Number.isFinite(Number(opts.nowMs)) ? Number(opts.nowMs) : Date.now();
  for (const row of rows || []) {
    const name = Array.isArray(row) ? row[0] : null;
    if (!cachestore.cacheFileKind(name)) continue;
    const uri = uriApi.joinPath(storageUri, name);
    let mtimeMs = NaN;
    if (!opts.clearAll) {
      try {
        const stat = await fsApi.stat(uri);
        mtimeMs = stat.mtime;
      } catch (e) {
        // Legacy files are deleted without needing a stat; a stat failure for
        // a current safe cache leaves it alone rather than guessing.
      }
    }
    if (!cachestore.shouldDeleteCacheFile(name, {
      clearAll: !!opts.clearAll,
      mtimeMs,
      nowMs,
      retentionMs: opts.retentionMs,
    })) continue;
    let deleted = false;
    // A transient VS Code filesystem error should not strand a legacy
    // source-bearing cache. Retry once, then report a count to the caller so
    // activation/clear can warn without disclosing any cache path.
    for (let attempt = 0; attempt < 2 && !deleted; attempt++) {
      try {
        await fsApi.delete(uri);
        deleted = true;
      } catch (e) {
        // retry once below
      }
    }
    if (deleted) removed++;
    else failed++;
  }
  return { removed, failed, inspectionFailed: false };
}

// The only disk-write boundary for live cache data. It accepts the Apex
// fileCache Map, filters it through cachestore's declaration-only,
// source-fragment-safe serializer, and never accepts the metadata cache.
async function persistSafeFactsCache(fsApi, storageUri, factsUri, engineVersion, fileCache) {
  const text = cachestore.serializeSafeFactsCache(engineVersion, fileCache);
  if (!text) return false;
  await fsApi.createDirectory(storageUri);
  await fsApi.writeFile(factsUri, Buffer.from(text, 'utf8'));
  return true;
}

module.exports = { cleanupCacheFiles, persistSafeFactsCache, isFileNotFoundError };

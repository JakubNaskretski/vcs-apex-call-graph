'use strict';

// Pure helpers for snapshotting dirty VS Code text documents and overlaying
// their contents on top of disk-derived scan results. The caller owns all
// persistence; these functions never mutate the disk cache Maps.
const APEX_EXT_RE = /\.(cls|trigger|apex)$/i;
const META_EXT_RE = /\.(js|cmp|app|xml|json|page|component)$/i;
const workspacepaths = require('./workspacepaths');

function pathKey(fsPath) {
  return typeof fsPath === 'string' ? fsPath.replace(/\\/g, '/') : '';
}

function sourceKind(fsPath) {
  if (APEX_EXT_RE.test(fsPath || '')) return 'apex';
  if (META_EXT_RE.test(fsPath || '')) return 'metadata';
  return null;
}

function fileBackedSourcePath(document) {
  const source = fileBackedSource(document);
  return source ? source.path : null;
}

function fileBackedSource(document) {
  if (!document || document.isUntitled) return null;
  const uri = document.uri;
  if (!uri || uri.scheme === 'untitled' || !uri.fsPath) return null;
  const fsPath = uri.fsPath || document.fileName;
  const kind = sourceKind(fsPath);
  const key = workspacepaths.resourceKey(uri);
  const sourcePath = workspacepaths.sourcePathForUri(uri);
  return fsPath && kind && key && sourcePath
    ? { key, path: sourcePath, fsPath, kind, uri }
    : null;
}

// onDidSaveTextDocument fires synchronously in the extension host before a
// filesystem watcher is guaranteed to deliver. Marking the path here closes
// the save -> immediate trace window where the document is already clean but
// the disk cache still represents its pre-save contents.
function createDidSaveHandler(markChanged, isInWorkspace) {
  return (document) => {
    const source = fileBackedSource(document);
    if (!source || typeof markChanged !== 'function') return;
    if (typeof isInWorkspace === 'function' && !isInWorkspace(document)) return;
    markChanged(source.key);
  };
}

function captureDirtyDocumentOverlays(documents) {
  const overlays = new Map();
  for (const document of documents || []) {
    if (!document || !document.isDirty || document.isUntitled) continue;
    const source = fileBackedSource(document);
    if (!source || typeof document.getText !== 'function') continue;
    let text;
    try {
      text = document.getText();
    } catch (e) {
      continue;
    }
    if (typeof text !== 'string') continue;
    overlays.set(source.key, Object.freeze({
      key: source.key,
      path: source.path,
      fsPath: source.fsPath,
      text,
      kind: source.kind,
      version: Number.isFinite(Number(document.version)) ? Number(document.version) : null,
    }));
  }
  return overlays;
}

// v0.2x/M2W: cheap, deterministic fingerprint of a
// captureDirtyDocumentOverlays() snapshot -- every overlay already carries
// the document's own monotonically increasing `version` (vscode bumps it on
// every edit, including an edit that is later undone back to the original
// text -- this fingerprint is deliberately conservative: it may report
// "changed" when the content actually round-tripped back to its previous
// text, never the reverse, which is the safe direction to be wrong in), so
// 'key@version' pairs are sufficient to detect an added, removed, or
// re-edited dirty buffer without hashing full text on every scan. Sorted so
// Map iteration order never affects the result. Consumed by extension.js's
// whole-index memoization (see scanflow.indexMemoFingerprint) -- an
// empty/absent overlay set fingerprints as ''.
function overlaySnapshotFingerprint(overlays) {
  if (!(overlays instanceof Map) || overlays.size === 0) return '';
  const parts = [];
  for (const overlay of overlays.values()) {
    parts.push(`${overlay.key}@${overlay.version == null ? '?' : overlay.version}`);
  }
  parts.sort();
  return parts.join('|');
}

function applyApexOverlays(factsList, eligiblePaths, overlays, parseFile) {
  const facts = Array.isArray(factsList) ? factsList.slice() : [];
  if (!(overlays instanceof Map) || typeof parseFile !== 'function') return { factsList: facts, overlaid: 0 };

  const positions = new Map();
  for (let i = 0; i < facts.length; i++) {
    const key = pathKey(facts[i] && facts[i].path);
    if (key && !positions.has(key)) positions.set(key, i);
  }

  let overlaid = 0;
  for (const resourceKey of eligiblePaths || []) {
    const overlay = overlays.get(resourceKey);
    if (!overlay || overlay.kind !== 'apex') continue;
    const sourceKey = pathKey(overlay.path);
    const parsed = parseFile({ path: overlay.path, text: overlay.text });
    if (positions.has(sourceKey)) facts[positions.get(sourceKey)] = parsed;
    else {
      positions.set(sourceKey, facts.length);
      facts.push(parsed);
    }
    overlaid++;
  }
  return { factsList: facts, overlaid };
}

function applyMetadataOverlays(files, eligiblePaths, overlays) {
  const result = Array.isArray(files) ? files.map((file) => ({ ...file })) : [];
  if (!(overlays instanceof Map)) return { files: result, overlaid: 0 };

  const positions = new Map();
  for (let i = 0; i < result.length; i++) {
    const key = pathKey(result[i] && result[i].path);
    if (key && !positions.has(key)) positions.set(key, i);
  }

  let overlaid = 0;
  for (const resourceKey of eligiblePaths || []) {
    const overlay = overlays.get(resourceKey);
    if (!overlay || overlay.kind !== 'metadata') continue;
    const sourceKey = pathKey(overlay.path);
    const file = { path: overlay.path, text: overlay.text };
    if (positions.has(sourceKey)) result[positions.get(sourceKey)] = file;
    else {
      positions.set(sourceKey, result.length);
      result.push(file);
    }
    overlaid++;
  }
  return { files: result, overlaid };
}

module.exports = {
  pathKey,
  sourceKind,
  fileBackedSource,
  fileBackedSourcePath,
  createDidSaveHandler,
  captureDirtyDocumentOverlays,
  overlaySnapshotFingerprint,
  applyApexOverlays,
  applyMetadataOverlays,
};

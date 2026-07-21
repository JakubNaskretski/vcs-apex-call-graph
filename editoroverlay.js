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
  applyApexOverlays,
  applyMetadataOverlays,
};

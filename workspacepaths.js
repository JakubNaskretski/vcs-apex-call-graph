'use strict';

const path = require('path');

// Canonical cache/dirty/overlay identity. fsPath alone is insufficient for
// remote/virtual workspaces because two authorities may expose the same path.
function resourceKey(uri) {
  if (!uri || typeof uri !== 'object') return '';
  if (typeof uri.toString === 'function') {
    const rendered = uri.toString();
    if (rendered && rendered !== '[object Object]') return rendered;
  }
  const scheme = typeof uri.scheme === 'string' && uri.scheme ? uri.scheme : 'file';
  const authority = typeof uri.authority === 'string' ? uri.authority : '';
  const uriPath = typeof uri.path === 'string' && uri.path
    ? uri.path
    : String(uri.fsPath || '').replace(/\\/g, '/');
  if (!uriPath) return '';
  const slashPath = uriPath.startsWith('/') ? uriPath : '/' + uriPath;
  return `${scheme}://${authority}${slashPath}`;
}

// Keep ordinary local paths byte-compatible with existing resolver/UI output,
// but make remote/virtual source locations authority-safe and parseable back
// into their original URI for navigation.
function sourcePathForUri(uri) {
  if (!uri) return '';
  return uri.scheme === 'file' && uri.fsPath ? uri.fsPath : resourceKey(uri);
}

function workspaceSetIdentity(folders) {
  return (folders || [])
    .map((folder) => resourceKey(folder && folder.uri))
    .filter(Boolean)
    .sort()
    .join('|');
}

function isSerializedResourcePath(value) {
  if (typeof value !== 'string') return false;
  // Accept both authority URIs (`vscode-remote://host/path`) and
  // authority-less virtual URIs (`memfs:/path`), but never interpret a
  // Windows drive path such as `C:\\workspace\\A.cls` as URI scheme `c`.
  return /^[A-Za-z][A-Za-z0-9+.-]*:/.test(value) && !/^[A-Za-z]:[\\/]/.test(value);
}

function sameOrigin(a, b) {
  return !!(
    a && b &&
    String(a.scheme || '') === String(b.scheme || '') &&
    String(a.authority || '') === String(b.authority || '')
  );
}

// Resolve an fsPath against the most specific containing workspace folder
// without throwing away that folder URI's scheme/authority. The caller can
// then reconstruct a remote/virtual resource URI with Uri.joinPath.
function findContainingWorkspaceFolder(fsPath, folders, pathApi) {
  pathApi = pathApi || path;
  if (typeof fsPath !== 'string' || !fsPath) return null;
  let best = null;
  for (const folder of folders || []) {
    const root = folder && folder.uri && folder.uri.fsPath;
    if (typeof root !== 'string' || !root) continue;
    const relativePath = pathApi.relative(root, fsPath);
    const outside =
      relativePath === '..' ||
      relativePath.startsWith('..' + pathApi.sep) ||
      pathApi.isAbsolute(relativePath);
    if (outside) continue;
    if (!best || root.length > best.root.length) best = { folder, root, relativePath };
  }
  return best;
}

// URI-aware counterpart: origin equality is mandatory before path
// containment, so vscode-remote://alpha/workspace can never match a folder
// rooted at vscode-remote://beta/workspace.
function findContainingWorkspaceFolderForUri(uri, folders, pathApi) {
  pathApi = pathApi || path;
  if (!uri || !uri.fsPath) return null;
  return findContainingWorkspaceFolder(
    uri.fsPath,
    (folders || []).filter((folder) => folder && folder.uri && sameOrigin(uri, folder.uri)),
    pathApi
  );
}

module.exports = {
  resourceKey,
  sourcePathForUri,
  workspaceSetIdentity,
  isSerializedResourcePath,
  sameOrigin,
  findContainingWorkspaceFolder,
  findContainingWorkspaceFolderForUri,
};

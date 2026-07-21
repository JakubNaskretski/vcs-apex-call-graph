'use strict';

const assert = require('assert');
const path = require('path');
const {
  resourceKey,
  sourcePathForUri,
  workspaceSetIdentity,
  isSerializedResourcePath,
  findContainingWorkspaceFolder,
  findContainingWorkspaceFolderForUri,
} = require('./workspacepaths');

function folder(name, fsPath, scheme, authority) {
  return { name, uri: uri(fsPath, scheme, authority) };
}

function uri(fsPath, scheme, authority) {
  scheme = scheme || 'file';
  authority = authority || '';
  return {
    fsPath,
    path: fsPath.replace(/\\/g, '/'),
    scheme,
    authority,
    toString() {
      if (authority) return `${scheme}://${authority}${this.path}`;
      return scheme === 'file' ? `file://${this.path}` : `${scheme}:${this.path}`;
    },
  };
}

const folders = [
  folder('root', '/workspace', 'vscode-remote', 'ssh-remote+host'),
  folder('nested', '/workspace/packages/nested', 'vscode-remote', 'ssh-remote+host'),
  folder('other', '/other', 'file', ''),
];

{
  const found = findContainingWorkspaceFolder('/workspace/classes/Live.cls', folders, path.posix);
  assert.strictEqual(found.folder.name, 'root');
  assert.strictEqual(found.relativePath, 'classes/Live.cls');
  assert.strictEqual(found.folder.uri.scheme, 'vscode-remote', 'remote scheme/authority survive path resolution');
}

{
  const found = findContainingWorkspaceFolder('/workspace/packages/nested/classes/Deep.cls', folders, path.posix);
  assert.strictEqual(found.folder.name, 'nested', 'most specific multi-root folder wins');
  assert.strictEqual(found.relativePath, 'classes/Deep.cls');
}

assert.strictEqual(findContainingWorkspaceFolder('/workspace-other/Fake.cls', folders, path.posix), null, 'prefix sibling is outside');
assert.strictEqual(findContainingWorkspaceFolder('/outside/External.cls', folders, path.posix), null, 'external path is rejected');
assert.strictEqual(findContainingWorkspaceFolder('', folders, path.posix), null);

// Same fsPath, different remote authority: identities, containment, source
// paths, and therefore cache/dirty/overlay keys remain distinct.
{
  const alpha = folder('alpha', '/workspace', 'vscode-remote', 'ssh-remote+alpha');
  const beta = folder('beta', '/workspace', 'vscode-remote', 'ssh-remote+beta');
  const alphaFile = uri('/workspace/classes/Shared.cls', 'vscode-remote', 'ssh-remote+alpha');
  const betaFile = uri('/workspace/classes/Shared.cls', 'vscode-remote', 'ssh-remote+beta');
  assert.notStrictEqual(resourceKey(alphaFile), resourceKey(betaFile));
  assert.notStrictEqual(sourcePathForUri(alphaFile), sourcePathForUri(betaFile));
  assert.notStrictEqual(
    workspaceSetIdentity([alpha]),
    workspaceSetIdentity([beta]),
    'persisted workspace-cache identity includes remote authority'
  );
  assert.strictEqual(
    findContainingWorkspaceFolderForUri(alphaFile, [beta, alpha], path.posix).folder.name,
    'alpha'
  );
  assert.strictEqual(
    findContainingWorkspaceFolderForUri(betaFile, [alpha, beta], path.posix).folder.name,
    'beta'
  );
}

assert.strictEqual(sourcePathForUri(uri('/workspace/Local.cls', 'file', '')), '/workspace/Local.cls');
{
  const virtual = uri('/workspace/Virtual.cls', 'memfs', '');
  assert.strictEqual(resourceKey(virtual), 'memfs:/workspace/Virtual.cls');
  assert.strictEqual(sourcePathForUri(virtual), 'memfs:/workspace/Virtual.cls');
  assert.strictEqual(isSerializedResourcePath(sourcePathForUri(virtual)), true);
  assert.strictEqual(isSerializedResourcePath('C:\\workspace\\Local.cls'), false);
  assert.strictEqual(isSerializedResourcePath('C:/workspace/Local.cls'), false);
}

console.log('apex-call-graph workspace path resolution self-check: all assertions passed');

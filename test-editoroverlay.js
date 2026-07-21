'use strict';

const assert = require('assert');
const parser = require('./parser');
const resolver = require('./resolver');
const cachestore = require('./cachestore');
const scanflow = require('./scanflow');
const {
  pathKey,
  sourceKind,
  fileBackedSource,
  fileBackedSourcePath,
  createDidSaveHandler,
  captureDirtyDocumentOverlays,
  applyApexOverlays,
  applyMetadataOverlays,
} = require('./editoroverlay');

function document(fsPath, text, opts) {
  opts = opts || {};
  const scheme = opts.scheme || 'file';
  const authority = opts.authority || '';
  const uriPath = fsPath.replace(/\\/g, '/');
  return {
    isDirty: opts.isDirty !== false,
    isUntitled: !!opts.isUntitled,
    version: opts.version || 1,
    fileName: fsPath,
    uri: {
      scheme,
      authority,
      fsPath,
      path: uriPath,
      toString() {
        if (authority) return `${scheme}://${authority}${uriPath}`;
        return scheme === 'file' ? `file://${uriPath}` : `${scheme}:${uriPath}`;
      },
    },
    getText() {
      if (opts.readError) throw new Error('document unavailable');
      return text;
    },
  };
}

function sourceKey(doc) {
  return fileBackedSource(doc).key;
}

// Capture only dirty, saved-path source documents and freeze their text at
// scan start. Clean, untitled, non-file, unrelated, and unreadable documents
// never enter the overlay snapshot.
{
  let liveText = 'public class LiveService {}';
  const live = document('/ws/LiveService.cls', liveText, { version: 7 });
  live.getText = () => liveText;
  const overlays = captureDirtyDocumentOverlays([
    live,
    document('/ws/FlowA.flow-meta.xml', '<Flow/>'),
    document('/ws/Clean.cls', 'clean', { isDirty: false }),
    document('/ws/Untitled.cls', 'untitled', { isUntitled: true }),
    document('/ws/Remote.cls', 'remote', { scheme: 'vscode-remote' }),
    document('/ws/notes.txt', 'notes'),
    document('/ws/Unreadable.cls', 'x', { readError: true }),
  ]);
  liveText = 'public class ChangedAfterSnapshot {}';
  assert.strictEqual(overlays.size, 3);
  assert.strictEqual(overlays.get('file:///ws/LiveService.cls').text, 'public class LiveService {}');
  assert.strictEqual(overlays.get('file:///ws/LiveService.cls').version, 7);
  assert.strictEqual(overlays.get('file:///ws/FlowA.flow-meta.xml').kind, 'metadata');
  assert.strictEqual(overlays.get('vscode-remote:/ws/Remote.cls').kind, 'apex', 'remote file-backed documents retain unsaved overlays');
  assert.strictEqual(Object.isFrozen(overlays.get('file:///ws/LiveService.cls')), true);
}

assert.strictEqual(pathKey('C:\\ws\\Live.cls'), 'C:/ws/Live.cls');
assert.strictEqual(sourceKind('/ws/run.apex'), 'apex');
assert.strictEqual(sourceKind('/ws/page.page'), 'metadata');
assert.strictEqual(sourceKind('/ws/readme.md'), null);
assert.strictEqual(fileBackedSourcePath(document('/ws/Saved.cls', 'x', { isDirty: false })), '/ws/Saved.cls');
assert.strictEqual(fileBackedSourcePath(document('/ws/Saved.txt', 'x', { isDirty: false })), null);

// Save -> immediate trace regression: the buffer is already clean (and so
// correctly absent from overlays), but onDidSave marks the path dirty before
// a delayed filesystem watcher. Identical mtime+size therefore cannot reuse
// the pre-save cache entry.
{
  const savedPath = '/ws/SavedNow.cls';
  const savedDocument = document(savedPath, 'public class SavedNow {}', { isDirty: false });
  assert.strictEqual(captureDirtyDocumentOverlays([savedDocument]).size, 0);
  const tracker = scanflow.createDirtyTracker();
  tracker.markSweepDone(tracker.peek());
  const savedKey = sourceKey(savedDocument);
  createDidSaveHandler((resourceKey) => tracker.markChanged(resourceKey))(savedDocument);
  const snapshot = tracker.peek();
  assert.strictEqual(snapshot.dirty.has(savedKey), true);
  assert.strictEqual(
    scanflow.canReuseStatCache(
      { mtimeMs: 100, size: 20, facts: { old: true } },
      { mtime: 100, size: 20 },
      scanflow.isExplicitlyDirty(snapshot, savedKey)
    ),
    false,
    'the synchronous save event wins even when saved bytes retain identical stats'
  );

  const externalTracker = scanflow.createDirtyTracker();
  externalTracker.markSweepDone(externalTracker.peek());
  createDidSaveHandler(
    (resourceKey) => externalTracker.markChanged(resourceKey),
    () => false
  )(document('/outside/External.cls', 'public class External {}', { isDirty: false }));
  assert.strictEqual(
    externalTracker.peek().dirty.size,
    0,
    'saving a supported file outside the workspace never enters incremental scan state'
  );
}

// End-to-end semantic proof: two dirty Apex snapshots replace disk facts in
// the index and create a call edge that exists only in unsaved text.
{
  const targetPath = '/ws/LiveTarget.cls';
  const callerPath = '/ws/LiveCaller.cls';
  const diskTarget = 'public class LiveTarget { public static void oldMethod() {} }';
  const diskCaller = 'public class LiveCaller { public static void run() { LiveTarget.oldMethod(); } }';
  const unsavedTarget = 'public class LiveTarget { public static void newMethod() {} }';
  const unsavedCaller = 'public class LiveCaller { public static void run() { LiveTarget.newMethod(); } }';
  const diskFacts = [
    parser.parseFile({ path: targetPath, text: diskTarget }),
    parser.parseFile({ path: callerPath, text: diskCaller }),
  ];
  const overlays = captureDirtyDocumentOverlays([
    document(targetPath, unsavedTarget),
    document(callerPath, unsavedCaller),
  ]);
  const applied = applyApexOverlays(
    diskFacts,
    new Set(['file://' + targetPath, 'file://' + callerPath]),
    overlays,
    parser.parseFile
  );
  assert.strictEqual(applied.overlaid, 2);
  assert.strictEqual(diskFacts[0].types[0].methods[0].name, 'oldMethod', 'disk-derived input is not mutated');
  const index = resolver.buildSemanticIndex(applied.factsList);
  const tree = resolver.buildCallerTree(index, { classLower: 'livetarget', methodLower: 'newmethod' });
  assert.ok(tree && tree.root);
  assert.strictEqual(tree.root.children[0].className, 'LiveCaller');
  assert.strictEqual(tree.root.children[0].methodLower, 'run');
}

// Metadata overlays replace or add only eligible scan paths, without
// mutating disk-derived file objects or leaking into the persisted Apex map.
{
  const metadataPath = '/ws/lwc/livePanel/livePanel.js';
  const diskFiles = [{ path: metadataPath, text: 'DISK_METADATA' }];
  const overlays = captureDirtyDocumentOverlays([
    document(metadataPath, 'UNSAVED_METADATA'),
    document('/outside/not-scanned.js', 'OUTSIDE_METADATA'),
  ]);
  const applied = applyMetadataOverlays(diskFiles, new Set(['file://' + metadataPath]), overlays);
  assert.deepStrictEqual(applied, {
    files: [{ path: metadataPath, text: 'UNSAVED_METADATA' }],
    overlaid: 1,
  });
  assert.strictEqual(diskFiles[0].text, 'DISK_METADATA');

  const diskCache = new Map([
    ['/ws/Cached.cls', { mtimeMs: 1, size: 10, facts: parser.parseFile({ path: '/ws/Cached.cls', text: 'public class Cached {}' }) }],
  ]);
  const persisted = cachestore.serializeSafeFactsCache(9, diskCache);
  assert.ok(!persisted.includes('UNSAVED_METADATA'));
  assert.ok(!persisted.includes('OUTSIDE_METADATA'));
}

// Same fsPath exposed by two remote authorities must never cross-apply an
// overlay. This is the collision that fsPath-only keys could not distinguish.
{
  const sharedFsPath = '/workspace/classes/Shared.cls';
  const alpha = document(sharedFsPath, 'public class AlphaOnly {}', {
    scheme: 'vscode-remote',
    authority: 'ssh-remote+alpha',
  });
  const beta = document(sharedFsPath, 'public class BetaOnly {}', {
    scheme: 'vscode-remote',
    authority: 'ssh-remote+beta',
  });
  const overlays = captureDirtyDocumentOverlays([alpha, beta]);
  assert.strictEqual(overlays.size, 2);
  const alphaKey = sourceKey(alpha);
  const betaKey = sourceKey(beta);
  assert.notStrictEqual(alphaKey, betaKey);
  const alphaDiskFacts = [parser.parseFile({ path: alphaKey, text: 'public class DiskAlpha {}' })];
  const applied = applyApexOverlays(alphaDiskFacts, new Set([alphaKey]), overlays, parser.parseFile);
  assert.strictEqual(applied.overlaid, 1);
  assert.strictEqual(applied.factsList[0].types[0].name, 'AlphaOnly');
  assert.ok(!JSON.stringify(applied.factsList).includes('BetaOnly'));
}

console.log('apex-call-graph editoroverlay.js self-check: all assertions passed');

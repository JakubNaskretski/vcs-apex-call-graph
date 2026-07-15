#!/usr/bin/env node
'use strict';
// Adversarial-verifier repro for H6 (freshness + cache tiebreak).
//
// (a) proves the size tiebreak (H6b) catches a same-mtime-different-size
//     edit: extension.js's scanAndParse must reparse a file whose mtime is
//     UNCHANGED but whose size changed, rather than trusting the stale
//     cached FileFacts.
// (b) proves showPathMap (H6a) reflects a file edit WITHOUT re-running the
//     interactive traceCallers/resolveTarget flow (no second QuickPick) --
//     it uses the stored lastTarget + a fresh scanAndParse+rebuild instead
//     of reusing a stale TreeResult.
//
// This builds a minimal in-memory mock of the 'vscode' module (this repo has
// no existing vscode-mock harness -- extension.js is otherwise untested
// outside the real extension host) and registers it in Module._load so
// extension.js's `require('vscode')` resolves to it. Files under dev/ only;
// does not modify extension.js/cachestore.js.

const path = require('path');
const Module = require('module');

// ---------------------------------------------------------------------------
// Virtual filesystem: fsPath -> { text, mtime }. size is ALWAYS derived from
// text.length (Buffer byte length) at stat-time -- exactly like a real fs --
// so "same mtime, different size" falls naturally out of editing `text`
// without touching `mtime`.
// ---------------------------------------------------------------------------
const vfs = new Map();
function vfsWrite(fsPath, text, mtime) {
  const prev = vfs.get(fsPath);
  vfs.set(fsPath, { text, mtime: mtime !== undefined ? mtime : (prev ? prev.mtime : 1000) });
}

const CLASS_A = 'A.cls';
const CLASS_B = 'B.cls';
const pA = path.join(__dirname, CLASS_A);
const pB = path.join(__dirname, CLASS_B);

vfsWrite(pA, `public class A { public void target(){ } }`, 5000);
// v1 of B: a single call site to A.target()
vfsWrite(pB, `public class B { public void caller1(){ A a = new A(); a.target(); } }`, 5000);

// ---------------------------------------------------------------------------
// Mock vscode module
// ---------------------------------------------------------------------------
let quickPickCalls = 0;
let quickPickAnswer = null; // set before each computeTrace() that must resolve interactively

const events = []; // captured showInformationMessage/showWarningMessage text, for debugging

function mkUri(fsPath) { return { fsPath }; }

const mockVscode = {
  EventEmitter: class {
    constructor() { this._h = []; }
    get event() { return (fn) => { this._h.push(fn); }; }
    fire() { for (const h of this._h) h(); }
  },
  TreeItem: class {
    constructor(label, state) { this.label = label; this.collapsibleState = state; }
  },
  TreeItemCollapsibleState: { Collapsed: 1, None: 0 },
  ThemeIcon: class { constructor(id) { this.id = id; } },
  Uri: { file: mkUri },
  Range: class { constructor(a, b, c, d) { this.args = [a, b, c, d]; } },
  ProgressLocation: { Notification: 1 },
  ViewColumn: { Beside: 1, One: 2 },
  workspace: {
    findFiles: async (glob) => {
      // Only care about the **/*.{cls,trigger,apex} glob for this repro --
      // metadata globs (lwc/aura/flow/omniscript/vf) match nothing in this
      // virtual fs, which is fine (A7 metadata indexing is additive/best-effort).
      if (typeof glob === 'string' && /\.\{cls,trigger,apex\}/.test(glob)) {
        return [...vfs.keys()].map(mkUri);
      }
      return [];
    },
    fs: {
      stat: async (uri) => {
        const e = vfs.get(uri.fsPath);
        if (!e) throw new Error('ENOENT: ' + uri.fsPath);
        return { mtime: e.mtime, size: Buffer.byteLength(e.text, 'utf8') };
      },
      readFile: async (uri) => {
        const e = vfs.get(uri.fsPath);
        if (!e) throw new Error('ENOENT: ' + uri.fsPath);
        return Buffer.from(e.text, 'utf8');
      },
    },
  },
  window: {
    activeTextEditor: undefined, // forces resolveTarget() down the QuickPick path
    createTreeView: () => ({ }),
    withProgress: async (opts, task) => task({ report: () => {} }),
    showWarningMessage: (msg) => { events.push(['warn', msg]); },
    showInformationMessage: (msg) => { events.push(['info', msg]); },
    setStatusBarMessage: () => {},
    showQuickPick: async () => { quickPickCalls++; return quickPickAnswer; },
    createWebviewPanel: () => {
      const panel = {
        webview: { html: '', onDidReceiveMessage: () => {} },
        onDidDispose: () => {},
        reveal: () => {},
      };
      return panel;
    },
  },
  commands: {
    _registry: new Map(),
    registerCommand(name, fn) { this._registry.set(name, fn); return { dispose() {} }; },
    executeCommand: async () => {},
  },
};

// Intercept require('vscode') to return our mock, without needing a real
// node_modules/vscode shim on disk.
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (request === 'vscode') return 'vscode';
  return origResolve.call(this, request, ...rest);
};
require.cache['vscode'] = { id: 'vscode', filename: 'vscode', loaded: true, exports: mockVscode };

const extension = require(path.join(__dirname, '..', 'extension.js'));

// ---------------------------------------------------------------------------
// Fake ExtensionContext -- globalStorageUri hydration/persist paths are
// exercised too (best-effort, wrapped in try/catch in activate()), pointed
// at a scratch dir under dev/ so nothing outside dev/ is touched.
// ---------------------------------------------------------------------------
const fs = require('fs');
const storageDir = path.join(__dirname, '.h6-scratch-storage');
if (!fs.existsSync(storageDir)) fs.mkdirSync(storageDir, { recursive: true });

const context = {
  subscriptions: [],
  globalStorageUri: { fsPath: storageDir },
};

let failures = 0;
function assert(cond, msg) {
  if (!cond) { failures++; console.error('FAIL: ' + msg); } else { console.log('PASS: ' + msg); }
}

async function main() {
  await extension.activate(context);
  const registry = mockVscode.commands._registry;
  assert(registry.has('apexTrace.traceCallers'), 'apexTrace.traceCallers command registered');
  assert(registry.has('apexTrace.showPathMap'), 'apexTrace.showPathMap command registered');

  // --- Round 1: trace A.target's CALLERS interactively (sets lastTarget) --
  // (B.caller1 is a call SITE, not the trace target -- tracing callers of
  // A.target is what surfaces B.caller1's call site(s) in the tree/map.)
  quickPickAnswer = { target: { classLower: 'a', methodLower: 'target' } };
  const traceFn = registry.get('apexTrace.traceCallers');
  await traceFn();
  assert(quickPickCalls === 1, 'round 1: exactly one QuickPick shown (interactive resolveTarget ran once)');

  // --- H6(b): edit B.cls, SAME mtime, DIFFERENT size -----------------------
  // Add a second call site inside caller1 -- same mtime (5000, untouched),
  // strictly larger size. A same-mtime-only cache check would wrongly reuse
  // the v1 FileFacts (missing the new call site); the mtimeMs+size tiebreak
  // must force a reparse.
  const v1 = vfs.get(pB).text;
  const v2 = `public class B { public void caller1(){ A a = new A(); a.target(); a.target(); } }`;
  assert(Buffer.byteLength(v2) !== Buffer.byteLength(v1), 'sanity: v2 has a different byte size than v1');
  vfsWrite(pB, v2, 5000); // mtime UNCHANGED
  assert(vfs.get(pB).mtime === 5000, 'sanity: B.cls mtime unchanged after edit');

  // --- H6(a): showPathMap must reflect the edit WITHOUT a second QuickPick -
  const showPathMapFn = registry.get('apexTrace.showPathMap');
  const qpBefore = quickPickCalls;
  quickPickAnswer = null; // if resolveTarget ran again it would find no QuickPick answer and abort
  await showPathMapFn();
  assert(quickPickCalls === qpBefore, 'showPathMap did not re-invoke the interactive QuickPick (used lastTarget, not re-run traceCallers)');

  // The webview panel's html is the only externally-observable signal here;
  // pathmap.js renders every call-site's rendered line text into the HTML,
  // so the SECOND `a.target();` call (only present in v2) must appear twice
  // in the site listing if the retrace actually picked up the edit.
  // We can't reach into mapPanel (module-private), so instead directly
  // rebuild via the public resolver contract to confirm the SAME source file
  // content produces 2 call sites -- this corroborates that scanAndParse (as
  // exercised through activate()'s real code path above) is the thing
  // capable of catching the edit, which is what round-trips through
  // showPathMap's retraceLastTarget. To directly observe the panel content,
  // we monkeypatch createWebviewPanel to capture the html that gets set.
  console.log('(no assertion failure above means: same-mtime/different-size edit was NOT silently served stale from cache and no re-QuickPick occurred)');
}

// Capture webview html to directly prove content freshness (re-activate with
// a capturing panel factory) -- rerun the whole scenario cleanly.
async function mainWithHtmlCapture() {
  // Fresh module instance isn't possible without clearing require cache for
  // extension.js's closures (fileCache is module-level); instead, reset vfs
  // to v1, re-activate fresh state by clearing require cache for extension.js.
  delete require.cache[require.resolve(path.join(__dirname, '..', 'extension.js'))];
  vfsWrite(pB, `public class B { public void caller1(){ A a = new A(); a.target(); } }`, 5000);

  let capturedHtml = null;
  mockVscode.window.createWebviewPanel = () => {
    const panel = {
      webview: {
        _html: '',
        get html() { return this._html; },
        set html(v) { this._html = v; capturedHtml = v; },
        onDidReceiveMessage: () => {},
      },
      onDidDispose: () => {},
      reveal: () => {},
    };
    return panel;
  };

  const ext2 = require(path.join(__dirname, '..', 'extension.js'));
  const ctx2 = { subscriptions: [], globalStorageUri: { fsPath: storageDir } };
  await ext2.activate(ctx2);
  const reg2 = mockVscode.commands._registry;

  quickPickAnswer = { target: { classLower: 'a', methodLower: 'target' } };
  await reg2.get('apexTrace.traceCallers')();
  const qpCount1 = quickPickCalls;

  const countCallSites = (html) => (html.match(/a\.target\(\)/g) || []).length;
  const before = countCallSites(capturedHtml || '');

  // showPathMap right after traceCallers (no edit yet) opens the panel too --
  // this call also lets us prime capturedHtml deterministically before the edit.
  quickPickAnswer = null;
  await reg2.get('apexTrace.showPathMap')();
  const afterFirstMap = countCallSites(capturedHtml || '');

  // Now edit: same mtime, bigger size, second call site added.
  vfsWrite(pB, `public class B { public void caller1(){ A a = new A(); a.target(); a.target(); } }`, 5000);
  await reg2.get('apexTrace.showPathMap')();
  const afterEdit = countCallSites(capturedHtml || '');

  assert(quickPickCalls === qpCount1, 'html-capture run: showPathMap calls never triggered an extra QuickPick after the initial trace');
  assert(afterFirstMap >= 1, 'html-capture run: path map html contains at least one target() call-site mention pre-edit');
  assert(afterEdit > afterFirstMap, `html-capture run: path map html reflects the edit (call-site mentions grew ${afterFirstMap} -> ${afterEdit}) without re-running traceCallers`);
}

main()
  .then(mainWithHtmlCapture)
  .then(() => {
    console.log('\n=== H6 verify summary ===');
    console.log(failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`);
    process.exit(failures === 0 ? 0 : 1);
  })
  .catch((e) => {
    console.error('ERROR', e);
    process.exit(1);
  });

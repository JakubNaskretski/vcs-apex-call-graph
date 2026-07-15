#!/usr/bin/env node
'use strict';
// Adversarial-verifier repro for H5(c): extension.js's resolveTarget /
// resolveCursorAmbiguity decision logic for the 'svc.process()' cursor-
// ambiguity cases from the goal spec.
//
// resolveCursorAmbiguity is module-private (extension.js exports only
// {activate, deactivate}), so this drives it end-to-end through the real
// extension.js via a mock 'vscode' module (same technique as
// dev/verify-h6-freshness-tiebreak.js) with a mock activeTextEditor/document
// simulating cursor placement -- this exercises the ACTUAL decision logic,
// not a reimplementation of it. Files under dev/ only.

const path = require('path');
const Module = require('module');
const fs = require('fs');

const vfs = new Map();
function vfsWrite(fsPath, text, mtime) { vfs.set(fsPath, { text, mtime: mtime || 1000 }); }

function mkUri(fsPath) { return { fsPath }; }

let quickPickCalls = [];      // [{picks, options}]
let quickPickAnswer = null;
let infoMessages = [];

const mockVscode = {
  EventEmitter: class {
    constructor() { this._h = []; }
    get event() { return (fn) => { this._h.push(fn); }; }
    fire() { for (const h of this._h) h(); }
  },
  TreeItem: class { constructor(label, state) { this.label = label; this.collapsibleState = state; } },
  TreeItemCollapsibleState: { Collapsed: 1, None: 0 },
  ThemeIcon: class { constructor(id) { this.id = id; } },
  Uri: { file: mkUri },
  Range: class { constructor(a, b, c, d) { this.args = [a, b, c, d]; } },
  ProgressLocation: { Notification: 1 },
  ViewColumn: { Beside: 1, One: 2 },
  workspace: {
    findFiles: async (glob) => {
      if (typeof glob === 'string' && /\.\{cls,trigger,apex\}/.test(glob)) return [...vfs.keys()].map(mkUri);
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
    activeTextEditor: undefined,
    createTreeView: () => (mockVscode._lastView = {}),
    withProgress: async (opts, task) => task({ report: () => {} }),
    showWarningMessage: () => {},
    showInformationMessage: (msg) => { infoMessages.push(msg); },
    setStatusBarMessage: () => {},
    showQuickPick: async (picks, options) => {
      quickPickCalls.push({ picks, options });
      return quickPickAnswer;
    },
    createWebviewPanel: () => ({ webview: { html: '', onDidReceiveMessage: () => {} }, onDidDispose: () => {}, reveal: () => {} }),
  },
  commands: {
    _registry: new Map(),
    registerCommand(name, fn) { this._registry.set(name, fn); return { dispose() {} }; },
    executeCommand: async () => {},
  },
};

const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (request === 'vscode') return 'vscode';
  return origResolve.call(this, request, ...rest);
};
require.cache['vscode'] = { id: 'vscode', filename: 'vscode', loaded: true, exports: mockVscode };

const extPath = path.join(__dirname, '..', 'extension.js');

function mkEditor({ fsPath, fullText, cursorLineText, word }) {
  return {
    document: {
      fileName: fsPath,
      getWordRangeAtPosition: () => ({}), // any truthy range; getText(range) below ignores its shape
      getText: (range) => (range === undefined ? fullText : word),
      lineAt: () => ({ text: cursorLineText }),
    },
    selection: { active: { line: 0, character: 0 } },
  };
}

let failures = 0;
function assert(cond, msg) {
  if (!cond) { failures++; console.error('FAIL: ' + msg); } else { console.log('PASS: ' + msg); }
}

async function freshExtension() {
  delete require.cache[require.resolve(extPath)];
  return require(extPath);
}

async function runScenario(name, { fooBody, barBody, cursorLineText, editorEnabled }) {
  vfs.clear();
  quickPickCalls = [];
  infoMessages = [];
  quickPickAnswer = null;

  // NOTE: resolveTarget derives the "enclosing class" strictly from the
  // active editor's FILENAME basename (minus extension), matched against
  // index.classes -- it must be exactly 'Foo.cls'/'Bar.cls' (matching the
  // Apex `class Foo`/`class Bar` declarations below), not a scenario-
  // prefixed name, or the enclosing-class lookup silently misses and this
  // whole test would be exercising the wrong code path.
  const fooText = `public class Foo { public void process(){ } public void run(){ ${fooBody} } }`;
  const barText = `public class Bar { public void process(){ ${barBody || ''} } }`;
  const pFoo = path.join(__dirname, `.h5c-scratch-${name}`, 'Foo.cls');
  const pBar = path.join(__dirname, `.h5c-scratch-${name}`, 'Bar.cls');
  vfsWrite(pFoo, fooText);
  vfsWrite(pBar, barText);

  mockVscode.window.activeTextEditor = editorEnabled
    ? mkEditor({ fsPath: pFoo, fullText: fooText, cursorLineText, word: 'process' })
    : undefined;

  const ext = await freshExtension();
  const ctx = { subscriptions: [], globalStorageUri: { fsPath: path.join(__dirname, '.h5c-scratch') } };
  if (!fs.existsSync(ctx.globalStorageUri.fsPath)) fs.mkdirSync(ctx.globalStorageUri.fsPath, { recursive: true });
  await ext.activate(ctx);
  const reg = mockVscode.commands._registry;
  await reg.get('apexTrace.traceCallers')();

  return { quickPickCalls: quickPickCalls.slice(), infoMessages: infoMessages.slice(), viewDescription: mockVscode._lastView && mockVscode._lastView.description };
}

async function main() {
  // -------------------------------------------------------------------
  // Case 1: svc.process() where svc's declared type (Bar) DOES resolve and
  // DOES declare process() -> 2-item QuickPick (enclosing vs receiver),
  // per H5(c) spec. Simulate the user picking the RECEIVER's method.
  // -------------------------------------------------------------------
  {
    quickPickAnswer = null; // set after we see the picks, since it must echo pick[1]
    const fooBody = 'Bar svc = new Bar(); svc.process();';
    const cursorLineText = 'Bar svc = new Bar(); svc.process();';
    // Need quickPickAnswer available BEFORE traceCallers runs; showQuickPick
    // is called with the actual picks array, so set the answer via a
    // one-shot wrapper that echoes picks[1] (the receiver option).
    mockVscode.window.showQuickPick = async (picks, options) => {
      quickPickCalls.push({ picks, options });
      return picks[1]; // choose the receiver's method
    };
    const res = await runScenario('case1', { fooBody, barBody: '', cursorLineText, editorEnabled: true });
    assert(res.quickPickCalls.length === 1, 'case 1: resolveCursorAmbiguity showed exactly one QuickPick');
    const qp = res.quickPickCalls[0];
    assert(qp.picks.length === 2, 'case 1: QuickPick offered exactly 2 items (enclosing vs receiver)');
    assert(qp.picks[0].label === 'Foo.process' && qp.picks[0].description === 'enclosing class', 'case 1: pick[0] is the enclosing class option');
    assert(qp.picks[1].label === 'Bar.process' && /via 'svc\.'/.test(qp.picks[1].description), "case 1: pick[1] is the receiver's method option, labeled via 'svc.'");
    assert(/ambiguous/i.test(qp.options.placeHolder), 'case 1: QuickPick placeholder calls out the ambiguity');
    assert(res.viewDescription && res.viewDescription.startsWith('Bar.process'), `case 1: picking the receiver option actually traces Bar.process, not Foo.process (view.description="${res.viewDescription}")`);
  }

  // -------------------------------------------------------------------
  // Case 2: svc.process() where svc's type does NOT resolve to a class
  // that declares process() (unknown/unresolvable type) -> falls back to
  // the enclosing class's method WITH an explicit note, no QuickPick.
  // -------------------------------------------------------------------
  {
    mockVscode.window.showQuickPick = async (picks, options) => {
      quickPickCalls.push({ picks, options });
      return quickPickAnswer;
    };
    const fooBody = 'UnknownWidget svc = new UnknownWidget(); svc.process();';
    const cursorLineText = 'UnknownWidget svc = new UnknownWidget(); svc.process();';
    const res = await runScenario('case2', { fooBody, cursorLineText, editorEnabled: true });
    assert(res.quickPickCalls.length === 0, 'case 2: unresolvable receiver type shows NO QuickPick');
    assert(res.infoMessages.some((m) => /could not be resolved/.test(m) && /enclosing class's 'process' instead/.test(m)),
      "case 2: an explicit info note explains the fallback to the enclosing class's method");
    assert(res.viewDescription && res.viewDescription.startsWith('Foo.process'), `case 2: fallback actually traces Foo.process, the enclosing class (view.description="${res.viewDescription}")`);
  }

  // -------------------------------------------------------------------
  // Case 3: this.process() -- receiver is literally 'this' -> NEVER
  // ambiguous (excluded by the receiverIdent !== 'this' guard); resolves
  // straight to the enclosing method, no QuickPick, no ambiguity note.
  // -------------------------------------------------------------------
  {
    const fooBody = 'this.process();';
    const cursorLineText = 'this.process();';
    const res = await runScenario('case3', { fooBody, cursorLineText, editorEnabled: true });
    assert(res.quickPickCalls.length === 0, "case 3: this.process() shows NO QuickPick (receiver === 'this' is never ambiguous)");
    assert(!res.infoMessages.some((m) => /ambiguous|could not be resolved/i.test(m)), 'case 3: no ambiguity-related note shown for this.process()');
  }

  // -------------------------------------------------------------------
  // Case 4: bare process() call, no receiver at all -> not ambiguous,
  // resolves straight to the enclosing method exactly as pre-H5(c).
  // -------------------------------------------------------------------
  {
    const fooBody = 'process();';
    const cursorLineText = 'process();';
    const res = await runScenario('case4', { fooBody, cursorLineText, editorEnabled: true });
    assert(res.quickPickCalls.length === 0, 'case 4: bare process() call shows NO QuickPick');
    assert(!res.infoMessages.some((m) => /ambiguous|could not be resolved/i.test(m)), 'case 4: no ambiguity-related note shown for bare process()');
  }

  // -------------------------------------------------------------------
  // Case 5: svc.process() but cursor's word does NOT match an enclosing-
  // class method at all -- resolveCursorAmbiguity must never even be
  // reached (the H5(c) guard is gated on "word ALSO matches an enclosing
  // method"); this is the pre-existing non-enclosing-method path.
  // -------------------------------------------------------------------
  {
    // Foo has no 'process' method in THIS variant (renamed to differentiate) --
    // instead cursor sits on a method name that Foo never declares, so the
    // 'hasMethod' gate in resolveTarget is false and ambiguity resolution is
    // skipped entirely; resolveTarget falls through to its OWN-class-only
    // suggestTargets/QuickPick path (a DIFFERENT QuickPick, not the 2-item
    // ambiguity one -- distinguished by its placeholder/pick shape).
    vfs.clear();
    quickPickCalls = [];
    infoMessages = [];
    const fooText = `public class Foo { public void run(){ Bar svc = new Bar(); svc.process(); } }`; // no Foo.process()
    const barText = `public class Bar { public void process(){ } }`;
    const pFoo = path.join(__dirname, '.h5c-scratch-case5', 'Foo.cls');
    const pBar = path.join(__dirname, '.h5c-scratch-case5', 'Bar.cls');
    vfsWrite(pFoo, fooText);
    vfsWrite(pBar, barText);
    mockVscode.window.activeTextEditor = mkEditor({ fsPath: pFoo, fullText: fooText, cursorLineText: 'Bar svc = new Bar(); svc.process();', word: 'process' });
    mockVscode.window.showQuickPick = async (picks, options) => {
      quickPickCalls.push({ picks, options });
      return null; // cancel -- we only care whether/how it was invoked
    };
    const ext = await freshExtension();
    const ctx = { subscriptions: [], globalStorageUri: { fsPath: path.join(__dirname, '.h5c-scratch') } };
    await ext.activate(ctx);
    await mockVscode.commands._registry.get('apexTrace.traceCallers')();
    assert(quickPickCalls.length === 1, 'case 5: exactly one QuickPick shown, but it is the GLOBAL suggestTargets picker, not the 2-item ambiguity picker');
    assert(quickPickCalls[0].picks.length !== 2 || !quickPickCalls[0].picks.some((p) => p.description === 'enclosing class'),
      "case 5: the shown QuickPick is not the ambiguity guard's 2-item {enclosing class}/{via 'svc.'} shape (word doesn't match an enclosing-class method, so H5(c)'s guard never fires)");
  }
}

main().then(() => {
  console.log('\n=== H5(c) cursor-ambiguity verify summary ===');
  console.log(failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`);
  process.exit(failures === 0 ? 0 : 1);
}).catch((e) => {
  console.error('ERROR', e);
  process.exit(1);
});

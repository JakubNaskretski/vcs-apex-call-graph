#!/usr/bin/env node
'use strict';

// Regression harness for the singleton Path Map panel. It drives the real
// extension command registrations through a small in-memory VS Code host:
// invoke Show Path Map on one Apex class, move the active editor to another
// class, invoke it again, and prove the same panel is overwritten.

const path = require('path');
const Module = require('module');

const repoRoot = path.join(__dirname, '..');
const workspaceRoot = path.join(__dirname, '.path-map-retarget-workspace');
const firstPath = path.join(workspaceRoot, 'MapFirst.cls');
const secondPath = path.join(workspaceRoot, 'MapSecond.cls');
const callerPath = path.join(workspaceRoot, 'MapCaller.cls');
const sourceByPath = new Map([
  [firstPath, 'public class MapFirst { public void run() {} }'],
  [secondPath, 'public class MapSecond { public void run() {} }'],
  [callerPath, [
    'public class MapCaller {',
    '  public void callFirst() { new MapFirst().run(); }',
    '  public void callSecond() { new MapSecond().run(); }',
    '}',
  ].join('\n')],
]);

function fileUri(fsPath) {
  return {
    scheme: 'file',
    authority: '',
    path: fsPath,
    fsPath,
    toString() { return `file://${fsPath}`; },
  };
}

function missing() {
  const error = new Error('not found');
  error.code = 'FileNotFound';
  return error;
}

const workspaceFolder = { name: 'path-map-retarget', uri: fileUri(workspaceRoot) };
let panelCreates = 0;
let panelReveals = 0;
let finalHtml = '';
let quickPickCalls = 0;
let panelMessageHandler = null;
let pathMapPanel = null;
const openedDocuments = [];

const mockVscode = {
  EventEmitter: class {
    constructor() { this.handlers = []; }
    get event() {
      return (handler) => {
        this.handlers.push(handler);
        return { dispose() {} };
      };
    }
    fire(value) { for (const handler of this.handlers) handler(value); }
    dispose() {}
  },
  TreeItem: class { constructor(label, state) { this.label = label; this.collapsibleState = state; } },
  TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
  ThemeIcon: class { constructor(id) { this.id = id; } },
  Position: class { constructor(line, character) { this.line = line; this.character = character; } },
  Range: class { constructor(a, b, c, d) { this.values = [a, b, c, d]; } },
  ProgressLocation: { Notification: 1 },
  ViewColumn: { Active: -1, Beside: -2, One: 1, Two: 2 },
  Uri: {
    file: fileUri,
    parse(value) { return fileUri(String(value).replace(/^file:\/\//, '')); },
    joinPath(base, ...parts) { return fileUri(path.join(base.fsPath, ...parts)); },
  },
  workspace: {
    workspaceFolders: [workspaceFolder],
    textDocuments: [],
    getWorkspaceFolder: () => workspaceFolder,
    getConfiguration: () => ({ get: () => undefined }),
    findFiles: async (glob) => {
      if (typeof glob === 'string' && /\.\{cls,trigger,apex\}/.test(glob)) {
        return [...sourceByPath.keys()].map(fileUri);
      }
      return [];
    },
    fs: {
      readDirectory: async () => [],
      createDirectory: async () => {},
      writeFile: async () => {},
      delete: async () => {},
      stat: async (uri) => {
        const text = sourceByPath.get(uri.fsPath);
        if (text == null) throw missing();
        return { mtime: 1000, size: Buffer.byteLength(text, 'utf8') };
      },
      readFile: async (uri) => {
        const text = sourceByPath.get(uri.fsPath);
        if (text == null) throw missing();
        return Buffer.from(text, 'utf8');
      },
    },
    createFileSystemWatcher: () => ({
      onDidChange: () => ({ dispose() {} }),
      onDidCreate: () => ({ dispose() {} }),
      onDidDelete: () => ({ dispose() {} }),
      dispose() {},
    }),
    onDidSaveTextDocument: () => ({ dispose() {} }),
    onDidChangeWorkspaceFolders: () => ({ dispose() {} }),
  },
  window: {
    activeTextEditor: undefined,
    createTreeView: () => ({ dispose() {} }),
    createOutputChannel: () => ({ appendLine() {}, dispose() {} }),
    withProgress: async (_options, task) => task(
      { report() {} },
      { isCancellationRequested: false, onCancellationRequested: () => ({ dispose() {} }) }
    ),
    showQuickPick: async () => { quickPickCalls++; return null; },
    showWarningMessage: () => {},
    showInformationMessage: () => {},
    showErrorMessage: () => {},
    setStatusBarMessage: () => {},
    showTextDocument: async (uri, options) => { openedDocuments.push({ uri, options }); },
    createWebviewPanel: () => {
      panelCreates++;
      pathMapPanel = {
        // createWebviewPanel receives the `Beside` sentinel, while the
        // resulting panel reports its concrete editor-group column.
        viewColumn: mockVscode.ViewColumn.Two,
        webview: {
          get html() { return finalHtml; },
          set html(value) { finalHtml = value; },
          onDidReceiveMessage: (handler) => {
            panelMessageHandler = handler;
            return { dispose() {} };
          },
          postMessage: async () => true,
        },
        onDidDispose: () => ({ dispose() {} }),
        reveal: () => { panelReveals++; },
        dispose() {},
      };
      return pathMapPanel;
    },
  },
  commands: {
    registry: new Map(),
    registerCommand(name, handler) {
      this.registry.set(name, handler);
      return { dispose() {} };
    },
    executeCommand: async () => {},
  },
  env: { clipboard: { writeText: async () => {} } },
};

function editorFor(fsPath, className, version) {
  const text = sourceByPath.get(fsPath);
  const uri = fileUri(fsPath);
  return {
    selection: { active: { line: 0, character: 13 } },
    document: {
      uri,
      fileName: fsPath,
      version,
      getWordRangeAtPosition: () => ({}),
      getText: (range) => (range ? className : text),
      lineAt: () => ({ text }),
    },
  };
}

const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (request === 'vscode') return 'vscode';
  return originalResolve.call(this, request, ...rest);
};
require.cache.vscode = { id: 'vscode', filename: 'vscode', loaded: true, exports: mockVscode };

let failures = 0;
function check(condition, message) {
  if (condition) console.log(`PASS: ${message}`);
  else {
    failures++;
    console.error(`FAIL: ${message}`);
  }
}

async function main() {
  const extension = require(path.join(repoRoot, 'extension.js'));
  const context = {
    subscriptions: [],
    globalStorageUri: fileUri(path.join(workspaceRoot, '.storage')),
    workspaceState: { get: () => undefined, update: async () => {} },
  };
  await extension.activate(context);
  const showPathMap = mockVscode.commands.registry.get('apexTrace.showPathMap');
  const refreshPathMap = mockVscode.commands.registry.get('apexTrace.refreshPathMap');
  check(typeof showPathMap === 'function', 'selection-sensitive Show Path Map command is registered');
  check(typeof refreshPathMap === 'function', 'last-target Refresh Path Map command is registered');

  mockVscode.window.activeTextEditor = editorFor(firstPath, 'MapFirst', 1);
  await showPathMap();
  const firstHtml = finalHtml;
  check(firstHtml.includes('MapFirst'), 'first invocation renders the first selected class');
  check(!firstHtml.includes('MapSecond'), 'first map does not leak the unrelated second branch');

  mockVscode.window.activeTextEditor = editorFor(secondPath, 'MapSecond', 1);
  await showPathMap();
  const secondHtml = finalHtml;
  check(secondHtml.includes('MapSecond'), 'second invocation renders the newly selected class');
  check(!secondHtml.includes('MapFirst'), 'second invocation replaces rather than merges the old map');
  check(firstHtml !== secondHtml, 'the panel HTML changes when the selected target changes');
  check(panelCreates === 1, 'both invocations reuse exactly one singleton panel');
  check(panelReveals === 2, 'the singleton panel is revealed after each invocation');
  check(quickPickCalls === 0, 'both class targets resolve directly from their captured editors');

  await refreshPathMap();
  check(finalHtml.includes('MapSecond') && !finalHtml.includes('MapFirst'),
    'view-title refresh keeps the last resolved target instead of following a moved cursor');

  const mapHtmlBeforeNavigation = finalHtml;
  pathMapPanel.viewColumn = mockVscode.ViewColumn.One;
  await panelMessageHandler({ type: 'open', path: firstPath, line: 1, col: 0 });
  check(openedDocuments.at(-1).options.viewColumn === mockVscode.ViewColumn.Beside,
    'a map in column one opens source beside it instead of replacing it');
  check(finalHtml === mapHtmlBeforeNavigation,
    'source navigation from a one-column layout leaves the map HTML intact');

  pathMapPanel.viewColumn = mockVscode.ViewColumn.Two;
  await panelMessageHandler({ type: 'open', path: secondPath, line: 1, col: 0 });
  check(openedDocuments.at(-1).options.viewColumn === mockVscode.ViewColumn.One,
    'a map in column two reuses the other editor group for source');
  check(finalHtml === mapHtmlBeforeNavigation,
    'source navigation from a two-column layout leaves the map HTML intact');

  await extension.deactivate();
  console.log('\n=== Path Map retarget verify summary ===');
  console.log(failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`);
  process.exitCode = failures === 0 ? 0 : 1;
}

main().catch((error) => {
  console.error('ERROR', error);
  process.exitCode = 1;
});

#!/usr/bin/env node
'use strict';
// Adversarial semantics-attack probe for v0.7 Feature B, part 2: sfdx-project.json
// discovery edge cases (missing 'path', absolute paths, nested packageDirectories/
// longest-prefix, duplicate 'default' flags, malformed JSON fallback) PLUS a
// live end-to-end repro of the real extension.js code path (activate() +
// registered command) against the REAL adv-org corpus, to check whether
// discoverPackageMap()'s output actually reaches buildSemanticIndex() the way
// MANIFEST's B2 (default-package fallback) requires.
//
// Two harnesses:
//   PART 1 -- a synthetic, in-memory-filesystem vscode mock isolating
//             discoverPackageMap() itself (extracted from extension.js via a
//             non-persisted, in-memory source instrumentation -- extension.js
//             on disk is never modified) against hostile sfdx-project.json
//             shapes.
//   PART 2 -- the REAL extension.js, REAL corpus on disk, driven through its
//             actual activate()+traceCallees command, to see whether B2's
//             default-package-fallback edge (NovaSharedBillingBridge ->
//             AcmeOrderUtil.buildQuery, force-app) actually resolves live.

const fs = require('fs');
const path = require('path');
const Module = require('module');
const vm = require('vm');

let failures = [];
function check(label, cond, detail) {
  if (cond) {
    console.log(`PASS  ${label}`);
  } else {
    console.log(`FAIL  ${label}${detail ? ' -- ' + detail : ''}`);
    failures.push(label);
  }
}

// =========================================================================
// PART 1: isolate discoverPackageMap() (+ its normalizePathForPrefix helper)
// from extension.js via an in-memory CommonJS module built from the SAME
// source text on disk, with one appended line exposing the two functions on
// module.exports (never written to disk -- extension.js itself is untouched;
// this is purely an in-process instrumentation of a string copy so the exact
// shipped algorithm is under test, not a reimplementation of it).
// =========================================================================
function loadDiscoverPackageMap(vscodeMock) {
  const extPath = path.join(__dirname, '..', 'extension.js');
  let src = fs.readFileSync(extPath, 'utf8');
  src += '\nmodule.exports.__discoverPackageMap = discoverPackageMap;\nmodule.exports.__normalizePathForPrefix = normalizePathForPrefix;\n';

  const mod = new Module(extPath, module);
  mod.filename = extPath;
  mod.paths = Module._nodeModulePaths(path.dirname(extPath));
  const origResolve = Module._resolveFilename;
  const localRequire = function (request) {
    if (request === 'vscode') return vscodeMock;
    return mod.require(request);
  };
  const wrapper = Module.wrap(src);
  const compiled = vm.runInThisContext(wrapper, { filename: extPath });
  compiled.call(mod.exports, mod.exports, localRequire, mod, extPath, path.dirname(extPath));
  return { discoverPackageMap: mod.exports.__discoverPackageMap, normalizePathForPrefix: mod.exports.__normalizePathForPrefix };
}

function mkUri(fsPath) { return { fsPath }; }

function mockVscodeFor(virtualFiles) {
  // virtualFiles: { [fsPath]: string (file content) }
  const uris = Object.keys(virtualFiles)
    .filter((p) => p.endsWith('sfdx-project.json'))
    .map(mkUri);
  return {
    EventEmitter: class { constructor() { this._h = []; } get event() { return (fn) => this._h.push(fn); } fire() {} },
    workspace: {
      findFiles: async () => uris,
      fs: {
        readFile: async (uri) => {
          if (!(uri.fsPath in virtualFiles)) throw new Error('ENOENT ' + uri.fsPath);
          return Buffer.from(virtualFiles[uri.fsPath], 'utf8');
        },
      },
    },
    window: {},
    commands: { registerCommand: () => ({ dispose() {} }) },
    ThemeIcon: class {},
    TreeItem: class {},
    TreeItemCollapsibleState: { Collapsed: 1, None: 0 },
    Uri: { file: mkUri },
    ProgressLocation: { Notification: 1 },
    ViewColumn: { Beside: 1 },
  };
}

async function part1() {
  console.log('\n--- PART 1: discoverPackageMap() hostile sfdx-project.json shapes ---');

  // --- 7a: missing 'path' on one packageDirectories entry -- must be
  // skipped (never throw), the OTHER valid entries still register.
  {
    const files = {
      '/ws1/sfdx-project.json': JSON.stringify({
        packageDirectories: [
          { package: 'no-path-here' }, // missing 'path' entirely
          { path: 'force-app', default: true },
        ],
      }),
    };
    const vsc = mockVscodeFor(files);
    const { discoverPackageMap } = loadDiscoverPackageMap(vsc);
    let threw = null, packageOf;
    try { packageOf = await discoverPackageMap(); } catch (e) { threw = e; }
    check('7a. missing path entry does not throw', !threw, threw && threw.stack);
    if (packageOf) {
      check('7a. missing-path entry contributes NOTHING (no crash, no phantom prefix)', packageOf('/ws1/force-app/main/default/classes/X.cls') === 'force-app', 'got ' + packageOf('/ws1/force-app/main/default/classes/X.cls'));
      check('7a. an unrelated path stays null (not accidentally captured by the pathless entry)', packageOf('/ws1/somewhere-else/Y.cls') === null, 'got ' + packageOf('/ws1/somewhere-else/Y.cls'));
    }
  }

  // --- 7a-2: 'path' present but empty string / whitespace-only -- also must
  // be skipped, not treated as project-root match-everything.
  {
    const files = {
      '/ws2/sfdx-project.json': JSON.stringify({
        packageDirectories: [
          { path: '   ', package: 'blank-path' },
          { path: 'force-app', default: true },
        ],
      }),
    };
    const vsc = mockVscodeFor(files);
    const { discoverPackageMap } = loadDiscoverPackageMap(vsc);
    const packageOf = await discoverPackageMap();
    check('7a-2. whitespace-only path entry does not match everything under project root', packageOf('/ws2/some-random-dir/Z.cls') === null, 'got ' + packageOf('/ws2/some-random-dir/Z.cls'));
    check('7a-2. valid sibling entry (force-app) still resolves', packageOf('/ws2/force-app/classes/X.cls') === 'force-app');
  }

  // --- 7b: absolute path in packageDirectories.path (spec technically calls
  // for relative paths, but sfdx tolerates absolute; a hostile fixture must
  // not crash or produce a broken double-rooted prefix).
  {
    const files = {
      '/ws3/sfdx-project.json': JSON.stringify({
        packageDirectories: [
          { path: '/ws3/force-app', default: true }, // absolute path, same as would-be relative
        ],
      }),
    };
    const vsc = mockVscodeFor(files);
    const { discoverPackageMap } = loadDiscoverPackageMap(vsc);
    let threw = null, packageOf;
    try { packageOf = await discoverPackageMap(); } catch (e) { threw = e; }
    check('7b. absolute packageDirectories.path does not throw', !threw, threw && threw.stack);
    if (packageOf) {
      const label = packageOf('/ws3/force-app/classes/X.cls');
      console.log(`      (7b info) absolute-path prefix -> packageOf result for /ws3/force-app/classes/X.cls = ${JSON.stringify(label)}`);
      // Whatever the exact prefix concatenation produces, it must be
      // deterministic and not silently swallow the file into a bogus label
      // that breaks the badge logic (undefined/[object Object]/etc).
      check('7b. absolute-path result is either null or a clean string label', label === null || (typeof label === 'string' && label.length > 0 && !/\[object/.test(label)), 'got ' + JSON.stringify(label));
    }
  }

  // --- 7c: nested packageDirectories -- longest prefix wins.
  {
    const files = {
      '/ws4/sfdx-project.json': JSON.stringify({
        packageDirectories: [
          { path: 'force-app', default: true },
          { path: 'force-app/main/default/nested-pkg', package: 'nested-label' },
        ],
      }),
    };
    const vsc = mockVscodeFor(files);
    const { discoverPackageMap } = loadDiscoverPackageMap(vsc);
    const packageOf = await discoverPackageMap();
    const nestedFile = '/ws4/force-app/main/default/nested-pkg/classes/Deep.cls';
    const outerFile = '/ws4/force-app/main/default/classes/Shallow.cls';
    check('7c. file inside the nested dir gets the MORE SPECIFIC (longer-prefix) label', packageOf(nestedFile) === 'nested-label', 'got ' + packageOf(nestedFile));
    check('7c. file outside the nested dir (but inside outer) gets the outer label', packageOf(outerFile) === 'force-app', 'got ' + packageOf(outerFile));
  }

  // --- 7d: duplicate 'default: true' flags on multiple entries -- discovery
  // itself must not crash; note that discoverPackageMap doesn't even read
  // `default` (see PART 2 finding below), so this is really a not-crash check.
  {
    const files = {
      '/ws5/sfdx-project.json': JSON.stringify({
        packageDirectories: [
          { path: 'pkg-a', package: 'a', default: true },
          { path: 'pkg-b', package: 'b', default: true }, // second default:true, malformed sfdx
        ],
      }),
    };
    const vsc = mockVscodeFor(files);
    const { discoverPackageMap } = loadDiscoverPackageMap(vsc);
    let threw = null, packageOf;
    try { packageOf = await discoverPackageMap(); } catch (e) { threw = e; }
    check('7d. duplicate default:true entries do not throw', !threw, threw && threw.stack);
    if (packageOf) {
      check('7d. both packages still register correctly for prefix matching', packageOf('/ws5/pkg-a/X.cls') === 'a' && packageOf('/ws5/pkg-b/Y.cls') === 'b');
    }
  }

  // --- 7e: malformed JSON -- must fall back to packageless (packageOf
  // returns null for everything), never throw out of discoverPackageMap.
  {
    const files = {
      '/ws6/sfdx-project.json': '{ "packageDirectories": [ { "path": "force-app" ',  // truncated/invalid JSON
    };
    const vsc = mockVscodeFor(files);
    const { discoverPackageMap } = loadDiscoverPackageMap(vsc);
    let threw = null, packageOf;
    try { packageOf = await discoverPackageMap(); } catch (e) { threw = e; }
    check('7e. malformed sfdx-project.json JSON does not throw discoverPackageMap', !threw, threw && threw.stack);
    if (packageOf) {
      check('7e. malformed JSON -> packageOf returns null for everything (packageless fallback)', packageOf('/ws6/force-app/classes/X.cls') === null, 'got ' + packageOf('/ws6/force-app/classes/X.cls'));
    }
  }

  // --- 7f: packageDirectories is not an array at all (e.g. a string, or
  // missing entirely) -- must not throw.
  {
    const files = {
      '/ws7/sfdx-project.json': JSON.stringify({ packageDirectories: 'not-an-array' }),
      '/ws8/sfdx-project.json': JSON.stringify({ name: 'no-packageDirectories-key' }),
    };
    const vsc = mockVscodeFor(files);
    const { discoverPackageMap } = loadDiscoverPackageMap(vsc);
    let threw = null, packageOf;
    try { packageOf = await discoverPackageMap(); } catch (e) { threw = e; }
    check('7f. non-array / missing packageDirectories does not throw', !threw, threw && threw.stack);
    if (packageOf) {
      check('7f. non-array packageDirectories contributes nothing (packageless for that project)', packageOf('/ws7/force-app/X.cls') === null);
    }
  }
}

// =========================================================================
// PART 2: live end-to-end repro against the REAL adv-org corpus through the
// REAL extension.js activate()+registered-command path, to check whether
// MANIFEST's B2 default-package-fallback edge actually resolves live.
// =========================================================================
async function part2() {
  console.log('\n--- PART 2: live default-package-fallback repro (real extension.js, real corpus) ---');

  const ADV_ORG_ROOT = 'test-fixtures/adv-org';
  const EXCLUDE_DIRS = new Set(['node_modules', '.sfdx', '.sf', '.git']);
  function walk(dir, out) {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
    for (const ent of entries) {
      if (ent.isDirectory()) { if (!EXCLUDE_DIRS.has(ent.name)) walk(path.join(dir, ent.name), out); }
      else out.push(path.join(dir, ent.name));
    }
  }

  const mockVscode = {
    EventEmitter: class { constructor() { this._h = []; } get event() { return (fn) => { this._h.push(fn); }; } fire() { for (const h of this._h) h(); } },
    TreeItem: class { constructor(label, state) { this.label = label; this.collapsibleState = state; } },
    TreeItemCollapsibleState: { Collapsed: 1, None: 0 },
    ThemeIcon: class { constructor(id) { this.id = id; } },
    Uri: { file: mkUri },
    Range: class { constructor(a, b, c, d) { this.args = [a, b, c, d]; } },
    ProgressLocation: { Notification: 1 },
    ViewColumn: { Beside: 1, One: 2 },
    workspace: {
      findFiles: async (glob) => {
        if (typeof glob === 'string' && /sfdx-project\.json/.test(glob)) {
          const out = [];
          walk(ADV_ORG_ROOT, out);
          return out.filter((p) => path.basename(p) === 'sfdx-project.json').map(mkUri);
        }
        if (typeof glob === 'string' && /\.\{cls,trigger,apex\}/.test(glob)) {
          const out = [];
          walk(ADV_ORG_ROOT, out);
          return out.filter((p) => /\.(cls|trigger|apex)$/i.test(p)).map(mkUri);
        }
        return [];
      },
      fs: {
        stat: async (uri) => { const st = fs.statSync(uri.fsPath); return { mtime: st.mtimeMs, size: st.size }; },
        readFile: async (uri) => Buffer.from(fs.readFileSync(uri.fsPath)),
      },
    },
    window: {
      activeTextEditor: undefined,
      createTreeView: () => ({}),
      withProgress: async (opts, task) => task({ report: () => {} }),
      showWarningMessage: (m) => { lastWarning = m; },
      showInformationMessage: () => {},
      setStatusBarMessage: () => {},
      showQuickPick: async () => null,
      createWebviewPanel: () => ({ webview: { html: '', onDidReceiveMessage: () => {} }, onDidDispose: () => {}, reveal: () => {} }),
    },
    commands: {
      _registry: new Map(),
      registerCommand(name, fn) { this._registry.set(name, fn); return { dispose() {} }; },
      executeCommand: async () => {},
    },
  };
  let lastWarning = null;

  const origResolve = Module._resolveFilename;
  Module._resolveFilename = function (request, ...rest) {
    if (request === 'vscode') return 'vscode';
    return origResolve.call(this, request, ...rest);
  };
  require.cache['vscode'] = { id: 'vscode', filename: 'vscode', loaded: true, exports: mockVscode };
  delete require.cache[require.resolve(path.join(__dirname, '..', 'extension.js'))];
  const extension = require(path.join(__dirname, '..', 'extension.js'));

  const context = { subscriptions: [], globalStorageUri: { fsPath: path.join(__dirname, '.hostile-v070-scratch-storage') } };
  await extension.activate(context);

  // We need the built index/tree, not just command side effects. Capture it
  // via provider.setRoots -- reach it by wrapping createTreeView to snoop
  // the TreeDataProvider passed to registerTreeDataProvider... but
  // extension.js uses vscode.window.createTreeView(viewId, { treeDataProvider }).
  // Patch createTreeView to capture the provider, then read its exposed roots
  // after invoking the traceCallees command with a REAL target (no QuickPick
  // needed if we call with an explicit target the way retraceLastTarget/
  // context-menu invocations do -- but the exported command signature takes
  // an optional pre-resolved target argument per A3/A4 sharing; if it
  // doesn't, we fall back to inspecting view.description / view.message,
  // which the traceTarget() function sets unconditionally.
  let capturedProvider = null;
  mockVscode.window.createTreeView = (viewId, opts) => { capturedProvider = opts.treeDataProvider; return { onDidChangeSelection: () => {}, reveal: () => {} }; };

  // Re-activate with the patched createTreeView so provider capture takes effect.
  delete require.cache[require.resolve(path.join(__dirname, '..', 'extension.js'))];
  const extension2 = require(path.join(__dirname, '..', 'extension.js'));
  const context2 = { subscriptions: [], globalStorageUri: { fsPath: path.join(__dirname, '.hostile-v070-scratch-storage2') } };
  await extension2.activate(context2);

  const traceCalleesFn = mockVscode.commands._registry.get('apexTrace.traceCallees');
  check('7g. apexTrace.traceCallees command registered', typeof traceCalleesFn === 'function', typeof traceCalleesFn);
  if (typeof traceCalleesFn !== 'function') { return; }

  // Drive it with an explicit target if the command supports one; the
  // registered handler signature is whatever extension.js wired up for the
  // context-menu path (className/methodName args) -- try common shapes.
  let treeSeen = null;
  const origSetRoots = capturedProvider && capturedProvider.setRoots;
  if (capturedProvider) {
    capturedProvider.setRoots = function (roots) { treeSeen = roots; if (origSetRoots) origSetRoots.call(capturedProvider, roots); };
  }

  try {
    await traceCalleesFn({ className: 'NovaSharedBillingBridge', methodName: 'syncSharedQuery' });
  } catch (e) {
    console.log('      (7g info) traceCallees threw with explicit-target arg shape 1: ' + e.message);
  }
  if (!treeSeen) {
    try {
      await traceCalleesFn('NovaSharedBillingBridge', 'syncSharedQuery');
    } catch (e) {
      console.log('      (7g info) traceCallees threw with explicit-target arg shape 2: ' + e.message);
    }
  }

  if (!treeSeen) {
    console.log('      (7g info) could not drive traceCallees to a known target via mocked args (QuickPick returns null); falling back to a direct resolver.js probe using the SAME packageOf the real extension.js would build.');
  }

  // Fallback / cross-check: reuse the actual on-disk parse+index pipeline
  // (parser.js + resolver.js, exactly as extension.js's scanAndBuildIndex
  // would) but build packageOf via the REAL discoverPackageMap (PART 1's
  // loader) so we are checking the REAL wiring end to end, without needing
  // to reverse-engineer the QuickPick-driven command argument shape.
  const parser = require('../parser');
  const resolver = require('../resolver');
  const { discoverPackageMap } = loadDiscoverPackageMap(mockVscode);
  const packageOf = await discoverPackageMap();

  const apexFiles = [];
  walk(ADV_ORG_ROOT, apexFiles);
  const facts = apexFiles.filter((p) => /\.(cls|trigger)$/i.test(p)).map((p) => parser.parseFile({ path: p, text: fs.readFileSync(p, 'utf8') }));

  // MUST-FIX #6 (post-fix): build the index EXACTLY the way extension.js's
  // scanAndBuildIndex now does at its call site (grep-verified):
  // `resolver.buildSemanticIndex(scan.factsList, { packageOf, defaultPackage })`,
  // where `defaultPackage` is read off `packageOf.defaultPackage` -- the
  // property discoverPackageMap() now attaches to its returned function
  // (see extension.js's own header note on that attachment for why it's a
  // property rather than a second return value).
  const defaultPackage = typeof packageOf.defaultPackage !== 'undefined' && packageOf.defaultPackage != null
    ? packageOf.defaultPackage
    : null;
  const indexAsExtensionBuildsIt = resolver.buildSemanticIndex(facts, { packageOf, defaultPackage });

  const tree = resolver.buildCalleeTree(indexAsExtensionBuildsIt, { classLower: 'novasharedbillingbridge', methodLower: 'syncsharedquery' }, {});
  const buildQueryChild = (tree.root.children || []).find((c) => /buildquery/i.test(c.methodLower || ''));

  console.log(`      (7g info) forward children of NovaSharedBillingBridge#syncSharedQuery under extension.js's ACTUAL opts wiring: ${JSON.stringify((tree.root.children || []).map((c) => ({ label: c.label, kind: c.kind, via: c.via, path: c.path })))}`);

  check(
    '7h. MANIFEST B2 default-package-fallback edge (NovaSharedBillingBridge -> AcmeOrderUtil.buildQuery) reaches the target node at all',
    !!buildQueryChild,
    buildQueryChild ? 'resolved: ' + JSON.stringify(buildQueryChild.label) : 'NOT FOUND'
  );
  check(
    '7h-2. MANIFEST B2 spec requires via=\'static\' (unambiguous default-package fallback) -- extension.js now passes opts.defaultPackage (MUST-FIX #6) to buildSemanticIndex',
    buildQueryChild && buildQueryChild.via === 'static',
    buildQueryChild
      ? `got via=${JSON.stringify(buildQueryChild.via)} (expected 'static'). Root cause (pre-fix): extension.js's discoverPackageMap() parsed packageDirectories[].path and .package but never read the .default flag, and its call site never supplied opts.defaultPackage at all. ` +
        `resolveDuplicateBucket()'s rule 2 (resolver.js: 'if (defaultPackage != null) { ... }') was therefore permanently dead code in the shipped extension: ` +
        `it always fell through to rule 3 ('ambiguous', approximate=true) for ANY duplicate-name reference that isn't resolved by same-package rule 1, even when ` +
        `MANIFEST's own ground truth (B2) says exactly one candidate (the default package's) should win unambiguously via='static'. Concretely this: (a) mislabels a ` +
        `perfectly resolvable call as approximate/ambiguous in the UI (wrong badge/tooltip, wrong legend classification), and (b) in any corpus where the NON-default ` +
        `candidate ALSO happens to declare a same-named method, would additionally emit a spurious extra edge to that non-default candidate that MANIFEST's rule 2 ` +
        `says must never appear (rule 2 short-circuits BEFORE rule 3's all-candidates fan-out) -- this fixture just doesn't trigger the second half because pkg-billing's ` +
        `AcmeOrderUtil.cls doesn't happen to declare a buildQuery method.`
      : 'N/A -- 7h already failed'
  );
  check(
    '7h-3. resolved edge must not be flagged approximate (MANIFEST: default-fallback is NOT approximate, only true ambiguous-fanout is)',
    buildQueryChild && buildQueryChild.approximate !== true,
    buildQueryChild ? `approximate=${buildQueryChild.approximate}` : 'N/A'
  );

  // Cross-check: prove resolver.js itself is fine when given defaultPackage
  // explicitly (isolates the bug to extension.js's wiring, not resolver.js's
  // B2 logic).
  const indexWithDefaultPackage = resolver.buildSemanticIndex(facts, { packageOf, defaultPackage: 'force-app' });
  const tree2 = resolver.buildCalleeTree(indexWithDefaultPackage, { classLower: 'novasharedbillingbridge', methodLower: 'syncsharedquery' }, {});
  const buildQueryChild2 = (tree2.root.children || []).find((c) => /buildquery/i.test(c.methodLower || ''));
  check('7i. cross-check: SAME edge DOES resolve when defaultPackage is supplied explicitly (isolates the bug to extension.js\'s missing wiring, not resolver.js)', !!buildQueryChild2, buildQueryChild2 ? 'resolved' : 'still missing -- resolver.js itself may also be broken');
}

(async () => {
  await part1();
  await part2();
  console.log('\n=== Summary ===');
  console.log(`failures: ${failures.length}`);
  if (failures.length) console.log(failures.map((f) => ' - ' + f).join('\n'));
  process.exitCode = failures.length ? 1 : 0;
})();

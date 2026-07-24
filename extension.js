'use strict';
// Apex Call Graph — method-level semantic call-graph UI shell (v0.3.0).
//
// This module coordinates the parser, resolver, metadata scanner, tree view,
// and Path Map through their documented data-only APIs.
//
//   parser.parseFile({ path, text }) -> FileFacts        // never throws
//   resolver.buildSemanticIndex(factsList[, opts]) -> Index
//   resolver.buildCallerTree(index, { classLower, methodLower }, opts) -> TreeResult   // direction: 'callers'
//   resolver.buildCalleeTree(index, { classLower, methodLower }, opts) -> TreeResult   // direction: 'callees' (v0.7 / A2)
//   resolver.suggestTargets(index) -> [{ label, classLower, methodLower }]
//   resolver.attachMetaCallers(index, metaRefs) -> Index (A6, mutates + returns)
//   metascan.parseMetaFile({ path, text }) -> [MetaRef]   // never throws (A5)
//   metascan.scanBundle(files) -> [MetaRef]                // Aura cross-file (A5)
//
// buildSemanticIndex's optional second `opts`
// argument may carry `opts.packageOf(fsPath) -> label|null`, built fresh
// every run from this workspace's sfdx-project.json file(s) -- see
// discoverPackageMap()'s header comment below. A workspace with no
// sfdx-project.json anywhere yields a packageOf that returns null for every
// path, which resolver.js treats as "nothing to say" --
// buildSemanticIndex's behavior in that case stays byte-identical to
// pre-v0.7.
//
// The same `opts` argument also carries
// `opts.ownNamespace: string|null`, this workspace's OWN managed-package
// namespace read from sfdx-project.json's top-level `namespace` property
// (discoverPackageMap() reads it in the same pass as packageOf, see that
// function's header comment below). What resolver.js DOES with a non-null
// ownNamespace (stripping it as a prefix before local class/object/metascan-
// ref lookup, so e.g. `vtx.VertexPricingService` in a workspace whose own
// namespace IS `vtx` resolves LOCAL rather than becoming an external node)
// is handled by resolver.js. Absent/empty `namespace` (the
// overwhelmingly common unmanaged/unlocked-package workspace) yields
// ownNamespace: null, which resolver.js's opts contract treats as "nothing
// to strip" -- byte-identical to pre-v0.8 in that case.
//
// uitree.js (pure, no vscode import) turns a TreeResult's TNode into plain
// UiNode objects; this file's only jobs are: scan + cache + parse workspace
// files (Apex AND, per A7, LWC/Aura/Flow/OmniScript/VF metadata), resolve a
// cursor/QuickPick target, ask resolver.js for the tree, and translate
// UiNode -> vscode.TreeItem (including the vscode-boundary line-number
// conversion — see the note below).
//
// v1's apexindex.js lexical engine is not used here; parse-error fallback
// lives inside resolver.js
// (files with FileFacts.parseError get lexical class-mention edges there,
// via apexindex.strip). This file never touches apexindex.js directly.
//
// Progressive depth and settings responsibilities:
//   - contributes.configuration read-through (readSettings() below) for the
//     apexCallGraph.* settings from package.json.
//   - per-trace expansion state (a Set<methodKeyLower> per traceId) and the
//     NATIVE lazy vscode.TreeItem expansion built on top of it -- see the
//     "progressive-depth tree building" section below (buildTreeForTarget/
//     expandFrontierKey) and LOAD_MORE_COMMAND's registerCommand in
//     activate().
//   - the Path Map webview's mirrored 'expand' message -> postMessage
//     'update' path (postPathMapUpdate below), so a click on the map's own
//     '+N' pill (pathmap.js's job to render) never re-sets the whole
//     webview .html (which would blow away the user's pan/zoom).
//
// P1 (resolver.js) amends buildCallerTree/buildCalleeTree's opts with
// `initialDepth` and `expandedKeys` (an iterable of methodKeyLower
// strings, resolver.js's own internal `${classLower}#${methodLower}`
// cycleKey convention), and TNode with `expandable`/`pendingCount` on a
// depth-frontier node. The resolver output shape is:
// `methodKey` is NOT stamped onto TNode as an explicit field (the internal
// cycleKey stays private to resolver.js) -- P3 (uitree.js) instead exports
// `frontierMethodKey(node)`, which derives the identical string from a
// node's own `className`/`methodLower` fields (falling back to an explicit
// `node.methodKey` if one is ever present), and this file imports + reuses
// that SAME function everywhere it needs a node's identity (see the
// require() above), rather than re-deriving it independently -- the one
// thing that guarantees extension.js, uitree.js, and pathmap.js always
// agree on one node's key string. uitree.js's shapeNode also appends a
// SYNTHETIC load-more child (`loadMore:true`, `expandKey:'<key>'`) as the
// sole entry in an expandable node's shaped `children` -- see toTreeItem's
// `uiNode.loadMore` branch below for how this file wires that child's click
// to LOAD_MORE_COMMAND. pathmap.js's client mirrors the same
// frontierMethodKey derivation for its own '+N' pill and posts
// {type:'expand', key} -- see showPathMapPanel's onDidReceiveMessage below.
// pathmap.js is additionally expected to export `buildPathMapData(tree)`
// (the same data blob renderPathMapHtml embeds inline, extracted so an
// 'update' postMessage can ship just the data); guarded via a `typeof`
// check, same idiom this file already uses for metascan.stripOwnNamespace
// (v0.8 N3) above, so a pathmap.js build without this specific export
// degrades to a full HTML re-set instead of breaking (see
// postPathMapUpdate below).

const vscode = require('vscode');
const crypto = require('crypto');
const path = require('path');
const parser = require('./parser');
const resolver = require('./resolver');
const metascan = require('./metascan');
const cachestore = require('./cachestore');
const cachefiles = require('./cachefiles');
const cachecoordinator = require('./cachecoordinator');
const editoroverlay = require('./editoroverlay');
const workspacepaths = require('./workspacepaths');
const targets = require('./targets');
// Pure, vscode-free helpers for single-flight/coalescing,
// the watcher dirty-set tracker, and the counts-only diagnostics payload
// shape) -- see scanflow.js's own header for the full contract each export
// carries; nothing in that file is vscode-aware, which is what makes it
// independently unit-tested (test-scanflow.js) outside the extension host.
const scanflow = require('./scanflow');
// Pure, vscode-free parse-pool manager (worker_threads),
// used only for a cold parse of >200 files -- see workerpool.js's own
// header. Also vscode-free/independently unit-tested (test-workerpool.js).
const workerpool = require('./workerpool');
const {
  shapeResult,
  shapeHeaderLines,
  effectiveOrientation,
  // shapeNode shapes ONE raw TNode (recursively) into a
  // UiNode -- used to re-shape just the freshly-expanded node after a
  // load-more click, instead of re-shaping (and re-diffing against) the
  // whole tree. frontierMethodKey is the SAME methodKeyLower derivation
  // uitree.js's own shapeLoadMoreChild uses to stamp UiNode.expandKey, and
  // pathmap.js's client mirrors verbatim for its own '+N' pill's postMessage
  // -- reusing it here (rather than re-deriving independently) is what
  // guarantees extension.js, uitree.js, and pathmap.js always agree on one
  // node's identity string.
  shapeNode,
  frontierMethodKey,
  // Entry-Point Catalog shaping surface (uitree.js's own
  // section header above shapeEntryCatalog documents the full contract) --
  // used only by the entry-catalog view wiring below (EntryCatalogProvider/
  // toEntryCatalogTreeItem/apexTrace.showEntryCatalog), never by the
  // pre-existing caller/callee trace path above.
  shapeEntryCatalog,
  shapeEntryCatalogHeaderLine,
  // v0.14.0: Impact Analysis is rendered in the ordinary call-graph tree,
  // but uses its own five-section pure shaping surface.
  shapeImpactReport,
  shapeImpactHeaderLine,
} = require('./uitree');
const { renderPathMapHtml, buildPathMapData } = require('./pathmap');

// Internal-only command id (never listed in package.json's
// contributes.commands -- it has no business appearing in the Command
// Palette) that a tree-view load-more TreeItem's `.command` points at, see
// toTreeItem's `uiNode.loadMore` branch below and this id's
// registerCommand call in activate().
const LOAD_MORE_COMMAND = 'apexTrace._loadMoreChildren';

const MAX_DEPTH = 8;

// Configuration section id and the same numeric defaults resolver.js's own
// DEFAULT_MAX_DEPTH/DEFAULT_MAX_NODES already use internally (MAX_DEPTH
// above mirrors DEFAULT_MAX_DEPTH) -- kept in sync deliberately so a
// workspace that never opens Settings sees byte-identical maxDepth/maxNodes
// behavior to pre-v0.9, and the only NEW user-visible default is
// initialDepth (progressive rendering starts collapsed at depth 2 instead
// of eagerly materializing the whole maxDepth=8 tree).
const CONFIG_SECTION = 'apexCallGraph';
const DEFAULT_INITIAL_DEPTH = 2;
const DEFAULT_EXPAND_STEP = 1;
const DEFAULT_MAX_NODES_SETTING = 2000;

// Reads the five apexCallGraph.* settings fresh via
// vscode.workspace.getConfiguration -- called at the start of every
// scanAndBuildIndex() (a real trace) AND right before every tree-only
// rebuild that doesn't rescan (orientation toggle, a frontier-node
// expand click), so an edit in Settings takes effect on the very next
// resolver call either way, same "re-discovered fresh every run"
// philosophy as discoverPackageMap() below. Values are defensively
// clamped to the package.json schema's own min/max: a workspace/user
// settings.json can still hand-write an out-of-range or wrong-type value,
// bypassing the Settings UI's own validation, and a malformed setting
// should degrade to the nearest valid default rather than produce
// surprising resolver.js behavior (e.g. a negative/NaN maxNodes).
function readSettings() {
  const cfg = vscode.workspace.getConfiguration(CONFIG_SECTION);
  const clampInt = (value, lo, hi, dflt) => {
    const n = Math.round(Number(value));
    if (!Number.isFinite(n)) return dflt;
    return Math.min(hi, Math.max(lo, n));
  };
  const rawExcludes = cfg.get('excludeGlobs');
  const excludeGlobs = scanflow.normalizeExcludeGlobs(rawExcludes);
  const excludeMatcher = scanflow.compileExcludeGlobs(excludeGlobs);
  // apexCallGraph.showUnconfirmed controls whether approximate edges are
  // grouped, hidden, or expanded. Read and validate it like every other
  // setting; an invalid or legacy value falls back to the documented
  // 'rollup' default.
  const rawShowUnconfirmed = cfg.get('showUnconfirmed');
  const showUnconfirmed = ['rollup', 'hide', 'expand'].includes(rawShowUnconfirmed) ? rawShowUnconfirmed : 'rollup';
  return {
    initialDepth: clampInt(cfg.get('initialDepth'), 1, 8, DEFAULT_INITIAL_DEPTH),
    expandStep: clampInt(cfg.get('expandStep'), 1, 4, DEFAULT_EXPAND_STEP),
    maxDepth: clampInt(cfg.get('maxDepth'), 1, 20, MAX_DEPTH),
    maxNodes: clampInt(cfg.get('maxNodes'), 100, 20000, DEFAULT_MAX_NODES_SETTING),
    excludeGlobs,
    excludeMatcher,
    showUnconfirmed,
  };
}

// v0.7.1: workspaceState key persisting the caller-tree ORIENTATION toggle
// ('target-first' | 'entry-first') across sessions -- see uitree.js's
// "v0.7.1 ORIENTATION" section for what the two values mean. Orientation is
// a view-only preference (a pure uitree.js re-rooting of the already-
// computed TreeResult), so it lives in workspaceState, not in the engine
// cache, and never bumps ENGINE_CACHE_VERSION.
const ORIENTATION_KEY = 'apexCallGraph.orientation';

// F6: bump this whenever parser.js's FileFacts/MethodFacts/CallFacts shape
// (or metascan.js's MetaRef shape) changes -- cachestore.js's deserialize()
// checks it with strict equality and discards the ENTIRE on-disk cache on
// any mismatch, so a stale cache from a prior engine version is never
// partially trusted. v0.4.0 adds MethodFacts.dml[] and MetaRef.flowObject/
// flowRecordTriggerType/cmdt/fieldName, so this moves from 3 to 4.
// v0.5.0 (parser.js, out of scope here) adds MethodFacts.throwsSites[]/
// catches[]/narrowings[] (G2/G3) and FileFacts.kind can now be 'anonymous'
// for .apex files (G4); metascan.js adds MetaRef.flowTriggerType
// (G1) -- a cached FileFacts/MetaRef from the v0.4 engine is missing all of
// these fields, so this moves from 4 to 5.
// v0.6.0 (H6b) adds a `size` tiebreak alongside `mtimeMs` to the in-memory
// fileCache/metaFileCache entry shape -- mtime alone has a known false-
// negative risk (two saves landing within the same filesystem mtime
// resolution tick can look "unchanged"), so this moves from 5 to 6.
// NOTE: older persisted entries do not round-trip a `size` field, so a cache entry
// hydrated from disk always comes back with size===undefined and therefore
// always fails this tiebreak once after a restart -- safe (forces exactly
// one reparse per file, never a false cache hit), but the full perf win
// needs a matching cachestore.js update.
// v0.11.0 adds MethodFacts.locals[].literal (optional; single-assignment
// string-literal locals) and TypeFacts.constants[] (static final String
// fields with a literal initializer) -- a cached FileFacts
// from the v0.6 engine is missing both additive fields, so this moves from 6
// to 7. resolver.js's dynamic-dispatch changes (literal
// candidates, narrowed generic-DML edges) consume these new parser fields
// but don't themselves change FileFacts/MetaRef shape, so they ride along
// on this same bump rather than needing one of their own.
// v0.15 hardening moves to an Apex-facts-only disk cache. v9 additionally
// omits every successful fact object containing source-faithful lines,
// expressions, receivers, DML targets, or literal values; pre-v9 files are
// classified as legacy and deleted.
const ENGINE_CACHE_VERSION = 9;

// H8: the extension's own version, read straight from package.json (a
// local file this extension ships with, never workspace-derived) -- purely
// informational, folded into both the Scan Stats output channel and the
// copyDiagnostics clipboard payload's `extensionVersion` field.
const EXTENSION_VERSION = require('./package.json').version;

// Debounce window between the end of a scan and the on-disk cache write --
// avoids a redundant write-per-scan burst if the user retriggers a trace
// (e.g. Cmd+. spam) before the previous write finished being useful anyway.
const PERSIST_DEBOUNCE_MS = 1500;
const CACHE_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

// Module-level cache: canonical resource URI -> { mtimeMs, size, facts }.
// URI identity includes scheme + authority, so two remote folders exposing
// the same fsPath cannot share an entry. Survives across command
// invocations in the same VS Code session so unchanged files are never
// re-parsed; the semantic index is still rebuilt from (possibly cached)
// facts on every run, since the workspace's file set and cross-file
// resolution can change between runs even when a given file didn't.
// F6: declaration-only entries without source fragments may also persist to
// disk; all other files safely reparse after restart.
const fileCache = new Map();

// A7: session-memory-only resource-URI-keyed cache for metadata source files
// (LWC/Aura/Flow/OmniScript/VF/Custom Metadata/Permission Set/Profile),
// mirroring fileCache above. Unlike fileCache
// this stores raw file text, but it is never passed to the disk-persistence
// boundary. Aura's cross-file bundling (a .cmp's
// controller="..." attribute plus its sibling Controller/Helper .js files'
// component.get('c.method') calls) means a single file's MetaRefs can
// depend on a SIBLING file's content, so per-file ref caching would need
// bundle-level invalidation bookkeeping. Re-running metascan's regex
// extractors over already-read text on every scan is cheap and keeps this
// correct by construction
// instead: mtime caching here only ever saves the vscode.workspace.fs.readFile
// I/O, not the (already fast) text scan.
const metaFileCache = new Map();

// =========================================================================
// Watcher dirty-set state.
// =========================================================================
// One shared tracker across BOTH the Apex and metadata scans (scanAndParse
// and scanMetaFiles each filter its own peek() snapshot down to the paths
// relevant to their own extensions via APEX_EXT_RE/META_EXT_RE, inline where
// each uses it) -- a single
// FileSystemWatcher setup (activate(), below) feeding one tracker is
// simpler and no less correct than two independent trackers, since the
// only two things read out of it (dirty/deleted resource-key SETS, and the one
// fullSweepNeeded latch) are already per-resource and per-run, not per-scan-
// type. Module-level (like fileCache/metaFileCache above) so it survives
// across command invocations within one extension-host session.
const dirtyTracker = scanflow.createDirtyTracker();
const cacheCoordinator = cachecoordinator.createCacheCoordinator();

// The exact set of canonical resource keys the LAST successful Apex/metadata sweep (full or
// incremental) actually produced FileFacts/text for -- lets a subsequent
// EMPTY-dirty-set trace reuse the in-memory factsList/metadata with ZERO
// findFiles+stat calls (H6's "reuses the in-memory factsList + metadata"),
// and lets a SMALL-dirty-set trace know which paths besides the dirty ones
// still belong in the final list. null until the first successful sweep
// (mirrors dirtyTracker's own fullSweepNeeded-starts-true invariant --
// there is nothing to reuse before that).
let lastApexUriSet = null;
let lastMetaUriSet = null;

const APEX_EXT_RE = /\.(cls|trigger|apex)$/i;
const META_EXT_RE = /\.(js|cmp|app|xml|json|page|component)$/i;

// H6: the full-sweep path always excludes these via the built-in provider
// pattern (scanWorkspaceUris/scanMetaWorkspaceUris) -- the
// INCREMENTAL dirty-set fast path below never calls findFiles at all, so it
// has no glob-exclude pass of its own to lean on. A watcher event for a
// path under one of these directories (the FileSystemWatcher globs
// themselves are not exclude-aware either) must not be allowed to sneak a
// path the full sweep would have excluded into fileCache/lastApexUriSet.
// The hard-coded check stays separate from the user-glob matcher below so
// these directories remain excluded even when no workspace folder can be
// resolved for a watcher path.
const HARD_EXCLUDED_DIR_RE = /[\\/](node_modules|\.sfdx|\.sf|\.git|__tests__)[\\/]/;
function isHardExcludedPath(fsPath) {
  return HARD_EXCLUDED_DIR_RE.test(fsPath);
}

function resourceKeyForUri(uri) {
  return workspacepaths.resourceKey(uri);
}

function sourcePathForUri(uri) {
  return workspacepaths.sourcePathForUri(uri);
}

function workspaceLocationForUri(uri) {
  return workspacepaths.findContainingWorkspaceFolderForUri(uri, vscode.workspace.workspaceFolders, path);
}

function resourceUriFromKey(resourceKey) {
  if (typeof resourceKey !== 'string' || !resourceKey) return null;
  try {
    return vscode.Uri.parse(resourceKey, true);
  } catch (_) {
    return null;
  }
}

function resourceUriForSourcePath(sourcePath) {
  if (typeof sourcePath !== 'string' || !sourcePath) return null;
  if (workspacepaths.isSerializedResourcePath(sourcePath)) {
    return resourceUriFromKey(sourcePath);
  }
  const location = workspacepaths.findContainingWorkspaceFolder(
    sourcePath,
    (vscode.workspace.workspaceFolders || []).filter((folder) => folder.uri.scheme === 'file'),
    path
  );
  if (!location) return null;
  if (!location.relativePath) return location.folder.uri;
  return vscode.Uri.joinPath(location.folder.uri, ...location.relativePath.split(/[\\/]/).filter(Boolean));
}

// FileSystemWatcher paths are absolute, while vscode.workspace.findFiles
// evaluates string globs relative to the containing workspace folder. Keep
// the incremental path consistent with the full sweep by converting to the
// same relative shape before applying scanflow's pure glob matcher.
function isUserExcludedUri(uri, excludeGlobs) {
  if (!uri || !uri.fsPath) return true;
  const location = workspaceLocationForUri(uri);
  const folder = uri ? vscode.workspace.getWorkspaceFolder(uri) : null;
  // Workspace watchers should already be scoped, but fail closed if another
  // event source ever hands incremental scanning an external path.
  if (!folder || !folder.uri || !folder.uri.fsPath) return true;
  const hasExcludePatterns = Array.isArray(excludeGlobs)
    ? excludeGlobs.length > 0
    : !!(excludeGlobs && Array.isArray(excludeGlobs.patterns) && excludeGlobs.patterns.length);
  if (!hasExcludePatterns) return false;
  const relativePath = location && location.folder === folder
    ? location.relativePath
    : path.relative(folder.uri.fsPath, uri.fsPath);
  return scanflow.matchesExcludeGlobs(relativePath, excludeGlobs);
}

// Worker threads are only worthwhile once there is
// meaningfully more cold-parse work than the spin-up overhead of a handful
// of threads -- see workerpool.js's own header for the size/chunking
// contract. Below this, the existing single-threaded inline loop stays
// exactly as fast (no thread spin-up cost at all) as it always was.
const WORKER_POOL_FILE_THRESHOLD = 200;


class TraceProvider {
  constructor() {
    this._emitter = new vscode.EventEmitter();
    this.onDidChangeTreeData = this._emitter.event;
    this._roots = []; // UiNode[]
    this._traceId = 0;
  }

  // `traceId` is stamped onto every TreeItem this render
  // produces (see toTreeItem below) so a LATER load-more click against one
  // of them can tell whether it still belongs to the CURRENT trace -- see
  // the staleness guard on LOAD_MORE_COMMAND's handler in activate() below.
  setRoots(uiNodes, traceId) {
    this._roots = uiNodes || [];
    this._traceId = traceId || 0;
    this._emitter.fire();
  }

  getTreeItem(el) {
    return el;
  }

  getChildren(el) {
    if (!el) return this._roots.map((n) => toTreeItem(n, this._traceId));
    return el._uiChildren || [];
  }

  // Targeted refresh tells VS Code one element's own rendering
  // (and, since vscode re-fetches, its children) may have changed, without
  // disturbing any sibling/ancestor TreeItem elsewhere in the tree.
  // LOAD_MORE_COMMAND's handler (activate(), below) calls this after
  // mutating a frontier node's TreeItem in place. Contrast with setRoots'
  // un-targeted fire(), a full-tree refresh reserved for an actual new
  // trace.
  refresh(el) {
    this._emitter.fire(el);
  }
}

// The Entry-Point Catalog's own TreeDataProvider, backing the
// second Explorer view ('apexTraceEntriesView', see activate() below). A
// flat two-level tree (kind group -> entries, uitree.js's
// shapeEntryCatalog output) rather than a recursive call tree, so this is
// deliberately simpler than TraceProvider above -- no traceId/progressive-
// depth bookkeeping, since an entry-catalog "trace" is just "the last scan
// this command ran", always fully materialized (a catalog is small and flat
// by construction -- one row per entry point, not a branching call graph).
class EntryCatalogProvider {
  constructor() {
    this._emitter = new vscode.EventEmitter();
    this.onDidChangeTreeData = this._emitter.event;
    this._roots = []; // UiNode[] (group nodes)
  }

  setRoots(uiNodes) {
    this._roots = uiNodes || [];
    this._emitter.fire();
  }

  getTreeItem(el) {
    return el;
  }

  getChildren(el) {
    if (!el) return this._roots.map((n) => toEntryCatalogTreeItem(n));
    return el._uiChildren || [];
  }
}

// UiNode.jump.line is still 1-based (uitree.js is pure and never touches
// vscode types — see its header comment); vscode.Position/Range are
// 0-based, so the conversion happens right here, at the boundary.
//
// `traceId` is threaded through purely so a load-more click can
// be checked against the CURRENT trace (see LOAD_MORE_COMMAND's handler
// below); it has no effect on rendering. `parent` (also new) is the
// enclosing TreeItem this call is building children FOR -- passed through
// only so a `uiNode.loadMore` child (see below) can capture it as the
// element its own click handler must mutate + refresh.
//
// uitree.js's shapeNode/shapeLoadMoreChild represent a frontier as follows:
// a frontier (uiNode.expandable) node's real `children` are simply empty,
// and shapeNode has already appended exactly ONE synthetic item
// (uiNode.loadMore:true, uiNode.expandKey:'<methodKeyLower>') as that
// node's sole child -- so this function needs NO special-casing for
// `expandable` at all; the existing eager recursive shaping already
// renders that one synthetic child like any other UiNode. The only new
// branch is for the synthetic child ITSELF: instead of a jump-to-source
// command, it gets the internal load-more command wired below.
function toTreeItem(uiNode, traceId, parent) {
  const it = new vscode.TreeItem(
    uiNode.label,
    uiNode.collapsible
      ? (uiNode.expanded ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed)
      : vscode.TreeItemCollapsibleState.None
  );
  it.description = uiNode.description;
  if (uiNode.tooltip) it.tooltip = uiNode.tooltip;
  if (uiNode.iconId) it.iconPath = new vscode.ThemeIcon(uiNode.iconId);
  it._traceId = traceId || 0;
  const kids = (uiNode.children || []).map((n) => toTreeItem(n, traceId, it));
  it._uiChildren = kids;
  if (uiNode.loadMore) {
    // uitree.js's shapeLoadMoreChild header note
    // explicitly hands this wiring to extension.js ("add expandKey to
    // opts.expandedKeys, re-trace, replace this node's children with the
    // fresh result") -- `parent` is THIS item's enclosing TreeItem (the
    // frontier node itself), the element LOAD_MORE_COMMAND's handler must
    // mutate + refresh.
    it.command = { command: LOAD_MORE_COMMAND, title: 'Load more', arguments: [uiNode.expandKey, traceId, parent] };
  } else if (uiNode.jump) {
    const line = Math.max(0, (uiNode.jump.line || 1) - 1);
    const col = Math.max(0, uiNode.jump.col || 0);
    it.command = openCommand(uiNode.jump.path, line, col);
  }
  return it;
}

function openCommand(sourcePath, line, col) {
  const resourceUri = resourceUriForSourcePath(sourcePath);
  return {
    command: 'vscode.open',
    title: 'Open',
    arguments: [resourceUri || vscode.Uri.file(sourcePath), { selection: new vscode.Range(line, col, line, col) }],
  };
}

// uitree.js's shapeEntryCatalog UiNode -> vscode.TreeItem, the
// entry-catalog view's own counterpart to toTreeItem above. Deliberately
// separate (not a mode of toTreeItem) since entry-catalog UiNodes carry
// fields toTreeItem's caller/callee tree never produces (isGroup/expanded/
// entryTarget, see uitree.js's header note above shapeEntryCatalog) and
// have none of toTreeItem's traceId/load-more machinery to thread through.
//
// Two custom (non-vscode-API) properties are stashed directly on the
// TreeItem, same idiom toTreeItem already uses for `_traceId`/`_uiChildren`
// above: `_entryTarget` ({classLower, methodLower}|null) and `_entryLabel`
// (the entry's own display label, for a no-target toast's wording) -- both
// read back by apexTrace.traceCallees' inline-action branch (registered in
// activate() below) when this item is passed to it as the `view/item/
// context` inline action's argument. Only ever set on an ENTRY leaf
// (uiNode.isGroup false); a group TreeItem carries neither property at all,
// which is exactly what that branch's `Object.prototype.hasOwnProperty`
// check relies on to tell "this call came from an entry-catalog inline
// action" apart from every pre-existing invocation of that same command
// (palette, editor context menu, the main view's title-bar button) -- none
// of which ever pass a TreeItem argument, so `item` is undefined there and
// the check is false by construction, leaving that command's original
// behavior byte-identical.
function toEntryCatalogTreeItem(uiNode) {
  const collapsibleState = uiNode.isGroup
    ? (uiNode.collapsible
        ? (uiNode.expanded ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed)
        : vscode.TreeItemCollapsibleState.None)
    : vscode.TreeItemCollapsibleState.None;
  const it = new vscode.TreeItem(uiNode.label, collapsibleState);
  it.description = uiNode.description;
  if (uiNode.tooltip) it.tooltip = uiNode.tooltip;
  if (uiNode.iconId) it.iconPath = new vscode.ThemeIcon(uiNode.iconId);
  const kids = (uiNode.children || []).map((n) => toEntryCatalogTreeItem(n));
  it._uiChildren = kids;
  if (!uiNode.isGroup) {
    // contextValue is what package.json's "view/item/context" `when` clause
    // (viewItem == apexTraceEntryCatalogEntry) matches against, so the
    // inline "What Does This Call?" action renders on entry rows only,
    // never on a kind-group header row.
    it.contextValue = 'apexTraceEntryCatalogEntry';
    it._entryTarget = uiNode.entryTarget || null;
    it._entryLabel = uiNode.label;
    if (uiNode.jump) {
      const line = Math.max(0, (uiNode.jump.line || 1) - 1);
      const col = Math.max(0, uiNode.jump.col || 0);
      it.command = openCommand(uiNode.jump.path, line, col);
    }
  }
  return it;
}

async function scanWorkspaceUris(excludeGlobs) {
  // .sfdx/.sf hold the StandardApexLibrary platform stubs — indexing those
  // would shadow real classes with same-named stubs.
  // v0.5 (G4): '**/*.apex' added alongside .cls/.trigger -- anonymous Apex
  // scripts (e.g. scripts/adhoc-recalc.apex) route through
  // parser.parseFile the same way .cls/.trigger do; parser.js (out of scope
  // here) is what special-cases the .apex extension into anonymousUnit()
  // parsing. Same excludes as the pre-existing .cls/.trigger scan.
  // User globs are post-filtered by the same linear matcher used for
  // incremental watcher paths. Keeping them out of the provider's outer
  // brace expression preserves literal commas and guarantees parity.
  const uris = await vscode.workspace.findFiles(
    '**/*.{cls,trigger,apex}',
    '{**/node_modules/**,**/.sfdx/**,**/.sf/**,**/.git/**,**/__tests__/**}'
  );
  // Defense-in-depth and parity: the same matcher used by incremental
  // watcher paths post-filters full-scan results too.
  return uris.filter((uri) => !isUserExcludedUri(uri, excludeGlobs));
}

// Reparses only files whose mtime changed since the last run (or that are
// new), reuses cached FileFacts for everything else, and prunes cache
// entries for files no longer present. Returns the facts list plus counts
// for the progress notification.
//
// Optional scan controls; omitting `opts` preserves legacy behavior except
// for the new fields on the
// return value):
//   opts.token   (H4): a vscode.CancellationToken. Checked once per loop
//     iteration (per file); a cancel mid-loop stops scanning immediately --
//     files already parsed THIS call stay in fileCache (nothing rolls
//     back), but the stale-cache-eviction pass below is skipped entirely
//     (see its own comment) and the returned `cancelled: true` tells the
//     caller (scanAndBuildIndex) to abort before ever building an
//     index/tree, per H4's "no partial index/tree is rendered" contract.
//   opts.dirtySnapshot (H6): `{ dirty: Set<fsPath>, deleted: Set<fsPath>,
//     fullSweepNeeded }`, a NON-destructive dirtyTracker.peek() snapshot (see
//     dirtyTracker's own header) taken by scanAndBuildIndex before this call.
//     `fullSweepNeeded` (or no prior successful sweep at all, i.e.
//     `lastApexUriSet === null`) means "trust nothing, findFiles+stat
//     everything" -- today's full-sweep behavior, below. Otherwise: an
//     EMPTY dirty+deleted set skips findFiles+stat ENTIRELY and reassembles
//     factsList purely from fileCache + the last sweep's own path set (zero
//     vscode.workspace.fs calls); a small non-empty set only re-stats/
//     re-parses THOSE paths (filtered to Apex extensions -- the tracker is
//     shared with the metadata scan, see APEX_EXT_RE/META_EXT_RE above) and
//     removes deleted ones from both the cache and the tracked path set.
async function scanAndParse(progress, excludeGlobs, opts) {
  opts = opts || {};
  const token = opts.token || null;
  const dirtySnapshot = opts.dirtySnapshot || null;
  const editorOverlays = opts.editorOverlays || null;
  const isCancelled = () => !!(token && token.isCancellationRequested);

  const useFullSweep = !dirtySnapshot || dirtySnapshot.fullSweepNeeded || !lastApexUriSet;

  // ---- H6 fast paths (only reachable after at least one successful full
  // sweep has populated lastApexUriSet) --------------------------------
  if (!useFullSweep) {
    const dirtyApex = new Set(
      [...dirtySnapshot.dirty].filter(
        (resourceKey) => {
          const uri = resourceUriFromKey(resourceKey);
          return !!(
            uri &&
            APEX_EXT_RE.test(uri.fsPath) &&
            !isHardExcludedPath(uri.fsPath) &&
            !isUserExcludedUri(uri, excludeGlobs)
          );
        }
      )
    );
    const deletedApex = new Set(
      [...dirtySnapshot.deleted].filter((resourceKey) => {
        const uri = resourceUriFromKey(resourceKey);
        return !!(uri && APEX_EXT_RE.test(uri.fsPath));
      })
    );

    if (dirtyApex.size === 0 && deletedApex.size === 0) {
      // H6: "a subsequent trace with an EMPTY dirty set skips findFiles+stat
      // entirely and reuses the in-memory factsList" -- zero I/O below.
      const factsList = [];
      for (const resourceKey of lastApexUriSet) {
        const entry = fileCache.get(resourceKey);
        if (entry) factsList.push(entry.facts);
      }
      const applied = editoroverlay.applyApexOverlays(factsList, lastApexUriSet, editorOverlays, parser.parseFile);
      return {
        factsList: applied.factsList,
        parsed: 0,
        cached: factsList.length,
        unreadable: 0,
        total: factsList.length,
        cancelled: false,
        sweepKind: 'skipped',
        timingMs: { glob: 0, stat: 0, parse: 0 },
        workerStats: null,
        overlaid: applied.overlaid,
      };
    }

    // H6: small dirty set -- only re-stat/re-parse those paths.
    const timingMs = { glob: 0, stat: 0, parse: 0 };
    for (const resourceKey of deletedApex) {
      fileCache.delete(resourceKey);
      lastApexUriSet.delete(resourceKey);
    }
    let parsed = 0;
    let unreadable = 0;
    const toParse = [];
    for (const resourceKey of dirtyApex) {
      if (isCancelled()) break;
      const uri = resourceUriFromKey(resourceKey);
      if (!uri || !vscode.workspace.getWorkspaceFolder(uri)) continue;
      const sourcePath = sourcePathForUri(uri);
      const tStat0 = Date.now();
      let stat;
      try {
        stat = await vscode.workspace.fs.stat(uri);
      } catch (e) {
        timingMs.stat += Date.now() - tStat0;
        // Watcher fired a change for a path that's gone by the time we get
        // to it (fast create+delete race) -- treat exactly like a delete.
        fileCache.delete(resourceKey);
        lastApexUriSet.delete(resourceKey);
        continue;
      }
      timingMs.stat += Date.now() - tStat0;
      const entry = fileCache.get(resourceKey);
      // The watcher already told us this path changed. Do not let a coarse
      // mtime plus a same-byte-length edit turn that authoritative event into
      // a stale cache hit.
      if (scanflow.canReuseStatCache(entry, stat, scanflow.isExplicitlyDirty(dirtySnapshot, resourceKey))) {
        lastApexUriSet.add(resourceKey); // defensive; forceFresh currently makes this unreachable
        continue;
      }
      toParse.push({ resourceKey, sourcePath, uri, stat });
    }
    const tParse0 = Date.now();
    for (const item of toParse) {
      if (isCancelled()) break;
      try {
        const bytes = await vscode.workspace.fs.readFile(item.uri);
        const text = Buffer.from(bytes).toString('utf8');
        const facts = parser.parseFile({ path: item.sourcePath, text }); // contract: never throws
        fileCache.set(item.resourceKey, { mtimeMs: item.stat.mtime, size: item.stat.size, facts });
        lastApexUriSet.add(item.resourceKey);
        parsed++;
      } catch (e) {
        unreadable++;
        fileCache.delete(item.resourceKey);
        lastApexUriSet.delete(item.resourceKey);
      }
      if (progress) progress.report({ message: `re-parsed ${parsed} changed file(s)…` });
    }
    timingMs.parse = Date.now() - tParse0;

    const factsList = [];
    for (const resourceKey of lastApexUriSet) {
      const entry = fileCache.get(resourceKey);
      if (entry) factsList.push(entry.facts);
    }
    const applied = editoroverlay.applyApexOverlays(factsList, lastApexUriSet, editorOverlays, parser.parseFile);
    return {
      factsList: applied.factsList,
      parsed,
      cached: factsList.length - parsed,
      unreadable,
      total: factsList.length,
      cancelled: isCancelled(),
      sweepKind: 'incremental',
      timingMs,
      workerStats: null,
      overlaid: applied.overlaid,
    };
  }

  // ---- full sweep (today's behavior; restructured for H7 pooled cold-
  // parse + H4 cancellation + H8 phase timing, otherwise unchanged) -------
  const timingMs = { glob: 0, stat: 0, parse: 0 };
  const tGlob0 = Date.now();
  const uris = await scanWorkspaceUris(excludeGlobs);
  timingMs.glob = Date.now() - tGlob0;

  const seen = new Set();
  const factsList = [];
  let cached = 0;
  let unreadable = 0;
  const toParse = []; // { resourceKey, sourcePath, uri, stat }

  for (const uri of uris) {
    if (isCancelled()) break;
    const resourceKey = resourceKeyForUri(uri);
    const sourcePath = sourcePathForUri(uri);
    seen.add(resourceKey);
    const tStat0 = Date.now();
    let stat;
    try {
      stat = await vscode.workspace.fs.stat(uri);
    } catch (e) {
      timingMs.stat += Date.now() - tStat0;
      unreadable++;
      continue; // unstattable — skip
    }
    timingMs.stat += Date.now() - tStat0;
    const entry = fileCache.get(resourceKey);
    // H6b: mtimeMs AND size must both match -- mtime resolution on some
    // filesystems is coarse enough that two distinct saves of the same file
    // can land within the same tick, and a same-mtime-different-content
    // false cache hit would silently trace against stale FileFacts. Size is
    // a cheap, free-riding tiebreak (already in the vscode.FileStat we just
    // fetched) that catches that case without a content hash.
    if (scanflow.canReuseStatCache(entry, stat, scanflow.isExplicitlyDirty(dirtySnapshot, resourceKey))) {
      factsList.push(entry.facts);
      cached++;
    } else {
      toParse.push({ resourceKey, sourcePath, uri, stat });
    }
    if (progress) {
      progress.report({ message: `stat ${cached + toParse.length} of ${uris.length} file(s)…` });
    }
  }

  // H7: read the text for every file needing a (re)parse first, THEN decide
  // inline-vs-pool once the total is known -- readFile itself always stays
  // on the main thread (vscode.workspace.fs has no worker-thread-callable
  // form), only the parser.parseFile CPU work moves to the pool.
  const tParse0 = Date.now();
  const readable = []; // { resourceKey, path, text, stat }
  for (const item of toParse) {
    if (isCancelled()) break;
    try {
      const bytes = await vscode.workspace.fs.readFile(item.uri);
      readable.push({
        resourceKey: item.resourceKey,
        path: item.sourcePath,
        text: Buffer.from(bytes).toString('utf8'),
        stat: item.stat,
      });
    } catch (e) {
      unreadable++; // file itself unreadable (permissions, race on delete, …)
    }
  }

  let parsed = 0;
  let workerStats = null;
  if (!isCancelled() && readable.length) {
    if (readable.length > WORKER_POOL_FILE_THRESHOLD) {
      const pooled = await workerpool.parseFiles(
        readable.map((r) => ({ path: r.path, text: r.text })),
        { shouldCancel: isCancelled }
      );
      const { facts, stats } = pooled;
      workerStats = stats;
      if (pooled.cancelled || isCancelled()) {
        timingMs.parse = Date.now() - tParse0;
        return {
          factsList,
          parsed: 0,
          cached,
          unreadable,
          total: uris.length,
          cancelled: true,
          sweepKind: 'full',
          timingMs,
          workerStats,
        };
      }
      for (let i = 0; i < readable.length; i++) {
        const item = readable[i];
        fileCache.set(item.resourceKey, { mtimeMs: item.stat.mtime, size: item.stat.size, facts: facts[i] });
        factsList.push(facts[i]);
        parsed++;
      }
      if (progress) {
        progress.report({ message: `parsed ${parsed} file(s) via worker pool (size ${stats.poolSize})…` });
      }
    } else {
      workerStats = {
        usedPool: false,
        poolSize: 0,
        chunksTotal: 0,
        chunksViaWorker: 0,
        chunksInlineFallback: 0,
        chunksCancelled: 0,
        workerErrors: 0,
      };
      for (const item of readable) {
        const facts = parser.parseFile({ path: item.path, text: item.text }); // contract: never throws
        fileCache.set(item.resourceKey, { mtimeMs: item.stat.mtime, size: item.stat.size, facts });
        factsList.push(facts);
        parsed++;
        if (progress) {
          progress.report({ message: `parsed ${parsed}, cached ${cached} of ${uris.length} file(s)…` });
        }
      }
    }
  }
  timingMs.parse = Date.now() - tParse0;

  const cancelled = isCancelled();
  // Drop cache entries for files that disappeared (renamed/deleted) so the
  // index never resurrects stale classes. H4: skipped entirely on a
  // cancelled run -- `seen` is only a PARTIAL snapshot of the workspace at
  // that point, and pruning against a partial snapshot could wrongly evict
  // still-live files this run simply never got to yet.
  if (!cancelled) {
    for (const resourceKey of [...fileCache.keys()]) {
      if (!seen.has(resourceKey)) fileCache.delete(resourceKey);
    }
    lastApexUriSet = new Set(seen); // H6: this sweep's own path set becomes the baseline the next dirty-set check reasons about
  }

  const applied = cancelled
    ? { factsList, overlaid: 0 }
    : editoroverlay.applyApexOverlays(factsList, seen, editorOverlays, parser.parseFile);
  return {
    factsList: applied.factsList,
    parsed,
    cached,
    unreadable,
    total: uris.length,
    cancelled,
    sweepKind: 'full',
    timingMs,
    workerStats,
    overlaid: applied.overlaid,
  };
}

// Workspace globs cover standard SFDX layouts
// (force-app/main/default/{lwc,aura,flows,omniscripts}/...), plus a VF
// pattern for Visualforce pages/components under their conventional SFDX
// folder names. Same exclusions as scanWorkspaceUris,
// plus __tests__ (Jest specs under an LWC bundle import the same
// '@salesforce/apex/Cls.method' specifier to jest.mock() it, but represent
// zero real Apex call edges — metascan.js already excludes these by path
// too; excluding at the glob level here just avoids reading them at all).
const META_GLOB_EXCLUDE = '{**/node_modules/**,**/.sfdx/**,**/.sf/**,**/.git/**,**/__tests__/**}';
const META_GLOBS = [
  '**/lwc/**/*.js',
  '**/aura/**/*.cmp',
  '**/aura/**/*.app',
  '**/aura/**/*.js',
  '**/flows/**/*.flow-meta.xml',
  '**/omniscripts/**/*.os-meta.xml',
  '**/omniscripts/**/*.json',
  '**/pages/**/*.page',
  '**/components/**/*.component',
  '**/customMetadata/**/*.md-meta.xml',
  '**/permissionsets/**/*.permissionset-meta.xml',
  '**/profiles/**/*.profile-meta.xml',
];

// Apply the same apexCallGraph.excludeGlobs post-filter as the
// Apex scan above, so one setting covers both scans and full/incremental
// semantics remain identical even for literal commas or malformed patterns.
async function scanMetaWorkspaceUris(excludeGlobs) {
  const results = await Promise.all(META_GLOBS.map((g) => vscode.workspace.findFiles(g, META_GLOB_EXCLUDE)));
  const seen = new Set();
  const uris = [];
  for (const arr of results) {
    for (const uri of arr) {
      if (isUserExcludedUri(uri, excludeGlobs)) continue;
      const resourceKey = resourceKeyForUri(uri);
      if (seen.has(resourceKey)) continue;
      seen.add(resourceKey);
      uris.push(uri);
    }
  }
  return uris;
}

// Reads (mtime-cached, mirroring scanAndParse above) every metadata source
// file into { path, text } pairs -- extraction itself (metascan.js) happens
// separately in computeMetaRefs, since Aura needs cross-file bundle context
// that isn't available file-by-file.
// Uses the same opts.token/opts.dirtySnapshot contract as
// scanAndParse above -- see that function's own header comment for the
// full rationale; the two functions are deliberately parallel in shape.
// No H7 pooling here: metadata extraction is regex-based text scanning
// (metascan.js), not the CPU-bound recursive-descent parse Apex needs --
// per this file's own pre-existing A7 header note it already targets
// "<300ms metascan perf bar" single-threaded, so there is no cold-parse
// bottleneck here worth a worker pool's spin-up cost.
async function scanMetaFiles(progress, excludeGlobs, opts) {
  opts = opts || {};
  const token = opts.token || null;
  const dirtySnapshot = opts.dirtySnapshot || null;
  const editorOverlays = opts.editorOverlays || null;
  const isCancelled = () => !!(token && token.isCancellationRequested);

  const useFullSweep = !dirtySnapshot || dirtySnapshot.fullSweepNeeded || !lastMetaUriSet;

  if (!useFullSweep) {
    const dirtyMeta = new Set(
      [...dirtySnapshot.dirty].filter(
        (resourceKey) => {
          const uri = resourceUriFromKey(resourceKey);
          return !!(
            uri &&
            META_EXT_RE.test(uri.fsPath) &&
            !APEX_EXT_RE.test(uri.fsPath) &&
            !isHardExcludedPath(uri.fsPath) &&
            !isUserExcludedUri(uri, excludeGlobs)
          );
        }
      )
    );
    const deletedMeta = new Set(
      [...dirtySnapshot.deleted].filter((resourceKey) => {
        const uri = resourceUriFromKey(resourceKey);
        return !!(uri && META_EXT_RE.test(uri.fsPath) && !APEX_EXT_RE.test(uri.fsPath));
      })
    );

    if (dirtyMeta.size === 0 && deletedMeta.size === 0) {
      const files = [];
      for (const resourceKey of lastMetaUriSet) {
        const entry = metaFileCache.get(resourceKey);
        if (entry) files.push({ path: entry.sourcePath, text: entry.metaText });
      }
      const applied = editoroverlay.applyMetadataOverlays(files, lastMetaUriSet, editorOverlays);
      return {
        files: applied.files,
        read: 0,
        cached: files.length,
        unreadable: 0,
        total: files.length,
        cancelled: false,
        sweepKind: 'skipped',
        overlaid: applied.overlaid,
      };
    }

    for (const resourceKey of deletedMeta) {
      metaFileCache.delete(resourceKey);
      lastMetaUriSet.delete(resourceKey);
    }
    let read = 0;
    let unreadable = 0;
    for (const resourceKey of dirtyMeta) {
      if (isCancelled()) break;
      const uri = resourceUriFromKey(resourceKey);
      if (!uri || !vscode.workspace.getWorkspaceFolder(uri)) continue;
      const sourcePath = sourcePathForUri(uri);
      let stat;
      try {
        stat = await vscode.workspace.fs.stat(uri);
      } catch (e) {
        metaFileCache.delete(resourceKey);
        lastMetaUriSet.delete(resourceKey);
        continue;
      }
      const entry = metaFileCache.get(resourceKey);
      // Same rule as dirty Apex: an explicit watcher event always wins over
      // an unchanged mtime+size tuple.
      if (scanflow.canReuseStatCache(entry, stat, scanflow.isExplicitlyDirty(dirtySnapshot, resourceKey))) {
        lastMetaUriSet.add(resourceKey); // defensive; forceFresh currently makes this unreachable
        continue;
      }
      try {
        const bytes = await vscode.workspace.fs.readFile(uri);
        const text = Buffer.from(bytes).toString('utf8');
        metaFileCache.set(resourceKey, { mtimeMs: stat.mtime, size: stat.size, sourcePath, metaText: text });
        lastMetaUriSet.add(resourceKey);
        read++;
      } catch (e) {
        unreadable++;
        metaFileCache.delete(resourceKey);
        lastMetaUriSet.delete(resourceKey);
      }
      if (progress) progress.report({ message: `metadata: re-read ${read} changed file(s)…` });
    }

    const files = [];
    for (const resourceKey of lastMetaUriSet) {
      const entry = metaFileCache.get(resourceKey);
      if (entry) files.push({ path: entry.sourcePath, text: entry.metaText });
    }
    const applied = editoroverlay.applyMetadataOverlays(files, lastMetaUriSet, editorOverlays);
    return {
      files: applied.files,
      read,
      cached: files.length - read,
      unreadable,
      total: files.length,
      cancelled: isCancelled(),
      sweepKind: 'incremental',
      overlaid: applied.overlaid,
    };
  }

  const uris = await scanMetaWorkspaceUris(excludeGlobs);
  const seen = new Set();
  const files = [];
  let read = 0;
  let cached = 0;
  let unreadable = 0;

  for (const uri of uris) {
    if (isCancelled()) break;
    const resourceKey = resourceKeyForUri(uri);
    const sourcePath = sourcePathForUri(uri);
    seen.add(resourceKey);
    let stat;
    try {
      stat = await vscode.workspace.fs.stat(uri);
    } catch (e) {
      unreadable++;
      continue;
    }
    const entry = metaFileCache.get(resourceKey);
    let text;
    // H6b: same mtimeMs+size tiebreak as scanAndParse's fileCache above.
    if (scanflow.canReuseStatCache(entry, stat, scanflow.isExplicitlyDirty(dirtySnapshot, resourceKey))) {
      text = entry.metaText;
      cached++;
    } else {
      try {
        const bytes = await vscode.workspace.fs.readFile(uri);
        text = Buffer.from(bytes).toString('utf8');
        metaFileCache.set(resourceKey, { mtimeMs: stat.mtime, size: stat.size, sourcePath, metaText: text });
        read++;
      } catch (e) {
        unreadable++;
        continue;
      }
    }
    files.push({ path: sourcePath, text });
    if (progress) {
      progress.report({ message: `metadata: read ${read}, cached ${cached} of ${uris.length} file(s)…` });
    }
  }

  const cancelled = isCancelled();
  if (!cancelled) {
    for (const resourceKey of [...metaFileCache.keys()]) {
      if (!seen.has(resourceKey)) metaFileCache.delete(resourceKey);
    }
    lastMetaUriSet = new Set(seen);
  }

  const applied = cancelled
    ? { files, overlaid: 0 }
    : editoroverlay.applyMetadataOverlays(files, seen, editorOverlays);
  return {
    files: applied.files,
    read,
    cached,
    unreadable,
    total: uris.length,
    cancelled,
    sweepKind: 'full',
    overlaid: applied.overlaid,
  };
}

// =========================================================================
// F6/v0.15: disk-persisted clean Apex-facts cache (cachestore.js does the pure
// serialize/deserialize; everything here is the vscode-side I/O plumbing:
// where the cache files live, when they get written, and hydrating the
// in-memory fileCache at activation). Metadata source is memory-only.
// =========================================================================

// Stable short id for "this workspace" so multiple different projects
// sharing the same context.globalStorageUri never collide on one cache
// file, and the SAME project's cache file is found again across sessions.
// Multi-root workspaces are folded into one id (sorted, joined folder
// URIs) since fileCache/metaFileCache are themselves workspace-wide, not
// per-folder. Scheme + authority are part of the hash, preventing same-path
// remote workspaces from sharing a persisted cache file.
function workspaceCacheKey() {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || !folders.length) return null;
  const joined = workspacepaths.workspaceSetIdentity(folders);
  return crypto.createHash('sha1').update(joined).digest('hex').slice(0, 16);
}

// Resolves to null when there's no open workspace folder -- nothing stable
// to key a cache file off, and scanWorkspaceUris() would find nothing to
// scan anyway, so persistence is simply skipped for that session.
function cacheUris(context) {
  const key = workspaceCacheKey();
  if (!key) return null;
  return {
    facts: vscode.Uri.joinPath(context.globalStorageUri, `facts-v${ENGINE_CACHE_VERSION}-${key}.json`),
  };
}

async function cleanupCacheFiles(context, opts) {
  return cachefiles.cleanupCacheFiles(vscode.workspace.fs, vscode.Uri, context.globalStorageUri, {
    ...(opts || {}),
    retentionMs: CACHE_RETENTION_MS,
  });
}

// Reads one cache file (if present) and merges its entries into targetMap.
// Best-effort in every direction: a missing file (first run ever, or first
// run after a globalStorage clear) is the normal case, not an error; a
// corrupt or version-mismatched file is handled by cachestore.deserialize()
// returning null (never throws) and is treated exactly the same as
// "missing" -- either way the next scan just falls back to reading/parsing
// every file cold, same as it always could.
async function hydrateOneCache(uri, targetMap, dataKey) {
  let bytes;
  try {
    bytes = await vscode.workspace.fs.readFile(uri);
  } catch (e) {
    return; // no cache file yet -- fine
  }
  const text = Buffer.from(bytes).toString('utf8');
  const payload = cachestore.deserialize(text, ENGINE_CACHE_VERSION);
  if (!payload) return; // corrupt or from a different engine version -- cold scan will repopulate
  const restored = cachestore.entriesToMap(payload.entries, dataKey);
  restored.forEach((value, fsPath) => targetMap.set(fsPath, value));
}

// Called once from activate(), before the first scan -- removes legacy raw-
// source caches, expires old safe facts, then hydrates clean Apex facts from
// the last session (if any). Metadata is intentionally reread after restart.
async function hydrateCaches(context) {
  // Remove source-bearing pre-v9 facts/meta caches and expire old safe facts
  // before considering hydration. Metadata text is memory-only; v9 also
  // excludes successful-parse source fragments and literal values.
  const cleanup = await cleanupCacheFiles(context);
  const uris = cacheUris(context);
  if (!uris) return cleanup;
  await hydrateOneCache(uris.facts, fileCache, 'facts');
  return cleanup;
}

async function persistCachesNow(context) {
  const uris = cacheUris(context);
  if (!uris) return;
  await cachefiles.persistSafeFactsCache(
    vscode.workspace.fs,
    context.globalStorageUri,
    uris.facts,
    ENGINE_CACHE_VERSION,
    fileCache
  );
}

function resetMemoryCaches() {
  fileCache.clear();
  metaFileCache.clear();
  lastApexUriSet = null;
  lastMetaUriSet = null;
  dirtyTracker.markFullSweepNeeded();
}

function clearCaches(context) {
  if (persistTimer) clearTimeout(persistTimer);
  persistTimer = null;
  pendingPersistContext = null;
  pendingPersistEpoch = null;

  // reset() increments the epoch synchronously. Clear immediately for the
  // command's in-memory semantics, then clear once more after all older
  // scans/writes have drained before deleting their possible disk output.
  const reset = cacheCoordinator.reset(async () => {
    resetMemoryCaches();
    return cleanupCacheFiles(context, { clearAll: true });
  });
  resetMemoryCaches();
  return reset;
}

let persistTimer = null;
let pendingPersistContext = null; // set alongside persistTimer, read by deactivate()'s flush below
let pendingPersistEpoch = null;

// Debounced disk write, scheduled after every scan (see computeTrace below).
// A failed write is swallowed -- the in-memory caches are still correct for
// the rest of this session either way, only the on-disk copy stays stale
// until the next successful write, which must never surface as a user-facing
// error for what is purely a perf optimization.
function schedulePersistCaches(context) {
  if (persistTimer) clearTimeout(persistTimer);
  pendingPersistContext = context;
  pendingPersistEpoch = cacheCoordinator.currentEpoch();
  persistTimer = setTimeout(() => {
    const epoch = pendingPersistEpoch;
    persistTimer = null;
    pendingPersistContext = null;
    pendingPersistEpoch = null;
    cacheCoordinator.enqueuePersist(epoch, () => persistCachesNow(context)).catch(() => {});
  }, PERSIST_DEBOUNCE_MS);
}

// Groups a flat { path, text }[] of Aura-bundle files by directory, the
// same way metascan.js's own scanBundle() does internally -- reproduced
// here (rather than reused) because computeMetaRefs needs to call
// scanBundle() once PER (markup, single-js-file) pair below, to keep every
// resulting MetaRef traceable back to the one physical file it came from
// (see the path-tagging note in computeMetaRefs).
function groupAuraFilesByDir(files) {
  const groups = new Map(); // dir -> { markup, jsFiles: [] }
  for (const f of files) {
    const idx = Math.max(f.path.lastIndexOf('/'), f.path.lastIndexOf('\\'));
    const dir = idx === -1 ? '' : f.path.slice(0, idx);
    let g = groups.get(dir);
    if (!g) {
      g = { markup: null, jsFiles: [] };
      groups.set(dir, g);
    }
    if (/\.(cmp|app)$/i.test(f.path)) {
      g.markup = f;
    } else if (/\.js$/i.test(f.path)) {
      g.jsFiles.push(f);
    }
  }
  return groups;
}

// metascan.js's MetaRef contract deliberately omits a `path` field (see its
// header comment) -- resolver.js's attachMetaCallers/buildMetaChildren
// default it to '' defensively when absent, but for real "jump to source"
// UX every meta caller node needs one, so this is the one place that stamps
// it on, matching each ref back to the exact file it was extracted from.
//
// Non-Aura sources: parseMetaFile(file) only ever reads that one file, so
// every ref it returns is tagged with that file's path.
//
// Aura is special-cased (see the module-level metaFileCache comment): per
// bundle directory, the class-level ref (methodName === null) is tagged
// with the markup file's path, and each js file's method-level refs are
// obtained by calling scanBundle([markup, thatOneJsFile]) in isolation
// (rather than scanBundle(allFilesInBundle) once) so the resulting refs can
// be tagged with THAT js file's path unambiguously -- with more than one
// js file in a bundle (Controller.js + Helper.js), calling scanBundle with
// the whole group at once would still be correct in aggregate but would
// leave no way to tell which js file each method-level ref came from.
function computeMetaRefs(files) {
  const refs = [];
  const auraFiles = files.filter((f) => /(^|[\\/])aura[\\/]/i.test(f.path));
  const otherFiles = files.filter((f) => !/(^|[\\/])aura[\\/]/i.test(f.path));

  for (const f of otherFiles) {
    for (const ref of metascan.parseMetaFile(f)) {
      ref.path = f.path;
      refs.push(ref);
    }
  }

  const groups = groupAuraFilesByDir(auraFiles);
  for (const g of groups.values()) {
    if (!g.markup) continue; // no controller declared -> nothing to attribute method-level refs to

    for (const ref of metascan.parseMetaFile(g.markup)) {
      ref.path = g.markup.path; // class-level ref
      refs.push(ref);
    }

    for (const jsFile of g.jsFiles) {
      for (const ref of metascan.scanBundle([g.markup, jsFile])) {
        if (ref.methodName == null) continue; // class-level ref, already captured above -- skip to avoid double-counting
        ref.path = jsFile.path;
        refs.push(ref);
      }
    }
  }

  return refs;
}

// =========================================================================
// B1 (v0.7): sfdx-project.json discovery -> packageOf(fsPath) -> label|null.
//
// Every sfdx-project.json found across the open workspace folder(s) is
// parsed for its `packageDirectories` ({ path, package?, default? }), each
// contributing one (absolute-prefix -> label) entry to a longest-prefix
// map: `label` is the declared `package` name when present, else the
// directory path's own last segment (per B1's contract) -- e.g. this
// a project may declare `force-app` (no `package` field, label
// falls back to `force-app`), `pkg-billing` (`package: "nova-billing"`),
// `pkg-shared` (`package: "nova-shared"`).
//
// Re-discovered FRESH on every scanAndBuildIndex() call (see its call site
// below) -- deliberately NOT cached across runs: sfdx-project.json files
// are few and tiny, so re-reading them every trace is cheap, and doing so
// means an edit to packageDirectories takes effect on the very next trace
// with no reload/cache-invalidation bookkeeping needed. This is also why
// B1 does NOT bump ENGINE_CACHE_VERSION -- packageOf is a pure opts-time
// hook layered on top of the (unchanged) FileFacts/MetaRef cache shape, and
// is never itself persisted.
//
// A workspace with no sfdx-project.json anywhere yields an empty prefix
// list, so the returned packageOf() returns null for every path -- see the
// module-header note on buildSemanticIndex's opts contract for why that
// keeps a packageless workspace's output byte-identical to pre-v0.7.
//
// v0.8 (N3): the SAME discovery pass also reads each sfdx-project.json's
// top-level `namespace` property -- the org's OWN managed-package namespace
// (e.g. `"namespace": "vtx"` for a namespaced org, absent/empty for an
// unlocked/unmanaged workspace, which is the overwhelming common case and
// must stay behaviorally inert -- see ownNamespace's attachment below).
// This is pure plumbing: discoverPackageMap()/scanAndBuildIndex() only
// EXTRACT the value and hand it to resolver.js as opts.ownNamespace,
// alongside the existing opts.packageOf/opts.defaultPackage. resolver.js
// strips the own-namespace prefix before local class/object lookup.
// No new vscode.workspace.fs read is added -- `json` is already parsed for
// packageDirectories a few lines below, so this reads one more property off
// the SAME parsed object, at zero extra I/O cost.
const SFDX_PROJECT_GLOB_EXCLUDE = '{**/node_modules/**,**/.sfdx/**,**/.sf/**,**/.git/**}';

// OS-separator-agnostic path normalization so prefix comparison in
// packageOf() below is a plain string operation regardless of platform --
// darwin/linux fsPaths are already '/'-separated; a Windows workspace's
// fsPaths use '\\', which this collapses to '/' the same way on both the
// stored prefix and the path being looked up, and strips any trailing
// separator so `X` and `X/` compare equal as prefixes.
function normalizePathForPrefix(p) {
  return String(p).replace(/\\/g, '/').replace(/\/+$/, '');
}

// Returns a packageOf(fsPath) function. Best-effort throughout: a missing
// workspace, an unreadable or invalid-JSON sfdx-project.json, or a
// malformed packageDirectories entry never throws -- each failure just
// means that one project file (or that one directory entry) contributes
// nothing to the map, same as if it didn't exist.
async function discoverPackageMap() {
  let uris = [];
  try {
    uris = await vscode.workspace.findFiles('**/sfdx-project.json', SFDX_PROJECT_GLOB_EXCLUDE);
  } catch (e) {
    return () => null;
  }

  const prefixes = []; // { prefix, label }[], sorted longest-prefix-first below
  // Label of the first packageDirectories entry marked
  // `default: true`, found across every discovered sfdx-project.json.
  // resolver.js's resolveDuplicateBucket() rule 2 (B2's "candidate in the
  // DEFAULT package" fallback) needs this label as opts.defaultPackage --
  // this function used to parse .path and .package but never read .default
  // at all, so that rule was permanently dead code in the shipped
  // extension. See its attachment onto the returned packageOf function
  // below for why this isn't a second return value.
  let defaultPackage = null;
  // v0.8 (N3): the OWN-ORG namespace -- first non-empty `namespace` string
  // found across every discovered sfdx-project.json wins, same first-wins
  // tie-break spirit as defaultPackage immediately above (a workspace with
  // 2+ project files declaring DIFFERENT namespaces is a malformed/unusual
  // setup no single "correct" answer exists for; picking the first found is
  // deterministic and matches how this function already resolves every
  // other cross-file ambiguity). Stays null (never an empty string) for the
  // common unmanaged/no-namespace workspace -- see ownNamespace's
  // attachment below for why that null is what keeps this plumbing inert.
  let ownNamespace = null;

  for (const uri of uris) {
    let json;
    try {
      const bytes = await vscode.workspace.fs.readFile(uri);
      json = JSON.parse(Buffer.from(bytes).toString('utf8'));
    } catch (e) {
      continue; // unreadable or invalid JSON -- skip this one project file, never fatal to the scan
    }
    // v0.8 (N3): read alongside packageDirectories below -- same parsed
    // `json`, no extra file read. A non-string/empty/whitespace-only
    // `namespace` (missing property, wrong JSON type, `""`) never sets
    // ownNamespace -- exactly the "absent/empty -> no stripping" half of
    // N3's contract, decided here at the source rather than pushed onto
    // every downstream reader.
    if (
      ownNamespace == null &&
      typeof json.namespace === 'string' &&
      json.namespace.trim()
    ) {
      ownNamespace = json.namespace.trim();
    }
    const dirs = Array.isArray(json.packageDirectories) ? json.packageDirectories : [];
    // Strip the trailing 'sfdx-project.json' filename (whichever separator
    // precedes it) to get the project root, keeping its trailing separator
    // so `projectRoot + relPath` concatenates cleanly below.
    const projectRoot = sourcePathForUri(uri).replace(/[^\\/]*$/, '');

    for (const dir of dirs) {
      if (!dir || typeof dir.path !== 'string' || !dir.path.trim()) continue;
      const relPath = dir.path.replace(/^[\\/]+/, '').replace(/[\\/]+$/, '');
      if (!relPath) continue;
      const label =
        typeof dir.package === 'string' && dir.package.trim() ? dir.package.trim() : relPath.split(/[\\/]/).pop();
      prefixes.push({ prefix: normalizePathForPrefix(projectRoot + relPath), label });
      // The first default:true entry wins (a malformed sfdx-project.json
      // with 2+ default:true entries must not throw; picking the first is a
      // defensible, deterministic
      // tie-break, same spirit as B2's own "first wins" duplicate handling).
      if (defaultPackage == null && dir.default === true) defaultPackage = label;
    }
  }

  // Longest prefix wins -- sort once, descending by prefix length, so
  // packageOf() below just returns the first match.
  prefixes.sort((a, b) => b.prefix.length - a.prefix.length);

  const packageOf = function packageOf(fsPath) {
    if (!fsPath || !prefixes.length) return null;
    const norm = normalizePathForPrefix(fsPath);
    for (const { prefix, label } of prefixes) {
      if (norm === prefix || norm.startsWith(prefix + '/')) return label;
    }
    return null;
  };
  // Attached to the returned function (not a second return
  // value / wrapper object) so every existing caller that treats
  // discoverPackageMap()'s result as a plain packageOf(fsPath) function --
  // keeps working unchanged; scanAndBuildIndex (below) is the only
  // reader of this property.
  packageOf.defaultPackage = defaultPackage;
  // v0.8 (N3): same attachment convention as defaultPackage immediately
  // above -- a third value riding on the one packageOf(fsPath) function
  // every existing caller already treats as the whole return value, not a
  // second/third return slot. null for the (overwhelmingly common) no-owner-
  // namespace workspace.
  packageOf.ownNamespace = ownNamespace;
  return packageOf;
}

function escapeRegExp(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// H5(c): true when `word` is called as `receiver.word(` on this one line,
// with receiver != 'this' (a `this.word(...)` call can only ever mean the
// enclosing class's own method, never ambiguous). Returns the first such
// receiver identifier found, or null when the word isn't called through any
// non-'this' receiver on this line (a bare `word(...)` call, or no call at
// all -- cursor merely sitting on a declaration, say).
function findReceiverCallOnLine(lineText, word) {
  if (!lineText || !word) return null;
  const re = new RegExp('([A-Za-z_$][\\w$]*)\\s*\\.\\s*' + escapeRegExp(word) + '\\s*\\(', 'g');
  let m;
  while ((m = re.exec(lineText))) {
    if (m[1] && m[1] !== 'this') return m[1];
  }
  return null;
}

// Best-effort local/parameter/field type lookup for `ident`, scanning the
// WHOLE document text for a declaration shape ('Type ident =', 'Type
// ident;', 'Type ident,'/'Type ident)' for a parameter). A crude regex, not
// a parser -- generics ('List<Account> ident') only ever match the outer
// type name ('List'), which is harmless: no user class is ever named
// 'List', so the ambiguity guard below correctly falls back to "couldn't
// resolve" rather than guessing wrong. Only ever used to offer a SECOND
// QuickPick candidate (see resolveCursorAmbiguity) -- a miss here just means
// today's (still contract-correct) enclosing-method pick is used instead.
function guessReceiverType(text, ident) {
  if (!text || !ident) return null;
  const re = new RegExp('\\b([A-Za-z_][\\w.]*)\\s+' + escapeRegExp(ident) + '\\s*(?:=[^=]|[;,)])');
  const m = re.exec(text);
  return m ? m[1] : null;
}

// H5(c): cursor-ambiguity guard. Placing the cursor on `svc.process()`
// where `svc` is declared as some OTHER type, inside a file whose own class
// also happens to declare a method named `process`, used to silently
// resolve to the enclosing class's `process` -- with no indication to the
// user that the wrong thing may have been traced (previously a documented
// [note]-level limitation, not fixed). Returns:
//   - undefined  when the word is NOT called through a non-'this' receiver
//                on the cursor line -- not ambiguous, caller proceeds with
//                today's enclosing-method pick exactly as before.
//   - null       when the 2-item QuickPick was shown and the user cancelled.
//   - a target   ({classLower, methodLower}) otherwise: either the user's
//                QuickPick choice, or the enclosing-method fallback (with an
//                explicit note shown) when the receiver's type could not be
//                resolved to a class that actually declares this method.
async function resolveCursorAmbiguity(index, enclosingCls, word, wordLower, enclosingLower, lineText, documentText) {
  const receiverIdent = findReceiverCallOnLine(lineText, word);
  if (!receiverIdent) return undefined;

  const guessedType = typeof documentText === 'string' ? guessReceiverType(documentText, receiverIdent) : null;
  const guessedTypeLower = guessedType ? guessedType.toLowerCase() : null;
  let receiverTarget = null;
  if (guessedTypeLower && index.classes.has(guessedTypeLower)) {
    const rcls = index.classes.get(guessedTypeLower);
    const rmethod = (rcls.methods || []).find((m) => (m.name || '').toLowerCase() === wordLower);
    if (rmethod) {
      receiverTarget = { classLower: guessedTypeLower, methodLower: wordLower, label: `${rcls.name}.${rmethod.name}` };
    }
  }

  if (!receiverTarget) {
    vscode.window.showInformationMessage(
      `Apex Call Graph: '${word}' is called on '${receiverIdent}.' here, but its type could not be resolved -- tracing the enclosing class's '${word}' instead.`
    );
    return { classLower: enclosingLower, methodLower: wordLower };
  }

  const picks = [
    { label: `${enclosingCls.name}.${word}`, description: 'enclosing class', target: { classLower: enclosingLower, methodLower: wordLower } },
    { label: receiverTarget.label, description: `via '${receiverIdent}.'`, target: { classLower: receiverTarget.classLower, methodLower: receiverTarget.methodLower } },
  ];
  const chosen = await vscode.window.showQuickPick(picks, {
    placeHolder: `'${word}' is ambiguous -- the enclosing class's method, or '${receiverIdent}'s method?`,
  });
  if (!chosen) return null;
  return chosen.target;
}

// H5(b): suggestTargets picker hygiene. targets.js owns the actual rules
// (suppress '(init)', relabel '<init>' -> 'ClassName (constructor)', dedupe
// same-(classLower,label) entries, re-sort by label) as a pure post-filter
// layered on top of resolver.suggestTargets(index) -- see targets.js's
// header comment for the full contract. This is just the wiring: refine,
// then reshape into the { label, picked, target } shape showQuickPick/the
// chosen.target.* read below expects.
//
// v0.7 / B3: targets.refineTargets() now ALSO suffixes a duplicated class
// name's label with ' (pkgLabel)' and (only when the underlying
// resolver.suggestTargets() item actually carried one) keeps a `package`
// field on its output. When present, that field is carried through onto
// `target` too -- so a QuickPick pick of e.g. "AcmeOrderUtil (nova-billing)"
// resolves to a target resolver.js's buildCallerTree/buildCalleeTree can use
// to pick the RIGHT one of the duplicated ClassMeta candidates, not just
// whichever one happens to be bucketed first. In a packageless workspace
// (or against a resolver.js without package-aware targets), refineTargets()
// never attaches `package` at all, so `target` keeps its pre-v0.7 two-field
// shape exactly.
function buildSuggestPicks(index) {
  const refined = targets.refineTargets(resolver.suggestTargets(index));
  return refined.map((t) => {
    const target = { classLower: t.classLower, methodLower: t.methodLower };
    if (Object.prototype.hasOwnProperty.call(t, 'package')) target.package = t.package;
    return { label: t.label, picked: false, target };
  });
}

// Cursor resolution per contract: word == method of enclosing file's class
// -> method target; word == known class -> class target; else QuickPick
// over resolver.suggestTargets(index). H5(c) adds a cursor-ambiguity guard
// (see resolveCursorAmbiguity above) ahead of the enclosing-class pick.
//
// Shared between both trace directions -- `direction`
// only ever affects the QuickPick's placeholder wording below (the
// enclosing-method/known-class fast paths above it stay direction-agnostic,
// since "which class/method" is exactly the same question either way).
async function resolveTarget(index, direction, targetContext) {
  const editor = targetContext ? null : vscode.window.activeTextEditor;
  const position = targetContext
    ? targetContext.position
    : editor
      ? editor.selection.active
      : null;
  let word = targetContext ? targetContext.word : null;
  let cursorLineText = targetContext ? targetContext.cursorLineText : null;
  let fileName = targetContext ? targetContext.fileName : null;
  let documentText = targetContext ? targetContext.documentText : null;
  if (editor && position) {
    const range = editor.document.getWordRangeAtPosition(position);
    if (range) word = editor.document.getText(range);
    cursorLineText = editor.document.lineAt(position.line).text;
    fileName = sourcePathForUri(editor.document.uri) || editor.document.fileName;
    documentText = editor.document.getText();
  }
  const wordLower = word ? word.toLowerCase() : null;

  let enclosingLower = null;
  if (fileName && /\.(cls|trigger)$/i.test(fileName)) {
    const base = fileName.split(/[\\/]/).pop().replace(/\.(cls|trigger)$/i, '');
    if (index.classes.has(base.toLowerCase())) enclosingLower = base.toLowerCase();
  }

  if (wordLower && enclosingLower) {
    const cls = index.classes.get(enclosingLower);
    const hasMethod = (cls.methods || []).some((m) => (m.name || '').toLowerCase() === wordLower);
    if (hasMethod) {
      const ambiguous = await resolveCursorAmbiguity(
        index,
        cls,
        word,
        wordLower,
        enclosingLower,
        cursorLineText,
        documentText
      );
      if (ambiguous !== undefined) return ambiguous; // null (cancelled) or a resolved target
      return { classLower: enclosingLower, methodLower: wordLower };
    }
  }

  if (wordLower && index.classes.has(wordLower)) {
    return { classLower: wordLower, methodLower: null };
  }

  const picks = buildSuggestPicks(index);
  if (!picks.length) {
    vscode.window.showWarningMessage('Apex Call Graph: no traceable classes or methods found.');
    return null;
  }
  const placeHolder = direction === 'callees'
    ? 'Trace what calls out from which Apex method or class?'
    : direction === 'impact'
      ? 'Analyze the impact of changing which Apex method?'
      : 'Trace callers of which Apex method or class?';
  const chosen = await vscode.window.showQuickPick(picks, { placeHolder });
  if (!chosen) return null;
  const target = { classLower: chosen.target.classLower, methodLower: chosen.target.methodLower || null };
  if (Object.prototype.hasOwnProperty.call(chosen.target, 'package')) target.package = chosen.target.package;
  return target;
}

// v0.14 Impact Analysis: resolve one concrete overload after the ordinary
// cursor/QuickPick target resolver has selected a method family.  A cursor
// on a declaration line wins without another prompt; all other overloaded
// targets get an explicit signature picker so the report never silently
// mixes sibling overloads.
async function resolveImpactReport(index, target, targetContext) {
  const initial = resolver.buildImpactReport(index, target);
  if (!initial) return null;
  if (!initial.needsOverloadChoice) return initial;

  let overloadSig = null;
  const editor = targetContext ? null : vscode.window.activeTextEditor;
  const position = targetContext
    ? targetContext.position
    : editor
      ? editor.selection.active
      : null;
  const activeFileName = targetContext
    ? targetContext.fileName
    : editor
      ? (sourcePathForUri(editor.document.uri) || editor.document.fileName)
      : null;
  const cm = index && index.classes instanceof Map ? index.classes.get(target.classLower) : null;
  if (activeFileName && position && cm && cm.path) {
    const activePath = String(activeFileName).replace(/\\/g, '/').toLowerCase();
    const targetPath = String(cm.path).replace(/\\/g, '/').toLowerCase();
    if (activePath === targetPath) {
      const declaration = targets.findDeclarationOverload(
        cm.methods || [],
        target.methodLower,
        position.line + 1
      );
      if (declaration) overloadSig = declaration.overloadSig;
    }
  }

  if (!overloadSig) {
    const picks = initial.availableOverloads.map((overload) => ({
      label: overload.overloadSig,
      description: (overload.params || []).map((p) => p.name).filter(Boolean).join(', '),
      overloadSig: overload.overloadSig,
    }));
    const chosen = await vscode.window.showQuickPick(picks, {
      placeHolder: `Choose the ${initial.target.label} overload whose signature may change`,
      matchOnDescription: true,
    });
    if (!chosen) return null;
    overloadSig = chosen.overloadSig;
  }

  return resolver.buildImpactReport(index, { ...target, overloadSig });
}

// =========================================================================
// Progressive-depth tree building. Every function in this
// section is a plain function of its arguments (no vscode, no closure over
// activate()'s session state) so it can be called identically from
// LOAD_MORE_COMMAND's tree-view handler and the Path Map webview's
// 'expand' message handler -- see their wiring inside activate() below.
// =========================================================================

// Shared resolver.js call shape used by a fresh trace (traceTarget),
// orientation-toggle's expansion-reset rebuild, and expandFrontierKey's
// stepped lazy-expansion rebuilds. `expandedKeys` is passed straight
// through as opts.expandedKeys; against a
// resolver.js build without initialDepth/expandedKeys support, these are
// simply inert extra opts properties and the whole tree materializes
// eagerly up to maxDepth.
function buildTreeForTarget(index, target, dir, settings, expandedKeys) {
  const opts = {
    maxDepth: settings.maxDepth,
    maxNodes: settings.maxNodes,
    initialDepth: settings.initialDepth,
    expandedKeys,
    showUnconfirmed: settings.showUnconfirmed,
  };
  return dir === 'callees' ? resolver.buildCalleeTree(index, target, opts) : resolver.buildCallerTree(index, target, opts);
}

// resolver.js's TNode does NOT stamp an
// explicit `methodKey` identity field (confirmed against
// resolver.js -- its cycleKey stays purely internal); uitree.js's exported
// frontierMethodKey() is the authoritative derivation both this file and
// uitree.js's own shapeLoadMoreChild use, so every key this file computes
// or compares is guaranteed to agree with the `expandKey` uitree.js/
// pathmap.js already stamped onto their own synthetic load-more items. Not
// gated on `node.expandable` here -- unlike directFrontierChildKeys below,
// this needs to re-locate a node REGARDLESS of whether it is currently
// frontier (the just-expanded node, mid-expandStep-loop, no longer is).
//
// Walks a raw TNode tree collecting every node whose derived key is in
// `keySet` into `out` (Map<key, TNode>) -- used by expandFrontierKey to
// re-locate, in a FRESHLY rebuilt tree, the exact node(s) whose key(s) were
// just added to expandedKeys.
function collectNodesByKeys(node, keySet, out) {
  if (!node) return;
  const key = frontierMethodKey(node);
  if (key && keySet.has(key) && !out.has(key)) out.set(key, node);
  for (const c of node.children || []) collectNodesByKeys(c, keySet, out);
}

// Direct (non-recursive) children of `nodes` that are themselves still
// frontier (expandable:true) -- exactly the set expandStep's next
// iteration should add because the engine stays single-level (see
// expandFrontierKey's own header note below). Gated on `c.expandable`
// (unlike collectNodesByKeys above) since only a genuinely-still-frontier
// child remains available for future enhancement.
function directFrontierChildKeys(nodes) {
  const keys = new Set();
  for (const n of nodes) {
    for (const c of n.children || []) {
      if (!c || !c.expandable) continue;
      const key = frontierMethodKey(c);
      if (key) keys.add(key);
    }
  }
  return keys;
}

// Implements progressive expandStep mechanics. The engine stays single-level:
// (adding one key to expandedKeys exposes only THAT node's own direct
// children; grandchildren beyond initialDepth stay frontier), so loading
// `settings.expandStep` levels is done here by looping: add the requested
// key(s), rebuild once, look at exactly those just-exposed nodes' direct
// children for any that are STILL frontier, add those too, and repeat
// (expandStep - 1) more times. The plural helper powers the map's
// "Expand visible" action without rebuilding once per branch; the singular
// wrapper preserves the tree-view/per-node behavior. Mutates `expandedKeys`
// in place and returns the final rebuilt TreeResult.
function expandFrontierKeys(index, target, dir, settings, expandedKeys, clickedKeys) {
  const step = Math.max(1, (settings && settings.expandStep) || 1);
  let keysToAdd = new Set(
    [...(clickedKeys || [])].filter((key) => typeof key === 'string' && key)
  );
  let tree = null;
  for (let i = 0; i < step && keysToAdd.size; i++) {
    for (const k of keysToAdd) expandedKeys.add(k);
    tree = buildTreeForTarget(index, target, dir, settings, expandedKeys);
    const justExpanded = new Map();
    collectNodesByKeys(tree.root, keysToAdd, justExpanded);
    keysToAdd = directFrontierChildKeys([...justExpanded.values()]);
  }
  return tree || buildTreeForTarget(index, target, dir, settings, expandedKeys);
}

function expandFrontierKey(index, target, dir, settings, expandedKeys, clickedKey) {
  return expandFrontierKeys(index, target, dir, settings, expandedKeys, [clickedKey]);
}

// Finds the raw TNode matching `key` anywhere under `root` (depth-first) --
// used to re-locate the SPECIFIC node a load-more click just expanded, so
// only ITS subtree needs re-shaping (via uitree.shapeNode), not the whole
// tree.
function findRawNodeByKey(root, key) {
  if (!root) return null;
  if (frontierMethodKey(root) === key) return root;
  for (const c of root.children || []) {
    const found = findRawNodeByKey(c, key);
    if (found) return found;
  }
  return null;
}

// Ships an incremental 'update' postMessage to
// an already-open Path Map panel instead of re-setting its whole .html
// (which would discard the user's current pan/zoom). The optional
// pathmap.buildPathMapData export is guarded via
// typeof, same idiom this file already uses for metascan.stripOwnNamespace
// (v0.8 N3) -- when unavailable, this safely falls back to the pre-v0.9 full
// HTML re-set so the feature degrades instead of breaking.
function postPathMapUpdate(panel, tree) {
  if (typeof buildPathMapData === 'function') {
    panel.webview.postMessage({ type: 'update', data: buildPathMapData(tree) });
  } else {
    panel.webview.html = renderPathMapHtml(tree);
  }
}

async function activate(context) {
  const provider = new TraceProvider();
  const view = vscode.window.createTreeView('apexTraceView', { treeDataProvider: provider });
  context.subscriptions.push(view);

  // The Entry-Point Catalog's own second Explorer view --
  // always visible (no `when` clause, same as apexTraceView), shows
  // a viewsWelcome (package.json) until apexTrace.showEntryCatalog is run
  // at least once this session.
  const entryCatalogProvider = new EntryCatalogProvider();
  const entryCatalogView = vscode.window.createTreeView('apexTraceEntriesView', { treeDataProvider: entryCatalogProvider });
  context.subscriptions.push(entryCatalogView);

  // F6/v0.15: delete source-bearing legacy caches and hydrate only clean Apex
  // facts before commands can run. Metadata source remains memory-only.
  // Best-effort: missing/corrupt/version-mismatched cache files degrade to a
  // cold scan and never block activation.
  try {
    const cleanup = await hydrateCaches(context);
    if (cleanup && cleanup.inspectionFailed) {
      vscode.window.showWarningMessage(
        'Apex Call Graph: could not inspect persisted cache storage; legacy cache cleanup may be incomplete. ' +
          'Use “Apex Call Graph: Clear Cache” to retry.'
      );
    } else if (cleanup && cleanup.failed > 0) {
      vscode.window.showWarningMessage(
        `Apex Call Graph: could not remove ${cleanup.failed} expired or legacy cache file(s). ` +
          'Use “Apex Call Graph: Clear Cache” to retry.'
      );
    }
  } catch (e) {
    // never let a cache-hydration failure prevent the extension from activating
  }

  // One OutputChannel is written once per completed scan, never per-file,
  // so this stays cheap even on a huge org. A shared single-flight/coalescing flow
  // for every trace-triggering command registered below (see scanflow.js's
  // own header for the exact join/queue/latest-wins contract).
  const scanStatsChannel = vscode.window.createOutputChannel('Apex Call Graph: Scan Stats');
  context.subscriptions.push(scanStatsChannel);
  const scanFlow = scanflow.createScanFlow();
  const excludeTracker = scanflow.createExcludeTracker();
  let pickerRequestNonce = 0;

  // Freeze the editor/position that initiated an interactive command before
  // it enters scanFlow's queue. Target resolution can happen seconds later,
  // after the user has moved to another editor; using the live selection at
  // that point would make both the key and the eventual target dishonest.
  function captureInteractiveTargetContext(kind) {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      return {
        position: null,
        key: scanflow.interactiveRequestKey(kind, null, ++pickerRequestNonce),
      };
    }
    const active = editor.selection.active;
    const position = new vscode.Position(active.line, active.character);
    const range = editor.document.getWordRangeAtPosition(position);
    const identity = {
      uri: editor.document.uri.toString(),
      version: editor.document.version,
      line: position.line,
      character: position.character,
    };
    return {
      position,
      fileName: sourcePathForUri(editor.document.uri) || editor.document.fileName,
      word: range ? editor.document.getText(range) : null,
      cursorLineText: editor.document.lineAt(position.line).text,
      documentText: editor.document.getText(),
      key: scanflow.interactiveRequestKey(kind, identity),
    };
  }

  // H8: the most recent completed scan's counts-only stats -- what
  // apexTrace.copyDiagnostics reports if invoked without a fresh trace
  // (e.g. right after activation, or after a run that ended up cancelled --
  // scanAndBuildIndex only ever overwrites this on an ACTUAL completed
  // scan, never on a cancelled one, so a cancel leaves the last good run's
  // numbers in place rather than blanking them).
  let lastRunStats = null;

  // H8: one line per completed scan -- files/parsed/reused/workers, ms per
  // phase, unresolved-by-reason, magnet-suppressed count. Deliberately
  // counts-only (mirrors buildDiagnosticsPayload's own hard privacy rule)
  // even though an OutputChannel is lower-stakes than the clipboard --
  // consistent behavior is simpler to reason about than "the channel can
  // say more than the clipboard can".
  function logRunStats(stats) {
    const f = stats.files;
    const w = stats.workers;
    const t = stats.timingMs;
    const reasonParts = Object.keys(stats.unresolvedByReason || {})
      .map((k) => `${k}=${stats.unresolvedByReason[k]}`)
      .join(', ');
    scanStatsChannel.appendLine(
      `[${new Date().toISOString()}] sweep=${stats.sweepKind} ` +
        `files(apex ${f.apexParsed}/${f.apexCached}/${f.apexTotal} parsed/cached/total, overlaid ${f.apexOverlaid || 0}, unreadable ${f.apexUnreadable}; ` +
        `meta ${f.metaRead}/${f.metaCached}/${f.metaTotal}, overlaid ${f.metaOverlaid || 0}) ` +
        `workers(used=${w.usedPool}, size=${w.poolSize}, chunks=${w.chunksTotal}, viaWorker=${w.chunksViaWorker}, inlineFallback=${w.chunksInlineFallback}, cancelled=${w.chunksCancelled || 0}, errors=${w.workerErrors}) ` +
        `ms(glob=${t.glob}, stat=${t.stat}, parse=${t.parse}, metascan=${t.metascan}, index=${t.index}, tree=${t.tree}) ` +
        `unresolvedByReason(${reasonParts || 'none'}) ` +
        `magnetSuppressed=${stats.magnetSuppressedAttachments} showUnconfirmed=${stats.showUnconfirmed}`
    );
  }

  // =========================================================================
  // FileSystemWatcher-fed dirty-set tracking.
  // =========================================================================
  // One watcher per glob (vscode.workspace.createFileSystemWatcher takes a
  // single GlobPattern), covering the same Apex + metadata globs
  // scanWorkspaceUris/scanMetaWorkspaceUris already scan, PLUS
  // sfdx-project.json (H6's own "sfdx-project.json changes also dirty the
  // package map" text) -- see the note below on why that last one needs no
  // further wiring beyond being watched at all. Every handler is wrapped
  // defensively: vscode's FileSystemWatcher API has no explicit
  // "overflow"/error event of its own to subscribe to, so the practical
  // reading of "watcher failure or overflow -> fall back to full sweep" is
  // (a) any exception setting up a watcher itself, and (b) any exception
  // inside a handler -- both latch dirtyTracker.markFullSweepNeeded(),
  // which makes the NEXT trace do a full, trust-nothing sweep rather than
  // silently trusting a dirty set this extension can no longer vouch for.
  try {
    const watchedGlobs = [
      '**/*.{cls,trigger,apex}',
      ...META_GLOBS,
      '**/sfdx-project.json',
    ];
    for (const glob of watchedGlobs) {
      const watcher = vscode.workspace.createFileSystemWatcher(glob);
      context.subscriptions.push(watcher);
      const safely = (fn) => {
        try {
          fn();
        } catch (e) {
          dirtyTracker.markFullSweepNeeded();
        }
      };
      watcher.onDidChange((uri) => safely(() => dirtyTracker.markChanged(resourceKeyForUri(uri))));
      watcher.onDidCreate((uri) => safely(() => dirtyTracker.markCreated(resourceKeyForUri(uri))));
      watcher.onDidDelete((uri) => safely(() => dirtyTracker.markDeleted(resourceKeyForUri(uri))));
    }
  } catch (e) {
    // Watcher setup itself failed (e.g. an exotic/virtual filesystem that
    // doesn't support file watching at all) -- never trust a dirty set this
    // extension has no way of keeping accurate; every future trace falls
    // back to a full sweep instead.
    dirtyTracker.markWatcherUnavailable();
  }

  // A save makes document.isDirty false immediately, while filesystem
  // watcher delivery may lag behind the next trace command. Mark the saved
  // source path synchronously so that trace cannot reuse pre-save disk facts
  // during that gap. DirtyTracker's generation guard preserves saves that
  // arrive while a scan is already in flight.
  context.subscriptions.push(
    vscode.workspace.onDidSaveTextDocument(
      editoroverlay.createDidSaveHandler(
        (resourceKey) => dirtyTracker.markChanged(resourceKey),
        (document) => !!vscode.workspace.getWorkspaceFolder(document.uri)
      )
    )
  );

  // A workspace-folder add/remove changes the universe searched by
  // findFiles without guaranteeing any per-file watcher event. Invalidate
  // the cached Apex/metadata path inventories so the next trace performs a
  // trust-nothing full sweep. The dirty tracker's generation guard also
  // preserves an event that arrives while another full sweep is in flight.
  context.subscriptions.push(
    vscode.workspace.onDidChangeWorkspaceFolders(
      scanflow.createWorkspaceFolderChangeHandler(() => dirtyTracker.markFullSweepNeeded())
    )
  );

  // H6a: tracks the last RESOLVED TARGET (not the last TreeResult) -- see
  // retraceLastTarget/scanAndBuildIndex below. Keeping only the target and
  // re-deriving the tree from a fresh scan+index every time refreshPathMap
  // needs it is what makes the map never go stale after an edit: the
  // mtime(+size, H6b) cache in scanAndParse/scanMetaFiles makes a re-scan of
  // an otherwise-unchanged workspace cheap (stat-only for every file except
  // the ones that actually changed), so re-deriving is not a meaningful
  // perf regression versus the old "reuse the stale cached TreeResult"
  // behavior it replaces.
  let lastTarget = null;
  // v0.7 / A3: the direction the LAST successful trace ran in --
  // 'callers' | 'callees'. Companion to lastTarget: the direction-toggle
  // button (apexTrace.toggleDirection) re-runs lastTarget in whichever
  // direction this ISN'T, so it must be updated in the same place
  // lastTarget is (see traceTarget below).
  let lastDirection = 'callers';
  // v0.7.1: caller-tree orientation ('target-first' | 'entry-first'),
  // hydrated from the last session's persisted choice. Anything other than
  // the literal 'entry-first' (including undefined on first ever run)
  // falls back to 'target-first', today's default.
  let orientation = context.workspaceState.get(ORIENTATION_KEY) === 'entry-first' ? 'entry-first' : 'target-first';
  // v0.7.1: the last rendered TreeResult + its scan counts + direction --
  // kept ONLY so apexTrace.toggleOrientation can re-render the CURRENT
  // result in the other orientation WITHOUT re-scanning (the toggle is a
  // pure view transform of an already-computed tree, so what is on screen
  // stays exactly as fresh -- or stale -- as it was the moment before the
  // toggle; nothing about the underlying result changes). Deliberately NOT
  // used by refreshPathMap: H6a's "always re-derive the map from a fresh
  // scan" decision stands unchanged.
  // Adds `index`/`target`/`traceId`; both the orientation-
  // toggle rebuild and the frontier-expand handlers (getChildren/the map's
  // 'expand' message, wired below) need to call resolver.js again against
  // the SAME already-built index/target without re-scanning.
  let lastRender = null; // { tree, scan, dir, index, target, traceId }
  let mapPanel = null; // singleton webview panel

  // Per-trace expansion state for progressive depth.
  // `expandedKeysByTrace` maps a monotonically increasing traceId to the
  // Set<methodKeyLower> of frontier nodes the user has clicked open for
  // THAT trace. Keyed by traceId (not just "the current Set") so a
  // getChildren/onDidReceiveMessage callback captured by an OLD TreeItem or
  // a queued webview message from a trace that has since been superseded
  // (a new trace, a direction toggle) can detect it is stale -- its
  // captured traceId no longer matches currentTraceId -- and no-op instead
  // of expanding against a dead index/target. Only the CURRENT trace's
  // entry is ever kept; a new one clears the map, since nothing reads a
  // non-current trace's expansion set.
  let currentTraceId = 0;
  const expandedKeysByTrace = new Map();

  // A brand-new trace (a fresh target resolution, a direction toggle via
  // retraceLastTarget) always starts with zero expanded frontier nodes.
  function newTraceState() {
    currentTraceId += 1;
    expandedKeysByTrace.clear();
    expandedKeysByTrace.set(currentTraceId, new Set());
    return currentTraceId;
  }

  // Orientation toggle keeps the same trace (same target/direction, no
  // rescan) but still resets expansion state
  // -- see apexTrace.toggleOrientation below for why (re-rooting a tree
  // that mixes fully-expanded-by-click branches with frontier stubs is
  // exactly the ambiguity this sidesteps). Clears the CURRENT trace's Set
  // in place rather than allocating a new traceId, since it is still,
  // conceptually, the same trace.
  function resetCurrentExpansion() {
    let s = expandedKeysByTrace.get(currentTraceId);
    if (!s) {
      s = new Set();
      expandedKeysByTrace.set(currentTraceId, s);
    } else {
      s.clear();
    }
    return s;
  }

  function currentExpandedKeys() {
    let s = expandedKeysByTrace.get(currentTraceId);
    if (!s) {
      s = new Set();
      expandedKeysByTrace.set(currentTraceId, s);
    }
    return s;
  }

  // Scans the workspace (Apex + metadata) and builds the semantic index --
  // the shared first half of both computeTrace (interactive target
  // resolution) and retraceLastTarget (H6a: re-run for a KNOWN target, no
  // QuickPick). Returns null (having already shown the appropriate warning)
  // when there is nothing to scan, or `{ cancelled: true }` (H4) when the
  // user cancelled the progress notification mid-scan -- callers must check
  // for BOTH falsy-null and `.cancelled` before treating the result as a
  // real `{ index, scan, settings, stats }`.
  //
  // The entire scan (Apex parse + metadata scan)
  // now runs under ONE cancellable withProgress call sharing ONE
  // CancellationToken, instead of two separate non-cancellable ones -- this
  // is also what makes H5's "cancel cancels the shared scan for all
  // joiners" true for free: every joiner of this same scanFlow key shares
  // this exact promise/progress/token triple. `dirtySnapshot` (H6) is taken
  // ONCE up front (non-destructively -- see dirtyTracker.peek()'s own
  // header) and fed to both scanAndParse/scanMetaFiles; on a successful
  // (non-cancelled) run, dirtyTracker.consume() clears exactly the paths
  // this run accounted for (never a path that arrived mid-scan -- see
  // consume()'s own header for why that's deliberate).
  async function scanAndBuildIndex() {
    // A cache reset is a barrier: scans requested while it is draining old
    // work wait here and therefore start from the deliberately empty maps.
    const operation = await cacheCoordinator.beginOperationAfterReset();
    try {
      return await scanAndBuildIndexForEpoch(operation.epoch);
    } finally {
      operation.end();
    }
  }

  async function scanAndBuildIndexForEpoch(scanCacheEpoch) {
    // Read the five apexCallGraph.* settings once at the top of
    // this scan+index call -- excludeGlobs feeds both scans below;
    // initialDepth/expandStep/maxDepth/maxNodes ride along on the returned
    // object so traceTarget builds its tree against the SAME snapshot the
    // scan itself used (a rare mid-scan settings edit can't produce a
    // mismatched exclude-vs-depth result within one trace operation).
    const settings = readSettings();
    // Snapshot every dirty file-backed editor once per scan. The resulting
    // raw text is passed only to ephemeral overlay helpers; fileCache and
    // metaFileCache remain disk-truth caches and persistence never sees it.
    const editorOverlays = editoroverlay.captureDirtyDocumentOverlays(vscode.workspace.textDocuments);
    // The last path inventory was built under a different exclusion policy.
    // A clean watcher set cannot describe which previously-included paths
    // must now disappear (or which previously-excluded paths must appear),
    // so the next successful scan must rebuild the inventory from findFiles.
    if (excludeTracker.requiresFullSweep(settings.excludeMatcher)) {
      dirtyTracker.markFullSweepNeeded();
    }
    const dirtySnapshot = dirtyTracker.peek();
    const phaseMs = { glob: 0, stat: 0, parse: 0, metascan: 0, index: 0, tree: 0 };
    let workerStats = null;
    let sweepKind = 'full';

    const result = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: 'Apex Call Graph: indexing workspace…', cancellable: true },
      async (progress, token) => {
        const scan = await scanAndParse(progress, settings.excludeMatcher, { token, dirtySnapshot, editorOverlays });
        phaseMs.glob += scan.timingMs ? scan.timingMs.glob : 0;
        phaseMs.stat += scan.timingMs ? scan.timingMs.stat : 0;
        phaseMs.parse += scan.timingMs ? scan.timingMs.parse : 0;
        workerStats = scan.workerStats || workerStats;
        sweepKind = scan.sweepKind || sweepKind;
        if (scan.cancelled || token.isCancellationRequested) {
          return { cancelled: true, scan };
        }
        if (!scan.factsList.length) {
          return { empty: true, scan };
        }

        // A7: non-Apex runtime references plus Permission Set/Profile class
        // access. Best-effort and additive -- a workspace with zero metadata
        // files (or one where the scan throws for some unexpected reason)
        // still traces Apex-to-Apex callers exactly as before; metascan.js's
        // own extractors already never throw per-file (see its header contract),
        // so the only realistic failure mode here is the vscode.workspace.fs
        // I/O layer itself, which this still guards defensively on every trace.
        let metaRefs = [];
        // Every '.flow-meta.xml' path this same metadata scan
        // saw, REGARDLESS of whether metascan.parseMetaFile() emitted any MetaRef
        // for it (a Screen/Autolaunched Flow with zero apex <actionCalls> emits
        // nothing at all today -- see resolver.js's buildEntryCatalog / its
        // collectFlowEntries header note) -- this is the index.flowFilePaths
        // mechanism ensures the Entry Point Catalog's flow group lists every
        // distinct flow file (not just the ones with an apex action), matching
        // distinct Flow file, including flows with no Apex action.
        // Best-effort same as metaRefs above: stays [] (today's byte-identical
        // absence) on any scan failure, never blocks the trace.
        let flowFilePaths = [];
        let metaScan = { files: [], read: 0, cached: 0, unreadable: 0, total: 0, cancelled: false, sweepKind: 'full' };
        try {
          const tMeta0 = Date.now();
          metaScan = await scanMetaFiles(progress, settings.excludeMatcher, { token, dirtySnapshot, editorOverlays });
          metaRefs = computeMetaRefs(metaScan.files);
          flowFilePaths = metaScan.files
            .filter((f) => f && typeof f.path === 'string' && /\.flow-meta\.xml$/i.test(f.path))
            .map((f) => f.path);
          phaseMs.metascan += Date.now() - tMeta0;
        } catch (e) {
          // metadata indexing is additive -- never block the Apex-only trace on it.
        }

        if (metaScan.cancelled || token.isCancellationRequested) {
          return { cancelled: true, scan };
        }

        progress.report({ message: 'building semantic index…' });

        // Keep package discovery + semantic indexing inside this SAME
        // cancellable progress scope. The interrupted implementation built
        // the index after withProgress had already returned, so its new
        // resolver shouldCancel guards were unreachable from the UI token.
        let packageOf = () => null;
        try {
          packageOf = await discoverPackageMap();
        } catch (e) {
          packageOf = () => null;
        }
        if (token.isCancellationRequested) return { cancelled: true, scan };

        const defaultPackage = typeof packageOf.defaultPackage !== 'undefined' && packageOf.defaultPackage != null
          ? packageOf.defaultPackage
          : null;
        const ownNamespace = typeof packageOf.ownNamespace !== 'undefined' && packageOf.ownNamespace != null
          ? packageOf.ownNamespace
          : null;
        const strippedMetaRefs =
          ownNamespace && typeof metascan.stripOwnNamespace === 'function'
            ? metascan.stripOwnNamespace(metaRefs, ownNamespace)
            : metaRefs;
        const tIndex0 = Date.now();
        const index = resolver.buildSemanticIndex(scan.factsList, {
          packageOf,
          defaultPackage,
          ownNamespace,
          shouldCancel: () => token.isCancellationRequested,
        });
        if (index.cancelled || token.isCancellationRequested) {
          phaseMs.index = Date.now() - tIndex0;
          return { cancelled: true, scan };
        }
        resolver.attachMetaCallers(index, strippedMetaRefs);
        index.flowFilePaths = flowFilePaths;
        phaseMs.index = Date.now() - tIndex0;

        return { scan, metaScan, index };
      }
    );

    // Clear Cache may have run while filesystem/parser work was awaiting.
    // Discard the old index and clear anything that scan repopulated; never
    // consume watcher state, schedule persistence, or render this result.
    if (!cacheCoordinator.isCurrent(scanCacheEpoch)) {
      resetMemoryCaches();
      return null;
    }

    if (result.cancelled) {
      // H4: "already-parsed facts stay cached, no partial index/tree is
      // rendered" -- return before ANY resolver.js call; the caller
      // (computeTrace/retraceLastTarget/etc.) shows the "cancelled" status
      // message and never renders anything for this run.
      return { cancelled: true };
    }
    if (result.empty) {
      vscode.window.showWarningMessage('Apex Call Graph: no .cls/.trigger/.apex files in this workspace.');
      return null;
    }

    const { scan, metaScan, index } = result;

    // H6: only a run that got all the way through without being cancelled
    // gets to consume the dirty snapshot it was handed -- a cancelled run
    // may have only partially accounted for those paths (see scanAndParse's
    // own "skipped entirely on a cancelled run" pruning note), so its
    // dirty/deleted paths must stay pending for the next attempt instead of
    // being wrongly marked "handled".
    dirtyTracker.consume(dirtySnapshot);
    if (sweepKind === 'full') dirtyTracker.markSweepDone(dirtySnapshot);
    excludeTracker.commit(settings.excludeMatcher);

    // F6: persist the just-updated fileCache/metaFileCache to disk
    // (debounced) regardless of what happens below -- the parse/read work
    // already happened and is worth saving even if the user cancels the
    // target QuickPick that follows.
    schedulePersistCaches(context);

    // Package discovery, namespace stripping, and semantic indexing were
    // completed inside the cancellable withProgress scope above.

    // Counts-only run stats are gathered fresh every scan and
    // fed to the 'Apex Call Graph: Scan Stats' output channel AND stashed as
    // `lastRunStats` (see its own declaration above) so apexTrace.
    // copyDiagnostics has something to report even before a NEW trace runs
    // again. `index.stats` is read defensively (typeof/duck-typed, same
    // idiom this file already uses for metascan.stripOwnNamespace/
    // pathmap.buildPathMapData) since resolver.js's own H1/H2/H3 stats
    // fields (unresolvedByReason, viaHistogram, magnetSuppressedAttachments)
    // are read defensively when present.
    const engineStats = index && typeof index.stats === 'object' && index.stats ? index.stats : {};
    const stats = {
      engineCacheVersion: ENGINE_CACHE_VERSION,
      extensionVersion: EXTENSION_VERSION,
      files: {
        apexTotal: scan.total,
        apexParsed: scan.parsed,
        apexCached: scan.cached,
        apexUnreadable: scan.unreadable,
        apexOverlaid: scan.overlaid || 0,
        metaTotal: (metaScan && metaScan.total) || 0,
        metaRead: (metaScan && metaScan.read) || 0,
        metaCached: (metaScan && metaScan.cached) || 0,
        metaUnreadable: (metaScan && metaScan.unreadable) || 0,
        metaOverlaid: (metaScan && metaScan.overlaid) || 0,
      },
      sweepKind,
      workers: workerStats || { usedPool: false, poolSize: 0, chunksTotal: 0, chunksViaWorker: 0, chunksInlineFallback: 0, chunksCancelled: 0, workerErrors: 0 },
      timingMs: phaseMs,
      unresolvedByReason: engineStats.unresolvedByReason || {},
      viaHistogram: engineStats.viaHistogram || {},
      magnetSuppressedAttachments: engineStats.magnetSuppressedAttachments || 0,
      showUnconfirmed: settings.showUnconfirmed,
      cancelled: false,
    };
    lastRunStats = stats;
    logRunStats(stats);

    return { index, scan, settings, stats, cacheEpoch: scanCacheEpoch };
  }

  // Builds the tree for a KNOWN target against an already-built index, and
  // applies every side effect a successful trace has always had (tree view
  // roots, view.description, setContext, the note toast, the duplicates
  // status-bar message, the live map-panel refresh) -- shared by
  // computeTrace (after interactive resolveTarget) and retraceLastTarget
  // (H6a, no interactive resolution).
  //
  // v0.7 / A3: `direction` ('callers' | 'callees', default 'callers') picks
  // which resolver.js tree-builder runs; everything else here (tree-view
  // wiring, header/note/duplicates messaging, map-panel refresh) is
  // identical either way -- both TreeResults share the same TNode shape.
  // v0.7.1: the pure RENDER step of a trace (tree roots + view description
  // + header banner), split out of traceTarget so apexTrace.toggleOrientation
  // can re-render the last result under the new orientation without
  // re-scanning or re-resolving anything. Reads the `orientation` state
  // above; uitree.js's effectiveOrientation() neutralizes 'entry-first' for
  // callees-direction trees, so this stays a safe no-op transform there.
  //
  // The active orientation is stated by the header (an explicit
  // 'Entry-first orientation: ...' line via shapeHeaderLines) and a
  // ' — entry-first' suffix on view.description; the default target-first
  // state deliberately renders BYTE-IDENTICALLY to pre-v0.7.1 (no suffix,
  // no header line) -- absence of the marker means the default, and the
  // toggle command's own toast announces every switch.
  // `traceId` (see newTraceState/currentTraceId above) is
  // threaded through to provider.setRoots so every TreeItem this render
  // produces is stamped with the trace it belongs to -- needed by the
  // staleness guard on LOAD_MORE_COMMAND's handler below.
  function renderTraceResult(tree, scan, dir, traceId) {
    provider.setRoots(shapeResult(tree, orientation), traceId);
    const directionLabel = dir === 'callees' ? 'callees of' : 'callers of';
    const orientationSuffix = effectiveOrientation(tree, orientation) === 'entry-first' ? ' — entry-first' : '';
    view.description = `${directionLabel} ${tree.targetLabel}${orientationSuffix} (parsed ${scan.parsed}, cached ${scan.cached})`;

    // H3/H1/H4: header lines (note today; capped/unresolvedSites once
    // resolver.js produces them) shown as a persistent banner above the
    // tree, in addition to (not instead of) the existing note toast below --
    // H8 already made the view always-visible/H4 calls for "an info row",
    // and view.message is the closest vscode TreeView API to that.
    const headerLines = shapeHeaderLines(tree, orientation);
    view.message = headerLines.length ? headerLines.join('  •  ') : undefined;
  }

  // `settings` comes from the SAME scanAndBuildIndex() call that
  // produced `index`/`scan` (see computeTrace/retraceLastTarget below) --
  // maxDepth/maxNodes/initialDepth now come from apexCallGraph.* settings
  // instead of the old hardcoded `{ maxDepth: MAX_DEPTH }`. A brand-new
  // trace always starts with a fresh, empty expansion Set (newTraceState());
  // apexTrace.toggleDirection reaches this via retraceLastTarget, so it
  // gets the same fresh-state treatment for free.
  // `stats` is optional; the same object scanAndBuildIndex
  // attached to `built.stats`) gets its `timingMs.tree` filled in here and
  // is re-logged to the Scan Stats channel/lastRunStats, since tree-building
  // is the one phase that happens AFTER scanAndBuildIndex already returned
  // (target resolution -- an interactive QuickPick -- sits in between).
  function traceTarget(index, scan, target, direction, settings, stats, expectedCacheEpoch) {
    // Target/overload QuickPicks may outlive a cache clear even though their
    // scan has already finished. Do not let that pre-clear index reappear in
    // the tree, diagnostics state, or Path Map afterwards.
    if (!cacheCoordinator.isCurrent(expectedCacheEpoch)) return null;
    const dir = direction === 'callees' ? 'callees' : 'callers';
    const traceId = newTraceState();
    const tTree0 = Date.now();
    const tree = buildTreeForTarget(index, target, dir, settings, currentExpandedKeys());
    if (stats) {
      stats.timingMs.tree += Date.now() - tTree0;
      lastRunStats = stats;
      logRunStats(stats);
    }
    if (!tree || !tree.root) {
      vscode.window.showWarningMessage('Apex Call Graph: could not resolve that target.');
      return null;
    }

    renderTraceResult(tree, scan, dir, traceId);
    vscode.commands.executeCommand('setContext', 'apexTrace.hasResults', true);
    vscode.commands.executeCommand('setContext', 'apexTrace.direction', dir);
    vscode.commands.executeCommand('setContext', 'apexTrace.mode', 'trace');

    if (tree.note) {
      vscode.window.showInformationMessage(`Apex Call Graph: ${tree.note}`);
    }

    if (index.duplicates && index.duplicates.length) {
      vscode.window.setStatusBarMessage(
        `Apex Call Graph: duplicate class names ignored: ${index.duplicates.slice(0, 3).join(', ')}${
          index.duplicates.length > 3 ? '…' : ''
        }`,
        8000
      );
    }

    lastTarget = target;
    lastDirection = dir;
    // v0.7.1: everything toggleOrientation needs to re-render without a
    // re-scan (the path map deliberately excluded -- see lastRender's decl).
    // `index`/`target`/`traceId` let the orientation-toggle
    // rebuild and the frontier-expand handlers (wired below) need them to
    // call resolver.js again without re-scanning.
    lastRender = { tree, scan, dir, index, target, traceId };
    // A brand-new trace is genuinely new content -- always a full HTML
    // re-set (never the incremental postMessage path, which is reserved
    // for an in-place frontier expand -- see postPathMapUpdate above).
    if (mapPanel) mapPanel.webview.html = renderPathMapHtml(tree);
    return tree;
  }

  // v0.7 / A3: `direction` defaults to 'callers' (unchanged pre-v0.7
  // behavior) when omitted -- the traceCallers/showPathMap call sites below
  // rely on that default.
  async function computeTrace(direction, targetContext) {
    const built = await scanAndBuildIndex();
    if (!built) return null;
    if (built.cancelled) {
      showScanCancelledMessage();
      return null;
    }
    const target = await resolveTarget(built.index, direction, targetContext);
    if (!target) return null;
    return traceTarget(built.index, built.scan, target, direction, built.settings, built.stats, built.cacheEpoch);
  }

  // H6a: re-runs scanAndParse + rebuilds the index/tree for the last
  // RESOLVED target (no QuickPick) -- called by refreshPathMap so the map is
  // never stale after an edit, instead of reusing whatever TreeResult
  // happened to be computed last.
  //
  // v0.7 / A3: `direction` defaults to lastDirection (i.e. "re-run the same
  // way it last ran") when omitted -- refreshPathMap wants that.
  // apexTrace.toggleDirection instead passes the OPPOSITE of lastDirection
  // explicitly.
  async function retraceLastTarget(direction) {
    if (!lastTarget) return null;
    const built = await scanAndBuildIndex();
    if (!built) return null;
    if (built.cancelled) {
      showScanCancelledMessage();
      return null;
    }
    return traceTarget(
      built.index,
      built.scan,
      lastTarget,
      direction || lastDirection,
      built.settings,
      built.stats,
      built.cacheEpoch
    );
  }

  // One shared toast handles every command that discovers its
  // scan was cancelled -- "already-parsed facts stay cached, no partial
  // index/tree is rendered" (nothing here mutates provider/view state; the
  // tree view is simply left exactly as it was before the cancelled run).
  function showScanCancelledMessage() {
    vscode.window.setStatusBarMessage('Apex Call Graph: scan cancelled.', 5000);
  }

  // The tree view's half of progressive depth:
  // registered once (after traceTarget/lastRender/currentExpandedKeys exist
  // as closures), invoked via LOAD_MORE_COMMAND's TreeItem.command on the
  // synthetic load-more child uitree.js's shapeLoadMoreChild appends to a
  // frontier node's shaped children (see toTreeItem's `uiNode.loadMore`
  // branch above for how `expandKey`/`traceId`/`parentItem` get captured).
  // A stale-trace click (traceId no longer current -- see currentTraceId's
  // header note above), or one with nothing to expand against (no
  // lastRender yet, or the freshly rebuilt tree no longer contains this
  // key), is a safe no-op -- the tree view simply stays as it was.
  context.subscriptions.push(
    vscode.commands.registerCommand(LOAD_MORE_COMMAND, (expandKey, traceId, parentItem) => {
      if (!expandKey || !parentItem || !lastRender || traceId !== currentTraceId) return;
      const settings = readSettings();
      const expandedKeys = currentExpandedKeys();
      const tree = expandFrontierKey(lastRender.index, lastRender.target, lastRender.dir, settings, expandedKeys, expandKey);
      if (!tree || !tree.root) return;
      lastRender.tree = tree;
      const rawNode = findRawNodeByKey(tree.root, expandKey);
      if (!rawNode) return;
      const targetPackage = tree.root.package || null;
      const freshUiNode = shapeNode(rawNode, targetPackage, orientation, tree.direction);
      // Refresh the CLICKED node's own TreeItem in place (same object
      // identity vscode already holds a reference to -- see
      // TraceProvider.refresh's own note) with its now-real children,
      // which replace the single load-more stub that was there before.
      parentItem.label = freshUiNode.label;
      parentItem.description = freshUiNode.description;
      parentItem.tooltip = freshUiNode.tooltip || undefined;
      parentItem.iconPath = freshUiNode.iconId ? new vscode.ThemeIcon(freshUiNode.iconId) : undefined;
      parentItem.collapsibleState = freshUiNode.collapsible
        ? vscode.TreeItemCollapsibleState.Collapsed
        : vscode.TreeItemCollapsibleState.None;
      parentItem._uiChildren = (freshUiNode.children || []).map((n) => toTreeItem(n, traceId, parentItem));
      provider.refresh(parentItem);
    })
  );

  function showPathMapPanel(tree) {
    if (!mapPanel) {
      mapPanel = vscode.window.createWebviewPanel(
        'apexTracePathMap',
        'Apex Call Graph: Path Map',
        vscode.ViewColumn.Beside,
        { enableScripts: true, retainContextWhenHidden: true }
      );
      mapPanel.onDidDispose(() => { mapPanel = null; });
      mapPanel.webview.onDidReceiveMessage((msg) => {
        if (msg && msg.type === 'open' && msg.path) {
          // pathmap.js is vscode-agnostic and sends 1-based lines
          const line = Math.max(0, (msg.line || 1) - 1);
          const col = Math.max(0, msg.col || 0);
          const resourceUri = resourceUriForSourcePath(msg.path);
          if (!resourceUri) return;
          // Never navigate over the Path Map itself. If the map occupies
          // column one (including the one-group-only layout), `Beside`
          // reuses or creates another group. Otherwise column one is a
          // stable, already-different destination. WebviewPanel.viewColumn
          // follows the panel when the user moves it between groups.
          const sourceViewColumn = mapPanel.viewColumn === vscode.ViewColumn.One
            ? vscode.ViewColumn.Beside
            : vscode.ViewColumn.One;
          vscode.window.showTextDocument(resourceUri, {
            selection: new vscode.Range(line, col, line, col),
            viewColumn: sourceViewColumn,
          });
          return;
        }
        // The map's own '+N' pill click posts
        // {type:'expand', key} (pathmap.js's client-side requestExpand,
        // key = its own frontierMethodKey mirror -- same derivation
        // uitree.js/this file use, see the require() header note above).
        // Drives the SAME per-trace expandedKeys Set the tree view's
        // LOAD_MORE_COMMAND handler uses (registered above) -- a node
        // expanded from either surface counts as expanded for both. The two
        // already-rendered surfaces update independently. A stale message
        // (mapPanel reused across a re-trace, msg.key referring to a node
        // from a trace that no longer exists) is handled the same
        // defensive way expandFrontierKey/findRawNodeByKey always do: "not
        // found in the current tree" just yields no update.
        if (msg && msg.type === 'expand' && msg.key && lastRender) {
          const settings = readSettings();
          const expandedKeys = currentExpandedKeys();
          const tree = expandFrontierKey(lastRender.index, lastRender.target, lastRender.dir, settings, expandedKeys, msg.key);
          if (tree && tree.root) {
            lastRender.tree = tree;
            postPathMapUpdate(mapPanel, tree);
          }
          return;
        }
        // The map-level "Expand visible" control posts every CURRENTLY
        // visible frontier key together. Expand them in one resolver rebuild
        // per configured step (not once per key), with a defensive bound and
        // shape check even though the offline webview is the only sender.
        if (msg && msg.type === 'expandMany' && Array.isArray(msg.keys) && lastRender) {
          const keys = [...new Set(
            msg.keys.filter((key) => typeof key === 'string' && key.length > 0 && key.length <= 512)
          )].slice(0, 2000);
          if (!keys.length) return;
          const settings = readSettings();
          const expandedKeys = currentExpandedKeys();
          const tree = expandFrontierKeys(lastRender.index, lastRender.target, lastRender.dir, settings, expandedKeys, keys);
          if (tree && tree.root) {
            lastRender.tree = tree;
            postPathMapUpdate(mapPanel, tree);
          }
        }
      });
    }
    mapPanel.webview.html = renderPathMapHtml(tree);
    mapPanel.reveal(vscode.ViewColumn.Beside, true);
  }

  context.subscriptions.push(
    vscode.commands.registerCommand('apexTrace.traceCallers', async () => {
      // Single-flighted; see scanFlow's header for the
      // join/queue/latest-wins contract. Freeze the initiating editor and
      // cursor so different targets never coalesce under a direction-only
      // key while indexing is still in flight.
      const targetContext = captureInteractiveTargetContext('callers');
      const tree = await scanFlow.request(targetContext.key, () => computeTrace('callers', targetContext));
      if (tree && tree.superseded) return;
      if (tree) await vscode.commands.executeCommand('apexTraceView.focus');
    }),
    // v0.7 / A3: "What Does This Call?" -- forward tracing. Shares target
    // resolution (resolveTarget/buildSuggestPicks) with the callers
    // direction per A4; only the resolver call + tree.direction differ,
    // both handled inside traceTarget/computeTrace above.
    //
    // This same command id is also wired as the entry-catalog
    // view's per-entry INLINE action (package.json's "view/item/context",
    // icon $(call-outgoing) -- the identical title/icon this command
    // already declares, so reusing the id rather than minting a new command
    // was the deliberate choice here, not an oversight). When VS Code
    // invokes a `view/item/context` menu command it passes the clicked
    // TreeItem as the first argument; every OTHER way this command can fire
    // (Command Palette, editor context menu, the main view's title-bar
    // button) never passes any argument at all, so `item` is undefined
    // there and this branch is a strict no-op for all pre-existing call
    // sites -- byte-identical behavior, purely additive.
    // `hasOwnProperty('_entryTarget')` (not just `item`) is the discriminator
    // rather than a truthy check, since `_entryTarget` is itself legitimately
    // null for a flow entry (toEntryCatalogTreeItem above stamps it on
    // every entry leaf, present-but-null included) -- see uitree.js's
    // entryCatalogTarget doc for why a flow entry never carries a real one.
    // A null target here represents "flows: run the
    // callee trace only when the flow has traceable children -- else no-op
    // toast" case (documented at uitree.js's shapeEntryCatalogEntry: today's
    // current catalog never gives a flow entry a target at all, so this is the
    // no-op branch for a Flow entry without a traceable Apex target).
    vscode.commands.registerCommand('apexTrace.traceCallees', async (item) => {
      if (item && Object.prototype.hasOwnProperty.call(item, '_entryTarget')) {
        if (!item._entryTarget) {
          vscode.window.showInformationMessage(
            `Apex Call Graph: "${item._entryLabel || 'this entry'}" has no further Apex callees to trace.`
          );
          return;
        }
        // Reuses the SAME scanAndBuildIndex()/traceTarget() machinery a
        // normal callee trace uses (caches reused, all the usual side
        // effects -- tree-view roots, header, note toast, map-panel
        // refresh) -- the only difference from computeTrace('callees') is
        // that the target is already known, so resolveTarget()'s
        // cursor/QuickPick step is skipped entirely.
        //
        // Single-flighted under a known-target key: a
        // second click on the SAME entry-catalog row while its scan is
        // still in flight coalesces (no second scan); a click on a
        // DIFFERENT entry queues (latest wins), same as every other
        // trace-triggering command below.
        const key = `known:${item._entryTarget.classLower}#${item._entryTarget.methodLower}:callees`;
        const result = await scanFlow.request(key, async () => {
          const built = await scanAndBuildIndex();
          if (!built) return null;
          if (built.cancelled) {
            showScanCancelledMessage();
            return null;
          }
          return traceTarget(
            built.index,
            built.scan,
            item._entryTarget,
            'callees',
            built.settings,
            built.stats,
            built.cacheEpoch
          );
        });
        if (result && result.superseded) return; // a newer request replaced this one -- nothing to render
        if (result) await vscode.commands.executeCommand('apexTraceView.focus');
        return;
      }
      const targetContext = captureInteractiveTargetContext('callees');
      const tree = await scanFlow.request(targetContext.key, () => computeTrace('callees', targetContext));
      if (tree && tree.superseded) return;
      if (tree) await vscode.commands.executeCommand('apexTraceView.focus');
    }),
    // v0.14.0: signature-change Impact Analysis.  It shares the exact same
    // cancellable scan/index snapshot as traces and the entry catalog, but
    // renders a dedicated sectioned tree; there is deliberately no Path Map
    // because this report is a set of risk surfaces rather than a call path.
    vscode.commands.registerCommand('apexTrace.impactAnalysis', async () => {
      const targetContext = captureInteractiveTargetContext('impact');
      const result = await scanFlow.request(targetContext.key, async () => {
        const built = await scanAndBuildIndex();
        if (!built) return null;
        if (built.cancelled) {
          showScanCancelledMessage();
          return null;
        }
        const target = await resolveTarget(built.index, 'impact', targetContext);
        if (!cacheCoordinator.isCurrent(built.cacheEpoch)) return null;
        if (!target) return null;
        if (!target.methodLower) {
          vscode.window.showWarningMessage('Apex Call Graph: Impact Analysis requires a method, not a whole class.');
          return null;
        }

        const tImpact0 = Date.now();
        const report = await resolveImpactReport(built.index, target, targetContext);
        if (!cacheCoordinator.isCurrent(built.cacheEpoch)) return null;
        built.stats.timingMs.tree += Date.now() - tImpact0;
        lastRunStats = built.stats;
        logRunStats(built.stats);
        if (!report || report.needsOverloadChoice) return null;

        const traceId = newTraceState();
        provider.setRoots(shapeImpactReport(report), traceId);
        view.description = `impact of ${report.target.label} (parsed ${built.scan.parsed}, cached ${built.scan.cached})`;
        view.message = shapeImpactHeaderLine(report) || undefined;
        vscode.commands.executeCommand('setContext', 'apexTrace.hasResults', true);
        vscode.commands.executeCommand('setContext', 'apexTrace.mode', 'impact');
        lastRender = null;
        return report;
      });
      if (result && result.superseded) return;
      if (result) await vscode.commands.executeCommand('apexTraceView.focus');
    }),
    // Builds the Entry-Point Catalog -- palette command
    // (category 'Apex Call Graph') AND the entry-catalog view's own
    // title-bar refresh button (package.json's "view/title", same '+
    // re-run to refresh' idiom apexTrace.refreshPathMap uses for
    // apexTraceView above) AND the viewsWelcome command link shown before
    // the view has ever been populated this session.
    vscode.commands.registerCommand('apexTrace.showEntryCatalog', async () => {
      // Single-flighted under a fixed 'catalog' key: a
      // repeat click while a catalog build is already in flight coalesces;
      // any OTHER trace request queues behind it (latest wins), same as
      // every other command here.
      const result = await scanFlow.request('catalog', async () => {
        const built = await scanAndBuildIndex();
        if (!built) return null;
        if (built.cancelled) {
          showScanCancelledMessage();
          return null;
        }
        // Keep a defensive capability guard so a mismatched resolver build
        // degrades to a clear warning instead of throwing a TypeError.
        if (typeof resolver.buildEntryCatalog !== 'function') {
          vscode.window.showWarningMessage(
            'Apex Call Graph: the entry-point catalog is not available in this build of resolver.js yet.'
          );
          return null;
        }
        let catalog;
        try {
          catalog = resolver.buildEntryCatalog(built.index);
        } catch (e) {
          vscode.window.showErrorMessage('Apex Call Graph: failed to build the entry-point catalog.');
          return null;
        }
        entryCatalogProvider.setRoots(shapeEntryCatalog(catalog));
        const headerLine = shapeEntryCatalogHeaderLine(catalog);
        entryCatalogView.message = headerLine || undefined;
        entryCatalogView.description = `parsed ${built.scan.parsed}, cached ${built.scan.cached}`;
        return true;
      });
      if (result && result.superseded) return;
      if (result) await vscode.commands.executeCommand('apexTraceEntriesView.focus');
    }),
    // v0.7 / A3: apexTraceView title-bar direction-toggle button -- re-runs
    // the LAST resolved target in the OPPOSITE direction, no QuickPick.
    // Mirrors retraceLastTarget's H6a "always re-derive from a fresh scan"
    // behavior, so the toggled view is never stale after an edit either.
    vscode.commands.registerCommand('apexTrace.toggleDirection', async () => {
      if (!lastTarget) {
        vscode.window.showWarningMessage(
          'Apex Call Graph: trace a class or method first, then use the direction-toggle button.'
        );
        return;
      }
      const nextDirection = lastDirection === 'callees' ? 'callers' : 'callees';
      // Single-flighted under the known target+direction key.
      const key = `known:${lastTarget.classLower}#${lastTarget.methodLower}:${nextDirection}`;
      const tree = await scanFlow.request(key, () => retraceLastTarget(nextDirection));
      if (tree && tree.superseded) return;
      if (tree) await vscode.commands.executeCommand('apexTraceView.focus');
    }),
    // v0.7.1: apexTraceView title-bar ORIENTATION toggle -- flips the
    // callers tree between 'target-first' (default: traced target at the
    // top, callers expanding beneath, stack-trace style) and 'entry-first'
    // (entry points at the top, execution order reading downward, target at
    // each branch tip -- same reading direction as the Path Map), persists
    // the choice, and re-renders the CURRENT result without re-scanning
    // (pure uitree.js re-rooting of the already-computed TreeResult).
    //
    // Deliberately a no-op in the callees direction (and the title-bar
    // button is hidden there via the package.json when-clause on
    // apexTrace.direction): a callees tree ALREADY reads execution-forward
    // -- its root is the traced target and expansion follows calls in the
    // order they happen -- so re-rooting it would just re-create the
    // backwards-reading problem this toggle exists to remove.
    vscode.commands.registerCommand('apexTrace.toggleOrientation', async () => {
      if (lastRender && lastRender.dir === 'callees') {
        vscode.window.showInformationMessage(
          'Apex Call Graph: orientation applies to the callers direction only — the callees tree already reads execution-forward.'
        );
        return;
      }
      orientation = orientation === 'entry-first' ? 'target-first' : 'entry-first';
      await context.workspaceState.update(ORIENTATION_KEY, orientation);
      if (lastRender) {
        // Still no re-scan (readSettings()/buildTreeForTarget
        // below are pure resolver.js calls against the already-built
        // lastRender.index -- no vscode.workspace.fs I/O). An orientation
        // toggle resets expansion state, so any
        // progressive-depth clicks made under the OLD orientation are
        // discarded first: re-rooting a tree that mixes fully-expanded-by-
        // click branches with frontier stubs is exactly the ambiguity this
        // sidesteps, so the new orientation always starts back at a clean
        // initialDepth. One extra (cheap) resolver call, nowhere near the
        // cost of an actual re-scan.
        const expandedKeys = resetCurrentExpansion();
        const settings = readSettings();
        const tree = buildTreeForTarget(lastRender.index, lastRender.target, lastRender.dir, settings, expandedKeys);
        // Defensive: the SAME index/target that already produced
        // lastRender.tree once cannot legitimately fail to resolve the
        // second time (nothing here touches the workspace or the index),
        // but never swap in a broken result over a known-good one if that
        // invariant is ever violated.
        if (tree && tree.root) {
          lastRender.tree = tree;
          renderTraceResult(tree, lastRender.scan, lastRender.dir, currentTraceId);
          if (mapPanel) mapPanel.webview.html = renderPathMapHtml(tree);
        }
      }
      vscode.window.showInformationMessage(
        orientation === 'entry-first'
          ? 'Apex Call Graph: entry-first orientation — entry points at the top, the traced target at each branch tip.'
          : 'Apex Call Graph: target-first orientation — the traced target at the top, its callers expanding beneath.'
      );
    }),
    vscode.commands.registerCommand('apexTrace.showPathMap', async () => {
      // This is the editor-context / Command Palette action: always resolve
      // the target under the cursor (or ask via QuickPick). Reusing
      // `lastTarget` here made a second invocation on another class silently
      // redraw the first class, which looked as if an open singleton panel
      // refused to be replaced. Preserve the current trace direction so a
      // caller/callee workflow can retarget without also changing modes.
      const direction = lastDirection;
      const targetContext = captureInteractiveTargetContext(`pathmap:${direction}`);
      const tree = await scanFlow.request(targetContext.key, () => computeTrace(direction, targetContext));
      if (tree && tree.superseded) return;
      if (tree) showPathMapPanel(tree);
    }),
    vscode.commands.registerCommand('apexTrace.refreshPathMap', async () => {
      // The Call Graph view-title action intentionally refreshes the last
      // resolved target from a new scan. Before any trace exists, retain the
      // old convenience behavior by resolving the active editor/QuickPick.
      let tree;
      if (lastTarget) {
        const key = `known:${lastTarget.classLower}#${lastTarget.methodLower}:${lastDirection}`;
        tree = await scanFlow.request(key, () => retraceLastTarget());
      } else {
        const targetContext = captureInteractiveTargetContext(`pathmap:${lastDirection}`);
        tree = await scanFlow.request(targetContext.key, () => computeTrace(lastDirection, targetContext));
      }
      if (tree && tree.superseded) return;
      if (tree) showPathMapPanel(tree);
    }),
    // Clipboard JSON contains only numbers/enums; see
    // scanflow.js's buildDiagnosticsPayload/assertCountsOnly for the full
    // contract. `assertCountsOnly` is run as a last-line-of-defense
    // assertion right before the clipboard write, never trusting
    // buildDiagnosticsPayload alone for a hard privacy rule -- if it somehow
    // throws (it shouldn't, given buildDiagnosticsPayload's own coercion),
    // NOTHING is copied and the user sees an error instead of a silent
    // partial/wrong copy.
    vscode.commands.registerCommand('apexTrace.copyDiagnostics', async () => {
      const payload = scanflow.buildDiagnosticsPayload(lastRunStats || {});
      try {
        scanflow.assertCountsOnly(payload);
      } catch (e) {
        vscode.window.showErrorMessage('Apex Call Graph: diagnostics payload failed its counts-only check -- nothing was copied.');
        return;
      }
      await vscode.env.clipboard.writeText(JSON.stringify(payload, null, 2));
      vscode.window.showInformationMessage(
        lastRunStats
          ? 'Apex Call Graph: copied diagnostics (counts only) to the clipboard.'
          : 'Apex Call Graph: copied diagnostics (counts only, no scan has run yet this session) to the clipboard.'
      );
    }),
    vscode.commands.registerCommand('apexTrace.clearCache', async () => {
      // Invalidate first (synchronously inside clearCaches), then remove every
      // closure/UI reference to the prior index while older scan/write work
      // drains behind the reset barrier.
      const clearing = clearCaches(context);
      lastTarget = null;
      lastDirection = 'callers';
      lastRender = null;
      lastRunStats = null;
      const traceId = newTraceState();
      provider.setRoots([], traceId);
      entryCatalogProvider.setRoots([]);
      view.description = undefined;
      view.message = undefined;
      entryCatalogView.description = undefined;
      entryCatalogView.message = undefined;
      if (mapPanel) {
        const panel = mapPanel;
        mapPanel = null;
        panel.dispose();
      }
      await Promise.all([
        vscode.commands.executeCommand('setContext', 'apexTrace.hasResults', false),
        vscode.commands.executeCommand('setContext', 'apexTrace.direction', 'callers'),
        vscode.commands.executeCommand('setContext', 'apexTrace.mode', 'trace'),
      ]);

      const cleanup = await clearing;
      if (cleanup && cleanup.inspectionFailed) {
        vscode.window.showWarningMessage(
          'Apex Call Graph: cleared memory, but could not inspect persisted cache storage. ' +
            'Disk cleanup could not be confirmed; run Clear Cache again to retry.'
        );
      } else if (cleanup && cleanup.failed > 0) {
        vscode.window.showWarningMessage(
          `Apex Call Graph: cleared memory, but could not remove ${cleanup.failed} persisted cache file(s). ` +
            'The next trace will still perform a full scan; run Clear Cache again to retry disk cleanup.'
        );
      } else {
        vscode.window.showInformationMessage(
          'Apex Call Graph: cleared in-memory and persisted caches. The next trace will perform a full scan.'
        );
      }
    })
  );
}

// F6: if a debounced cache write was still pending when VS Code starts
// shutting down this extension, flush it immediately instead of losing it --
// deactivate() may return a Thenable and the extension host waits (briefly)
// for it, so this is worth doing rather than letting PERSIST_DEBOUNCE_MS
// silently lose the most recent scan's cache update.
function deactivate() {
  if (!persistTimer) return undefined;
  clearTimeout(persistTimer);
  persistTimer = null;
  const context = pendingPersistContext;
  const epoch = pendingPersistEpoch;
  pendingPersistContext = null;
  pendingPersistEpoch = null;
  if (!context || epoch == null) return undefined;
  return cacheCoordinator.enqueuePersist(epoch, () => persistCachesNow(context)).catch(() => {});
}

module.exports = { activate, deactivate };

'use strict';
// Apex Call Graph — method-level semantic call-graph UI shell (v0.3.0).
//
// This file is written against the FROZEN CONTRACT ("=== CONTRACT:
// parser.js ===" / "=== CONTRACT: resolver.js ===" / "=== CONTRACT:
// extension.js ===") handed down for this rework. parser.js does not exist
// on disk yet (agent A's file) — this module requires it and calls it
// exactly per the contract's documented API; it will work the moment
// parser.js lands with that shape. resolver.js is required the same way.
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
// v0.7 / B1 additive contract: buildSemanticIndex's optional second `opts`
// argument may carry `opts.packageOf(fsPath) -> label|null`, built fresh
// every run from this workspace's sfdx-project.json file(s) -- see
// discoverPackageMap()'s header comment below. A workspace with no
// sfdx-project.json anywhere yields a packageOf that returns null for every
// path, which resolver.js's B2 contract treats as "nothing to say" --
// buildSemanticIndex's behavior in that case stays byte-identical to
// pre-v0.7.
//
// v0.8 / N3 additive contract (this round, plumbing ONLY -- see the
// CONTRACT AMENDMENTS' own N3 text): the SAME `opts` argument also carries
// `opts.ownNamespace: string|null`, this workspace's OWN managed-package
// namespace read from sfdx-project.json's top-level `namespace` property
// (discoverPackageMap() reads it in the same pass as packageOf, see that
// function's header comment below). What resolver.js DOES with a non-null
// ownNamespace (stripping it as a prefix before local class/object/metascan-
// ref lookup, so e.g. `vtx.VertexPricingService` in a workspace whose own
// namespace IS `vtx` resolves LOCAL rather than becoming an external node)
// is entirely out of scope for this file -- resolver.js is frozen this
// round, a different phase's job. Absent/empty `namespace` (the
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
// v1's apexindex.js lexical engine is NOT used here: per the frozen
// contract, parse-error fallback now lives inside resolver.js itself
// (files with FileFacts.parseError get lexical class-mention edges there,
// via apexindex.strip). This file never touches apexindex.js directly.
//
// v0.9 / P2 (progressive depth + settings) -- CONTRACT AMENDMENT, additive
// over everything above. This file owns:
//   - contributes.configuration read-through (readSettings() below) for the
//     5 new apexCallGraph.* settings (package.json, this round).
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
// depth-frontier node. Confirmed against the LANDED resolver.js:
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
// (v0.8 N3) above, so a pathmap.js build that hasn't landed this specific
// export yet degrades to a full HTML re-set instead of breaking (see
// postPathMapUpdate below).

const vscode = require('vscode');
const crypto = require('crypto');
const parser = require('./parser');
const resolver = require('./resolver');
const metascan = require('./metascan');
const cachestore = require('./cachestore');
const targets = require('./targets');
const {
  shapeResult,
  shapeHeaderLines,
  effectiveOrientation,
  // v0.9 / P1/P3: shapeNode shapes ONE raw TNode (recursively) into a
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
  // v0.12.0 / C2: Entry-Point Catalog shaping surface (uitree.js's own
  // section header above shapeEntryCatalog documents the full contract) --
  // used only by the entry-catalog view wiring below (EntryCatalogProvider/
  // toEntryCatalogTreeItem/apexTrace.showEntryCatalog), never by the
  // pre-existing caller/callee trace path above.
  shapeEntryCatalog,
  shapeEntryCatalogHeaderLine,
} = require('./uitree');
const { renderPathMapHtml, buildPathMapData } = require('./pathmap');

// v0.9 / P2: internal-only command id (never listed in package.json's
// contributes.commands -- it has no business appearing in the Command
// Palette) that a tree-view load-more TreeItem's `.command` points at, see
// toTreeItem's `uiNode.loadMore` branch below and this id's
// registerCommand call in activate().
const LOAD_MORE_COMMAND = 'apexTrace._loadMoreChildren';

const MAX_DEPTH = 8;

// v0.9 / P2: contributes.configuration section id (package.json, this
// round) and the same 4 numeric defaults resolver.js's own
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

// v0.9 / P2: reads the 5 apexCallGraph.* settings fresh via
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
  const excludeGlobs = Array.isArray(rawExcludes)
    ? rawExcludes.filter((g) => typeof g === 'string' && g.trim().length > 0)
    : [];
  return {
    initialDepth: clampInt(cfg.get('initialDepth'), 1, 8, DEFAULT_INITIAL_DEPTH),
    expandStep: clampInt(cfg.get('expandStep'), 1, 4, DEFAULT_EXPAND_STEP),
    maxDepth: clampInt(cfg.get('maxDepth'), 1, 20, MAX_DEPTH),
    maxNodes: clampInt(cfg.get('maxNodes'), 100, 20000, DEFAULT_MAX_NODES_SETTING),
    excludeGlobs,
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
// flowRecordTriggerType/cmdt/fieldName, so this goes 3 -> 4 for this round.
// v0.5.0 (parser.js, out of scope here) adds MethodFacts.throwsSites[]/
// catches[]/narrowings[] (G2/G3) and FileFacts.kind can now be 'anonymous'
// for .apex files (G4); metascan.js (this round) adds MetaRef.flowTriggerType
// (G1) -- a cached FileFacts/MetaRef from the v0.4 engine is missing all of
// these fields, so this goes 4 -> 5 for this round.
// v0.6.0 (H6b) adds a `size` tiebreak alongside `mtimeMs` to the in-memory
// fileCache/metaFileCache entry shape -- mtime alone has a known false-
// negative risk (two saves landing within the same filesystem mtime
// resolution tick can look "unchanged"), so this goes 5 -> 6 for this round.
// NOTE: cachestore.js's mapToEntries/entriesToMap (a different file's owner
// this round) do not yet round-trip a `size` field, so a cache entry
// hydrated from disk always comes back with size===undefined and therefore
// always fails this tiebreak once after a restart -- safe (forces exactly
// one reparse per file, never a false cache hit), but the full perf win
// needs a matching cachestore.js update.
// v0.11.0 (Round B) adds MethodFacts.locals[].literal (optional; single-
// assignment string-literal locals, B1) and TypeFacts.constants[] (static
// final String fields with a literal initializer, B1) -- a cached FileFacts
// from the v0.6 engine is missing both additive fields, so this goes 6 -> 7
// for this round. resolver.js's own B1/B2 changes (dynamic-dispatch literal
// candidates, narrowed generic-DML edges) consume these new parser fields
// but don't themselves change FileFacts/MetaRef shape, so they ride along
// on this same bump rather than needing one of their own.
const ENGINE_CACHE_VERSION = 7;

// Debounce window between the end of a scan and the on-disk cache write --
// avoids a redundant write-per-scan burst if the user retriggers a trace
// (e.g. Cmd+. spam) before the previous write finished being useful anyway.
const PERSIST_DEBOUNCE_MS = 1500;

// Module-level cache: fsPath -> { mtimeMs, facts }. Survives across command
// invocations in the same VS Code session so unchanged files are never
// re-parsed; the semantic index is still rebuilt from (possibly cached)
// facts on every run, since the workspace's file set and cross-file
// resolution can change between runs even when a given file didn't.
// F6: also persisted to disk (see persistCachesNow/hydrateCaches below) so a
// fresh VS Code session hydrates from context.globalStorageUri instead of
// starting cold — a scan of an unchanged big org then only has to stat files.
const fileCache = new Map();

// A7: mtime cache for metadata source files (LWC/Aura/Flow/OmniScript/VF),
// mirroring fileCache above. Unlike fileCache this stores the raw file TEXT
// (field name `metaText`, matching cachestore.js's CacheEntry contract),
// not the extracted MetaRef[] — Aura's cross-file bundling (a .cmp's
// controller="..." attribute plus its sibling Controller/Helper .js files'
// component.get('c.method') calls) means a single file's MetaRefs can
// depend on a SIBLING file's content, so per-file ref caching would need
// bundle-level invalidation bookkeeping. Re-running metascan's regex
// extractors over already-read text on every scan is cheap (see the A7 task
// brief's <300ms metascan perf bar) and keeps this correct-by-construction
// instead: mtime caching here only ever saves the vscode.workspace.fs.readFile
// I/O, not the (already fast) text scan.
const metaFileCache = new Map();

class TraceProvider {
  constructor() {
    this._emitter = new vscode.EventEmitter();
    this.onDidChangeTreeData = this._emitter.event;
    this._roots = []; // UiNode[]
    this._traceId = 0;
  }

  // `traceId` (v0.9 / P2) is stamped onto every TreeItem this render
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

  // v0.9 / P2: targeted refresh -- tells vscode ONE element's own rendering
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

// v0.12.0 / C2: the Entry-Point Catalog's own TreeDataProvider, backing the
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
// v0.9 / P2: `traceId` is threaded through purely so a load-more click can
// be checked against the CURRENT trace (see LOAD_MORE_COMMAND's handler
// below); it has no effect on rendering. `parent` (also new) is the
// enclosing TreeItem this call is building children FOR -- passed through
// only so a `uiNode.loadMore` child (see below) can capture it as the
// element its own click handler must mutate + refresh.
//
// Per the LANDED P1/P3 contract (uitree.js's shapeNode/shapeLoadMoreChild):
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
    uiNode.collapsible ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None
  );
  it.description = uiNode.description;
  if (uiNode.tooltip) it.tooltip = uiNode.tooltip;
  if (uiNode.iconId) it.iconPath = new vscode.ThemeIcon(uiNode.iconId);
  it._traceId = traceId || 0;
  const kids = (uiNode.children || []).map((n) => toTreeItem(n, traceId, it));
  it._uiChildren = kids;
  if (uiNode.loadMore) {
    // v0.9 / P2<->P1/P3: uitree.js's shapeLoadMoreChild's own header note
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

function openCommand(fsPath, line, col) {
  return {
    command: 'vscode.open',
    title: 'Open',
    arguments: [vscode.Uri.file(fsPath), { selection: new vscode.Range(line, col, line, col) }],
  };
}

// v0.12.0 / C2: uitree.js's shapeEntryCatalog UiNode -> vscode.TreeItem, the
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

// v0.9 / P2: appends `extraGlobs` (apexCallGraph.excludeGlobs) onto a
// builtin '{a,b,c}' brace-list exclude pattern. `extraGlobs` is expected to
// already be individual glob strings (readSettings() already filtered out
// non-string/blank entries) with no embedded commas of their own -- a glob
// containing a literal comma would need its own brace-expansion, which is
// rare enough for an exclude pattern that this naive split/join is not
// worth complicating for. Returns `builtinPattern` completely unchanged
// when there is nothing to append, so a workspace that never sets
// excludeGlobs (the overwhelmingly common case) scans byte-identically to
// pre-v0.9.
function combineExcludePattern(builtinPattern, extraGlobs) {
  if (!extraGlobs || !extraGlobs.length) return builtinPattern;
  const inner = builtinPattern.replace(/^\{/, '').replace(/\}$/, '');
  const parts = inner.split(',').concat(extraGlobs);
  return '{' + parts.join(',') + '}';
}

async function scanWorkspaceUris(excludeGlobs) {
  // .sfdx/.sf hold the StandardApexLibrary platform stubs — indexing those
  // would shadow real classes with same-named stubs.
  // v0.5 (G4): '**/*.apex' added alongside .cls/.trigger -- anonymous Apex
  // scripts (e.g. a corpus's scripts/adhoc-recalc.apex) route through
  // parser.parseFile the same way .cls/.trigger do; parser.js (out of scope
  // here) is what special-cases the .apex extension into anonymousUnit()
  // parsing. Same excludes as the pre-existing .cls/.trigger scan.
  // v0.9 / P2: `excludeGlobs` (apexCallGraph.excludeGlobs) is appended via
  // combineExcludePattern above -- see readSettings()'s header note.
  return vscode.workspace.findFiles(
    '**/*.{cls,trigger,apex}',
    combineExcludePattern('{**/node_modules/**,**/.sfdx/**,**/.sf/**,**/.git/**}', excludeGlobs)
  );
}

// Reparses only files whose mtime changed since the last run (or that are
// new), reuses cached FileFacts for everything else, and prunes cache
// entries for files no longer present. Returns the facts list plus counts
// for the progress notification.
async function scanAndParse(progress, excludeGlobs) {
  const uris = await scanWorkspaceUris(excludeGlobs);
  const seen = new Set();
  const factsList = [];
  let parsed = 0;
  let cached = 0;
  let unreadable = 0;

  for (const uri of uris) {
    const fsPath = uri.fsPath;
    seen.add(fsPath);
    let stat;
    try {
      stat = await vscode.workspace.fs.stat(uri);
    } catch (e) {
      unreadable++;
      continue; // unstattable — skip
    }
    const entry = fileCache.get(fsPath);
    // H6b: mtimeMs AND size must both match -- mtime resolution on some
    // filesystems is coarse enough that two distinct saves of the same file
    // can land within the same tick, and a same-mtime-different-content
    // false cache hit would silently trace against stale FileFacts. Size is
    // a cheap, free-riding tiebreak (already in the vscode.FileStat we just
    // fetched) that catches that case without a content hash.
    if (entry && entry.mtimeMs === stat.mtime && entry.size === stat.size) {
      factsList.push(entry.facts);
      cached++;
    } else {
      try {
        const bytes = await vscode.workspace.fs.readFile(uri);
        const text = Buffer.from(bytes).toString('utf8');
        const facts = parser.parseFile({ path: fsPath, text }); // contract: never throws
        fileCache.set(fsPath, { mtimeMs: stat.mtime, size: stat.size, facts });
        factsList.push(facts);
        parsed++;
      } catch (e) {
        unreadable++; // file itself unreadable (permissions, race on delete, …)
        continue;
      }
    }
    if (progress) {
      progress.report({ message: `parsed ${parsed}, cached ${cached} of ${uris.length} file(s)…` });
    }
  }

  // Drop cache entries for files that disappeared (renamed/deleted) so the
  // index never resurrects stale classes.
  for (const fsPath of [...fileCache.keys()]) {
    if (!seen.has(fsPath)) fileCache.delete(fsPath);
  }

  return { factsList, parsed, cached, unreadable, total: uris.length };
}

// A7: workspace globs derived from the adv-org corpus's SFDX layout
// (force-app/main/default/{lwc,aura,flows,omniscripts}/...), plus a VF
// pattern (per metascan.js's A5 spec — no adv-org fixtures exist for it,
// but real workspaces may have Visualforce pages/components under those
// conventional SFDX folder names). Same exclusions as scanWorkspaceUris,
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
];

// v0.9 / P2: `excludeGlobs` folded into META_GLOB_EXCLUDE via
// combineExcludePattern -- same apexCallGraph.excludeGlobs setting the Apex
// scan above uses, so one setting covers both scans.
async function scanMetaWorkspaceUris(excludeGlobs) {
  const excludePattern = combineExcludePattern(META_GLOB_EXCLUDE, excludeGlobs);
  const results = await Promise.all(META_GLOBS.map((g) => vscode.workspace.findFiles(g, excludePattern)));
  const seen = new Set();
  const uris = [];
  for (const arr of results) {
    for (const uri of arr) {
      if (seen.has(uri.fsPath)) continue;
      seen.add(uri.fsPath);
      uris.push(uri);
    }
  }
  return uris;
}

// Reads (mtime-cached, mirroring scanAndParse above) every metadata source
// file into { path, text } pairs -- extraction itself (metascan.js) happens
// separately in computeMetaRefs, since Aura needs cross-file bundle context
// that isn't available file-by-file.
async function scanMetaFiles(progress, excludeGlobs) {
  const uris = await scanMetaWorkspaceUris(excludeGlobs);
  const seen = new Set();
  const files = [];
  let read = 0;
  let cached = 0;
  let unreadable = 0;

  for (const uri of uris) {
    const fsPath = uri.fsPath;
    seen.add(fsPath);
    let stat;
    try {
      stat = await vscode.workspace.fs.stat(uri);
    } catch (e) {
      unreadable++;
      continue;
    }
    const entry = metaFileCache.get(fsPath);
    let text;
    // H6b: same mtimeMs+size tiebreak as scanAndParse's fileCache above.
    if (entry && entry.mtimeMs === stat.mtime && entry.size === stat.size) {
      text = entry.metaText;
      cached++;
    } else {
      try {
        const bytes = await vscode.workspace.fs.readFile(uri);
        text = Buffer.from(bytes).toString('utf8');
        metaFileCache.set(fsPath, { mtimeMs: stat.mtime, size: stat.size, metaText: text });
        read++;
      } catch (e) {
        unreadable++;
        continue;
      }
    }
    files.push({ path: fsPath, text });
    if (progress) {
      progress.report({ message: `metadata: read ${read}, cached ${cached} of ${uris.length} file(s)…` });
    }
  }

  for (const fsPath of [...metaFileCache.keys()]) {
    if (!seen.has(fsPath)) metaFileCache.delete(fsPath);
  }

  return { files, read, cached, unreadable, total: uris.length };
}

// =========================================================================
// F6: disk-persisted facts cache (cachestore.js does the pure
// serialize/deserialize; everything here is the vscode-side I/O plumbing:
// where the cache files live, when they get written, and hydrating the
// in-memory fileCache/metaFileCache from them at activation).
// =========================================================================

// Stable short id for "this workspace" so multiple different projects
// sharing the same context.globalStorageUri never collide on one cache
// file, and the SAME project's cache file is found again across sessions.
// Multi-root workspaces are folded into one id (sorted, joined folder
// paths) since fileCache/metaFileCache are themselves workspace-wide, not
// per-folder -- "one file per workspace-folder-path hash" per the task
// brief, using the full folder SET as the hashed key.
function workspaceCacheKey() {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || !folders.length) return null;
  const joined = folders
    .map((f) => f.uri.fsPath)
    .sort()
    .join('|');
  return crypto.createHash('sha1').update(joined).digest('hex').slice(0, 16);
}

// Resolves to null when there's no open workspace folder -- nothing stable
// to key a cache file off, and scanWorkspaceUris() would find nothing to
// scan anyway, so persistence is simply skipped for that session.
function cacheUris(context) {
  const key = workspaceCacheKey();
  if (!key) return null;
  return {
    facts: vscode.Uri.joinPath(context.globalStorageUri, `facts-${key}.json`),
    meta: vscode.Uri.joinPath(context.globalStorageUri, `meta-${key}.json`),
  };
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

// Called once from activate(), before the first scan -- hydrates
// fileCache/metaFileCache from the last session's persisted cache (if any)
// so a cold VS Code restart over an unchanged workspace still only has to
// stat files on its first trace, not re-read/re-parse everything.
async function hydrateCaches(context) {
  const uris = cacheUris(context);
  if (!uris) return;
  await hydrateOneCache(uris.facts, fileCache, 'facts');
  await hydrateOneCache(uris.meta, metaFileCache, 'metaText');
}

async function persistCachesNow(context) {
  const uris = cacheUris(context);
  if (!uris) return;
  await vscode.workspace.fs.createDirectory(context.globalStorageUri);
  const factsText = cachestore.serialize({
    engineVersion: ENGINE_CACHE_VERSION,
    entries: cachestore.mapToEntries(fileCache, 'facts'),
  });
  const metaText = cachestore.serialize({
    engineVersion: ENGINE_CACHE_VERSION,
    entries: cachestore.mapToEntries(metaFileCache, 'metaText'),
  });
  if (factsText) await vscode.workspace.fs.writeFile(uris.facts, Buffer.from(factsText, 'utf8'));
  if (metaText) await vscode.workspace.fs.writeFile(uris.meta, Buffer.from(metaText, 'utf8'));
}

let persistTimer = null;
let pendingPersistContext = null; // set alongside persistTimer, read by deactivate()'s flush below

// Debounced disk write, scheduled after every scan (see computeTrace below).
// A failed write is swallowed -- the in-memory caches are still correct for
// the rest of this session either way, only the on-disk copy stays stale
// until the next successful write, which must never surface as a user-facing
// error for what is purely a perf optimization.
function schedulePersistCaches(context) {
  if (persistTimer) clearTimeout(persistTimer);
  pendingPersistContext = context;
  persistTimer = setTimeout(() => {
    persistTimer = null;
    pendingPersistContext = null;
    persistCachesNow(context).catch(() => {});
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
// round's adv-org corpus declares `force-app` (no `package` field, label
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
// alongside the existing opts.packageOf/opts.defaultPackage -- what
// resolver.js (frozen this round, a different phase's job -- see N3's
// CONTRACT AMENDMENT text) does with it (stripping the own-namespace prefix
// before local class/object lookup, per N3) is entirely out of scope here.
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
  // MUST-FIX #6: label of the FIRST packageDirectories entry marked
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
    const projectRoot = uri.fsPath.replace(/[^\\/]*$/, '');

    for (const dir of dirs) {
      if (!dir || typeof dir.path !== 'string' || !dir.path.trim()) continue;
      const relPath = dir.path.replace(/^[\\/]+/, '').replace(/[\\/]+$/, '');
      if (!relPath) continue;
      const label =
        typeof dir.package === 'string' && dir.package.trim() ? dir.package.trim() : relPath.split(/[\\/]/).pop();
      prefixes.push({ prefix: normalizePathForPrefix(projectRoot + relPath), label });
      // MUST-FIX #6: first default:true entry wins (a malformed sfdx-project.json
      // with 2+ default:true entries -- see dev/hostile-v070-sfdx-edgecases.js
      // 7d -- must not throw; picking the first is a defensible, deterministic
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
  // MUST-FIX #6: attached to the returned function (not a second return
  // value / wrapper object) so every existing caller that treats
  // discoverPackageMap()'s result as a plain packageOf(fsPath) function --
  // incl. dev/hostile-v070-sfdx-edgecases.js's PART 1 harness -- keeps
  // working completely unchanged; scanAndBuildIndex (below) is the only
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
async function resolveCursorAmbiguity(index, enclosingCls, word, wordLower, enclosingLower, lineText, editor) {
  const receiverIdent = findReceiverCallOnLine(lineText, word);
  if (!receiverIdent) return undefined;

  const guessedType = editor ? guessReceiverType(editor.document.getText(), receiverIdent) : null;
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
// (or against a resolver.js that hasn't landed B2 yet), refineTargets()
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
// v0.7 / A4: shared verbatim between both trace directions -- `direction`
// only ever affects the QuickPick's placeholder wording below (the
// enclosing-method/known-class fast paths above it stay direction-agnostic,
// since "which class/method" is exactly the same question either way).
async function resolveTarget(index, direction) {
  const editor = vscode.window.activeTextEditor;
  let word = null;
  let cursorLineText = null;
  if (editor) {
    const range = editor.document.getWordRangeAtPosition(editor.selection.active);
    if (range) word = editor.document.getText(range);
    cursorLineText = editor.document.lineAt(editor.selection.active.line).text;
  }
  const wordLower = word ? word.toLowerCase() : null;

  let enclosingLower = null;
  if (editor && /\.(cls|trigger)$/i.test(editor.document.fileName)) {
    const base = editor.document.fileName.split(/[\\/]/).pop().replace(/\.(cls|trigger)$/i, '');
    if (index.classes.has(base.toLowerCase())) enclosingLower = base.toLowerCase();
  }

  if (wordLower && enclosingLower) {
    const cls = index.classes.get(enclosingLower);
    const hasMethod = (cls.methods || []).some((m) => (m.name || '').toLowerCase() === wordLower);
    if (hasMethod) {
      const ambiguous = await resolveCursorAmbiguity(index, cls, word, wordLower, enclosingLower, cursorLineText, editor);
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
  const placeHolder =
    direction === 'callees' ? 'Trace what calls out from which Apex method or class?' : 'Trace callers of which Apex method or class?';
  const chosen = await vscode.window.showQuickPick(picks, { placeHolder });
  if (!chosen) return null;
  const target = { classLower: chosen.target.classLower, methodLower: chosen.target.methodLower || null };
  if (Object.prototype.hasOwnProperty.call(chosen.target, 'package')) target.package = chosen.target.package;
  return target;
}

// =========================================================================
// v0.9 / P2: progressive-depth tree building. Every function in this
// section is a plain function of its arguments (no vscode, no closure over
// activate()'s session state) so it can be called identically from
// LOAD_MORE_COMMAND's tree-view handler and the Path Map webview's
// 'expand' message handler -- see their wiring inside activate() below.
// =========================================================================

// Shared resolver.js call shape used by a fresh trace (traceTarget),
// orientation-toggle's expansion-reset rebuild, and expandFrontierKey's
// stepped lazy-expansion rebuilds. `expandedKeys` is passed straight
// through as opts.expandedKeys per the P1 CONTRACT AMENDMENT; against a
// pre-P1 resolver.js (which does not read initialDepth/expandedKeys yet)
// these are simply inert extra opts properties -- the whole tree
// materializes eagerly up to maxDepth, exactly like pre-v0.9, until P1
// lands.
function buildTreeForTarget(index, target, dir, settings, expandedKeys) {
  const opts = {
    maxDepth: settings.maxDepth,
    maxNodes: settings.maxNodes,
    initialDepth: settings.initialDepth,
    expandedKeys,
  };
  return dir === 'callees' ? resolver.buildCalleeTree(index, target, opts) : resolver.buildCallerTree(index, target, opts);
}

// v0.9 / P1<->P2 sub-contract: resolver.js's TNode does NOT stamp an
// explicit `methodKey` identity field (confirmed against the landed
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
// iteration should add, per P1's "engine stays single-level" design (see
// expandFrontierKey's own header note below). Gated on `c.expandable`
// (unlike collectNodesByKeys above) since only a genuinely-still-frontier
// child is a meaningful next-round target.
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

// v0.9 / P1<->P2 CONTRACT: implements the expandStep mechanics P1's own
// text documents as the CALLER's job -- "the engine stays single-level"
// (adding one key to expandedKeys exposes only THAT node's own direct
// children; grandchildren beyond initialDepth stay frontier), so loading
// `settings.expandStep` levels on a single click is done here by looping:
// add the clicked key, rebuild, look at exactly the just-exposed node's
// direct children for any that are STILL frontier, add those too, and
// repeat (expandStep - 1) more times (stopping early once nothing new is
// exposed, e.g. a branch that bottoms out before reaching expandStep
// levels). Mutates `expandedKeys` in place (the CALLER's per-trace Set) and
// returns the final rebuilt TreeResult.
function expandFrontierKey(index, target, dir, settings, expandedKeys, clickedKey) {
  const step = Math.max(1, (settings && settings.expandStep) || 1);
  let keysToAdd = new Set([clickedKey]);
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

// v0.9 / P2<->P4 sub-contract: ships an incremental 'update' postMessage to
// an already-open Path Map panel instead of re-setting its whole .html
// (which would discard the user's current pan/zoom -- see P4's own CONTRACT
// AMENDMENT text). pathmap.buildPathMapData is P4's job to add; guarded via
// typeof, same idiom this file already uses for metascan.stripOwnNamespace
// (v0.8 N3) -- until it lands, this safely falls back to the pre-v0.9 full
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

  // v0.12.0 / C2: the Entry-Point Catalog's own second Explorer view --
  // always visible (no `when` clause, same as apexTraceView per H8), shows
  // a viewsWelcome (package.json) until apexTrace.showEntryCatalog is run
  // at least once this session.
  const entryCatalogProvider = new EntryCatalogProvider();
  const entryCatalogView = vscode.window.createTreeView('apexTraceEntriesView', { treeDataProvider: entryCatalogProvider });
  context.subscriptions.push(entryCatalogView);

  // F6: hydrate fileCache/metaFileCache from the previous session's
  // persisted cache before any command can run, so the very first trace in
  // a fresh VS Code window over an unchanged workspace only has to stat
  // files instead of re-reading/re-parsing everything. Best-effort: a
  // missing/corrupt/version-mismatched cache file degrades to "start cold",
  // never blocks activation on an error.
  try {
    await hydrateCaches(context);
  } catch (e) {
    // never let a cache-hydration failure prevent the extension from activating
  }

  // H6a: tracks the last RESOLVED TARGET (not the last TreeResult) -- see
  // retraceLastTarget/scanAndBuildIndex below. Keeping only the target and
  // re-deriving the tree from a fresh scan+index every time showPathMap
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
  // used by showPathMap: H6a's "always re-derive the map from a fresh
  // scan" decision stands unchanged.
  // v0.9 / P2: gains `index`/`target`/`traceId` -- both the orientation-
  // toggle rebuild and the frontier-expand handlers (getChildren/the map's
  // 'expand' message, wired below) need to call resolver.js again against
  // the SAME already-built index/target without re-scanning.
  let lastRender = null; // { tree, scan, dir, index, target, traceId }
  let mapPanel = null; // singleton webview panel

  // v0.9 / P2: per-trace expansion state -- see this file's header note on
  // the P1 CONTRACT AMENDMENT for the full progressive-depth design.
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
  // retraceLastTarget) always starts with ZERO expanded frontier nodes --
  // "state resets on re-trace/direction" per the CONTRACT AMENDMENT.
  function newTraceState() {
    currentTraceId += 1;
    expandedKeysByTrace.clear();
    expandedKeysByTrace.set(currentTraceId, new Set());
    return currentTraceId;
  }

  // Orientation toggle keeps the SAME trace (same target/direction, no
  // re-scan) but per the CONTRACT AMENDMENT still "resets expansion state"
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
  // when there is nothing to scan.
  async function scanAndBuildIndex() {
    // v0.9 / P2: read the 5 apexCallGraph.* settings ONCE at the top of
    // this scan+index call -- excludeGlobs feeds both scans below;
    // initialDepth/expandStep/maxDepth/maxNodes ride along on the returned
    // object so traceTarget builds its tree against the SAME snapshot the
    // scan itself used (a rare mid-scan settings edit can't produce a
    // mismatched exclude-vs-depth result within one trace operation).
    const settings = readSettings();
    const scan = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: 'Apex Call Graph: indexing workspace…' },
      (progress) => scanAndParse(progress, settings.excludeGlobs)
    );
    if (!scan.factsList.length) {
      vscode.window.showWarningMessage('Apex Call Graph: no .cls/.trigger/.apex files in this workspace.');
      return null;
    }

    // A7: LWC/Aura/Flow/OmniScript/VF metadata callers. Best-effort and
    // additive -- a workspace with zero metadata files (or one where the
    // scan throws for some unexpected reason) still traces Apex-to-Apex
    // callers exactly as before; metascan.js's own extractors already never
    // throw per-file (see its header contract), so the only realistic
    // failure mode here is the vscode.workspace.fs I/O layer itself, which
    // this still guards defensively since it runs on every trace.
    let metaRefs = [];
    // v0.12.0 / C1 seam: every '.flow-meta.xml' path this same metadata scan
    // saw, REGARDLESS of whether metascan.parseMetaFile() emitted any MetaRef
    // for it (a Screen/Autolaunched Flow with zero apex <actionCalls> emits
    // nothing at all today -- see resolver.js's buildEntryCatalog / its
    // collectFlowEntries header note) -- this is the index.flowFilePaths
    // "future extension.js round" that comment anticipates, landing this
    // round so the Entry Point Catalog's flow group actually lists every
    // distinct flow file (not just the ones with an apex action), matching
    // both corpora's GROUND-TRUTH/MANIFEST 'Entry catalog' sections (e.g.
    // adv-org's AcmeBackorderResolutionFlow/AcmeNotifyCustomerSubflow/
    // AcmeQuoteApprovalScreenFlow, none of which have an apex action).
    // Best-effort same as metaRefs above: stays [] (today's byte-identical
    // absence) on any scan failure, never blocks the trace.
    let flowFilePaths = [];
    try {
      const metaScan = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: 'Apex Call Graph: indexing metadata (LWC/Aura/Flow/OmniScript)…' },
        (progress) => scanMetaFiles(progress, settings.excludeGlobs)
      );
      metaRefs = computeMetaRefs(metaScan.files);
      flowFilePaths = metaScan.files
        .filter((f) => f && typeof f.path === 'string' && /\.flow-meta\.xml$/i.test(f.path))
        .map((f) => f.path);
    } catch (e) {
      // metadata indexing is additive -- never block the Apex-only trace on it.
    }

    // F6: persist the just-updated fileCache/metaFileCache to disk
    // (debounced) regardless of what happens below -- the parse/read work
    // already happened and is worth saving even if the user cancels the
    // target QuickPick that follows.
    schedulePersistCaches(context);

    // B1: re-discover sfdx-project.json package directories fresh on every
    // scan (see discoverPackageMap()'s header comment for why this is never
    // cached) and hand resolver.js a packageOf(fsPath) lookup it can use
    // for B2's same-package / default-package / ambiguous resolution order.
    // Best-effort: package discovery is purely additive, so any failure
    // here just falls back to a packageOf that returns null for everything
    // (identical to a workspace with no sfdx-project.json at all) rather
    // than blocking the trace.
    let packageOf = () => null;
    try {
      packageOf = await discoverPackageMap();
    } catch (e) {
      packageOf = () => null;
    }

    // MUST-FIX #6: wire B2's default-package fallback through -- previously
    // only `packageOf` was ever passed, so resolveDuplicateBucket()'s rule 2
    // (resolver.js) was permanently dead code and every default-package
    // resolution fell through to rule 3 ('ambiguous', approximate=true)
    // even when exactly one candidate should win unambiguously via='static'.
    const defaultPackage = typeof packageOf.defaultPackage !== 'undefined' && packageOf.defaultPackage != null
      ? packageOf.defaultPackage
      : null;
    // v0.8 (N3): same attach-and-extract convention as defaultPackage right
    // above -- discoverPackageMap() already folded the org's own namespace
    // (sfdx-project.json's `namespace` property) into this SAME packageOf()
    // call, so no second discovery pass is needed here. null (not the
    // typeof-undefined case a bare property access on a plain `() => null`
    // fallback function would produce) for every workspace with no
    // sfdx-project.json, no `namespace` property, or a discovery failure --
    // resolver.js's opts contract treats a null/absent opts.ownNamespace as
    // "nothing to strip", byte-identical to today (see N3's CONTRACT
    // AMENDMENT text: "Absent/empty namespace property -> no stripping").
    const ownNamespace = typeof packageOf.ownNamespace !== 'undefined' && packageOf.ownNamespace != null
      ? packageOf.ownNamespace
      : null;
    // v0.8 (N3): metascan.js's own namespace-aware kinds (flow/cmdt/
    // omniscript, alongside the pre-existing lwc/M1 case) tag a namespaced
    // MetaRef with `.namespace` but never know the WORKSPACE's own
    // namespace themselves (metascan.js stays index-free by design) -- per
    // metascan.js's own `stripOwnNamespace(refs, ownNamespace)` header
    // contract, THIS file is the one expected to call it, exactly once,
    // AFTER scanning and BEFORE handing refs to attachMetaCallers(), so a
    // ref naming this workspace's OWN namespace (e.g. an LWC import of
    // `vtx.VertexPricingService` in a workspace whose own namespace IS
    // `vtx`) reads `.namespace: null` by the time attachMetaCallers() sees
    // it and resolves through the ordinary local-class path instead of
    // being counted as an unattachable namespaced/managed-package ref --
    // exactly N3's "references prefixed with the OWN namespace resolve to
    // LOCAL classes/objects" for the metadata-ref surface. Guarded behind a
    // typeof check (not a bare call) since metascan.js is owned by a
    // different phase this round: if that function is absent/renamed,
    // metaRefs simply passes through unchanged (today's byte-identical
    // behavior) rather than throwing. A null/absent ownNamespace (the
    // overwhelmingly common case) already makes stripOwnNamespace() itself
    // a documented no-op, so this call is inert for every workspace that
    // doesn't declare its own namespace.
    const strippedMetaRefs =
      ownNamespace && typeof metascan.stripOwnNamespace === 'function'
        ? metascan.stripOwnNamespace(metaRefs, ownNamespace)
        : metaRefs;
    const index = resolver.buildSemanticIndex(scan.factsList, { packageOf, defaultPackage, ownNamespace });
    resolver.attachMetaCallers(index, strippedMetaRefs);
    // v0.12.0 / C1 seam: see flowFilePaths' own declaration above -- purely
    // additive extra field on the index, read only by
    // resolver.buildEntryCatalog's collectFlowEntries; every pre-existing
    // resolver.js code path (buildCallerTree/buildCalleeTree/suggestTargets)
    // never reads this property, so existing trace output is unaffected.
    index.flowFilePaths = flowFilePaths;
    return { index, scan, settings };
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
  // v0.9 / P2: `traceId` (see newTraceState/currentTraceId above) is
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

  // v0.9 / P2: `settings` comes from the SAME scanAndBuildIndex() call that
  // produced `index`/`scan` (see computeTrace/retraceLastTarget below) --
  // maxDepth/maxNodes/initialDepth now come from apexCallGraph.* settings
  // instead of the old hardcoded `{ maxDepth: MAX_DEPTH }`. A brand-new
  // trace always starts with a FRESH, empty expansion Set (newTraceState())
  // -- "state resets on re-trace/direction" per the CONTRACT AMENDMENT;
  // apexTrace.toggleDirection reaches this via retraceLastTarget, so it
  // gets the same fresh-state treatment for free.
  function traceTarget(index, scan, target, direction, settings) {
    const dir = direction === 'callees' ? 'callees' : 'callers';
    const traceId = newTraceState();
    const tree = buildTreeForTarget(index, target, dir, settings, currentExpandedKeys());
    if (!tree || !tree.root) {
      vscode.window.showWarningMessage('Apex Call Graph: could not resolve that target.');
      return null;
    }

    renderTraceResult(tree, scan, dir, traceId);
    vscode.commands.executeCommand('setContext', 'apexTrace.hasResults', true);
    vscode.commands.executeCommand('setContext', 'apexTrace.direction', dir);

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
    // v0.9 / P2: `index`/`target`/`traceId` added -- the orientation-toggle
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
  async function computeTrace(direction) {
    const built = await scanAndBuildIndex();
    if (!built) return null;
    const target = await resolveTarget(built.index, direction);
    if (!target) return null;
    return traceTarget(built.index, built.scan, target, direction, built.settings);
  }

  // H6a: re-runs scanAndParse + rebuilds the index/tree for the last
  // RESOLVED target (no QuickPick) -- called by showPathMap so the map is
  // never stale after an edit, instead of reusing whatever TreeResult
  // happened to be computed last.
  //
  // v0.7 / A3: `direction` defaults to lastDirection (i.e. "re-run the same
  // way it last ran") when omitted -- showPathMap's refresh wants that.
  // apexTrace.toggleDirection instead passes the OPPOSITE of lastDirection
  // explicitly.
  async function retraceLastTarget(direction) {
    if (!lastTarget) return null;
    const built = await scanAndBuildIndex();
    if (!built) return null;
    return traceTarget(built.index, built.scan, lastTarget, direction || lastDirection, built.settings);
  }

  // v0.9 / P2: the tree view's half of the progressive-depth contract --
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
          vscode.window.showTextDocument(vscode.Uri.file(msg.path), {
            selection: new vscode.Range(line, col, line, col),
            viewColumn: vscode.ViewColumn.One,
          });
          return;
        }
        // v0.9 / P2<->P4: the map's own '+N' pill click posts
        // {type:'expand', key} (pathmap.js's client-side requestExpand,
        // key = its own frontierMethodKey mirror -- same derivation
        // uitree.js/this file use, see the require() header note above).
        // Drives the SAME per-trace expandedKeys Set the tree view's
        // LOAD_MORE_COMMAND handler uses (registered above) -- a node
        // expanded from either surface counts as expanded for both, even
        // though this round does not live-push one surface's expansion
        // into the other's already-rendered view. A stale message
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
        }
      });
    }
    mapPanel.webview.html = renderPathMapHtml(tree);
    mapPanel.reveal(vscode.ViewColumn.Beside, true);
  }

  context.subscriptions.push(
    vscode.commands.registerCommand('apexTrace.traceCallers', async () => {
      const tree = await computeTrace('callers');
      if (tree) await vscode.commands.executeCommand('apexTraceView.focus');
    }),
    // v0.7 / A3: "What Does This Call?" -- forward tracing. Shares target
    // resolution (resolveTarget/buildSuggestPicks) with the callers
    // direction per A4; only the resolver call + tree.direction differ,
    // both handled inside traceTarget/computeTrace above.
    //
    // v0.12.0 / C2: this SAME command id is also wired as the entry-catalog
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
    // A null target here is EXACTLY the C2 contract's "flows: run the
    // callee trace only when the flow has traceable children -- else no-op
    // toast" case (documented at uitree.js's shapeEntryCatalogEntry: today's
    // C1 contract never gives a flow entry a target at all, so this is the
    // no-op branch for every flow entry as of this round).
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
        const built = await scanAndBuildIndex();
        if (!built) return;
        const tree = traceTarget(built.index, built.scan, item._entryTarget, 'callees', built.settings);
        if (tree) await vscode.commands.executeCommand('apexTraceView.focus');
        return;
      }
      const tree = await computeTrace('callees');
      if (tree) await vscode.commands.executeCommand('apexTraceView.focus');
    }),
    // v0.12.0 / C2: builds the Entry-Point Catalog -- palette command
    // (category 'Apex Call Graph') AND the entry-catalog view's own
    // title-bar refresh button (package.json's "view/title", same '+
    // re-run to refresh' idiom apexTrace.showPathMap already uses for
    // apexTraceView above) AND the viewsWelcome command link shown before
    // the view has ever been populated this session.
    vscode.commands.registerCommand('apexTrace.showEntryCatalog', async () => {
      const built = await scanAndBuildIndex();
      if (!built) return;
      // C1 (resolver.js's buildEntryCatalog) may still be in flight this
      // round -- same forward-compat `typeof` guard idiom this file already
      // uses for metascan.stripOwnNamespace (v0.8 N3) and
      // pathmap.buildPathMapData (v0.9 P2) above, so a resolver.js build
      // that hasn't landed C1 yet degrades to a clear warning instead of
      // throwing a TypeError.
      if (typeof resolver.buildEntryCatalog !== 'function') {
        vscode.window.showWarningMessage(
          'Apex Call Graph: the entry-point catalog is not available in this build of resolver.js yet.'
        );
        return;
      }
      let catalog;
      try {
        catalog = resolver.buildEntryCatalog(built.index);
      } catch (e) {
        vscode.window.showErrorMessage('Apex Call Graph: failed to build the entry-point catalog.');
        return;
      }
      entryCatalogProvider.setRoots(shapeEntryCatalog(catalog));
      const headerLine = shapeEntryCatalogHeaderLine(catalog);
      entryCatalogView.message = headerLine || undefined;
      entryCatalogView.description = `parsed ${built.scan.parsed}, cached ${built.scan.cached}`;
      await vscode.commands.executeCommand('apexTraceEntriesView.focus');
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
      const tree = await retraceLastTarget(nextDirection);
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
        // v0.9 / P2: still no re-scan (readSettings()/buildTreeForTarget
        // below are pure resolver.js calls against the already-built
        // lastRender.index -- no vscode.workspace.fs I/O). Per the CONTRACT
        // AMENDMENT ("orientation toggle reset[s] expansion state"), any
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
      // H6a: prefer re-tracing the last KNOWN target over reusing a
      // possibly-stale cached TreeResult -- see retraceLastTarget's comment.
      const tree = lastTarget ? await retraceLastTarget() : await computeTrace('callers');
      if (tree) showPathMapPanel(tree);
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
  pendingPersistContext = null;
  if (!context) return undefined;
  return persistCachesNow(context).catch(() => {});
}

module.exports = { activate, deactivate };

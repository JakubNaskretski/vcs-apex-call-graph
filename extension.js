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
//   resolver.buildSemanticIndex(factsList) -> Index
//   resolver.buildCallerTree(index, { classLower, methodLower }, opts) -> TreeResult
//   resolver.suggestTargets(index) -> [{ label, classLower, methodLower }]
//   resolver.attachMetaCallers(index, metaRefs) -> Index (A6, mutates + returns)
//   metascan.parseMetaFile({ path, text }) -> [MetaRef]   // never throws (A5)
//   metascan.scanBundle(files) -> [MetaRef]                // Aura cross-file (A5)
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

const vscode = require('vscode');
const crypto = require('crypto');
const parser = require('./parser');
const resolver = require('./resolver');
const metascan = require('./metascan');
const cachestore = require('./cachestore');
const targets = require('./targets');
const { shapeResult, shapeHeaderLines } = require('./uitree');
const { renderPathMapHtml } = require('./pathmap');

const MAX_DEPTH = 8;

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
const ENGINE_CACHE_VERSION = 6;

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
  }

  setRoots(uiNodes) {
    this._roots = uiNodes || [];
    this._emitter.fire();
  }

  getTreeItem(el) {
    return el;
  }

  getChildren(el) {
    if (!el) return this._roots.map(toTreeItem);
    return el._uiChildren || [];
  }
}

// UiNode.jump.line is still 1-based (uitree.js is pure and never touches
// vscode types — see its header comment); vscode.Position/Range are
// 0-based, so the conversion happens right here, at the boundary.
function toTreeItem(uiNode) {
  const it = new vscode.TreeItem(
    uiNode.label,
    uiNode.collapsible ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None
  );
  it.description = uiNode.description;
  if (uiNode.tooltip) it.tooltip = uiNode.tooltip;
  if (uiNode.iconId) it.iconPath = new vscode.ThemeIcon(uiNode.iconId);
  const kids = (uiNode.children || []).map(toTreeItem);
  it._uiChildren = kids;
  if (uiNode.jump) {
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

async function scanWorkspaceUris() {
  // .sfdx/.sf hold the StandardApexLibrary platform stubs — indexing those
  // would shadow real classes with same-named stubs.
  // v0.5 (G4): '**/*.apex' added alongside .cls/.trigger -- anonymous Apex
  // scripts (e.g. a corpus's scripts/adhoc-recalc.apex) route through
  // parser.parseFile the same way .cls/.trigger do; parser.js (out of scope
  // here) is what special-cases the .apex extension into anonymousUnit()
  // parsing. Same excludes as the pre-existing .cls/.trigger scan.
  return vscode.workspace.findFiles(
    '**/*.{cls,trigger,apex}',
    '{**/node_modules/**,**/.sfdx/**,**/.sf/**,**/.git/**}'
  );
}

// Reparses only files whose mtime changed since the last run (or that are
// new), reuses cached FileFacts for everything else, and prunes cache
// entries for files no longer present. Returns the facts list plus counts
// for the progress notification.
async function scanAndParse(progress) {
  const uris = await scanWorkspaceUris();
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

async function scanMetaWorkspaceUris() {
  const results = await Promise.all(META_GLOBS.map((g) => vscode.workspace.findFiles(g, META_GLOB_EXCLUDE)));
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
async function scanMetaFiles(progress) {
  const uris = await scanMetaWorkspaceUris();
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
function buildSuggestPicks(index) {
  const refined = targets.refineTargets(resolver.suggestTargets(index));
  return refined.map((t) => ({
    label: t.label,
    picked: false,
    target: { classLower: t.classLower, methodLower: t.methodLower },
  }));
}

// Cursor resolution per contract: word == method of enclosing file's class
// -> method target; word == known class -> class target; else QuickPick
// over resolver.suggestTargets(index). H5(c) adds a cursor-ambiguity guard
// (see resolveCursorAmbiguity above) ahead of the enclosing-class pick.
async function resolveTarget(index) {
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
  const chosen = await vscode.window.showQuickPick(picks, { placeHolder: 'Trace callers of which Apex method or class?' });
  if (!chosen) return null;
  return { classLower: chosen.target.classLower, methodLower: chosen.target.methodLower || null };
}

async function activate(context) {
  const provider = new TraceProvider();
  const view = vscode.window.createTreeView('apexTraceView', { treeDataProvider: provider });
  context.subscriptions.push(view);

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
  let mapPanel = null; // singleton webview panel

  // Scans the workspace (Apex + metadata) and builds the semantic index --
  // the shared first half of both computeTrace (interactive target
  // resolution) and retraceLastTarget (H6a: re-run for a KNOWN target, no
  // QuickPick). Returns null (having already shown the appropriate warning)
  // when there is nothing to scan.
  async function scanAndBuildIndex() {
    const scan = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: 'Apex Call Graph: indexing workspace…' },
      (progress) => scanAndParse(progress)
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
    try {
      const metaScan = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: 'Apex Call Graph: indexing metadata (LWC/Aura/Flow/OmniScript)…' },
        (progress) => scanMetaFiles(progress)
      );
      metaRefs = computeMetaRefs(metaScan.files);
    } catch (e) {
      // metadata indexing is additive -- never block the Apex-only trace on it.
    }

    // F6: persist the just-updated fileCache/metaFileCache to disk
    // (debounced) regardless of what happens below -- the parse/read work
    // already happened and is worth saving even if the user cancels the
    // target QuickPick that follows.
    schedulePersistCaches(context);

    const index = resolver.buildSemanticIndex(scan.factsList);
    resolver.attachMetaCallers(index, metaRefs);
    return { index, scan };
  }

  // Builds the tree for a KNOWN target against an already-built index, and
  // applies every side effect a successful trace has always had (tree view
  // roots, view.description, setContext, the note toast, the duplicates
  // status-bar message, the live map-panel refresh) -- shared by
  // computeTrace (after interactive resolveTarget) and retraceLastTarget
  // (H6a, no interactive resolution).
  function traceTarget(index, scan, target) {
    const tree = resolver.buildCallerTree(index, target, { maxDepth: MAX_DEPTH });
    if (!tree || !tree.root) {
      vscode.window.showWarningMessage('Apex Call Graph: could not resolve that target.');
      return null;
    }

    provider.setRoots(shapeResult(tree));
    view.description = `${tree.targetLabel} (parsed ${scan.parsed}, cached ${scan.cached})`;
    vscode.commands.executeCommand('setContext', 'apexTrace.hasResults', true);

    // H3/H1/H4: header lines (note today; capped/unresolvedSites once
    // resolver.js produces them) shown as a persistent banner above the
    // tree, in addition to (not instead of) the existing note toast below --
    // H8 already made the view always-visible/H4 calls for "an info row",
    // and view.message is the closest vscode TreeView API to that.
    const headerLines = shapeHeaderLines(tree);
    view.message = headerLines.length ? headerLines.join('  •  ') : undefined;

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
    if (mapPanel) mapPanel.webview.html = renderPathMapHtml(tree);
    return tree;
  }

  async function computeTrace() {
    const built = await scanAndBuildIndex();
    if (!built) return null;
    const target = await resolveTarget(built.index);
    if (!target) return null;
    return traceTarget(built.index, built.scan, target);
  }

  // H6a: re-runs scanAndParse + rebuilds the index/tree for the last
  // RESOLVED target (no QuickPick) -- called by showPathMap so the map is
  // never stale after an edit, instead of reusing whatever TreeResult
  // happened to be computed last.
  async function retraceLastTarget() {
    if (!lastTarget) return null;
    const built = await scanAndBuildIndex();
    if (!built) return null;
    return traceTarget(built.index, built.scan, lastTarget);
  }

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
        }
      });
    }
    mapPanel.webview.html = renderPathMapHtml(tree);
    mapPanel.reveal(vscode.ViewColumn.Beside, true);
  }

  context.subscriptions.push(
    vscode.commands.registerCommand('apexTrace.traceCallers', async () => {
      const tree = await computeTrace();
      if (tree) await vscode.commands.executeCommand('apexTraceView.focus');
    }),
    vscode.commands.registerCommand('apexTrace.showPathMap', async () => {
      // H6a: prefer re-tracing the last KNOWN target over reusing a
      // possibly-stale cached TreeResult -- see retraceLastTarget's comment.
      const tree = lastTarget ? await retraceLastTarget() : await computeTrace();
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

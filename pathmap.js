'use strict';
// pathmap.js — renders a resolver.js TreeResult (the frozen TNode/SiteView
// contract reproduced below, and mirrored in uitree.js's header comment) as
// a single, fully self-contained HTML document: an interactive,
// left-to-right "execution path map" — the traced TARGET sits on the right,
// its callers fan out to the left, one hop (column) per depth level, like a
// timeline of how a call reaches the target.
//
// Pure data-in/string-out, CommonJS, zero new dependencies, no vscode
// import — so it can be exercised head-less by dev/pathmap-preview.js and
// unit-tested by test-pathmap.js without a running extension host. The
// caller (extension.js, wired up later) is expected to hand the returned
// string straight to a vscode.WebviewPanel's `.webview.html` with
// `enableScripts: true`; see the integration note delivered alongside this
// file for the exact wiring.
//
// Frozen input contract (verbatim from resolver.js / uitree.js headers):
//
//   treeResult = { root: TNode, targetLabel, note }
//   TNode = {
//     label, kind: 'method'|'trigger'|'class'|'lwc'|'aura'|'flow'|
//       'omniscript'|'vf' (A6/A7: metadata-caller nodes from resolver.js's
//       attachMetaCallers/buildMetaChildren) | 'cmdt' (v0.4 F4b: Custom
//       Metadata record, same family, always terminal today) | 'anonymous'
//       (v0.5 G4: anonymous-Apex-script (.apex) pseudo-type/method node --
//       Apex-source family like 'method'/'trigger'/'class', NOT part of the
//       metadata-caller family; always a pure root),
//     className, methodLower,
//     path, line, entries: [string], isTest,
//     via: string|null,  // ...|'metadata'|'dml'|'dynamic'|'override' (v0.4
//                         // adds the last three)|'publish'|'throws'|
//                         // 'narrowed'|'async' (v0.5 G1/G2/G3/G5 add these
//                         // four; only 'narrowed' is approximate) --
//                         // rendered verbatim as edge labels/node badges, no
//                         // code change needed here for a new via string to
//                         // show up correctly)
//     sites: [SiteView], children: [TNode],
//     cyclic, truncated, approximate,
//     caughtHere,  // boolean, v0.5 G2: an ancestor catch clause catches the
//                  // exception being traced AT THIS NODE. Always paired with
//                  // a matching entries badge text ('catches <ExcName>',
//                  // resolver.js's doing) -- this file additionally renders
//                  // a shield-glyph badge for it (see badgeGlyphs in
//                  // CLIENT_JS_TEXT). Traversal continues past a caughtHere
//                  // node, so it is purely an informational marker.
//   }
//   SiteView = {
//     path, line, col, lineText, argsRendered: string|null, via,
//     overloadSig: string|null,  // A4 field, v0.6 (H3): previously
//                                 // serialized here but never surfaced in
//                                 // the tooltip's site rows -- confirmed
//                                 // bug, fixed alongside argsRendered below.
//   }
//
// `children` are CALLERS of the node (resolver.js's own phrasing). The tree
// therefore already reads target-outward: root = target, each level of
// children = one hop further from the target. Entry roots (the leftmost
// nodes in the rendered map) are simply the tree's leaves — nodes with no
// children — plus any node carrying non-empty `entries` (annotation/
// trigger/Batchable-style entry points can appear at any depth, not only at
// leaves, e.g. a Batchable class's `execute` method may itself still have
// callers above it in rare cases; this file does not need to special-case
// that, since it only draws the tree it's given — see LAYOUT below).
//
// v0.4 (F1b) NOTE: a 'flow' node is no longer guaranteed to be a leaf — a
// record-triggered flow's children are the DML sites on its object
// (resolver.js's doing). layoutTree() below has always walked `children`
// purely structurally (any node with a non-empty `children` array is an
// internal node, regardless of its `kind`), so a meta-kind node with
// children was already handled correctly by construction; nothing here ever
// special-cased "meta kinds are leaves". Documented explicitly since it's
// easy to assume otherwise from the A6/A7-era phrasing above.
//
// SECURITY — every scrap of text here (labels, lineText, argsRendered,
// paths, via, entries, note, targetLabel) comes straight from the traced
// workspace's own source code and must be treated as hostile input. The
// ONLY place user data is interpolated into the returned HTML string is a
// single JSON blob (see jsonForScript); everything the browser displays is
// built from that blob at render time via DOM `textContent`/attribute APIs
// (never innerHTML, never insertAdjacentHTML, never document.write), so no
// HTML-escaping pass can be forgotten or bypassed downstream. The blob
// itself additionally neutralizes `</script>`-breakout (JSON.stringify does
// not escape `<`/`>`) and legacy-illegal JS string line-terminator
// characters (U+2028/U+2029, which JSON allows but older JS string-literal
// grammar does not).

// ---------------------------------------------------------------------
// Layout constants (shared between the Node-side layout pass and the
// client-side renderer, which trusts the x/y this file precomputes).
// ---------------------------------------------------------------------
const LAYOUT = {
  colWidth: 260,
  rowHeight: 96,
  nodeWidth: 220,
  nodeHeight: 60,
  marginX: 48,
  marginY: 48,
};

// ---- entry-badge shortening --------------------------------------------
// uitree.js's badges keep the full annotation text verbatim (e.g.
// '@AuraEnabled (LWC/Aura)', 'trigger on Account (before insert, before
// update)'); the path map's badge pills are meant to stay small, so this
// trims the parenthetical qualifier and collapses any 'trigger on X (Y, Z)'
// entry down to the single word 'trigger'. 'Batchable'/'Queueable'/
// 'Schedulable' have no parenthetical, so they pass through unchanged.
function shortenEntry(raw) {
  const e = String(raw == null ? '' : raw);
  if (/^trigger on /i.test(e)) return 'trigger';
  const idx = e.indexOf(' (');
  return idx === -1 ? e : e.slice(0, idx);
}

// ---- color-accent bucket -------------------------------------------------
// Spec calls out four accent buckets: trigger/entry/test/normal. A node
// wears exactly one accent, so ties resolve trigger > entry > test > normal
// — a trigger or an explicit annotation entry point is a more specific,
// more load-bearing fact about a node than "this also happens to sit in a
// test class". isTest still gets its own visual treatment (dimmed + beaker
// badge, applied independently of accent — see buildNodeEl in the client
// script) even when a different accent wins.
//
// A7 adds a 5th bucket, 'metadata', for the LWC/Aura/Flow/OmniScript/VF
// caller nodes resolver.js's attachMetaCallers/buildMetaChildren produce
// (TNode.kind one of 'lwc'|'aura'|'flow'|'omniscript'|'vf'). v0.4 (F4b)
// folds 'cmdt' (Custom Metadata record) into the same bucket — it is the
// same "caller lives outside Apex source" family, just a different kind tag.
// These nodes always carry a non-empty `entries` (their kind-specific
// label, e.g. '@salesforce/apex import' / 'Custom Metadata record' — see
// resolver.js's metaEntryLabel) per the A6/F4b contract, so 'metadata' is
// checked ahead of 'entry' — otherwise every metadata node would
// collapse onto the same accent as an ordinary @AuraEnabled/@future/etc.
// entry-point node and lose its distinct color in the map.
const META_ACCENT_KINDS = new Set(['lwc', 'aura', 'flow', 'omniscript', 'vf', 'cmdt']);

// v0.5 (G4) adds a 6th bucket, 'anonymous', for TNode.kind==='anonymous' --
// an anonymous-Apex-script node. Deliberately NOT folded into 'metadata':
// unlike the A6/A7/F4b kinds above, an anonymous script IS real Apex source
// (parser.js's anonymousUnit(), not metascan.js), it just has no declared
// class/trigger of its own. Checked right alongside 'trigger' (both are
// "the kind itself decides the accent" cases), ahead of 'entry'/'test' for
// the same reason 'metadata' is: an anonymous-script node always carries the
// 'Anonymous Apex script' entries label per the G4 spec, so it would
// otherwise collapse onto the generic 'entry' accent and lose its distinct
// color.
function accentKind(node) {
  if (node.kind === 'trigger') return 'trigger';
  if (node.kind === 'anonymous') return 'anonymous';
  if (META_ACCENT_KINDS.has(node.kind)) return 'metadata';
  if (node.entries && node.entries.length) return 'entry';
  if (node.isTest) return 'test';
  return 'normal';
}

// ---- layout: simple leaf-order dendrogram ---------------------------------
// TNode.children is a genuine tree — resolver.js's ancestor-path cycle
// bookkeeping and maxDepth cap mean this is never a general DAG needing
// node merging — so a classic "leaves get consecutive rows, an internal
// node gets the average of its children's rows" pass is enough to
// guarantee zero overlap within a column: any two subtrees that are not
// ancestor/descendant of each other get disjoint, non-adjacent leaf-index
// ranges by construction (their leaves are numbered in one continuous DFS
// sweep), and a node's own row always lands inside its own subtree's
// range — so two unrelated nodes that land in the same column are always
// at least one full row apart. Depth (hops from the target) maps directly
// to column, counted from the right: the target (depth 0) is the
// rightmost column, and each hop further from it moves one column left.
function layoutTree(root) {
  const nodes = [];
  const edges = [];
  let nextId = 0;
  let leafCounter = 0;
  let maxDepth = 0;

  function visit(tnode, parentId, depth) {
    const id = nextId++;
    if (depth > maxDepth) maxDepth = depth;
    const rec = { id: id, parentId: parentId, depth: depth, tnode: tnode, row: 0 };
    nodes.push(rec);
    if (parentId != null) edges.push({ from: id, to: parentId, tnode: tnode });

    const kids = Array.isArray(tnode.children) ? tnode.children : [];
    if (kids.length === 0) {
      rec.row = leafCounter;
      leafCounter += 1;
    } else {
      let sum = 0;
      for (const kid of kids) sum += visit(kid, id, depth + 1);
      rec.row = sum / kids.length;
    }
    return rec.row;
  }

  visit(root, null, 0);

  for (const rec of nodes) {
    const col = maxDepth - rec.depth; // target (depth 0) -> rightmost column
    rec.x = LAYOUT.marginX + col * LAYOUT.colWidth;
    rec.y = LAYOUT.marginY + rec.row * LAYOUT.rowHeight;
  }

  const width = LAYOUT.marginX * 2 + (maxDepth + 1) * LAYOUT.colWidth;
  const height = LAYOUT.marginY * 2 + Math.max(1, leafCounter) * LAYOUT.rowHeight;
  return { nodes: nodes, edges: edges, width: width, height: height, maxDepth: maxDepth };
}

// ---- TNode/SiteView -> plain JSON-safe shapes -----------------------------
function shapeSiteForData(s) {
  return {
    path: (s && s.path) || null,
    line: s && typeof s.line === 'number' ? s.line : null,
    col: s && typeof s.col === 'number' ? s.col : 0,
    lineText: (s && s.lineText) || '',
    argsRendered: (s && s.argsRendered) || null,
    overloadSig: (s && s.overloadSig) || null,
    via: (s && s.via) || null,
  };
}

// v0.6 (H3): explicit 'root' badge -- see uitree.js's isRootNode, mirrored
// here rather than shared via require so pathmap.js stays a standalone,
// dev-tool-friendly module (see this file's header note). No known caller
// in THIS trace (childless), and not cyclic/truncated/seenElsewhere -- all
// three of those mean "there IS more above, just not shown/expanded here".
function isRootNode(t) {
  if (!t) return false;
  const hasChildren = !!(t.children && t.children.length);
  return !hasChildren && !t.cyclic && !t.truncated && !t.seenElsewhere;
}

function shapeNodeForData(rec) {
  const t = rec.tnode || {};
  return {
    id: rec.id,
    parentId: rec.parentId,
    x: rec.x,
    y: rec.y,
    label: t.label != null ? String(t.label) : '',
    kind: t.kind || 'class',
    accent: accentKind(t),
    badges: (t.entries || []).map(shortenEntry),
    isTest: !!t.isTest,
    approximate: !!t.approximate,
    cyclic: !!t.cyclic,
    truncated: !!t.truncated,
    caughtHere: !!t.caughtHere,
    // v0.6 (H1 forward-compat, H5 rendering): resolver.js does not produce
    // TNode.seenElsewhere yet -- see uitree.js's matching field doc.
    seenElsewhere: !!t.seenElsewhere,
    root: isRootNode(t),
    via: t.via || null,
    path: t.path || null,
    line: typeof t.line === 'number' ? t.line : null,
    className: t.className || '',
    sites: (t.sites || []).map(shapeSiteForData),
  };
}

function shapeEdgeForData(e) {
  const t = e.tnode || {};
  return {
    from: e.from,
    to: e.to,
    via: t.via || null,
    approximate: !!t.approximate,
  };
}

// ---- safe embedding of the data blob into an inline <script> -------------
// JSON.stringify does not escape '<'/'>', so a lineText/argsRendered/label
// containing "</script>" would otherwise terminate our <script> block early
// (the HTML tokenizer scans raw script-tag text for "</script" regardless
// of JS string-literal context) and let arbitrary attacker HTML/script
// follow it. Escaping every '<' and '>' to a \u-escape neutralizes that
// completely — </> are valid JS string-literal escapes, so the
// JSON still parses to the exact original text once the JS engine reads
// the string literal. U+2028/U+2029 get the same treatment: JSON permits
// them literally but pre-ES2019 JS string-literal grammar treats them as
// line terminators, which would be a syntax error inside `const DATA = ...;`
// in an older embedding browser.
function jsonForScript(value) {
  return JSON.stringify(value)
    .replace(/</g, '\\u003C')
    .replace(/>/g, '\\u003E')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

// ---------------------------------------------------------------------
// Static document pieces. Kept as their own template-literal constants
// (rather than one giant literal) so the embedded client-side script is
// free to build strings however is clearest without any risk of Node's own
// `${...}` interpolation firing inside what's meant to be literal client
// JS text. The client script deliberately never uses backtick template
// literals itself (plain string concatenation only) so this file never has
// to reason about nested backtick escaping.
// ---------------------------------------------------------------------

const CSS_TEXT = `
  * { box-sizing: border-box; }
  html, body {
    margin: 0; padding: 0; height: 100%; width: 100%; overflow: hidden;
    background: var(--pm-bg); color: var(--pm-fg);
    font-family: var(--vscode-font-family, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif);
    font-size: var(--vscode-font-size, 13px);
  }
  body { display: flex; flex-direction: column; }

  :root {
    --pm-bg: var(--vscode-editor-background, #ffffff);
    --pm-fg: var(--vscode-editor-foreground, #1e1e1e);
    --pm-border: var(--vscode-panel-border, #cccccc);
    --pm-node-bg: var(--vscode-editorWidget-background, #f3f3f3);
    --pm-muted: var(--vscode-descriptionForeground, #6e6e6e);
    --pm-link: var(--vscode-textLink-foreground, #3794ff);
    --pm-trigger: var(--vscode-charts-red, #f14c4c);
    --pm-entry: var(--vscode-charts-blue, #3794ff);
    --pm-test: var(--vscode-charts-green, #89d185);
    --pm-approx: var(--vscode-charts-orange, #d18616);
    --pm-normal: var(--vscode-descriptionForeground, #9d9d9d);
    --pm-metadata: var(--vscode-charts-purple, #b180d7);
    --pm-anonymous: var(--vscode-charts-yellow, #cca700);
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --pm-bg: var(--vscode-editor-background, #1e1e1e);
      --pm-fg: var(--vscode-editor-foreground, #d4d4d4);
      --pm-border: var(--vscode-panel-border, #454545);
      --pm-node-bg: var(--vscode-editorWidget-background, #252526);
      --pm-muted: var(--vscode-descriptionForeground, #9d9d9d);
    }
  }

  #pm-header {
    flex: 0 0 auto; display: flex; align-items: baseline; gap: 14px; flex-wrap: wrap;
    padding: 8px 14px; background: var(--pm-bg); border-bottom: 1px solid var(--pm-border);
  }
  #pm-title { font-weight: 600; font-size: 14px; }
  #pm-stats, #pm-hint { color: var(--pm-muted); font-size: 12px; }
  #pm-note { color: var(--pm-approx); font-size: 12px; }
  #pm-hint { margin-left: auto; }

  #pm-legend {
    position: fixed; top: 44px; right: 10px; z-index: 6; max-width: 340px; max-height: 70vh; overflow: auto;
    background: var(--pm-node-bg); border: 1px solid var(--pm-border); border-radius: 6px; padding: 2px 10px;
    box-shadow: 0 2px 8px rgba(0,0,0,.2);
  }
  #pm-legend summary { cursor: pointer; font-weight: 600; padding: 6px 0; list-style: none; }
  #pm-legend summary::-webkit-details-marker { display: none; }
  #pm-legend summary::before { content: '▸ '; }
  #pm-legend[open] summary::before { content: '▾ '; }
  #pm-legend h4 { margin: 8px 0 4px; font-size: 11px; text-transform: uppercase; color: var(--pm-muted); }
  #pm-legend .legend-row { display: flex; align-items: flex-start; gap: 6px; margin: 3px 0; font-size: 12px; line-height: 1.35; }
  #pm-legend .legend-row .k { flex: 0 0 auto; font-weight: 600; min-width: 78px; }
  .swatch { width: 10px; height: 10px; margin-top: 3px; border-radius: 3px; display: inline-block; flex: 0 0 auto; }
  .swatch.trigger { background: var(--pm-trigger); }
  .swatch.entry { background: var(--pm-entry); }
  .swatch.test { background: var(--pm-test); opacity: .6; }
  .swatch.normal { background: var(--pm-normal); }
  .swatch.metadata { background: var(--pm-metadata); }
  .swatch.anonymous { background: var(--pm-anonymous); }

  #pm-viewport { flex: 1 1 auto; position: relative; overflow: hidden; cursor: grab; }
  #pm-viewport.dragging { cursor: grabbing; }
  #pm-canvas { position: absolute; top: 0; left: 0; transform-origin: 0 0; }
  #pm-edges { position: absolute; top: 0; left: 0; overflow: visible; }
  #pm-nodes { position: absolute; top: 0; left: 0; }

  .node {
    position: absolute; border-radius: 8px; border: 1.5px solid var(--pm-border);
    background: var(--pm-node-bg); padding: 6px 10px 8px; overflow: hidden; cursor: pointer;
    box-shadow: 0 1px 2px rgba(0,0,0,.15);
  }
  .node:hover { border-color: var(--pm-link); }
  .node.kind-trigger { border-left: 4px solid var(--pm-trigger); }
  .node.kind-entry { border-left: 4px solid var(--pm-entry); }
  .node.kind-test { border-left: 4px solid var(--pm-test); }
  .node.kind-normal { border-left: 4px solid var(--pm-normal); }
  .node.kind-metadata { border-left: 4px solid var(--pm-metadata); }
  .node.kind-anonymous { border-left: 4px solid var(--pm-anonymous); }
  .node.is-test { opacity: .62; }
  .node.is-approx { border-style: dashed; border-color: var(--pm-approx); }

  .node-label {
    font-size: 12px; font-weight: 600; line-height: 1.25; overflow: hidden; text-overflow: ellipsis;
    display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical;
  }
  .node-badges { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 4px; }
  .badge {
    font-size: 10px; line-height: 1.5; padding: 0 5px; border-radius: 8px;
    background: var(--pm-bg); border: 1px solid var(--pm-border); color: var(--pm-muted); white-space: nowrap;
  }

  .edge-path { fill: none; stroke: var(--pm-border); stroke-width: 1.5; }
  .edge-path.is-approx { stroke-dasharray: 4 3; stroke: var(--pm-approx); }
  .edge-label { font-size: 10px; fill: var(--pm-muted); }

  .pm-tooltip {
    position: fixed; z-index: 20; max-width: 440px; max-height: 320px; overflow: auto;
    background: var(--pm-node-bg); border: 1px solid var(--pm-border); border-radius: 6px;
    padding: 8px 10px; box-shadow: 0 4px 14px rgba(0,0,0,.3); font-size: 12px;
  }
  .pm-tooltip[hidden] { display: none; }
  .pm-tooltip .tt-title { font-weight: 600; margin-bottom: 6px; }
  .pm-tooltip .tt-empty { color: var(--pm-muted); }
  .pm-tooltip .tt-site { padding: 4px 6px; border-radius: 4px; cursor: pointer; }
  .pm-tooltip .tt-site:hover { background: var(--pm-bg); }
  .pm-tooltip .tt-line {
    font-family: var(--vscode-editor-font-family, monospace); white-space: pre-wrap; word-break: break-all;
  }
  .pm-tooltip .tt-args { color: var(--pm-muted); margin-top: 2px; white-space: pre-wrap; word-break: break-all; }
  .pm-tooltip .tt-via { color: var(--pm-muted); font-size: 10px; margin-top: 2px; }
`;

// Client-side script. No backticks and no `${` sequences appear anywhere in
// this string on purpose (see the note above CSS_TEXT) — every dynamic bit
// of markup is built with document.createElement/textContent/setAttribute
// and plain string concatenation, never innerHTML/insertAdjacentHTML/
// document.write, so nothing here can turn traced-source-code text into
// executable HTML.
const CLIENT_JS_TEXT = `
(function () {
  'use strict';

  var vscodeApi = null;
  if (typeof acquireVsCodeApi === 'function') {
    // acquireVsCodeApi() may only be called once per webview session, so it
    // is cached here rather than re-invoked from postOpen.
    vscodeApi = acquireVsCodeApi();
  }

  function postOpen(path, line, col) {
    if (!path) return;
    var msg = { type: 'open', path: path, line: line == null ? 1 : line, col: col || 0 };
    if (vscodeApi) {
      vscodeApi.postMessage(msg);
    } else {
      console.log('[apex-trace pathmap] open', msg);
    }
  }

  function clearChildren(el) {
    while (el.firstChild) el.removeChild(el.firstChild);
  }

  var header = document.getElementById('pm-title');
  var stats = document.getElementById('pm-stats');
  var noteEl = document.getElementById('pm-note');
  header.textContent = DATA.meta.targetLabel || '(no target)';
  stats.textContent = DATA.meta.nodeCount + ' node' + (DATA.meta.nodeCount === 1 ? '' : 's') +
    ', ' + DATA.meta.edgeCount + ' edge' + (DATA.meta.edgeCount === 1 ? '' : 's');
  if (DATA.meta.note) {
    noteEl.textContent = DATA.meta.note;
  }
  // v0.6 (H1/H4 forward-compat, H4's own header wording): additional header
  // lines (capped / workspace-wide unresolved-sites count), precomputed
  // server-side (see headerExtraLinesForResult) so this is a straight
  // display concatenation, appended onto the note line rather than
  // replacing it.
  if (DATA.meta.headerExtra && DATA.meta.headerExtra.length) {
    var extra = DATA.meta.headerExtra.join('  \\u2022  ');
    noteEl.textContent = noteEl.textContent ? (noteEl.textContent + '  \\u2022  ' + extra) : extra;
  }

  var nodesLayer = document.getElementById('pm-nodes');
  var edgesSvg = document.getElementById('pm-edges');
  var canvas = document.getElementById('pm-canvas');
  var viewport = document.getElementById('pm-viewport');
  var tooltip = document.getElementById('pm-tooltip');

  var W = DATA.layout.width;
  var H = DATA.layout.height;
  var NW = DATA.layout.nodeWidth;
  var NH = DATA.layout.nodeHeight;

  canvas.style.width = W + 'px';
  canvas.style.height = H + 'px';
  edgesSvg.setAttribute('width', String(W));
  edgesSvg.setAttribute('height', String(H));

  var nodeById = {};
  DATA.nodes.forEach(function (n) { nodeById[n.id] = n; });

  var SVG_NS = 'http://www.w3.org/2000/svg';

  function badgeGlyphs(n) {
    var out = n.badges.slice();
    // v0.5 (G2): shield glyph for caughtHere -- IN ADDITION to the
    // 'catches <ExcName>' text already present in n.badges (from
    // TNode.entries, shortened by shortenEntry server-side). Pushed first,
    // right after the entries-derived badges, mirroring uitree.js's order.
    if (n.caughtHere) out.push('\\uD83D\\uDEE1'); // shield glyph (U+1F6E1)
    if (n.isTest) out.push('\\uD83E\\uDDEA'); // test-tube glyph
    // v0.6 (H3): 'root' glyph -- mirrors uitree.js's '◉ root' badge.
    if (n.root) out.push('\\u25C9'); // FISHEYE (U+25C9) -- root
    if (n.cyclic) out.push('\\u21BA'); // loop-arrow glyph
    if (n.truncated) out.push('\\u2026'); // ellipsis (depth cap reached)
    // v0.6 (H1 forward-compat, H5 rendering): seenElsewhere glyph.
    if (n.seenElsewhere) out.push('\\u21E2'); // dashed rightwards arrow (U+21E2)
    return out;
  }

  function buildNodeEl(n) {
    var el = document.createElement('div');
    el.className = 'node kind-' + n.accent + (n.isTest ? ' is-test' : '') + (n.approximate ? ' is-approx' : '');
    el.style.left = n.x + 'px';
    el.style.top = n.y + 'px';
    el.style.width = NW + 'px';
    el.style.minHeight = NH + 'px';
    el.setAttribute('data-id', String(n.id));

    var labelEl = document.createElement('div');
    labelEl.className = 'node-label';
    labelEl.textContent = (n.approximate ? '~' : '') + n.label;
    el.appendChild(labelEl);

    var glyphs = badgeGlyphs(n);
    if (glyphs.length) {
      var badgeRow = document.createElement('div');
      badgeRow.className = 'node-badges';
      glyphs.forEach(function (g) {
        var b = document.createElement('span');
        b.className = 'badge';
        b.textContent = g;
        badgeRow.appendChild(b);
      });
      el.appendChild(badgeRow);
    }

    el.addEventListener('mouseenter', function () { cancelHideTooltip(); showTooltip(n, el); });
    el.addEventListener('mouseleave', scheduleHideTooltip);
    el.addEventListener('click', function () {
      if (dragMoved) return; // a pan gesture that ended over a node must not open it
      postOpen(n.path, n.line, 0);
    });

    return el;
  }

  DATA.nodes.forEach(function (n) {
    nodesLayer.appendChild(buildNodeEl(n));
  });

  function edgePath(from, to) {
    var x1 = from.x + NW;
    var y1 = from.y + NH / 2;
    var x2 = to.x;
    var y2 = to.y + NH / 2;
    var midX = (x1 + x2) / 2;
    return 'M ' + x1 + ' ' + y1 + ' C ' + midX + ' ' + y1 + ', ' + midX + ' ' + y2 + ', ' + x2 + ' ' + y2;
  }

  DATA.edges.forEach(function (e) {
    var from = nodeById[e.from];
    var to = nodeById[e.to];
    if (!from || !to) return;

    var path = document.createElementNS(SVG_NS, 'path');
    path.setAttribute('d', edgePath(from, to));
    path.setAttribute('class', 'edge-path' + (e.approximate ? ' is-approx' : ''));
    edgesSvg.appendChild(path);

    if (e.via) {
      var text = document.createElementNS(SVG_NS, 'text');
      var midX = (from.x + NW + to.x) / 2;
      var midY = (from.y + to.y) / 2 + NH / 2 - 4;
      text.setAttribute('x', String(midX));
      text.setAttribute('y', String(midY));
      text.setAttribute('text-anchor', 'middle');
      text.setAttribute('class', 'edge-label');
      text.textContent = e.via;
      edgesSvg.appendChild(text);
    }
  });

  // ---- tooltip: call sites for the hovered node ---------------------------
  var hideTimer = null;
  function cancelHideTooltip() {
    if (hideTimer) { clearTimeout(hideTimer); hideTimer = null; }
  }
  function scheduleHideTooltip() {
    hideTimer = setTimeout(function () { tooltip.hidden = true; }, 150);
  }
  tooltip.addEventListener('mouseenter', cancelHideTooltip);
  tooltip.addEventListener('mouseleave', scheduleHideTooltip);

  // v0.6 (H3): combined '-> overloadSig · argsRendered' detail text, mirrors
  // uitree.js's siteDetailLine -- overloadSig used to be rendered NOWHERE
  // (confirmed bug) and argsRendered was tooltip-only; this IS the tooltip,
  // so the fix here is making overloadSig show up at all, plus prefixing
  // both with '-> ' to match the tree's inline rendering.
  function siteDetailText(site) {
    var parts = [];
    if (site.overloadSig) parts.push(site.overloadSig);
    if (site.argsRendered) parts.push(site.argsRendered);
    if (!parts.length) return null;
    return '-> ' + parts.join(' \\u00B7 ');
  }

  function siteRow(site, fallbackPath) {
    var row = document.createElement('div');
    row.className = 'tt-site';

    var lineEl = document.createElement('div');
    lineEl.className = 'tt-line';
    var lineNo = site.line == null ? '?' : String(site.line);
    lineEl.textContent = 'L' + lineNo + ': ' + site.lineText;
    row.appendChild(lineEl);

    var detailText = siteDetailText(site);
    if (detailText) {
      var argsEl = document.createElement('div');
      argsEl.className = 'tt-args';
      argsEl.textContent = detailText;
      row.appendChild(argsEl);
    }

    if (site.via) {
      var viaEl = document.createElement('div');
      viaEl.className = 'tt-via';
      viaEl.textContent = 'via ' + site.via;
      row.appendChild(viaEl);
    }

    row.addEventListener('click', function (ev) {
      ev.stopPropagation();
      postOpen(site.path || fallbackPath, site.line, site.col);
    });
    return row;
  }

  function showTooltip(n, el) {
    clearChildren(tooltip);

    var title = document.createElement('div');
    title.className = 'tt-title';
    title.textContent = (n.approximate ? '~' : '') + n.label;
    tooltip.appendChild(title);

    if (!n.sites.length) {
      var empty = document.createElement('div');
      empty.className = 'tt-empty';
      empty.textContent = n.path ? (n.path + (n.line ? ':' + n.line : '')) : 'no call sites recorded';
      tooltip.appendChild(empty);
    } else {
      n.sites.forEach(function (s) { tooltip.appendChild(siteRow(s, n.path)); });
    }

    tooltip.hidden = false;
    var rect = el.getBoundingClientRect();
    tooltip.style.top = Math.max(4, rect.top) + 'px';
    tooltip.style.left = (rect.right + 10) + 'px';

    // clamp after layout so the tooltip never runs off the right/bottom edge
    var tr = tooltip.getBoundingClientRect();
    if (tr.right > window.innerWidth - 4) {
      tooltip.style.left = Math.max(4, rect.left - tr.width - 10) + 'px';
    }
    var tr2 = tooltip.getBoundingClientRect();
    if (tr2.bottom > window.innerHeight - 4) {
      tooltip.style.top = Math.max(4, window.innerHeight - tr2.height - 4) + 'px';
    }
  }

  // ---- pan (drag background) + zoom (wheel, clamped) ----------------------
  var scale = 1;
  var panX = 24;
  var panY = 24;
  var MIN_SCALE = 0.2;
  var MAX_SCALE = 3;

  function applyTransform() {
    canvas.style.transform = 'translate(' + panX + 'px,' + panY + 'px) scale(' + scale + ')';
  }

  (function fitInitial() {
    // Fit a large map into the viewport on first paint instead of opening
    // zoomed to a single corner; never zooms IN past 1:1 for small maps.
    var vw = viewport.clientWidth || 800;
    var vh = viewport.clientHeight || 600;
    var fit = Math.min(1, vw / W, vh / H);
    scale = Math.max(MIN_SCALE, fit);
    panX = 24;
    panY = Math.max(24, (vh - H * scale) / 2);
    applyTransform();
  })();

  var dragging = false;
  var dragMoved = false;
  var dragStartX = 0;
  var dragStartY = 0;
  var panStartX = 0;
  var panStartY = 0;

  viewport.addEventListener('mousedown', function (e) {
    dragging = true;
    dragMoved = false;
    dragStartX = e.clientX;
    dragStartY = e.clientY;
    panStartX = panX;
    panStartY = panY;
    viewport.classList.add('dragging');
  });

  window.addEventListener('mousemove', function (e) {
    if (!dragging) return;
    var dx = e.clientX - dragStartX;
    var dy = e.clientY - dragStartY;
    if (Math.abs(dx) > 3 || Math.abs(dy) > 3) dragMoved = true;
    panX = panStartX + dx;
    panY = panStartY + dy;
    applyTransform();
  });

  window.addEventListener('mouseup', function () {
    dragging = false;
    viewport.classList.remove('dragging');
    // deferred so the click event that follows mouseup still sees dragMoved
    setTimeout(function () { dragMoved = false; }, 0);
  });

  viewport.addEventListener('wheel', function (e) {
    e.preventDefault();
    var rect = viewport.getBoundingClientRect();
    var mouseX = e.clientX - rect.left;
    var mouseY = e.clientY - rect.top;
    var contentX = (mouseX - panX) / scale;
    var contentY = (mouseY - panY) / scale;
    var factor = e.deltaY > 0 ? 0.9 : 1.1;
    scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale * factor));
    panX = mouseX - contentX * scale;
    panY = mouseY - contentY * scale;
    applyTransform();
  }, { passive: false });
})();
`;

const LEGEND_HTML = `
    <summary>Legend</summary>
    <h4>Node color (left accent bar)</h4>
    <div class="legend-row"><span class="swatch trigger"></span><span><span class="k">trigger</span>trigger-file entry point</span></div>
    <div class="legend-row"><span class="swatch entry"></span><span><span class="k">entry</span>has an entry-point annotation (@AuraEnabled, @InvocableMethod, @future, @HttpX, webservice, Batchable, Queueable, Schedulable)</span></div>
    <div class="legend-row"><span class="swatch test"></span><span><span class="k">test</span>only reachable from test code</span></div>
    <div class="legend-row"><span class="swatch normal"></span><span><span class="k">normal</span>regular method or class</span></div>
    <div class="legend-row"><span class="swatch metadata"></span><span><span class="k">metadata</span>caller from LWC, Aura, Flow, OmniScript, VF, or Custom Metadata — not Apex source (a Flow node here may still have its own children, e.g. the DML sites on its object — a metadata node is not always a leaf)</span></div>
    <div class="legend-row"><span class="swatch anonymous"></span><span><span class="k">anonymous</span>anonymous Apex script (.apex) — real Apex source, but with no declared class/trigger of its own; always a pure root (nothing calls it)</span></div>
    <h4>Markers</h4>
    <div class="legend-row"><span class="k">~ prefix</span>approximate resolution (dashed border too) — via interface/unique-name/lexical/override/narrowed/dynamic fallback, so this edge may be wrong or one of several candidates</div>
    <div class="legend-row"><span class="k">&#x1F9EA;</span>test-only node (also dimmed)</div>
    <div class="legend-row"><span class="k">&#x21BA;</span>cyclic — this call chain recurses back on itself here</div>
    <div class="legend-row"><span class="k">&#x2026;</span>truncated — trace depth cap reached, more callers may exist above this node</div>
    <div class="legend-row"><span class="k">&#x1F6E1;</span>caughtHere — an ancestor catch clause here catches the exception being traced (exact type, a USER exception ancestor, or bare Exception); paired with a "catches &lt;Exc&gt;" badge. Traversal still continues past this node — rethrow is unknowable</div>
    <div class="legend-row"><span class="k">&#x25C9;</span>root — no known caller in this trace: an entry point or unused/dead code. Never shown together with cyclic, truncated, or seenElsewhere (those all mean "there IS more above, it just isn't shown/expanded here")</div>
    <div class="legend-row"><span class="k">&#x21E2;</span>seenElsewhere — this method's caller subtree was already expanded once elsewhere in this same trace (per-run dedup); its own call sites are still shown here, only the deeper callers above it are collapsed</div>
    <h4>Edge "via" labels</h4>
    <div class="legend-row"><span class="k">typed</span>resolved through the receiver's declared type</div>
    <div class="legend-row"><span class="k">static</span>Class.method() static call</div>
    <div class="legend-row"><span class="k">new</span>constructor call</div>
    <div class="legend-row"><span class="k">this</span>this.method() same-class call</div>
    <div class="legend-row"><span class="k">super</span>super.method() parent-class call</div>
    <div class="legend-row"><span class="k">interface</span>dispatched through an interface type (approximate — every implementer is included, including through an interface-extends-interface chain)</div>
    <div class="legend-row"><span class="k">unique-name</span>no receiver type available; matched by a codebase-unique method name (approximate)</div>
    <div class="legend-row"><span class="k">lexical</span>parse-error fallback, matched by text mention only (approximate)</div>
    <div class="legend-row"><span class="k">metadata</span>caller is LWC, Aura, Flow, OmniScript, VF, or Custom Metadata, not Apex source (see the metadata accent above)</div>
    <div class="legend-row"><span class="k">dml</span>a DML statement (or Database.xxx() method call) whose target object has a trigger, or that matches a record-triggered flow's operation — not a direct method call</div>
    <div class="legend-row"><span class="k">dynamic</span>Type.forName('LiteralClassName') or a Custom Metadata field value naming a class (approximate — resolved by name only, not by real dispatch)</div>
    <div class="legend-row"><span class="k">override</span>fan-out edge to a subclass's override of a virtual/abstract method reached via a base-type receiver (approximate — the runtime type may differ)</div>
    <div class="legend-row"><span class="k">publish</span>EventBus.publish(...) of a platform-event (__e) record — resolves to every trigger registered on that event, and to the publish sites shown as children of a platform-event-triggered flow (not approximate)</div>
    <div class="legend-row"><span class="k">throws</span>a throw statement (creator-type "throw new X(...)" or a resolved "throw e" rethrow) — shown as a root-level child when tracing the thrown exception type itself (not approximate)</div>
    <div class="legend-row"><span class="k">narrowed</span>instanceof-narrowing fallback — the receiver's declared type doesn't have the method, but an "x instanceof T" narrowing found in the same method does (approximate — branch polarity is not tracked, only that the narrowing exists in the method)</div>
    <div class="legend-row"><span class="k">async</span>System.enqueueJob / Database.executeBatch / System.schedule call whose argument is an inline "new KnownClass(...)" — edge added to that class's execute method, in addition to the ordinary "new" constructor edge (not approximate)</div>
`;

// v0.6 (H1/H4 forward-compat): additional header lines beyond treeResult.note
// (which was already rendered before this round). Mirrors uitree.js's
// shapeHeaderLines, kept as an independent small implementation here rather
// than a cross-file require (see this file's header note on staying
// self-contained/dev-tool-friendly, same rationale as isRootNode above).
// Neither field existed on TreeResult when this comment was first written --
// both checks are defensive.
//
// CONTRACT NOTE (integrator, v0.6.0): resolver.js's real buildCallerTree
// output nests unresolvedSites under stats (TreeResult.stats.unresolvedSites),
// not a top-level TreeResult.unresolvedSites field -- read from stats to
// match what resolver.js actually produces (uitree.js's shapeHeaderLines
// mirrors this same fix).
function headerExtraLinesForResult(treeResult) {
  const lines = [];
  const stats = treeResult && treeResult.stats;
  if (stats && stats.capped) {
    lines.push('Result capped -- not every caller could be expanded.');
  }
  const unresolved = stats && stats.unresolvedSites;
  if (typeof unresolved === 'number' && unresolved > 0) {
    lines.push(`${unresolved} call sites workspace-wide could not be resolved (dynamic/platform/deep-chain).`);
  }
  return lines;
}

// renderPathMapHtml(treeResult, opts) -> string
//
// opts (all optional):
//   legendOpen: boolean — render the legend <details> expanded by default
//               (default false, kept collapsed so the canvas starts clean).
function renderPathMapHtml(treeResult, opts) {
  const options = opts || {};
  const root = treeResult && treeResult.root;
  const layout = root
    ? layoutTree(root)
    : { nodes: [], edges: [], width: LAYOUT.marginX * 2, height: LAYOUT.marginY * 2, maxDepth: 0 };

  const nodesOut = layout.nodes.map(shapeNodeForData);
  const edgesOut = layout.edges.map(shapeEdgeForData);

  const data = {
    meta: {
      targetLabel: (treeResult && treeResult.targetLabel) || '',
      note: (treeResult && treeResult.note) || null,
      headerExtra: headerExtraLinesForResult(treeResult),
      nodeCount: nodesOut.length,
      edgeCount: edgesOut.length,
    },
    layout: {
      width: layout.width,
      height: layout.height,
      nodeWidth: LAYOUT.nodeWidth,
      nodeHeight: LAYOUT.nodeHeight,
    },
    nodes: nodesOut,
    edges: edgesOut,
  };

  const legendOpenAttr = options.legendOpen ? ' open' : '';
  const dataScript = 'var DATA = ' + jsonForScript(data) + ';';

  return (
    '<!doctype html>\n' +
    '<html lang="en">\n' +
    '<head>\n' +
    '<meta charset="UTF-8">\n' +
    '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src \'unsafe-inline\'; script-src \'unsafe-inline\';">\n' +
    '<meta name="viewport" content="width=device-width, initial-scale=1.0">\n' +
    '<title>Apex Call Graph: Execution Path Map</title>\n' +
    '<style>' + CSS_TEXT + '</style>\n' +
    '</head>\n' +
    '<body>\n' +
    '<header id="pm-header">\n' +
    '  <div id="pm-title"></div>\n' +
    '  <div id="pm-stats"></div>\n' +
    '  <div id="pm-note"></div>\n' +
    '  <div id="pm-hint">drag to pan &middot; scroll to zoom &middot; click a node or a tooltip line to open it</div>\n' +
    '</header>\n' +
    '<details id="pm-legend"' + legendOpenAttr + '>' + LEGEND_HTML + '</details>\n' +
    '<div id="pm-viewport">\n' +
    '  <div id="pm-canvas">\n' +
    '    <svg id="pm-edges"></svg>\n' +
    '    <div id="pm-nodes"></div>\n' +
    '  </div>\n' +
    '</div>\n' +
    '<div id="pm-tooltip" class="pm-tooltip" hidden></div>\n' +
    '<script>\n' +
    dataScript + '\n' +
    CLIENT_JS_TEXT + '\n' +
    '</script>\n' +
    '</body>\n' +
    '</html>\n'
  );
}

module.exports = {
  renderPathMapHtml,
  // exported for test-pathmap.js / dev tooling; not part of the frozen
  // integration surface (only renderPathMapHtml is).
  shortenEntry,
  accentKind,
  layoutTree,
  isRootNode,
  headerExtraLinesForResult,
};

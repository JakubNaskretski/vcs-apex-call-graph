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
//   treeResult = { root: TNode, targetLabel, note, direction, stats }
//   TNode = {
//     label, kind: 'method'|'trigger'|'class'|'lwc'|'aura'|'flow'|
//       'omniscript'|'vf' (A6/A7: metadata-caller nodes from resolver.js's
//       attachMetaCallers/buildMetaChildren) | 'cmdt' (v0.4 F4b: Custom
//       Metadata record, same family, always terminal today) | 'anonymous'
//       (v0.5 G4: anonymous-Apex-script (.apex) pseudo-type/method node --
//       Apex-source family like 'method'/'trigger'/'class', NOT part of the
//       metadata-caller family; always a pure root) | 'exception' (v0.7 A3:
//       forward-traced throw target, always terminal) | 'unresolved' (v0.7
//       A6: one aggregated, always-terminal, always-approximate leaf per
//       method summarizing unresolved forward call sites) | 'external'
//       (v0.8 N1/N4/N6, forward-compat -- resolver.js does not produce this
//       kind yet, same status as the seenElsewhere field below: a reference
//       into managed-package code this workspace has no source for.
//       Terminal in the callees direction; in callers direction its
//       children are the ordinary local caller subtree of every site that
//       references it -- no special-casing needed here either way, see
//       accentKind/shapeNodeForData below for its accent + 'managed: <ns>'
//       badge),
//     className, methodLower,
//     path, line, entries: [string], isTest,
//     package,  // string|null|undefined (v0.7 B3): the sfdx package label
//               // this node's file lives under -- see shapeNodeForData's
//               // targetPackage/packageBadge threading below, which turns
//               // it into a '(label)' badge ONLY when it differs from the
//               // traced target's own package (root.package).
//     ns,       // string|undefined (v0.8 N1/N4, forward-compat): ONLY
//               // meaningful on a kind:'external' node -- its managed-
//               // package namespace, mirrored into the 'managed: <ns>'
//               // badge (see managedBadge/shapeNodeForData below).
//     via: string|null,  // ...|'metadata'|'dml'|'dynamic'|'override' (v0.4
//                         // adds the last three)|'publish'|'throws'|
//                         // 'narrowed'|'async' (v0.5 G1/G2/G3/G5 add these
//                         // four; only 'narrowed' is approximate)|
//                         // 'ambiguous' (v0.7 B2: duplicate-named-class
//                         // fan-out that neither same-package nor default-
//                         // package preference could resolve; approximate)|
//                         // 'external' (v0.8 N1/N2/N4, forward-compat: a
//                         // reference into managed-package code -- NOT
//                         // approximate, see uitree.js's matching TNode.via
//                         // doc for the rationale)
//                         // -- rendered verbatim as edge labels/node badges,
//                         // no code change needed here for a new via string
//                         // to show up correctly)
//     sites: [SiteView], children: [TNode],
//     cyclic, truncated, approximate,
//     caughtHere,  // boolean, v0.5 G2: an ancestor catch clause catches the
//                  // exception being traced AT THIS NODE. Always paired with
//                  // a matching entries badge text ('catches <ExcName>',
//                  // resolver.js's doing) -- this file additionally renders
//                  // a shield-glyph badge for it (see badgeGlyphs in
//                  // CLIENT_JS_TEXT). Traversal continues past a caughtHere
//                  // node, so it is purely an informational marker.
//     expandable,  // boolean, v0.9 P1 (forward-compat -- resolver.js does
//                  // not produce this yet, mirrors uitree.js's matching
//                  // field doc verbatim): this node hit the progressive
//                  // depth frontier -- real callers/callees exist
//                  // (pendingCount says how many DIRECT groups) but weren't
//                  // expanded this pass, so `children` is empty here even
//                  // though the node is NOT actually childless. Rendered as
//                  // a clickable '+N' pill (see the CLIENT_JS_TEXT pill
//                  // note below), distinct from the plain read-only badge
//                  // spans, and excluded from the 'root' flag (isRootNode
//                  // below) -- same "there IS more, just not shown" family
//                  // as cyclic/truncated/seenElsewhere.
//     pendingCount,  // number|undefined, v0.9 P1 (forward-compat): ONLY
//                    // meaningful alongside expandable:true -- see
//                    // uitree.js's matching field doc.
//     methodKey,     // string|undefined, v0.9 P1 (forward-compat): ONLY
//                    // meaningful alongside expandable:true -- the
//                    // methodKeyLower identity the pill's click-to-expand
//                    // affordance posts back to the extension (see
//                    // frontierMethodKey below); optional, same
//                    // "explicit field wins, else derive from
//                    // className+methodLower" pattern as `ns`/
//                    // externalNamespace.
//   }
//
// v0.7 (A3) direction: treeResult.direction is 'callers'|'callees'|absent.
// resolver.js's buildCallerTree stamps 'callers' on EVERY TreeResult it
// returns, unconditionally -- so 'callers' is treated exactly like an
// absent field: both render byte-identically to before this round
// (unmirrored layout, no direction header/meta text -- see layoutTree/
// renderPathMapHtml below, both take the same non-mirrored branch and
// produce a null directionLabel). 'callees' -- the one genuinely NEW
// direction this round adds -- mirrors the layout (target LEFT, callees fan
// out RIGHT -- see layoutTree) and shows an explicit 'What Does This Call?'
// header/meta label. See uitree.js's matching directionHeaderLine for the
// fuller interpretive-decision writeup (not duplicated here verbatim,
// consistent with this file's existing pattern of small independent
// re-implementations rather than a cross-file require).
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
// v0.7 (A3): two more "the kind alone decides the accent" buckets, same
// priority tier as trigger/anonymous, ahead of entry/test -- an exception-
// class node or an aggregated unresolved-sites leaf could in principle
// carry entries (e.g. an exception class that is ALSO an inner class with
// its own annotation) and must not collapse onto the generic 'entry' accent
// and lose its distinct color.
// v0.8 (N6, forward-compat): a 7th bucket, 'external', for TNode.kind===
// 'external' -- see the module header's TNode.kind doc above. Same "the
// kind alone decides the accent" tier as trigger/anonymous/exception/
// unresolved, ahead of entry/test, for the identical reason: an external
// node could in principle carry entries and must not collapse onto the
// generic 'entry' accent and lose its distinct color.
function accentKind(node) {
  if (node.kind === 'trigger') return 'trigger';
  if (node.kind === 'anonymous') return 'anonymous';
  if (node.kind === 'exception') return 'exception';
  // v0.7.1 (U3, R8): confirmed against resolver.js's real buildCalleeTree
  // implementation -- the generic-typed-DML marker reuses kind:'unresolved'
  // verbatim (via 'dml-unresolved' is what distinguishes it; see
  // LEGEND_HTML below), so no separate kind/accent branch is needed here.
  if (node.kind === 'unresolved') return 'unresolved';
  if (node.kind === 'external') return 'external';
  if (META_ACCENT_KINDS.has(node.kind)) return 'metadata';
  if (node.entries && node.entries.length) return 'entry';
  if (node.isTest) return 'test';
  return 'normal';
}

// v0.8 (N4/N6, forward-compat): mirrors uitree.js's externalNamespace/
// managedBadge exactly -- kept as independent small implementations here
// rather than a cross-file require, same rationale as isRootNode/
// packageBadge above (this file stays a standalone, dev-tool-friendly
// module). See uitree.js's matching comment for the full label-derivation
// rationale (a TNode arriving with kind:'external' but no explicit `ns`
// field still renders a correct badge, derived from its own label).
function externalNamespace(node) {
  if (!node || node.kind !== 'external') return null;
  if (typeof node.ns === 'string' && node.ns) return node.ns;
  const label = typeof node.label === 'string' ? node.label : '';
  const dotIdx = label.indexOf('.');
  if (dotIdx > 0) return label.slice(0, dotIdx);
  const dunderIdx = label.indexOf('__');
  if (dunderIdx > 0) return label.slice(0, dunderIdx);
  return null;
}

function managedBadge(node) {
  const ns = externalNamespace(node);
  return ns ? `managed: ${ns}` : null;
}

// v0.9 (P1/P4, forward-compat): mirrors uitree.js's frontierMethodKey
// exactly -- see that file's comment for the full "explicit field wins,
// else derive from className+methodLower" rationale. Kept as an
// independent small implementation here rather than a cross-file require,
// same rationale as isRootNode/packageBadge/externalNamespace/managedBadge
// above (this file stays a standalone, dev-tool-friendly module -- and
// CLIENT_JS_TEXT executes in the webview's own JS realm, which cannot
// require() this Node module at all, so the client-side pill click handler
// below re-derives the same key from the already-serialized node data
// rather than calling this function directly).
function frontierMethodKey(node) {
  if (!node) return null;
  if (typeof node.methodKey === 'string' && node.methodKey) return node.methodKey;
  const cls = typeof node.className === 'string' ? node.className.toLowerCase() : '';
  const method = typeof node.methodLower === 'string' && node.methodLower ? node.methodLower : null;
  if (!cls && !method) return null;
  return method ? `${cls}#${method}` : cls;
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
// to column. By default (the callers direction -- `direction` absent or
// 'callers', see this file's header note on why those two are treated
// identically) the target (depth 0) is the RIGHTMOST column, and each hop
// further from it moves one column left, exactly as before this round.
//
// v0.7 (A3): when `direction === 'callees'` the column order MIRRORS -- the
// target (depth 0) becomes the LEFTMOST column and each hop further (each
// forward call) moves one column right, per the A3 spec ("target LEFT,
// callees flowing RIGHT (mirror the column math)"). This is a pure column-
// index flip (`rec.depth` instead of `maxDepth - rec.depth`); row placement
// (the leaf-order dendrogram pass above) and every other geometry constant
// (colWidth, width, height) are completely unaffected -- only which end of
// the row a given depth lands on changes. The client-side edge-curve
// direction (CLIENT_JS_TEXT's edgePath) reads DATA.layout.mirrored to draw
// curves the same reading-direction way (parent-column -> child-column,
// left to right) as the callers direction already always did.
function layoutTree(root, direction) {
  const mirrored = direction === 'callees';
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
    // target (depth 0) -> rightmost column normally, leftmost when mirrored.
    const col = mirrored ? rec.depth : maxDepth - rec.depth;
    rec.x = LAYOUT.marginX + col * LAYOUT.colWidth;
    rec.y = LAYOUT.marginY + rec.row * LAYOUT.rowHeight;
  }

  const width = LAYOUT.marginX * 2 + (maxDepth + 1) * LAYOUT.colWidth;
  const height = LAYOUT.marginY * 2 + Math.max(1, leafCounter) * LAYOUT.rowHeight;
  return { nodes: nodes, edges: edges, width: width, height: height, maxDepth: maxDepth, mirrored: mirrored };
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
//
// v0.9 (P1/P4, forward-compat): `expandable` joins the exclusion list, same
// rationale/regression-safety as uitree.js's matching isRootNode update --
// `t.expandable` is undefined on every pre-v0.9 fixture, so `!undefined` is
// `true` and this is a no-op there.
function isRootNode(t) {
  if (!t) return false;
  const hasChildren = !!(t.children && t.children.length);
  return !hasChildren && !t.cyclic && !t.truncated && !t.seenElsewhere && !t.expandable;
}

// v0.7 (B3): the node's package badge text, or null when none applies --
// mirrors uitree.js's packageBadge exactly (see that file's comment for the
// full rationale), kept as an independent small implementation here rather
// than a cross-file require, same rationale as isRootNode above.
function packageBadge(node, targetPackage) {
  if (!node || !node.package) return null;
  if (node.package === targetPackage) return null;
  return '(' + node.package + ')';
}

// v0.7 (B3): `targetPackage` is an OPTIONAL second argument -- the traced
// target's own `.package` (computed once in renderPathMapHtml from the tree
// root and threaded through every node). Every EXISTING call site that
// invokes `shapeNodeForData(rec)` with just one argument keeps behaving
// exactly as before: `targetPackage` is undefined, so packageBadge() below
// returns null for every node unless that node happens to carry a
// `.package` of its own (no pre-v0.7 fixture does).
function shapeNodeForData(rec, targetPackage) {
  const t = rec.tnode || {};
  const badges = (t.entries || []).map(shortenEntry);
  // v0.8 (N4/N6, forward-compat): the 'managed: <ns>' badge for an external
  // node -- a node-level fact about THIS node (which managed package it
  // belongs to), so it joins `badges` the same way entries/pkgBadge do,
  // rather than riding on the edge-level `via` field a couple lines below
  // (edges get their own label from `t.via`, see CLIENT_JS_TEXT's edge
  // rendering -- this badge is about the node, not the edge into it).
  const managed = managedBadge(t);
  if (managed) badges.push(managed);
  const pkgBadge = packageBadge(t, targetPackage);
  if (pkgBadge) badges.push(pkgBadge);
  return {
    id: rec.id,
    parentId: rec.parentId,
    x: rec.x,
    y: rec.y,
    label: t.label != null ? String(t.label) : '',
    kind: t.kind || 'class',
    accent: accentKind(t),
    badges: badges,
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
    // v0.7 (B3): the raw package label (or null) -- not itself rendered as
    // a badge client-side (the badge string, if any, already landed in
    // `badges` above); exposed so dev tooling / future callers can inspect
    // it without re-deriving from `entries`.
    package: t.package || null,
    // v0.8 (N4/N6, forward-compat): the resolved external namespace (or
    // null) -- same "raw value exposed alongside its derived badge" pattern
    // as `package` immediately above; the badge string itself, if any,
    // already landed in `badges` above.
    ns: externalNamespace(t),
    sites: (t.sites || []).map(shapeSiteForData),
    // v0.9 (P1/P4, forward-compat): NOT folded into `badges` above (unlike
    // managed/pkgBadge) -- the frontier marker renders client-side as a
    // distinct, CLICKABLE pill (see CLIENT_JS_TEXT's buildNodeEl), not a
    // plain read-only badge span, so the client needs these raw fields to
    // build that pill itself rather than a pre-rendered string.
    expandable: !!t.expandable,
    pendingCount: typeof t.pendingCount === 'number' ? t.pendingCount : null,
    expandKey: frontierMethodKey(t),
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
    /* v0.7 (A3): no dedicated --vscode-charts-* slot is left unclaimed by
       the buckets above, so these two reach for theme-semantic vars instead
       of the charts palette -- errorForeground fits an exception-class node
       directly, disabledForeground reads as "unknown/inert", matching an
       aggregated unresolved-sites leaf. */
    --pm-exception: var(--vscode-errorForeground, #f14c4c);
    --pm-unresolved: var(--vscode-disabledForeground, #8a8a8a);
    /* v0.8 (N6, forward-compat): an 8th accent bucket for kind:'external'
       (managed-package reference) nodes. charts-cyan is the one
       --vscode-charts-* slot none of the buckets above claims yet, and its
       cool, "not one of ours" tone fits a node whose source lives outside
       this workspace. */
    --pm-external: var(--vscode-charts-cyan, #29b6f6);
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
  /* v0.7 (A3): direction sign-post -- empty (no width impact beyond its own
     zero content) whenever DATA.meta.directionLabel is null, i.e. for every
     pre-v0.7-shaped/undirected TreeResult and the 'today' byte-identical
     case; see directionHeaderLine's interpretive-decision comment. */
  #pm-direction { font-weight: 600; font-size: 12px; color: var(--pm-link); }

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
  .swatch.exception { background: var(--pm-exception); }
  .swatch.unresolved { background: var(--pm-unresolved); }
  .swatch.external { background: var(--pm-external); }

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
  .node.kind-exception { border-left: 4px solid var(--pm-exception); }
  .node.kind-unresolved { border-left: 4px solid var(--pm-unresolved); }
  .node.kind-external { border-left: 4px solid var(--pm-external); }
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
  /* v0.9 (P1/P4): the frontier '+N' pill -- deliberately DISTINCT from the
     plain, read-only .badge spans above (solid link-color fill instead of an
     outlined muted-text chip) so it visually reads as clickable, not just
     informational. A dedicated block (not nested in .node-badges) since it
     is appended as its own row, separate from the ordinary badge row -- see
     buildNodeEl in CLIENT_JS_TEXT below and the pill-vs-body click
     separation note there. */
  .frontier-pill {
    display: inline-block; margin-top: 4px; font-size: 10px; font-weight: 600; line-height: 1.6;
    padding: 0 7px; border-radius: 9px; background: var(--pm-link); color: var(--pm-node-bg);
    cursor: pointer; border: none;
  }
  .frontier-pill:hover { filter: brightness(1.15); }
  .frontier-pill:active { filter: brightness(0.9); }

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

  // v0.9 (P1/P4): posted by a frontier node's '+N' pill click (see
  // buildNodeEl below) -- {type:'expand', key} per the P2 CONTRACT
  // AMENDMENT text verbatim. n.expandKey is server-computed
  // (shapeNodeForData/frontierMethodKey in pathmap.js), never re-derived
  // client-side, so this stays a pure postMessage relay, same shape as
  // postOpen immediately above.
  function requestExpand(n) {
    if (!n || !n.expandKey) return;
    var msg = { type: 'expand', key: n.expandKey };
    if (vscodeApi) {
      vscodeApi.postMessage(msg);
    } else {
      console.log('[apex-trace pathmap] expand', msg);
    }
  }

  function clearChildren(el) {
    while (el.firstChild) el.removeChild(el.firstChild);
  }

  var header = document.getElementById('pm-title');
  var directionEl = document.getElementById('pm-direction');
  var stats = document.getElementById('pm-stats');
  var noteEl = document.getElementById('pm-note');

  // v0.9 (P1/P4): the header-rendering logic, factored into its own named
  // function so the {type:'update'} handler (applyUpdate, near the bottom
  // of this script) can reuse it VERBATIM instead of a second, driftable
  // copy -- called once below for the initial render, exactly reproducing
  // this file's pre-v0.9 top-level statement order/behavior.
  function renderHeader() {
    header.textContent = DATA.meta.targetLabel || '(no target)';
    // v0.7 (A3): direction sign-post -- left EMPTY (matching every pre-v0.7
    // render byte-for-byte) whenever directionLabel is null, i.e. absent/
    // undirected TreeResults; see directionHeaderLine's interpretive-decision
    // comment for why that specific case must stay exactly "today".
    if (DATA.meta.directionLabel) {
      directionEl.textContent = DATA.meta.directionLabel;
    }
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
  }
  renderHeader();

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
  function indexNodes() {
    nodeById = {};
    DATA.nodes.forEach(function (n) { nodeById[n.id] = n; });
  }
  indexNodes();

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
    if (n.truncated) out.push('\\u2026'); // ellipsis (capped -- depth cap or node-count cap)
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

    // v0.9 (P1/P4): the frontier '+N' pill -- a DISTINCT, clickable element
    // (see the .frontier-pill CSS rule) appended as its own row, separate
    // from the plain read-only .badge spans above. PILL-VS-BODY CLICK
    // SEPARATION: its own click listener calls ev.stopPropagation() FIRST,
    // so the click never bubbles up to el's own 'click' listener below
    // (which still jumps to source) -- clicking the pill posts {type:
    // 'expand', key}, clicking anywhere else on the node body still jumps.
    if (n.expandable) {
      var pill = document.createElement('span');
      pill.className = 'frontier-pill';
      pill.textContent = '+' + (n.pendingCount == null ? '' : n.pendingCount);
      var pillNoun = DATA.meta.direction === 'callees' ? 'callees' : 'callers';
      var pillCount = n.pendingCount == null ? 'more' : String(n.pendingCount) + ' more';
      pill.title = pillCount + ' direct ' + pillNoun + ' \\u2014 click to expand';
      pill.addEventListener('click', function (ev) {
        ev.stopPropagation();
        requestExpand(n);
      });
      el.appendChild(pill);
    }

    el.addEventListener('mouseenter', function () { cancelHideTooltip(); showTooltip(n, el); });
    el.addEventListener('mouseleave', scheduleHideTooltip);
    el.addEventListener('click', function () {
      if (dragMoved) return; // a pan gesture that ended over a node must not open it
      postOpen(n.path, n.line, 0);
    });

    return el;
  }

  // v0.7 (A3): 'to' is always the tree PARENT (edges are gathered child->
  // parent, see layoutTree/shapeEdgeForData -- this doesn't change with
  // direction) and 'from' is always the tree CHILD. In the default
  // (non-mirrored) layout the parent sits at a LARGER x than the child (the
  // target/depth-0 node is rightmost), so the curve is drawn child-right-
  // edge -> parent-left-edge, i.e. left-to-right, converging into the
  // target -- exactly the pre-v0.7 behavior, unchanged when MIRRORED is
  // false (see the leftNode/rightNode selection below: false picks
  // leftNode=from/rightNode=to, identical to the original from/to/x1/y1/x2/
  // y2 assignment this replaced). When MIRRORED is true the parent instead
  // sits at the SMALLER x (target/depth-0 is leftmost, see layoutTree), so
  // leftNode/rightNode swap to keep the curve reading left-to-right
  // (parent's right edge -> child's left edge) instead of drawing
  // backwards.
  var MIRRORED = !!(DATA.layout && DATA.layout.mirrored);
  function edgePath(from, to) {
    var leftNode = MIRRORED ? to : from;
    var rightNode = MIRRORED ? from : to;
    var x1 = leftNode.x + NW;
    var y1 = leftNode.y + NH / 2;
    var x2 = rightNode.x;
    var y2 = rightNode.y + NH / 2;
    var midX = (x1 + x2) / 2;
    return 'M ' + x1 + ' ' + y1 + ' C ' + midX + ' ' + y1 + ', ' + midX + ' ' + y2 + ', ' + x2 + ' ' + y2;
  }

  // v0.9 (P1/P4): the node+edge DOM construction, factored into its own
  // named function so the {type:'update'} handler (applyUpdate below) can
  // rebuild the map from a fresh data blob by calling the EXACT same code
  // the initial render already used, instead of a second, driftable copy.
  // Called once below for the initial render.
  function renderGraph() {
    DATA.nodes.forEach(function (n) {
      nodesLayer.appendChild(buildNodeEl(n));
    });

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
  }
  renderGraph();

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

  // ---- update-in-place: {type:'update', data} ------------------------------
  // v0.9 (P1/P4): posted by extension.js after a frontier click grows the
  // trace (see requestExpand above) -- extension.js builds the data value
  // with pathmap.js's own exported buildPathMapData(newTreeResult), the EXACT
  // same shape this script's DATA already is, then calls
  // panel.webview.postMessage({type:'update', data: data}). No jsonForScript
  // escaping is needed on this path AT ALL: postMessage structured-clones a
  // real JS object straight into this webview's 'message' event, it is
  // NEVER re-parsed as embedded script-tag text, so the closing-tag-breakout
  // risk jsonForScript defends against on the INITIAL blob (see this file's
  // SECURITY header note) simply does not exist here. What DOES still apply,
  // unchanged, is the DOM-safety invariant this whole file holds to (see
  // this file's SECURITY header note): applyUpdate below renders everything
  // it touches via the exact same createElement/textContent-only functions
  // (renderHeader/renderGraph/buildNodeEl) the initial render already used
  // -- there is no second, less careful code path.
  //
  // PRESERVE pan/zoom + legend state:
  //   - pan/zoom: preserveTransformOnUpdate is a pure, DOM-free function
  //     (also exported Node-side from pathmap.js, see that file's matching
  //     export, so the "preserve, never re-derive" contract is unit-
  //     testable independent of any browser) -- it is an intentional
  //     IDENTITY pass-through: applyUpdate below calls it and reapplies the
  //     result instead of calling fitInitial() again, so the just-rebuilt
  //     canvas renders at the exact pan/zoom position the user already had,
  //     never snapping back to a fitted default view.
  //   - legend: the #pm-legend <details> element's open/closed state is
  //     simply never referenced anywhere below -- there is no code path
  //     that could reset it, so it is preserved automatically by omission.
  function preserveTransformOnUpdate(prevTransform) {
    var keptScale = prevTransform && typeof prevTransform.scale === 'number' ? prevTransform.scale : 1;
    var keptPanX = prevTransform && typeof prevTransform.panX === 'number' ? prevTransform.panX : 24;
    var keptPanY = prevTransform && typeof prevTransform.panY === 'number' ? prevTransform.panY : 24;
    return { scale: keptScale, panX: keptPanX, panY: keptPanY };
  }

  function applyUpdate(newData) {
    DATA = newData;
    renderHeader();

    W = DATA.layout.width;
    H = DATA.layout.height;
    NW = DATA.layout.nodeWidth;
    NH = DATA.layout.nodeHeight;
    canvas.style.width = W + 'px';
    canvas.style.height = H + 'px';
    edgesSvg.setAttribute('width', String(W));
    edgesSvg.setAttribute('height', String(H));
    MIRRORED = !!(DATA.layout && DATA.layout.mirrored);

    indexNodes();

    // A lingering tooltip would describe a now-removed DOM node / stale
    // data -- hidden rather than left open and wrong.
    tooltip.hidden = true;

    clearChildren(nodesLayer);
    clearChildren(edgesSvg);
    renderGraph();

    var kept = preserveTransformOnUpdate({ scale: scale, panX: panX, panY: panY });
    scale = kept.scale;
    panX = kept.panX;
    panY = kept.panY;
    applyTransform();
  }

  window.addEventListener('message', function (event) {
    var msg = event.data;
    if (!msg || msg.type !== 'update' || !msg.data) return;
    applyUpdate(msg.data);
  });
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
    <div class="legend-row"><span class="swatch exception"></span><span><span class="k">exception</span>(v0.7) a thrown exception's class, reached by tracing forward (What Does This Call?) through a "throw" statement — always terminal</span></div>
    <div class="legend-row"><span class="swatch unresolved"></span><span><span class="k">unresolved</span>(v0.7) one aggregated leaf per method, summarizing every forward call site that couldn't be resolved to an indexed target (dynamic/platform calls, e.g. HttpRequest/System.debug) — always terminal, approximate. Also covers a DML statement whose target couldn't be narrowed to a concrete SObject type (e.g. a generic List&lt;SObject&gt;) — labeled "DML on unresolved SObject type", no trigger/flow linkage possible</span></div>
    <div class="legend-row"><span class="swatch external"></span><span><span class="k">external</span>(v0.8) a reference into managed-package code this workspace has no source for — terminal when tracing What Does This Call?; a valid trace target with its own local-caller subtree when tracing Who Calls This</span></div>
    <h4>Markers</h4>
    <div class="legend-row"><span class="k">~ prefix</span>approximate resolution (dashed border too) — via interface/unique-name/lexical/override/narrowed/dynamic fallback, so this edge may be wrong or one of several candidates</div>
    <div class="legend-row"><span class="k">&#x1F9EA;</span>test-only node (also dimmed)</div>
    <div class="legend-row"><span class="k">&#x21BA;</span>cyclic — this call chain recurses back on itself here</div>
    <div class="legend-row"><span class="k">&#x2026;</span>capped — trace depth cap OR the node-count (maxNodes) cap reached, more callers/callees may exist beyond this node</div>
    <div class="legend-row"><span class="k">&#x1F6E1;</span>caughtHere — an ancestor catch clause here catches the exception being traced (exact type, a USER exception ancestor, or bare Exception); paired with a "catches &lt;Exc&gt;" badge. Traversal still continues past this node — rethrow is unknowable</div>
    <div class="legend-row"><span class="k">&#x25C9;</span>root — no known caller in this trace: an entry point or unused/dead code. Never shown together with cyclic, truncated, or seenElsewhere (those all mean "there IS more above, it just isn't shown/expanded here")</div>
    <div class="legend-row"><span class="k">&#x21E2;</span>seenElsewhere — this method's caller subtree was already expanded once elsewhere in this same trace (per-run dedup); its own call sites are still shown here, only the deeper callers above it are collapsed</div>
    <div class="legend-row"><span class="k">+N pill</span>(v0.9) progressive-depth frontier — N direct callers/callees exist but haven't been loaded yet (see apexCallGraph.initialDepth). A distinct, CLICKABLE pill, separate from the plain read-only badges above and from the node body itself — click the pill (not the node) to expand this node in place; clicking the node body still jumps to its source, exactly as before. Pan/zoom and the legend's own open/closed state are preserved across the expand</div>
    <div class="legend-row"><span class="k">(pkgLabel)</span>(v0.7 B3) package badge — shown on a node when its file lives in a DIFFERENT sfdx package directory than the traced target's; the label is the package name from sfdx-project.json's packageDirectories, or the path segment itself when that directory declares no package name. A single call site can fan out to two children with two DIFFERENT badges (see the "ambiguous" via below)</div>
    <div class="legend-row"><span class="k">managed: ns</span>(v0.8 N4) managed-package badge — shown on an "external" node, naming the managed-package namespace it belongs to (e.g. "managed: zenq")</div>
    <div class="legend-row"><span class="k">N dup. names</span>(v0.7 B3) header note — "&lt;N&gt; duplicate class names across packages" appears above the map whenever this workspace has classes sharing the same qualified name across two or more sfdx packages; resolution always prefers the referring file's own package first, then the default package, before falling back to the ambiguous fan-out below</div>
    <h4>Direction</h4>
    <div class="legend-row"><span class="k">Who Calls This</span>(default, unlabeled above) the traced target sits on the RIGHT; its callers fan out to the LEFT, one hop per column, converging into the target</div>
    <div class="legend-row"><span class="k">What This Calls</span>(v0.7 A3, forward tracing — shown above as "What Does This Call?") the traced target sits on the LEFT instead; its callees fan out to the RIGHT, one hop per column — the column order and every edge curve mirror the default layout so both directions still read left-to-right</div>
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
    <div class="legend-row"><span class="k">ambiguous</span>(v0.7 B2) a class name duplicated across sfdx packages that neither same-package nor default-package preference could resolve — every remaining candidate gets its own edge, each typically carrying a DIFFERENT package badge (approximate)</div>
    <div class="legend-row"><span class="k">unresolved</span>(v0.7.1) marks the aggregated "N unresolved sites" leaf itself — one or more forward call sites in this method couldn't be resolved to an indexed target (approximate)</div>
    <div class="legend-row"><span class="k">dml-unresolved</span>(v0.7.1) a DML statement whose target couldn't be narrowed to a concrete SObject (e.g. a generic List&lt;SObject&gt;/SObject-typed variable) — no trigger or flow linkage could be traced (approximate)</div>
    <div class="legend-row"><span class="k">external</span>(v0.8 N1/N2/N4) a reference into managed-package code (a namespaced method/class call, or a DML target naming a managed object) — NOT approximate, a genuine namespace match (see the "external" accent above)</div>
`;

// v0.7 (A3): mirrors uitree.js's directionHeaderLine exactly -- see that
// file's INTERPRETIVE DECISION comment for the full byte-identical-bar
// writeup (not duplicated here verbatim, consistent with this file's
// existing pattern of small independent re-implementations, same rationale
// as isRootNode/packageBadge above). resolver.js's buildCallerTree stamps
// `direction: 'callers'` on EVERY TreeResult unconditionally, so 'callers'
// (like an absent field) stays the silent, byte-identical-to-today case;
// only 'callees' (the genuinely new v0.7 capability) gets the explicit
// 'What Does This Call?' sign-post, mirroring apexTrace.traceCallees's
// command title verbatim (package.json, not owned by this file).
function directionHeaderLine(direction) {
  if (direction === 'callees') return 'What Does This Call?';
  return null;
}

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
//
// v0.7 (B3): duplicate-names line prepended ahead of capped/unresolved,
// gated behind stats.duplicateNames > 0 -- does not fire for a
// pre-v0.7-shaped TreeResult (no `stats.duplicateNames`), so fixture7's
// existing exact-array assertion in test-pathmap.js is unaffected. (The
// direction sign-post itself is NOT folded in here -- it gets its own
// dedicated `data.meta.directionLabel` field / `#pm-direction` header
// element instead, see renderPathMapHtml below, so it reads as a primary
// mode indicator rather than getting lost among capped/unresolved
// warnings.) The capped-line wording is direction-aware for the same
// reason uitree.js's is (see shapeHeaderLines there): the SAME cap/DAG-
// memoization machinery now runs in both directions, so "caller" would be
// misleading for a callees-direction result.
function headerExtraLinesForResult(treeResult) {
  const lines = [];
  const stats = treeResult && treeResult.stats;
  if (stats && typeof stats.duplicateNames === 'number' && stats.duplicateNames > 0) {
    lines.push(
      `${stats.duplicateNames} duplicate class names across packages — resolution prefers the referring file's package`
    );
  }
  if (stats && stats.capped) {
    const cappedNoun = (treeResult && treeResult.direction) === 'callees' ? 'callee' : 'caller';
    lines.push(`Result capped -- not every ${cappedNoun} could be expanded.`);
  }
  const unresolved = stats && stats.unresolvedSites;
  // v0.8 (N5, forward-compat): mirrors uitree.js's matching shapeHeaderLines
  // addition exactly -- see that file's comment for the full rationale and
  // the byte-identical-when-absent gate this depends on (adv-org, with zero
  // namespaced refs, always has externalRefs absent/0, so it always takes
  // the untouched `else` branch below).
  const externalRefs = stats && stats.externalRefs;
  const externalNamespaces = stats && Array.isArray(stats.externalNamespaces) ? stats.externalNamespaces : [];
  if (typeof externalRefs === 'number' && externalRefs > 0) {
    const unresolvedPart = typeof unresolved === 'number' ? unresolved : 0;
    const refWord = externalRefs === 1 ? 'ref' : 'refs';
    const nsPart = externalNamespaces.length ? ` (${externalNamespaces.join(', ')})` : '';
    lines.push(`${unresolvedPart} unresolved · ${externalRefs} managed-package ${refWord}${nsPart}.`);
  } else if (typeof unresolved === 'number' && unresolved > 0) {
    lines.push(`${unresolved} call sites workspace-wide could not be resolved (dynamic/platform/deep-chain).`);
  }
  // v0.7.1 (U3, M2 coordination point): mirrors uitree.js's matching
  // shapeHeaderLines addition -- see that file's comment for the full
  // rationale (attachMetaCallers() candidate-count gate dropping an
  // ambiguous/unmatched-namespace metadata ref instead of mis-pointing it
  // at an unrelated same-name local class). 'metaUnresolved' is the exact
  // stat field name given in the fix spec.
  const metaUnresolved = stats && stats.metaUnresolved;
  if (typeof metaUnresolved === 'number' && metaUnresolved > 0) {
    lines.push(
      `${metaUnresolved} metadata reference${metaUnresolved === 1 ? '' : 's'} could not be attached (ambiguous or unmatched namespace).`
    );
  }
  return lines;
}

// v0.9 (P1/P4): the DATA blob (meta/layout/nodes/edges) renderPathMapHtml
// embeds into the initial document, factored out into its own exported
// function -- THE "rebuild helper" the update-in-place feature needs to be
// unit-testable in Node (see this file's module.exports comment and
// test-pathmap.js): extension.js calls this a SECOND time after a frontier
// click grows the trace (buildCallerTree/buildCalleeTree re-run with the
// expanded opts.expandedKeys) and posts the result straight to the webview
// as panel.webview.postMessage({type:'update', data: buildPathMapData(...)})
// -- see CLIENT_JS_TEXT's update-in-place section for the client half of
// this contract. Every field/shape is identical to what renderPathMapHtml
// already embedded pre-v0.9 (this is a pure extraction, not a new shape);
// renderPathMapHtml below now simply calls this and JSON-embeds the result,
// so the INITIAL render is byte-identical to before this round.
function buildPathMapData(treeResult) {
  const root = treeResult && treeResult.root;
  const direction = treeResult && treeResult.direction;
  const layout = root
    ? layoutTree(root, direction)
    : {
        nodes: [],
        edges: [],
        width: LAYOUT.marginX * 2,
        height: LAYOUT.marginY * 2,
        maxDepth: 0,
        mirrored: direction === 'callees',
      };

  // v0.7 (B3): the traced target is `root` regardless of direction (see
  // this file's header note -- buildCalleeTree's root is the traced method
  // too, only its `children` mean something different), so `root.package`
  // is unambiguously "the target's package" either way.
  const targetPackage = (root && root.package) || null;
  const nodesOut = layout.nodes.map((rec) => shapeNodeForData(rec, targetPackage));
  const edgesOut = layout.edges.map(shapeEdgeForData);

  return {
    meta: {
      targetLabel: (treeResult && treeResult.targetLabel) || '',
      note: (treeResult && treeResult.note) || null,
      headerExtra: headerExtraLinesForResult(treeResult),
      // v0.7 (A3): both fields are additive-only and null whenever
      // `direction` is absent -- see directionHeaderLine's interpretive-
      // decision comment for why that specific case must stay exactly
      // "today" (this is the literal mechanism behind the pinned
      // "callers-direction render is byte-identical to today" bar).
      direction: direction || null,
      directionLabel: directionHeaderLine(direction),
      nodeCount: nodesOut.length,
      edgeCount: edgesOut.length,
    },
    layout: {
      width: layout.width,
      height: layout.height,
      nodeWidth: LAYOUT.nodeWidth,
      nodeHeight: LAYOUT.nodeHeight,
      // v0.7 (A3): read by CLIENT_JS_TEXT's edgePath to flip which side of
      // an edge is treated as visually-left vs visually-right; false for
      // every direction except 'callees' (see layoutTree's own comment).
      mirrored: !!layout.mirrored,
    },
    nodes: nodesOut,
    edges: edgesOut,
  };
}

// v0.9 (P1/P4): the ENTIRE "preserve pan/zoom on an in-place update" promise
// captured as one pure, DOM-free function, exported so it is unit-testable
// here in Node -- CLIENT_JS_TEXT's applyUpdate (search
// 'preserveTransformOnUpdate' there) calls a textually-identical algorithm
// on the client; kept as two independent copies rather than one shared
// require, same rationale as isRootNode/packageBadge/externalNamespace/
// managedBadge/frontierMethodKey above (this file stays a standalone,
// dev-tool-friendly, zero-bundler module -- CLIENT_JS_TEXT executes in the
// webview's own JS realm, which cannot require() this Node module).
//
// The function is intentionally an IDENTITY pass-through of `prevTransform`
// -- preserving pan/zoom on an in-place data update means exactly "do
// nothing to these three numbers", never re-deriving them from the new
// data (which would be indistinguishable from silently losing the user's
// current pan/zoom position, the exact regression this feature exists to
// prevent -- note the function does not even ACCEPT a `newData` parameter,
// so there is nothing for a future edit to accidentally start reading).
// The pure-function boundary exists so that invariant is independently
// checkable (see test-pathmap.js): a future change to the update path that
// starts threading new-data-derived values into this function to
// "helpfully" re-fit the view would show up as a changed function
// signature/behavior a reviewer can catch, rather than a silent DOM
// behavior change no test in this suite could ever observe (pathmap.js has
// no browser/DOM harness -- see this file's header note).
function preserveTransformOnUpdate(prevTransform) {
  const scale = prevTransform && typeof prevTransform.scale === 'number' ? prevTransform.scale : 1;
  const panX = prevTransform && typeof prevTransform.panX === 'number' ? prevTransform.panX : 24;
  const panY = prevTransform && typeof prevTransform.panY === 'number' ? prevTransform.panY : 24;
  return { scale, panX, panY };
}

// renderPathMapHtml(treeResult, opts) -> string
//
// opts (all optional):
//   legendOpen: boolean — render the legend <details> expanded by default
//               (default false, kept collapsed so the canvas starts clean).
function renderPathMapHtml(treeResult, opts) {
  const options = opts || {};
  const data = buildPathMapData(treeResult);

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
    '  <div id="pm-direction"></div>\n' +
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
  packageBadge,
  // v0.8 (N4/N6): external-node badge helpers, exported so test-pathmap.js
  // can unit-test them directly, same rationale as packageBadge/isRootNode.
  externalNamespace,
  managedBadge,
  directionHeaderLine,
  headerExtraLinesForResult,
  // v0.9 (P1/P4): progressive-depth update-in-place surface. `buildPathMapData`
  // IS part of the frozen integration surface alongside renderPathMapHtml --
  // extension.js calls it directly to build a {type:'update', data} postMessage
  // payload without a full HTML re-render (see its own header comment).
  // `preserveTransformOnUpdate` and `frontierMethodKey` are exported for
  // test-pathmap.js / dev tooling, same rationale as everything else in this
  // block.
  buildPathMapData,
  preserveTransformOnUpdate,
  frontierMethodKey,
};

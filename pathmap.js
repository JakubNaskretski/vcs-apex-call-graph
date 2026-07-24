'use strict';
// pathmap.js — renders a resolver.js TreeResult (the TNode/SiteView shape
// reproduced below and mirrored in uitree.js) as
// a single, fully self-contained HTML document: an interactive,
// left-to-right "execution path map" — the traced TARGET sits on the right,
// its callers fan out to the left, one hop (column) per depth level, like a
// timeline of how a call reaches the target.
//
// Pure data-in/string-out, CommonJS, zero new dependencies, no vscode
// import — so it can be exercised head-less by dev/pathmap-preview.js and
// unit-tested by test-pathmap.js without a running extension host. The
// extension.js hands the returned
// string straight to a vscode.WebviewPanel's `.webview.html` with
// `enableScripts: true`.
//
// Input data shape:
//
//   treeResult = { root: TNode, targetLabel, note, direction, stats }
//   TNode = {
//     label, kind: 'method'|'trigger'|'class'|'lwc'|'aura'|'flow'|
//       'omniscript'|'vf' (metadata-caller nodes from resolver.js's
//       attachMetaCallers/buildMetaChildren) | 'cmdt' (Custom
//       Metadata record, same family, always terminal today) | 'anonymous'
//       (anonymous-Apex-script (.apex) pseudo-type/method node --
//       Apex-source family like 'method'/'trigger'/'class', NOT part of the
//       metadata-caller family; always a pure root) | 'exception' (
//       forward-traced throw target, always terminal) | 'unresolved' (one
//       aggregated, always-terminal, always-approximate leaf per
//       method summarizing unresolved forward call sites) | 'external'
//       (a reference into managed-package code this workspace has no source
//       for.
//       Terminal in the callees direction; in callers direction its
//       children are the ordinary local caller subtree of every site that
//       references it -- no special-casing needed here either way, see
//       accentKind/shapeNodeForData below for its accent + 'managed: <ns>'
//       badge),
//     className, methodLower,
//     path, line, entries: [string], isTest,
//     package,  // string|null|undefined: the sfdx package label
//               // this node's file lives under -- see shapeNodeForData's
//               // targetPackage/packageBadge threading below, which turns
//               // it into a '(label)' badge ONLY when it differs from the
//               // traced target's own package (root.package).
//     ns,       // string|undefined: ONLY
//               // meaningful on a kind:'external' node -- its managed-
//               // package namespace, mirrored into the 'managed: <ns>'
//               // badge (see managedBadge/shapeNodeForData below).
//     via: string|null,  // ...|'metadata'|'dml'|'dynamic'|'override' (v0.4
//                         // adds the last three)|'publish'|'throws'|
//                         // 'narrowed'|'async'
//                         // four; only 'narrowed' is approximate)|
//                         // 'ambiguous' (duplicate-named-class
//                         // fan-out that neither same-package nor default-
//                         // package preference could resolve; approximate)|
//                         // 'external' (a
//                         // reference into managed-package code -- NOT
//                         // approximate, see uitree.js's matching TNode.via
//                         // doc for the rationale)
//                         // -- rendered verbatim as edge labels/node badges,
//                         // no code change needed here for a new via string
//                         // to show up correctly)
//     sites: [SiteView], children: [TNode],
//     cyclic, truncated, approximate,
//     caughtHere,  // boolean: an ancestor catch clause catches the
//                  // exception being traced AT THIS NODE. Always paired with
//                  // a matching entries badge text ('catches <ExcName>',
//                  // resolver.js's doing) -- this file additionally renders
//                  // a shield-glyph badge for it (see badgeGlyphs in
//                  // CLIENT_JS_TEXT). Traversal continues past a caughtHere
//                  // node, so it is purely an informational marker.
//     expandable,  // boolean: resolver marks a progressive-depth frontier
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
//     pendingCount,  // number|undefined: ONLY
//                    // meaningful alongside expandable:true -- see
//                    // uitree.js's matching field doc.
//     methodKey,     // string|undefined: ONLY
//                    // meaningful alongside expandable:true -- the
//                    // methodKeyLower identity the pill's click-to-expand
//                    // affordance posts back to the extension (see
//                    // frontierMethodKey below); optional, same
//                    // "explicit field wins, else derive from
//                    // className+methodLower" pattern as `ns`/
//                    // externalNamespace.
//   }
//
// treeResult.direction is 'callers'|'callees'|absent.
// resolver.js's buildCallerTree stamps 'callers' on EVERY TreeResult it
// returns, unconditionally -- so 'callers' is treated exactly like an
// absent field: both retain the legacy caller layout
// (unmirrored layout, no direction header/meta text -- see layoutTree/
// renderPathMapHtml below, both take the same non-mirrored branch and
// produce a null directionLabel). 'callees' -- the one genuinely NEW
// 'callees' mirrors the layout (target LEFT, callees fan
// out RIGHT -- see layoutTree) and shows an explicit 'What Does This Call?'
// header/meta label. See uitree.js's matching directionHeaderLine for the
// fuller interpretive-decision writeup (not duplicated here verbatim,
// consistent with this file's existing pattern of small independent
// re-implementations rather than a cross-file require).
//   SiteView = {
//     path, line, col, lineText, argsRendered: string|null, via,
//     overloadSig: string|null,  // overload selected for this site
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
// A 'flow' node's children can ALSO be its own
// subflow chain (via:'subflow', both directions — see resolver.js's own
// contract and this file's LEGEND_HTML "subflow" row), recursing arbitrarily
// deep and cycle-guarded (cyclic:true, zero children, same as any other
// cyclic node this file already renders). Same "walks `children` purely
// structurally" posture as the F1b note above — no code change was needed
// here for this either, only the legend text a human reads.
//
// v0.13: TNode.kind gains 'rollup' --
// UNLIKE every other kind above, resolver.js NEVER produces this one; it is
// synthesized ENTIRELY by this file's own groupApproximateChildren
// (see that function's header comment, ahead of layoutTree) as a pure
// rendering-layer regroup of a node's approximate children into one
// collapsed pill, per the apexCallGraph.showUnconfirmed setting. It carries
// via:null/approximate:false itself (the pill container isn't a guess, its
// members still are) and renders via a dedicated CSS rule (.node.kind-rollup)
// and CLIENT_JS_TEXT click-to-expand-in-place behavior, both documented at
// their own definitions.
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
  // Leave enough horizontal connector space for resolution labels such as
  // "static" and "typed" to sit clear of both adjoining cards. Edge labels
  // are centered on half of this gutter in either map direction.
  colWidth: 340,
  rowHeight: 116,
  nodeWidth: 248,
  nodeHeight: 84,
  marginX: 56,
  marginY: 72,
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
// Nodes use four base accent buckets: trigger/entry/test/normal. A node
// wears exactly one accent, so ties resolve trigger > entry > test > normal
// — a trigger or an explicit annotation entry point is a more specific,
// more load-bearing fact about a node than "this also happens to sit in a
// test class". isTest still gets its own visual treatment (dimmed + beaker
// badge, applied independently of accent — see buildNodeEl in the client
// script) even when a different accent wins.
//
// The 'metadata' bucket covers LWC/Aura/Flow/OmniScript/VF
// caller nodes resolver.js's attachMetaCallers/buildMetaChildren produce
// (TNode.kind one of 'lwc'|'aura'|'flow'|'omniscript'|'vf'). v0.4 (F4b)
// folds 'cmdt' (Custom Metadata record) into the same bucket — it is the
// same "caller lives outside Apex source" family, just a different kind tag.
// These nodes always carry a non-empty `entries` (their kind-specific
// label, e.g. '@salesforce/apex import' / 'Custom Metadata record' — see
// resolver.js's metaEntryLabel), so 'metadata' is
// checked ahead of 'entry' — otherwise every metadata node would
// collapse onto the same accent as an ordinary @AuraEnabled/@future/etc.
// entry-point node and lose its distinct color in the map.
const META_ACCENT_KINDS = new Set(['lwc', 'aura', 'flow', 'omniscript', 'vf', 'cmdt', 'permissionset', 'profile']);

// The 'anonymous' bucket covers TNode.kind==='anonymous' --
// an anonymous-Apex-script node. Deliberately NOT folded into 'metadata':
// unlike metadata kinds above, an anonymous script IS real Apex source
// (parser.js's anonymousUnit(), not metascan.js), it just has no declared
// class/trigger of its own. Checked right alongside 'trigger' (both are
// "the kind itself decides the accent" cases), ahead of 'entry'/'test' for
// the same reason 'metadata' is: an anonymous-script node always carries the
// 'Anonymous Apex script' entry label, so it would
// otherwise collapse onto the generic 'entry' accent and lose its distinct
// color.
// Two more "the kind alone decides the accent" buckets use the same
// priority tier as trigger/anonymous, ahead of entry/test -- an exception-
// class node or an aggregated unresolved-sites leaf could in principle
// carry entries (e.g. an exception class that is ALSO an inner class with
// its own annotation) and must not collapse onto the generic 'entry' accent
// and lose its distinct color.
// The 'external' bucket covers TNode.kind===
// 'external' -- see the module header's TNode.kind doc above. Same "the
// kind alone decides the accent" tier as trigger/anonymous/exception/
// unresolved, ahead of entry/test, for the identical reason: an external
// node could in principle carry entries and must not collapse onto the
// generic 'entry' accent and lose its distinct color.
function accentKind(node) {
  if (node.kind === 'trigger') return 'trigger';
  if (node.kind === 'anonymous') return 'anonymous';
  if (node.kind === 'exception') return 'exception';
  // buildCalleeTree
  // implementation -- the generic-typed-DML marker reuses kind:'unresolved'
  // verbatim (via 'dml-unresolved' is what distinguishes it; see
  // LEGEND_HTML below), so no separate kind/accent branch is needed here.
  if (node.kind === 'unresolved') return 'unresolved';
  if (node.kind === 'external') return 'external';
  // A synthetic rollup pseudo-node
  // (see groupApproximateChildren/ROLLUP_LABEL below) -- same "the kind
  // alone decides the accent" tier as every check above, ahead of entry/
  // test, since a rollup node never carries entries/isTest of its own but
  // must still get its own distinct visual treatment (a dashed pill, not a
  // rectangular accent-bar node -- see the .node.kind-rollup CSS rule).
  if (node.kind === 'rollup') return 'rollup';
  if (META_ACCENT_KINDS.has(node.kind)) return 'metadata';
  if (node.entries && node.entries.length) return 'entry';
  if (node.isTest) return 'test';
  return 'normal';
}

// ---- visual vocabulary ---------------------------------------------------
// `accentKind` is the long-standing compatibility bucket used by existing
// tests and consumers.  The Path Map needs a little more information than
// that one bucket can carry: Flow and LWC are both metadata, for example,
// but are much easier to scan when their cards say what they actually are.
// Keep the old accent intact and add a small, allow-listed visual vocabulary
// for the card's type chip and restrained color family.
function nodeVisual(node) {
  const t = node || {};
  const kind = String(t.kind || '').toLowerCase();
  const entries = Array.isArray(t.entries) ? t.entries.map((e) => String(e).toLowerCase()).join(' ') : '';

  if (kind === 'trigger') return { key: 'trigger', label: 'Trigger', tone: 'entry' };
  if (kind === 'lwc') return { key: 'lwc', label: 'LWC', tone: 'interface' };
  if (kind === 'aura') return { key: 'aura', label: 'Aura', tone: 'interface' };
  if (kind === 'flow') return { key: 'flow', label: 'Flow', tone: 'automation' };
  if (kind === 'omniscript') return { key: 'omniscript', label: 'OmniScript', tone: 'automation' };
  if (kind === 'vf') return { key: 'visualforce', label: 'Visualforce', tone: 'interface' };
  if (kind === 'cmdt') return { key: 'custom-metadata', label: 'Custom metadata', tone: 'data' };
  if (kind === 'permissionset') return { key: 'permission-set', label: 'Permission set', tone: 'data' };
  if (kind === 'profile') return { key: 'profile', label: 'Profile', tone: 'data' };
  if (kind === 'anonymous') return { key: 'anonymous', label: 'Anonymous Apex', tone: 'entry' };
  if (kind === 'exception') return { key: 'exception', label: 'Exception', tone: 'danger' };
  if (kind === 'unresolved') return { key: 'unresolved', label: 'Unresolved', tone: 'neutral' };
  if (kind === 'external') return { key: 'external', label: 'External', tone: 'external' };
  if (kind === 'rollup') return { key: 'possible', label: 'Possible', tone: 'approx' };

  if (entries.includes('@auraenabled')) return { key: 'aura-method', label: 'Aura / LWC', tone: 'interface' };
  if (entries.includes('@invocablemethod')) return { key: 'invocable', label: 'Invocable', tone: 'automation' };
  if (entries.includes('@future')) return { key: 'future', label: 'Future', tone: 'automation' };
  if (entries.includes('batchable')) return { key: 'batch', label: 'Batch', tone: 'automation' };
  if (entries.includes('queueable')) return { key: 'queueable', label: 'Queueable', tone: 'automation' };
  if (entries.includes('schedulable')) return { key: 'scheduled', label: 'Scheduled', tone: 'automation' };
  if (entries.includes('@restresource') || /@http(?:get|post|put|patch|delete)/.test(entries)) {
    return { key: 'rest', label: 'REST', tone: 'entry' };
  }
  if (entries.includes('webservice')) return { key: 'soap', label: 'SOAP', tone: 'entry' };
  if (entries.includes('anonymous apex')) return { key: 'anonymous', label: 'Anonymous Apex', tone: 'entry' };
  if (entries) return { key: 'entry', label: 'Entry point', tone: 'entry' };
  if (t.isTest) return { key: 'test-apex', label: 'Test Apex', tone: 'test' };
  if (kind === 'constructor') return { key: 'constructor', label: 'Constructor', tone: 'apex' };
  if (kind === 'class') return { key: 'apex-class', label: 'Apex class', tone: 'apex' };
  return { key: 'apex', label: 'Apex', tone: 'apex' };
}

function edgeTone(via, approximate) {
  if (approximate) return 'approx';
  const v = String(via || '').toLowerCase();
  if (v === 'metadata' || v === 'subflow') return 'automation';
  if (v === 'dml' || v === 'publish') return 'data';
  if (v === 'async') return 'automation';
  if (v === 'external') return 'external';
  if (v === 'throws') return 'danger';
  if (v === 'unresolved' || v === 'dml-unresolved') return 'neutral';
  return 'apex';
}

// Mirrors uitree.js's externalNamespace/
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

// Mirrors uitree.js's frontierMethodKey
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

// =========================================================================
// Approximate-edge rollup on the map.
// Mirrors uitree.js's identical section (same rationale for why this is a
// pure rendering-layer regroup, not a resolver.js change) as an independent
// implementation, same "standalone, dev-tool-friendly module" posture as
// every other small helper this file re-implements rather than requiring
// uitree.js for (see isRootNode/packageBadge/frontierMethodKey above).
//
// UNLIKE uitree.js's shapeNode (which regroups already-shaped UiNode
// children), this operates on the RAW TNode tree, BEFORE layoutTree ever
// sees it -- groupApproximateChildren returns a brand-new TNode tree (never
// mutates its input) with a synthetic `kind:'rollup'` pseudo-node spliced in
// wherever a node had approximate children to group. layoutTree/
// shapeNodeForData/shapeEdgeForData then walk this ALREADY-TRANSFORMED tree
// with ZERO further code changes -- they already walk `children` purely
// structurally (see layoutTree's own header comment), so a rollup
// pseudo-node lays out, and shapes into the JSON node/edge arrays, exactly
// like any other node. Only accentKind (above) and the client-side pill
// rendering (CLIENT_JS_TEXT, see the ROLLUP PILL section there) need to know
// kind:'rollup' exists at all.
//
// Same three modes as uitree.js (SHOW_UNCONFIRMED_ROLLUP/_HIDE/_EXPAND
// below), same 'expand' default-when-omitted/unrecognized for identical
// regression-safety reasons -- see normalizeShowUnconfirmed's doc.
const SHOW_UNCONFIRMED_ROLLUP = 'rollup';
const SHOW_UNCONFIRMED_HIDE = 'hide';
const SHOW_UNCONFIRMED_EXPAND = 'expand';
const SHOW_UNCONFIRMED_VALUES = new Set([SHOW_UNCONFIRMED_ROLLUP, SHOW_UNCONFIRMED_HIDE, SHOW_UNCONFIRMED_EXPAND]);
function normalizeShowUnconfirmed(value) {
  return SHOW_UNCONFIRMED_VALUES.has(value) ? value : SHOW_UNCONFIRMED_EXPAND;
}

// Mirrors uitree.js's rollupNoun/rollupLabel exactly -- see that file's
// comments for the singular/plural rationale.
function rollupNoun(direction, count) {
  const plural = direction === 'callees' ? 'callees' : 'callers';
  return count === 1 ? plural.slice(0, -1) : plural;
}
function rollupLabel(count, direction) {
  return `${count} possible ${rollupNoun(direction, count)} (unconfirmed)`;
}

// The one synthetic rollup TNode shape -- degrades safely through the
// EXISTING shapeNodeForData (below) with no special-casing there beyond
// accentKind's new branch: every field that function reads is present here
// with a safe, inert value (null path/line/className, empty entries/sites,
// approximate:false -- the pill CONTAINER isn't itself an approximate
// GUESS, its MEMBERS still carry their own true approximate:true, preserved
// unchanged by this transform).
function makeRollupTNode(approxChildren, direction) {
  return {
    label: rollupLabel(approxChildren.length, direction),
    kind: 'rollup',
    className: '',
    methodLower: null,
    path: null,
    line: null,
    entries: [],
    isTest: false,
    via: null,
    sites: [],
    children: approxChildren,
    cyclic: false,
    truncated: false,
    approximate: false,
    caughtHere: false,
    seenElsewhere: false,
    expandable: false,
    pendingCount: null,
    methodKey: null,
    package: null,
  };
}

// Pure, recursive, non-mutating TNode -> TNode transform: partitions
// `tnode.children` into confirmed/approximate (by each child's OWN
// `approximate` flag, exactly the field resolver.js already stamps per the
// contract), then per `mode`:
//   'expand' -- every child kept in its original order, none dropped/
//               regrouped -- the legacy flat shape. Still recurses
//               (producing a full deep clone with identical structure/order/
//               field values throughout, since a single `mode` applies to
//               the whole call) rather than short-circuiting to `tnode`
//               itself, so this stays a genuine identity-shaped TRANSFORM
//               (easy to reason about/test) rather than a special early
//               return -- layoutTree only ever reads the result, never the
//               original `tnode`, so the extra clone has no observable cost
//               beyond this one pass over the tree.
//   'hide'  -- drops approximate children (and their entire subtrees)
//               entirely; confirmed children are kept, recursively
//               transformed the same way.
//   'rollup'-- confirmed children kept (recursively transformed, in their
//               original relative order); if there is at least one
//               approximate child, ONE makeRollupTNode is appended as the
//               last child, its own `children` being the (recursively
//               transformed) approximate children.
function groupApproximateChildren(tnode, mode, direction) {
  if (!tnode) return tnode;
  const rawChildren = Array.isArray(tnode.children) ? tnode.children : [];
  const recurse = (child) => groupApproximateChildren(child, mode, direction);
  let newChildren;
  if (mode === SHOW_UNCONFIRMED_EXPAND) {
    newChildren = rawChildren.map(recurse);
  } else {
    const confirmed = [];
    const approx = [];
    for (const child of rawChildren) {
      (child && child.approximate ? approx : confirmed).push(child);
    }
    newChildren = confirmed.map(recurse);
    if (mode === SHOW_UNCONFIRMED_ROLLUP && approx.length) {
      newChildren = newChildren.concat([makeRollupTNode(approx.map(recurse), direction)]);
    }
    // mode === SHOW_UNCONFIRMED_HIDE: approx children simply omitted.
  }
  return Object.assign({}, tnode, { children: newChildren });
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
// further from it moves one column left.
//
// When `direction === 'callees'` the column order MIRRORS -- the
// target (depth 0) becomes the LEFTMOST column and each hop further (each
// forward call) moves one column right: target left, callees flowing right.
// This is a pure column-
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

// Explicit 'root' badge -- see uitree.js's isRootNode, mirrored
// here rather than shared via require so pathmap.js stays a standalone,
// dev-tool-friendly module (see this file's header note). No known caller
// in THIS trace (childless), and not cyclic/truncated/seenElsewhere -- all
// three of those mean "there IS more above, just not shown/expanded here".
//
// `expandable` joins the exclusion list, same
// rationale/regression-safety as uitree.js's matching isRootNode update --
// `t.expandable` is undefined on every pre-v0.9 fixture, so `!undefined` is
// `true` and this is a no-op there.
function isRootNode(t) {
  if (!t) return false;
  const hasChildren = !!(t.children && t.children.length);
  return !hasChildren && !t.cyclic && !t.truncated && !t.seenElsewhere && !t.expandable;
}

// The node's package badge text, or null when none applies --
// mirrors uitree.js's packageBadge exactly (see that file's comment for the
// full rationale), kept as an independent small implementation here rather
// than a cross-file require, same rationale as isRootNode above.
function packageBadge(node, targetPackage) {
  if (!node || !node.package) return null;
  if (node.package === targetPackage) return null;
  return '(' + node.package + ')';
}

// `targetPackage` is an OPTIONAL second argument -- the traced
// target's own `.package` (computed once in renderPathMapHtml from the tree
// root and threaded through every node). Every EXISTING call site that
// invokes `shapeNodeForData(rec)` with just one argument keeps behaving
// exactly as before: `targetPackage` is undefined, so packageBadge() below
// returns null for every node unless that node happens to carry a
// `.package` of its own (no pre-v0.7 fixture does).
function shapeNodeForData(rec, targetPackage) {
  const t = rec.tnode || {};
  const visual = nodeVisual(t);
  const badges = (t.entries || []).map(shortenEntry);
    // The 'managed: <ns>' badge for an external
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
    depth: rec.depth,
    x: rec.x,
    y: rec.y,
    label: t.label != null ? String(t.label) : '',
    kind: t.kind || 'class',
    accent: accentKind(t),
    typeKey: visual.key,
    typeLabel: visual.label,
    tone: visual.tone,
    target: rec.parentId == null,
    badges: badges,
    isTest: !!t.isTest,
    approximate: !!t.approximate,
    cyclic: !!t.cyclic,
    truncated: !!t.truncated,
    caughtHere: !!t.caughtHere,
    // `seenElsewhere` is preserved for renderers that support it; see
    // uitree.js's matching field documentation.
    seenElsewhere: !!t.seenElsewhere,
    root: isRootNode(t),
    via: t.via || null,
    path: t.path || null,
    line: typeof t.line === 'number' ? t.line : null,
    className: t.className || '',
    methodLower: t.methodLower || null,
    // The raw package label (or null) is not itself rendered as
    // a badge client-side (the badge string, if any, is already present in
    // `badges` above); exposed so dev tooling / future callers can inspect
    // it without re-deriving from `entries`.
    package: t.package || null,
    // The resolved external namespace (or
    // null) -- same "raw value exposed alongside its derived badge" pattern
    // as `package` immediately above; the badge string itself, if any,
    // already present in `badges` above.
    ns: externalNamespace(t),
    sites: (t.sites || []).map(shapeSiteForData),
    // Frontier state is NOT folded into `badges` above (unlike
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
    tone: edgeTone(t.via, !!t.approximate),
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
    --pm-apex: var(--vscode-charts-blue, #4fa3ff);
    --pm-entry-hue: var(--vscode-charts-red, #ff7a68);
    --pm-automation: var(--vscode-charts-purple, #b692f6);
    --pm-interface: var(--vscode-charts-cyan, #40c4d8);
    --pm-data: var(--vscode-charts-yellow, #e2a73b);
    --pm-danger: var(--vscode-errorForeground, #f14c4c);
    --pm-trigger: var(--pm-entry-hue);
    --pm-entry: var(--pm-entry-hue);
    --pm-test: var(--vscode-charts-green, #89d185);
    --pm-approx: var(--vscode-charts-orange, #d18616);
    --pm-normal: var(--vscode-descriptionForeground, #9d9d9d);
    --pm-metadata: var(--pm-automation);
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
    --pm-apex-soft: rgba(79, 163, 255, .11);
    --pm-entry-soft: rgba(255, 122, 104, .11);
    --pm-automation-soft: rgba(182, 146, 246, .12);
    --pm-interface-soft: rgba(64, 196, 216, .11);
    --pm-data-soft: rgba(226, 167, 59, .12);
    --pm-external-soft: rgba(41, 182, 246, .11);
    --pm-test-soft: rgba(137, 209, 133, .11);
    --pm-danger-soft: rgba(241, 76, 76, .11);
    --pm-neutral-soft: rgba(157, 157, 157, .08);
    --pm-lane: rgba(127, 127, 127, .035);
    --pm-lane-target: rgba(79, 163, 255, .055);
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

  #pm-workspace { flex: 1 1 auto; min-height: 0; display: flex; }
  #pm-sidebar {
    flex: 0 0 360px; min-width: 280px; max-width: 420px; display: flex;
    flex-direction: column; min-height: 0; border-left: 1px solid var(--pm-border);
    background: var(--pm-node-bg);
  }

  #pm-legend {
    flex: 0 0 auto; max-height: 46%; overflow: auto; padding: 2px 12px;
    background: var(--pm-node-bg); border-bottom: 1px solid var(--pm-border);
  }
  #pm-legend summary { cursor: pointer; font-weight: 600; padding: 6px 0; list-style: none; }
  #pm-legend summary::-webkit-details-marker { display: none; }
  #pm-legend summary::before { content: '▸ '; }
  #pm-legend[open] summary::before { content: '▾ '; }
  #pm-legend h4 { margin: 8px 0 4px; font-size: 11px; text-transform: uppercase; color: var(--pm-muted); }
  #pm-legend .legend-row { display: flex; align-items: flex-start; gap: 6px; margin: 3px 0; font-size: 12px; line-height: 1.35; }
  #pm-legend .legend-row .k { flex: 0 0 auto; font-weight: 600; min-width: 78px; margin-right: 5px; }
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
  .line-swatch { width: 24px; height: 0; margin-top: 8px; border-top: 2px solid; display: inline-block; flex: 0 0 auto; }
  .line-swatch.apex { color: var(--pm-apex); }
  .line-swatch.automation { color: var(--pm-automation); }
  .line-swatch.data { color: var(--pm-data); }
  .line-swatch.external { color: var(--pm-external); }
  .line-swatch.danger { color: var(--pm-danger); }
  .line-swatch.approx { color: var(--pm-approx); border-top-style: dashed; }

  #pm-class-context {
    flex: 0 0 auto; max-height: 156px; overflow: auto; padding: 9px 12px 10px;
    border-bottom: 1px solid var(--pm-border);
    background: linear-gradient(105deg, var(--pm-apex-soft), transparent 72%), var(--pm-node-bg);
  }
  #pm-class-context[hidden] { display: none; }
  .class-context-eyebrow {
    color: var(--pm-muted); font-family: var(--vscode-editor-font-family, monospace);
    font-size: 9px; font-weight: 700; letter-spacing: .06em; text-transform: uppercase;
  }
  .class-context-title {
    margin-top: 2px; font-size: 12px; font-weight: 650; overflow: hidden;
    text-overflow: ellipsis; white-space: nowrap;
  }
  .class-context-methods { display: grid; gap: 3px; margin-top: 7px; }
  .class-context-method {
    display: flex; align-items: center; gap: 8px; width: 100%; min-width: 0;
    padding: 4px 7px; border: 1px solid transparent; border-radius: 5px;
    background: transparent; color: var(--pm-fg); cursor: pointer;
    font: inherit; font-size: 11px; text-align: left;
  }
  .class-context-method:hover { background: var(--pm-bg); border-color: var(--pm-border); }
  .class-context-method:focus-visible { outline: 2px solid var(--pm-link); outline-offset: -2px; }
  .class-context-method.is-current {
    border-color: var(--pm-link); background: var(--pm-apex-soft);
  }
  .class-context-method .method-name {
    flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis;
    white-space: nowrap; font-family: var(--vscode-editor-font-family, monospace);
  }
  .class-context-method .method-hop {
    flex: 0 0 auto; color: var(--pm-muted); font-size: 9px;
    font-family: var(--vscode-editor-font-family, monospace); text-transform: uppercase;
  }

  #pm-viewport { flex: 1 1 auto; min-width: 0; position: relative; overflow: hidden; cursor: grab; }
  #pm-viewport.dragging { cursor: grabbing; }
  #pm-canvas { position: absolute; top: 0; left: 0; transform-origin: 0 0; }
  #pm-lanes, #pm-edges, #pm-nodes { position: absolute; top: 0; left: 0; }
  #pm-lanes { pointer-events: none; }
  #pm-edges { position: absolute; top: 0; left: 0; overflow: visible; }
  #pm-nodes { position: absolute; top: 0; left: 0; }

  .depth-lane {
    position: absolute; top: 0; border-left: 1px solid rgba(127,127,127,.09);
    border-right: 1px solid rgba(127,127,127,.09); background: var(--pm-lane);
  }
  .depth-lane.is-target { background: var(--pm-lane-target); border-color: rgba(79,163,255,.2); }
  .depth-label {
    position: absolute; top: 18px; left: 12px; color: var(--pm-muted);
    font-family: var(--vscode-editor-font-family, monospace); font-size: 10px;
    font-weight: 700; letter-spacing: .08em; text-transform: uppercase;
  }
  .depth-lane.is-target .depth-label { color: var(--pm-link); }

  #pm-controls {
    position: absolute; right: 14px; bottom: 14px; z-index: 8; display: flex;
    overflow: hidden; border: 1px solid var(--pm-border); border-radius: 8px;
    background: var(--pm-node-bg); box-shadow: 0 3px 12px rgba(0,0,0,.18);
  }
  #pm-controls button {
    min-width: 30px; height: 28px; border: 0; border-right: 1px solid var(--pm-border);
    padding: 0 8px; background: transparent; color: var(--pm-fg); cursor: pointer;
    font: inherit;
  }
  #pm-controls button:last-child { border-right: 0; }
  #pm-controls button:hover { background: var(--pm-apex-soft); }
  #pm-controls button:focus-visible { outline: 2px solid var(--pm-link); outline-offset: -2px; }
  #pm-controls button.is-primary { color: var(--pm-link); font-weight: 600; min-width: 116px; }
  #pm-controls button:disabled { color: var(--pm-muted); cursor: default; opacity: .68; }
  #pm-controls button:disabled:hover { background: transparent; }

  .node {
    --node-accent: var(--pm-normal); --node-soft: var(--pm-neutral-soft);
    position: absolute; border-radius: 9px; border: 1px solid var(--pm-border);
    border-left: 4px solid var(--node-accent);
    background: linear-gradient(105deg, var(--node-soft), transparent 58%), var(--pm-node-bg);
    padding: 7px 10px 8px; overflow: hidden; cursor: pointer;
    box-shadow: 0 2px 5px rgba(0,0,0,.14);
  }
  .node:hover { border-color: var(--node-accent); box-shadow: 0 3px 9px rgba(0,0,0,.22); }
  .node:focus-visible { outline: 2px solid var(--pm-link); outline-offset: 3px; }
  .node.kind-trigger { --node-accent: var(--pm-trigger); --node-soft: var(--pm-entry-soft); }
  .node.kind-entry { --node-accent: var(--pm-entry); --node-soft: var(--pm-entry-soft); }
  .node.kind-test { --node-accent: var(--pm-test); --node-soft: var(--pm-test-soft); }
  .node.kind-normal { --node-accent: var(--pm-normal); --node-soft: var(--pm-neutral-soft); }
  .node.kind-metadata { --node-accent: var(--pm-metadata); --node-soft: var(--pm-automation-soft); }
  .node.kind-anonymous { --node-accent: var(--pm-anonymous); --node-soft: var(--pm-data-soft); }
  .node.kind-exception { --node-accent: var(--pm-exception); --node-soft: var(--pm-danger-soft); }
  .node.kind-unresolved { --node-accent: var(--pm-unresolved); --node-soft: var(--pm-neutral-soft); }
  .node.kind-external { --node-accent: var(--pm-external); --node-soft: var(--pm-external-soft); }
  .node.tone-apex { --node-accent: var(--pm-apex); --node-soft: var(--pm-apex-soft); }
  .node.tone-entry { --node-accent: var(--pm-entry-hue); --node-soft: var(--pm-entry-soft); }
  .node.tone-automation { --node-accent: var(--pm-automation); --node-soft: var(--pm-automation-soft); }
  .node.tone-interface { --node-accent: var(--pm-interface); --node-soft: var(--pm-interface-soft); }
  .node.tone-data { --node-accent: var(--pm-data); --node-soft: var(--pm-data-soft); }
  .node.tone-external { --node-accent: var(--pm-external); --node-soft: var(--pm-external-soft); }
  .node.tone-test { --node-accent: var(--pm-test); --node-soft: var(--pm-test-soft); }
  .node.tone-danger { --node-accent: var(--pm-danger); --node-soft: var(--pm-danger-soft); }
  .node.tone-neutral { --node-accent: var(--pm-unresolved); --node-soft: var(--pm-neutral-soft); }
  .node.tone-approx { --node-accent: var(--pm-approx); --node-soft: var(--pm-data-soft); }
  .node.is-target {
    border-width: 2px; border-left-width: 5px;
    box-shadow: 0 0 0 3px var(--pm-apex-soft), 0 4px 12px rgba(0,0,0,.2);
  }
  .node.is-test { opacity: .78; }
  .node.is-approx { border-style: dashed; border-color: var(--pm-approx); }
  /* The rollup pseudo-node --
     rendered as a dashed, fully-rounded PILL (no left accent bar, centered
     text) instead of the ordinary rectangular node shape, so it visually
     reads as "a grouped placeholder", not one more caller/callee. Reuses
     --pm-approx (the same color the individual approximate members'
     dashed borders/edges already use) rather than a brand-new accent
     variable -- thematically this pill IS "the approximate stuff, grouped". */
  .node.kind-rollup {
    border-left: none; border-style: dashed; border-color: var(--pm-approx);
    border-radius: 999px; text-align: center; display: flex; align-items: center; justify-content: center;
  }
  .node.kind-rollup .node-label { -webkit-line-clamp: 3; }
  /* A node/edge beneath a collapsed rollup pill --
     see CLIENT_JS_TEXT's isHiddenByCollapsedRollup/renderGraph, which never
     even creates these DOM elements while collapsed; this class exists only
     as a defensive belt-and-suspenders rule (never actually relied on to
     hide anything, since renderGraph skips creating them in the first
     place) documenting the invariant for a future reader. */
  .hidden-by-rollup { display: none; }

  .node-meta { display: flex; align-items: center; gap: 6px; margin-bottom: 4px; min-height: 14px; }
  .node-type, .node-role {
    font-family: var(--vscode-editor-font-family, monospace); font-size: 9px; line-height: 1.45;
    font-weight: 700; letter-spacing: .05em; text-transform: uppercase; white-space: nowrap;
  }
  .node-type {
    max-width: 150px; overflow: hidden; text-overflow: ellipsis; padding: 0 5px;
    border: 1px solid var(--node-accent); border-radius: 4px; color: var(--node-accent);
    background: var(--node-soft);
  }
  .node-role { margin-left: auto; color: var(--pm-link); }

  .node-label {
    font-size: 12px; font-weight: 600; line-height: 1.25; overflow: hidden; text-overflow: ellipsis;
    display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical;
    /* Long-name layout hardening: a real-org render bug
       report showed nodes with very long, SPACE-FREE identifiers (Apex
       class/method names routinely run 60+ characters, e.g.
       'SomeVeryLongClassName.someVeryLongMethodName' has no whitespace at
       all to wrap on) rendering as bare, unboxed-looking text spilling past
       the node -- text-overflow:ellipsis + -webkit-line-clamp above only
       reliably clip at natural word-wrap points; a single unbreakable token
       longer than the node's fixed width needs an explicit permission to
       break MID-WORD to actually get clipped+ellipsized inside the box
       rather than overflowing it. overflow-wrap:anywhere (modern, preferred)
       plus word-break:break-word (broad-compatibility fallback for engines
       that don't honor the former) both grant that permission; overflow:
       hidden on this element (kept) and on the parent .node (kept, see
       above) still do the actual clipping either way -- the FULL untruncated
       label always still reaches the DOM/tooltip (see buildNodeEl/
       showTooltip in CLIENT_JS_TEXT: labelEl.textContent and the tooltip
       title both always use the complete n.label, never a shortened copy),
       so hovering a visually-clipped node still shows its whole name. */
    overflow-wrap: anywhere; word-break: break-word;
  }
  .node-badges { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 4px; }
  .node.has-frontier .node-badges { padding-right: 74px; }
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
    position: absolute; right: 8px; bottom: 7px; display: inline-block; margin: 0;
    font-size: 10px; font-weight: 600; line-height: 1.6;
    padding: 0 7px; border-radius: 9px; background: var(--pm-link); color: var(--pm-node-bg);
    cursor: pointer; border: none; font-family: inherit;
  }
  .frontier-pill:hover { filter: brightness(1.15); }
  .frontier-pill:active { filter: brightness(0.9); }
  .frontier-pill:focus-visible { outline: 2px solid var(--pm-link); outline-offset: 2px; }

  .edge-path {
    fill: none; stroke: var(--pm-apex); color: var(--pm-apex); stroke-width: 1.7;
    stroke-linecap: round; stroke-linejoin: round; opacity: .78;
  }
  .edge-path.tone-automation { stroke: var(--pm-automation); color: var(--pm-automation); }
  .edge-path.tone-data { stroke: var(--pm-data); color: var(--pm-data); }
  .edge-path.tone-external { stroke: var(--pm-external); color: var(--pm-external); }
  .edge-path.tone-danger { stroke: var(--pm-danger); color: var(--pm-danger); }
  .edge-path.tone-neutral { stroke: var(--pm-unresolved); color: var(--pm-unresolved); }
  .edge-path.tone-approx, .edge-path.is-approx {
    stroke-dasharray: 5 4; stroke: var(--pm-approx); color: var(--pm-approx);
  }
  .edge-label {
    font-family: var(--vscode-editor-font-family, monospace); font-size: 9px; font-weight: 600;
    fill: var(--pm-muted); paint-order: stroke; stroke: var(--pm-bg); stroke-width: 4px;
    stroke-linejoin: round;
  }
  .arrow-head.tone-apex { fill: var(--pm-apex); }
  .arrow-head.tone-automation { fill: var(--pm-automation); }
  .arrow-head.tone-data { fill: var(--pm-data); }
  .arrow-head.tone-external { fill: var(--pm-external); }
  .arrow-head.tone-danger { fill: var(--pm-danger); }
  .arrow-head.tone-neutral { fill: var(--pm-unresolved); }
  .arrow-head.tone-approx { fill: var(--pm-approx); }

  .pm-tooltip {
    flex: 1 1 auto; min-height: 0; overflow: auto; background: var(--pm-node-bg);
    padding: 12px 14px; font-size: 12px;
  }
  .pm-tooltip .tt-eyebrow {
    margin-bottom: 5px; color: var(--pm-muted); font-family: var(--vscode-editor-font-family, monospace);
    font-size: 10px; font-weight: 700; letter-spacing: .06em; text-transform: uppercase;
  }
  .pm-tooltip .tt-title { font-weight: 650; font-size: 13px; margin-bottom: 8px; overflow-wrap: anywhere; }
  .pm-tooltip .tt-empty { color: var(--pm-muted); }
  .pm-tooltip .tt-site {
    display: block; width: 100%; margin: 0 0 4px; padding: 6px 7px; border: 0;
    border-radius: 5px; background: transparent; color: var(--pm-fg); cursor: pointer;
    font: inherit; text-align: left;
  }
  .pm-tooltip .tt-site:hover { background: var(--pm-bg); }
  .pm-tooltip .tt-site:focus-visible { outline: 2px solid var(--pm-link); outline-offset: -2px; }
  .pm-tooltip .tt-line {
    font-family: var(--vscode-editor-font-family, monospace); white-space: pre-wrap; word-break: break-all;
  }
  .pm-tooltip .tt-args { color: var(--pm-muted); margin-top: 2px; white-space: pre-wrap; word-break: break-all; }
  .pm-tooltip .tt-via { color: var(--pm-muted); font-size: 10px; margin-top: 2px; }

  @media (max-width: 900px) {
    #pm-workspace { flex-direction: column; }
    #pm-sidebar {
      flex: 0 0 190px; width: auto; max-width: none; min-width: 0;
      border-left: 0; border-top: 1px solid var(--pm-border);
    }
    #pm-legend { max-height: 90px; }
    #pm-class-context { max-height: 112px; }
  }
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

  // Posted by a frontier node's '+N' pill click (see buildNodeEl below):
  // {type:'expand', key}. n.expandKey is server-computed
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

  function requestExpandMany(nodes) {
    var keys = [];
    var seen = {};
    (nodes || []).forEach(function (n) {
      if (!n || !n.expandKey || seen[n.expandKey]) return;
      seen[n.expandKey] = true;
      keys.push(n.expandKey);
    });
    if (!keys.length) return;
    var msg = { type: 'expandMany', keys: keys };
    if (vscodeApi) {
      vscodeApi.postMessage(msg);
    } else {
      console.log('[apex-trace pathmap] expand many', msg);
    }
  }

  function clearChildren(el) {
    while (el.firstChild) el.removeChild(el.firstChild);
  }

  var header = document.getElementById('pm-title');
  var directionEl = document.getElementById('pm-direction');
  var stats = document.getElementById('pm-stats');
  var noteEl = document.getElementById('pm-note');

  // Header-rendering logic, factored into its own named
  // function so the {type:'update'} handler (applyUpdate, near the bottom
  // of this script) can reuse it VERBATIM instead of a second, driftable
  // copy -- called once below for the initial render, exactly reproducing
  // this file's pre-v0.9 top-level statement order/behavior.
  function renderHeader() {
    header.textContent = DATA.meta.targetLabel || '(no target)';
    // Direction sign-post -- left EMPTY for callers
    // render byte-for-byte) whenever directionLabel is null, i.e. absent/
    // undirected TreeResults; see directionHeaderLine's interpretive-decision
    // comment for why that specific case must stay exactly "today".
    if (DATA.meta.directionLabel) {
      directionEl.textContent = DATA.meta.directionLabel;
    } else {
      directionEl.textContent = '';
    }
    stats.textContent = DATA.meta.nodeCount + ' node' + (DATA.meta.nodeCount === 1 ? '' : 's') +
      ', ' + DATA.meta.edgeCount + ' edge' + (DATA.meta.edgeCount === 1 ? '' : 's');
    if (DATA.meta.note) {
      noteEl.textContent = DATA.meta.note;
    } else {
      noteEl.textContent = '';
    }
    // Additional header
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

  var lanesLayer = document.getElementById('pm-lanes');
  var nodesLayer = document.getElementById('pm-nodes');
  var edgesSvg = document.getElementById('pm-edges');
  var canvas = document.getElementById('pm-canvas');
  var viewport = document.getElementById('pm-viewport');
  var tooltip = document.getElementById('pm-tooltip');
  var classContext = document.getElementById('pm-class-context');
  var controls = document.getElementById('pm-controls');
  var expandVisibleButton = document.getElementById('pm-expand-visible');
  var zoomOutButton = document.getElementById('pm-zoom-out');
  var fitButton = document.getElementById('pm-fit');
  var zoomInButton = document.getElementById('pm-zoom-in');

  var W = DATA.layout.width;
  var H = DATA.layout.height;
  var NW = DATA.layout.nodeWidth;
  var NH = DATA.layout.nodeHeight;

  canvas.style.width = W + 'px';
  canvas.style.height = H + 'px';
  lanesLayer.style.width = W + 'px';
  lanesLayer.style.height = H + 'px';
  edgesSvg.setAttribute('width', String(W));
  edgesSvg.setAttribute('height', String(H));

  var nodeById = {};
  var classPeersByName = Object.create(null);
  // Child id -> parent id, rebuilt
  // alongside nodeById every time DATA changes (initial render + every
  // applyUpdate) -- used by isHiddenByCollapsedRollup below to walk a
  // node's ancestor chain looking for a still-collapsed rollup pill.
  var parentByChild = {};
  function indexNodes() {
    nodeById = {};
    parentByChild = {};
    classPeersByName = Object.create(null);
    DATA.nodes.forEach(function (n) {
      nodeById[n.id] = n;
      var key = classContextKey(n);
      if (!key) return;
      if (!classPeersByName[key]) classPeersByName[key] = [];
      classPeersByName[key].push(n);
    });
    DATA.edges.forEach(function (e) { parentByChild[e.from] = e.to; });
  }
  indexNodes();

  // Rollup-pill expand/collapse
  // state -- a plain map of rollup-node-id -> true once the user has
  // clicked it open. Declared OUTSIDE renderGraph/applyUpdate (module-level
  // in this IIFE) so it PERSISTS across an applyUpdate call -- a rollup the
  // user already opened must stay open across a server-driven refresh
  // (e.g. a frontier '+N' click elsewhere growing the trace), never reset
  // out from under them. Starts empty: every rollup begins COLLAPSED, per
  // the tree-view collapsed-state behavior.
  var expandedRollups = {};

  // A node is hidden iff any ANCESTOR of it (never the node itself) is a
  // still-collapsed rollup pill -- walks the parent chain via parentByChild
  // built above. The rollup pill node ITSELF is always visible (it IS the
  // clickable placeholder); only what's BENEATH an unopened one is hidden.
  // Recurses past an OPENED rollup's own ancestors too, so nested rollups
  // (an approximate node that itself has a mixed confirmed/approximate
  // subtree, per groupApproximateChildren's recursion) hide/show correctly
  // at every level independently.
  function isHiddenByCollapsedRollup(nodeId) {
    var cur = parentByChild[nodeId];
    while (cur != null) {
      var parent = nodeById[cur];
      if (parent && parent.kind === 'rollup' && !expandedRollups[parent.id]) return true;
      cur = parentByChild[cur];
    }
    return false;
  }

  function classContextKey(n) {
    if (!n || !n.className || !n.methodLower) return null;
    if (n.methodLower === '(trigger)' || n.methodLower === '(anonymous)') return null;
    return String(n.className).toLowerCase();
  }

  function methodNameInClass(n) {
    var label = String((n && n.label) || '');
    var prefix = String((n && n.className) || '') + '.';
    return label.indexOf(prefix) === 0 ? label.slice(prefix.length) : label;
  }

  function visibleFrontierNodes() {
    return DATA.nodes.filter(function (n) {
      return n.expandable && n.expandKey && !isHiddenByCollapsedRollup(n.id);
    });
  }

  function refreshExpandControl() {
    var count = visibleFrontierNodes().length;
    expandVisibleButton.disabled = count === 0;
    expandVisibleButton.textContent = count === 0
      ? 'Fully expanded'
      : ('Expand visible (' + count + ')');
    expandVisibleButton.title = count === 0
      ? 'No visible frontier branches remain'
      : 'Expand all ' + count + ' visible frontier branch' + (count === 1 ? '' : 'es') +
        ' by the configured expansion step';
  }

  function renderLanes() {
    var byDepth = {};
    DATA.nodes.forEach(function (n) {
      if (byDepth[n.depth] == null) byDepth[n.depth] = n.x;
    });
    Object.keys(byDepth).map(Number).sort(function (a, b) { return byDepth[a] - byDepth[b]; }).forEach(function (depth) {
      var lane = document.createElement('div');
      lane.className = 'depth-lane' + (depth === 0 ? ' is-target' : '');
      lane.style.left = (byDepth[depth] - 16) + 'px';
      lane.style.width = (NW + 32) + 'px';
      lane.style.height = H + 'px';
      lane.setAttribute('aria-hidden', 'true');

      var label = document.createElement('span');
      label.className = 'depth-label';
      label.textContent = depth === 0 ? 'Target' : ('Hop ' + depth);
      lane.appendChild(label);
      lanesLayer.appendChild(lane);
    });
  }

  var SVG_NS = 'http://www.w3.org/2000/svg';

  function badgeGlyphs(n) {
    var out = n.badges.slice();
    // Shield glyph for caughtHere -- IN ADDITION to the
    // 'catches <ExcName>' text already present in n.badges (from
    // TNode.entries, shortened by shortenEntry server-side). Pushed first,
    // right after the entries-derived badges, mirroring uitree.js's order.
    if (n.caughtHere) out.push('\\uD83D\\uDEE1'); // shield glyph (U+1F6E1)
    if (n.isTest) out.push('\\uD83E\\uDDEA'); // test-tube glyph
    // 'root' glyph -- mirrors uitree.js's '◉ root' badge.
    if (n.root) out.push('\\u25C9'); // FISHEYE (U+25C9) -- root
    if (n.cyclic) out.push('\\u21BA'); // loop-arrow glyph
    if (n.truncated) out.push('\\u2026'); // ellipsis (capped -- depth cap or node-count cap)
    // seenElsewhere glyph.
    if (n.seenElsewhere) out.push('\\u21E2'); // dashed rightwards arrow (U+21E2)
    return out;
  }

  function buildNodeEl(n) {
    var isRollup = n.kind === 'rollup';
    var el = document.createElement('div');
    el.className = 'node kind-' + n.accent + ' type-' + n.typeKey + ' tone-' + n.tone +
      (n.target ? ' is-target' : '') + (n.isTest ? ' is-test' : '') + (n.approximate ? ' is-approx' : '') +
      (n.expandable ? ' has-frontier' : '');
    el.style.left = n.x + 'px';
    el.style.top = n.y + 'px';
    el.style.width = NW + 'px';
    el.style.height = NH + 'px';
    el.setAttribute('data-id', String(n.id));
    el.setAttribute('role', 'button');
    el.setAttribute('tabindex', '0');
    el.setAttribute('aria-label', n.typeLabel + ': ' + n.label + (n.target ? '. Traced target.' : '') +
      (n.approximate ? ' Approximate match.' : ''));
    el.title = n.label;

    if (!isRollup) {
      var metaRow = document.createElement('div');
      metaRow.className = 'node-meta';
      var typeEl = document.createElement('span');
      typeEl.className = 'node-type';
      typeEl.textContent = n.typeLabel;
      metaRow.appendChild(typeEl);
      if (n.target) {
        var roleEl = document.createElement('span');
        roleEl.className = 'node-role';
        roleEl.textContent = 'Target';
        metaRow.appendChild(roleEl);
      }
      el.appendChild(metaRow);
    }

    var labelEl = document.createElement('div');
    labelEl.className = 'node-label';
    // The rollup pill's own label
    // is prefixed with a disclosure triangle reflecting its CURRENT
    // expand/collapse state (▸ collapsed / ▾ expanded -- same glyph pair
    // the #pm-legend <details> element's own ::before rule already uses,
    // one consistent "there's more, click to reveal" visual vocabulary).
    // Every other node keeps its pre-existing '~' approximate prefix,
    // unchanged.
    labelEl.textContent = isRollup
      ? (expandedRollups[n.id] ? '\\u25BE ' : '\\u25B8 ') + n.label
      : (n.approximate ? '~' : '') + n.label;
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

    // The frontier '+N' pill -- a DISTINCT, clickable element
    // (see the .frontier-pill CSS rule) appended as its own row, separate
    // from the plain read-only .badge spans above. PILL-VS-BODY CLICK
    // SEPARATION: its own click listener calls ev.stopPropagation() FIRST,
    // so the click never bubbles up to el's own 'click' listener below
    // (which still jumps to source) -- clicking the pill posts {type:
    // 'expand', key}, clicking anywhere else on the node body still jumps.
    if (n.expandable) {
      var pill = document.createElement('button');
      pill.type = 'button';
      pill.className = 'frontier-pill';
      pill.textContent = 'Expand +' + (n.pendingCount == null ? '' : n.pendingCount);
      var pillNoun = DATA.meta.direction === 'callees' ? 'callees' : 'callers';
      var pillCount = n.pendingCount == null ? 'more' : String(n.pendingCount) + ' more';
      pill.title = pillCount + ' direct ' + pillNoun + ' \\u2014 click to expand';
      pill.setAttribute('aria-label', 'Expand ' + pillCount + ' direct ' + pillNoun + ' from ' + n.label);
      pill.addEventListener('click', function (ev) {
        ev.stopPropagation();
        requestExpand(n);
      });
      el.appendChild(pill);
    }

    el.addEventListener('mouseenter', function () { showTooltip(n); });
    el.addEventListener('focus', function () { showTooltip(n); });
    function activateNode() {
      if (dragMoved) return; // a pan gesture that ended over a node must not open it
      // A rollup pill has no
      // source location of its own (n.path is always null, see
      // makeRollupTNode in pathmap.js) -- clicking it toggles its
      // expand/collapse state instead of jumping anywhere. REUSES the
      // in-place update path verbatim: applyUpdate is the EXACT function
      // extension.js's server-driven {type:'update'} messages already call
      // (see the bottom of this script) -- calling it again here, locally,
      // with the SAME DATA reference (nothing server-side changed, only
      // this rollup's entry in the client-local expandedRollups map),
      // rebuilds nodesLayer/edgesSvg through renderGraph (which now sees
      // the flipped expandedRollups state via isHiddenByCollapsedRollup)
      // and reapplies the preserved pan/zoom -- no postMessage round trip
      // to the extension at all, since every node/edge this could reveal
      // is ALREADY present in DATA (resolver.js resolved the full tree up
      // front; H2 only changed how it's GROUPED for display).
      if (isRollup) {
        expandedRollups[n.id] = !expandedRollups[n.id];
        applyUpdate(DATA);
        return;
      }
      postOpen(n.path, n.line, 0);
    }
    el.addEventListener('click', activateNode);
    el.addEventListener('keydown', function (ev) {
      if (ev.key !== 'Enter' && ev.key !== ' ') return;
      ev.preventDefault();
      activateNode();
    });

    return el;
  }

  // 'to' is always the tree PARENT (edges are gathered child->
  // parent, see layoutTree/shapeEdgeForData -- this doesn't change with
  // direction) and 'from' is always the tree CHILD. In the default
  // (non-mirrored) layout the parent sits at a LARGER x than the child (the
  // target/depth-0 node is rightmost), so the curve is drawn child-right-
  // edge -> parent-left-edge, i.e. left-to-right, converging into the
  // target. When MIRRORED is true the parent instead
  // sits at the SMALLER x (target/depth-0 is leftmost, see layoutTree), so
  // leftNode/rightNode swap to keep the connector reading left-to-right
  // (parent's right edge -> child's left edge) instead of drawing
  // backwards.
  var MIRRORED = !!(DATA.layout && DATA.layout.mirrored);
  function edgePoints(from, to) {
    var leftNode = MIRRORED ? to : from;
    var rightNode = MIRRORED ? from : to;
    var x1 = leftNode.x + NW;
    var y1 = leftNode.y + NH / 2;
    var x2 = rightNode.x;
    var y2 = rightNode.y + NH / 2;
    var midX = (x1 + x2) / 2;
    return { x1: x1, y1: y1, x2: x2, y2: y2, midX: midX };
  }
  function edgePath(from, to) {
    var p = edgePoints(from, to);
    // Orthogonal elbow connectors expose the hierarchy at a glance: every
    // hop leaves a card horizontally, joins the branch rail, then enters
    // the next depth column horizontally again.
    return 'M ' + p.x1 + ' ' + p.y1 + ' H ' + p.midX + ' V ' + p.y2 + ' H ' + p.x2;
  }

  var EDGE_TONES = ['apex', 'automation', 'data', 'external', 'danger', 'neutral', 'approx'];
  function renderArrowMarkers() {
    var defs = document.createElementNS(SVG_NS, 'defs');
    EDGE_TONES.forEach(function (tone) {
      var marker = document.createElementNS(SVG_NS, 'marker');
      marker.setAttribute('id', 'pm-arrow-' + tone);
      marker.setAttribute('viewBox', '0 0 7 7');
      marker.setAttribute('refX', '6');
      marker.setAttribute('refY', '3.5');
      marker.setAttribute('markerWidth', '7');
      marker.setAttribute('markerHeight', '7');
      marker.setAttribute('orient', 'auto');
      var arrow = document.createElementNS(SVG_NS, 'path');
      arrow.setAttribute('d', 'M 0 0 L 7 3.5 L 0 7 z');
      arrow.setAttribute('class', 'arrow-head tone-' + tone);
      marker.appendChild(arrow);
      defs.appendChild(marker);
    });
    edgesSvg.appendChild(defs);
  }

  // The node+edge DOM construction, factored into its own
  // named function so the {type:'update'} handler (applyUpdate below) can
  // rebuild the map from a fresh data blob by calling the EXACT same code
  // the initial render already used, instead of a second, driftable copy.
  // Called once below for the initial render.
  function renderGraph() {
    renderLanes();
    renderArrowMarkers();
    DATA.nodes.forEach(function (n) {
      // A node beneath a
      // still-collapsed rollup pill is never even given a DOM element --
      // simplest possible "collapsed by default, expand in place" (no
      // separate hide/show pass needed later; re-calling renderGraph via
      // applyUpdate after a toggle naturally includes/excludes it).
      if (isHiddenByCollapsedRollup(n.id)) return;
      nodesLayer.appendChild(buildNodeEl(n));
    });

    DATA.edges.forEach(function (e) {
      var from = nodeById[e.from];
      var to = nodeById[e.to];
      if (!from || !to) return;
      // An edge is hidden whenever EITHER endpoint is -- the child-side
      // check alone would already cover every case reachable from a
      // collapsed rollup (its parent is never hidden, see
      // isHiddenByCollapsedRollup's own doc), but checking both is cheap
      // and correct regardless of which end a future edge shape might add.
      if (isHiddenByCollapsedRollup(e.from) || isHiddenByCollapsedRollup(e.to)) return;

      var path = document.createElementNS(SVG_NS, 'path');
      path.setAttribute('d', edgePath(from, to));
      path.setAttribute('class', 'edge-path tone-' + e.tone + (e.approximate ? ' is-approx' : ''));
      path.setAttribute('marker-end', 'url(#pm-arrow-' + e.tone + ')');
      edgesSvg.appendChild(path);

      if (e.via) {
        var text = document.createElementNS(SVG_NS, 'text');
        var points = edgePoints(from, to);
        // Put labels on the branch-specific horizontal segment, never on
        // the shared vertical rail. In callers mode each child owns the
        // left segment; in callees mode it owns the right segment.
        var labelX = MIRRORED ? (points.midX + points.x2) / 2 : (points.x1 + points.midX) / 2;
        var labelY = (MIRRORED ? points.y2 : points.y1) - 6;
        text.setAttribute('x', String(labelX));
        text.setAttribute('y', String(labelY));
        text.setAttribute('text-anchor', 'middle');
        text.setAttribute('class', 'edge-label tone-' + e.tone);
        text.textContent = e.via;
        edgesSvg.appendChild(text);
      }
    });
    refreshExpandControl();
  }
  renderGraph();

  // ---- details inspector: call sites for the hovered/focused node ---------
  // This is a dedicated sibling of the viewport, never a floating overlay.
  // It cannot obscure the card or branch being inspected, and the last
  // inspected node remains stable while the pointer moves into a source row.
  function renderInspectorEmpty() {
    renderClassContext(null);
    clearChildren(tooltip);
    var eyebrow = document.createElement('div');
    eyebrow.className = 'tt-eyebrow';
    eyebrow.textContent = 'Path details';
    tooltip.appendChild(eyebrow);
    var empty = document.createElement('div');
    empty.className = 'tt-empty';
    empty.textContent = 'Hover or focus a node to inspect its call sites. Select a source line to open it.';
    tooltip.appendChild(empty);
  }

  // Keep same-class context out of the graph itself: only methods that are
  // already visible in this map are collected, deduplicated by method
  // identity, and shown in a compact sidebar frame for the inspected node.
  function renderClassContext(current) {
    clearChildren(classContext);
    var classKey = classContextKey(current);
    if (!classKey) {
      classContext.hidden = true;
      return;
    }

    var unique = Object.create(null);
    (classPeersByName[classKey] || []).forEach(function (peer) {
      if (isHiddenByCollapsedRollup(peer.id)) return;
      var methodKey = String(peer.methodLower || peer.label).toLowerCase();
      var kept = unique[methodKey];
      if (!kept || peer.id === current.id || peer.depth < kept.depth) unique[methodKey] = peer;
    });
    var peers = Object.keys(unique).map(function (key) { return unique[key]; });
    if (peers.length < 2) {
      classContext.hidden = true;
      return;
    }
    peers.sort(function (a, b) {
      if (a.id === current.id) return -1;
      if (b.id === current.id) return 1;
      if (a.depth !== b.depth) return a.depth - b.depth;
      return methodNameInClass(a).localeCompare(methodNameInClass(b));
    });

    classContext.hidden = false;
    var eyebrow = document.createElement('div');
    eyebrow.className = 'class-context-eyebrow';
    eyebrow.textContent = 'Same class in this map';
    classContext.appendChild(eyebrow);

    var title = document.createElement('div');
    title.className = 'class-context-title';
    title.textContent = current.className;
    title.title = current.className;
    classContext.appendChild(title);

    var list = document.createElement('div');
    list.className = 'class-context-methods';
    peers.forEach(function (peer) {
      var button = document.createElement('button');
      button.type = 'button';
      button.className = 'class-context-method' + (peer.id === current.id ? ' is-current' : '');
      button.title = peer.label;
      if (peer.id === current.id) button.setAttribute('aria-current', 'true');

      var name = document.createElement('span');
      name.className = 'method-name';
      name.textContent = methodNameInClass(peer);
      button.appendChild(name);

      var hop = document.createElement('span');
      hop.className = 'method-hop';
      hop.textContent = peer.target ? 'Target' : ('Hop ' + peer.depth);
      button.appendChild(hop);

      button.addEventListener('click', function () { focusMapNode(peer); });
      list.appendChild(button);
    });
    classContext.appendChild(list);
  }

  // Combined '-> overloadSig · argsRendered' detail text, mirrors
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
    var row = document.createElement('button');
    row.type = 'button';
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

  // The rollup pill's inspector
  // details explain the grouping itself (mirrors uitree.js's ROLLUP_TOOLTIP
  // constant, condensed) rather than falling through to the generic
  // 'no call sites recorded' empty-state text below, which would be
  // confusing on a node that deliberately never carries sites of its own.
  var ROLLUP_TOOLTIP_TEXT =
    'Grouped for clarity: each of these was matched through approximate resolution (interface / unique-name / lexical / override / narrowed / dynamic / ambiguous) and may be wrong, or one of several candidates. Click the pill to expand/collapse.';

  function showTooltip(n) {
    renderClassContext(n);
    clearChildren(tooltip);

    var isRollup = n.kind === 'rollup';
    var eyebrow = document.createElement('div');
    eyebrow.className = 'tt-eyebrow';
    eyebrow.textContent = n.typeLabel + (n.approximate ? ' \u00B7 approximate' : '') + (n.target ? ' \u00B7 target' : '');
    tooltip.appendChild(eyebrow);
    var title = document.createElement('div');
    title.className = 'tt-title';
    title.textContent = isRollup ? n.label : (n.approximate ? '~' : '') + n.label;
    tooltip.appendChild(title);

    if (isRollup) {
      var rollupNote = document.createElement('div');
      rollupNote.className = 'tt-empty';
      rollupNote.textContent = ROLLUP_TOOLTIP_TEXT;
      tooltip.appendChild(rollupNote);
    } else if (!n.sites.length) {
      var empty = document.createElement('div');
      empty.className = 'tt-empty';
      empty.textContent = n.path ? (n.path + (n.line ? ':' + n.line : '')) : 'no call sites recorded';
      tooltip.appendChild(empty);
    } else {
      n.sites.forEach(function (s) { tooltip.appendChild(siteRow(s, n.path)); });
    }
  }
  renderInspectorEmpty();

  // ---- pan (drag background) + zoom (wheel, clamped) ----------------------
  var scale = 1;
  var panX = 24;
  var panY = 24;
  var MIN_SCALE = 0.2;
  var MAX_SCALE = 3;

  function applyTransform() {
    canvas.style.transform = 'translate(' + panX + 'px,' + panY + 'px) scale(' + scale + ')';
  }

  function focusMapNode(n) {
    if (!n || isHiddenByCollapsedRollup(n.id)) return;
    panX = (viewport.clientWidth || 800) / 2 - (n.x + NW / 2) * scale;
    panY = (viewport.clientHeight || 600) / 2 - (n.y + NH / 2) * scale;
    applyTransform();
    showTooltip(n);
    var card = nodesLayer.querySelector('[data-id="' + String(n.id) + '"]');
    if (card) {
      try {
        card.focus({ preventScroll: true });
      } catch (e) {
        card.focus();
      }
    }
  }

  function fitMap() {
    // Fit a large map into the viewport on first paint instead of opening
    // zoomed to a single corner; never zooms IN past 1:1 for small maps.
    var vw = viewport.clientWidth || 800;
    var vh = viewport.clientHeight || 600;
    var fit = Math.min(1, vw / W, vh / H);
    scale = Math.max(MIN_SCALE, fit);
    panX = 24;
    panY = Math.max(24, (vh - H * scale) / 2);
    applyTransform();
  }

  function zoomAround(factor, mouseX, mouseY) {
    var contentX = (mouseX - panX) / scale;
    var contentY = (mouseY - panY) / scale;
    scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale * factor));
    panX = mouseX - contentX * scale;
    panY = mouseY - contentY * scale;
    applyTransform();
  }

  function zoomFromCenter(factor) {
    zoomAround(factor, (viewport.clientWidth || 800) / 2, (viewport.clientHeight || 600) / 2);
  }

  fitMap();
  controls.addEventListener('mousedown', function (e) { e.stopPropagation(); });
  expandVisibleButton.addEventListener('click', function () {
    var frontiers = visibleFrontierNodes();
    if (!frontiers.length) return;
    expandVisibleButton.disabled = true;
    expandVisibleButton.textContent = 'Expanding\u2026';
    requestExpandMany(frontiers);
  });
  zoomOutButton.addEventListener('click', function () { zoomFromCenter(0.85); });
  fitButton.addEventListener('click', fitMap);
  zoomInButton.addEventListener('click', function () { zoomFromCenter(1.15); });

  var dragging = false;
  var dragMoved = false;
  var dragStartX = 0;
  var dragStartY = 0;
  var panStartX = 0;
  var panStartY = 0;

  viewport.addEventListener('mousedown', function (e) {
    if (e.button !== 0 || (e.target && e.target.closest && e.target.closest('#pm-controls'))) return;
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
    var factor = e.deltaY > 0 ? 0.9 : 1.1;
    zoomAround(factor, mouseX, mouseY);
  }, { passive: false });

  // ---- update-in-place: {type:'update', data} ------------------------------
  // Posted by extension.js after a frontier click grows the
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
    lanesLayer.style.width = W + 'px';
    lanesLayer.style.height = H + 'px';
    edgesSvg.setAttribute('width', String(W));
    edgesSvg.setAttribute('height', String(H));
    MIRRORED = !!(DATA.layout && DATA.layout.mirrored);

    indexNodes();

    // A lingering inspector selection could describe a node removed by the
    // expansion update. Reset it to the stable invitation state.
    renderInspectorEmpty();

    clearChildren(lanesLayer);
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
    <h4>Node cards</h4>
    <div class="legend-row"><span class="k">type chip</span>names the component directly (Apex, Trigger, Flow, LWC, Aura, Invocable, Visualforce, external, and others), so color is never the only cue</div>
    <div class="legend-row"><span class="k">Target lane</span>the traced class or method; hop lanes show tree depth away from it</div>
    <div class="legend-row"><span class="swatch trigger"></span><span><span class="k">trigger</span>trigger-file entry point</span></div>
    <div class="legend-row"><span class="swatch entry"></span><span><span class="k">entry</span>has an entry-point annotation (@AuraEnabled, @InvocableMethod, @future, @HttpX, webservice, Batchable, Queueable, Schedulable)</span></div>
    <div class="legend-row"><span class="swatch test"></span><span><span class="k">test</span>only reachable from test code</span></div>
    <div class="legend-row"><span class="swatch normal"></span><span><span class="k">normal</span>regular method or class</span></div>
    <div class="legend-row"><span class="swatch metadata"></span><span><span class="k">metadata</span>caller from LWC, Aura, Flow, OmniScript, VF, or Custom Metadata — not Apex source (a Flow node here may still have its own children, e.g. the DML sites on its object, or — v0.13 — its own subflow chain; a metadata node is not always a leaf). Permission Set/Profile access grants are authorization facts, not execution edges, and are shown only in the tree view.</span></div>
    <div class="legend-row"><span class="swatch anonymous"></span><span><span class="k">anonymous</span>anonymous Apex script (.apex) — real Apex source, but with no declared class/trigger of its own; always a pure root (nothing calls it)</span></div>
    <div class="legend-row"><span class="swatch exception"></span><span><span class="k">exception</span>(v0.7) a thrown exception's class, reached by tracing forward (What Does This Call?) through a "throw" statement — always terminal</span></div>
    <div class="legend-row"><span class="swatch unresolved"></span><span><span class="k">unresolved</span>(v0.7) one aggregated leaf per method, summarizing every forward call site that couldn't be resolved to an indexed target (dynamic/platform calls, e.g. HttpRequest/System.debug) — always terminal, approximate. Also covers a DML statement whose target couldn't be narrowed to a concrete SObject type (e.g. a generic List&lt;SObject&gt;) — labeled "DML on unresolved SObject type", no trigger/flow linkage possible</span></div>
    <div class="legend-row"><span class="swatch external"></span><span><span class="k">external</span>(v0.8) a reference into managed-package code this workspace has no source for — terminal when tracing What Does This Call?; a valid trace target with its own local-caller subtree when tracing Who Calls This</span></div>
    <div class="legend-row"><span class="k">&#x25B8;/&#x25BE; N possible ... (unconfirmed)</span>(v0.13) a ROLLUP pill — groups every DIRECT approximate caller/callee of the node above it into one collapsed placeholder (dashed border, same color as the "~" approximate marker below), so a handful of confirmed edges aren't buried under a wall of guesses. Click the pill to expand it in place (&#x25BE;) or collapse it again (&#x25B8;) — everything it contains was already resolved, so expanding never re-scans or re-fetches anything. Controlled by the apexCallGraph.showUnconfirmed setting ('rollup' default / 'hide' drops these entirely / 'expand' restores the old flat rendering)</div>
    <h4>Connection colors</h4>
    <div class="legend-row"><span class="line-swatch apex"></span><span><span class="k">Apex</span>typed, static, constructor, this/super, and other confirmed code calls</span></div>
    <div class="legend-row"><span class="line-swatch automation"></span><span><span class="k">Automation</span>Flow/metadata, subflow, and async transitions</span></div>
    <div class="legend-row"><span class="line-swatch data"></span><span><span class="k">Data/event</span>DML and platform-event publish transitions</span></div>
    <div class="legend-row"><span class="line-swatch external"></span><span><span class="k">External</span>managed-package boundary</span></div>
    <div class="legend-row"><span class="line-swatch danger"></span><span><span class="k">Exception</span>throw transition</span></div>
    <div class="legend-row"><span class="line-swatch approx"></span><span><span class="k">Possible</span>approximate match; always dashed</span></div>
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
    <div class="legend-row"><span class="k">What This Calls</span>(v0.7 A3, forward tracing — shown above as "What Does This Call?") the traced target sits on the LEFT instead; its callees fan out to the RIGHT, one hop per column — the column order and every tree connector mirror the default layout so both directions still read left-to-right</div>
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
    <div class="legend-row"><span class="k">subflow</span>(v0.13) a declared &lt;subflows&gt; reference between two Flow files, never an Apex call — NOT approximate, a declared reference. Who Calls This: the flow's own PARENT flow (the parent invokes it as a subflow), recursing up. What This Calls: the flow's own SUBFLOW (it invokes the child), recursing down into that subflow's own apex actions/further subflows. Cycle-guarded (&#x21BA; on repeat, never hangs)</div>
`;

// Mirrors uitree.js's directionHeaderLine exactly -- see that
// file's INTERPRETIVE DECISION comment for the full byte-identical-bar
// writeup (not duplicated here verbatim, consistent with this file's
// existing pattern of small independent re-implementations, same rationale
// as isRootNode/packageBadge above). resolver.js's buildCallerTree stamps
// `direction: 'callers'` on EVERY TreeResult unconditionally, so 'callers'
// (like an absent field) stays the silent, byte-identical-to-today case;
// only 'callees' (the genuinely new v0.7 capability) gets the explicit
// 'What Does This Call?' sign-post, mirroring apexTrace.traceCallees's
// command title verbatim from package.json.
function directionHeaderLine(direction) {
  if (direction === 'callees') return 'What Does This Call?';
  return null;
}

// Additional header lines beyond treeResult.note
// (which is rendered separately). Mirrors uitree.js's
// shapeHeaderLines, kept as an independent small implementation here rather
// than a cross-file require (see this file's header note on staying
// self-contained/dev-tool-friendly, same rationale as isRootNode above).
// Neither field existed on TreeResult when this comment was first written --
// both checks are defensive.
//
// resolver.js's buildCallerTree
// output nests unresolvedSites under stats (TreeResult.stats.unresolvedSites),
// not a top-level TreeResult.unresolvedSites field -- read from stats to
// match what resolver.js actually produces (uitree.js's shapeHeaderLines
// mirrors this same fix).
//
// Duplicate-names line prepended ahead of capped/unresolved,
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
//
// v0.13 removed stats.unresolvedSites,
// stats.externalRefs/externalNamespaces, and stats.metaUnresolved USED to
// each surface their own workspace-global line here (mirroring uitree.js's
// shapeHeaderLines, which this function has always mirrored) -- see that
// file's matching SCOPED HEADERS section for the full rationale (a
// per-trace header has no business reporting workspace-wide totals unrelated
// to the ONE method being traced; `stats` itself is unchanged, those fields
// simply move to being an H8 "Scan Stats" output-channel concern only).
// unresolvedMentionsHeaderLine below is the one new, genuinely SCOPED
// replacement, matching uitree.js's identical function.
function unresolvedMentionsTargetMethodName(treeResult) {
  const um = treeResult && treeResult.unresolvedMentions;
  if (um && typeof um.method === 'string' && um.method) return um.method;
  const label = (treeResult && treeResult.root && treeResult.root.label) || '';
  const dotIdx = label.lastIndexOf('.');
  return dotIdx >= 0 ? label.slice(dotIdx + 1) : label;
}
function unresolvedMentionsHeaderLine(treeResult) {
  if ((treeResult && treeResult.direction) === 'callees') return null;
  const um = treeResult && treeResult.unresolvedMentions;
  const count = um && typeof um.count === 'number' ? um.count : 0;
  if (count <= 0) return null;
  const method = unresolvedMentionsTargetMethodName(treeResult);
  const siteWord = count === 1 ? 'site' : 'sites';
  return `${count} unresolved ${siteWord} elsewhere mention ${method}( — potential unconfirmed callers`;
}
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
  const mentionsLine = unresolvedMentionsHeaderLine(treeResult);
  if (mentionsLine) lines.push(mentionsLine);
  return lines;
}

// The DATA blob (meta/layout/nodes/edges) renderPathMapHtml
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
// so the initial render keeps the same data shape.
//
// v0.13: `opts.showUnconfirmed` is an
// OPTIONAL second-argument field (same "an opts object, not a positional
// parameter" shape renderPathMapHtml's own `opts.legendOpen` already uses),
// threaded straight into groupApproximateChildren BEFORE layoutTree ever
// sees the tree -- see that function's own doc for the full three-mode
// contract. Omitted/unrecognized normalizes to 'expand', preserving the
// legacy flat shape for existing callers.
function buildPathMapData(treeResult, opts) {
  const options = opts || {};
  const mode = normalizeShowUnconfirmed(options.showUnconfirmed);
  const direction = treeResult && treeResult.direction;
  // Permission/profile grants are useful in the tree view but are not
  // execution edges. Remove them before laying out the Execution Path Map.
  const runtimeRoot = treeResult && treeResult.root
    ? Object.assign({}, treeResult.root, {
        children: (treeResult.root.children || []).filter((c) =>
          !c || (c.kind !== 'permissionset' && c.kind !== 'profile')
        ),
      })
    : null;
  const root = runtimeRoot ? groupApproximateChildren(runtimeRoot, mode, direction) : null;
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

  // The traced target is `root` regardless of direction (see
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
      // Both fields are additive-only and null whenever
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
      colWidth: LAYOUT.colWidth,
      marginX: LAYOUT.marginX,
      maxDepth: layout.maxDepth,
      // Read by CLIENT_JS_TEXT's edgePath to flip which side of
      // an edge is treated as visually-left vs visually-right; false for
      // every direction except 'callees' (see layoutTree's own comment).
      mirrored: !!layout.mirrored,
    },
    nodes: nodesOut,
    edges: edgesOut,
  };
}

// The "preserve pan/zoom on an in-place update" promise
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
// signature/behavior that is easy to diagnose, rather than a silent DOM
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
//   showUnconfirmed: 'rollup'|'hide'|'expand' — see
//               buildPathMapData's own doc; forwarded through unchanged.
function renderPathMapHtml(treeResult, opts) {
  const options = opts || {};
  const data = buildPathMapData(treeResult, options);

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
    '  <div id="pm-hint">hover or focus a node for details &middot; drag to pan &middot; scroll to zoom</div>\n' +
    '</header>\n' +
    '<div id="pm-workspace">\n' +
    '  <div id="pm-viewport">\n' +
    '    <div id="pm-controls" aria-label="Map controls">\n' +
    '      <button id="pm-expand-visible" class="is-primary" type="button" title="Expand every visible frontier branch by the configured expansion step">Expand visible</button>\n' +
    '      <button id="pm-zoom-out" type="button" title="Zoom out" aria-label="Zoom out">&minus;</button>\n' +
    '      <button id="pm-fit" type="button" title="Fit tree to view">Fit</button>\n' +
    '      <button id="pm-zoom-in" type="button" title="Zoom in" aria-label="Zoom in">+</button>\n' +
    '    </div>\n' +
    '    <div id="pm-canvas">\n' +
    '      <div id="pm-lanes"></div>\n' +
    '      <svg id="pm-edges"></svg>\n' +
    '      <div id="pm-nodes"></div>\n' +
    '    </div>\n' +
    '  </div>\n' +
    '  <aside id="pm-sidebar" aria-label="Path details">\n' +
    '    <details id="pm-legend"' + legendOpenAttr + '>' + LEGEND_HTML + '</details>\n' +
    '    <section id="pm-class-context" aria-label="Same-class methods" hidden></section>\n' +
    '    <section id="pm-tooltip" class="pm-tooltip" aria-live="polite"></section>\n' +
    '  </aside>\n' +
    '</div>\n' +
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
  // exported for test-pathmap.js / dev tooling; not part of the runtime
  // integration surface (only renderPathMapHtml is).
  shortenEntry,
  accentKind,
  nodeVisual,
  edgeTone,
  layoutTree,
  isRootNode,
  packageBadge,
  // External-node badge helpers, exported so test-pathmap.js
  // can unit-test them directly, same rationale as packageBadge/isRootNode.
  externalNamespace,
  managedBadge,
  directionHeaderLine,
  headerExtraLinesForResult,
  // Progressive-depth update-in-place surface. `buildPathMapData`
  // is part of the integration surface alongside renderPathMapHtml --
  // extension.js calls it directly to build a {type:'update', data} postMessage
  // payload without a full HTML re-render (see its own header comment).
  // `preserveTransformOnUpdate` and `frontierMethodKey` are exported for
  // test-pathmap.js / dev tooling, same rationale as everything else in this
  // block.
  buildPathMapData,
  preserveTransformOnUpdate,
  frontierMethodKey,
  // Approximate-rollup surface,
  // exported so test-pathmap.js can unit-test the grouping transform
  // directly against bare fixtures, same rationale as everything else in
  // this block.
  normalizeShowUnconfirmed,
  rollupLabel,
  groupApproximateChildren,
  // Scoped-header surface, same
  // export rationale.
  unresolvedMentionsTargetMethodName,
  unresolvedMentionsHeaderLine,
};

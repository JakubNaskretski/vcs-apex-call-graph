'use strict';
// uitree.js — pure TNode -> UiNode shaping for Apex Call Graph's method-level
// engine. No vscode dependency: everything here takes/returns plain data,
// so it is unit-testable with `node test-uitree.js` and is the only place
// that knows how a TNode/SiteView (produced by resolver.js) turns into
// something extension.js can hand to vscode.TreeItem.
//
// Input shapes, copied verbatim from the frozen "=== CONTRACT: resolver.js
// ===" section (this file must not change them):
//
//   TNode = {
//     label,        // 'Cls.method' | 'TriggerName' | 'Cls' | metadata label
//                   // | 'N unresolved sites' (v0.7 A6: aggregated leaf)
//     kind,         // 'method' | 'trigger' | 'class' |
//                   // 'lwc' | 'aura' | 'flow' | 'omniscript' | 'vf' (A6:
//                   // metadata-caller nodes attached via resolver.js's
//                   // attachMetaCallers/buildMetaChildren) | 'cmdt' (v0.4
//                   // F4b: Custom Metadata record, same family as the A6
//                   // kinds -- always terminal today, but this file does
//                   // not assume that; see the children note below) |
//                   // 'anonymous' (v0.5 G4: an anonymous-Apex-script
//                   // (.apex) pseudo-type/method node -- Apex-source family
//                   // like 'method'/'trigger'/'class', NOT a metadata-
//                   // caller kind; always a pure root, per the G4 spec) |
//                   // 'exception' (v0.7 A3: forward-traced throw target --
//                   // the exception class reached by a `throw` site, always
//                   // terminal) | 'unresolved' (v0.7 A6: one aggregated,
//                   // always-terminal, always-approximate leaf per method
//                   // summarizing every forward call site that couldn't be
//                   // resolved to an indexed target) | 'external' (v0.8 N1/
//                   // N4, forward-compat -- resolver.js does not produce
//                   // this kind yet, same status as seenElsewhere below: a
//                   // reference into MANAGED-PACKAGE code this workspace has
//                   // no source for, e.g. `zenq.Billing.charge(...)` or a
//                   // DML target naming a managed object like
//                   // `kwx__Ledger__c`. Always carries via:'external' (see
//                   // the `via` field doc below) and, per N1's ExternalMeta
//                   // shape, a `ns` field naming its namespace (e.g. 'zenq')
//                   // -- read by externalNamespace()/managedBadge() below,
//                   // with a label-derived fallback for a TNode that arrives
//                   // without `ns` (see externalNamespace's own comment).
//                   // TERMINAL in the callees direction (no source to
//                   // recurse into); in the callers direction its children
//                   // are the ordinary local caller subtree of every site
//                   // that references it (per N4) -- this file needs no
//                   // special-casing for either case, since it already
//                   // renders whatever `children` array it is given
//                   // generically, exactly like the 'flow' note just above) --
//                   // NOTE (v0.4 F1b): 'flow' nodes are no longer
//                   // guaranteed terminal -- a record-triggered flow's
//                   // children are the DML sites on its object
//                   // (resolver.js's doing; this file already renders
//                   // ANY node's children generically, so no special-
//                   // casing was needed here for that). Per the A2 spec, a
//                   // 'flow' node IS always terminal specifically in the
//                   // forward (callees) direction -- still no special-
//                   // casing needed here, since a terminal TNode simply
//                   // arrives with an empty `children` array either way.
//                   // v0.13 (S2/S3): that A2 terminality is no longer
//                   // absolute -- a 'flow' node's children may now ALSO be
//                   // its own subflow chain (via:'subflow', both
//                   // directions: parent flows when tracing callers, child
//                   // flows when tracing callees), recursing arbitrarily
//                   // deep (cycle-guarded). Same "renders whatever children
//                   // it is given generically" posture applies -- no
//                   // special-casing needed here for this either.
//     className, path, line,   // line = decl line for jump
//     package,      // string|null|undefined (v0.7 B3): the sfdx package
//                    // label (packageDirectories' `package` name, or the
//                    // path segment when a directory has none) that this
//                    // node's file lives under; undefined/null in a
//                    // packageless workspace or on a synthetic node with no
//                    // backing file. This file never renders it directly --
//                    // see packageBadge()/shapeNode()'s targetPackage
//                    // threading below, which turns it into a "(label)"
//                    // badge ONLY when it differs from the traced target's
//                    // own package (root.package).
//     ns,           // string|undefined (v0.8 N1/N4, forward-compat): ONLY
//                    // meaningful on a kind:'external' node -- its managed-
//                    // package namespace (e.g. 'zenq'), mirroring
//                    // ExternalMeta.ns from N1's index contract. Rendered as
//                    // the 'managed: <ns>' badge (see managedBadge() below),
//                    // never on any other kind.
//     entries: [string], isTest,
//     via: string|null,        // 'typed'|'static'|'new'|'this'|'super'|
//                               // 'interface'|'unique-name'|'lexical'|
//                               // 'metadata'|'dml'|'dynamic'|'override'
//                               // (v0.4 adds the last three)|'publish'|
//                               // 'throws'|'narrowed'|'async' (v0.5 G1/G2/
//                               // G3/G5 add these four -- only 'narrowed' is
//                               // approximate)|'ambiguous' (v0.7 B2: a
//                               // duplicate-named class reference that
//                               // neither same-package nor default-package
//                               // preference could resolve -- approximate)|
//                               // 'external' (v0.8 N1/N2/N4, forward-compat:
//                               // a reference into managed-package code --
//                               // NOT approximate, per N2's precedence rule
//                               // 3: a genuine namespace match is exact, not
//                               // a guess)|'subflow' (v0.13 S2/S3: a declared
//                               // <subflows> reference between two Flow
//                               // files -- NOT approximate, a declared
//                               // reference, same "genuine, not a guess"
//                               // posture as 'external'/'publish' above) --
//                               // this file renders whatever
//                               // string it is given verbatim as a badge, so
//                               // new via values need no code change here,
//                               // only in the legend-equivalent docs a human
//                               // reads.
//     sites: [SiteView],
//     children: [TNode],
//     cyclic, truncated, approximate,
//     caughtHere,   // boolean, v0.5 G2: an ancestor catch clause (exact
//                    // type, an ancestor in the USER exception hierarchy, or
//                    // bare 'Exception') catches the exception being traced
//                    // AT THIS NODE. Always paired with a matching entries
//                    // badge text ('catches <ExcName>', resolver.js's doing)
//                    // -- this file additionally renders a shield glyph
//                    // badge for it (see badgesForNode). Traversal continues
//                    // past a caughtHere node (rethrow is unknowable), so
//                    // this is purely an informational marker, not a leaf.
//     seenElsewhere,  // boolean, v0.6 H1 (forward-compat -- resolver.js does
//                     // not produce this yet): this method's caller subtree
//                     // was already expanded once elsewhere in the SAME
//                     // buildCallerTree run (per-run DAG dedup), so
//                     // `children` is forced empty here even though real
//                     // callers may exist -- `sites` (this node's OWN call
//                     // sites) are still populated and shown normally, only
//                     // the deeper subtree is collapsed. Rendered as its own
//                     // badge (see badgesForNode) and excluded from the
//                     // 'root' badge (a seenElsewhere node is emphatically
//                     // NOT "no known caller", it is "caller already shown
//                     // above").
//     expandable,   // boolean, v0.9 P1 (forward-compat -- resolver.js does
//                    // not produce this yet): this node hit the PROGRESSIVE
//                    // depth frontier (depth >= opts.initialDepth and its
//                    // methodKey is not in opts.expandedKeys) -- real
//                    // callers/callees exist (pendingCount > 0 says exactly
//                    // how many DIRECT groups) but the engine deliberately
//                    // did not expand them this pass, so `children` is empty
//                    // here even though the node is NOT actually childless.
//                    // Distinct from `truncated` (the maxDepth/maxNodes HARD
//                    // caps, which the user cannot resolve by clicking) --
//                    // an expandable node is a SOFT, interactive boundary:
//                    // clicking it (native TreeView lazy-expand, or the
//                    // path map's pill) adds its methodKey to
//                    // opts.expandedKeys and re-traces, which is exactly
//                    // how progressive depth grows the tree one click at a
//                    // time. Rendered as a '+N' badge (frontierBadge below)
//                    // plus a synthetic load-more child (see shapeNode) and,
//                    // like every other "there IS more above/below, it's
//                    // just not shown" flag (cyclic/truncated/
//                    // seenElsewhere), excluded from the 'root' badge
//                    // (isRootNode below) and from entry-first's
//                    // `_entryFirstRoot` stamp (see rerootEntryFirst).
//     pendingCount,  // number|undefined, v0.9 P1 (forward-compat): ONLY
//                    // meaningful alongside expandable:true -- the count of
//                    // DIRECT distinct caller/callee groups this node has
//                    // that were not expanded. Read by frontierBadge/
//                    // shapeNode below to render '+N'; absent/non-number is
//                    // treated as "count unknown" (renders a bare '+').
//     methodKey,     // string|undefined, v0.9 P1 (forward-compat): ONLY
//                    // meaningful alongside expandable:true -- the exact
//                    // `methodKeyLower` identity (resolver.js's own
//                    // `${classLower}#${methodLower}` composite, or a bare
//                    // classLower for a class-level target) this node's
//                    // click-to-expand affordance must add to
//                    // opts.expandedKeys to load its children. OPTIONAL:
//                    // when absent, frontierMethodKey() below derives the
//                    // identical string from the node's own `className` +
//                    // `methodLower` fields (already present on every TNode,
//                    // see above) -- the same "explicit field wins, else
//                    // derive from fields already on the node" pattern
//                    // externalNamespace() uses for `ns` below, so a
//                    // hand-built/early TNode that has expandable:true but
//                    // no explicit `methodKey` yet still renders a working
//                    // load-more affordance instead of silently losing it.
//   }
//
//   SiteView = {
//     path, line, col, lineText,
//     argsRendered: string|null,  // params zipped with args, or raw args
//     via,
//     overloadSig: string|null,  // A4: 'name(TypeHead, ...)' when the call
//                                // site pinned a specific overload out of a
//                                // true overload family; null otherwise.
//                                // v0.6 (H3): previously carried by
//                                // resolver.js's SiteView but never rendered
//                                // anywhere in this file -- confirmed bug,
//                                // fixed by siteLabel/siteDetailLine below.
//   }
//
// LINE-NUMBERING CONVENTION (not pinned down explicitly by the contract,
// documented here so extension.js and resolver.js agree): parser.js's
// CallFacts/MethodFacts document `line` as 1-based (straight from antlr's
// `ctx.start.line`), and nothing in the resolver.js contract says TNode.line
// / SiteView.line get renumbered — so this file treats every `line` it
// receives as 1-based, unmodified, and outputs it unmodified. Converting to
// vscode's 0-based Position/Range only happens at the vscode boundary in
// extension.js, right before constructing the jump command. `col` is
// documented 0-based already (matches vscode Position column) and passes
// through unchanged everywhere.
//
// Output shape (consumed by extension.js to build vscode.TreeItem):
//
//   UiNode = {
//     label,          // string, '~' prefixed when approximate
//     description,    // badges joined with ' · '
//     tooltip,        // string
//     iconId,         // vscode.ThemeIcon id string
//     jump: { path, line, col } | null,   // line still 1-based, see above
//     collapsible,    // boolean
//     children: [UiNode],
//     loadMore,       // boolean, v0.9 P1/P3 -- ONLY present (true) on the
//                      // one synthetic child shapeNode appends to an
//                      // expandable node (see shapeNode/shapeLoadMoreChild
//                      // below); every ordinary UiNode simply omits this
//                      // field, so `uiNode.loadMore` is the extension.js-
//                      // side test for "this TreeItem is the click-to-
//                      // expand affordance, not a real caller/callee".
//     expandKey,      // string|null, v0.9 P1/P3 -- ONLY present alongside
//                      // loadMore:true -- the methodKeyLower extension.js
//                      // must add to opts.expandedKeys (see
//                      // frontierMethodKey below) when this item is
//                      // selected/activated, then re-trace and replace this
//                      // node's children with the fresh result.
//   }
//
// Ordering: resolver.js's buildCallerTree contract already states "Sort
// children: non-test first, then label" — so this file never re-sorts;
// TNode.children order is preserved exactly as given (tests-last ordering
// is a resolver.js responsibility, not this file's).
//
// v0.7.1: this file additionally owns the ORIENTATION transform
// ('target-first' vs 'entry-first') -- a pure re-rooting of the computed
// TreeResult, callers direction only. See the "v0.7.1 ORIENTATION" section
// ahead of rerootEntryFirst() below for the full design, including the
// edge-attachment choice.

const ICON_TRIGGER = 'zap';
const ICON_TEST = 'beaker';
const ICON_ENTRIES = 'plug';
const ICON_METHOD = 'symbol-method';
const ICON_CLASS = 'symbol-class';

// v0.5 (G4): anonymous-Apex-script node icon -- Apex-source family, checked
// alongside ICON_TRIGGER below, NOT part of META_ICON_BY_KIND (that map is
// for the non-Apex metadata-caller kinds only).
const ICON_ANONYMOUS = 'terminal';

// v0.7 (A3): forward-tracing-only node kinds -- neither is part of the A6/A7
// metadata-caller family (both are Apex-source-adjacent concepts: a thrown
// exception CLASS, or a summary of unresolved Apex call sites), so each gets
// its own icon, checked alongside ICON_TRIGGER/ICON_ANONYMOUS below rather
// than folded into META_ICON_BY_KIND.
const ICON_EXCEPTION = 'flame';
const ICON_UNRESOLVED = 'question';

// v0.8 (N6, forward-compat -- see the TNode.kind doc above): an EXTERNAL
// node, a reference into managed-package code this workspace has no source
// for. The spec text offered a choice of two vscode Codicon ids
// ('package'/'globe'); 'package' is picked here since it echoes "managed
// PACKAGE" directly and is visually distinct from every icon already used
// above -- 'globe' would read more like a network/URL concept. Checked
// alongside ICON_EXCEPTION/ICON_UNRESOLVED below (same "the kind alone
// decides the icon" tier), since an external node could in principle carry
// entries and must not fall back to the generic ICON_ENTRIES 'plug' glyph.
const ICON_EXTERNAL = 'package';

// v0.13 (Round 2.5, H2 — rendering half): a 'rollup' pseudo-node -- the
// approximate-callers/callees GROUPING itself is resolver.js's job
// (buildChildrenLevel's applyShowUnconfirmed, per the apexCallGraph.
// showUnconfirmed setting: 'rollup' default | 'hide' | 'expand'); this file
// only ever RENDERS whatever TNode.kind it is handed, exactly like every
// other kind above -- 'layers' reads as "several things stacked/grouped
// together", visually distinct from every icon already used. Checked
// alongside ICON_EXCEPTION/ICON_UNRESOLVED/ICON_EXTERNAL below (same "the
// kind alone decides the icon" tier), since a rollup node could in
// principle carry entries and must not fall back to ICON_ENTRIES.
const ICON_ROLLUP = 'layers';
// v0.13 (Round 2.5, H3 — header half): the caller-direction "K unresolved
// sites elsewhere mention <method>(" info node resolver.js's buildCallerTree
// now appends as one more child of the traced target (kind:
// 'unresolved-mentions', label already fully formatted -- see
// unresolvedMentionsHeaderLine's own doc, ahead of shapeHeaderLines, for how
// this file reuses that exact label text for the header banner too). Reuses
// ICON_UNRESOLVED (declared above) rather than a new glyph -- thematically
// the SAME "unresolved/unconfirmed" family as the pre-existing aggregated
// 'unresolved' leaf, just scoped to the caller direction instead of callee.

// A7: metadata-caller node icons, one per MetaRef.kind (see resolver.js's
// buildMetaChildren / metaEntryLabel — these TNode.kind values are
// 'lwc'|'aura'|'flow'|'omniscript'|'vf'|'cmdt' (v0.4 F4b adds the last one),
// disjoint from the pre-existing 'method'|'trigger'|'class' set).
const ICON_FLOW = 'symbol-event';
const ICON_LWC = 'symbol-interface';
const ICON_AURA = 'browser';
const ICON_OMNISCRIPT = 'json';
const ICON_VF = 'file-code';
const ICON_CMDT = 'gear';

const META_ICON_BY_KIND = {
  flow: ICON_FLOW,
  lwc: ICON_LWC,
  aura: ICON_AURA,
  omniscript: ICON_OMNISCRIPT,
  vf: ICON_VF,
  cmdt: ICON_CMDT,
};

// v0.7.1: the two orientation values. 'target-first' is today's default
// rendering and MUST stay byte-identical (see the ORIENTATION section
// below); 'entry-first' is the new re-rooted rendering. Every orientation
// parameter in this file is OPTIONAL -- omitted/unknown values mean
// 'target-first', so every pre-v0.7.1 call site keeps behaving exactly as
// before.
const ORIENTATION_TARGET_FIRST = 'target-first';
const ORIENTATION_ENTRY_FIRST = 'entry-first';

// Priority mirrors the contract's own listing order: trigger, test,
// entries, method, class — extended (A7, +v0.4 F4b's 'cmdt') with the
// metadata-caller kinds, checked right after trigger (mutually exclusive
// with every other kind, so placement relative to test/entries is moot;
// these nodes always carry isTest:false and a non-empty `entries` per the
// A6/F4b contract, so they would otherwise fall through to the generic
// ICON_ENTRIES 'plug' glyph and lose their distinct identity). A 'flow' node
// with children (v0.4 F1b: a record-triggered flow's DML-site callers) still
// gets ICON_FLOW here — icon selection is about what KIND of node this is,
// not whether it happens to be a leaf.
function iconForNode(node) {
  if (node.kind === 'trigger') return ICON_TRIGGER;
  if (node.kind === 'anonymous') return ICON_ANONYMOUS;
  // v0.7 (A3): same priority tier as trigger/anonymous -- the kind alone
  // decides the icon, ahead of isTest/entries, since a node of either kind
  // could in principle carry entries (e.g. an unresolved-sites leaf) and
  // must not fall back to the generic ICON_ENTRIES 'plug' glyph.
  if (node.kind === 'exception') return ICON_EXCEPTION;
  // v0.7.1 (U3, R8): confirmed against resolver.js's real buildCalleeTree
  // implementation (buildForwardExtras' unresolvedDmlForwardCounts branch)
  // -- the generic-typed-DML marker reuses kind:'unresolved' verbatim (via
  // 'dml-unresolved' is what distinguishes it; see the VIA_GLOSSARY entry
  // below), so no separate kind/icon branch is needed here at all.
  if (node.kind === 'unresolved') return ICON_UNRESOLVED;
  // v0.8 (N6, forward-compat): same "the kind alone decides the icon" tier
  // as exception/unresolved just above -- an external node could in
  // principle carry entries too and must not collapse onto ICON_ENTRIES.
  if (node.kind === 'external') return ICON_EXTERNAL;
  // v0.13 (Round 2.5, H2/H3): same "the kind alone decides the icon" tier --
  // see ICON_ROLLUP/the comment just above it for the full rationale.
  if (node.kind === 'rollup') return ICON_ROLLUP;
  if (node.kind === 'unresolved-mentions') return ICON_UNRESOLVED;
  if (META_ICON_BY_KIND[node.kind]) return META_ICON_BY_KIND[node.kind];
  if (node.isTest) return ICON_TEST;
  if (node.entries && node.entries.length) return ICON_ENTRIES;
  if (node.kind === 'method') return ICON_METHOD;
  return ICON_CLASS;
}

function labelForNode(node) {
  const prefix = node && node.approximate ? '~' : '';
  return prefix + (node && node.label != null ? node.label : '');
}

// v0.8 (N1/N4/N6, forward-compat -- see the TNode.kind/ns doc above):
// this EXTERNAL node's own namespace, or null when the node isn't external
// (or carries no derivable namespace at all). Reads `node.ns` when present
// (the natural mirror of N1's ExternalMeta.ns), and otherwise DERIVES it
// from the node's own label -- both of N1's documented external label
// shapes ('zenq.Billing' for a namespaced method/class call, 'kwx__Ledger__c'
// for a namespaced DML object) put the namespace token as everything before
// the FIRST '.' or '__' -- so a hand-built/early TNode that has kind:
// 'external' but hasn't been wired up with an explicit `ns` field yet still
// renders a correct badge instead of silently losing it.
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

// v0.8 (N4, forward-compat): the 'managed: <ns>' badge text for an EXTERNAL
// node, or null when none applies -- exact wording per N4's CONTRACT
// AMENDMENT text ("badge 'managed: <ns>'"). Kept as its own tiny helper
// (rather than inlined into badgesForNode) so it is independently unit-
// testable against a bare `{ kind, ns }`/`{ kind, label }` fixture, same
// rationale as packageBadge()/isRootNode() below.
function managedBadge(node) {
  const ns = externalNamespace(node);
  return ns ? `managed: ${ns}` : null;
}

// v0.9 (P1/P3, forward-compat): the methodKeyLower identity a click-to-
// expand affordance for this node must hand back to
// opts.expandedKeys/buildCallerTree/buildCalleeTree -- see the TNode.
// methodKey field doc above for the full "explicit field wins, else derive"
// rationale. Returns null when there is nothing derivable at all (neither an
// explicit methodKey nor a className), so callers can treat a null result as
// "no working expand affordance" rather than emitting a broken '#' key.
function frontierMethodKey(node) {
  if (!node) return null;
  if (typeof node.methodKey === 'string' && node.methodKey) return node.methodKey;
  const cls = typeof node.className === 'string' ? node.className.toLowerCase() : '';
  const method = typeof node.methodLower === 'string' && node.methodLower ? node.methodLower : null;
  if (!cls && !method) return null;
  return method ? `${cls}#${method}` : cls;
}

// v0.9 (P1/P3, forward-compat): the '+N' frontier badge text for an
// expandable node, or null when the node isn't a frontier at all. `N` is
// `pendingCount` when it's a real number; an expandable node that (for
// whatever reason) arrives without a usable pendingCount still renders a
// bare '+' rather than silently dropping the marker -- same "degrade
// gracefully, never silently lose the flag" posture as every other
// forward-compat helper in this file (externalNamespace/managedBadge above).
function frontierBadge(node) {
  if (!node || !node.expandable) return null;
  const n = typeof node.pendingCount === 'number' ? node.pendingCount : null;
  return n != null ? `+${n}` : '+';
}

// v0.9 (P3): the noun a frontier marker's text should use -- 'callees' only
// for an explicit callees-direction trace, 'callers' for absent/'callers'
// (mirrors every other direction-aware noun swap already in this file, e.g.
// shapeHeaderLines' `cappedNoun`).
function frontierNoun(direction) {
  return direction === 'callees' ? 'callees' : 'callers';
}

// Badge order per contract: entries · caughtHere (shield) · test · via ·
// managed:<ns> (v0.8 N4) · package (v0.7 B3) · '~' when approximate ·
// '↺ cycle' · '… capped' · '+N' frontier (v0.9 P3) · '↪ seen elsewhere'.
// (The 'root' badge is NOT added here -- see isRootNode/shapeNode below: it
// depends on the shaped `children` count, which this per-node-flags
// function deliberately does not compute, so it stays cheaply unit-testable
// against partial TNode fixtures.)
// v0.5 (G2): caughtHere gets its own shield-glyph badge, IN ADDITION to the
// 'catches <ExcName>' text resolver.js already stamps into `entries` for the
// same node (see the TNode.caughtHere doc above) -- the glyph is a quick
// visual flag, the entries text (already rendered by the line above) is the
// actual exception name.
//
// v0.7 (B3): `pkgBadge` is an OPTIONAL second argument -- the pre-computed
// '(pkgLabel)' string from packageBadge() below, or falsy when the node has
// no package or matches the traced target's own package. It is threaded in
// by the caller (shapeNode, which alone has the tree-wide `targetPackage`
// context this per-node function deliberately does not compute) rather than
// looked up here, so every EXISTING call site that invokes
// `badgesForNode(node)` with just one argument -- including every fixture
// in test-uitree.js written before this round -- keeps behaving exactly as
// before (pkgBadge undefined is simply falsy, so no badge is pushed).
//
// v0.7.1: `orientation` is an OPTIONAL third argument, same
// omitted-means-unchanged convention as pkgBadge. It only affects the
// seenElsewhere badge's wording (see below); every other badge is
// orientation-agnostic.
//
// v0.9 (P3): the frontier '+N' badge (see below) is direction-agnostic on
// purpose -- it never spells out "callers"/"callees", just a bare count --
// so it needs no new parameter here; the direction-aware NOUN only shows up
// in the longer glossary tooltip line (see glossaryLinesForNode/
// frontierNoun below), which already threads other tree-wide context
// separately from this per-node function.
function badgesForNode(node, pkgBadge, orientation) {
  const badges = [];
  if (node.entries && node.entries.length) badges.push(node.entries.join(', '));
  if (node.caughtHere) badges.push('🛡');
  if (node.isTest) badges.push('test');
  if (node.via) badges.push(node.via);
  // v0.8 (N4, forward-compat): the managed-package badge -- computed
  // directly from `node` here (unlike pkgBadge, it needs no tree-wide
  // context, just this node's own kind/ns/label), positioned right after
  // `via` since it further qualifies the same "this is an external
  // reference" fact the via:'external' badge just above already announced.
  const managed = managedBadge(node);
  if (managed) badges.push(managed);
  if (pkgBadge) badges.push(pkgBadge);
  if (node.approximate) badges.push('~');
  if (node.cyclic) badges.push('↺ cycle');
  // v0.7.1 (U2, gauntlet Tier-3 #5 / fix-backlog #2): resolver.js's
  // `truncated` flag now fires for TWO distinct causes that share one
  // boolean -- the pre-existing per-branch depth cap (maxDepth) AND the
  // whole-tree maxNodes cap (R5's fix stamps `truncated=true` on the
  // specific node whose expansion the node-count budget cut off, mirroring
  // the depth-cap pattern). The old '… depth cap' wording was accurate only
  // for the first cause and would misreport the second (a node cut off by
  // the node-count budget has NOT necessarily hit any depth limit) -- '…
  // capped' is deliberately cause-agnostic so it stays true either way. See
  // isRootNode below: a truncated node is (and was already) excluded from
  // the '◉ root' badge regardless of which cap fired.
  if (node.truncated) badges.push('… capped');
  // v0.9 (P1/P3, forward-compat): the progressive-depth frontier badge --
  // see the TNode.expandable/pendingCount field docs above and
  // frontierBadge's own comment. Slotted right after '… capped': both
  // badges mean "there is more here that isn't shown", truncated being the
  // hard/non-interactive cap and this being the soft/click-to-load one, so
  // reading them adjacently in that order (hard cap, then soft frontier)
  // matches the two flags' actual severity. A node cannot carry both at
  // once (truncated is stamped by the maxDepth/maxNodes HARD caps, which by
  // construction fire only once expandable's SOFT initialDepth frontier
  // would have already stopped expansion), but this file makes no
  // assumption either way -- both simply render if both happen to be true.
  const frontier = frontierBadge(node);
  if (frontier) badges.push(frontier);
  // v0.6 (H1 forward-compat, H5 rendering): resolver.js does not produce
  // TNode.seenElsewhere yet -- this is purely additive and a no-op today.
  // v0.7.1: in the entry-first orientation the SAME flag reads
  // '↪ continues above' -- the reference node now anchors the START of its
  // own chain, and the deeper entry chain it points at was expanded in
  // another top-level branch of the same view, i.e. "above" in reading
  // order, not "elsewhere" in an unspecified direction.
  if (node.seenElsewhere) {
    badges.push(orientation === ORIENTATION_ENTRY_FIRST ? '↪ continues above' : '↪ seen elsewhere');
  }
  return badges;
}

// v0.7 (B3): the node's package badge text, or null when none applies --
// null whenever the node carries no package at all, OR its package matches
// `targetPackage` (the traced target's OWN package, i.e. root.package --
// see shapeResult below). Kept as a small standalone helper, same rationale
// as isRootNode: it needs tree-wide context (the target's package) that
// badgesForNode's per-node-only signature does not carry, so callers thread
// the result in explicitly (see shapeNode).
function packageBadge(node, targetPackage) {
  if (!node || !node.package) return null;
  if (node.package === targetPackage) return null;
  return '(' + node.package + ')';
}

// v0.6 (H3): explicit 'root' badge for a node with NO known caller in this
// trace -- an entry point or unused/dead code, per the README's promise.
// Deliberately excludes cyclic/truncated/seenElsewhere: all three mean
// "there IS more above this node, we just didn't show/expand it", the exact
// opposite of "root". Kept OUT of badgesForNode (see the comment above it)
// so that function's existing per-flag unit tests (built from partial TNode
// fixtures with no `children` array) are unaffected by this addition;
// callers that need the root badge call this from shapeNode instead, where
// the real children array is always present.
//
// v0.9 (P1/P3, forward-compat): `expandable` joins the exclusion list for
// the exact same reason -- a frontier node has an empty `children` array
// purely because the engine chose not to expand it THIS pass (see the
// TNode.expandable field doc above), not because it genuinely has no known
// caller/callee. Purely additive: `node.expandable` is undefined on every
// pre-v0.9 fixture, so `!undefined` is `true` and this check is a no-op
// there -- the REGRESSION PIN (initialDepth === maxDepth && expandedKeys
// empty -> output byte-identical to v0.8) holds because a v0.8-shaped
// resolver.js never sets `expandable` at all.
function isRootNode(node) {
  if (!node) return false;
  const hasChildren = !!(node.children && node.children.length);
  return !hasChildren && !node.cyclic && !node.truncated && !node.seenElsewhere && !node.expandable;
}

// v0.6 (H3): the site's marquee data -- overloadSig and argsRendered -- used
// to be tooltip-only (argsRendered) or rendered NOWHERE at all (overloadSig
// -- confirmed bug). This builds the second, visible '-> ...' line: both
// present join with ' · ' (overloadSig first, since it's the shorter,
// scan-first fact -- 'calculatePrice(String) · skuCode: ...'), either alone
// renders on its own, neither present means no second line at all (an
// empty/whitespace-only argsRendered, e.g. metadata call sites that pass
// '', is treated as absent, same as null).
function siteDetailLine(site) {
  const parts = [];
  if (site && site.overloadSig) parts.push(site.overloadSig);
  if (site && site.argsRendered) parts.push(site.argsRendered);
  if (!parts.length) return null;
  return '-> ' + parts.join(' · ');
}

// Label is 'L<line>: <lineText>', plus the '-> ...' detail line appended
// after a newline when there's marquee data to show -- still a single
// UiNode per site (no extra tree nesting), the second line is just part of
// this same row's label text.
function siteLabel(site) {
  const line = site && typeof site.line === 'number' ? site.line : '?';
  const lineText = (site && site.lineText) || '';
  const base = `L${line}: ${lineText}`;
  const detail = siteDetailLine(site);
  return detail ? `${base}\n${detail}` : base;
}

// Tooltip is argsRendered per the contract ("site items ... with tooltip
// argsRendered"); when there's nothing to render (null/empty — e.g. a
// zero-arg call) fall back to the source location so the tooltip is never
// blank. Unchanged by H3: the detail line now ALSO shows this inline (see
// siteLabel/siteDetailLine above), but the tooltip stays as documented —
// "Keep tooltips too" per the H3 spec.
function siteTooltip(site) {
  if (site && site.argsRendered) return site.argsRendered;
  if (site && site.path) return `${site.path}:${typeof site.line === 'number' ? site.line : '?'}`;
  return '';
}

function shapeSite(site) {
  const hasLine = site && typeof site.line === 'number';
  return {
    label: siteLabel(site),
    description: (site && site.via) || '',
    tooltip: siteTooltip(site),
    iconId: 'arrow-small-right',
    jump: site && site.path && hasLine ? { path: site.path, line: site.line, col: site.col || 0 } : null,
    collapsible: false,
    children: [],
  };
}

// v0.6 (H5a): one-line glossary explanations, keyed by the badge/marker they
// document -- every via value the resolver.js contract lists, plus every
// non-via marker (~, cycle, depth-cap, caughtHere, seenElsewhere, root).
// Rendered into the NODE tooltip (see nodeTooltip below), not the badge text
// itself, so the badges stay short while a hover still explains them.
const VIA_GLOSSARY = {
  typed: "resolved through the receiver's declared type, following the extends chain",
  static: 'Class.method() static call',
  new: 'constructor call',
  this: 'this.method() same-class call',
  super: 'super.method() parent-class call',
  interface: 'dispatched through an interface-typed variable to every implementer (approximate)',
  'unique-name': 'no receiver type available; matched by a codebase-unique method name (approximate)',
  lexical: 'parse-error fallback, matched by text mention only (approximate)',
  metadata: 'caller is LWC, Aura, Flow, OmniScript, VF, or Custom Metadata, not Apex source',
  dml: 'a DML statement whose target object has a trigger, or that matches a record-triggered flow',
  dynamic: "Type.forName('LiteralClassName') or a Custom Metadata field naming a class (approximate)",
  override: "fan-out edge to a subclass's override of a virtual/abstract method (approximate)",
  publish: 'EventBus.publish(...) of a platform-event record, resolved to every trigger on that event',
  throws: 'a throw statement, shown when tracing the thrown exception type itself',
  narrowed: "an 'x instanceof T' narrowing found in the same method as the fallback receiver type (approximate)",
  async: 'System.enqueueJob / Database.executeBatch / System.schedule call to a known class',
  // v0.7 (B2): duplicate-named-class fan-out -- neither same-package nor
  // default-package preference could disambiguate, so every remaining
  // candidate gets its own edge.
  ambiguous: "a class name duplicated across sfdx packages that neither the referring file's own package nor the default package could resolve -- every remaining candidate gets an edge (approximate)",
  // v0.7 (A6): pre-existing gap closed here -- the aggregated "N unresolved
  // sites" leaf (kind:'unresolved') has carried via:'unresolved' since v0.7
  // shipped, but this table never had a matching entry, so its tooltip
  // silently dropped the via line. Purely additive: a node with this via
  // already rendered correctly (the label text itself is self-explanatory
  // plain English), it just gained an explanation line it was missing.
  unresolved: 'aggregated leaf: one or more forward call sites in this method could not be resolved to an indexed target (dynamic/platform call, deep/unknown-type chain, etc.) — approximate',
  // v0.7.1 (U3, R8): the gauntlet's "generic-typed DML loses trigger
  // linkage" fix (KappaUnitOfWork.commitWork() -- `List<SObject> records;
  // insert records;` can't be narrowed to a concrete SObject type, so no
  // DML->trigger/flow edge can be emitted). Confirmed against resolver.js's
  // real buildCalleeTree implementation (buildForwardExtras'
  // unresolvedDmlForwardCounts branch): kind:'unresolved' (reused
  // verbatim), via:'dml-unresolved' (this exact string -- deliberately its
  // OWN via, not 'dml' above, since 'dml' promises a real trigger/flow
  // match, which is exactly what this marker does NOT have; "no trigger
  // linkage" is the whole point), label 'DML on unresolved SObject type'
  // (or 'N DML sites on unresolved SObject type' when N > 1), always
  // approximate + truncated (terminal).
  'dml-unresolved': "DML on unresolved SObject type — the DML statement's target could not be narrowed to a concrete SObject (e.g. a generic List<SObject>/SObject-typed variable), so no trigger or flow linkage could be traced (approximate)",
  // v0.8 (N4/N6, forward-compat): exact tooltip wording per N4's CONTRACT
  // AMENDMENT text ("tooltip 'managed package code — source not
  // analyzable'"). This one entry alone satisfies N6's "glossary tooltip"
  // requirement for the 'external' kind -- glossaryLinesForNode below
  // already renders a `${via}: ${VIA_GLOSSARY[via]}` line for ANY node
  // carrying a recognized via, with zero extra code needed here, exactly
  // like every other via value in this table. NOT approximate (see the
  // TNode.via field doc above), so this via never co-occurs with the '~'
  // marker glossary line.
  external: 'managed package code — source not analyzable',
  // v0.13 (S2/S3): flow-to-flow subflow chains -- a declared `<subflows>`
  // reference between two Flow files metascan actually saw (never a
  // fan-out guess, unlike interface/unique-name/dynamic/etc. above), so
  // this via is deliberately absent from resolver.js's APPROX_VIA set and
  // never co-occurs with the '~' marker line, same posture as 'publish'/
  // 'throws'/'external' just above. In the callers direction it's the
  // flow's own PARENT flow (the parent invokes it as a subflow); in the
  // callees direction it's the flow's own SUBFLOW (it invokes the child).
  subflow: 'a declared <subflows> reference between two Flow files — not an Apex call, a parent/child flow-orchestration edge',
  // v0.13 (Round 2.5, H3 — header half): via values on a kind:
  // 'unresolved-mentions' node's individual mention-site children (see
  // resolver.js's buildCallerTree -- each mentionChildren entry carries
  // `via: s.reason || 'unresolved'`, one of resolver.js's own
  // stats.unresolvedByReason keys). These are NOT edges into the traced
  // target -- they are call sites elsewhere that merely MENTION its method
  // name on a receiver H1's arity-gate/attachment-cap rule declined to wire
  // up -- so each explanation below is written from that "worth a manual
  // look, not a confirmed caller" angle, distinct from every via above.
  'unknown-receiver': "a call site using this exact method name, on a receiver whose type couldn't be determined at all — never even reached the unique-name attachment check",
  'non-literal-dynamic': 'a call site using this exact method name reached only through a non-literal dynamic dispatch (e.g. a computed Type.forName argument) — not literal-flow traceable',
  'parse-fallback': "a call site in a file that failed to parse — matched by text mention only, in a file this workspace couldn't fully analyze",
  'name-too-common': "a call site using this exact method name that COULD have attached via unique-name (its argument count matched), but the name attracted more unresolvable-receiver sites workspace-wide than UNIQUE_NAME_MAX allows — attaching all of them would make a framework-common name look like a confirmed caller",
};

const MARKER_GLOSSARY = {
  approximate: '~ — approximate resolution: this edge may be wrong or one of several candidates',
  caughtHere: '🛡 caughtHere — an ancestor catch clause here catches the exception being traced; traversal still continues past it (rethrow is unknowable)',
  cyclic: '↺ cycle — this call chain recurses back on itself here',
  // v0.7.1 (U2): cause-agnostic wording -- see the badgesForNode comment
  // above for why this can no longer say "depth cap" specifically now that
  // the node-count (maxNodes) cap stamps the same flag on the one node its
  // own expansion was cut off at.
  truncated: '… capped — trace depth cap or node-count cap reached; more callers/callees may exist beyond this node',
  seenElsewhere: '↪ seen elsewhere — this subtree was already expanded once elsewhere in this trace; its own call sites are still shown, only the deeper callers above it are collapsed',
  // v0.7.1: the entry-first re-wording of the same flag (see badgesForNode)
  // -- in that orientation the reference node is the START of its own
  // chain, and the deeper entry chain it references was expanded fully in
  // another top-level branch of this same view.
  seenElsewhereEntryFirst: "↪ continues above — this method's deeper entry chain was already expanded in another branch of this trace; the chain starts here instead of repeating it",
  // v0.7.1: documents the entry-first edge-attachment convention for the
  // user (see the ORIENTATION section ahead of rerootEntryFirst below for
  // the full design rationale) -- appended to the tooltip of every
  // entry-first node that carries an incoming edge (via and/or sites).
  entryFirstEdge: "entry-first: this node's via badge and call-site rows describe how the node ABOVE calls it — the site lines live in that caller's source file",
  root: '◉ root — no known caller in this trace: an entry point or unused/dead code',
  // v0.7 (B3): explains the '(pkgLabel)' badge -- the actual label text is
  // dynamic (the package name itself), so this is appended as a suffix onto
  // that literal badge string in glossaryLinesForNode below, rather than
  // being a single fixed lookup string like the other entries here.
  package: "this node's file lives in a different sfdx package directory than the traced target's",
  // v0.13 (Round 2.5, H2 — rendering half): explains the GROUPING itself --
  // distinct from the generic 'approximate' line above (which every rolled-
  // up MEMBER also carries individually, describing its own edge), this one
  // is about the collapsed CONTAINER. Keyed off node.kind in
  // glossaryLinesForNode below, not a via lookup (the rollup node's own
  // via is null -- see resolver.js's applyShowUnconfirmed).
  rollup: 'grouped for clarity — every approximate caller/callee of this node is collected here instead of cluttering the list above; expand to inspect each one individually (its own via badge explains exactly how IT was matched)',
  // v0.13 (Round 2.5, H3 — header half): explains the caller-direction
  // scoped-mentions info node (kind:'unresolved-mentions') -- keyed off
  // node.kind, same rationale as 'rollup' just above. Its own via
  // ('unresolved', or per-child reason via VIA_GLOSSARY) already explains
  // the INDIVIDUAL sites; this line explains why the group exists at all.
  unresolvedMentions:
    "these call sites use this exact method name on a receiver that couldn't be resolved, but were deliberately NOT wired up as confirmed callers (arity mismatch, a name too common workspace-wide to trust, dynamic dispatch, or a parse failure -- see each child's own via badge) — worth a manual look if you suspect one of these really does call this method",
};

// v0.9 (P1/P3, forward-compat): the frontier glossary line, exact wording
// per the CONTRACT AMENDMENT text ("tooltip 'N more direct callers/callees
// — expand to load'") -- direction-resolved via frontierNoun since a real
// trace always knows which direction it's tracing (the contract's own
// slash-separated phrasing is describing the two possible renderings, not a
// literal string to emit verbatim). Built here rather than as a single
// fixed MARKER_GLOSSARY lookup because both the badge text and the count
// are dynamic per node -- same rationale/pattern as the '(pkgLabel)' line
// two lines below in glossaryLinesForNode.
function frontierGlossaryLine(node, direction) {
  const badge = frontierBadge(node);
  const noun = frontierNoun(direction);
  const n = typeof node.pendingCount === 'number' ? node.pendingCount : null;
  const countText = n != null ? `${n} more direct ${noun}` : `more direct ${noun}`;
  return `${badge} — ${countText} — expand to load`;
}

// v0.7 (B3): `pkgBadge` is the same optional pre-computed '(pkgLabel)'
// string threaded through badgesForNode above -- see that function's
// comment for why it is a parameter here rather than computed locally.
//
// v0.7.1: `orientation` optional third argument, same convention as
// badgesForNode. In entry-first it (a) swaps the seenElsewhere line for its
// re-worded variant, (b) adds the edge-attachment explainer on nodes that
// carry an incoming edge, and (c) anchors the 'root' line to the
// transform's own _entryFirstRoot stamp instead of isRootNode() --
// isRootNode's "childless and unflagged" rule is meaningless after
// re-rooting (every branch TIP is childless there, and tips are the traced
// target, the exact opposite of "no known caller").
//
// v0.9 (P1/P3): `direction` optional fourth argument, same
// omitted-means-'callers' convention as badgesForNode/frontierNoun. Only
// feeds the new frontier line below; every other line is direction-agnostic.
function glossaryLinesForNode(node, pkgBadge, orientation, direction) {
  const entryFirst = orientation === ORIENTATION_ENTRY_FIRST;
  const lines = [];
  if (node && node.via && VIA_GLOSSARY[node.via]) lines.push(`${node.via}: ${VIA_GLOSSARY[node.via]}`);
  // v0.13 (Round 2.5, H2/H3): kind-based lines for the two new synthetic
  // container kinds -- see MARKER_GLOSSARY.rollup/unresolvedMentions' own
  // comments for why these are keyed off `kind`, not `via`.
  if (node && node.kind === 'rollup') lines.push(MARKER_GLOSSARY.rollup);
  if (node && node.kind === 'unresolved-mentions') lines.push(MARKER_GLOSSARY.unresolvedMentions);
  if (entryFirst && node && (node.via || (node.sites && node.sites.length))) {
    lines.push(MARKER_GLOSSARY.entryFirstEdge);
  }
  if (node && node.approximate) lines.push(MARKER_GLOSSARY.approximate);
  if (node && node.caughtHere) lines.push(MARKER_GLOSSARY.caughtHere);
  if (node && node.cyclic) lines.push(MARKER_GLOSSARY.cyclic);
  if (node && node.truncated) lines.push(MARKER_GLOSSARY.truncated);
  if (node && node.expandable) lines.push(frontierGlossaryLine(node, direction));
  if (node && node.seenElsewhere) {
    lines.push(entryFirst ? MARKER_GLOSSARY.seenElsewhereEntryFirst : MARKER_GLOSSARY.seenElsewhere);
  }
  if (entryFirst ? !!(node && node._entryFirstRoot) : isRootNode(node)) lines.push(MARKER_GLOSSARY.root);
  if (pkgBadge) lines.push(`${pkgBadge} — ${MARKER_GLOSSARY.package}`);
  return lines;
}

// Node tooltip: the source path (as before), plus a one-line-per-badge
// glossary explaining every marker this specific node carries. No existing
// caller relied on the node tooltip being exactly `node.path` (only site
// tooltips are pinned by contract/tests), so this is a pure addition.
//
// v0.7 (B3): `pkgBadge` optional second argument, same rationale/threading
// as badgesForNode/glossaryLinesForNode above -- omitted (undefined), every
// EXISTING call site (including every pre-v0.7 test fixture) is unaffected.
// v0.7.1: `orientation` optional third argument, passed straight through to
// glossaryLinesForNode.
// v0.9 (P1/P3): `direction` optional fourth argument, passed straight
// through to glossaryLinesForNode.
function nodeTooltip(node, pkgBadge, orientation, direction) {
  const lines = [];
  if (node && node.path) lines.push(node.path);
  const glossary = glossaryLinesForNode(node, pkgBadge, orientation, direction);
  if (glossary.length) {
    if (lines.length) lines.push('');
    lines.push(...glossary);
  }
  return lines.join('\n');
}

// v0.9 (P1/P3): the synthetic "load more" UiNode shapeNode appends as the
// sole child of an `expandable` node (see the TNode.expandable field doc
// and the UiNode.loadMore/expandKey field docs at the top of this file).
// NATIVE LAZY TREE rendering (per the P2 CONTRACT AMENDMENT): this item is
// what makes an expandable node with ZERO real TNode.children still render
// Collapsed with something to expand into -- `collapsible` downstream comes
// from `kids.length > 0` exactly like every other node (see shapeNode
// below), so appending this one synthetic child is the ENTIRE mechanism,
// no separate collapsible override needed. `jump: null` -- this item has no
// source location of its own, so extension.js's existing
// `if (uiNode.jump) it.command = ...` guard already leaves it commandless
// by construction; extension.js is expected to instead special-case
// `uiNode.loadMore` (own file, not this one) to wire the actual expand
// behavior (add `expandKey` to opts.expandedKeys, re-trace, replace this
// node's children with the fresh result).
function shapeLoadMoreChild(node, direction) {
  const noun = frontierNoun(direction);
  const n = typeof node.pendingCount === 'number' ? node.pendingCount : null;
  const label = n != null ? `+${n} more ${noun}…` : `More ${noun}…`;
  return {
    label,
    description: '',
    tooltip: frontierGlossaryLine(node, direction),
    iconId: 'ellipsis',
    jump: null,
    collapsible: false,
    children: [],
    loadMore: true,
    expandKey: frontierMethodKey(node),
  };
}

// Recursive TNode -> UiNode. Sites render before child caller nodes (call
// sites at this node come first, then the deeper callers of this caller) —
// order within each group is preserved from resolver.js's output.
//
// v0.7 (B3): `targetPackage` is an OPTIONAL second argument -- the traced
// target's own `.package` (computed once in shapeResult from the tree
// root, then threaded down through every recursive call so each descendant
// can compare its own `.package` against it). Every EXISTING call site that
// invokes `shapeNode(node)` with just one argument -- including every
// fixture in test-uitree.js written before this round -- keeps behaving
// exactly as before: `targetPackage` is undefined, so packageBadge() below
// returns null for every node UNLESS that node happens to carry a
// `.package` of its own (no pre-v0.7 fixture does), in which case it would
// still show a badge (there being no target package to match against) --
// this is intentional and harmless: none of today's fixtures exercise it,
// and it means a caller that DOES want package badges without going
// through shapeResult can pass targetPackage explicitly.
// v0.7.1: `orientation` is an OPTIONAL third argument, threaded down every
// recursive call exactly like targetPackage. Omitted (every pre-v0.7.1 call
// site), rendering is byte-identical to before. When 'entry-first' it only
// changes (a) the seenElsewhere badge wording + glossary (badgesForNode /
// nodeTooltip above) and (b) WHICH nodes get the '◉ root' badge: after
// re-rooting, "childless and unflagged" (isRootNode) describes the traced
// TARGET at each branch tip -- the one node guaranteed to HAVE callers --
// so the badge is anchored to the transform's _entryFirstRoot stamp
// instead: the tree roots that came from genuine entry leaves. They still
// truthfully have "no known caller" (their children below are their
// CALLEES in this orientation), and boundary roots (cyclic/truncated/
// seenElsewhere) stay excluded, same rule as target-first.
// v0.9 (P1/P3): `direction` is an OPTIONAL fourth argument, threaded down
// every recursive call exactly like targetPackage/orientation. Omitted
// (every pre-v0.9 call site), the frontier machinery below is a pure no-op
// (see isRootNode/badgesForNode's own `node.expandable` guards -- undefined
// on every pre-v0.9 TNode) and `direction` itself only ever reaches
// shapeLoadMoreChild/frontierGlossaryLine, which are themselves only
// invoked when `node.expandable` is true. When `node.expandable` IS true,
// this appends `shapeLoadMoreChild`'s single synthetic item onto `kids`
// BEFORE computing `collapsible`/`children` below -- an expandable TNode's
// own `children` array is always empty (see the field doc: the engine
// either expands a node's children fully or not at all, never partially),
// so this is the only source of a non-empty `kids` array for such a node.
//
// v0.13 (Round 2.5, H2 — rendering half): the APPROXIMATE ROLLUP grouping
// itself is resolver.js's job now (buildChildrenLevel's applyShowUnconfirmed,
// gated by the apexCallGraph.showUnconfirmed setting) -- by the time a TNode
// reaches this file, its `children` array is ALREADY grouped/hidden/flat per
// that setting, exactly one more kind of TNode.children shape this file
// walks purely structurally (same posture as every other resolver.js-side
// tree shape this file has never needed special-casing for -- flow subflow
// chains, record-triggered DML children, etc.). This function therefore
// needs NO changes to walk it: a `kind:'rollup'` pseudo-node is just another
// child, recursively shaped exactly like any other node (see iconForNode/
// VIA_GLOSSARY/MARKER_GLOSSARY above for its dedicated icon + glossary
// lines) -- no partitioning, no mode parameter, nothing extra threaded
// through the recursion below.
function shapeNode(node, targetPackage, orientation, direction) {
  const entryFirst = orientation === ORIENTATION_ENTRY_FIRST;
  const uiSites = (node.sites || []).map(shapeSite);
  const uiChildren = (node.children || []).map((child) => shapeNode(child, targetPackage, orientation, direction));
  let kids = uiSites.concat(uiChildren);
  if (node.expandable) kids = kids.concat([shapeLoadMoreChild(node, direction)]);
  const pkgBadge = packageBadge(node, targetPackage);
  const badges = badgesForNode(node, pkgBadge, orientation);
  // v0.6 (H3): appended last -- root is mutually exclusive with
  // cyclic/truncated/seenElsewhere by construction (isRootNode), so its
  // position relative to those is moot; this ordering matches the README's
  // own 'entries · via · root' example exactly whenever nothing else fires.
  if (entryFirst ? !!node._entryFirstRoot : isRootNode(node)) badges.push('◉ root');
  return {
    label: labelForNode(node),
    description: badges.join(' · '),
    tooltip: nodeTooltip(node, pkgBadge, orientation, direction),
    iconId: iconForNode(node),
    jump: node.path && typeof node.line === 'number' ? { path: node.path, line: node.line, col: 0 } : null,
    collapsible: kids.length > 0,
    children: kids,
  };
}

// =========================================================================
// v0.7.1 ORIENTATION: 'target-first' (default) vs 'entry-first'.
//
// The callers tree has always rendered TARGET-FIRST: root = the traced
// target, expanding = who calls it -- stack-trace style, reading upward
// AGAINST execution order. 'entry-first' is a PURE RE-ROOTING TRANSFORM
// over the already-computed TreeResult (no resolver.js change, no re-scan):
// enumerate every root-to-leaf PATH of the target-first tree, reverse each
// path (so it reads entry -> ... -> target, the same direction the Path
// Map reads), then merge the reversed paths into a trie so paths sharing
// the same entry chain share one subtree. The roots of the result are the
// LEAVES of the target-first tree: the genuine entry points (childless,
// unflagged) plus the boundary leaves (cyclic / truncated / seenElsewhere),
// which ride along unchanged as the start of their own chain -- each keeps
// its boundary badge so the reader knows it is a boundary, not a real
// entry (seenElsewhere is re-worded '↪ continues above' here, see
// badgesForNode). The traced target is, by construction, the deepest node
// of every branch.
//
// EDGE-ATTACHMENT CHOICE (the one real decision in this transform): in the
// target-first tree, the via badge + call sites describing the edge
// "X calls Y" hang on X -- the tree-CHILD (X sits under its callee Y; a
// node's edge data describes the call it makes to its tree-parent). After
// path reversal the same two nodes stay adjacent but swap roles: X becomes
// Y's tree-parent. This transform re-hangs that edge data on Y, the
// entry-first tree-CHILD -- i.e. edge data (via / sites / approximate) is
// shifted ONE STEP TOWARD THE TARGET along each reversed path -- so the
// invariant "a node's via badge and call sites always describe the edge
// connecting it to its tree-parent" holds identically in both
// orientations; only the edge's direction relative to the tree flips
// (target-first: child calls its parent; entry-first: parent calls its
// child). The rejected alternative (each node simply keeping its own
// via/sites) breaks on any merge: a diamond's two entry-leaf instances
// E-under-A ("E calls A", site L5) and E-under-B ("E calls B", site L9)
// merge into ONE entry-first root E, and keeping both site sets on E would
// leave two different edges' sites indistinguishable on one node. With the
// shift, each site lands on the unique child it describes (A gets L5, B
// gets L9) -- edge-unambiguous by construction. The tooltip documents this
// for the user (MARKER_GLOSSARY.entryFirstEdge): sites shown on an
// entry-first node are lines in its PARENT's source file.
//
// A trie position's merge key = the node's identity fields + its (shifted)
// incoming-edge data, so two path positions merge only when they are the
// same node reached over the same edge; the boundary flags are part of
// identity, so a seenElsewhere reference of a method never merges with
// that method's full expansion elsewhere.
//
// Node-inherent data (entries / isTest / caughtHere / package / the
// boundary flags) stays with its node; only edge data shifts. The
// '◉ root' badge is re-anchored via the _entryFirstRoot stamp -- see
// shapeNode's comment.
//
// Direction is ORTHOGONAL, and this transform applies to the CALLERS
// direction only: a callees tree already reads execution-forward (root =
// target, expansion follows calls in the order they happen), so re-rooting
// it would just re-create the backwards-reading problem this feature
// exists to remove. effectiveOrientation() therefore neutralizes
// 'entry-first' whenever treeResult.direction === 'callees'; extension.js
// additionally hides/no-ops the toggle in that direction.
//
// v0.9 (P1/P3) FRONTIER NODES, DOCUMENTED CHOICE: a progressive-depth
// frontier node (TNode.expandable:true, see the field doc up top) has an
// EMPTY `children` array by construction -- the engine chose not to expand
// it this pass -- so walk()'s existing "no children -> path ends here"
// rule (unchanged by this round) already treats it exactly like a genuine
// target-first LEAF: it terminates every path that reaches it, and (via
// makeNode below) becomes the entry-first ROOT of its own chain, the same
// way a cyclic/truncated/seenElsewhere boundary leaf already does. This is
// the deliberate, chosen rendering (not an oversight): a frontier is, from
// the re-rooted reader's point of view, just another kind of "the chain
// keeps going, but not shown here" boundary -- the SAME family
// cyclic/truncated/seenElsewhere already belong to -- so it gets the exact
// same treatment those three get:
//   - it is EXCLUDED from `_entryFirstRoot` (see makeNode below) so it does
//     NOT pick up the '◉ root' badge -- a frontier boundary is emphatically
//     not "no known caller", it is "caller(s) exist, just not expanded yet"
//     (this mirrors isRootNode's target-first exclusion of `expandable`
//     one-for-one);
//   - it KEEPS its own `expandable`/`pendingCount`/`methodKey` fields
//     (copied through by makeNode below) so shapeNode's frontier badge +
//     synthetic load-more child (see shapeLoadMoreChild) render identically
//     whether this node is being shown target-first or as an entry-first
//     boundary root -- the click-to-expand affordance keeps working
//     regardless of orientation, since expanding a node's children is an
//     orientation-independent fact about THAT node, not about the view;
//   - `expandable` also joins the trie merge key (keyOf below), alongside
//     the pre-existing cyclic/truncated/seenElsewhere boundary flags, for
//     the identical reason those are there: a frontier occurrence of a
//     method must never silently merge with a DIFFERENT (expanded, or
//     differently-pending) occurrence of the same method reached over a
//     different edge elsewhere in the tree.
// See test-uitree.js's "entry-first frontier" section for the pinned
// end-to-end proof of this rendering.
// =========================================================================

// The single decision point for "does entry-first actually apply here":
// only when explicitly requested AND the tree is not a callees-direction
// result (absent direction = a pre-v0.7 TreeResult = callers). Everything
// else -- including unknown orientation strings -- is target-first.
function effectiveOrientation(treeResult, orientation) {
  if (orientation !== ORIENTATION_ENTRY_FIRST) return ORIENTATION_TARGET_FIRST;
  if (treeResult && treeResult.direction === 'callees') return ORIENTATION_TARGET_FIRST;
  return ORIENTATION_ENTRY_FIRST;
}

// Pure TNode transform: target-first root -> entry-first root ARRAY (one
// root per distinct entry chain start). Never mutates its input; the
// returned nodes are fresh objects carrying the same contract fields (plus
// the private _entryFirstRoot stamp shapeNode reads). See the ORIENTATION
// section above for the full design.
function rerootEntryFirst(root) {
  if (!root) return [];

  // 1) Every root-to-leaf path of the target-first tree. Bounded by the
  // resolver's own caps (<= 2000 nodes / depth 8), so paths.length is at
  // most the leaf count and the total work is O(nodes * depth).
  const paths = [];
  const walk = (node, acc) => {
    acc.push(node);
    const kids = node.children || [];
    if (!kids.length) paths.push(acc.slice());
    else for (const k of kids) walk(k, acc);
    acc.pop();
  };
  walk(root, []);

  // Identity + incoming-edge merge key (see the ORIENTATION comment).
  // JSON over an explicit field list keeps it deterministic regardless of
  // property order on the source TNodes; undefined serializes as null.
  const keyOf = (src, edgeSrc) =>
    JSON.stringify([
      src.label != null ? src.label : null,
      src.kind != null ? src.kind : null,
      src.className != null ? src.className : null,
      src.path != null ? src.path : null,
      typeof src.line === 'number' ? src.line : null,
      src.package != null ? src.package : null,
      !!src.isTest,
      src.entries || [],
      !!src.caughtHere,
      !!src.cyclic,
      !!src.truncated,
      !!src.seenElsewhere,
      // v0.9 (P1/P3, forward-compat): `expandable` joins the identity key
      // alongside the pre-existing boundary flags above -- see the FRONTIER
      // NODES doc paragraph in the ORIENTATION section above for why. Kept
      // as three separate entries (rather than folding pendingCount/
      // methodKey into a single composite) so the key stays readable/
      // debuggable, matching this array's existing one-field-per-line style.
      !!src.expandable,
      typeof src.pendingCount === 'number' ? src.pendingCount : null,
      src.methodKey != null ? src.methodKey : null,
      edgeSrc ? (edgeSrc.via != null ? edgeSrc.via : null) : null,
      edgeSrc ? !!edgeSrc.approximate : false,
      edgeSrc
        ? (edgeSrc.sites || []).map((s) => [s.path, s.line, s.col, s.lineText, s.argsRendered, s.via, s.overloadSig])
        : null,
    ]);

  // Fresh entry-first TNode: identity fields from `src` (the node itself),
  // edge fields from `edgeSrc` (the next node closer to the entry on the
  // ORIGINAL path -- i.e. this node's new tree-parent's former edge data,
  // which described exactly the edge now connecting the two). A path start
  // (i === 0) has no incoming edge: via null / sites [] / not approximate.
  const makeNode = (src, edgeSrc, isPathStart) => ({
    label: src.label,
    kind: src.kind,
    className: src.className,
    methodLower: src.methodLower,
    path: src.path,
    line: src.line,
    package: src.package,
    entries: src.entries,
    isTest: src.isTest,
    caughtHere: src.caughtHere,
    cyclic: src.cyclic,
    truncated: src.truncated,
    seenElsewhere: src.seenElsewhere,
    // v0.9 (P1/P3, forward-compat): carried through unchanged -- see the
    // FRONTIER NODES doc paragraph above -- so a frontier boundary root's
    // own badge/synthetic-child rendering (shapeNode/shapeLoadMoreChild)
    // works identically in entry-first as it does target-first.
    expandable: src.expandable,
    pendingCount: src.pendingCount,
    methodKey: src.methodKey,
    via: edgeSrc ? edgeSrc.via : null,
    sites: edgeSrc ? edgeSrc.sites || [] : [],
    approximate: edgeSrc ? !!edgeSrc.approximate : false,
    children: [],
    // Genuine entry (an unflagged target-first leaf) at the start of this
    // path -> gets the '◉ root' badge in entry-first (see shapeNode);
    // boundary leaves (cyclic/truncated/seenElsewhere/expandable) do not --
    // see the FRONTIER NODES doc paragraph above for why `expandable` joins
    // this exclusion list one-for-one with the pre-existing three.
    _entryFirstRoot: !!(isPathStart && !src.cyclic && !src.truncated && !src.seenElsewhere && !src.expandable),
  });

  // 2+3) Reverse each path, shift the edge data one step toward the
  // target, and merge into the trie. Insertion order of the Map preserves
  // the target-first tree's own DFS order among roots and siblings.
  const roots = [];
  const rootIndex = new Map();
  for (const path of paths) {
    const rev = path.slice().reverse();
    let list = roots;
    let index = rootIndex;
    for (let i = 0; i < rev.length; i++) {
      const src = rev[i];
      const edgeSrc = i > 0 ? rev[i - 1] : null;
      const key = keyOf(src, edgeSrc);
      let node = index.get(key);
      if (!node) {
        node = makeNode(src, edgeSrc, i === 0);
        node._childIndex = new Map();
        list.push(node);
        index.set(key, node);
      }
      list = node.children;
      index = node._childIndex;
    }
  }

  // Drop the construction-only child indexes so the returned TNodes carry
  // nothing but contract fields + the documented _entryFirstRoot stamp.
  const strip = (nodes) => {
    for (const n of nodes) {
      delete n._childIndex;
      strip(n.children);
    }
  };
  strip(roots);
  return roots;
}

// =========================================================================
// v0.13 (Round 2.5, H3 — header half): SCOPED HEADERS.
//
// Pre-Round-2.5, shapeHeaderLines surfaced three WORKSPACE-GLOBAL counters
// (stats.unresolvedSites, stats.externalRefs/externalNamespaces, stats.
// metaUnresolved -- see the v0.6/v0.8/v0.7.1 comments still on
// shapeHeaderLines below) on every single trace, regardless of which
// method was actually traced. That is workspace-wide bookkeeping unrelated
// to the ONE target being looked at right now -- H3 removes it from the
// per-trace header (stats itself is UNCHANGED: resolver.js keeps computing
// every one of those fields exactly as before, they simply move to being
// exclusively an H8 "Scan Stats" output-channel concern, a different file's
// job this round).
//
// In its place, the CALLER direction only gains ONE new, genuinely SCOPED
// header line: resolver.js's buildCallerTree already computes the "K
// unresolved sites elsewhere mention <method>( — potential unconfirmed
// callers" figure ENGINE-SIDE (see resolver.js's own H3 comment, ahead of
// its `mentionsNode` construction) and renders it as one more ordinary CHILD
// of the traced target -- `kind: 'unresolved-mentions'`, its own `.label`
// ALREADY the complete, exact-wording string, its own `.children` the
// individual mention sites (each a real class/line, via one of resolver.js's
// unresolvedByReason strings -- see the VIA_GLOSSARY additions above). This
// file therefore needs NO new TreeResult field and NO new node-shaping
// function at all: the info node rides through shapeNode/shapeResult like
// any other child (same "walks children purely structurally" posture this
// file already has for flow subflow chains, DML children, etc. -- see
// shapeNode's own comment), picking up its icon/glossary from iconForNode/
// MARKER_GLOSSARY.unresolvedMentions above with zero extra plumbing.
//
// The ONE genuinely new piece of work here is the HEADER BANNER line
// (TreeView.message, via shapeHeaderLines) -- the tree already shows the
// info node as a collapsed row, but a header line surfaces the SAME fact
// without the reader having to scroll past every real caller first. Rather
// than recomputing that wording a second time (risking it drifting from
// resolver.js's own string), unresolvedMentionsHeaderLine below simply
// FINDS the mentionsNode among treeResult.root.children and reuses its
// `.label` VERBATIM.
// =========================================================================

// Finds resolver.js's H3 info node (kind:'unresolved-mentions') among the
// traced target's DIRECT children, or null when absent -- absent covers
// every pre-Round-2.5 TreeResult (no such kind existed), a callee-direction
// TreeResult (resolver.js never adds this kind there -- its existing
// per-method kind:'unresolved' aggregate leaf is "already scoped", per the
// H3 spec), and a genuine K=0 caller-direction trace (resolver.js's own
// `if (mentions.length)` guard means the node simply isn't added at all).
function findUnresolvedMentionsNode(treeResult) {
  const children = treeResult && treeResult.root && Array.isArray(treeResult.root.children) ? treeResult.root.children : [];
  return children.find((c) => c && c.kind === 'unresolved-mentions') || null;
}

// The new scoped header line -- resolver.js's mentionsNode.label VERBATIM
// (already the complete, exact-wording "K unresolved sites elsewhere
// mention <method>( — potential unconfirmed callers" string), or null when
// findUnresolvedMentionsNode finds nothing (see that function's own doc for
// every case that covers).
function unresolvedMentionsHeaderLine(treeResult) {
  if (treeResult && treeResult.direction === 'callees') return null;
  const node = findUnresolvedMentionsNode(treeResult);
  return node ? node.label : null;
}

// treeResult: resolver.js's TreeResult ({ root, targetLabel, note }). Returns
// a single-element array (the traced target as the sole top-level item, its
// callers nested underneath) or [] when there's no root to show.
//
// v0.7 (B3): the traced target IS `treeResult.root` regardless of direction
// (buildCalleeTree's root is the traced method too, per the A2 contract --
// only its `children` mean something different), so `root.package` is
// unambiguously "the target's package" in both directions. This is the one
// and only place `targetPackage` is derived; every descendant node's badge
// is relative to it (see shapeNode/packageBadge above).
//
// v0.7.1: `orientation` optional second argument. Omitted / 'target-first'
// / anything unknown / any callees-direction tree -> the exact pre-v0.7.1
// single-root code path, byte-identical output (test-uitree.js pins this).
// Effective 'entry-first' -> the re-rooted multi-root rendering; note
// `targetPackage` is STILL the traced target's package (the target sits at
// the branch tips there, but "which package is home" doesn't move).
//
// v0.9 (P1/P3): `treeResult.direction` is read here (not a new parameter --
// it is already ON treeResult, unlike orientation which is a display-only
// choice extension.js tracks separately) and threaded down through every
// shapeNode call, so a frontier node's badge/glossary/synthetic child use
// the correct 'callers'/'callees' noun without every caller of shapeResult
// having to pass it explicitly. Absent/'callers' -> frontierNoun's own
// default already reads 'callers', so this is a no-op for every pre-v0.9
// TreeResult shape.
//
// v0.13 (Round 2.5, H2/H3): resolver.js owns grouping and produces both
// rollup and unresolved-mentions TNodes. In target-first mode they flow
// through structurally like every other child. Entry-first is the one
// exception: an unresolved-mentions node is informational, not a caller
// edge, so feeding it to rerootEntryFirst would fabricate execution paths
// from each uncertain site into the target. Strip it from the execution
// tree before re-rooting and append the shaped info node as a separate root
// instead. Rollup nodes remain in the execution tree because they group
// real (albeit approximate) edges.
function shapeResult(treeResult, orientation) {
  if (!treeResult || !treeResult.root) return [];
  const targetPackage = treeResult.root.package || null;
  const direction = treeResult.direction;
  if (effectiveOrientation(treeResult, orientation) === ORIENTATION_ENTRY_FIRST) {
    const mentionNodes = (treeResult.root.children || []).filter((c) => c && c.kind === 'unresolved-mentions');
    const executionRoot = mentionNodes.length
      ? { ...treeResult.root, children: (treeResult.root.children || []).filter((c) => !c || c.kind !== 'unresolved-mentions') }
      : treeResult.root;
    const roots = rerootEntryFirst(executionRoot).map((r) =>
      shapeNode(r, targetPackage, ORIENTATION_ENTRY_FIRST, direction)
    );
    for (const node of mentionNodes) roots.push(shapeNode(node, targetPackage, undefined, direction));
    return roots;
  }
  return [shapeNode(treeResult.root, targetPackage, undefined, direction)];
}

// v0.6 (H1/H4, H5a rendering): plain-string header lines for extension.js to
// surface above the tree (via TreeView.message), alongside (or instead of)
// the existing note toast. Every field checked here is OPTIONAL (a
// not-found target's TreeResult, or an older/synthetic TreeResult, may omit
// stats entirely), so this degrades gracefully rather than throwing:
//   - treeResult.note                 (H4: e.g. 'No callers found — this is
//                                      likely an entry point or unused code.')
//   - treeResult.direction            (v0.7 A3: 'callers'|'callees' -- see
//                                      directionHeaderLine below)
//   - treeResult.stats.duplicateNames (v0.7 B3: workspace-wide count of
//                                      class names bucketed across packages)
//   - treeResult.stats.capped         (H1: buildCallerTree's node cap fired)
//   - treeResult.root.children        (v0.13 Round 2.5 H3: scanned for
//                                      resolver.js's kind:'unresolved-
//                                      mentions' info node -- see the
//                                      SCOPED HEADERS section above
//                                      shapeResult for the full contract;
//                                      NOT a new TreeResult/stats field)
//
// v0.13 (Round 2.5, H3) REMOVED: stats.unresolvedSites, stats.externalRefs/
// externalNamespaces, and stats.metaUnresolved USED to each surface their
// own workspace-global header line here (see the CHANGELOG/git history for
// the exact pre-Round-2.5 wording, still pinned as REGRESSION assertions in
// test-uitree.js proving they no longer fire). Per the H3 spec, a per-trace
// header has no business reporting workspace-wide totals unrelated to the
// ONE method being traced -- `stats` itself is untouched (resolver.js keeps
// computing every one of those fields exactly as before; H8's "Scan Stats"
// output channel, a different file's job this round, is their only
// remaining consumer). The one thing that DOES belong in a trace header is
// the new, genuinely scoped unresolvedMentionsHeaderLine below.
//

// v0.7 (A3) INTERPRETIVE DECISION on the pinned "callers-direction render is
// byte-identical to today" bar: resolver.js's buildCallerTree now stamps
// `direction: 'callers'` on EVERY TreeResult it returns, unconditionally --
// see resolver.js's own comment at the not-found-target shell: "direction is
// now present on EVERY TreeResult ... a brand-new field no pre-v0.7 caller
// could have been reading." Since 'callers' is therefore the universal,
// unconditional state of every real caller-direction TreeResult (not an
// opt-in tag some callers set and others don't), "byte-identical to today"
// can only be satisfied by treating 'callers' -- exactly like an absent
// field -- as the silent, no-new-header-text case. This is also the literal
// mechanism behind the hard-pinned `shapeHeaderLines({ root: {}, targetLabel:
// 'x', note: null })` -> `[]` assertion below (which predates this round)
// AND behind test.js's real end-to-end H4 assertion (a genuine
// buildCallerTree() TreeResult, which now always carries
// `direction: 'callers'`, must still produce exactly the same 2 header
// lines it did before this round) -- both would break if 'callers' surfaced
// new text. Only 'callees' (the genuinely NEW v0.7 capability, and the only
// direction value that did NOT exist before this round) gets an explicit
// sign-post, 'What Does This Call?', mirroring the apexTrace.traceCallees
// command title verbatim (see package.json, not owned by this file) so the
// two names never drift apart -- "who calls this" stays the well-known,
// unlabeled default; "what this calls" is the one new thing worth calling
// out. Only shapeHeaderLines reads `direction` at all -- shapeNode/
// shapeResult (the actual tree content) never look at it, so the tree
// portion of a render is ALWAYS identical regardless of direction tagging
// (see test-uitree.js's own byte-identical assertion for the proof).
function directionHeaderLine(direction) {
  if (direction === 'callees') return 'What Does This Call?';
  return null;
}

// v0.7.1: `orientation` optional second argument, same omitted-means-
// unchanged convention as everywhere else in this file. Only the effective
// 'entry-first' state (never 'callers'+'target-first', which is the
// universal default and must stay byte-identical -- same interpretive rule
// as directionHeaderLine's 'callers' case above) adds a header line
// stating the active orientation, slotted after the note/direction lines
// and before the stats lines.
function shapeHeaderLines(treeResult, orientation) {
  const lines = [];
  const note = treeResult && treeResult.note;
  if (note) lines.push(String(note));
  const directionLine = directionHeaderLine(treeResult && treeResult.direction);
  if (directionLine) lines.push(directionLine);
  if (effectiveOrientation(treeResult, orientation) === ORIENTATION_ENTRY_FIRST) {
    lines.push('Entry-first orientation: entry points at the top, the traced target at each branch tip.');
  }
  const stats = treeResult && treeResult.stats;
  if (stats && typeof stats.duplicateNames === 'number' && stats.duplicateNames > 0) {
    lines.push(
      `${stats.duplicateNames} duplicate class names across packages — resolution prefers the referring file's package`
    );
  }
  if (stats && stats.capped) {
    // v0.7 (A3): the pre-existing wording said "caller" unconditionally --
    // correct for the only direction that existed pre-v0.7, but misleading
    // once the SAME cap/DAG-memoization machinery (per the A2 contract:
    // "REUSE it, do not fork") also runs in the callees direction. Absent/
    // 'callers' keeps the exact original wording (byte-identical, see the
    // note above directionHeaderLine); only 'callees' swaps the noun.
    const cappedNoun = (treeResult && treeResult.direction) === 'callees' ? 'callee' : 'caller';
    lines.push(`Result capped -- not every ${cappedNoun} could be expanded.`);
  }
  // v0.13 (Round 2.5, H3): the ONE new scoped line -- see the SCOPED HEADERS
  // section ahead of shapeResult above for the full contract/rationale and
  // unresolvedMentionsHeaderLine's own doc for the exact gating (K > 0,
  // caller direction only).
  const mentionsLine = unresolvedMentionsHeaderLine(treeResult);
  if (mentionsLine) lines.push(mentionsLine);
  return lines;
}

// =========================================================================
// v0.12.0 / C2 (Entry-Point Catalog): pure shaping of resolver.js's NEW
// buildEntryCatalog(index) export (C1, may still be in flight this round --
// this section and its tests in test-uitree.js are written against the
// documented contract shape only, never against resolver.js's actual
// source, same "code against the frozen contract" discipline this whole
// file already follows for TNode/SiteView above). Feeds the SECOND Explorer
// view ('apexTraceEntriesView', extension.js's job) -- a flat two-level
// tree (kind group -> entries), NOT a recursive call tree, so this reuses
// the UiNode shape (label/description/tooltip/iconId/jump/collapsible/
// children) but adds three fields meaningful ONLY here (extension.js's
// dedicated toEntryCatalogTreeItem reads them; the ordinary trace-tree
// toTreeItem/shapeResult path never sees them):
//   - isGroup: true on a kind-group node, undefined on an entry leaf.
//   - expanded: boolean, ONLY on a group node -- per the C2 contract every
//     group starts collapsed except 'trigger' and 'flow' (EXPANDED_KINDS
//     below); an EMPTY group (zero entries) is additionally rendered
//     non-collapsible at all (`collapsible: false`) -- nothing to expand,
//     so no expand arrow -- via collapsible rather than expanded.
//   - entryTarget: { classLower, methodLower } | null, ONLY on an entry
//     leaf -- the target extension.js' inline "What Does This Call?" action
//     hands straight to resolver.buildCalleeTree(index, target, opts),
//     exactly the same {classLower, methodLower} shape resolveTarget()/
//     buildSuggestPicks() already produce for the interactive QuickPick
//     path. Derived generically from Entry.className/methodLower (both
//     present -> a real Apex target; classLower is the lowercased
//     className, methodLower passed through as-is since the C1 contract's
//     Entry.methodLower is already lowercase, matching every existing
//     pseudo-method convention in this codebase: '(trigger)' for trigger
//     entries, '(anonymous)' for anonymous-script entries, an ordinary
//     lowercased method name for everything else). null whenever EITHER is
//     null -- per the C1 contract text this is flow entries ALWAYS
//     ("flow: ... className|null, methodLower|null"), since a Flow is not
//     an Apex class/method buildCalleeTree can target; extension.js's
//     inline-action handler degrades that case to a no-op toast, per the
//     C2 contract's "flows: run the callee trace only when the flow has
//     traceable children -- else no-op toast, documented" text (documented
//     here: today's C1 contract never gives a flow entry a target at all,
//     so the "has traceable children" case is a no-op right now for every
//     entry this file shapes -- if a future resolver.js round ever DOES
//     attach a real Apex target to some flow entries, this same generic
//     className+methodLower derivation picks it up automatically, no
//     uitree.js change needed).
//
// Copied verbatim from the frozen "=== CONTRACT: resolver.js ===" C1 text
// this round:
//
//   Catalog = { groups: [Group], stats: { total, byKind: {kind: n}, packages: [labels] } }
//   Group = { kind, label, entries: [Entry] }
//     kind in this EXACT display order: trigger, aura, invocable, rest,
//     soap, async, email, platform, flow, anonymous.
//   Entry = {
//     label,               // 'Cls.method' | 'TriggerName' | flow API name | script name
//     className, methodLower, path, line,
//     detail,              // trigger: 'on <Object> (<events>)'; rest: the
//                           // @HttpX verb(s); async: 'Batchable'|
//                           // 'Queueable'|'Schedulable'|'@future'; flow:
//                           // '<triggerType> on <Object>' or 'screen'|
//                           // 'scheduled'|'platform event on <Object>';
//                           // others: the entry annotation label.
//     package,             // string|null, only when != the default package.
//   }
//   stats.excludedTestEntries -- count of isTest-excluded entries (not part
//   of any group, workspace-wide).
// =========================================================================

// v0.12.0 (C2): group kinds that render pre-expanded (TreeItemCollapsible-
// State.Expanded) the first time the catalog is shown -- triggers and flows
// are the two kinds a Salesforce developer orienting on "how does the org
// get entered" most wants to see without an extra click; every other kind
// starts collapsed. `label`/`invocable`/etc. never appear here.
const ENTRY_CATALOG_EXPANDED_KINDS = new Set(['trigger', 'flow']);

// v0.12.0 (C2): one icon per Group.kind, in the SAME display order the C1
// contract pins (trigger, aura, invocable, rest, soap, async, email,
// platform, flow, anonymous) -- purely so a reader scanning this table can
// check it against that order at a glance. 'trigger'/'flow'/'anonymous'
// deliberately reuse ICON_TRIGGER/ICON_FLOW/ICON_ANONYMOUS (declared far
// above) rather than picking new glyphs, so a trigger/flow/anonymous-script
// node looks the SAME in this view as it does as a caller/callee-tree node
// elsewhere in the extension -- one visual vocabulary, not two. The other
// six kinds have no existing analog in the caller/callee tree (that tree
// only ever shows a plain 'method' node for an @AuraEnabled/@InvocableMethod
// /@HttpX/webservice/Batchable-Queueable-Schedulable-or-@future/
// InboundEmailHandler/platform-hook method -- the entries[] BADGE is what
// names the annotation there, not a distinct icon), so each gets its own
// new, semantically-fitting codicon id.
const ENTRY_CATALOG_ICON_BY_KIND = {
  trigger: ICON_TRIGGER,
  aura: 'radio-tower',
  invocable: 'gear',
  rest: 'globe',
  soap: 'server-process',
  async: 'watch',
  email: 'mail',
  platform: 'shield',
  flow: ICON_FLOW,
  anonymous: ICON_ANONYMOUS,
};

// v0.12.0 (C2): one-line "what is this kind" explanation per Group.kind --
// the glossary/tooltip text the C2 contract asks this file to own (group
// label wording itself comes verbatim from resolver.js's Group.label, per
// the contract; this is the ADDITIONAL explanatory line uitree.js adds on
// top, exactly like VIA_GLOSSARY/MARKER_GLOSSARY do for the caller/callee
// tree above). Rendered on both the group node's own tooltip and appended
// to every entry leaf's tooltip within that group (see entryTooltip below).
const ENTRY_CATALOG_KIND_GLOSSARY = {
  trigger: 'Apex trigger — fires on DML against a specific object.',
  aura: '@AuraEnabled method — callable from Aura components and Lightning Web Components.',
  invocable: '@InvocableMethod method — callable as a Flow or Process Builder action.',
  rest: '@HttpGet/@HttpPost/@HttpPut/@HttpPatch/@HttpDelete method on an @RestResource class — callable via the REST API.',
  soap: 'webservice method — callable via the SOAP API.',
  async: 'Batchable/Queueable/Schedulable execute method or @future method — runs asynchronously, not from a direct call site.',
  email: 'Apex email service class (implements Messaging.InboundEmailHandler) — invoked when mail arrives at its service address.',
  platform: 'platform-invoked hook (Install/Uninstall/RegistrationHandler/Comparable/Finalizer) — called by the platform itself, not application code.',
  flow: 'Flow — screen, record-triggered, scheduled, autolaunched, or platform-event flow found in this workspace.',
  anonymous: 'anonymous Apex script (.apex) — an ad hoc entry point, e.g. a one-off data-fix script.',
};

// Fallback display label, used ONLY when a Group arrives with a falsy
// `label` (defensive -- the C1 contract always supplies one; this just
// keeps a malformed/partial fixture from rendering a blank tree row instead
// of throwing, same defensive spirit as this file's other `|| fallback`
// idioms, e.g. externalNamespace's label-derived fallback).
const ENTRY_CATALOG_KIND_FALLBACK_LABEL = {
  trigger: 'Triggers',
  aura: 'Aura / LWC (@AuraEnabled)',
  invocable: 'Invocable Actions',
  rest: 'REST Endpoints',
  soap: 'SOAP Web Services',
  async: 'Async (Batch / Queueable / Schedulable / @future)',
  email: 'Email Handlers',
  platform: 'Platform Hooks',
  flow: 'Flows',
  anonymous: 'Anonymous Scripts',
};

// v0.12.0 (C2): derives the {classLower, methodLower} extension.js's inline
// "What Does This Call?" action hands to resolver.buildCalleeTree, or null
// when this entry carries no traceable Apex target -- see the section
// header above for the full rationale (generic derivation, not
// kind-specific: every existing pseudo-method convention -- '(trigger)',
// '(anonymous)', an ordinary lowercased method name -- already arrives on
// Entry.methodLower exactly as buildCalleeTree expects it).
function entryCatalogTarget(entry) {
  if (!entry || !entry.className || !entry.methodLower) return null;
  return { classLower: String(entry.className).toLowerCase(), methodLower: entry.methodLower };
}

// v0.12.0 (C2): entry leaf description badge -- `detail` (the kind-specific
// one-liner the C1 contract documents, e.g. 'on Account (before insert,
// after update)') plus a '(pkgLabel)' badge when `package` is present,
// mirroring packageBadge's own '(...)' formatting elsewhere in this file
// (deliberately NOT reusing packageBadge() itself -- that function compares
// against a tree-wide `targetPackage` this flat catalog has no equivalent
// of; Entry.package is already contract-documented as "only when != the
// default package", i.e. pre-filtered by resolver.js, so every non-null
// value here is meant to render).
function entryCatalogDescription(entry) {
  const parts = [];
  if (entry && entry.detail) parts.push(String(entry.detail));
  if (entry && entry.package) parts.push(`(${entry.package})`);
  return parts.join(' · ');
}

// v0.12.0 (C2): entry leaf tooltip -- source location, the detail line
// again (in full, in case the description badge above got visually
// truncated by a narrow Explorer pane), the kind glossary line, and the
// package explainer (reusing MARKER_GLOSSARY.package's exact wording, same
// glossary line the caller/callee tree's own package badge uses -- one
// consistent explanation for what a '(pkgLabel)' badge means anywhere in
// this extension).
function entryCatalogEntryTooltip(kind, entry) {
  const lines = [];
  if (entry && entry.path) {
    lines.push(typeof entry.line === 'number' && entry.line > 0 ? `${entry.path}:${entry.line}` : entry.path);
  }
  if (entry && entry.detail) lines.push(String(entry.detail));
  if (ENTRY_CATALOG_KIND_GLOSSARY[kind]) lines.push(ENTRY_CATALOG_KIND_GLOSSARY[kind]);
  if (entry && entry.package) lines.push(`(${entry.package}) — ${MARKER_GLOSSARY.package}`);
  return lines.join('\n');
}

// v0.12.0 (C2): shapes ONE Entry into a leaf UiNode. `kind` is threaded in
// by the caller (shapeEntryCatalogGroup) rather than read off `entry`
// itself -- Entry per the C1 contract carries no `kind` field of its own,
// only its enclosing Group does.
function shapeEntryCatalogEntry(kind, entry) {
  const hasLine = entry && typeof entry.line === 'number' && entry.line > 0;
  return {
    label: (entry && entry.label) || '',
    description: entryCatalogDescription(entry),
    tooltip: entryCatalogEntryTooltip(kind, entry),
    iconId: ENTRY_CATALOG_ICON_BY_KIND[kind] || ICON_ENTRIES,
    jump: entry && entry.path && hasLine ? { path: entry.path, line: entry.line, col: 0 } : null,
    collapsible: false,
    children: [],
    isGroup: false,
    kind,
    entryTarget: entryCatalogTarget(entry),
  };
}

// v0.12.0 (C2): shapes ONE Group into a group UiNode whose `children` are
// its shaped Entry leaves, stable-sorted exactly as resolver.js's C1
// contract already promises ("stable sort by label" -- this file trusts
// that ordering and does not re-sort, same "resolver.js is the sorting
// authority" convention shapeResult already follows for TNode.children
// above).
function shapeEntryCatalogGroup(group) {
  const kind = group && group.kind;
  const entries = (group && Array.isArray(group.entries)) ? group.entries : [];
  const children = entries.map((e) => shapeEntryCatalogEntry(kind, e));
  const hasEntries = children.length > 0;
  return {
    label: (group && group.label) || ENTRY_CATALOG_KIND_FALLBACK_LABEL[kind] || kind || '',
    description: String(children.length),
    tooltip: ENTRY_CATALOG_KIND_GLOSSARY[kind] || '',
    iconId: ENTRY_CATALOG_ICON_BY_KIND[kind] || ICON_ENTRIES,
    jump: null,
    // Only a group with at least one entry is collapsible at all -- an
    // empty group (0 entries) renders as a plain, non-expandable row (no
    // arrow to click into nothing), matching `expanded: false` for it too.
    collapsible: hasEntries,
    expanded: hasEntries && ENTRY_CATALOG_EXPANDED_KINDS.has(kind),
    children,
    isGroup: true,
    kind,
  };
}

// v0.12.0 (C2): Catalog -> UiNode[] (one root per Group, in the C1
// contract's fixed kind order -- this file trusts and preserves
// `catalog.groups`' own order, it never reorders). Defensive against a
// malformed/absent catalog (e.g. a resolver.js build that hasn't landed C1
// yet -- extension.js's own `typeof resolver.buildEntryCatalog === 'function'`
// guard is the first line of defense there, but this stays cheap and safe
// to call standalone too, same "never throw on a shape it wasn't handed"
// discipline as shapeResult above).
function shapeEntryCatalog(catalog) {
  if (!catalog || !Array.isArray(catalog.groups)) return [];
  return catalog.groups.map(shapeEntryCatalogGroup);
}

// v0.12.0 (C2): one-line, human-readable summary of Catalog.stats --
// extension.js sets this as the entry-catalog view's persistent banner
// (TreeView.message, the SAME mechanism renderTraceResult already uses for
// the caller/callee view's header lines above), satisfying the C2
// contract's "header/first-line shows stats totals". Degrades to '' (never
// throws) on a missing/malformed `stats`, matching shapeHeaderLines'
// own graceful-degradation convention for a not-yet-produced field.
function shapeEntryCatalogHeaderLine(catalog) {
  const stats = catalog && catalog.stats;
  if (!stats || typeof stats.total !== 'number') return '';
  // The total + kind-count facts read as ONE clause ('42 entry points
  // across 2 kinds'), not two ' · '-separated ones -- everything else
  // pushed onto `parts` below IS its own ' · '-separated clause.
  const kindsCount = stats.byKind && typeof stats.byKind === 'object' ? Object.keys(stats.byKind).length : 0;
  let headline = `${stats.total} entry point${stats.total === 1 ? '' : 's'}`;
  if (kindsCount > 0) headline += ` across ${kindsCount} kind${kindsCount === 1 ? '' : 's'}`;
  const parts = [headline];
  if (typeof stats.excludedTestEntries === 'number' && stats.excludedTestEntries > 0) {
    parts.push(`${stats.excludedTestEntries} test-class entr${stats.excludedTestEntries === 1 ? 'y' : 'ies'} excluded`);
  }
  if (typeof stats.unresolvedSites === 'number') {
    parts.push(`${stats.unresolvedSites} unresolved site${stats.unresolvedSites === 1 ? '' : 's'}`);
  }
  if (typeof stats.managedRefs === 'number') {
    parts.push(`${stats.managedRefs} managed reference${stats.managedRefs === 1 ? '' : 's'}`);
  }
  if (Array.isArray(stats.packages) && stats.packages.length) {
    parts.push(`packages: ${stats.packages.join(', ')}`);
  }
  return parts.join(' · ');
}

// =========================================================================
// v0.14 Impact Analysis: sectioned report -> ordinary UiNode[]
// =========================================================================

function impactSiteLabel(site) {
  if (!site) return '';
  return site.callerMethod ? `${site.callerClass}.${site.callerMethod}` : String(site.callerClass || '');
}

function shapeImpactSite(site, severity) {
  const location = site && site.path
    ? `${site.path}${site.line ? `:${site.line}` : ''}`
    : '';
  const details = [];
  if (location) details.push(location);
  if (site && site.lineText) details.push(String(site.lineText));
  if (site && site.overloadSig) details.push(`selected ${site.overloadSig} (${site.overloadPick || 'exact'})`);
  return {
    label: impactSiteLabel(site),
    description: [site && site.via, site && site.overloadPick].filter(Boolean).join(' · '),
    tooltip: details.join('\n'),
    iconId: severity === 'break' ? 'error' : 'warning',
    jump: site && site.path && site.line ? { path: site.path, line: site.line, col: site.col || 0 } : null,
    collapsible: false,
    children: [],
  };
}

function impactSection(label, children, iconId, expanded) {
  const rows = Array.isArray(children) ? children : [];
  return {
    label,
    description: String(rows.length),
    tooltip: `${rows.length} ${label.toLowerCase()} item${rows.length === 1 ? '' : 's'}`,
    iconId,
    jump: null,
    collapsible: rows.length > 0,
    expanded: rows.length > 0 && expanded !== false,
    children: rows,
    isImpactSection: true,
  };
}

function shapeImpactContract(report) {
  const contract = report && report.contract ? report.contract : {};
  const rows = [];
  for (const iface of contract.interfaces || []) {
    const callers = (iface.callers || []).map((site) => shapeImpactSite(site, 'uncertain'));
    rows.push({
      label: `${iface.iface}.${iface.overloadSig || iface.method || ''}`,
      description: `interface · ${callers.length} caller${callers.length === 1 ? '' : 's'}`,
      tooltip: iface.path ? `${iface.path}${iface.line ? `:${iface.line}` : ''}` : 'Interface contract',
      iconId: 'symbol-interface',
      jump: iface.path && iface.line ? { path: iface.path, line: iface.line, col: 0 } : null,
      collapsible: callers.length > 0,
      children: callers,
    });
  }
  const overrides = contract.overrides || {};
  if (overrides.base) {
    const callers = (overrides.callersOfBase || []).map((site) => shapeImpactSite(site, 'uncertain'));
    rows.push({
      label: overrides.base.label,
      description: `overrides base · ${callers.length} caller${callers.length === 1 ? '' : 's'}`,
      tooltip: overrides.base.path ? `${overrides.base.path}${overrides.base.line ? `:${overrides.base.line}` : ''}` : 'Overridden base declaration',
      iconId: 'arrow-up',
      jump: overrides.base.path && overrides.base.line ? { path: overrides.base.path, line: overrides.base.line, col: 0 } : null,
      collapsible: callers.length > 0,
      children: callers,
    });
  }
  for (const override of overrides.overriddenBy || []) {
    rows.push({
      label: override.label,
      description: 'overridden by',
      tooltip: override.path ? `${override.path}${override.line ? `:${override.line}` : ''}` : 'Overriding declaration',
      iconId: 'arrow-down',
      jump: override.path && override.line ? { path: override.path, line: override.line, col: 0 } : null,
      collapsible: false,
      children: [],
    });
  }
  return rows;
}

function shapeImpactMetadata(metadata) {
  return (metadata || []).map((site) => {
    const parents = (site.parentFlows || []).map((flow) => ({
      label: flow.label,
      description: 'parent flow',
      tooltip: flow.path ? `${flow.path}${flow.line ? `:${flow.line}` : ''}` : 'Parent flow in the invocation chain',
      iconId: 'symbol-event',
      jump: flow.path && flow.line ? { path: flow.path, line: flow.line, col: 0 } : null,
      collapsible: false,
      children: [],
    }));
    return {
      label: site.label,
      description: [site.kind, parents.length ? `${parents.length} parent flow${parents.length === 1 ? '' : 's'}` : null].filter(Boolean).join(' · '),
      tooltip: site.path ? `${site.path}${site.line ? `:${site.line}` : ''}` : 'Metadata contract surface',
      iconId: META_ICON_BY_KIND[site.kind] || 'references',
      jump: site.path && site.line ? { path: site.path, line: site.line, col: 0 } : null,
      collapsible: parents.length > 0,
      children: parents,
    };
  });
}

function shapeImpactReport(report) {
  if (!report || !report.target) return [];
  const breaks = (report.breaks || []).map((site) => shapeImpactSite(site, 'break'));
  const mightBreak = (report.mightBreak || []).map((site) => shapeImpactSite(site, 'uncertain'));
  const contract = shapeImpactContract(report);
  const metadata = shapeImpactMetadata(report.metadata || []);
  const otherOverloads = (report.otherOverloads || []).map((overload) => ({
    label: overload.overloadSig,
    description: `${overload.callerCount || 0} caller${overload.callerCount === 1 ? '' : 's'}`,
    tooltip: overload.path ? `${overload.path}${overload.line ? `:${overload.line}` : ''}` : 'Other overload',
    iconId: 'symbol-method',
    jump: overload.path && overload.line ? { path: overload.path, line: overload.line, col: 0 } : null,
    collapsible: false,
    children: [],
  }));
  return [
    impactSection('BREAKS', breaks, 'error', true),
    impactSection('MIGHT BREAK', mightBreak, 'warning', true),
    impactSection('CONTRACT', contract, 'symbol-interface', true),
    impactSection('METADATA', metadata, 'references', true),
    impactSection('OTHER OVERLOADS', otherOverloads, 'symbol-method', false),
  ];
}

function shapeImpactHeaderLine(report) {
  const stats = report && report.stats;
  if (!stats) return '';
  return `${stats.breaks || 0} direct break${stats.breaks === 1 ? '' : 's'} · `
    + `${stats.mightBreak || 0} uncertain · `
    + `${stats.contractSurfaces || 0} contract surface${stats.contractSurfaces === 1 ? '' : 's'} · `
    + `${stats.metadataSurfaces || 0} metadata surface${stats.metadataSurfaces === 1 ? '' : 's'}`;
}

module.exports = {
  iconForNode,
  labelForNode,
  badgesForNode,
  packageBadge,
  // v0.8 (N4/N6): external-node badge helpers, exported so test-uitree.js
  // can unit-test them directly against bare fixtures, same rationale as
  // packageBadge/isRootNode above.
  externalNamespace,
  managedBadge,
  isRootNode,
  siteLabel,
  siteDetailLine,
  siteTooltip,
  shapeSite,
  shapeNode,
  shapeResult,
  directionHeaderLine,
  shapeHeaderLines,
  // v0.7.1 orientation surface (see the ORIENTATION section above).
  effectiveOrientation,
  rerootEntryFirst,
  // v0.9 (P1/P3): progressive-depth frontier helpers, exported so
  // test-uitree.js can unit-test them directly against bare fixtures, same
  // rationale as externalNamespace/managedBadge above.
  frontierMethodKey,
  frontierBadge,
  shapeLoadMoreChild,
  // v0.12.0 (C2): Entry-Point Catalog shaping surface -- see the section
  // header above shapeEntryCatalog for the full contract. Granular helpers
  // (shapeEntryCatalogEntry/Group, entryCatalogTarget) exported so
  // test-uitree.js can unit-test them directly against bare fixtures, same
  // rationale as externalNamespace/managedBadge/frontierMethodKey above.
  entryCatalogTarget,
  shapeEntryCatalogEntry,
  shapeEntryCatalogGroup,
  shapeEntryCatalog,
  shapeEntryCatalogHeaderLine,
  shapeImpactSite,
  shapeImpactReport,
  shapeImpactHeaderLine,
  // v0.13 (Round 2.5, H3 -- header half): SCOPED HEADERS surface, exported
  // so test-uitree.js can unit-test these directly against bare fixtures,
  // same rationale as externalNamespace/managedBadge/frontierMethodKey
  // above. (H2's rollup grouping has no dedicated export here -- it needs
  // none: resolver.js already produces the grouped tree, and this file
  // renders it via the ordinary iconForNode/VIA_GLOSSARY/MARKER_GLOSSARY
  // surface already exported above, same as every other TNode.kind.)
  findUnresolvedMentionsNode,
  unresolvedMentionsHeaderLine,
};

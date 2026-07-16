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
//                               // a guess) -- this file renders whatever
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

// Badge order per contract: entries · caughtHere (shield) · test · via ·
// managed:<ns> (v0.8 N4) · package (v0.7 B3) · '~' when approximate ·
// '↺ cycle' · '… capped' · '↪ seen elsewhere'.
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
function isRootNode(node) {
  if (!node) return false;
  const hasChildren = !!(node.children && node.children.length);
  return !hasChildren && !node.cyclic && !node.truncated && !node.seenElsewhere;
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
};

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
function glossaryLinesForNode(node, pkgBadge, orientation) {
  const entryFirst = orientation === ORIENTATION_ENTRY_FIRST;
  const lines = [];
  if (node && node.via && VIA_GLOSSARY[node.via]) lines.push(`${node.via}: ${VIA_GLOSSARY[node.via]}`);
  if (entryFirst && node && (node.via || (node.sites && node.sites.length))) {
    lines.push(MARKER_GLOSSARY.entryFirstEdge);
  }
  if (node && node.approximate) lines.push(MARKER_GLOSSARY.approximate);
  if (node && node.caughtHere) lines.push(MARKER_GLOSSARY.caughtHere);
  if (node && node.cyclic) lines.push(MARKER_GLOSSARY.cyclic);
  if (node && node.truncated) lines.push(MARKER_GLOSSARY.truncated);
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
function nodeTooltip(node, pkgBadge, orientation) {
  const lines = [];
  if (node && node.path) lines.push(node.path);
  const glossary = glossaryLinesForNode(node, pkgBadge, orientation);
  if (glossary.length) {
    if (lines.length) lines.push('');
    lines.push(...glossary);
  }
  return lines.join('\n');
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
function shapeNode(node, targetPackage, orientation) {
  const entryFirst = orientation === ORIENTATION_ENTRY_FIRST;
  const uiSites = (node.sites || []).map(shapeSite);
  const uiChildren = (node.children || []).map((child) => shapeNode(child, targetPackage, orientation));
  const kids = uiSites.concat(uiChildren);
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
    tooltip: nodeTooltip(node, pkgBadge, orientation),
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
    via: edgeSrc ? edgeSrc.via : null,
    sites: edgeSrc ? edgeSrc.sites || [] : [],
    approximate: edgeSrc ? !!edgeSrc.approximate : false,
    children: [],
    // Genuine entry (an unflagged target-first leaf) at the start of this
    // path -> gets the '◉ root' badge in entry-first (see shapeNode);
    // boundary leaves (cyclic/truncated/seenElsewhere) do not.
    _entryFirstRoot: !!(isPathStart && !src.cyclic && !src.truncated && !src.seenElsewhere),
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
function shapeResult(treeResult, orientation) {
  if (!treeResult || !treeResult.root) return [];
  const targetPackage = treeResult.root.package || null;
  if (effectiveOrientation(treeResult, orientation) === ORIENTATION_ENTRY_FIRST) {
    return rerootEntryFirst(treeResult.root).map((r) => shapeNode(r, targetPackage, ORIENTATION_ENTRY_FIRST));
  }
  return [shapeNode(treeResult.root, targetPackage)];
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
//   - treeResult.stats.unresolvedSites (H4: workspace-wide dropped-call-site
//                                      count -- nested under stats, matching
//                                      resolver.js's real buildCallerTree
//                                      return shape, NOT a top-level
//                                      TreeResult.unresolvedSites field).
//   - treeResult.stats.metaUnresolved (v0.7.1 U3/M2 coordination point:
//                                      workspace-wide count of namespaced
//                                      metadata refs -- LWC/Aura/Flow/etc.
//                                      imports -- that attachMetaCallers()
//                                      could not attach to exactly one local
//                                      class and therefore dropped rather
//                                      than mis-pointing at an unrelated
//                                      same-name local class. Same
//                                      nested-under-stats / not-yet-produced-
//                                      by-every-TreeResult shape as
//                                      unresolvedSites above.)
//   - treeResult.stats.externalRefs / treeResult.stats.externalNamespaces
//                                     (v0.8 N5, forward-compat -- resolver.js
//                                      does not produce either field yet):
//                                      workspace-wide count of references now
//                                      modeled as external (managed-package)
//                                      nodes, and the sorted list of distinct
//                                      namespaces they belong to. Per N5,
//                                      these references are REMOVED from
//                                      unresolvedSites' count, so this file
//                                      renders ONE combined line ('N
//                                      unresolved · M managed-package refs
//                                      (ns1, ns2)') whenever externalRefs > 0,
//                                      instead of the plain unresolvedSites
//                                      line -- see the code below for the
//                                      exact byte-identical-when-absent gate.
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
  const unresolved = stats && stats.unresolvedSites;
  // v0.8 (N5, forward-compat -- resolver.js does not produce
  // stats.externalRefs/stats.externalNamespaces yet): per N5's CONTRACT
  // AMENDMENT text, once references are modeled as external nodes they are
  // REMOVED from the unresolved tally, and the header "show[s] both: 'N
  // unresolved · M managed-package refs (zenq, kwx)'". Gated strictly behind
  // `externalRefs > 0` so a workspace with NO namespaced refs at all (every
  // pre-v0.8 fixture, and adv-org's whole corpus per the v0.8 REGRESSION
  // POLICY) takes the untouched `else` branch below and renders the EXACT
  // pre-v0.8 wording -- this is what keeps that 10-target byte-identical bar
  // satisfiable by a purely additive change here.
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
  // v0.7.1 (U3, M2 coordination point): anticipates metascan.js/resolver.js's
  // planned attachMetaCallers() candidate-count gate -- a namespaced meta
  // ref (LWC/Aura/Flow/etc. import naming a managed-package Apex method)
  // that cannot be attached to exactly one local class under its own
  // namespace is dropped rather than mis-pointed at an unrelated same-name
  // local class, and counted in this stat instead. Mirrors the
  // unresolvedSites line immediately above -- same "nested under stats"
  // shape, same degrade-gracefully-when-absent behavior for every
  // pre-v0.7.1 TreeResult. INTEGRATION NOTE: 'metaUnresolved' is the exact
  // field name given in the fix spec; if the resolver/metascan owner lands
  // it under a different name, update this key to match.
  const metaUnresolved = stats && stats.metaUnresolved;
  if (typeof metaUnresolved === 'number' && metaUnresolved > 0) {
    lines.push(
      `${metaUnresolved} metadata reference${metaUnresolved === 1 ? '' : 's'} could not be attached (ambiguous or unmatched namespace).`
    );
  }
  return lines;
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
};

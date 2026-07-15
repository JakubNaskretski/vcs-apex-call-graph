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
//                   // caller kind; always a pure root, per the G4 spec) --
//                   // NOTE (v0.4 F1b): 'flow' nodes are no longer
//                   // guaranteed terminal -- a record-triggered flow's
//                   // children are the DML sites on its object
//                   // (resolver.js's doing; this file already renders
//                   // ANY node's children generically, so no special-
//                   // casing was needed here for that).
//     className, path, line,   // line = decl line for jump
//     entries: [string], isTest,
//     via: string|null,        // 'typed'|'static'|'new'|'this'|'super'|
//                               // 'interface'|'unique-name'|'lexical'|
//                               // 'metadata'|'dml'|'dynamic'|'override'
//                               // (v0.4 adds the last three)|'publish'|
//                               // 'throws'|'narrowed'|'async' (v0.5 G1/G2/
//                               // G3/G5 add these four -- only 'narrowed' is
//                               // approximate) -- this file renders whatever
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

const ICON_TRIGGER = 'zap';
const ICON_TEST = 'beaker';
const ICON_ENTRIES = 'plug';
const ICON_METHOD = 'symbol-method';
const ICON_CLASS = 'symbol-class';

// v0.5 (G4): anonymous-Apex-script node icon -- Apex-source family, checked
// alongside ICON_TRIGGER below, NOT part of META_ICON_BY_KIND (that map is
// for the non-Apex metadata-caller kinds only).
const ICON_ANONYMOUS = 'terminal';

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

// Badge order per contract: entries · caughtHere (shield) · test · via ·
// '~' when approximate · '↺ cycle' · '… depth cap' · '↪ seen elsewhere'.
// (The 'root' badge is NOT added here -- see isRootNode/shapeNode below: it
// depends on the shaped `children` count, which this per-node-flags
// function deliberately does not compute, so it stays cheaply unit-testable
// against partial TNode fixtures.)
// v0.5 (G2): caughtHere gets its own shield-glyph badge, IN ADDITION to the
// 'catches <ExcName>' text resolver.js already stamps into `entries` for the
// same node (see the TNode.caughtHere doc above) -- the glyph is a quick
// visual flag, the entries text (already rendered by the line above) is the
// actual exception name.
function badgesForNode(node) {
  const badges = [];
  if (node.entries && node.entries.length) badges.push(node.entries.join(', '));
  if (node.caughtHere) badges.push('🛡');
  if (node.isTest) badges.push('test');
  if (node.via) badges.push(node.via);
  if (node.approximate) badges.push('~');
  if (node.cyclic) badges.push('↺ cycle');
  if (node.truncated) badges.push('… depth cap');
  // v0.6 (H1 forward-compat, H5 rendering): resolver.js does not produce
  // TNode.seenElsewhere yet -- this is purely additive and a no-op today.
  if (node.seenElsewhere) badges.push('↪ seen elsewhere');
  return badges;
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
};

const MARKER_GLOSSARY = {
  approximate: '~ — approximate resolution: this edge may be wrong or one of several candidates',
  caughtHere: '🛡 caughtHere — an ancestor catch clause here catches the exception being traced; traversal still continues past it (rethrow is unknowable)',
  cyclic: '↺ cycle — this call chain recurses back on itself here',
  truncated: '… depth cap — trace depth cap reached; more callers may exist above this node',
  seenElsewhere: '↪ seen elsewhere — this subtree was already expanded once elsewhere in this trace; its own call sites are still shown, only the deeper callers above it are collapsed',
  root: '◉ root — no known caller in this trace: an entry point or unused/dead code',
};

function glossaryLinesForNode(node) {
  const lines = [];
  if (node && node.via && VIA_GLOSSARY[node.via]) lines.push(`${node.via}: ${VIA_GLOSSARY[node.via]}`);
  if (node && node.approximate) lines.push(MARKER_GLOSSARY.approximate);
  if (node && node.caughtHere) lines.push(MARKER_GLOSSARY.caughtHere);
  if (node && node.cyclic) lines.push(MARKER_GLOSSARY.cyclic);
  if (node && node.truncated) lines.push(MARKER_GLOSSARY.truncated);
  if (node && node.seenElsewhere) lines.push(MARKER_GLOSSARY.seenElsewhere);
  if (isRootNode(node)) lines.push(MARKER_GLOSSARY.root);
  return lines;
}

// Node tooltip: the source path (as before), plus a one-line-per-badge
// glossary explaining every marker this specific node carries. No existing
// caller relied on the node tooltip being exactly `node.path` (only site
// tooltips are pinned by contract/tests), so this is a pure addition.
function nodeTooltip(node) {
  const lines = [];
  if (node && node.path) lines.push(node.path);
  const glossary = glossaryLinesForNode(node);
  if (glossary.length) {
    if (lines.length) lines.push('');
    lines.push(...glossary);
  }
  return lines.join('\n');
}

// Recursive TNode -> UiNode. Sites render before child caller nodes (call
// sites at this node come first, then the deeper callers of this caller) —
// order within each group is preserved from resolver.js's output.
function shapeNode(node) {
  const uiSites = (node.sites || []).map(shapeSite);
  const uiChildren = (node.children || []).map(shapeNode);
  const kids = uiSites.concat(uiChildren);
  const badges = badgesForNode(node);
  // v0.6 (H3): appended last -- root is mutually exclusive with
  // cyclic/truncated/seenElsewhere by construction (isRootNode), so its
  // position relative to those is moot; this ordering matches the README's
  // own 'entries · via · root' example exactly whenever nothing else fires.
  if (isRootNode(node)) badges.push('◉ root');
  return {
    label: labelForNode(node),
    description: badges.join(' · '),
    tooltip: nodeTooltip(node),
    iconId: iconForNode(node),
    jump: node.path && typeof node.line === 'number' ? { path: node.path, line: node.line, col: 0 } : null,
    collapsible: kids.length > 0,
    children: kids,
  };
}

// treeResult: resolver.js's TreeResult ({ root, targetLabel, note }). Returns
// a single-element array (the traced target as the sole top-level item, its
// callers nested underneath) or [] when there's no root to show.
function shapeResult(treeResult) {
  if (!treeResult || !treeResult.root) return [];
  return [shapeNode(treeResult.root)];
}

// v0.6 (H1/H4, H5a rendering): plain-string header lines for extension.js to
// surface above the tree (via TreeView.message), alongside (or instead of)
// the existing note toast. Every field checked here is OPTIONAL (a
// not-found target's TreeResult, or an older/synthetic TreeResult, may omit
// stats entirely), so this degrades gracefully rather than throwing:
//   - treeResult.note                 (H4: e.g. 'No callers found — this is
//                                      likely an entry point or unused code.')
//   - treeResult.stats.capped         (H1: buildCallerTree's node cap fired)
//   - treeResult.stats.unresolvedSites (H4: workspace-wide dropped-call-site
//                                      count -- nested under stats, matching
//                                      resolver.js's real buildCallerTree
//                                      return shape, NOT a top-level
//                                      TreeResult.unresolvedSites field).
function shapeHeaderLines(treeResult) {
  const lines = [];
  const note = treeResult && treeResult.note;
  if (note) lines.push(String(note));
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

module.exports = {
  iconForNode,
  labelForNode,
  badgesForNode,
  isRootNode,
  siteLabel,
  siteDetailLine,
  siteTooltip,
  shapeSite,
  shapeNode,
  shapeResult,
  shapeHeaderLines,
};

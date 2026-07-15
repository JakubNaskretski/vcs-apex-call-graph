'use strict';
// Self-check for the pure UI-shaping layer: node test-uitree.js
// No vscode dependency — everything here is plain data in/out, built
// against the frozen TNode/SiteView contract (see uitree.js header).
const assert = require('assert');
const {
  iconForNode,
  labelForNode,
  badgesForNode,
  packageBadge,
  isRootNode,
  siteLabel,
  siteDetailLine,
  siteTooltip,
  shapeSite,
  shapeNode,
  shapeResult,
  directionHeaderLine,
  shapeHeaderLines,
  effectiveOrientation,
  rerootEntryFirst,
} = require('./uitree');

// --- labelForNode: approximate '~' prefix ---
assert.strictEqual(labelForNode({ label: 'OppService.applyDiscount' }), 'OppService.applyDiscount');
assert.strictEqual(
  labelForNode({ label: 'OppService.applyDiscount', approximate: true }),
  '~OppService.applyDiscount',
  'approximate node label is ~ prefixed'
);
assert.strictEqual(labelForNode({ label: 'OppService', approximate: false }), 'OppService');

// --- badgesForNode: full combination, contract order (entries, test, via, ~, cycle, depth cap) ---
const fullNode = {
  entries: ['@AuraEnabled (LWC/Aura)'],
  isTest: true,
  via: 'typed',
  approximate: true,
  cyclic: true,
  truncated: true,
};
assert.deepStrictEqual(badgesForNode(fullNode), [
  '@AuraEnabled (LWC/Aura)',
  'test',
  'typed',
  '~',
  '↺ cycle',
  '… depth cap',
]);

// --- badgesForNode: individual flags in isolation ---
assert.deepStrictEqual(badgesForNode({ entries: [], isTest: false, via: null }), []);
assert.deepStrictEqual(badgesForNode({ entries: ['Batchable', 'Queueable'] }), ['Batchable, Queueable']);
assert.deepStrictEqual(badgesForNode({ isTest: true }), ['test']);
assert.deepStrictEqual(badgesForNode({ via: 'unique-name' }), ['unique-name']);
assert.deepStrictEqual(badgesForNode({ approximate: true }), ['~']);
assert.deepStrictEqual(badgesForNode({ cyclic: true }), ['↺ cycle']);
assert.deepStrictEqual(badgesForNode({ truncated: true }), ['… depth cap']);

// --- iconForNode: contract priority (trigger, test, entries, method, class) ---
assert.strictEqual(iconForNode({ kind: 'trigger', isTest: false, entries: [] }), 'zap');
assert.strictEqual(iconForNode({ kind: 'trigger', isTest: true, entries: ['x'] }), 'zap', 'trigger wins over test/entries');
assert.strictEqual(iconForNode({ kind: 'method', isTest: true, entries: [] }), 'beaker');
assert.strictEqual(iconForNode({ kind: 'method', isTest: true, entries: ['x'] }), 'beaker', 'test wins over entries');
assert.strictEqual(iconForNode({ kind: 'method', isTest: false, entries: ['@future (async)'] }), 'plug');
assert.strictEqual(iconForNode({ kind: 'method', isTest: false, entries: [] }), 'symbol-method');
assert.strictEqual(iconForNode({ kind: 'class', isTest: false, entries: [] }), 'symbol-class');

// --- iconForNode: A7 metadata-caller kinds get their own distinct icons,
// and win over the generic ICON_ENTRIES fallback even though these nodes
// always carry a non-empty `entries` (per A6's buildMetaChildren contract) ---
assert.strictEqual(iconForNode({ kind: 'lwc', isTest: false, entries: ['@salesforce/apex import'] }), 'symbol-interface');
assert.strictEqual(iconForNode({ kind: 'aura', isTest: false, entries: ['Aura controller'] }), 'browser');
assert.strictEqual(iconForNode({ kind: 'flow', isTest: false, entries: ['Flow apex action'] }), 'symbol-event');
assert.strictEqual(iconForNode({ kind: 'omniscript', isTest: false, entries: ['OmniScript Remote Action'] }), 'json');
assert.strictEqual(iconForNode({ kind: 'vf', isTest: false, entries: ['VF controller'] }), 'file-code');
assert.strictEqual(
  iconForNode({ kind: 'flow', isTest: false, entries: ['Flow apex action'] }),
  'symbol-event',
  'metadata kind wins over the entries-badge fallback'
);

// --- iconForNode: v0.4 F4b 'cmdt' kind gets its own distinct icon, same
// family as the A7 metadata-caller kinds ---
assert.strictEqual(
  iconForNode({ kind: 'cmdt', isTest: false, entries: ['Custom Metadata record'] }),
  'gear',
  'cmdt kind gets its own icon, wins over the entries-badge fallback'
);

// --- iconForNode: v0.5 G4 'anonymous' kind gets its own distinct icon
// ('terminal'), Apex-source family (like trigger), NOT the metadata-caller
// family -- wins over the entries-badge fallback the same way trigger/cmdt do ---
assert.strictEqual(
  iconForNode({ kind: 'anonymous', isTest: false, entries: ['Anonymous Apex script'] }),
  'terminal',
  'anonymous kind gets its own icon, wins over the entries-badge fallback'
);
assert.strictEqual(
  iconForNode({ kind: 'anonymous', isTest: true, entries: [] }),
  'terminal',
  'anonymous kind wins over isTest too, same priority tier as trigger'
);

// --- badgesForNode: v0.4 new via values ('dml'/'dynamic'/'override') render
// exactly like every other via value -- no special-casing needed, generic
// badge pass-through ---
assert.deepStrictEqual(badgesForNode({ via: 'dml' }), ['dml']);
assert.deepStrictEqual(badgesForNode({ via: 'dynamic' }), ['dynamic']);
assert.deepStrictEqual(badgesForNode({ via: 'override' }), ['override']);
assert.deepStrictEqual(
  badgesForNode({ via: 'override', approximate: true }),
  ['override', '~'],
  'override is an approximate via, same as interface/unique-name/lexical'
);
assert.deepStrictEqual(
  badgesForNode({ via: 'dynamic', approximate: true }),
  ['dynamic', '~']
);

// --- badgesForNode: v0.5 new via values ('publish'/'throws'/'narrowed'/
// 'async') render exactly like every other via value -- same generic
// pass-through, no special-casing needed. Per the G1/G2/G5 spec only
// 'narrowed' is approximate; 'publish'/'throws'/'async' are not. ---
assert.deepStrictEqual(badgesForNode({ via: 'publish' }), ['publish']);
assert.deepStrictEqual(badgesForNode({ via: 'throws' }), ['throws']);
assert.deepStrictEqual(badgesForNode({ via: 'async' }), ['async']);
assert.deepStrictEqual(
  badgesForNode({ via: 'narrowed', approximate: true }),
  ['narrowed', '~'],
  'narrowed is an approximate via, same as interface/unique-name/lexical/override'
);

// --- badgesForNode: v0.5 (G2) caughtHere gets a shield-glyph badge, IN
// ADDITION to the 'catches <ExcName>' entries text resolver.js stamps onto
// the same node -- both appear, in that order (entries text first, per the
// contract's badge-order comment). ---
assert.deepStrictEqual(
  badgesForNode({ entries: ['catches AcmeValidationException'], caughtHere: true }),
  ['catches AcmeValidationException', '🛡']
);
assert.deepStrictEqual(badgesForNode({ caughtHere: true }), ['🛡'], 'shield badge alone when entries happens to be empty');
assert.deepStrictEqual(badgesForNode({ caughtHere: false }), [], 'no shield badge when caughtHere is false/absent');
assert.deepStrictEqual(
  badgesForNode({ entries: ['catches AcmeValidationException'], caughtHere: true, isTest: true, via: 'static' }),
  ['catches AcmeValidationException', '🛡', 'test', 'static'],
  'shield badge sits right after entries, ahead of test/via, matching the documented badge order'
);

// --- site rendering: label 'L<line>: <lineText>', tooltip argsRendered, jump ---
// No argsRendered/overloadSig -> no second line, label unchanged.
assert.strictEqual(siteLabel({ line: 42, lineText: 'svc.applyDiscount(pct, oppId);' }), 'L42: svc.applyDiscount(pct, oppId);');
assert.strictEqual(siteTooltip({ argsRendered: 'pct: 0.15, oppId: opps[0].Id' }), 'pct: 0.15, oppId: opps[0].Id');
assert.strictEqual(siteTooltip({ argsRendered: null, path: '/ws/Handler.cls', line: 42 }), '/ws/Handler.cls:42', 'no argsRendered falls back to location');
assert.strictEqual(siteTooltip({}), '');

// --- v0.6 (H3): siteDetailLine — the inline '-> ...' second line, previously
// rendered nowhere (overloadSig) or tooltip-only (argsRendered). ---
assert.strictEqual(siteDetailLine({}), null, 'neither overloadSig nor argsRendered -> no detail line');
assert.strictEqual(siteDetailLine({ argsRendered: '' }), null, 'empty-string argsRendered treated as absent, same as null');
assert.strictEqual(
  siteDetailLine({ argsRendered: 'pct: 0.15, oppId: opps[0].Id' }),
  '-> pct: 0.15, oppId: opps[0].Id',
  'argsRendered alone renders as the detail line'
);
assert.strictEqual(
  siteDetailLine({ overloadSig: 'calculatePrice(String)' }),
  '-> calculatePrice(String)',
  'overloadSig alone renders as the detail line'
);
assert.strictEqual(
  siteDetailLine({ overloadSig: 'calculatePrice(String)', argsRendered: 'skuCode: sku' }),
  '-> calculatePrice(String) · skuCode: sku',
  'overloadSig and argsRendered combine, overloadSig first, per the H3 spec example'
);

// v0.6 (H3): siteLabel now appends siteDetailLine as a second, \n-separated
// line whenever there IS marquee data to show — this is the confirmed-bug
// fix (overloadSig was rendered nowhere; argsRendered was tooltip-only).
assert.strictEqual(
  siteLabel({ line: 11, lineText: 'svc.applyDiscount(pct, oppId);', overloadSig: 'applyDiscount(Id, Decimal)', argsRendered: 'oppId: opps[0].Id, pct: 0.15' }),
  'L11: svc.applyDiscount(pct, oppId);\n-> applyDiscount(Id, Decimal) · oppId: opps[0].Id, pct: 0.15',
  'siteLabel appends the inline detail line when overloadSig+argsRendered are present'
);

const site = shapeSite({
  path: '/ws/Handler.cls',
  line: 42,
  col: 4,
  lineText: 'svc.applyDiscount(pct, oppId);',
  argsRendered: 'pct: 0.15, oppId: opps[0].Id',
  via: 'typed',
});
assert.strictEqual(
  site.label,
  'L42: svc.applyDiscount(pct, oppId);\n-> pct: 0.15, oppId: opps[0].Id',
  'shapeSite label includes the inline args detail line (H3)'
);
assert.strictEqual(site.tooltip, 'pct: 0.15, oppId: opps[0].Id', 'tooltip is kept, unchanged, alongside the new inline rendering');
assert.strictEqual(site.description, 'typed');
assert.deepStrictEqual(site.jump, { path: '/ws/Handler.cls', line: 42, col: 4 }, 'line passed through 1-based, unmodified');
assert.strictEqual(site.collapsible, false, 'still a single non-collapsible row -- the detail line is part of the label, not a nested child');
assert.deepStrictEqual(site.children, [], 'no extra child row is added for the detail line');

// v0.6 (H3): overloadSig alone, through the full shapeSite path.
const overloadSite = shapeSite({
  path: '/ws/PricingService.cls',
  line: 7,
  col: 4,
  lineText: 'PricingService.calculatePrice(skuCode);',
  overloadSig: 'calculatePrice(String)',
  argsRendered: null,
  via: 'static',
});
assert.strictEqual(overloadSite.label, 'L7: PricingService.calculatePrice(skuCode);\n-> calculatePrice(String)');

const siteNoPath = shapeSite({ line: 1 });
assert.strictEqual(siteNoPath.jump, null, 'no path -> no jump target');
const siteNoLine = shapeSite({ path: '/ws/Handler.cls' });
assert.strictEqual(siteNoLine.jump, null, 'no line -> no jump target');

// --- shapeNode: recursive structure, sites before child nodes, jump only when path+line ---
const tnode = {
  label: 'OppService.applyDiscount',
  kind: 'method',
  className: 'OppService',
  path: '/ws/OppService.cls',
  line: 4,
  entries: [],
  isTest: false,
  via: null,
  sites: [
    { path: '/ws/Handler.cls', line: 11, col: 4, lineText: 'svc.applyDiscount(pct, oppId);', argsRendered: 'pct: 0.15, oppId: opps[0].Id', via: 'typed' },
  ],
  children: [
    {
      label: 'Handler.afterUpdate',
      kind: 'method',
      className: 'Handler',
      path: '/ws/Handler.cls',
      line: 9,
      entries: [],
      isTest: false,
      via: 'typed',
      sites: [],
      children: [],
      cyclic: false,
      truncated: false,
      approximate: false,
    },
  ],
  cyclic: false,
  truncated: false,
  approximate: false,
};
const shaped = shapeNode(tnode);
assert.strictEqual(shaped.label, 'OppService.applyDiscount');
assert.strictEqual(shaped.collapsible, true, 'has sites + children -> collapsible');
assert.strictEqual(shaped.children.length, 2, 'sites + child nodes both appear');
assert.strictEqual(
  shaped.children[0].label,
  'L11: svc.applyDiscount(pct, oppId);\n-> pct: 0.15, oppId: opps[0].Id',
  'call site rendered before child caller node, with its inline args detail line (H3)'
);
assert.strictEqual(shaped.children[1].label, 'Handler.afterUpdate');
assert.strictEqual(shaped.children[1].collapsible, false, 'childless leaf node is not collapsible');
assert.deepStrictEqual(shaped.children[1].jump, { path: '/ws/Handler.cls', line: 9, col: 0 }, 'node jump uses decl line, col 0');
// v0.6 (H3): Handler.afterUpdate has no children of its own (childless,
// non-cyclic, non-truncated) -> gets the explicit 'root' badge, per the
// README's promise. The traced target itself (`shaped`) has a caller
// (Handler.afterUpdate) so it must NOT get the badge.
assert(shaped.children[1].description.includes('◉ root'), 'childless non-cyclic non-truncated node gets the root badge');
assert(!shaped.description.includes('◉ root'), 'a node with a known caller never gets the root badge');

// --- approximate node: ~ prefix on label AND ~ badge, end to end through shapeNode ---
const approxNode = { ...tnode, approximate: true, via: 'unique-name', children: [], sites: [] };
const shapedApprox = shapeNode(approxNode);
assert.strictEqual(shapedApprox.label, '~OppService.applyDiscount');
assert(shapedApprox.description.includes('~'), 'approximate badge present');
assert(shapedApprox.description.includes('unique-name'), 'via badge present');

// --- cycle / truncation markers ---
const cyclicNode = { ...tnode, cyclic: true, children: [], sites: [] };
const shapedCyclic = shapeNode(cyclicNode);
assert(shapedCyclic.description.includes('↺ cycle'));
assert(!shapedCyclic.description.includes('◉ root'), 'a cyclic node never gets the root badge -- there IS more above it, just not shown');
const truncatedNode = { ...tnode, truncated: true, children: [], sites: [] };
const shapedTruncated = shapeNode(truncatedNode);
assert(shapedTruncated.description.includes('… depth cap'));
assert(!shapedTruncated.description.includes('◉ root'), 'a depth-capped node never gets the root badge -- more callers may exist above it');

// --- v0.6 (H1 forward-compat, H5 rendering): seenElsewhere badge + tooltip
// glossary + root-badge exclusion. resolver.js does not produce this field
// yet, but uitree.js's rendering support is locked in ahead of that change. ---
const seenElsewhereNode = { ...tnode, seenElsewhere: true, children: [], sites: [] };
const shapedSeenElsewhere = shapeNode(seenElsewhereNode);
assert(shapedSeenElsewhere.description.includes('↪ seen elsewhere'), 'seenElsewhere gets its own badge');
assert(!shapedSeenElsewhere.description.includes('◉ root'), 'a seenElsewhere node never gets the root badge -- its subtree was already shown above, it is not "no known caller"');
assert(shapedSeenElsewhere.tooltip.includes('seen elsewhere'), 'seenElsewhere gets a one-line tooltip explanation (H5a glossary)');

// --- v0.6 (H5a): tooltip glossary — every via value, '~', cycle, depth-cap,
// caughtHere, seenElsewhere, and root get a one-line explanation in the node
// tooltip (in addition to the existing path-as-tooltip behavior). ---
const typedNode = { ...tnode, via: 'typed', children: [], sites: [] };
const shapedTyped = shapeNode(typedNode);
assert(shapedTyped.tooltip.startsWith('/ws/OppService.cls'), 'tooltip still starts with the source path');
assert(shapedTyped.tooltip.includes('typed:'), "via 'typed' gets a glossary explanation in the tooltip");
assert(shapeNode({ ...tnode, via: 'interface', children: [], sites: [] }).tooltip.includes('interface:'), "via 'interface' gets a glossary explanation");
assert(shapeNode({ ...tnode, via: 'narrowed', children: [], sites: [] }).tooltip.includes('narrowed:'), "via 'narrowed' gets a glossary explanation");
assert(shapeNode({ ...tnode, via: 'async', children: [], sites: [] }).tooltip.includes('async:'), "via 'async' gets a glossary explanation");
assert(shapeNode({ ...tnode, approximate: true, children: [], sites: [] }).tooltip.includes('approximate resolution'), "'~' gets a glossary explanation");
assert(shapeNode(cyclicNode).tooltip.includes('recurses back'), 'cycle gets a glossary explanation');
assert(shapeNode(truncatedNode).tooltip.includes('depth cap reached'), 'depth cap gets a glossary explanation');
assert(shapeNode({ ...tnode, caughtHere: true, children: [], sites: [] }).tooltip.includes('caughtHere'), 'caughtHere gets a glossary explanation');
assert(shapeNode({ ...tnode, children: [], sites: [] }).tooltip.includes('root —'), "a bare childless node's tooltip explains the root badge too");

// --- v0.6 (H3): isRootNode direct unit checks ---
assert.strictEqual(isRootNode(null), false);
assert.strictEqual(isRootNode({ children: [] }), true, 'childless, no other flags -> root');
assert.strictEqual(isRootNode({ children: [{ label: 'x' }] }), false, 'has children -> not root');
assert.strictEqual(isRootNode({ children: [], cyclic: true }), false, 'cyclic excludes root');
assert.strictEqual(isRootNode({ children: [], truncated: true }), false, 'truncated excludes root');
assert.strictEqual(isRootNode({ children: [], seenElsewhere: true }), false, 'seenElsewhere excludes root');
assert.strictEqual(isRootNode({}), true, 'no children field at all is treated as childless -> root');

// --- v0.6 (H1/H4 forward-compat): shapeHeaderLines ---
assert.deepStrictEqual(shapeHeaderLines(null), [], 'null treeResult -> no header lines');
assert.deepStrictEqual(shapeHeaderLines({ root: {}, targetLabel: 'x', note: null }), [], "today's real TreeResult shape with no note -> no header lines");
assert.deepStrictEqual(
  shapeHeaderLines({ root: {}, targetLabel: 'x', note: 'No callers found — this is likely an entry point or unused code.' }),
  ['No callers found — this is likely an entry point or unused code.'],
  'note (already part of the real contract today) becomes a header line'
);
assert.deepStrictEqual(
  shapeHeaderLines({ root: {}, targetLabel: 'x', note: null, stats: { nodes: 42, uniqueMethods: 10, capped: true } }),
  ['Result capped -- not every caller could be expanded.'],
  'H1 forward-compat: stats.capped produces a capped header line'
);
// NOTE (integrator, v0.6.0): resolver.js's real buildCallerTree output nests
// unresolvedSites under stats (stats.unresolvedSites), not a top-level
// TreeResult.unresolvedSites field -- these fixtures match that real shape
// (shapeHeaderLines was fixed to read from stats to match).
assert.deepStrictEqual(
  shapeHeaderLines({ root: {}, targetLabel: 'x', note: null, stats: { nodes: 1, uniqueMethods: 1, capped: false, unresolvedSites: 3 } }),
  ['3 call sites workspace-wide could not be resolved (dynamic/platform/deep-chain).'],
  'H4 forward-compat: stats.unresolvedSites > 0 produces the exact required header wording'
);
assert.deepStrictEqual(
  shapeHeaderLines({ root: {}, targetLabel: 'x', note: null, stats: { nodes: 1, uniqueMethods: 1, capped: false, unresolvedSites: 0 } }),
  [],
  'stats.unresolvedSites === 0 produces no header line'
);
assert.deepStrictEqual(
  shapeHeaderLines({
    root: {},
    targetLabel: 'x',
    note: 'interface dispatch: showing every implementer',
    stats: { nodes: 5, uniqueMethods: 5, capped: true, unresolvedSites: 1 },
  }),
  [
    'interface dispatch: showing every implementer',
    'Result capped -- not every caller could be expanded.',
    '1 call sites workspace-wide could not be resolved (dynamic/platform/deep-chain).',
  ],
  'all three header lines combine, note first, in a fixed order'
);

// --- tests-last ordering preserved from resolver output (uitree must NOT re-sort) ---
// Deliberately not alphabetical among non-test siblings, to prove shapeNode
// preserves resolver.js's order rather than imposing its own sort.
const orderedChildren = [
  { label: 'ZHandler', kind: 'class', path: '/ws/Z.cls', line: 1, entries: [], isTest: false, via: null, sites: [], children: [], cyclic: false, truncated: false, approximate: false },
  { label: 'AHandler', kind: 'class', path: '/ws/A.cls', line: 1, entries: [], isTest: false, via: null, sites: [], children: [], cyclic: false, truncated: false, approximate: false },
  { label: 'AServiceTest', kind: 'class', path: '/ws/AT.cls', line: 1, entries: [], isTest: true, via: null, sites: [], children: [], cyclic: false, truncated: false, approximate: false },
];
const ordered = shapeNode({ ...tnode, sites: [], children: orderedChildren });
assert.deepStrictEqual(
  ordered.children.map((c) => c.label),
  ['ZHandler', 'AHandler', 'AServiceTest'],
  'uitree preserves resolver-supplied order verbatim, even when it is not alphabetical'
);

// --- A6/A7 end-to-end: a metadata-caller TNode (resolver.js's
// buildMetaChildren shape) shapes with its distinct icon, the 'metadata'
// via badge (via the existing generic badgesForNode logic — no special
// casing needed there), and its kind-specific entries label ---
const metaTNode = {
  label: 'acmeOrderDashboard',
  kind: 'lwc',
  className: '',
  methodLower: null,
  path: '/ws/lwc/acmeOrderDashboard/acmeOrderDashboard.js',
  line: 3,
  entries: ['@salesforce/apex import'],
  isTest: false,
  via: 'metadata',
  sites: [
    {
      path: '/ws/lwc/acmeOrderDashboard/acmeOrderDashboard.js',
      line: 3,
      col: 0,
      lineText: "import getRecentQuotes from '@salesforce/apex/AcmeQuoteAuraService.getRecentQuotes';",
      argsRendered: '',
      via: 'metadata',
    },
  ],
  children: [],
  cyclic: false,
  truncated: false,
  approximate: false,
};
const shapedMeta = shapeNode(metaTNode);
assert.strictEqual(shapedMeta.iconId, 'symbol-interface', 'lwc metadata node gets its distinct icon');
assert(shapedMeta.description.includes('@salesforce/apex import'), 'kind-specific entries label present');
assert(shapedMeta.description.includes('metadata'), "'metadata' via badge present (generic badgesForNode path)");
assert.strictEqual(shapedMeta.collapsible, true, 'metadata node with one site is collapsible');
assert.strictEqual(shapedMeta.children.length, 1, 'metadata node exposes its one call site as a child');

// --- v0.4 F4b: a terminal 'cmdt' TNode (resolver.js's Custom Metadata
// linkage) shapes with its own icon and the 'Custom Metadata record' entries
// label, mirroring the A6/A7 metadata-caller shape above ---
const cmdtTNode = {
  label: 'Acme_Integration_Config.Order_Sync_Handler',
  kind: 'cmdt',
  className: '',
  methodLower: null,
  path: '/ws/customMetadata/Acme_Integration_Config.Order_Sync_Handler.md-meta.xml',
  line: 7,
  entries: ['Custom Metadata record'],
  isTest: false,
  via: 'metadata',
  sites: [],
  children: [],
  cyclic: false,
  truncated: false,
  approximate: false,
};
const shapedCmdt = shapeNode(cmdtTNode);
assert.strictEqual(shapedCmdt.iconId, 'gear', 'cmdt node gets its distinct icon');
assert(shapedCmdt.description.includes('Custom Metadata record'), 'kind-specific entries label present');
assert(shapedCmdt.description.includes('metadata'), "'metadata' via badge present");
assert.strictEqual(shapedCmdt.collapsible, false, 'cmdt node with no sites/children is a leaf, per MANIFEST (terminal)');

// --- v0.4 F1b: a 'flow' TNode is NO LONGER assumed terminal -- a
// record-triggered flow can carry both its own actionCalls site AND child
// TNodes (the DML sites on its object). shapeNode must render both exactly
// like it already does for any other non-leaf node -- no special-casing for
// meta kinds needed, this just locks the contract in with a regression test ---
const flowChildDmlNode = {
  label: 'AcmeOrderService.recalculatePricing',
  kind: 'method',
  className: 'AcmeOrderService',
  path: '/ws/AcmeOrderService.cls',
  line: 39,
  entries: [],
  isTest: false,
  via: 'dml',
  sites: [],
  children: [],
  cyclic: false,
  truncated: false,
  approximate: false,
};
const nonTerminalFlowTNode = {
  label: 'AcmeOrderStatusRecordTriggeredFlow',
  kind: 'flow',
  className: '',
  methodLower: null,
  path: '/ws/flows/AcmeOrderStatusRecordTriggeredFlow.flow-meta.xml',
  line: 44,
  entries: ['Flow apex action'],
  isTest: false,
  via: 'metadata',
  sites: [
    {
      path: '/ws/flows/AcmeOrderStatusRecordTriggeredFlow.flow-meta.xml',
      line: 44,
      col: 0,
      lineText: '<actionName>AcmeOrderService.recalculatePricing</actionName>',
      argsRendered: '',
      via: 'metadata',
    },
  ],
  children: [flowChildDmlNode],
  cyclic: false,
  truncated: false,
  approximate: false,
};
const shapedFlow = shapeNode(nonTerminalFlowTNode);
assert.strictEqual(shapedFlow.iconId, 'symbol-event', 'flow node keeps its flow icon regardless of having children');
assert.strictEqual(shapedFlow.collapsible, true, 'flow node with children is collapsible, not forced terminal');
assert.strictEqual(shapedFlow.children.length, 2, 'its one site plus its one DML-site child both appear');
assert.strictEqual(shapedFlow.children[0].label, 'L44: <actionName>AcmeOrderService.recalculatePricing</actionName>', 'site renders before the child caller node');
assert.strictEqual(shapedFlow.children[1].label, 'AcmeOrderService.recalculatePricing', 'nested DML-site child node renders like any other TNode');
assert(shapedFlow.children[1].description.includes('dml'), "the DML child's via badge is 'dml'");

// --- v0.5 G4: an 'anonymous' TNode (parser.js's anonymousUnit() pseudo-type/
// method, resolver.js's doing to surface it as a TNode.kind) shapes with its
// distinct 'terminal' icon and the "Anonymous Apex script" entries label,
// and — per the G4 spec ("scripts are pure roots — nothing calls them") — is
// always a leaf with zero children in practice, though shapeNode does not
// assume that structurally (same generic children-rendering as every other
// kind). ---
const anonymousTNode = {
  label: '(anonymous)',
  kind: 'anonymous',
  className: 'adhocRecalc',
  methodLower: '(anonymous)',
  path: '/ws/scripts/adhoc-recalc.apex',
  line: 1,
  entries: ['Anonymous Apex script'],
  isTest: false,
  via: null,
  sites: [],
  children: [],
  cyclic: false,
  truncated: false,
  approximate: false,
};
const shapedAnonymous = shapeNode(anonymousTNode);
assert.strictEqual(shapedAnonymous.iconId, 'terminal', 'anonymous script node gets its distinct icon');
assert(shapedAnonymous.description.includes('Anonymous Apex script'), 'kind-specific entries label present');
assert.strictEqual(shapedAnonymous.collapsible, false, 'a pure-root anonymous script node has no callers of its own');
// v0.6 (H3): the G4 spec's own words are "always a pure root" -- must get
// the explicit root badge too.
assert(shapedAnonymous.description.includes('◉ root'), 'a pure-root anonymous script node gets the root badge');

// --- v0.5 G2: a caughtHere TNode shapes with the shield-glyph badge AND its
// entries-carried 'catches <ExcName>' text, end to end through shapeNode.
// Traversal continues past a caughtHere node (rethrow is unknowable), so it
// still renders its own children normally -- caughtHere is purely additive,
// never forces a node terminal. ---
const caughtHereTNode = {
  label: 'AcmeOrderBatchProcessor.execute',
  kind: 'method',
  className: 'AcmeOrderBatchProcessor',
  path: '/ws/classes/AcmeOrderBatchProcessor.cls',
  line: 25,
  entries: ['catches AcmeValidationException'],
  isTest: false,
  via: 'static',
  caughtHere: true,
  sites: [],
  children: [
    {
      label: 'AcmeOrderService.processOrders',
      kind: 'method',
      className: 'AcmeOrderService',
      path: '/ws/classes/AcmeOrderService.cls',
      line: 18,
      entries: [],
      isTest: false,
      via: 'async',
      sites: [],
      children: [],
      cyclic: false,
      truncated: false,
      approximate: false,
    },
  ],
  cyclic: false,
  truncated: false,
  approximate: false,
};
const shapedCaughtHere = shapeNode(caughtHereTNode);
assert(shapedCaughtHere.description.includes('catches AcmeValidationException'), "entries 'catches <Exc>' text present");
assert(shapedCaughtHere.description.includes('🛡'), 'shield-glyph badge present');
assert.strictEqual(shapedCaughtHere.collapsible, true, 'caughtHere does not force a node terminal -- traversal continues past it');
assert.strictEqual(shapedCaughtHere.children.length, 1);
assert.strictEqual(shapedCaughtHere.children[0].label, 'AcmeOrderService.processOrders');
assert(shapedCaughtHere.children[0].description.includes('async'), "the async-hop child's via badge is 'async' (v0.5 G5)");
assert(!shapedCaughtHere.description.includes('◉ root'), 'caughtHere node has a real caller (the traced target) -- not root');
assert(shapedCaughtHere.children[0].description.includes('◉ root'), "the async-hop child has no callers of its own -- gets the root badge");

// --- shapeResult ---
assert.deepStrictEqual(shapeResult(null), [], 'null result -> empty array');
assert.deepStrictEqual(shapeResult({}), [], 'result without root -> empty array');
const topLevel = shapeResult({ root: tnode, targetLabel: 'OppService.applyDiscount', note: null });
assert.strictEqual(topLevel.length, 1);
assert.strictEqual(topLevel[0].label, 'OppService.applyDiscount');

// =========================================================================
// v0.7 (A3): direction-aware headers ('who calls this' vs 'what this
// calls'). CONFIRMED against the real resolver.js sibling implementation:
// buildCallerTree now stamps `direction: 'callers'` on EVERY TreeResult it
// returns, unconditionally (see resolver.js's own comment: "direction is
// now present on EVERY TreeResult ... a brand-new field no pre-v0.7 caller
// could have been reading"). Since 'callers' is therefore the universal
// state of every REAL caller-direction TreeResult -- not an opt-in tag some
// callers set and others don't -- "byte-identical to today" can only mean
// 'callers' renders with ZERO new header text, exactly like the pre-v0.7,
// direction-less shape. Only 'callees' (the one genuinely NEW direction
// this round adds) gets an explicit sign-post. This is also load-bearing
// for test.js's real end-to-end H4 assertion, which calls the ACTUAL
// resolver.buildCallerTree()+uitree.shapeHeaderLines() pipeline and expects
// exactly 2 header lines (note + workspace-wide unresolved-sites count) --
// a real TreeResult from that pipeline always carries direction:'callers',
// so a 3rd "Who Calls This?" line here would be a genuine regression there,
// not just a hypothetical one.
// =========================================================================
assert.strictEqual(directionHeaderLine(undefined), null, 'no direction field -> no header line');
assert.strictEqual(directionHeaderLine(null), null, 'null direction -> no header line');
assert.strictEqual(
  directionHeaderLine('callers'),
  null,
  "'callers' -- the value EVERY real buildCallerTree TreeResult now carries -- renders with NO header line, matching the pre-v0.7 default exactly"
);
assert.strictEqual(directionHeaderLine('callees'), 'What Does This Call?', "'callees' -- the one genuinely new v0.7 direction -- gets the forward-tracing header line");
assert.strictEqual(directionHeaderLine('bogus'), null, 'an unrecognized direction string is treated like absent -- no header line');

assert.deepStrictEqual(
  shapeHeaderLines({ root: {}, targetLabel: 'x', note: null, direction: 'callers' }),
  [],
  "shapeHeaderLines produces NO new line for direction:'callers' -- byte-identical to the pre-existing 'no direction field' fixture above"
);
assert.deepStrictEqual(
  shapeHeaderLines({ root: {}, targetLabel: 'x', note: null, direction: 'callees' }),
  ['What Does This Call?'],
  "shapeHeaderLines surfaces the 'callees' direction line"
);
assert.deepStrictEqual(
  shapeHeaderLines({ root: {}, targetLabel: 'x', note: 'interface dispatch: showing every implementer', direction: 'callees' }),
  ['interface dispatch: showing every implementer', 'What Does This Call?'],
  'note still comes first, direction line second, when both are present'
);
// v0.7 (A3): the capped-line wording is direction-aware -- 'caller' for the
// default/callers case (byte-identical to the pre-existing H1 fixture
// above), 'callee' for callees, since the SAME cap/DAG-memoization
// machinery now runs in both directions.
assert.deepStrictEqual(
  shapeHeaderLines({ root: {}, targetLabel: 'x', note: null, direction: 'callees', stats: { capped: true } }),
  ['What Does This Call?', 'Result capped -- not every callee could be expanded.'],
  'callees direction swaps the capped-line noun to "callee"'
);
assert.deepStrictEqual(
  shapeHeaderLines({ root: {}, targetLabel: 'x', note: null, direction: 'callers', stats: { capped: true } }),
  ['Result capped -- not every caller could be expanded.'],
  "callers direction keeps the original 'caller' wording AND the original (no direction-line) header shape -- byte-identical to the pre-existing H1 fixture with no direction field"
);

// v0.7 (A3) byte-identical bar, at BOTH layers this file owns:
//  (1) shapeResult (the actual tree content) never reads treeResult.direction
//      at all -- only shapeHeaderLines does -- so it is unconditionally
//      identical regardless of direction tagging.
//  (2) shapeHeaderLines ITSELF is now also byte-identical for 'callers' vs.
//      absent (per the confirmed-design assertions immediately above), so a
//      full, real-shaped TreeResult (note + stats, direction:'callers') is
//      byte-identical end to end to the same TreeResult with no `direction`
//      field at all. This is the concrete mechanism behind the pinned
//      "CALLERS-DIRECTION render is byte-identical to today" bar, at this
//      file's layer, verified for a fixture WITHOUT any package field.
assert.deepStrictEqual(
  shapeResult({ root: tnode, targetLabel: 'OppService.applyDiscount', note: null, direction: 'callers' }),
  topLevel,
  'shapeResult renders byte-identically whether or not direction:"callers" is explicitly tagged, for a fixture with no package field -- direction only affects shapeHeaderLines, never per-node shaping'
);
assert.deepStrictEqual(
  shapeNode(tnode, undefined),
  shapeNode(tnode),
  "shapeNode's optional targetPackage argument is a pure no-op when omitted -- identical to every pre-v0.7 call site"
);
const realShapedTreeResultDirectionless = {
  root: {},
  targetLabel: 'x',
  note: 'No callers found — this is likely an entry point or unused code.',
  stats: { nodes: 1, uniqueMethods: 1, capped: false, unresolvedSites: 3 },
};
assert.deepStrictEqual(
  shapeHeaderLines({ ...realShapedTreeResultDirectionless, direction: 'callers' }),
  shapeHeaderLines(realShapedTreeResultDirectionless),
  "shapeHeaderLines is fully byte-identical for a real-shaped (note+stats) TreeResult whether or not direction:'callers' is explicitly tagged -- the exact scenario test.js's H4 end-to-end assertion depends on against the REAL resolver.buildCallerTree(), which always stamps direction:'callers'"
);

// =========================================================================
// v0.7 (A3): 'exception' and 'unresolved' node kinds -- icons 'flame' /
// 'question', same "kind alone decides the icon" priority tier as
// trigger/anonymous (checked ahead of isTest/entries).
// =========================================================================
assert.strictEqual(iconForNode({ kind: 'exception', isTest: false, entries: [] }), 'flame');
assert.strictEqual(
  iconForNode({ kind: 'exception', isTest: true, entries: ['x'] }),
  'flame',
  'exception kind wins over isTest/entries, same tier as trigger'
);
assert.strictEqual(iconForNode({ kind: 'unresolved', isTest: false, entries: [] }), 'question');
assert.strictEqual(
  iconForNode({ kind: 'unresolved', isTest: false, entries: ['5 unresolved sites'] }),
  'question',
  'unresolved kind wins over the entries-badge fallback'
);

// End-to-end: an exception-class TNode (resolver.js's A3 throw-forward
// shape) shapes with the flame icon, 'throws' via badge (not approximate --
// per the A3/G2 spec, a throw site itself is not an approximate resolution),
// and is a terminal leaf.
const exceptionTNode = {
  label: 'AcmeValidationException',
  kind: 'exception',
  className: 'AcmeValidationException',
  path: '/ws/classes/AcmeValidationException.cls',
  line: 1,
  entries: [],
  isTest: false,
  via: 'throws',
  sites: [],
  children: [],
  cyclic: false,
  truncated: false,
  approximate: false,
};
const shapedException = shapeNode(exceptionTNode);
assert.strictEqual(shapedException.iconId, 'flame', 'exception node gets the flame icon');
assert(shapedException.description.includes('throws'), "'throws' via badge present");
assert(!shapedException.description.includes('~'), 'a throw site itself is not approximate, per the A3/G2 spec');
assert.strictEqual(shapedException.collapsible, false, 'exception node is terminal, per the A3 spec');
assert(shapedException.description.includes('◉ root'), 'a childless non-cyclic non-truncated exception leaf still gets the generic root badge');

// End-to-end: an aggregated unresolved-sites leaf (resolver.js's A6 shape).
const unresolvedTNode = {
  label: '5 unresolved sites',
  kind: 'unresolved',
  className: 'AcmeSmsNotifier',
  methodLower: 'sendsms',
  path: '/ws/classes/AcmeSmsNotifier.cls',
  line: 18,
  entries: [],
  isTest: false,
  via: null,
  sites: [],
  children: [],
  cyclic: false,
  truncated: false,
  approximate: true,
};
const shapedUnresolved = shapeNode(unresolvedTNode);
assert.strictEqual(shapedUnresolved.iconId, 'question', 'unresolved node gets the question icon');
assert.strictEqual(shapedUnresolved.label, '~5 unresolved sites', 'approximate -> "~" prefixed label, per the A6 spec');
assert(shapedUnresolved.description.includes('~'), 'unresolved node is flagged approximate, per the A6 spec');
assert.strictEqual(shapedUnresolved.collapsible, false, 'unresolved node is terminal, per the A6 spec');

// =========================================================================
// v0.7 (B2): 'ambiguous' via value -- generic pass-through (same as every
// other via string), plus its VIA_GLOSSARY tooltip entry.
// =========================================================================
assert.deepStrictEqual(badgesForNode({ via: 'ambiguous' }), ['ambiguous']);
assert.deepStrictEqual(
  badgesForNode({ via: 'ambiguous', approximate: true }),
  ['ambiguous', '~'],
  'ambiguous is an approximate via, same as interface/unique-name/lexical/override/narrowed/dynamic'
);
assert(
  shapeNode({ ...tnode, via: 'ambiguous', children: [], sites: [] }).tooltip.includes('ambiguous:'),
  "via 'ambiguous' gets a glossary explanation in the tooltip"
);

// =========================================================================
// v0.7 (B3): package badges -- packageBadge() unit checks, badge ordering
// (right after via, ahead of '~'), tooltip glossary line, and end-to-end
// threading through shapeNode/shapeResult (targetPackage derived from
// treeResult.root.package).
// =========================================================================
assert.strictEqual(packageBadge(null, 'force-app'), null, 'null node -> no badge');
assert.strictEqual(packageBadge({ package: null }, 'force-app'), null, 'node with no package -> no badge');
assert.strictEqual(packageBadge({ package: 'force-app' }, 'force-app'), null, 'same package as target -> no badge');
assert.strictEqual(
  packageBadge({ package: 'nova-billing' }, 'force-app'),
  '(nova-billing)',
  'different package -> "(pkgLabel)" badge, matching the MANIFEST B4 format verbatim'
);
assert.strictEqual(
  packageBadge({ package: 'force-app' }, undefined),
  '(force-app)',
  'no targetPackage context (undefined) -> any package the node carries differs from it, badge shown'
);

// badge ordering: entries · shield · test · via · package · '~' · cycle · depth cap · seenElsewhere.
assert.deepStrictEqual(
  badgesForNode({ entries: ['@AuraEnabled (LWC/Aura)'], isTest: true, via: 'static', approximate: true, cyclic: true, truncated: true }, '(nova-billing)'),
  ['@AuraEnabled (LWC/Aura)', 'test', 'static', '(nova-billing)', '~', '↺ cycle', '… depth cap'],
  'package badge sits right after via, ahead of the "~" approximate marker'
);
assert.deepStrictEqual(badgesForNode({ via: 'static' }), ['static'], 'badgesForNode(node) with no second argument is unaffected -- no package badge appears');

// End to end: NovaBillingService.recordBatchCompletion (pkg-billing) as a
// child of AcmeOrderBatchProcessor.finish (force-app) -- mirrors the
// MANIFEST B4 case 1 cross-package badge fixture almost verbatim.
const crossPackageChild = {
  label: 'NovaBillingService.recordBatchCompletion',
  kind: 'method',
  className: 'NovaBillingService',
  path: '/ws/pkg-billing/main/default/classes/NovaBillingService.cls',
  line: 20,
  package: 'nova-billing',
  entries: [],
  isTest: false,
  via: 'static',
  sites: [],
  children: [],
  cyclic: false,
  truncated: false,
  approximate: false,
};
const crossPackageTarget = {
  label: 'AcmeOrderBatchProcessor.finish',
  kind: 'method',
  className: 'AcmeOrderBatchProcessor',
  path: '/ws/classes/AcmeOrderBatchProcessor.cls',
  line: 33,
  package: 'force-app',
  entries: [],
  isTest: false,
  via: null,
  sites: [],
  children: [crossPackageChild],
  cyclic: false,
  truncated: false,
  approximate: false,
};
const shapedCrossPackage = shapeResult({ root: crossPackageTarget, targetLabel: 'AcmeOrderBatchProcessor.finish', note: null });
assert.strictEqual(shapedCrossPackage[0].label, 'AcmeOrderBatchProcessor.finish');
assert(!shapedCrossPackage[0].description.includes('nova-billing'), "the target itself never carries its own package as a badge (it can't differ from itself)");
const shapedCrossChild = shapedCrossPackage[0].children[0];
assert.strictEqual(shapedCrossChild.label, 'NovaBillingService.recordBatchCompletion');
assert(shapedCrossChild.description.includes('(nova-billing)'), 'cross-package child carries the "(nova-billing)" badge, per MANIFEST B4 case 1');
assert(shapedCrossChild.tooltip.includes('(nova-billing) —'), 'package badge gets a glossary explanation in the node tooltip too');
assert(shapedCrossChild.tooltip.toLowerCase().includes('different sfdx package'), 'package badge glossary line explains what the badge means');

// Same-package caller: no badge at all, even though a DIFFERENT sibling in
// the same tree does carry one (MANIFEST B4 case 2's "no badge" half).
const samePackageChild = {
  label: 'AcmeOrderRestResource.handleGet',
  kind: 'method',
  className: 'AcmeOrderRestResource',
  path: '/ws/classes/AcmeOrderRestResource.cls',
  line: 13,
  package: 'force-app',
  entries: [],
  isTest: false,
  via: 'static',
  sites: [],
  children: [],
  cyclic: false,
  truncated: false,
  approximate: false,
};
const samePackageTarget = { ...crossPackageTarget, children: [crossPackageChild, samePackageChild] };
const shapedSamePackage = shapeResult({ root: samePackageTarget, targetLabel: 'AcmeOrderBatchProcessor.finish', note: null });
const [badgedChild, unbadgedChild] = shapedSamePackage[0].children;
assert(badgedChild.description.includes('(nova-billing)'), 'the cross-package child keeps its badge');
assert(!unbadgedChild.description.includes('('), 'the same-package caller carries no package badge at all');

// v0.7 (B4) case 3: a single call site fans out (via='ambiguous') to two
// children in two DIFFERENT non-target packages -- each carries its OWN,
// different badge from the other, not just from the parent.
const ambiguousBillingChild = {
  label: 'NovaBillingUtil.auditPricingSync',
  kind: 'method',
  className: 'NovaBillingUtil',
  path: '/ws/pkg-billing/main/default/classes/NovaBillingUtil.cls',
  line: 5,
  package: 'nova-billing',
  entries: [],
  isTest: false,
  via: 'ambiguous',
  approximate: true,
  sites: [],
  children: [],
  cyclic: false,
  truncated: false,
};
const ambiguousSharedChild = {
  ...ambiguousBillingChild,
  path: '/ws/pkg-shared/main/default/classes/NovaBillingUtil.cls',
  package: 'nova-shared',
};
const ambiguousTarget = { ...crossPackageTarget, children: [ambiguousBillingChild, ambiguousSharedChild] };
const shapedAmbiguous = shapeResult({ root: ambiguousTarget, targetLabel: 'AcmeOrderBatchProcessor.finish', note: null });
const [ambigChild1, ambigChild2] = shapedAmbiguous[0].children;
assert(ambigChild1.description.includes('(nova-billing)'));
assert(ambigChild2.description.includes('(nova-shared)'));
assert.notStrictEqual(ambigChild1.description, ambigChild2.description, 'the two ambiguous fan-out children carry DIFFERENT badges from each other');
assert(ambigChild1.description.includes('ambiguous') && ambigChild2.description.includes('ambiguous'), 'both fan-out children carry the ambiguous via badge too');

// =========================================================================
// v0.7 (B3): duplicate-names header note -- exact wording pinned by the
// MANIFEST ("N duplicate class names across packages — resolution prefers
// the referring file's package").
// =========================================================================
assert.deepStrictEqual(
  shapeHeaderLines({ root: {}, targetLabel: 'x', note: null, stats: { duplicateNames: 2 } }),
  ["2 duplicate class names across packages — resolution prefers the referring file's package"],
  'exact MANIFEST-pinned wording for N=2'
);
assert.deepStrictEqual(
  shapeHeaderLines({ root: {}, targetLabel: 'x', note: null, stats: { duplicateNames: 0 } }),
  [],
  'duplicateNames === 0 -> no header line'
);
assert.deepStrictEqual(
  shapeHeaderLines({
    root: {},
    targetLabel: 'x',
    note: 'interface dispatch: showing every implementer',
    direction: 'callees',
    stats: { duplicateNames: 2, capped: true, unresolvedSites: 1 },
  }),
  [
    'interface dispatch: showing every implementer',
    'What Does This Call?',
    "2 duplicate class names across packages — resolution prefers the referring file's package",
    'Result capped -- not every callee could be expanded.',
    '1 call sites workspace-wide could not be resolved (dynamic/platform/deep-chain).',
  ],
  'all five header lines combine in a fixed order: note, direction, duplicate names, capped, unresolved'
);

// =========================================================================
// v0.7.1 ORIENTATION: 'target-first' (default, byte-identical) vs
// 'entry-first' (pure re-rooting transform -- see uitree.js's ORIENTATION
// section). Six pinned scenarios, per the v0.7.1 work order.
// =========================================================================

// Small helper for these tests: UiNode children mix site rows (icon
// 'arrow-small-right', never collapsible) and real node rows; a branch
// "tip" is a node row with no node-row children of its own.
function uiNodeChildren(ui) {
  return (ui.children || []).filter((c) => c.iconId !== 'arrow-small-right');
}
function collectTips(ui, out) {
  const kids = uiNodeChildren(ui);
  if (!kids.length) out.push(ui);
  else kids.forEach((k) => collectTips(k, out));
  return out;
}

// --- effectiveOrientation: the single decision point ---
assert.strictEqual(effectiveOrientation({ direction: 'callers' }, 'entry-first'), 'entry-first');
assert.strictEqual(effectiveOrientation({}, 'entry-first'), 'entry-first', 'absent direction (a pre-v0.7 TreeResult) is the callers direction -- entry-first applies');
assert.strictEqual(effectiveOrientation({ direction: 'callers' }, 'target-first'), 'target-first');
assert.strictEqual(effectiveOrientation({ direction: 'callers' }, undefined), 'target-first', 'omitted orientation -> the default');
assert.strictEqual(effectiveOrientation({ direction: 'callers' }, 'bogus'), 'target-first', 'unknown orientation strings fall back to the default');
assert.strictEqual(effectiveOrientation({ direction: 'callees' }, 'entry-first'), 'target-first', 'callees direction neutralizes entry-first -- that tree already reads execution-forward');
assert.strictEqual(effectiveOrientation(null, undefined), 'target-first');

// --- (1) target-first output is UNCHANGED byte-for-byte vs today ---
// `topLevel` above was produced by the pre-v0.7.1 single-argument call and
// its rendered values are pinned by the earlier assertions; both explicit
// 'target-first' and an omitted orientation must reproduce it exactly.
const orientTfTree = { root: tnode, targetLabel: 'OppService.applyDiscount', note: null, direction: 'callers' };
assert.deepStrictEqual(
  shapeResult({ root: tnode, targetLabel: 'OppService.applyDiscount', note: null }, 'target-first'),
  topLevel,
  "explicit 'target-first' reproduces the pre-v0.7.1 pinned output exactly"
);
assert.strictEqual(
  JSON.stringify(shapeResult(orientTfTree, 'target-first')),
  JSON.stringify(shapeResult(orientTfTree)),
  "byte-for-byte: JSON of the explicit-'target-first' render equals the default render"
);
assert.strictEqual(
  JSON.stringify(shapeResult(orientTfTree, undefined)),
  JSON.stringify(shapeResult(orientTfTree)),
  'byte-for-byte: an undefined orientation argument equals the one-argument call'
);
assert.deepStrictEqual(
  shapeHeaderLines({ root: {}, targetLabel: 'x', note: 'n', direction: 'callers', stats: { capped: true } }, 'target-first'),
  ['n', 'Result capped -- not every caller could be expanded.'],
  'target-first adds NO orientation header line -- header byte-identical to today'
);

// --- (2) entry-first on a 3-level chain: entry at the root, target at the
// branch tip, edge data shifted one step toward the target ---
const efSiteEntryToMid = {
  path: '/ws/triggers/AcmeQuoteTrigger.trigger',
  line: 6,
  col: 2,
  lineText: 'new Handler().afterUpdate(Trigger.new);',
  argsRendered: 'quotes: Trigger.new',
  via: 'new',
};
const efSiteMidToTarget = {
  path: '/ws/Handler.cls',
  line: 11,
  col: 4,
  lineText: 'svc.applyDiscount(pct, oppId);',
  argsRendered: 'oppId: opps[0].Id, pct: 0.15',
  via: 'typed',
};
const efEntry = {
  label: 'AcmeQuoteTrigger',
  kind: 'trigger',
  className: 'AcmeQuoteTrigger',
  path: '/ws/triggers/AcmeQuoteTrigger.trigger',
  line: 1,
  entries: ['trigger on Quote (after update)'],
  isTest: false,
  via: 'new',
  sites: [efSiteEntryToMid],
  children: [],
  cyclic: false,
  truncated: false,
  approximate: false,
};
const efMid = {
  label: 'Handler.afterUpdate',
  kind: 'method',
  className: 'Handler',
  path: '/ws/Handler.cls',
  line: 9,
  entries: [],
  isTest: false,
  via: 'typed',
  sites: [efSiteMidToTarget],
  children: [efEntry],
  cyclic: false,
  truncated: false,
  approximate: false,
};
const efTargetRoot = {
  label: 'OppService.applyDiscount',
  kind: 'method',
  className: 'OppService',
  path: '/ws/OppService.cls',
  line: 4,
  entries: [],
  isTest: false,
  via: null,
  sites: [],
  children: [efMid],
  cyclic: false,
  truncated: false,
  approximate: false,
};

// Raw transform structure first (rerootEntryFirst directly).
const efRaw = rerootEntryFirst(efTargetRoot);
assert.strictEqual(efRaw.length, 1, 'one entry -> one entry-first root');
assert.strictEqual(efRaw[0].label, 'AcmeQuoteTrigger');
assert.strictEqual(efRaw[0]._entryFirstRoot, true, 'a genuine entry leaf is stamped as an entry-first root');
assert.strictEqual(efRaw[0].via, null, "a root has no incoming edge -- its former edge data ('entry calls mid') moved off it");
assert.deepStrictEqual(efRaw[0].sites, [], 'no site rows on the root');
assert.strictEqual(efRaw[0].children[0].label, 'Handler.afterUpdate');
assert.strictEqual(efRaw[0].children[0].via, 'new', "the mid node carries the edge from the entry ABOVE it ('entry calls mid')");
assert.deepStrictEqual(efRaw[0].children[0].sites, [efSiteEntryToMid], "…and that edge's sites, verbatim");
assert.strictEqual(efRaw[0].children[0].children[0].label, 'OppService.applyDiscount', 'the traced target is the deepest node of the branch');
assert.strictEqual(efRaw[0].children[0].children[0].via, 'typed', "the tip carries the edge from the mid node above it ('mid calls target')");
assert.deepStrictEqual(efRaw[0].children[0].children[0].sites, [efSiteMidToTarget]);
assert.deepStrictEqual(efRaw[0].children[0].children[0].children, [], 'the tip is a leaf');
assert.deepStrictEqual(
  rerootEntryFirst(efTargetRoot),
  efRaw,
  'rerootEntryFirst is deterministic and side-effect-free (second run over the same input is identical)'
);
assert.strictEqual(efTargetRoot.children[0].via, 'typed', 'the transform never mutates its input tree');
assert.deepStrictEqual(rerootEntryFirst(null), [], 'null root -> no entry-first roots');

// Shaped end to end.
const efShaped = shapeResult({ root: efTargetRoot, targetLabel: 'OppService.applyDiscount', note: null, direction: 'callers' }, 'entry-first');
assert.strictEqual(efShaped.length, 1);
const efRootUi = efShaped[0];
assert.strictEqual(efRootUi.label, 'AcmeQuoteTrigger', 'the entry (a target-first leaf) is the entry-first root');
assert.strictEqual(efRootUi.iconId, 'zap', 'the entry keeps its own kind/icon');
assert(efRootUi.description.includes('trigger on Quote (after update)'), 'the entry keeps its own entries badge');
assert(efRootUi.description.includes('◉ root'), 'a genuine entry keeps the root badge as an entry-first root -- it still has no known caller');
assert(!efRootUi.description.split(' · ').includes('new'), 'no via badge on the root -- its former edge data now hangs on the node below');
assert.strictEqual(efRootUi.children.length, 1, 'no site rows on the root either');
const efMidUi = efRootUi.children[0];
assert.strictEqual(efMidUi.label, 'Handler.afterUpdate');
assert(efMidUi.description.split(' · ').includes('new'), "the mid node's via badge is the edge from the entry above it");
assert.strictEqual(efMidUi.children.length, 2, 'mid node renders the entry->mid site row plus the target tip');
assert.strictEqual(
  efMidUi.children[0].label,
  'L6: new Handler().afterUpdate(Trigger.new);\n-> quotes: Trigger.new',
  "the site describing 'entry calls mid' hangs on the mid node, directly under its entry parent -- same adjacent pair as target-first"
);
const efTipUi = efMidUi.children[1];
assert.strictEqual(efTipUi.label, 'OppService.applyDiscount', 'the traced target sits at the branch tip');
assert(efTipUi.description.split(' · ').includes('typed'), "the tip's via badge is the edge from the mid node above it");
assert(!efTipUi.description.includes('◉ root'), 'the target tip NEVER gets the root badge -- it has callers (the whole chain above it)');
assert.strictEqual(efTipUi.children.length, 1);
assert.strictEqual(
  efTipUi.children[0].label,
  'L11: svc.applyDiscount(pct, oppId);\n-> oppId: opps[0].Id, pct: 0.15',
  "the site describing 'mid calls target' hangs on the target tip, adjacent to the mid node"
);
assert(efTipUi.tooltip.includes('entry-first:'), 'entry-first tooltip documents the edge-attachment convention on nodes carrying an incoming edge');
assert(efTipUi.tooltip.includes("caller's source file"), 'the tooltip explains the site lines live in the CALLER (parent) source file');
assert(!efRootUi.tooltip.includes('entry-first:'), 'no edge-attachment tooltip line on a root -- it carries no incoming edge');

// Multi-branch: the target must sit at EVERY branch tip.
const efEntry2 = {
  ...efEntry,
  label: 'AcmeNightlyBatch.execute',
  kind: 'method',
  className: 'AcmeNightlyBatch',
  path: '/ws/AcmeNightlyBatch.cls',
  line: 12,
  entries: ['Batchable'],
  via: 'static',
  sites: [{ path: '/ws/AcmeNightlyBatch.cls', line: 20, col: 4, lineText: 'Util.recalc(scope);', argsRendered: null, via: 'static' }],
};
const efMid2 = { ...efMid, label: 'Util.recalc', className: 'Util', path: '/ws/Util.cls', line: 3, via: 'static', sites: [{ path: '/ws/Util.cls', line: 5, col: 2, lineText: 'OppService.applyDiscount(a, b);', argsRendered: null, via: 'static' }], children: [efEntry2] };
const efTwoBranch = { ...efTargetRoot, children: [efMid, efMid2] };
const efTwoShaped = shapeResult({ root: efTwoBranch, targetLabel: 'OppService.applyDiscount', note: null, direction: 'callers' }, 'entry-first');
assert.strictEqual(efTwoShaped.length, 2, 'two distinct entries -> two entry-first roots');
assert.deepStrictEqual(efTwoShaped.map((r) => r.label), ['AcmeQuoteTrigger', 'AcmeNightlyBatch.execute'], 'root order preserves the target-first DFS order');
const efAllTips = efTwoShaped.reduce((acc, r) => collectTips(r, acc), []);
assert.strictEqual(efAllTips.length, 2);
assert(efAllTips.every((t) => t.label === 'OppService.applyDiscount'), 'the traced target is the deepest node of EVERY branch');

// --- (3) diamond: shared entry chain merges into ONE root (trie), no
// duplicated entry subtrees ---
const dSiteEA = { path: '/ws/EntryController.cls', line: 5, col: 2, lineText: 'HelperA.applyA(order);', argsRendered: null, via: 'static' };
const dSiteEB = { path: '/ws/EntryController.cls', line: 9, col: 2, lineText: 'HelperB.applyB(order);', argsRendered: null, via: 'static' };
const dSiteAT = { path: '/ws/HelperA.cls', line: 3, col: 4, lineText: 'svc.applyDiscount(a, b);', argsRendered: null, via: 'typed' };
const dSiteBT = { path: '/ws/HelperB.cls', line: 7, col: 4, lineText: 'OppService.applyDiscount(x, y);', argsRendered: null, via: 'static' };
const dEntryBase = {
  label: 'EntryController.run',
  kind: 'method',
  className: 'EntryController',
  path: '/ws/EntryController.cls',
  line: 3,
  entries: ['@AuraEnabled (LWC/Aura)'],
  isTest: false,
  children: [],
  cyclic: false,
  truncated: false,
  approximate: false,
};
// The SAME entry method reached through two different callers -- two
// distinct TNode instances (as the resolver really produces), each carrying
// only the sites of ITS OWN edge.
const dEntryUnderA = { ...dEntryBase, via: 'static', sites: [dSiteEA] };
const dEntryUnderB = { ...dEntryBase, via: 'static', sites: [dSiteEB] };
const dA = { label: 'HelperA.applyA', kind: 'method', className: 'HelperA', path: '/ws/HelperA.cls', line: 2, entries: [], isTest: false, via: 'typed', sites: [dSiteAT], children: [dEntryUnderA], cyclic: false, truncated: false, approximate: false };
const dB = { label: 'HelperB.applyB', kind: 'method', className: 'HelperB', path: '/ws/HelperB.cls', line: 6, entries: [], isTest: false, via: 'static', sites: [dSiteBT], children: [dEntryUnderB], cyclic: false, truncated: false, approximate: false };
const dRoot = { label: 'OppService.applyDiscount', kind: 'method', className: 'OppService', path: '/ws/OppService.cls', line: 4, entries: [], isTest: false, via: null, sites: [], children: [dA, dB], cyclic: false, truncated: false, approximate: false };
const dShaped = shapeResult({ root: dRoot, targetLabel: 'OppService.applyDiscount', note: null, direction: 'callers' }, 'entry-first');
assert.strictEqual(dShaped.length, 1, 'diamond: the shared entry merges into ONE entry-first root -- no duplicated entry subtrees');
const dRootUi = dShaped[0];
assert.strictEqual(dRootUi.label, 'EntryController.run');
assert(dRootUi.description.includes('◉ root'));
assert.strictEqual(dRootUi.children.length, 2, 'the merged root carries NO site rows of its own -- each per-edge site set moved onto the child it describes');
assert.deepStrictEqual(dRootUi.children.map((c) => c.label), ['HelperA.applyA', 'HelperB.applyB'], 'both diamond arms hang under the single merged entry');

// --- (4) sites stay attached to the correct edge after reversal ---
const dAUi = dRootUi.children[0];
const dBUi = dRootUi.children[1];
assert.strictEqual(
  dAUi.children[0].label,
  'L5: HelperA.applyA(order);',
  "the 'entry calls HelperA' site (L5) hangs on HelperA, whose tree-parent is exactly the entry -- pair (EntryController.run, HelperA.applyA) stays adjacent after reversal"
);
assert.strictEqual(
  dBUi.children[0].label,
  'L9: HelperB.applyB(order);',
  "the 'entry calls HelperB' site (L9) hangs on HelperB -- the two merged edges keep their site sets separated, nothing pools on the shared root"
);
const dTipA = dAUi.children[1];
const dTipB = dBUi.children[1];
assert.strictEqual(dTipA.label, 'OppService.applyDiscount');
assert.strictEqual(dTipA.children[0].label, 'L3: svc.applyDiscount(a, b);', "the 'HelperA calls target' site hangs on the target tip under HelperA");
assert(dTipA.description.split(' · ').includes('typed'), "…with HelperA's edge via");
assert.strictEqual(dTipB.children[0].label, 'L7: OppService.applyDiscount(x, y);', "the 'HelperB calls target' site hangs on the OTHER branch's tip");
assert(dTipB.description.split(' · ').includes('static'), "…with HelperB's edge via");
// Cross-check the SAME pair adjacency in the unchanged target-first render:
// there, the L5 site hangs on the entry node whose tree-PARENT is HelperA --
// same two nodes, other member of the pair.
const dShapedTF = shapeResult({ root: dRoot, targetLabel: 'OppService.applyDiscount', note: null, direction: 'callers' });
assert.strictEqual(dShapedTF[0].children[0].label, 'HelperA.applyA');
assert.strictEqual(dShapedTF[0].children[0].children[1].label, 'EntryController.run');
assert.strictEqual(
  dShapedTF[0].children[0].children[1].children[0].label,
  'L5: HelperA.applyA(order);',
  'target-first control: the same L5 site sits on the entry node directly under HelperA -- the reversal moved it across the SAME edge, not to a different pair'
);

// --- (5) cyclic and seenElsewhere (and truncated) markers survive ---
const mCyclic = { label: 'Recur.step', kind: 'method', className: 'Recur', path: '/ws/Recur.cls', line: 2, entries: [], isTest: false, via: 'static', sites: [{ path: '/ws/Recur.cls', line: 8, col: 2, lineText: 'MidA.run(n - 1);', argsRendered: null, via: 'static' }], children: [], cyclic: true, truncated: false, approximate: false };
const mSeen = { label: 'Shared.util', kind: 'method', className: 'Shared', path: '/ws/Shared.cls', line: 1, entries: [], isTest: false, via: 'static', sites: [{ path: '/ws/Shared.cls', line: 4, col: 2, lineText: 'MidB.helper();', argsRendered: null, via: 'static' }], children: [], cyclic: false, truncated: false, seenElsewhere: true, approximate: false };
const mTrunc = { label: 'Deep.caller', kind: 'method', className: 'Deep', path: '/ws/Deep.cls', line: 9, entries: [], isTest: false, via: 'typed', sites: [{ path: '/ws/Deep.cls', line: 12, col: 2, lineText: 'MidC.go();', argsRendered: null, via: 'typed' }], children: [], cyclic: false, truncated: true, approximate: false };
const mMidA = { label: 'MidA.run', kind: 'method', className: 'MidA', path: '/ws/MidA.cls', line: 2, entries: [], isTest: false, via: 'typed', sites: [{ path: '/ws/MidA.cls', line: 5, col: 2, lineText: 'T.m();', argsRendered: null, via: 'typed' }], children: [mCyclic], cyclic: false, truncated: false, approximate: false };
const mMidB = { ...mMidA, label: 'MidB.helper', className: 'MidB', path: '/ws/MidB.cls', children: [mSeen] };
const mMidC = { ...mMidA, label: 'MidC.go', className: 'MidC', path: '/ws/MidC.cls', children: [mTrunc] };
const mRoot = { label: 'T.m', kind: 'method', className: 'T', path: '/ws/T.cls', line: 1, entries: [], isTest: false, via: null, sites: [], children: [mMidA, mMidB, mMidC], cyclic: false, truncated: false, approximate: false };
const mShaped = shapeResult({ root: mRoot, targetLabel: 'T.m', note: null, direction: 'callers' }, 'entry-first');
assert.strictEqual(mShaped.length, 3, 'every boundary leaf becomes its own entry-first root -- no cross-boundary merging');
const [mCycRootUi, mSeenRootUi, mTruncRootUi] = mShaped;
assert.strictEqual(mCycRootUi.label, 'Recur.step');
assert(mCycRootUi.description.split(' · ').includes('↺ cycle'), 'the cyclic marker survives re-rooting');
assert(!mCycRootUi.description.includes('◉ root'), 'a cyclic boundary root is NOT a genuine entry -- no root badge');
assert(mCycRootUi.tooltip.includes('recurses back'), 'cyclic glossary line survives');
assert.strictEqual(mSeenRootUi.label, 'Shared.util');
assert(mSeenRootUi.description.split(' · ').includes('↪ continues above'), "seenElsewhere re-words to '↪ continues above' in entry-first, per the v0.7.1 spec");
assert(!mSeenRootUi.description.includes('↪ seen elsewhere'), 'the target-first wording does not leak into entry-first');
assert(!mSeenRootUi.description.includes('◉ root'), 'a seenElsewhere boundary root is NOT a genuine entry -- no root badge');
assert(mSeenRootUi.tooltip.includes('↪ continues above —'), 'entry-first seenElsewhere glossary line present');
assert.strictEqual(mTruncRootUi.label, 'Deep.caller');
assert(mTruncRootUi.description.split(' · ').includes('… depth cap'), 'the truncated marker survives re-rooting too');
assert(!mTruncRootUi.description.includes('◉ root'));
// Boundary roots still start a normal chain: their (former) edge data sits
// on the node below, and the chain ends at the target.
assert.strictEqual(uiNodeChildren(mCycRootUi)[0].label, 'MidA.run');
assert.strictEqual(uiNodeChildren(mCycRootUi)[0].children[0].label, 'L8: MidA.run(n - 1);', "the cyclic root's former site hangs on the node below it, same shift as everywhere else");
assert(collectTips(mCycRootUi, []).every((t) => t.label === 'T.m'));
// …and the unchanged target-first render still uses the original wording.
const mShapedTF = shapeResult({ root: mRoot, targetLabel: 'T.m', note: null, direction: 'callers' });
const mSeenTF = mShapedTF[0].children[1].children[1];
assert.strictEqual(mSeenTF.label, 'Shared.util');
assert(mSeenTF.description.includes('↪ seen elsewhere'), "target-first keeps '↪ seen elsewhere' -- the re-wording is entry-first-only");

// --- (6) empty/zero-caller tree: the same honest note, and an identical
// single-node render, in BOTH orientations ---
const zRoot = { label: 'AcmeUnused.helper', kind: 'method', className: 'AcmeUnused', path: '/ws/AcmeUnused.cls', line: 2, entries: [], isTest: false, via: null, sites: [], children: [], cyclic: false, truncated: false, approximate: false };
const zTree = {
  root: zRoot,
  targetLabel: 'AcmeUnused.helper',
  note: 'No callers found — this is likely an entry point or unused code.',
  direction: 'callers',
  stats: { nodes: 1, uniqueMethods: 1, capped: false, unresolvedSites: 0 },
};
const zTF = shapeResult(zTree);
const zEF = shapeResult(zTree, 'entry-first');
assert.deepStrictEqual(zEF, zTF, 'a zero-caller tree renders IDENTICALLY in both orientations -- one node, root badge, tooltip and all');
assert.strictEqual(zTF.length, 1);
assert(zTF[0].description.includes('◉ root'));
const zHeadTF = shapeHeaderLines(zTree);
const zHeadEF = shapeHeaderLines(zTree, 'entry-first');
assert.strictEqual(zHeadTF[0], 'No callers found — this is likely an entry point or unused code.');
assert.strictEqual(zHeadEF[0], zHeadTF[0], 'the honest zero-caller note leads the header in BOTH orientations');
assert(
  zHeadEF.includes('Entry-first orientation: entry points at the top, the traced target at each branch tip.'),
  'entry-first states the active orientation in the header'
);
assert.strictEqual(zHeadTF.length, 1, 'target-first adds no orientation line -- header byte-identical to today');

// --- orientation is callers-only: entry-first is a pure no-op on a
// callees-direction tree, at both the tree and the header layer ---
const cTree = { root: tnode, targetLabel: 'OppService.applyDiscount', note: null, direction: 'callees' };
assert.strictEqual(
  JSON.stringify(shapeResult(cTree, 'entry-first')),
  JSON.stringify(shapeResult(cTree)),
  'entry-first is a byte-identical no-op in the callees direction -- that tree already reads execution-forward'
);
assert.deepStrictEqual(
  shapeHeaderLines(cTree, 'entry-first'),
  shapeHeaderLines(cTree),
  'no orientation header line in the callees direction either'
);

// --- header composition: the orientation line slots after note/direction,
// before the stats lines ---
assert.deepStrictEqual(
  shapeHeaderLines(
    { root: {}, targetLabel: 'x', note: 'n', direction: 'callers', stats: { duplicateNames: 2, capped: true, unresolvedSites: 1 } },
    'entry-first'
  ),
  [
    'n',
    'Entry-first orientation: entry points at the top, the traced target at each branch tip.',
    "2 duplicate class names across packages — resolution prefers the referring file's package",
    'Result capped -- not every caller could be expanded.',
    '1 call sites workspace-wide could not be resolved (dynamic/platform/deep-chain).',
  ],
  'entry-first header line slots between the note and the stats lines'
);

console.log('apex-trace uitree self-check: all assertions passed');

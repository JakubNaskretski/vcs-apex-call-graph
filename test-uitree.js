'use strict';
// Self-check for the pure UI-shaping layer: node test-uitree.js
// No vscode dependency — everything here is plain data in/out, built
// against the frozen TNode/SiteView contract (see uitree.js header).
const assert = require('assert');
const {
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

console.log('apex-trace uitree self-check: all assertions passed');

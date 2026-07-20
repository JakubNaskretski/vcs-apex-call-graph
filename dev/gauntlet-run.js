'use strict';
// Examiner run: real engine (parser.js + resolver.js + metascan.js) over
// the source-controlled fictional gauntlet corpus, mechanically diffed
// against GROUND-TRUTH.md. Read-only against the engine; writes nothing
// to the corpus. Prints a structured report to stdout.

const fs = require('fs');
const path = require('path');
const parser = require('../parser');
const resolver = require('../resolver');
const metascan = require('../metascan');
const uitree = require('../uitree');
const { advOrgRoot, gauntletOrgRoot } = require('./corpus-paths');

// Keep paths relative in diagnostics so verification logs are portable and
// never expose a machine-local home directory.
const ORG_ROOT = path.relative(process.cwd(), gauntletOrgRoot) || '.';
const FORCE_APP = path.join(ORG_ROOT, 'force-app');
const SKIP_DIRS = new Set(['.sfdx', '.sf', 'node_modules', '.git']);

// ---------------------------------------------------------------------
// 1. Walk the corpus, split Apex source files from metadata files.
// ---------------------------------------------------------------------
const apexFiles = [];
const metaFiles = [];
function walk(dir) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (e) {
    return;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue;
      walk(full);
    } else if (/\.(cls|trigger)$/i.test(e.name)) {
      apexFiles.push(full);
    } else if (/\.(cls|trigger)-meta\.xml$/i.test(e.name)) {
      // Apex-file sidecar ONLY (e.g. Foo.cls-meta.xml) -- not scanned as
      // Apex or metascan input. v0.8-B5 BUG FIX: the old pattern here was
      // the over-broad `/-meta\.xml$/i`, which ALSO matched (and silently
      // dropped) genuine metascan content files that happen to share the
      // "-meta.xml" suffix convention -- .flow-meta.xml, .md-meta.xml,
      // .cmp-meta.xml, .app-meta.xml, .os-meta.xml, .page-meta.xml,
      // .component-meta.xml, .js-meta.xml (an LWC's OWN metadata, distinct
      // from its .js source) -- see metascan.js's own COMPOUND_EXT for the
      // authoritative list this corpus can contain. Those must fall through
      // to the `metaFiles` bucket below like any other metadata file (this
      // is exactly what v0.8-B5's Vtx_Namespace_Probe_Flow.flow-meta.xml and
      // Kappa_Trigger_Config.Namespace_Handler.md-meta.xml need).
    } else {
      metaFiles.push(full);
    }
  }
}
walk(FORCE_APP);

console.log('=== CORPUS INVENTORY ===');
console.log('Apex files found:', apexFiles.length, '(expect 277 after the v0.14 Impact fixture matrix)');
console.log('Non-Apex metadata files found (metascan candidates):', metaFiles.length);
metaFiles.forEach((f) => console.log('  META:', path.relative(ORG_ROOT, f)));

// ---------------------------------------------------------------------
// 2. parseFile every .cls/.trigger; confirm parseError == null everywhere.
// ---------------------------------------------------------------------
const factsList = [];
const parseErrors = [];
for (const abs of apexFiles) {
  const text = fs.readFileSync(abs, 'utf8');
  const facts = parser.parseFile({ path: abs, text });
  factsList.push(facts);
  if (facts.parseError) {
    parseErrors.push({ path: abs, error: facts.parseError });
  }
}
console.log('\n=== PARSE RESULTS ===');
console.log('Files parsed:', factsList.length);
console.log('Parse errors:', parseErrors.length);
for (const pe of parseErrors) {
  console.log('  PARSE ERROR:', path.relative(ORG_ROOT, pe.path), '->', pe.error);
}

// ---------------------------------------------------------------------
// 3. metascan.parseMetaFile over any non-Apex metadata files. v0.8-B5 adds
//    this corpus's FIRST real metadata files (a Flow + a CMDT record + an
//    LWC bundle's .js, per v0.8-A5/B5) -- pre-v0.8 this branch was dead
//    (metaFiles.length === 0 always). This corpus has no Aura bundles, so
//    parseMetaFile alone (which dispatches LWC .js -> extractLwc directly,
//    same as every other metadata kind) covers every file here; scanBundle
//    is Aura-only (see its own header) and would silently skip all of them.
// ---------------------------------------------------------------------
console.log('\n=== METASCAN ===');
let metaRefs = [];
if (metaFiles.length === 0) {
  console.log('No metadata files present in corpus (no LWC/Aura/Flow/OmniScript/VF). metascan.parseMetaFile not invoked (nothing to scan).');
} else {
  for (const f of metaFiles) {
    try {
      const text = fs.readFileSync(f, 'utf8');
      const res = metascan.parseMetaFile({ path: f, text });
      for (const ref of res) { ref.path = f; metaRefs.push(ref); }
      console.log('  SCANNED:', path.relative(ORG_ROOT, f), '->', JSON.stringify(res));
    } catch (e) {
      console.log('  SCAN ERROR:', path.relative(ORG_ROOT, f), '->', e.message);
    }
  }
  console.log(`Total metaRefs extracted: ${metaRefs.length}`);
}

// ---------------------------------------------------------------------
// 4. buildSemanticIndex with packageOf + ownNamespace derived from
//    sfdx-project.json (single default packageDirectory "force-app").
//    v0.8/N3: sfdx-project.json now also carries a top-level "namespace"
//    property ("vtx", per v0.8-B) -- read it here exactly like extension.js
//    does (discoverPackageMap) and dev/smoke.js's own sfdx-project.json
//    readers, and pass it through as opts.ownNamespace so B1's own-
//    namespace-resolves-locally contract is actually exercised by this
//    examiner run, not silently skipped.
// ---------------------------------------------------------------------
function buildPackageOf() {
  const sfdxProjectPath = path.join(ORG_ROOT, 'sfdx-project.json');
  let json;
  try {
    json = JSON.parse(fs.readFileSync(sfdxProjectPath, 'utf8'));
  } catch (e) {
    return { packageOf: () => null, defaultPackage: null, ownNamespace: null };
  }
  const dirs = Array.isArray(json.packageDirectories) ? json.packageDirectories : [];
  const prefixes = [];
  let defaultPackage = null;
  for (const dir of dirs) {
    if (!dir || typeof dir.path !== 'string' || !dir.path.trim()) continue;
    const relPath = dir.path.replace(/^[\\/]+/, '').replace(/[\\/]+$/, '');
    if (!relPath) continue;
    const label = typeof dir.package === 'string' && dir.package.trim() ? dir.package.trim() : relPath.split(/[\\/]/).pop();
    prefixes.push({ prefix: path.join(ORG_ROOT, relPath), label });
    if (dir.default === true) defaultPackage = label;
  }
  prefixes.sort((a, b) => b.prefix.length - a.prefix.length);
  const packageOf = function (fsPath) {
    if (!fsPath || !prefixes.length) return null;
    for (const { prefix, label } of prefixes) {
      if (fsPath === prefix || fsPath.startsWith(prefix + path.sep)) return label;
    }
    return null;
  };
  const ownNamespace = typeof json.namespace === 'string' && json.namespace.trim() ? json.namespace.trim() : null;
  return { packageOf, defaultPackage, ownNamespace };
}
const { packageOf, defaultPackage, ownNamespace } = buildPackageOf();
console.log('\n=== SFDX PROJECT ===');
console.log('defaultPackage:', defaultPackage);
console.log('ownNamespace:', JSON.stringify(ownNamespace));

const index = resolver.buildSemanticIndex(factsList, { packageOf, defaultPackage, ownNamespace });
// v0.8/N1(c)/N3: attach metascan.js's MetaRef[] (Flow/CMDT/LWC) onto the
// SAME index, mirroring extension.js's real call order exactly --
// metascan.stripOwnNamespace(metaRefs, ownNamespace) BEFORE
// attachMetaCallers (both extension.js and resolver.js's own attachMetaCallers
// independently detect/strip the own namespace too -- see resolver.js's
// detectMetaRefNamespace header note -- so this call is redundant-but-
// harmless defense in depth, matching the real product's actual pipeline
// byte-for-byte rather than a simplified one).
const strippedMetaRefs = ownNamespace && typeof metascan.stripOwnNamespace === 'function'
  ? metascan.stripOwnNamespace(metaRefs, ownNamespace)
  : metaRefs;
resolver.attachMetaCallers(index, strippedMetaRefs);
// v0.12.0 / C1 seam: every '.flow-meta.xml' path this walk saw, mirroring
// extension.js's real scanAndBuildIndex() wiring exactly (see its own
// header note) -- read only by resolver.buildEntryCatalog's
// collectFlowEntries, in the '## Entry catalog' section far below.
index.flowFilePaths = metaFiles.filter((p) => /\.flow-meta\.xml$/i.test(p));
console.log('index.stats:', JSON.stringify(index.stats));

// ---------------------------------------------------------------------
// Helpers for tree inspection / diffing.
// ---------------------------------------------------------------------
function relLine(node) {
  if (!node.path) return `${node.line}`;
  return `${path.relative(ORG_ROOT, node.path)}:${node.line}`;
}

function dumpNode(node, depth, out) {
  const pad = '  '.repeat(depth);
  const badges = [];
  if (node.via) badges.push('via=' + node.via);
  if (node.isTest) badges.push('test');
  if (node.cyclic) badges.push('cyclic');
  if (node.truncated) badges.push('truncated');
  if (node.approximate) badges.push('~approx');
  if (node.entries && node.entries.length) badges.push(node.entries.join(','));
  if (node.seenElsewhere) badges.push('seenElsewhere');
  out.push(`${pad}${node.label} [${node.kind}] ${badges.join(' ')} @ ${relLine(node)}`);
  if (node.sites && node.sites.length) {
    for (const s of node.sites) {
      out.push(`${pad}  site L${s.line}:${s.col} via=${s.via} ${s.lineText ? '// ' + s.lineText.trim().slice(0, 90) : ''}`);
    }
  }
  for (const c of node.children || []) dumpNode(c, depth + 1, out);
}

function printTree(label, tree) {
  console.log(`\n--- ${label} ---`);
  console.log('note:', tree.note);
  console.log('direction:', tree.direction);
  console.log('stats:', JSON.stringify(tree.stats));
  const out = [];
  dumpNode(tree.root, 0, out);
  console.log(out.join('\n'));
  return tree;
}

function findAllLabels(node, out) {
  out.push(node.label + '#' + (node.methodLower || ''));
  for (const c of node.children || []) findAllLabels(c, out);
  return out;
}

function collectAllNodeLabelsFlat(tree) {
  return findAllLabels(tree.root, []);
}

// direct-children labels only (level 1)
function directChildLabels(tree) {
  return (tree.root.children || []).map((c) => c.label);
}

// The original gauntlet assertions describe the pre-v0.13 flat execution
// tree. Keep those assertions stable while the dedicated hardening section
// below exercises the new default rollup and scoped informational header.
const buildCallerTreeRaw = resolver.buildCallerTree.bind(resolver);
const buildCalleeTreeRaw = resolver.buildCalleeTree.bind(resolver);
resolver.buildCallerTree = function buildLegacyCallerTree(indexArg, target, opts) {
  const tree = buildCallerTreeRaw(indexArg, target, { ...(opts || {}), showUnconfirmed: 'expand' });
  tree.root.children = (tree.root.children || []).filter((child) => child.kind !== 'unresolved-mentions');
  if (!tree.root.children.length && !tree.note) tree.note = 'No callers found.';
  return tree;
};
resolver.buildCalleeTree = function buildLegacyCalleeTree(indexArg, target, opts) {
  return buildCalleeTreeRaw(indexArg, target, { ...(opts || {}), showUnconfirmed: 'expand' });
};

const findings = { BUG: [], KNOWN_GAP: [], NEW_GAP: [], NOTE: [] };
function bug(id, desc) {
  findings.BUG.push({ id, desc });
  console.log(`  [BUG] ${id}: ${desc}`);
}
function knownGap(id, desc) {
  findings.KNOWN_GAP.push({ id, desc });
  console.log(`  [KNOWN-GAP] ${id}: ${desc}`);
}
function newGap(id, desc) {
  findings.NEW_GAP.push({ id, desc });
  console.log(`  [NEW-GAP] ${id}: ${desc}`);
}
function note(id, desc) {
  findings.NOTE.push({ id, desc });
  console.log(`  [NOTE] ${id}: ${desc}`);
}

// =======================================================================
// TARGET 1 — VertexPricingService.reprice (callers) -- THE fan-in target
// =======================================================================
console.log('\n\n########## TARGET 1: VertexPricingService.reprice (callers) ##########');
{
  const tree = printTree('T1 VertexPricingService.reprice callers', resolver.buildCallerTree(index, { classLower: 'vertexpricingservice', methodLower: 'reprice' }, {}));
  const expectedLabels = [
    'VertexPricingService.repriceOrder',
    'VertexOrderController.recalculate',
    'VertexOrderController.bulkRecalculate',
    'VertexOrderService.processOrder',
    'VertexOrderService.reconcileOrder',
    'VertexOrderTriggerHandler.handleAfterUpdate',
    'VertexOrderTriggerHandler.handleAfterInsert',
    'VertexRepriceBatch.execute',
    'VertexBulkRepriceUtil.repriceBatch',
    'VertexRepriceableDispatcher.dispatch',
    // v0.7.1: GROUND-TRUTH.md Section 3's own authoring defect, corrected --
    // VertexPremiumPricingService.reprice's own super.reprice(order) call is
    // a genuine 17th caller node (via=super), previously omitted from this
    // table despite Section 2's per-file spec requiring it (see
    // VALIDATION-REPORT.md item 29 / dev/gauntlet run findings T1-count).
    'VertexPremiumPricingService.reprice',
    'VertexPricingServiceTest.testReprice',
    'VertexOrderServiceTest.testDirectReprice',
    'VertexOrderTriggerHandlerTest.testHandleAfterUpdateDirect',
    'VertexOrderApprovalInvocable.execute',
    'VertexOrderConversionService.convertAndReprice',
    'VertexQuoteToOrderConverter.finalizeOrder',
  ];
  const actualLabels = directChildLabels(resolver.buildCallerTree(index, { classLower: 'vertexpricingservice', methodLower: 'reprice' }, {}));
  console.log('\nDirect child count actual:', actualLabels.length, 'expected: 17');
  if (actualLabels.length !== 17) {
    bug('T1-count', `Direct caller node count = ${actualLabels.length}, expected 17. Actual labels: ${JSON.stringify(actualLabels)}`);
  }
  const missing = expectedLabels.filter((l) => !actualLabels.includes(l));
  const extra = actualLabels.filter((l) => !expectedLabels.includes(l));
  if (missing.length) bug('T1-missing', `Missing expected caller nodes: ${JSON.stringify(missing)}`);
  if (extra.length) bug('T1-extra', `Unexpected/phantom caller nodes present: ${JSON.stringify(extra)}`);

  // tests-last ordering: isTest nodes must sort after non-test nodes; among
  // each group, alphabetical by label (per sortTNodes).
  const nonTest = actualLabels.filter((l) => !/Test\./.test(l) && !l.includes('Test'));
  console.log('Ordering as returned:', JSON.stringify(actualLabels));
  let sawTest = false;
  let orderOk = true;
  const t1tree = resolver.buildCallerTree(index, { classLower: 'vertexpricingservice', methodLower: 'reprice' }, {});
  for (const c of t1tree.root.children) {
    if (c.isTest) sawTest = true;
    else if (sawTest) orderOk = false; // non-test after a test -> violates tests-last
  }
  if (!orderOk) bug('T1-order', 'tests-last ordering violated: a non-test node appears after a test node in VertexPricingService.reprice caller list.');
  else console.log('tests-last ordering: OK');

  // multi-site checks
  const byLabel = {};
  for (const c of t1tree.root.children) byLabel[c.label] = c;
  const reconcile = byLabel['VertexOrderService.reconcileOrder'];
  if (!reconcile) bug('T1-reconcile-missing', 'VertexOrderService.reconcileOrder node missing entirely.');
  else if (!reconcile.sites || reconcile.sites.length !== 2) bug('T1-reconcile-sites', `reconcileOrder expected 2 site rows under 1 node (multi-site #1), got ${reconcile.sites ? reconcile.sites.length : 'undefined'}.`);
  else console.log('MULTI-SITE #1 (reconcileOrder): OK, 2 sites 1 node.');

  const bulkReprice = byLabel['VertexBulkRepriceUtil.repriceBatch'];
  if (!bulkReprice) bug('T1-bulkreprice-missing', 'VertexBulkRepriceUtil.repriceBatch node missing entirely.');
  else if (!bulkReprice.sites || bulkReprice.sites.length !== 2) bug('T1-bulkreprice-sites', `repriceBatch expected 2 site rows under 1 node (multi-site #2), got ${bulkReprice.sites ? bulkReprice.sites.length : 'undefined'}.`);
  else console.log('MULTI-SITE #2 (repriceBatch): OK, 2 sites 1 node.');

  // interface fan-out (dispatcher) should include grandchild leg to
  // VertexPremiumPricingService.reprice (override fan-out) SOMEWHERE under
  // the dispatcher subtree, or as a sibling top-level entry -- GROUND-TRUTH
  // says "also fans to sibling target VertexPremiumPricingService.reprice"
  // meaning it's a fan-out of the SAME call site, i.e. this exact target
  // (VertexPricingService.reprice base) should show the dispatcher as ONE
  // of its callers (already checked above); the override fan-out itself
  // is a property of the interface-dispatch call site widening to both
  // implementers -- checked properly by tracing VertexPremiumPricingService
  // .reprice's OWN caller tree below (not asserted further here).
  const dispatcher = byLabel['VertexRepriceableDispatcher.dispatch'];
  if (dispatcher) {
    if (!dispatcher.via || !/interface/i.test(dispatcher.via)) bug('T1-dispatcher-via', `Dispatcher node via = ${dispatcher.via}, expected interface(~).`);
    else console.log('Dispatcher via=interface: OK (' + dispatcher.via + ')');
  }

  // Non-edges: VertexShippingController.recalcShipping must NEVER appear.
  const allLabelsFlat = collectAllNodeLabelsFlat(t1tree);
  if (allLabelsFlat.some((l) => l.startsWith('VertexShippingController.recalcShipping'))) {
    bug('T1-nonedge-shippingcontroller', 'VertexShippingController.recalcShipping (calls a DIFFERENT reprice) appears somewhere in VertexPricingService.reprice caller tree -- precision-trap pollution.');
  } else {
    console.log('Non-edge check (VertexShippingController.recalcShipping absent): OK');
  }
  if (allLabelsFlat.some((l) => l.startsWith('VertexOrderMigrationUtil.legacyRepriceDispatch'))) {
    bug('T1-nonedge-migrationutil', 'VertexOrderMigrationUtil.legacyRepriceDispatch (ambiguous 2-candidate receiver) appears in VertexPricingService.reprice caller tree -- should be unresolved, zero edges.');
  } else {
    console.log('Non-edge check (VertexOrderMigrationUtil.legacyRepriceDispatch absent): OK');
  }

  // Ancestors -- one level further up.
  console.log('\nAncestor spot-checks (grandparents):');
  function findNodeByLabel(node, label) {
    if (node.label === label) return node;
    for (const c of node.children || []) {
      const f = findNodeByLabel(c, label);
      if (f) return f;
    }
    return null;
  }
  // ROUND C ADJUDICATION (2026-07-17), T1-anc-facade + T1-anc-nightlyjob:
  // the deep ancestors were NEVER missing from the tree. The old NOTE-level
  // checks used findNodeByLabel above (DFS pre-order, first label match),
  // and because 'VertexPremiumPricingService.reprice' (via=super) sorts
  // alphabetically before both 'VertexPricingService.repriceOrder' and
  // 'VertexRepriceBatch.execute' among the root's children, the DFS
  // descended into the Premium override-fan-out subtree first and matched
  // the H1 DAG-memoization seenElsewhere REFERENCE copies there -- whose
  // children are DELIBERATELY [] per resolver.js buildOneChildNode case 3
  // ("show it as a reference node ... instead of re-walking"). The
  // EXPANDED occurrence of each identity (always the depth-1 direct-caller
  // node: the walk is BFS level-order, so a depth-1 occurrence registers
  // in ctx.expandedKeys before any deeper copy is built) carries the
  // ancestors exactly where GROUND-TRUTH Target 1 "Ancestors" expects
  // them. Isolated repro incl. no-override control:
  // dev/gauntlet/repro-roundc-t1-anc-dagdedup.js. Both checks are
  // therefore now hard [MUST -- adjudicated 2026-07-17] assertions against
  // the EXPANDED occurrence (findExpandedNodeByLabel below); absence of
  // either ancestor from that node is a BUG, never a NOTE.
  function findExpandedNodeByLabel(root, label) {
    // BFS; prefer the expanded (non-seenElsewhere) occurrence, fall back
    // to a reference copy only if no expanded one exists anywhere.
    let fallback = null;
    const queue = [root];
    while (queue.length) {
      const n = queue.shift();
      if (n.label === label) {
        if (!n.seenElsewhere) return n;
        if (!fallback) fallback = n;
      }
      for (const c of n.children || []) queue.push(c);
    }
    return fallback;
  }
  // hAU lookup switched to the expanded-preferring finder too (identical
  // result today -- 'VertexOrderTriggerHandler...' sorts before
  // 'VertexPremium...', so the naive DFS already hit the expanded node --
  // but this keeps the check immune to future corpus additions shifting
  // the sort order). Severity unchanged (NOTE): T1-anc-trigger/T1-anc-test
  // were not part of the Round C adjudication.
  const hAU = findExpandedNodeByLabel(t1tree.root, 'VertexOrderTriggerHandler.handleAfterUpdate');
  if (hAU) {
    const grandLabels = (hAU.children || []).map((c) => c.label);
    console.log('  handleAfterUpdate grandparents:', JSON.stringify(grandLabels));
    if (!grandLabels.includes('VertexOrderTrigger')) note('T1-anc-trigger', `Expected VertexOrderTrigger as ancestor of handleAfterUpdate; got ${JSON.stringify(grandLabels)}`);
    if (!grandLabels.some((l) => l.includes('VertexOrderTriggerHandlerTest'))) note('T1-anc-test', `Expected VertexOrderTriggerHandlerTest ancestor of handleAfterUpdate; got ${JSON.stringify(grandLabels)}`);
  } else {
    bug('T1-anc-hAU-missing', 'Could not locate handleAfterUpdate node to check ancestors.');
  }
  // Observation only (NOT asserted -- this shape is incidental to the
  // current override-fan-out policy, the asserted invariant is ancestor
  // presence on the expanded node below): the naive DFS-first match for
  // the two adjudicated identities is expected to be an H1 seenElsewhere
  // reference copy under the Premium subtree.
  for (const lbl of ['VertexPricingService.repriceOrder', 'VertexRepriceBatch.execute']) {
    const naive = findNodeByLabel(t1tree.root, lbl);
    console.log(`  (info) naive DFS-first match for ${lbl}: seenElsewhere=${naive ? naive.seenElsewhere : 'n/a'}, children=${naive ? (naive.children || []).length : 'n/a'}`);
  }
  const repriceOrderNode = findExpandedNodeByLabel(t1tree.root, 'VertexPricingService.repriceOrder');
  if (!repriceOrderNode || repriceOrderNode.seenElsewhere) {
    bug('T1-anc-facade', `[MUST -- adjudicated 2026-07-17] No EXPANDED occurrence of VertexPricingService.repriceOrder in the tree (got ${repriceOrderNode ? 'reference copy only' : 'nothing'}).`);
  } else {
    const gl = (repriceOrderNode.children || []).map((c) => c.label);
    console.log('  repriceOrder grandparents (expanded occurrence):', JSON.stringify(gl));
    if (!gl.includes('VertexOrderStaticFacade.triggerReprice')) bug('T1-anc-facade', `[MUST -- adjudicated 2026-07-17] Expected VertexOrderStaticFacade.triggerReprice ancestor on the EXPANDED repriceOrder occurrence; got ${JSON.stringify(gl)}`);
    else console.log('  T1-anc-facade: OK [MUST -- adjudicated 2026-07-17], facade grandparent present on expanded occurrence.');
  }
  const execNode = findExpandedNodeByLabel(t1tree.root, 'VertexRepriceBatch.execute');
  if (!execNode || execNode.seenElsewhere) {
    bug('T1-anc-nightlyjob', `[MUST -- adjudicated 2026-07-17] No EXPANDED occurrence of VertexRepriceBatch.execute in the tree (got ${execNode ? 'reference copy only' : 'nothing'}).`);
  } else {
    const gl = (execNode.children || []).map((c) => c.label);
    console.log('  VertexRepriceBatch.execute ancestors (expanded occurrence):', JSON.stringify(gl));
    if (!gl.some((l) => l.includes('VertexNightlyAdjustmentJob'))) bug('T1-anc-nightlyjob', `[MUST -- adjudicated 2026-07-17] Expected VertexNightlyAdjustmentJob.execute great-grandparent chain on the EXPANDED VertexRepriceBatch.execute occurrence; got ${JSON.stringify(gl)}`);
    else console.log('  T1-anc-nightlyjob: OK [MUST -- adjudicated 2026-07-17], nightly-job great-grandparent present on expanded occurrence.');
  }
}

// =======================================================================
// TARGET 1b — VertexPremiumPricingService.reprice caller tree (override
// fan-out sibling target check for the dispatcher)
// =======================================================================
console.log('\n\n########## TARGET 1b: VertexPremiumPricingService.reprice (callers) — override fan-out sibling ##########');
{
  const tree = printTree('T1b VertexPremiumPricingService.reprice callers', resolver.buildCallerTree(index, { classLower: 'vertexpremiumpricingservice', methodLower: 'reprice' }, {}));
  const labels = directChildLabels(tree);
  if (!labels.includes('VertexRepriceableDispatcher.dispatch')) {
    bug('T1b-override-fanout', `VertexRepriceableDispatcher.dispatch expected as a caller of VertexPremiumPricingService.reprice (override fan-out leg), got children: ${JSON.stringify(labels)}`);
  } else {
    console.log('Override fan-out to VertexPremiumPricingService.reprice: OK');
  }
  // also super.reprice() call inside VertexPremiumPricingService.reprice
  // itself is a CALLEE of THIS method, not a caller -- not checked here.
}

// =======================================================================
// TARGET 2 — VertexPricingService.repriceOrder (callers)
// =======================================================================
console.log('\n\n########## TARGET 2: VertexPricingService.repriceOrder (callers) ##########');
{
  const tree = printTree('T2 VertexPricingService.repriceOrder callers', resolver.buildCallerTree(index, { classLower: 'vertexpricingservice', methodLower: 'repriceorder' }, {}));
  const labels = directChildLabels(tree);
  // v0.8-B1 REGRESSION POLICY category (c): VtxOwnNamespaceProbe.cls (new
  // v0.8-B corpus fixture) adds a SECOND, genuinely new local caller here --
  // vtx.VertexPricingService.repriceOrder(order), own-namespace-stripped
  // per N3 into an ordinary local static call. The pre-existing v0.7.1
  // caller (VertexOrderStaticFacade.triggerReprice) is completely
  // unaffected -- this is a pure addition, not a changed pre-existing
  // expectation, and the v0.8-B1 GROUND-TRUTH.md table for this exact site
  // states the expected outcome as "Edge -> local VertexPricingService
  // .repriceOrder, via=static" (see B1's own row for L3).
  const expected = ['VertexOrderStaticFacade.triggerReprice', 'VtxOwnNamespaceProbe.callOwnNamespaceClass'].sort();
  if (JSON.stringify(labels.slice().sort()) !== JSON.stringify(expected)) {
    bug('T2-caller', `Expected exactly 2 callers ${JSON.stringify(expected)} (pre-existing VertexOrderStaticFacade.triggerReprice + v0.8-B1's own-namespace-stripped VtxOwnNamespaceProbe.callOwnNamespaceClass), got ${JSON.stringify(labels)}`);
  } else {
    console.log('T2 caller shape: OK -- pre-existing v0.7.1 caller unchanged, PLUS v0.8-B1\'s own-namespace-stripped local caller (VtxOwnNamespaceProbe.callOwnNamespaceClass) [MUST] per N3');
    const ownNsChild = tree.root.children.find((c) => c.label === 'VtxOwnNamespaceProbe.callOwnNamespaceClass');
    if (ownNsChild.via !== 'static') bug('T2-ownns-via', `v0.8-B1 [MUST]: VtxOwnNamespaceProbe.callOwnNamespaceClass edge via=${ownNsChild.via}, expected 'static' (an ordinary local static call, post-strip)`);
  }
}

// =======================================================================
// TARGET 3 — VertexShippingCostService.reprice (precision-trap target)
// =======================================================================
console.log('\n\n########## TARGET 3: VertexShippingCostService.reprice (callers) ##########');
{
  const tree = printTree('T3 VertexShippingCostService.reprice callers', resolver.buildCallerTree(index, { classLower: 'vertexshippingcostservice', methodLower: 'reprice' }, {}));
  const labels = directChildLabels(tree);
  if (labels.length !== 1 || labels[0] !== 'VertexShippingController.recalcShipping') {
    bug('T3-caller', `Expected exactly 1 caller VertexShippingController.recalcShipping, got ${JSON.stringify(labels)}`);
  } else {
    console.log('T3 caller shape: OK, no pollution from the 16 VertexPricingService.reprice callers.');
  }
}

// =======================================================================
// TARGETS 4/5/6 + the other 9 uncalled processors — the 12-way collision
// =======================================================================
console.log('\n\n########## TARGETS 4-6 + 12-way process() collision ##########');
{
  const stageMap = {
    VertexIngestProcessor: 'runIngest',
    VertexValidationProcessor: 'runValidation',
  };
  const allProcessors = [
    'VertexIngestProcessor', 'VertexValidationProcessor', 'VertexEnrichmentProcessor',
    'VertexRoutingProcessor', 'VertexAuditProcessor', 'VertexBillingProcessor',
    'VertexComplianceProcessor', 'VertexArchiveProcessor', 'VertexNotifyProcessor',
    'VertexSyncProcessor', 'VertexCleanupProcessor', 'VertexFinalizeProcessor',
  ];
  for (const cls of allProcessors) {
    const tree = resolver.buildCallerTree(index, { classLower: cls.toLowerCase(), methodLower: 'process' }, {});
    const labels = directChildLabels(tree);
    if (stageMap[cls]) {
      const expectedCaller = `VertexPipelineRunner.${stageMap[cls]}`;
      if (labels.length !== 1 || labels[0] !== expectedCaller) {
        bug(`T4-6-${cls}`, `${cls}.process expected exactly 1 caller ${expectedCaller}, got ${JSON.stringify(labels)} (note: ${tree.note})`);
      } else {
        console.log(`${cls}.process caller shape: OK (${expectedCaller})`);
      }
    } else {
      // expect 0 callers, honest zero-caller note
      if (labels.length !== 0) {
        bug(`T4-6-${cls}-falsepositive`, `${cls}.process expected 0 callers (12-way collision non-edge demo), got ${JSON.stringify(labels)} -- FALSE EDGE from the ambiguous runDynamic() call site would land here.`);
      } else if (!tree.note) {
        bug(`T4-6-${cls}-nonote`, `${cls}.process has 0 children but tree.note is falsy -- expected an honest zero-caller note per README.`);
      } else {
        console.log(`${cls}.process: 0 callers, note="${tree.note}" -- OK`);
      }
    }
  }
  // Confirm the ambiguous runDynamic call site does NOT resolve to ANY of
  // the 12 -- already covered per-class above by requiring EXACT caller
  // sets; also sanity print index.stats.unresolvedSites to see it moved.
  console.log('index.stats.unresolvedSites (workspace-wide):', index.stats && index.stats.unresolvedSites);
}

// =======================================================================
// TARGETS 7/8/9 — naming traps (run on 3 near-duplicate classes)
// =======================================================================
console.log('\n\n########## TARGETS 7-9: naming traps (run) ##########');
{
  const cases = [
    { cls: 'vertexorderservice', method: 'run', label: 'VertexOrderService.run', expectedCaller: 'VertexOrderRunnerUtil.triggerCaseVariantRun' },
    { cls: 'vertexorderservices', method: 'run', label: 'VertexOrderServices.run', expectedCaller: 'VertexOrderRunnerUtil.triggerPluralRun' },
    { cls: 'vertex_order_service', method: 'run', label: 'Vertex_Order_Service.run', expectedCaller: 'VertexOrderRunnerUtil.triggerUnderscoreRun' },
  ];
  for (const c of cases) {
    const tree = resolver.buildCallerTree(index, { classLower: c.cls, methodLower: c.method }, {});
    const labels = directChildLabels(tree);
    if (labels.length !== 1 || labels[0] !== c.expectedCaller) {
      bug(`T7-9-${c.label}`, `${c.label} expected exactly 1 caller ${c.expectedCaller}, got ${JSON.stringify(labels)}`);
    } else {
      console.log(`${c.label} caller shape: OK (${c.expectedCaller}) -- no cross-pollution among the 3 near-duplicates.`);
    }
  }
}

// =======================================================================
// TARGET 10 — Billing.charge (local class) + zenq.Billing.charge trap
// =======================================================================
console.log('\n\n########## TARGET 10: Billing.charge (callers) ##########');
{
  const tree = printTree('T10 Billing.charge callers', resolver.buildCallerTree(index, { classLower: 'billing', methodLower: 'charge' }, {}));
  const node = tree.root.children[0];
  if (tree.root.children.length !== 1 || tree.root.children[0].label !== 'VertexLedgerBridge.postToLedger') {
    bug('T10-caller', `Expected exactly 1 caller node VertexLedgerBridge.postToLedger, got ${JSON.stringify(directChildLabels(tree))}`);
  } else if (node.sites.length !== 1) {
    bug('T10-sites', `Expected exactly 1 site row on VertexLedgerBridge.postToLedger (only C5:3, NOT C5:19 zenq.Billing.charge) -- got ${node.sites.length} site(s): ${JSON.stringify(node.sites.map((s) => s.line))}`);
  } else if (node.sites[0].line !== 3) {
    bug('T10-siteline', `Expected the single site at line 3, got line ${node.sites[0].line} -- may indicate zenq.Billing.charge (line 19) incorrectly collapsed onto local Billing.charge.`);
  } else {
    console.log('T10: OK -- exactly 1 caller, 1 site (line 3), zenq.Billing.charge (line 19) correctly absent (no false-positive namespace-prefix collapse).');
  }
}

// =======================================================================
// TARGET 11 — VertexLedgerBridge.postToLedger (CALLEE TREE B) + reverse
// caller-direction sanity (both directions for this "3 targets" set)
// =======================================================================
console.log('\n\n########## TARGET 11: VertexLedgerBridge.postToLedger (callees) ##########');
{
  const tree = printTree('T11 VertexLedgerBridge.postToLedger callees', resolver.buildCalleeTree(index, { classLower: 'vertexledgerbridge', methodLower: 'posttoledger' }, {}));
  const labels = directChildLabels(tree);
  console.log('Callee direct children:', JSON.stringify(labels));
  if (!labels.some((l) => l.startsWith('Billing.charge'))) {
    bug('T11-billing-missing', `Expected an edge to Billing.charge (via=static), got children ${JSON.stringify(labels)}`);
  } else {
    console.log('Billing.charge edge present: OK');
  }
  // v0.8-A1 (C5:6): kwx__LedgerService.postEntry is a 2-segment call --
  // per N2's explicit carve-out this NEVER promotes to an external node
  // (indistinguishable from an ordinary unresolved local reference), and it
  // must still never resolve to any local class either. [MUST] no-change.
  if (labels.some((l) => /kwx__LedgerService/i.test(l))) {
    bug('T11-kwx-phantom', `kwx__LedgerService.postEntry should NOT resolve to any local class (never declared) -- found phantom node: ${JSON.stringify(labels)}`);
  } else {
    console.log('kwx__LedgerService.postEntry correctly absent as a local node (no phantom edge to a nonexistent class): OK');
  }
  if (labels.some((l) => l === 'kwx.KappaGateway' || /externalservice/i.test(l))) {
    // sanity only, no assertion -- kwx__LedgerService is unrelated to any
    // kwx.* EXTERNAL node either (2-segment carve-out means it never joins
    // the externals map at all -- checked directly below).
  }
  if (index.externals instanceof Map && index.externals.has('kwx.ledgerservice')) {
    bug('T11-kwx-external-phantom', 'v0.8-A1/N2: kwx__LedgerService.postEntry (2-segment) must NEVER create an external node -- found one anyway.');
  } else {
    console.log('kwx__LedgerService.postEntry correctly absent from index.externals too (N2 2-segment carve-out): OK');
  }
  // zenq.Billing.charge must NOT collapse onto local Billing.charge -- i.e.
  // exactly ONE local Billing.charge-labeled callee child, with exactly 1
  // site (unchanged from v0.7.1).
  const billingChildren = (tree.root.children || []).filter((c) => c.label && c.label.startsWith('Billing.charge') && c.kind !== 'external');
  if (billingChildren.length > 1) {
    bug('T11-billing-duplicate-node', `Expected exactly 1 local Billing.charge callee node, found ${billingChildren.length} -- possible zenq.Billing.charge/local Billing.charge conflation into separate nodes.`);
  } else if (billingChildren.length === 1 && billingChildren[0].sites && billingChildren[0].sites.length > 1) {
    bug('T11-billing-multisite', `Billing.charge callee node has ${billingChildren[0].sites.length} site rows -- expected exactly 1 (C5:3 only); zenq.Billing.charge (C5:19) must not collapse onto this node. Sites: ${JSON.stringify(billingChildren[0].sites.map((s) => s.line))}`);
  } else if (billingChildren.length === 1) {
    console.log('Billing.charge callee node: exactly 1 site, no zenq.Billing.charge collapse -- OK');
  }
  // v0.8-A1 [MUST] per N2 step 3: C5:19 zenq.Billing.charge(...) is now a
  // PROMOTED external node -- a NEW sibling callee child, kind='external',
  // label='zenq.Billing', method 'charge', via='external', NOT approximate,
  // and it must still never collapse onto the local Billing.charge node
  // checked above (already enforced by that check's own kind!=='external'
  // filter).
  const zenqBillingChild = (tree.root.children || []).find((c) => c.kind === 'external' && c.label === 'zenq.Billing');
  if (!zenqBillingChild) {
    bug('T11-zenqbilling-external-missing', `v0.8-A1 [MUST] per N2 step 3: expected a NEW external callee node 'zenq.Billing' (C5:19), got children ${JSON.stringify(labels)}`);
  } else {
    if (zenqBillingChild.via !== 'external') bug('T11-zenqbilling-via', `zenq.Billing external node via=${zenqBillingChild.via}, expected 'external'`);
    if (zenqBillingChild.approximate !== false) bug('T11-zenqbilling-approx', `zenq.Billing external node approximate=${zenqBillingChild.approximate}, expected false (a namespace-precedence resolution is confident, not a guess)`);
    if (!zenqBillingChild.sites || zenqBillingChild.sites.length !== 1 || zenqBillingChild.sites[0].line !== 19) {
      bug('T11-zenqbilling-site', `zenq.Billing external node expected exactly 1 site at line 19, got ${JSON.stringify(zenqBillingChild.sites && zenqBillingChild.sites.map((s) => s.line))}`);
    } else {
      console.log('v0.8-A1: zenq.Billing EXTERNAL callee node present, via=external, not approximate, 1 site at C5:19 -- OK [MUST]');
    }
  }
  // v0.8-A1 [MUST] per N1(b): C5:13 insert new kwx__Ledger__c(...) is now a
  // PROMOTED external OBJECT node -- kind='external', ns='kwx'.
  const kwxLedgerChild = (tree.root.children || []).find((c) => c.kind === 'external' && /kwx__Ledger__c/i.test(c.label || ''));
  if (!kwxLedgerChild) {
    bug('T11-kwxledger-external-missing', `v0.8-A1 [MUST] per N1(b): expected a NEW external object node 'kwx__Ledger__c' (C5:13), got children ${JSON.stringify(labels)}`);
  } else if (kwxLedgerChild.ns !== 'kwx') {
    bug('T11-kwxledger-ns', `kwx__Ledger__c external node ns=${JSON.stringify(kwxLedgerChild.ns)}, expected 'kwx'`);
  } else {
    console.log('v0.8-A1: kwx__Ledger__c EXTERNAL object callee node present, ns=kwx -- OK [MUST]');
  }
  // DML->trigger fan-out for insert kwx__Ledger__c: trigger fan-out STAYS
  // ZERO -- no local trigger is declared on kwx__Ledger__c anywhere in this
  // corpus (that pairing is reserved for the DIFFERENT object
  // kwx__Invoice__c in v0.8-B2 -- see this row's own GROUND-TRUTH.md note).
  // This invariant from v0.7.1 §4 row 6 is preserved byte-for-byte.
  const anyTriggerNode = (tree.root.children || []).some((c) => c.kind === 'trigger');
  if (anyTriggerNode) {
    bug('T11-phantom-trigger', 'Unexpected trigger fan-out node present under VertexLedgerBridge.postToLedger callees -- no trigger exists on kwx__Ledger__c in this corpus (that pairing is reserved for kwx__Invoice__c, v0.8-B2).');
  } else {
    console.log('DML->trigger fan-out for kwx__Ledger__c insert: correctly zero trigger targets (v0.8-A1, byte-identical to v0.7.1) -- OK');
  }
  console.log('Full unresolved workspace count at this point:', tree.stats.unresolvedSites, 'externalRefs:', tree.stats.externalRefs, 'externalNamespaces:', JSON.stringify(tree.stats.externalNamespaces));
}
console.log('\n--- TARGET 11 reverse direction (both-directions sanity): VertexLedgerBridge.postToLedger (callers) ---');
{
  const tree = printTree('T11-rev VertexLedgerBridge.postToLedger callers', resolver.buildCallerTree(index, { classLower: 'vertexledgerbridge', methodLower: 'posttoledger' }, {}));
  console.log('(no ground-truth caller expectation stated for this method; recorded for completeness/orientation check)');
}

// =======================================================================
// TARGET 12 — VertexPricingServiceImpl.priceItems (callers)
// =======================================================================
console.log('\n\n########## TARGET 12: VertexPricingServiceImpl.priceItems (callers) ##########');
{
  const tree = printTree('T12 VertexPricingServiceImpl.priceItems callers', resolver.buildCallerTree(index, { classLower: 'vertexpricingserviceimpl', methodLower: 'priceitems' }, {}));
  const labels = directChildLabels(tree);
  if (labels.length !== 1 || labels[0] !== 'VertexApplicationConsumer.priceViaFactory') {
    bug('T12-caller', `Expected exactly 1 caller VertexApplicationConsumer.priceViaFactory (via=interface,~), got ${JSON.stringify(labels)}`);
  } else {
    const n = tree.root.children[0];
    if (!n.via || !/interface/i.test(n.via)) bug('T12-via', `Expected via=interface(~), got via=${n.via}`);
    else console.log('T12: OK -- via=interface(~)');
  }
  // 2-hop ancestor check: same method also calls VertexApplication.newInstance
  function findNodeByLabel(node, label) {
    if (node.label === label) return node;
    for (const c of node.children || []) {
      const f = findNodeByLabel(c, label);
      if (f) return f;
    }
    return null;
  }
}

// =======================================================================
// TARGET 13 — VertexGenericTriggerDispatcher.dispatch (CALLEE TREE C)
// =======================================================================
console.log('\n\n########## TARGET 13: VertexGenericTriggerDispatcher.dispatch (callees) ##########');
{
  const tree = printTree('T13 VertexGenericTriggerDispatcher.dispatch callees', resolver.buildCalleeTree(index, { classLower: 'vertexgenerictriggerdispatcher', methodLower: 'dispatch' }, {}));
  const labels = directChildLabels(tree);
  console.log('Callee direct children:', JSON.stringify(labels));
  if (labels.some((l) => /VertexAlertTriggerHandler\.<init>|VertexAlertTriggerHandler\.\(constructor\)/i.test(l))) {
    bug('T13-phantom-ctor', `Unexpected constructor edge to VertexAlertTriggerHandler.<init> from dynamic Map<Type,Type>.newInstance() -- should be no edge (IDEAL, dynamic Type value not a literal forName).`);
  } else {
    console.log('No phantom constructor edge for handlerType.newInstance(): OK');
  }
  if (!labels.some((l) => l.startsWith('VertexAlertTriggerHandler.run'))) {
    bug('T13-run-missing', `Expected edge to VertexAlertTriggerHandler.run (via=interface,~), got children ${JSON.stringify(labels)}`);
  } else {
    const n = (tree.root.children || []).find((c) => c.label.startsWith('VertexAlertTriggerHandler.run'));
    if (!n.via || !/interface/i.test(n.via)) bug('T13-run-via', `Expected via=interface(~) on VertexAlertTriggerHandler.run edge, got via=${n.via}`);
    else console.log('VertexAlertTriggerHandler.run edge via=interface(~): OK');
  }
}
console.log('\n--- TARGET 13 reverse direction (both-directions sanity): dispatch (callers) ---');
{
  printTree('T13-rev VertexGenericTriggerDispatcher.dispatch callers', resolver.buildCallerTree(index, { classLower: 'vertexgenerictriggerdispatcher', methodLower: 'dispatch' }, {}));
}

// =======================================================================
// TARGET 14 — VertexAlertTriggerHandler.run (callers)
// =======================================================================
console.log('\n\n########## TARGET 14: VertexAlertTriggerHandler.run (callers) ##########');
{
  const tree = printTree('T14 VertexAlertTriggerHandler.run callers', resolver.buildCallerTree(index, { classLower: 'vertexalerttriggerhandler', methodLower: 'run' }, {}));
  const labels = directChildLabels(tree);
  if (labels.length !== 1 || labels[0] !== 'VertexGenericTriggerDispatcher.dispatch') {
    bug('T14-caller', `Expected exactly 1 caller VertexGenericTriggerDispatcher.dispatch (via=interface,~), got ${JSON.stringify(labels)}`);
  } else {
    console.log('T14: OK');
  }
}

// =======================================================================
// TARGET 15 — VertexOrderProcessor.Batch.Row (class + .process) + outer
// static callback
// =======================================================================
console.log('\n\n########## TARGET 15: VertexOrderProcessor.Batch.Row (inner-inner) ##########');
{
  // class-level target for the constructor
  const treeCtor = printTree('T15a VertexOrderProcessor.Batch.Row (class, ctor callers)', resolver.buildCallerTree(index, { classLower: 'vertexorderprocessor.batch.row', methodLower: null }, {}));
  console.log('ctor tree children:', JSON.stringify(directChildLabels(treeCtor)));
  const treeProcess = printTree('T15b VertexOrderProcessor.Batch.Row.process (callers)', resolver.buildCallerTree(index, { classLower: 'vertexorderprocessor.batch.row', methodLower: 'process' }, {}));
  const processLabels = directChildLabels(treeProcess);
  if (processLabels.length !== 1 || processLabels[0] !== 'VertexNestedConsumer.run') {
    bug('T15-process-caller', `Expected exactly 1 caller VertexNestedConsumer.run for Row.process, got ${JSON.stringify(processLabels)}`);
  } else {
    console.log('T15b: OK Row.process caller = VertexNestedConsumer.run');
  }
  const ctorLabels = directChildLabels(treeCtor);
  const hasCtorCaller = ctorLabels.some((l) => l.includes('VertexNestedConsumer'));
  if (treeCtor.note && treeCtor.note.includes('not found')) {
    note('T15-ctor-target-notfound', `Class-level target for VertexOrderProcessor.Batch.Row not found using dotted classLower "vertexorderprocessor.batch.row" -- may need a different inner-class key format. Recording as NOTE, not BUG, pending confirmation of the correct classLower convention for nested inner classes; children: ${JSON.stringify(ctorLabels)}`);
  } else if (!hasCtorCaller) {
    bug('T15-ctor-caller-missing', `Expected VertexNestedConsumer.run as a <init> caller of VertexOrderProcessor.Batch.Row, got ${JSON.stringify(ctorLabels)}`);
  } else {
    console.log('T15a: OK ctor caller = VertexNestedConsumer.run');
  }
  // outer static callback: VertexOrderProcessor.staticHelper <- Row.process
  const treeHelper = printTree('T15c VertexOrderProcessor.staticHelper (callers)', resolver.buildCallerTree(index, { classLower: 'vertexorderprocessor', methodLower: 'statichelper' }, {}));
  const helperLabels = directChildLabels(treeHelper);
  if (!helperLabels.some((l) => l.includes('.process') && l.toLowerCase().includes('row'))) {
    bug('T15-helper-caller', `Expected VertexOrderProcessor.Batch.Row.process as caller of staticHelper (inner-inner-to-outer static callback), got ${JSON.stringify(helperLabels)}`);
  } else {
    console.log('T15c: OK inner-inner-to-outer static callback resolved.');
  }
}

// =======================================================================
// TARGET 16 — VertexInvoiceLine.Amount (method vs property)
// =======================================================================
console.log('\n\n########## TARGET 16: VertexInvoiceLine.Amount (method) callers ##########');
{
  const invoiceLineFacts = factsList.find((f) => /VertexInvoiceLine\.cls$/.test(f.path));
  console.log('VertexInvoiceLine.cls parseError:', invoiceLineFacts ? invoiceLineFacts.parseError : 'FILE NOT FOUND IN FACTSLIST');
  const tree = printTree('T16 VertexInvoiceLine.Amount callers', resolver.buildCallerTree(index, { classLower: 'vertexinvoiceline', methodLower: 'amount' }, {}));
  const labels = directChildLabels(tree);
  if (labels.length !== 1 || labels[0] !== 'VertexInvoiceLineConsumer.run') {
    bug('T16-caller', `Expected exactly 1 caller VertexInvoiceLineConsumer.run (the parenthesized method call, line 6), got ${JSON.stringify(labels)}`);
  } else {
    const n = tree.root.children[0];
    if (n.sites.length !== 1) bug('T16-sites', `Expected exactly 1 site row (line 6 method call only, NOT lines 4/5 property access), got ${n.sites.length}: ${JSON.stringify(n.sites.map((s) => s.line))}`);
    else if (n.sites[0].line !== 6) bug('T16-siteline', `Expected the resolved call at line 6, got line ${n.sites[0].line} -- possible property-access miscounted as a call.`);
    else console.log('T16: OK -- exactly 1 site at line 6, property read/write (lines 4-5) correctly produce zero CallFacts.');
  }
}

// =======================================================================
// TARGET 17 — VertexDiscountCalculator.calculate (2 overloads)
// =======================================================================
console.log('\n\n########## TARGET 17: VertexDiscountCalculator.calculate (overloads) ##########');
{
  const tree = printTree('T17 VertexDiscountCalculator.calculate callers (method-level, both overloads share methodLower)', resolver.buildCallerTree(index, { classLower: 'vertexdiscountcalculator', methodLower: 'calculate' }, {}));
  const n = tree.root.children.length === 1 ? tree.root.children[0] : null;
  console.log('children:', JSON.stringify(directChildLabels(tree)));
  if (!n) {
    bug('T17-node-shape', `Expected exactly 1 caller node VertexDiscountConsumer.run (grouping both overload calls), got ${JSON.stringify(directChildLabels(tree))}`);
  } else if (!n.sites || n.sites.length !== 2) {
    bug('T17-sites-count', `Expected 2 site rows (one per overload) under VertexDiscountConsumer.run, got ${n.sites ? n.sites.length : 'undefined'}`);
  } else {
    const vias = n.sites.map((s) => s.via);
    const overloadSigs = n.sites.map((s) => s.overloadSig || null);
    console.log('site vias:', JSON.stringify(vias), 'overloadSigs:', JSON.stringify(overloadSigs));
    if (!vias.includes('static') || !vias.includes('typed')) {
      bug('T17-vias', `Expected one site via=static (arity 1) and one via=typed (arity 2), got ${JSON.stringify(vias)}`);
    } else {
      console.log('T17: OK -- 2 sites, arity-matched overloads stay split (static/typed), not collapsed into one undifferentiated edge.');
    }
  }
}

// =======================================================================
// TARGET 18 — VertexRepriceBatch (class-level, CALLEE TREE A)
// =======================================================================
console.log('\n\n########## TARGET 18: VertexRepriceBatch (class-level, callees) ##########');
{
  const tree = printTree('T18 VertexRepriceBatch callees (class-level)', resolver.buildCalleeTree(index, { classLower: 'vertexrepricebatch', methodLower: null }, {}));
  // class-level callee tree: expect children grouped per-method (start,
  // execute, finish) or a flattened list -- inspect structure directly.
  console.log('Class-level callee root children:', JSON.stringify(directChildLabels(tree)));
}
console.log('\n--- T18b: VertexRepriceBatch.execute (method-level callees) ---');
{
  const tree = printTree('T18b VertexRepriceBatch.execute callees', resolver.buildCalleeTree(index, { classLower: 'vertexrepricebatch', methodLower: 'execute' }, {}));
  const labels = directChildLabels(tree);
  if (!labels.some((l) => l.startsWith('VertexPricingService.reprice'))) {
    bug('T18-execute-callee', `Expected callee edge to VertexPricingService.reprice (via=typed), got ${JSON.stringify(labels)}`);
  } else {
    console.log('T18b execute callee: OK');
  }
}
console.log('\n--- T18c: VertexRepriceBatch.finish (method-level callees) ---');
{
  const tree = printTree('T18c VertexRepriceBatch.finish callees', resolver.buildCalleeTree(index, { classLower: 'vertexrepricebatch', methodLower: 'finish' }, {}));
  const labels = directChildLabels(tree);
  if (!labels.some((l) => l.startsWith('VertexFollowupBatch.execute'))) {
    bug('T18-finish-callee', `Expected async callee edge to VertexFollowupBatch.execute (via=async), got ${JSON.stringify(labels)}`);
  } else {
    const n = (tree.root.children || []).find((c) => c.label.startsWith('VertexFollowupBatch.execute'));
    if (!n.via || n.via !== 'async') bug('T18-finish-via', `Expected via=async on VertexFollowupBatch.execute edge, got via=${n.via}`);
    else console.log('T18c finish callee: OK, via=async.');
  }
}
console.log('\n--- T18d: VertexRepriceBatch.start (method-level callees, SOQL-only, expect 0 Apex callees) ---');
{
  const tree = printTree('T18d VertexRepriceBatch.start callees', resolver.buildCalleeTree(index, { classLower: 'vertexrepricebatch', methodLower: 'start' }, {}));
  const labels = directChildLabels(tree);
  if (labels.length !== 0) {
    note('T18-start-unexpected-callee', `Expected 0 Apex callees for start() (SOQL query only), got ${JSON.stringify(labels)}`);
  } else {
    console.log('T18d: OK, 0 callees for start() (SOQL only).');
  }
}
console.log('\n--- T18 reverse direction (both-directions sanity): VertexRepriceBatch.execute (callers) ---');
{
  const tree = printTree('T18-rev VertexRepriceBatch.execute callers', resolver.buildCallerTree(index, { classLower: 'vertexrepricebatch', methodLower: 'execute' }, {}));
  const labels = directChildLabels(tree);
  console.log('(execute has no known Apex caller within corpus other than async-scheduled batch execution -- recording for completeness)', JSON.stringify(labels));
}

// =======================================================================
// TARGET 19 — VertexDataBridge.sync via VertexSyncable / VertexReadable
// =======================================================================
console.log('\n\n########## TARGET 19: VertexDataBridge.sync (callers) — transitive interface (adjudicated 2026-07-17) ##########');
{
  const tree = printTree('T19 VertexDataBridge.sync callers', resolver.buildCallerTree(index, { classLower: 'vertexdatabridge', methodLower: 'sync' }, {}));
  const labels = directChildLabels(tree);
  console.log('children:', JSON.stringify(labels));
  const hasSyncable = labels.includes('VertexSyncConsumer.runViaSyncable');
  const hasReadable = labels.includes('VertexSyncConsumer.runViaReadable');
  if (!hasSyncable) {
    bug('T19-direct-missing', `Expected VertexSyncConsumer.runViaSyncable (direct implements) as a confident [MUST] caller, got ${JSON.stringify(labels)}`);
  } else {
    console.log('Direct-implements leg (runViaSyncable): present, OK [MUST]');
  }
  // ROUND C ADJUDICATION (2026-07-17), T19-transitive-present: the edge's
  // presence is NOT an accident to keep recording -- it is the engine's own
  // documented behavior. resolver.js's G6 pass ("interface-extends-
  // interface transitive closure", in buildSemanticIndex, shipped v0.5)
  // states verbatim that an implementer of a child interface "must be
  // reachable from a variable typed to any of those ancestor interfaces
  // too" and additively registers every implementer under every ancestor
  // interface across ALL parent branches (extendsTypes, not just the first
  // parent). The implementer index is therefore built off the full
  // interface lattice, not just direct `implements` declarations. Isolated
  // repro (incl. multi-parent leg + up-only closure-direction control):
  // dev/gauntlet/repro-roundc-t19-iface-extends.js. Promoted from the old
  // present/absent NOTE pair to a hard [MUST -- adjudicated 2026-07-17]
  // assertion: absence (or a non-interface/non-approximate edge shape)
  // is a BUG, never a NOTE.
  if (!hasReadable) {
    bug('T19-transitive-missing', `[MUST -- adjudicated 2026-07-17] VertexSyncConsumer.runViaReadable (transitive via VertexSyncable extends VertexReadable, VertexWritable) is ABSENT -- G6 interface-extends closure regressed; got ${JSON.stringify(labels)}`);
  } else {
    const readableNode = (tree.root.children || []).find((c) => c.label === 'VertexSyncConsumer.runViaReadable');
    if (!readableNode || readableNode.via !== 'interface' || readableNode.approximate !== true) {
      bug('T19-transitive-shape', `[MUST -- adjudicated 2026-07-17] runViaReadable edge present but wrong shape: via=${readableNode && readableNode.via}, approximate=${readableNode && readableNode.approximate} (expected via=interface, approximate ~, same edge class as the direct leg).`);
    } else {
      console.log('Transitive-implements leg (runViaReadable): present, via=interface ~, OK [MUST -- adjudicated 2026-07-17: G6 interface-extends closure, implementer index built off the full interface lattice]');
    }
  }
}

// =======================================================================
// TARGET 20 — VertexStatusRouter.route (multi-site) + all 19 switch
// branches as callees
// =======================================================================
console.log('\n\n########## TARGET 20: VertexStatusRouter.route (callers, multi-site) ##########');
{
  const tree = printTree('T20 VertexStatusRouter.route callers', resolver.buildCallerTree(index, { classLower: 'vertexstatusrouter', methodLower: 'route' }, {}));
  const labels = directChildLabels(tree);
  if (labels.length !== 1 || labels[0] !== 'VertexStatusRouterConsumer.run') {
    bug('T20-caller', `Expected exactly 1 caller node VertexStatusRouterConsumer.run, got ${JSON.stringify(labels)}`);
  } else {
    const n = tree.root.children[0];
    if (!n.sites || n.sites.length !== 2) bug('T20-sites', `Expected 2 site rows under 1 node (bonus multi-site demo), got ${n.sites ? n.sites.length : 'undefined'}`);
    else console.log('T20: OK -- 2 sites, 1 node.');
  }
}
console.log('\n--- T20b: VertexStatusRouter.route (callees) -- all 19 switch branches ---');
{
  const tree = printTree('T20b VertexStatusRouter.route callees', resolver.buildCalleeTree(index, { classLower: 'vertexstatusrouter', methodLower: 'route' }, {}));
  const labels = directChildLabels(tree);
  console.log('callee count:', labels.length, 'expected 19');
  const expectedHandlers = [
    'handleNew', 'handleValidated', 'handleEnriched', 'handleRouted', 'handlePriced',
    'handleApproved', 'handleRejected', 'handleOnHold', 'handleBackordered',
    'handlePartiallyShipped', 'handleShipped', 'handleInvoiced', 'handlePaid',
    'handleDisputed', 'handleRefunded', 'handleCancelled', 'handleArchived',
    'handleEscalated', 'handleUnknown',
  ];
  const gotHandlers = labels.map((l) => l.split('.').pop());
  const missing = expectedHandlers.filter((h) => !gotHandlers.includes(h));
  const extra = gotHandlers.filter((h) => !expectedHandlers.includes(h));
  if (missing.length || labels.length !== 19) {
    bug('T20-switch-branches', `Expected all 19 switch-branch callees, got ${labels.length}: missing=${JSON.stringify(missing)} extra=${JSON.stringify(extra)} full=${JSON.stringify(labels)}`);
  } else {
    console.log('T20b: OK -- all 19 switch branches independently extracted as callees, none silently dropped.');
  }
}

// =======================================================================
// v0.8 NAMESPACE MODELING -- GROUND-TRUTH.md "v0.8 ground-truth: namespace
// modeling" section (v0.8-A promoted probes + v0.8-B new fixtures).
// =======================================================================
console.log('\n\n########## v0.8-A2: KappaGatewayCaller (namespace probes 1-4) ##########');
{
  const ext = (k) => (index.externals instanceof Map ? index.externals.get(k) : null);
  const zk = ext('zenq.kappagateway');
  const kk = ext('kwx.kappagateway');
  const typo = ext('zenq.kappagatewey');
  if (!zk) bug('A2-zenq-missing', "Expected external node 'zenq.kappagateway' (L3 + L9 case-varied)");
  else if (zk.refCount < 2) bug('A2-zenq-refcount', `zenq.kappagateway refCount=${zk.refCount}, expected >= 2 (L3 + L9)`);
  else console.log('A2 L3/L9: zenq.kappagateway external present, refCount>=2 (case-insensitive fold) -- OK [MUST]');
  if (!kk) bug('A2-kwx-missing', "Expected DISTINCT external node 'kwx.kappagateway' (L16, different namespace)");
  else console.log('A2 L16: kwx.kappagateway external present, distinct from zenq.kappagateway -- OK [MUST] per N1(a)');
  if (!typo) bug('A2-typo-missing', "Expected DISTINCT external node 'zenq.kappagatewey' (L21, 1-letter typo, must not fuzzy-match)");
  else console.log('A2 L21: zenq.kappagatewey external present as its OWN distinct node -- OK [MUST] per N2 step 3');
  const localTree = resolver.buildCallerTree(index, { classLower: 'kappagateway', methodLower: 'dispatch' }, {});
  const localLabels = collectAllNodeLabelsFlat(localTree);
  if (localLabels.some((l) => /kappagatewey|kwx\./i.test(l))) {
    bug('A2-local-pollution', `Local KappaGateway.dispatch caller tree polluted by a namespaced site: ${JSON.stringify(localLabels)}`);
  } else {
    console.log('None of the 4 namespace-probe sites attach to local KappaGateway.dispatch -- OK [MUST]');
  }
}

console.log('\n\n########## v0.8-A3/A4: BoltRelayCaller / BeaconCaller ##########');
{
  const ext = (k) => (index.externals instanceof Map ? index.externals.get(k) : null);
  if (!ext('zenq.relay')) bug('A3-relay-missing', "Expected external node 'zenq.relay' (BoltRelayCaller.trigger, would-be false target = inner class BoltContainer.Relay)");
  else console.log('A3: zenq.relay external present, no false landing on BoltContainer.Relay -- OK [MUST] per N2 step 3');
  if (!ext('zenq.beacon')) bug('A4-beacon-missing', "Expected external node 'zenq.beacon' (BeaconCaller.ping, would-be false targets = 2 ambiguous inner Beacon classes)");
  else console.log('A4: zenq.beacon external present (confident external resolution, not a declined ambiguity) -- OK [MUST] per N2 step 3');
}

console.log('\n\n########## v0.8-A5/B5: cross-surface consistency (Apex + LWC + Flow + CMDT) ##########');
{
  const ext = (k) => (index.externals instanceof Map ? index.externals.get(k) : null);
  const zk = ext('zenq.kappagateway');
  // Apex (L3+L9, refCount 2) + LWC import + Flow actionName = 4 distinct
  // referencing sites all landing on the SAME external node.
  if (!zk) bug('A5-zenq-missing', 'zenq.kappagateway external node missing entirely -- cannot check cross-surface consistency.');
  else if (zk.refCount !== 4) bug('A5-refcount', `v0.8-A5/B5 [MUST]: zenq.kappagateway refCount=${zk.refCount}, expected exactly 4 (Apex L3 + Apex L9 + LWC import + Flow actionName)`);
  else console.log('v0.8-A5/B5: zenq.kappagateway refCount=4 -- Apex + LWC + Flow all land on ONE shared external node -- OK [MUST] per N1(c)');
  const kwxPle = ext('kwx.postledgerentry');
  if (!kwxPle) bug('B5-kwxple-missing', "v0.8-B5 [MUST]: expected external node 'kwx.postledgerentry' (Flow bare actionName 'kwx__PostLedgerEntry' + CMDT value 'kwx__PostLedgerEntry')");
  else if (kwxPle.refCount !== 2) bug('B5-kwxple-refcount', `v0.8-B5 [MUST]: kwx.postledgerentry refCount=${kwxPle.refCount}, expected exactly 2 (Flow + CMDT)`);
  else console.log('v0.8-B5: kwx.postledgerentry refCount=2 -- Flow + CMDT both land on ONE shared external node -- OK [MUST] per N1(c)');
  // The pre-existing LOCAL CMDT record (Order_Handler -> KappaOrderTriggerHandler,
  // a real local class) must be completely unaffected by adding a second record.
  const localHandlerTree = resolver.buildCallerTree(index, { classLower: 'kappaordertriggerhandler', methodLower: null }, {});
  console.log('Sanity: KappaOrderTriggerHandler (pre-existing local CMDT-driven class) still resolves --', localHandlerTree.note || 'has callers/children as before');
}

console.log('\n\n########## v0.8-B1: own-namespace resolves LOCALLY (VtxOwnNamespaceProbe) ##########');
{
  const tree = resolver.buildCallerTree(index, { classLower: 'vertexpricingservice', methodLower: 'repriceorder' }, {});
  const labels = directChildLabels(tree);
  if (!labels.includes('VtxOwnNamespaceProbe.callOwnNamespaceClass')) {
    bug('B1-ownns-local-missing', `v0.8-B1 [MUST] per N3: expected vtx.VertexPricingService.repriceOrder(order) (own-namespace, stripped) to resolve LOCALLY as a caller of VertexPricingService.repriceOrder, got ${JSON.stringify(labels)}`);
  } else {
    console.log('B1 L3: vtx.VertexPricingService.repriceOrder resolves LOCALLY (own-namespace stripped) -- OK [MUST] per N3');
  }
  if (index.externals instanceof Map && Array.from(index.externals.keys()).some((k) => k.startsWith('vtx.'))) {
    bug('B1-vtx-external-leak', "v0.8-B1 [MUST] per N3: no external node may ever have ns='vtx' (the workspace's OWN namespace) -- found one.");
  } else {
    console.log("B1: no external node with ns='vtx' anywhere in the index -- OK [MUST] per N3");
  }
  if (Array.isArray(index.stats.externalNamespaces) && index.stats.externalNamespaces.includes('vtx')) {
    bug('B1-vtx-in-stats', "v0.8-B1 [MUST]: index.stats.externalNamespaces must never include the workspace's own namespace ('vtx') -- found it.");
  } else {
    console.log("B1: index.stats.externalNamespaces does not include 'vtx' -- OK [MUST]");
  }
  // L7/L11: bare Config__c and own-ns-prefixed vtx__Config__c DML must
  // resolve to the SAME local object identity, zero external node.
  if (index.externals instanceof Map && Array.from(index.externals.keys()).some((k) => /config__c/i.test(k))) {
    bug('B1-config-external', 'v0.8-B1 [MUST] per N3: vtx__Config__c must strip to the local Config__c object, never an external node.');
  } else {
    console.log('B1 L7/L11: Config__c / vtx__Config__c -- no external node created -- OK [MUST] per N3');
  }
}

console.log('\n\n########## v0.8-B2: local trigger on namespaced object (kwx__Invoice__c) ##########');
{
  const ext = (k) => (index.externals instanceof Map ? index.externals.get(k) : null);
  const invoiceExt = ext('kwx.invoice__c') || Array.from(index.externals instanceof Map ? index.externals.values() : []).find((v) => /kwx__Invoice__c/i.test(v.label || ''));
  if (!invoiceExt) {
    bug('B2-invoice-external-missing', "v0.8-B2 [MUST] per N1(b): expected an external object node for 'kwx__Invoice__c' (VtxKwxInvoiceService.postInvoice L3 insert)");
  } else {
    console.log('B2: kwx__Invoice__c EXTERNAL object node present -- OK [MUST] per N1(b)');
  }
  const calleeTree = resolver.buildCalleeTree(index, { classLower: 'vtxkwxinvoiceservice', methodLower: 'postinvoice' }, {});
  const calleeLabels = directChildLabels(calleeTree);
  const hasTriggerFanout = (calleeTree.root.children || []).some((c) => c.kind === 'trigger' && /VtxKwxInvoiceTrigger/i.test(c.label || ''));
  if (!hasTriggerFanout) {
    bug('B2-trigger-fanout-missing', `v0.8-B2 [MUST] per N4: DML on kwx__Invoice__c must fan out to VtxKwxInvoiceTrigger exactly like a local object -- got children ${JSON.stringify(calleeLabels)}`);
  } else {
    console.log('B2: DML on kwx__Invoice__c fans out to VtxKwxInvoiceTrigger (before insert) exactly like a local object -- OK [MUST] per N4');
  }
}

console.log('\n\n########## v0.8-B3: precedence traps (zenq local class vs. namespace token) ##########');
{
  const ext = (k) => (index.externals instanceof Map ? index.externals.get(k) : null);
  const ledgerTree = resolver.buildCallerTree(index, { classLower: 'zenq.ledger', methodLower: 'post' }, {});
  const ledgerLabels = directChildLabels(ledgerTree);
  if (!ledgerLabels.includes('ZenqLocalPrecedenceCaller.callWithLocalMember')) {
    bug('B3-localmember-missing', `v0.8-B3 [MUST] per N2 step 2: zenq.Ledger.post(amount) (Head='zenq' resolves to the GENUINE local class, Mid='Ledger' resolves as its real inner class) must edge to local zenq.Ledger.post -- got ${JSON.stringify(ledgerLabels)}`);
  } else {
    console.log('B3 L3: zenq.Ledger.post(amount) resolves LOCALLY (local-class-chain wins) -- OK [MUST] per N2 step 2');
  }
  if (ext('zenq.ledger')) {
    bug('B3-ledger-external-phantom', "v0.8-B3 [MUST]: 'zenq.Ledger' must NEVER become an external node -- Head='zenq' resolves to the genuine local class.");
  } else {
    console.log('B3: no external node for zenq.Ledger (local-class-chain precedence honored) -- OK [MUST]');
  }
  if (!ext('zenq.signal')) {
    bug('B3-signal-missing', "v0.8-B3 [MUST] per N2 step 3: zenq.Signal.emit(cmd) (Head='zenq' resolves to the local class, but Mid='Signal' does NOT resolve on it) must fall through to an external node -- missing.");
  } else {
    console.log('B3 L11: zenq.Signal.emit(cmd) -- Head resolves but Mid does not -> falls through to EXTERNAL (no false local edge) -- OK [MUST] per N2 step 3');
  }
  if (ext('unknownpkg.doThing') || (index.externals instanceof Map && Array.from(index.externals.keys()).some((k) => /unknownpkg/i.test(k)))) {
    bug('B3-2seg-external-phantom', "v0.8-B3 [MUST] per N2 2-segment carve-out: UnknownPkg.doThing() (2-segment) must NEVER become an external node.");
  } else {
    console.log('B3: TwoSegmentUnknownCaller -- UnknownPkg.doThing() stays unresolved, no external node (2-segment carve-out) -- OK [MUST] per N2');
  }
}

console.log('\n\n########## v0.8-B4: two namespaces, same class name, distinct external nodes ##########');
{
  const ext = (k) => (index.externals instanceof Map ? index.externals.get(k) : null);
  const zg = ext('zenq.gateway');
  const kg = ext('kwx.gateway');
  if (!zg) bug('B4-zenqgateway-missing', "v0.8-B4 [MUST] per N2 step 3: expected external node 'zenq.gateway' (NamespaceDistinctGatewayCaller.openBoth L3)");
  else console.log('B4 L3: zenq.gateway external present -- OK [MUST]');
  if (!kg) bug('B4-kwxgateway-missing', "v0.8-B4 [MUST] per N1(a): expected DISTINCT external node 'kwx.gateway' (L10, same class name, different namespace)");
  else console.log('B4 L10: kwx.gateway external present, distinct from zenq.gateway (identity = (namespace, class) pair) -- OK [MUST] per N1(a)');
}

// =======================================================================
// v0.10-A: fluent chain resolution (CHAIN_MAX=12 + per-chain cycle guard),
// per GROUND-TRUTH.md's "v0.10 ground-truth edges" section.
// =======================================================================
function callersOf(cls, method) {
  return resolver.buildCallerTree(index, { classLower: cls, methodLower: method }, {});
}
function callerLabelsOf(cls, method) {
  return directChildLabels(callersOf(cls, method));
}
// v0.11/B1+B2: forward-direction counterpart, same {}-opts convention --
// used by the v0.11 section below to inspect direct callee children
// (external ctor edges, narrowed DML/trigger edges, and the honest
// "DML on unresolved SObject type" marker's presence/absence).
function calleesOf(cls, method) {
  return resolver.buildCalleeTree(index, { classLower: cls, methodLower: method }, {});
}

console.log('\n\n########## v0.10-A1: VtxReportChainCaller (long chain ladder, S=5/8/12/13) ##########');
{
  // (The StageN.cls hop-verb off-by-one corpus defect this block used to
  // tolerate as NOTE-level was FIXED 2026-07-17 -- each StageN now declares
  // its own hop verb, matching VtxReportChainCaller.cls's call text and
  // GROUND-TRUTH.md's hop-verb table -- so the S=5/8/12 resolutions are
  // enforced as hard [MUST] checks below. The S=13 over-cap chain has its
  // own hard no-edge invariant further down.)
  const stageChecks = [
    { s: 5, method: 'runFiveSegmentChain' },
    { s: 8, method: 'runEightSegmentChain' },
    { s: 12, method: 'runTwelveSegmentChain' },
  ];
  for (const { s, method } of stageChecks) {
    const labels = callerLabelsOf('vtxreportquerystage' + s, 'build');
    const hit = labels.includes('VtxReportChainCaller.' + method);
    if (hit) {
      console.log(`A1: VtxReportChainCaller.${method} resolves to VtxReportQueryStage${s}.build, via=typed -- OK [MUST] per v0.10-A1-i`);
    } else {
      bug(
        `A1-ladder-S${s}-${method}`,
        `v0.10-A1 [MUST]: VtxReportChainCaller.${method} must resolve to VtxReportQueryStage${s}.build (via=typed) with CHAIN_MAX=12 -- got callers: ${labels.join(', ') || '(none)'}`
      );
    }
  }
  // Hard invariant regardless of the corpus defect above: exceeding
  // CHAIN_MAX (S=13, runThirteenSegmentChain's OWN traced .build() call)
  // must NEVER produce an edge to Stage12.build OR Stage13.build --
  // "exceeding the cap is itself a failure of this rule, not a truncate-
  // and-guess" (A1-ii's own framing). True today (confirmed): asserted as
  // a real BUG check since a false edge here would be a genuine resolver
  // defect, corpus quirk or not.
  const s13ToStage12 = callerLabelsOf('vtxreportquerystage12', 'build').includes('VtxReportChainCaller.runThirteenSegmentChain');
  const s13ToStage13 = callerLabelsOf('vtxreportquerystage13', 'build').includes('VtxReportChainCaller.runThirteenSegmentChain');
  if (s13ToStage12 || s13ToStage13) {
    bug('A1-s13-phantom-edge', `v0.10-A1 [MUST]: runThirteenSegmentChain's traced .build() call (S=13, one past CHAIN_MAX=12) must NEVER produce an edge to Stage12.build (truncate-and-guess) or Stage13.build (the "true" landing spot) -- got Stage12=${s13ToStage12} Stage13=${s13ToStage13}`);
  } else {
    console.log('A1: runThirteenSegmentChain (S=13, exceeds CHAIN_MAX) correctly produces NO edge to Stage12.build or Stage13.build -- OK [MUST] per A1-ii');
  }
}

console.log('\n\n########## v0.10-A1: VtxChainCycleCaller (return-type cycle, 6-.next()-deep) ##########');
{
  // Unaffected by the ladder's hop-verb defect above -- both cycle classes
  // uniformly declare `next()`, no verb-per-level assignment to get wrong.
  const nodeANext = callerLabelsOf('vtxchaincyclenodea', 'next');
  const nodeBNext = callerLabelsOf('vtxchaincyclenodeb', 'next');
  // S=0 (plain declared-type call) and S=2 (2-hop walk, lands back on A)
  // both resolve to VtxChainCycleNodeA.next; S=1 (1-hop walk, lands on B)
  // resolves to VtxChainCycleNodeB.next -- see A1-iii's own table.
  const aHits = nodeANext.filter((l) => l === 'VtxChainCycleCaller.runSixDeepCycle').length;
  const bHits = nodeBNext.filter((l) => l === 'VtxChainCycleCaller.runSixDeepCycle').length;
  if (aHits < 1 || bHits < 1) {
    bug('A1-cycle-shorthop-missing', `v0.10-A1 [MUST] per A1-iii: expected VtxChainCycleCaller.runSixDeepCycle to appear as a caller of BOTH VtxChainCycleNodeA.next (S=0 and S=2, i.e. present at least once -- resolver.js's own findAllLabels-style caller list does not distinguish multiple sites onto the same caller as separate entries here) and VtxChainCycleNodeB.next (S=1) -- got A.next hits=${aHits}, B.next hits=${bHits}`);
  } else {
    console.log(`A1: runSixDeepCycle's short (in-guard) hops resolve as expected -- A.next hits=${aHits}, B.next hits=${bHits} -- OK [MUST] per A1-iii`);
  }
  // S>=3 (the 3rd hop onward re-visits an already-walked (type,method)
  // pair) must degrade to NO edge, incl. the headline S=6 `.terminal()`
  // call -- checked by confirming terminal() has ZERO callers on EITHER
  // cycle class (terminal() is deliberately declared on both, non-unique,
  // so rule 7's unique-name fallback can never mask a guard failure here).
  const aTerminal = callerLabelsOf('vtxchaincyclenodea', 'terminal');
  const bTerminal = callerLabelsOf('vtxchaincyclenodeb', 'terminal');
  if (aTerminal.length || bTerminal.length) {
    bug('A1-cycle-terminal-phantom', `v0.10-A1 [MUST] per A1-iii: VtxChainCycleCaller.runSixDeepCycle's traced .terminal() call (S=6) must produce NO edge to EITHER cycle class (the per-chain visited guard must fire at the 3rd hop, well before this) -- got NodeA.terminal callers=${JSON.stringify(aTerminal)}, NodeB.terminal callers=${JSON.stringify(bTerminal)}`);
  } else {
    console.log('A1: VtxChainCycleCaller.runSixDeepCycle -- the 6-deep return-type cycle degrades honestly to NO edge on .terminal() (both NodeA and NodeB) -- OK [MUST] per A1-iii cycle guard');
  }
}

// =======================================================================
// v0.10-B: Visualforce method-level action bindings, per GROUND-TRUTH.md's
// "v0.10-B" tables (B1-B4).
// =======================================================================
console.log('\n\n########## v0.10-B1: pages/VtxCatalogPage.page (disambiguation traps) ##########');
{
  // L1: apex:page root action="{!initCatalog}" -- declared ONLY on the
  // controller -> method-level edge to VtxCatalogController.initCatalog.
  const initCatalog = callerLabelsOf('vtxcatalogcontroller', 'initcatalog');
  if (!initCatalog.includes('VtxCatalogPage')) {
    bug('B1-initcatalog-missing', `v0.10-B1 [MUST] L1: expected VtxCatalogPage (kind=vf) as a caller of VtxCatalogController.initCatalog -- got ${JSON.stringify(initCatalog)}`);
  } else {
    console.log('B1 L1: apex:page root action="{!initCatalog}" -> VtxCatalogController.initCatalog method-level edge -- OK [MUST]');
  }
  // L6: apex:commandButton action="{!refreshResults}" -- declared ONLY on
  // the EXTENSION (not the controller) -> method-level edge there.
  const refreshResults = callerLabelsOf('vtxcatalogfilterextension', 'refreshresults');
  if (!refreshResults.includes('VtxCatalogPage')) {
    bug('B1-refreshresults-missing', `v0.10-B1 [MUST] L6: expected VtxCatalogPage as a caller of VtxCatalogFilterExtension.refreshResults (declared on the EXTENSION, not the controller) -- got ${JSON.stringify(refreshResults)}`);
  } else {
    console.log('B1 L6: apex:commandButton action="{!refreshResults}" -> VtxCatalogFilterExtension.refreshResults (extension, not controller) -- OK [MUST]');
  }
  // L7: apex:commandButton action="{!resetAll}" -- declared on BOTH
  // controller and extension -> "several declare it": NO method-level edge
  // on either; the SAME class-level ref to the controller already exists
  // (from the page's own controller= attribute) and must not gain a
  // fabricated method node.
  const resetAllOnController = callerLabelsOf('vtxcatalogcontroller', 'resetall');
  const resetAllOnExtension = callerLabelsOf('vtxcatalogfilterextension', 'resetall');
  if (resetAllOnController.includes('VtxCatalogPage') || resetAllOnExtension.includes('VtxCatalogPage')) {
    bug('B1-resetall-fabricated', `v0.10-B1 [MUST] L7: resetAll is declared on BOTH VtxCatalogController AND VtxCatalogFilterExtension ("several declare it") -- expected NO method-level edge on either, got controller=${JSON.stringify(resetAllOnController)} extension=${JSON.stringify(resetAllOnExtension)}`);
  } else {
    console.log('B1 L7: apex:commandButton action="{!resetAll}" -- ambiguous (declared on BOTH classes), correctly produces NO fabricated method edge -- OK [MUST]');
  }
  const controllerClassLevel = callerLabelsOf('vtxcatalogcontroller', null);
  if (!controllerClassLevel.includes('VtxCatalogPage')) {
    bug('B1-resetall-classlevel-missing', `v0.10-B1 [MUST] L7: the pre-existing class-level ref to VtxCatalogController (from the page's own controller= attribute) must still be present regardless of the L7 ambiguity -- got ${JSON.stringify(controllerClassLevel)}`);
  } else {
    console.log('B1: pre-existing class-level VtxCatalogPage -> VtxCatalogController ref (from controller=) unaffected by the L7 ambiguity -- OK [MUST]');
  }
  // L13: apex:actionFunction action="{!vanishedSortHandler}" -- declared on
  // NEITHER class -> no method-level edge anywhere, no NEW class-level edge
  // beyond the pre-existing controller= one (already checked above).
  const vanishedOnController = callerLabelsOf('vtxcatalogcontroller', 'vanishedsorthandler');
  const vanishedOnExtension = callerLabelsOf('vtxcatalogfilterextension', 'vanishedsorthandler');
  if (vanishedOnController.length || vanishedOnExtension.length) {
    bug('B1-vanished-fabricated', `v0.10-B1 [MUST] L13: vanishedSortHandler is declared on NEITHER class -- expected NO method-level edge, got controller=${JSON.stringify(vanishedOnController)} extension=${JSON.stringify(vanishedOnExtension)}`);
  } else {
    console.log('B1 L13: apex:actionFunction action="{!vanishedSortHandler}" -- matches no declaring class, correctly produces NO fabricated method edge -- OK [MUST]');
  }
  // L14: apex:actionSupport action="{!filterExt.legacyReset}" -- dotted,
  // must be SKIPPED entirely at the metascan layer (no MetaRef at all).
  const legacyReset = callerLabelsOf('vtxcatalogfilterextension', 'legacyreset');
  if (legacyReset.length) {
    bug('B1-legacyreset-leaked', `v0.10-B1 [MUST] L14: {!filterExt.legacyReset} is a DOTTED expression -- metascan must skip it entirely (no MetaRef), so VtxCatalogFilterExtension.legacyReset must NEVER appear as a callee of this page -- got callers ${JSON.stringify(legacyReset)}`);
  } else {
    console.log('B1 L14: apex:actionSupport action="{!filterExt.legacyReset}" (dotted) -- correctly skipped, legacyReset has NO callers from this page -- OK [MUST]');
  }
}

console.log('\n\n########## v0.10-B2: pages/VtxOrderHistoryPage.page (clean contrast, no traps) ##########');
{
  const expectedMethods = ['exporthistory', 'retryfailedsync', 'refreshstatus'];
  for (const m of expectedMethods) {
    const labels = callerLabelsOf('vtxorderhistorycontroller', m);
    if (!labels.includes('VtxOrderHistoryPage')) {
      bug(`B2-${m}-missing`, `v0.10-B2 [MUST]: expected VtxOrderHistoryPage as a caller of VtxOrderHistoryController.${m} -- got ${JSON.stringify(labels)}`);
    } else {
      console.log(`B2: VtxOrderHistoryController.${m} <- VtxOrderHistoryPage -- OK [MUST]`);
    }
  }
}

console.log('\n\n########## v0.10-B3: pages/VtxAccountSummaryPage.page (standardController only, literal no-edge) ##########');
{
  // No controller=/extensions= at all. The PRE-EXISTING class-level scan
  // (unchanged by A2) still yields ZERO class-level refs for this file
  // (confirmed below). A2's method-level scan is UNCONDITIONAL on whether
  // the page has a controller/extensions list at all (metascan.js's own
  // documented contract -- "metascan's job is syntactic extraction only;
  // it has no class index"), so it DOES still emit 2 method-level MetaRefs
  // here ({!edit}/{!save}, both with controllerClass:null,
  // extensionClasses:[]) -- that part is CORRECT A2 behavior, not the bug
  // to check for. The actual "literal no-edge" invariant this page tests
  // is downstream, in the RESOLVER's attach gate: with zero candidate
  // classes, attachVfActionRef must drop both refs entirely -- no method
  // edge, no class-level fallback (there is no controller to fall back
  // to), nothing attached anywhere in the index.
  const pagePath = path.join(ORG_ROOT, 'force-app/main/default/pages/VtxAccountSummaryPage.page');
  let classLevelRefCount = -1;
  try {
    const text = fs.readFileSync(pagePath, 'utf8');
    classLevelRefCount = metascan.parseMetaFile({ path: pagePath, text }).filter((r) => r.className != null).length;
  } catch (e) { /* file missing -- classLevelRefCount stays -1, caught below */ }
  if (classLevelRefCount !== 0) {
    bug('B3-classlevel-unexpected', `v0.10-B3 [MUST]: VtxAccountSummaryPage.page (standardController="Account" only) must yield ZERO class-level MetaRefs (no controller=/extensions= attribute at all) -- got ${classLevelRefCount === -1 ? 'file not found/unreadable' : classLevelRefCount + ' ref(s)'}`);
  } else {
    console.log('B3: VtxAccountSummaryPage.page (standardController only) yields ZERO class-level MetaRefs -- pre-existing scan unaffected by A2 -- OK [MUST]');
  }
  const editAnywhere = index.metaCallers instanceof Map && Array.from(index.metaCallers.values()).some((refs) => refs.some((r) => r.label === 'VtxAccountSummaryPage' && r.methodName === 'edit'));
  const saveAnywhere = index.metaCallers instanceof Map && Array.from(index.metaCallers.values()).some((refs) => refs.some((r) => r.label === 'VtxAccountSummaryPage' && r.methodName === 'save'));
  if (editAnywhere || saveAnywhere) {
    bug('B3-action-attached-nowhere-expected', `v0.10-B3 [MUST]: VtxAccountSummaryPage has no controller/extensions class list at all, so its {!edit}/{!save} action bindings must attach NOWHERE in the index (not even a class-level fallback -- there's no controller to fall back to) -- got edit-attached=${editAnywhere} save-attached=${saveAnywhere}`);
  } else {
    console.log('B3: {!edit}/{!save} action bindings attach NOWHERE in the index (no controller/extensions class list to attach to) -- literal no-edge case confirmed -- OK [MUST]');
  }
}

console.log('\n\n########## v0.10-B4: components/VtxFilterPanel.component ##########');
{
  const expectedMethods = ['applyfilter', 'clearfilters'];
  for (const m of expectedMethods) {
    const labels = callerLabelsOf('vtxfilterpanelcontroller', m);
    if (!labels.includes('VtxFilterPanel')) {
      bug(`B4-${m}-missing`, `v0.10-B4 [MUST]: expected VtxFilterPanel (kind=vf, .component -- not .page) as a caller of VtxFilterPanelController.${m} -- got ${JSON.stringify(labels)}`);
    } else {
      console.log(`B4: VtxFilterPanelController.${m} <- VtxFilterPanel (.component) -- OK [MUST]`);
    }
  }
}

// =======================================================================
// v0.11-B1: literal-flow Type.forName dynamic dispatch, per GROUND-TRUTH.md
// "v0.11-B1. Literal-flow dynamic dispatch (Type.forName)" -- B1-i's
// per-method table + B1-ii's non-edge appendix, both against the real
// VtxDynamicFactory.cls/VtxHandlerNames.cls fixtures.
// =======================================================================
console.log('\n\n########## v0.11-B1: classes/VtxDynamicFactory.cls (literal-flow Type.forName) ##########');
{
  // (a) createFromLiteralLocal: single-assignment literal local, never
  // reassigned -> MUST resolve, via='dynamic', approximate:true.
  const literalLocalTree = calleesOf('vtxdynamicfactory', 'createfromliterallocal');
  const literalLocalCtor = (literalLocalTree.root.children || []).find((c) => c.label === 'VtxRouterHandler.<init>');
  if (!literalLocalCtor) {
    bug('B1-a-literallocal-missing', `v0.11-B1 [MUST] per (a): expected VtxDynamicFactory.createFromLiteralLocal -> VtxRouterHandler.<init> (single-assignment literal local), got children ${JSON.stringify((literalLocalTree.root.children || []).map((c) => c.label))}`);
  } else if (literalLocalCtor.via !== 'dynamic' || literalLocalCtor.approximate !== true) {
    bug('B1-a-literallocal-badge', `v0.11-B1 [MUST] per (a): VtxRouterHandler.<init> edge via=${literalLocalCtor.via} approximate=${literalLocalCtor.approximate}, expected via='dynamic' approximate:true`);
  } else {
    console.log('B1(a): createFromLiteralLocal -> VtxRouterHandler.<init>, via=dynamic, approximate:true -- OK [MUST]');
  }

  // (a-neg) createFromReassignedLocal: same literal-initializer shape, but
  // reassigned later in the method (inside an `if`) -> the parser's
  // no-reassignment proof is purely syntactic, so `literal` is cleared
  // regardless of branch reachability -- MUST NOT resolve to EITHER value
  // the local ever held (row 22's non-edge appendix: not even the
  // ORIGINAL pre-reassignment value 'VtxRouterHandler').
  const reassignedTree = calleesOf('vtxdynamicfactory', 'createfromreassignedlocal');
  const reassignedLabels = (reassignedTree.root.children || []).map((c) => c.label);
  if (reassignedLabels.includes('VtxRouterHandler.<init>') || reassignedLabels.includes('VtxLegacyHandler.<init>')) {
    bug('B1-aneg-reassigned-phantom', `v0.11-B1 [MUST] per (a-neg): createFromReassignedLocal must produce NO ctor edge (reassignment anywhere in the method clears \`literal\` unconditionally) -- got children ${JSON.stringify(reassignedLabels)}`);
  } else {
    console.log('B1(a-neg): createFromReassignedLocal -- reassigned local correctly produces NO ctor edge (neither the original nor the reassigned value) -- OK [MUST]');
  }

  // (b) createFromOwnConstant: own-class static final String constant,
  // bare reference -> MUST resolve to VtxEscalationHandler.<init>.
  const ownConstTree = calleesOf('vtxdynamicfactory', 'createfromownconstant');
  const ownConstCtor = (ownConstTree.root.children || []).find((c) => c.label === 'VtxEscalationHandler.<init>');
  if (!ownConstCtor) {
    bug('B1-b-ownconst-missing', `v0.11-B1 [MUST] per (b): expected VtxDynamicFactory.createFromOwnConstant -> VtxEscalationHandler.<init> (own-class bare constant), got children ${JSON.stringify((ownConstTree.root.children || []).map((c) => c.label))}`);
  } else if (ownConstCtor.via !== 'dynamic' || ownConstCtor.approximate !== true) {
    bug('B1-b-ownconst-badge', `v0.11-B1 [MUST] per (b): VtxEscalationHandler.<init> edge via=${ownConstCtor.via} approximate=${ownConstCtor.approximate}, expected via='dynamic' approximate:true`);
  } else {
    console.log('B1(b): createFromOwnConstant -> VtxEscalationHandler.<init>, via=dynamic, approximate:true -- OK [MUST]');
  }

  // (b) createFromCrossClassConstant: cross-class static final String
  // constant, QUALIFIED reference (VtxHandlerNames.ROUTER) -> MUST resolve
  // to VtxRouterHandler.<init>.
  const crossConstTree = calleesOf('vtxdynamicfactory', 'createfromcrossclassconstant');
  const crossConstCtor = (crossConstTree.root.children || []).find((c) => c.label === 'VtxRouterHandler.<init>');
  if (!crossConstCtor) {
    bug('B1-b-crossconst-missing', `v0.11-B1 [MUST] per (b): expected VtxDynamicFactory.createFromCrossClassConstant -> VtxRouterHandler.<init> (VtxHandlerNames.ROUTER, cross-class), got children ${JSON.stringify((crossConstTree.root.children || []).map((c) => c.label))}`);
  } else if (crossConstCtor.via !== 'dynamic' || crossConstCtor.approximate !== true) {
    bug('B1-b-crossconst-badge', `v0.11-B1 [MUST] per (b): VtxRouterHandler.<init> (cross-class) edge via=${crossConstCtor.via} approximate=${crossConstCtor.approximate}, expected via='dynamic' approximate:true`);
  } else {
    console.log('B1(b): createFromCrossClassConstant -> VtxRouterHandler.<init> (via VtxHandlerNames.ROUTER), via=dynamic, approximate:true -- OK [MUST]');
  }

  // (b-neg v1) createFromNonFinalCrossClassField: cross-class field, literal
  // initializer, NOT final -- absent from TypeFacts.constants entirely ->
  // MUST NOT resolve (row 23's non-edge appendix).
  const nonFinalTree = calleesOf('vtxdynamicfactory', 'createfromnonfinalcrossclassfield');
  const nonFinalLabels = (nonFinalTree.root.children || []).map((c) => c.label);
  if (nonFinalLabels.includes('VtxLegacyHandler.<init>')) {
    bug('B1-bneg1-nonfinal-phantom', `v0.11-B1 [MUST] per (b-neg): createFromNonFinalCrossClassField must produce NO ctor edge (VtxHandlerNames.LEGACY_HANDLER_NAME is not \`final\`, so it never enters TypeFacts.constants) -- got children ${JSON.stringify(nonFinalLabels)}`);
  } else {
    console.log('B1(b-neg v1): createFromNonFinalCrossClassField -- non-final field correctly produces NO ctor edge, despite naming a real local class -- OK [MUST]');
  }

  // (b-neg v2) createFromComputedCrossClassField: cross-class field, final,
  // but initializer is a method call, not a literal -- also absent from
  // TypeFacts.constants -> MUST NOT resolve (row 24: moot regardless, no
  // VtxComputedHandler class exists anywhere in this corpus).
  const computedTree = calleesOf('vtxdynamicfactory', 'createfromcomputedcrossclassfield');
  const computedDynamicChildren = (computedTree.root.children || []).filter((c) => c.via === 'dynamic');
  if (computedDynamicChildren.length) {
    bug('B1-bneg2-computed-phantom', `v0.11-B1 [MUST] per (b-neg): createFromComputedCrossClassField must produce NO dynamic ctor edge (COMPUTED_HANDLER_NAME's initializer is a method call, not a literal, so it never enters TypeFacts.constants) -- got ${JSON.stringify(computedDynamicChildren.map((c) => c.label))}`);
  } else {
    console.log('B1(b-neg v2): createFromComputedCrossClassField -- non-literal-initializer field correctly produces NO ctor edge -- OK [MUST]');
  }

  // (c) createFromTernary: ternary of two string literals -> MUST edge
  // BOTH candidates.
  const ternaryTree = calleesOf('vtxdynamicfactory', 'createfromternary');
  const ternaryLabels = (ternaryTree.root.children || []).map((c) => c.label);
  const legacyCtor = (ternaryTree.root.children || []).find((c) => c.label === 'VtxLegacyHandler.<init>');
  const routerCtor = (ternaryTree.root.children || []).find((c) => c.label === 'VtxRouterHandler.<init>');
  if (!legacyCtor || !routerCtor) {
    bug('B1-c-ternary-missing', `v0.11-B1 [MUST] per (c): expected createFromTernary -> BOTH VtxLegacyHandler.<init> AND VtxRouterHandler.<init>, got children ${JSON.stringify(ternaryLabels)}`);
  } else if (legacyCtor.via !== 'dynamic' || legacyCtor.approximate !== true || routerCtor.via !== 'dynamic' || routerCtor.approximate !== true) {
    bug('B1-c-ternary-badge', `v0.11-B1 [MUST] per (c): both ternary ctor edges must be via='dynamic' approximate:true -- got legacy(via=${legacyCtor.via},approx=${legacyCtor.approximate}) router(via=${routerCtor.via},approx=${routerCtor.approximate})`);
  } else {
    console.log('B1(c): createFromTernary -> BOTH VtxLegacyHandler.<init> AND VtxRouterHandler.<init>, via=dynamic, approximate:true -- OK [MUST]');
  }

  // (d) createFromNamespacedLiteral: literal naming a namespaced external
  // ('zenq.Billing') -> MUST edge the external node (own namespace is
  // 'vtx', so 'zenq' is foreign); exact method-label is [IDEAL] only.
  const namespacedTree = calleesOf('vtxdynamicfactory', 'createfromnamespacedliteral');
  const zenqBillingChild = (namespacedTree.root.children || []).find((c) => c.kind === 'external' && c.label === 'zenq.Billing');
  if (!zenqBillingChild) {
    bug('B1-d-namespaced-missing', `v0.11-B1 [MUST] per (d): expected createFromNamespacedLiteral -> external node 'zenq.Billing', got children ${JSON.stringify((namespacedTree.root.children || []).map((c) => c.label))}`);
  } else {
    if (zenqBillingChild.via !== 'dynamic' || zenqBillingChild.approximate !== true) {
      bug('B1-d-namespaced-badge', `v0.11-B1 [MUST] per (d): zenq.Billing external node via=${zenqBillingChild.via} approximate=${zenqBillingChild.approximate}, expected via='dynamic' approximate:true (literal-flow inference, not a syntactic ns.Class(...) call)`);
    } else {
      console.log('B1(d): createFromNamespacedLiteral -> external node zenq.Billing, via=dynamic, approximate:true -- OK [MUST]');
    }
    const site = zenqBillingChild.sites && zenqBillingChild.sites[0];
    if (!site || site.via !== 'dynamic') {
      note('B1-d-sitelabel', `v0.11-B1 [IDEAL]: zenq.Billing external node's new site (from createFromNamespacedLiteral) -- exact method-label/site via not independently verified here beyond the node-level via check above`);
    } else {
      console.log('B1(d): zenq.Billing external node site via=dynamic -- OK [IDEAL]');
    }
  }

  // (e) createFromParam: param-fed Type.forName -- a method PARAMETER never
  // appears in MethodFacts.locals, so no `literal` is ever recorded ->
  // MUST NOT resolve; also has ZERO callers anywhere in this corpus (row
  // 25's non-edge appendix), so there is no indirect literal-flow path
  // to chase either.
  const paramTree = calleesOf('vtxdynamicfactory', 'createfromparam');
  const paramDynamicChildren = (paramTree.root.children || []).filter((c) => c.via === 'dynamic');
  if (paramDynamicChildren.length) {
    bug('B1-e-param-phantom', `v0.11-B1 [MUST] per (e): createFromParam must produce NO dynamic ctor edge (the arg is a method parameter, never a local) -- got ${JSON.stringify(paramDynamicChildren.map((c) => c.label))}`);
  } else {
    console.log('B1(e): createFromParam -- param-fed Type.forName correctly produces NO ctor edge -- OK [MUST]');
  }
  const paramCallers = callerLabelsOf('vtxdynamicfactory', 'createfromparam');
  if (paramCallers.length) {
    bug('B1-e-param-hascallers', `v0.11-B1 row 25 [MUST]: createFromParam is documented as having ZERO callers anywhere in this corpus (tested in isolation) -- got callers ${JSON.stringify(paramCallers)}`);
  } else {
    console.log('B1: createFromParam has zero callers anywhere in this corpus, as documented -- OK [MUST] per row 25');
  }
}

// =======================================================================
// v0.11-B2: generic-DML narrowing, per GROUND-TRUTH.md "v0.11-B2. Generic-
// DML narrowing" -- B2-i's per-method table + B2-ii's promoted pre-existing
// regression check (KappaUnitOfWork.commitWork), both against the real
// VtxUnitOfWorkNarrowing.cls fixture (+ the pre-existing KappaUnitOfWork.cls).
// =======================================================================
console.log('\n\n########## v0.11-B2: classes/VtxUnitOfWorkNarrowing.cls (generic-DML narrowing) ##########');
{
  function dmlMarkerOf(tree) {
    return (tree.root.children || []).find((c) => c.kind === 'unresolved' && c.via === 'dml-unresolved');
  }
  function triggerChildOf(tree, label) {
    return (tree.root.children || []).find((c) => c.kind === 'trigger' && c.label === label);
  }

  // commitBothTypes: TWO new Concrete__c(...) evidence calls, union =
  // {Kappa_Order__c, Kappa_Shipment__c} -> 3 narrowed ~dml edges total
  // (KappaOrderTrigger + KappaOrderUowTrigger for Kappa_Order__c,
  // KappaShipmentTrigger for Kappa_Shipment__c), marker REPLACED (gone).
  {
    const tree = calleesOf('vtxunitofworknarrowing', 'commitbothtypes');
    if (dmlMarkerOf(tree)) {
      bug('B2-bothtypes-marker-present', 'v0.11-B2 [MUST]: commitBothTypes has narrowing evidence for BOTH add() calls -- the honest "DML on unresolved SObject type" marker must be REPLACED, but it is still present.');
    } else {
      console.log('B2: commitBothTypes -- honest marker correctly REPLACED (narrowing evidence found) -- OK [MUST]');
    }
    const orderTrig = triggerChildOf(tree, 'KappaOrderTrigger');
    const orderUowTrig = triggerChildOf(tree, 'KappaOrderUowTrigger');
    const shipmentTrig = triggerChildOf(tree, 'KappaShipmentTrigger');
    if (!orderTrig || !orderUowTrig || !shipmentTrig) {
      bug('B2-bothtypes-edges-missing', `v0.11-B2 [MUST]: commitBothTypes must narrow to all 3 trigger edges (KappaOrderTrigger, KappaOrderUowTrigger, KappaShipmentTrigger) -- got children ${JSON.stringify((tree.root.children || []).map((c) => c.label))}`);
    } else if ([orderTrig, orderUowTrig, shipmentTrig].some((c) => c.via !== 'dml' || c.approximate !== true)) {
      bug('B2-bothtypes-badge', `v0.11-B2 [MUST]: all 3 narrowed edges must be via='dml' approximate:true -- got ${JSON.stringify([orderTrig, orderUowTrig, shipmentTrig].map((c) => ({ label: c.label, via: c.via, approximate: c.approximate })))}`);
    } else {
      console.log('B2: commitBothTypes -- all 3 narrowed edges present (KappaOrderTrigger, KappaOrderUowTrigger, KappaShipmentTrigger), via=dml, approximate:true -- OK [MUST]');
    }
  }

  // commitTypedOrdersViaAddAll: addAll(typedOrders) where typedOrders is a
  // local declared List<Kappa_Order__c> -> narrows to {Kappa_Order__c} ->
  // 2 narrowed edges (KappaOrderTrigger + KappaOrderUowTrigger), marker gone.
  {
    const tree = calleesOf('vtxunitofworknarrowing', 'committypedordersviaaddall');
    if (dmlMarkerOf(tree)) {
      bug('B2-addall-marker-present', 'v0.11-B2 [MUST]: commitTypedOrdersViaAddAll has narrowing evidence (addAll of a declared-List<Kappa_Order__c> local) -- the honest marker must be REPLACED, but it is still present.');
    } else {
      console.log('B2: commitTypedOrdersViaAddAll -- honest marker correctly REPLACED -- OK [MUST]');
    }
    const orderTrig = triggerChildOf(tree, 'KappaOrderTrigger');
    const orderUowTrig = triggerChildOf(tree, 'KappaOrderUowTrigger');
    if (!orderTrig || !orderUowTrig) {
      bug('B2-addall-edges-missing', `v0.11-B2 [MUST]: commitTypedOrdersViaAddAll must narrow to Kappa_Order__c's 2 triggers (KappaOrderTrigger, KappaOrderUowTrigger) -- got children ${JSON.stringify((tree.root.children || []).map((c) => c.label))}`);
    } else if (orderTrig.via !== 'dml' || orderTrig.approximate !== true || orderUowTrig.via !== 'dml' || orderUowTrig.approximate !== true) {
      bug('B2-addall-badge', `v0.11-B2 [MUST]: both narrowed edges must be via='dml' approximate:true -- got orderTrig(via=${orderTrig.via},approx=${orderTrig.approximate}) orderUowTrig(via=${orderUowTrig.via},approx=${orderUowTrig.approximate})`);
    } else {
      console.log('B2: commitTypedOrdersViaAddAll -- both narrowed edges present (KappaOrderTrigger, KappaOrderUowTrigger), via=dml, approximate:true -- OK [MUST]');
    }
  }

  // commitWithNoInMethodEvidence: ZERO add/addAll calls anywhere -> marker
  // STAYS, zero narrowed edges (uses `update`, proving DML-verb-independence).
  {
    const tree = calleesOf('vtxunitofworknarrowing', 'commitwithnoinmethodevidence');
    const marker = dmlMarkerOf(tree);
    const anyTrigger = (tree.root.children || []).some((c) => c.kind === 'trigger');
    if (!marker || anyTrigger) {
      bug('B2-noevidence-marker-missing', `v0.11-B2 [MUST]: commitWithNoInMethodEvidence has ZERO in-method add/addAll evidence -- the honest marker must STAY and NO trigger edges may appear -- got marker=${!!marker} anyTrigger=${anyTrigger}, children ${JSON.stringify((tree.root.children || []).map((c) => c.label))}`);
    } else {
      console.log('B2: commitWithNoInMethodEvidence -- zero evidence, honest marker STAYS, zero narrowed edges -- OK [MUST]');
    }
  }

  // commitWithComplexExpressionEvidence: the one add(...) call's argument
  // is a method-call expression (locateExistingOrder()), not `new
  // Concrete__c(` nor a bare identifier -> does NOT qualify as evidence
  // (cross-method return-type inference is explicitly out of scope) ->
  // marker STAYS, zero narrowed edges.
  {
    const tree = calleesOf('vtxunitofworknarrowing', 'commitwithcomplexexpressionevidence');
    const marker = dmlMarkerOf(tree);
    const anyTrigger = (tree.root.children || []).some((c) => c.kind === 'trigger');
    if (!marker || anyTrigger) {
      bug('B2-complexexpr-marker-missing', `v0.11-B2 [MUST]: commitWithComplexExpressionEvidence's one add() call is a method-call expression, NOT valid evidence (cross-method return-type inference is out of scope) -- the honest marker must STAY and NO trigger edges may appear -- got marker=${!!marker} anyTrigger=${anyTrigger}, children ${JSON.stringify((tree.root.children || []).map((c) => c.label))}`);
    } else {
      console.log('B2: commitWithComplexExpressionEvidence -- method-call-result add() argument correctly does NOT count as evidence, honest marker STAYS -- OK [MUST]');
    }
  }

  // B2-ii promoted regression: KappaUnitOfWork.commitWork (pre-existing) --
  // its own add() calls live in a DIFFERENT method (registerNew), out of
  // scope by construction (same-METHOD evidence only) -> marker STAYS,
  // byte-identical to pre-B2.
  {
    const tree = calleesOf('kappaunitofwork', 'commitwork');
    const marker = dmlMarkerOf(tree);
    const anyTrigger = (tree.root.children || []).some((c) => c.kind === 'trigger');
    if (!marker || anyTrigger) {
      bug('B2-commitwork-regression', `v0.11-B2-ii [MUST] (no-change regression): KappaUnitOfWork.commitWork's own add() calls live in registerNew (a DIFFERENT method) -- cross-method evidence is out of scope, so the honest marker must STAY exactly as pre-B2 and NO trigger edges may appear -- got marker=${!!marker} anyTrigger=${anyTrigger}, children ${JSON.stringify((tree.root.children || []).map((c) => c.label))}`);
    } else {
      console.log('B2-ii: KappaUnitOfWork.commitWork -- pre-existing zero-evidence method unaffected by B2, honest marker STAYS -- OK [MUST] (promoted regression check)');
    }
  }
}

// =======================================================================
// v0.12.0 / C1+C2: ## Entry catalog -- resolver.buildEntryCatalog(index)
// mechanically diffed against BOTH corpora's hand-audited ground truth:
//   - gauntlet-org: example-data/gauntlet-org/GROUND-TRUTH.md's own
//     '## Entry catalog (v0.12)' section (23 entries total, EVERY one
//     listed there -- this checks all 23, not just a 15-entry sample,
//     since the ground truth itself is exhaustive for this corpus).
//   - adv-org: example-data/adv-org/MANIFEST.md's own '## Entry catalog'
//     section (34 entries total; its own "15 representative spot entries"
//     table is checked here verbatim, plus the 6 flow entries individually
//     documented in its "Additional flow details" paragraph).
// Uses the SAME `index` this file already built for gauntlet-org above
// (index.flowFilePaths already wired at its build site); builds a SEPARATE
// adv-org index locally (this file is otherwise gauntlet-org-only), using
// the same real-pipeline wiring dev/smoke.js's runAdvOrg()/
// runGauntletOrgManagedPackages() already establish (packageOf across all
// 3 package roots, ownNamespace from sfdx-project.json, metascan +
// attachMetaCallers, flowFilePaths).
// =======================================================================
console.log('\n\n########## ENTRY CATALOG (v0.12.0) ##########');
if (typeof resolver.buildEntryCatalog !== 'function') {
  bug('EC-not-exported', 'v0.12.0 [MUST]: resolver.buildEntryCatalog is not exported by this build of resolver.js.');
} else {
  // --- gauntlet-org --------------------------------------------------
  const ecT0 = Date.now();
  const catalog = resolver.buildEntryCatalog(index);
  const ecT1 = Date.now();
  const catalog2 = resolver.buildEntryCatalog(index);
  console.log(`gauntlet-org catalog build: ${ecT1 - ecT0}ms (perf bar: < 50ms).`);
  console.log('gauntlet-org stats:', JSON.stringify(catalog.stats));

  if (ecT1 - ecT0 >= 50) {
    bug('EC-perf-gauntlet', `v0.12.0 [MUST]: gauntlet-org catalog build took ${ecT1 - ecT0}ms, expected < 50ms (read-only walk over an already-built index).`);
  }
  if (JSON.stringify(catalog) !== JSON.stringify(catalog2)) {
    bug('EC-determinism-gauntlet', 'v0.12.0 [MUST]: buildEntryCatalog(index) is not deterministic across two calls on the SAME gauntlet-org index.');
  }
  const kindsInOrder = catalog.groups.map((g) => g.kind);
  const expectedKindOrder = ['trigger', 'aura', 'invocable', 'rest', 'soap', 'async', 'email', 'platform', 'flow', 'anonymous'];
  if (JSON.stringify(kindsInOrder) !== JSON.stringify(expectedKindOrder)) {
    bug('EC-kind-order-gauntlet', `v0.12.0 [MUST]: group kind order must be exactly ${JSON.stringify(expectedKindOrder)}, got ${JSON.stringify(kindsInOrder)}.`);
  }

  // v0.13.0: flow count 1 -> 8 (7 new flow files -- see GROUND-TRUTH.md's
  // "## v0.13 subflow chains" -> "Entry catalog delta (v0.13)" table), a
  // counts-only delta permitted by the v0.13 REGRESSION POLICY ((b): "the
  // entry-catalog detail suffix" -- new flow FILES are new entries outright,
  // not merely re-detailed pre-existing ones, since this corpus had no such
  // files before this round).
  const gauntletExpectedByKind = { trigger: 6, aura: 6, invocable: 3, rest: 0, soap: 0, async: 9, email: 0, platform: 0, flow: 10, anonymous: 0 };
  for (const [kind, expected] of Object.entries(gauntletExpectedByKind)) {
    const actual = (catalog.stats.byKind && catalog.stats.byKind[kind]) || 0;
    if (actual !== expected) {
      bug('EC-count-gauntlet-' + kind, `GROUND-TRUTH.md '## Entry catalog' [MUST]: kind='${kind}' expected count ${expected}, got ${actual}.`);
    }
  }
  // v0.14.0: total 30 -> 34 (+1 Aura, +1 Invocable, +2 Flow fixtures).
  if (catalog.stats.total !== 34) bug('EC-total-gauntlet', `GROUND-TRUTH.md [MUST]: expected total=34, got ${catalog.stats.total}.`);
  if (catalog.stats.excludedTestEntries !== 0) bug('EC-excluded-gauntlet', `GROUND-TRUTH.md [MUST]: expected excludedTestEntries=0, got ${catalog.stats.excludedTestEntries}.`);
  if (!Array.isArray(catalog.stats.packages) || catalog.stats.packages.length !== 0) bug('EC-packages-gauntlet', `GROUND-TRUTH.md [MUST]: single-package corpus -- expected packages=[], got ${JSON.stringify(catalog.stats.packages)}.`);

  function ecFindEntry(cat, kind, label) {
    const g = cat.groups.find((x) => x.kind === kind);
    return g && g.entries.find((e) => e.label === label);
  }
  function ecCheckEntry(id, kind, label, expectedDetail) {
    const e = ecFindEntry(catalog, kind, label);
    if (!e) {
      bug('EC-' + id + '-missing', `GROUND-TRUTH.md '## Entry catalog' [MUST]: expected [${kind}] '${label}' -- entry missing entirely.`);
    } else if (e.detail !== expectedDetail) {
      bug('EC-' + id + '-detail', `GROUND-TRUTH.md '## Entry catalog' [MUST]: [${kind}] '${label}' expected detail '${expectedDetail}', got '${e.detail}'.`);
    } else {
      console.log(`  OK [${kind}] ${label} -- ${e.detail}`);
    }
  }

  // All 6 triggers (source-declaration event order, not alphabetized).
  ecCheckEntry('trig-kappaorder', 'trigger', 'KappaOrderTrigger', 'on Kappa_Order__c (before insert, after insert, after update)');
  ecCheckEntry('trig-kappaorderuow', 'trigger', 'KappaOrderUowTrigger', 'on Kappa_Order__c (after insert)');
  ecCheckEntry('trig-kappashipment', 'trigger', 'KappaShipmentTrigger', 'on Kappa_Shipment__c (before insert, after insert)');
  ecCheckEntry('trig-boltitem', 'trigger', 'VertexBoltItemTrigger', 'on Kappa_Item__c (after insert, after update)');
  ecCheckEntry('trig-vertexorder', 'trigger', 'VertexOrderTrigger', 'on Vertex_Order__c (after update, after insert)');
  ecCheckEntry('trig-kwxinvoice', 'trigger', 'VtxKwxInvoiceTrigger', 'on kwx__Invoice__c (before insert)');

  // All 6 aura entries.
  ecCheckEntry('aura-multi05', 'aura', 'VertexBoltMulti05.runBeta', '@AuraEnabled (LWC/Aura)');
  ecCheckEntry('aura-solo01', 'aura', 'VertexBoltSolo01.runDispatch', '@AuraEnabled (LWC/Aura)');
  ecCheckEntry('aura-solo02', 'aura', 'VertexBoltSolo02.runDispatch', '@AuraEnabled (LWC/Aura)');
  ecCheckEntry('aura-bulkrecalc', 'aura', 'VertexOrderController.bulkRecalculate', '@AuraEnabled (LWC/Aura)');
  ecCheckEntry('aura-recalc', 'aura', 'VertexOrderController.recalculate', '@AuraEnabled (LWC/Aura)');
  ecCheckEntry('aura-impact-refresh', 'aura', 'VertexImpactController.refresh', '@AuraEnabled (LWC/Aura)');
  // VertexBoltMulti05's OTHER 2 methods (runAlpha/runGamma, plain public,
  // no @AuraEnabled) must NEVER appear anywhere in the aura group.
  const auraGroupLabels = (catalog.groups.find((g) => g.kind === 'aura').entries || []).map((e) => e.label);
  if (auraGroupLabels.includes('VertexBoltMulti05.runAlpha') || auraGroupLabels.includes('VertexBoltMulti05.runGamma')) {
    bug('EC-multi05-false-positive', `GROUND-TRUTH.md [MUST]: VertexBoltMulti05's non-@AuraEnabled methods (runAlpha/runGamma) must not appear in the aura group -- got ${JSON.stringify(auraGroupLabels)}.`);
  }

  // All 3 invocable entries.
  ecCheckEntry('inv-solo03', 'invocable', 'VertexBoltSolo03.runDispatch', '@InvocableMethod (Flow)');
  ecCheckEntry('inv-approval', 'invocable', 'VertexOrderApprovalInvocable.execute', '@InvocableMethod (Flow)');
  ecCheckEntry('inv-impact-action', 'invocable', 'VertexImpactAction.run', '@InvocableMethod (Flow)');

  // All 9 async entries -- Batchable's start/finish count alongside execute
  // (ruling 2), not just execute() alone.
  ecCheckEntry('async-nightlyrelay', 'async', 'VertexBoltNightlyRelayJob.execute', 'Schedulable');
  ecCheckEntry('async-solo04', 'async', 'VertexBoltSolo04.execute', 'Schedulable');
  ecCheckEntry('async-followup-exec', 'async', 'VertexFollowupBatch.execute', 'Batchable');
  ecCheckEntry('async-followup-finish', 'async', 'VertexFollowupBatch.finish', 'Batchable');
  ecCheckEntry('async-followup-start', 'async', 'VertexFollowupBatch.start', 'Batchable');
  ecCheckEntry('async-nightlyadj', 'async', 'VertexNightlyAdjustmentJob.execute', 'Schedulable');
  ecCheckEntry('async-repricebatch-exec', 'async', 'VertexRepriceBatch.execute', 'Batchable');
  ecCheckEntry('async-repricebatch-finish', 'async', 'VertexRepriceBatch.finish', 'Batchable');
  ecCheckEntry('async-repricebatch-start', 'async', 'VertexRepriceBatch.start', 'Batchable');

  // The one flow entry -- record-triggered, direct '<triggerType> on
  // <Object>' form (this corpus has no platform-event/screen flow to
  // exercise the other 2 detail shapes -- see the adv-org leg below).
  ecCheckEntry('flow-namespaceprobe', 'flow', 'Vtx_Namespace_Probe_Flow', 'RecordAfterSave on Vertex_Order__c');

  // v0.13.0: the 7 new flow entries -- GROUND-TRUTH.md "## v0.13 subflow
  // chains" -> "Entry catalog delta (v0.13)" table, verbatim.
  ecCheckEntry('flow-widgetlifecycle', 'flow', 'Vtx_WidgetLifecycleFlow', 'RecordAfterSave on Vertex_Widget__c');
  ecCheckEntry('flow-widgetnotifysubflow', 'flow', 'Vtx_WidgetLifecycleNotifySubflow', 'screen or autolaunched (subflow of Vtx_WidgetLifecycleFlow)');
  ecCheckEntry('flow-chaintop', 'flow', 'Vtx_FlowChainTop', 'screen or autolaunched');
  ecCheckEntry('flow-chainmid', 'flow', 'Vtx_FlowChainMid', 'screen or autolaunched (subflow of Vtx_FlowChainTop)');
  ecCheckEntry('flow-chainleaf', 'flow', 'Vtx_FlowChainLeaf', 'screen or autolaunched (subflow of Vtx_FlowChainMid)');
  ecCheckEntry('flow-cyclea', 'flow', 'Vtx_FlowCycleA', 'screen or autolaunched (subflow of Vtx_FlowCycleB)');
  ecCheckEntry('flow-cycleb', 'flow', 'Vtx_FlowCycleB', 'screen or autolaunched (subflow of Vtx_FlowCycleA)');
  ecCheckEntry('flow-impact-parent', 'flow', 'Vtx_ImpactParentFlow', 'screen or autolaunched');
  ecCheckEntry('flow-impact-child', 'flow', 'Vtx_ImpactChildFlow', 'screen or autolaunched (subflow of Vtx_ImpactParentFlow)');

  console.log('gauntlet-org: all 34 ground-truth entries checked (6 trigger + 6 aura + 3 invocable + 9 async + 10 flow; rest/soap/email/platform/anonymous confirmed empty above).');

  // --- adv-org ---------------------------------------------------------
  const ADV_ORG_PROJECT_ROOT = path.relative(process.cwd(), advOrgRoot) || '.';
  const ADV_ORG_ROOT = path.join(ADV_ORG_PROJECT_ROOT, 'force-app', 'main', 'default');
  const ADV_ORG_SKIP_DIRS = new Set(['.sfdx', '.sf', 'node_modules', '.git', '__tests__']);
  const ADV_ORG_SCRIPTS_ROOT = path.join(ADV_ORG_PROJECT_ROOT, 'scripts');
  const ADV_ORG_PKG_ROOTS = [
    path.join(ADV_ORG_PROJECT_ROOT, 'pkg-billing', 'main', 'default'),
    path.join(ADV_ORG_PROJECT_ROOT, 'pkg-shared', 'main', 'default'),
  ];

  function advWalk(dir, apexOut, metaOut) {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) { if (ADV_ORG_SKIP_DIRS.has(e.name)) continue; advWalk(full, apexOut, metaOut); continue; }
      if (/\.(cls|trigger)$/i.test(e.name)) apexOut.push(full);
      else if (/\.(cls|trigger)-meta\.xml$/i.test(e.name)) continue;
      else if (/\.js$/i.test(e.name) || /\.flow-meta\.xml$/i.test(e.name) || /\.md-meta\.xml$/i.test(e.name) || /\.os-meta\.xml$/i.test(e.name) || /\.(cmp|app)$/i.test(e.name) || /\.json$/i.test(e.name) || /\.(page|component)$/i.test(e.name)) metaOut.push(full);
    }
  }
  function advBuildPackageOf() {
    const sfdxProjectPath = path.join(ADV_ORG_PROJECT_ROOT, 'sfdx-project.json');
    let json;
    try { json = JSON.parse(fs.readFileSync(sfdxProjectPath, 'utf8')); } catch (e) { return { packageOf: () => null, defaultPackage: null, ownNamespace: null }; }
    const dirs = Array.isArray(json.packageDirectories) ? json.packageDirectories : [];
    const prefixes = [];
    let defaultPackage = null;
    for (const dir of dirs) {
      if (!dir || typeof dir.path !== 'string' || !dir.path.trim()) continue;
      const relPath = dir.path.replace(/^[\\/]+/, '').replace(/[\\/]+$/, '');
      if (!relPath) continue;
      const label = typeof dir.package === 'string' && dir.package.trim() ? dir.package.trim() : relPath.split(/[\\/]/).pop();
      prefixes.push({ prefix: path.join(ADV_ORG_PROJECT_ROOT, relPath), label });
      if (dir.default === true) defaultPackage = label;
    }
    prefixes.sort((a, b) => b.prefix.length - a.prefix.length);
    const packageOfFn = function (fsPath) {
      if (!fsPath || !prefixes.length) return null;
      for (const { prefix, label } of prefixes) {
        if (fsPath === prefix || fsPath.startsWith(prefix + path.sep)) return label;
      }
      return null;
    };
    const ownNamespaceVal = typeof json.namespace === 'string' && json.namespace.trim() ? json.namespace.trim() : null;
    return { packageOf: packageOfFn, defaultPackage, ownNamespace: ownNamespaceVal };
  }

  const advApexOut = [];
  const advMetaOut = [];
  advWalk(ADV_ORG_ROOT, advApexOut, advMetaOut);
  for (const pr of ADV_ORG_PKG_ROOTS) advWalk(pr, advApexOut, advMetaOut);
  try {
    for (const name of fs.readdirSync(ADV_ORG_SCRIPTS_ROOT)) {
      if (/\.apex$/i.test(name)) advApexOut.push(path.join(ADV_ORG_SCRIPTS_ROOT, name));
    }
  } catch (e) { /* scripts/ dir optional */ }

  const { packageOf: advPackageOf, defaultPackage: advDefaultPackage, ownNamespace: advOwnNamespace } = advBuildPackageOf();
  const advFactsList = advApexOut.map((p) => parser.parseFile({ path: p, text: fs.readFileSync(p, 'utf8') }));
  const advParseErrors = advFactsList.filter((f) => f.parseError);
  // adv-org has ONE deliberately-malformed fixture (AcmeBrokenParser.cls,
  // a parser-robustness probe -- see dev/smoke.js/dev/manifest-verify.js's
  // own "expect exactly 1: AcmeBrokenParser.cls" convention); anything
  // other than exactly that one file is a genuine defect.
  const advUnexpectedParseErrors = advParseErrors.filter((f) => !/AcmeBrokenParser\.cls$/.test(f.path));
  if (advParseErrors.length !== 1 || advUnexpectedParseErrors.length > 0) {
    bug('EC-advorg-parseerrors', `v0.12.0 [MUST]: adv-org expected exactly 1 parseError (AcmeBrokenParser.cls, a deliberate parser-robustness fixture), got ${advParseErrors.length}: ${JSON.stringify(advParseErrors.map((f) => f.path))}`);
  } else {
    console.log('adv-org: exactly 1 parseError (AcmeBrokenParser.cls, the known deliberate fixture) -- OK.');
  }
  const advIndex = resolver.buildSemanticIndex(advFactsList, { packageOf: advPackageOf, defaultPackage: advDefaultPackage, ownNamespace: advOwnNamespace });
  const advMetaRefs = [];
  for (const f of advMetaOut) {
    const text = fs.readFileSync(f, 'utf8');
    for (const ref of metascan.parseMetaFile({ path: f, text })) { ref.path = f; advMetaRefs.push(ref); }
  }
  const advStrippedRefs = advOwnNamespace && typeof metascan.stripOwnNamespace === 'function'
    ? metascan.stripOwnNamespace(advMetaRefs, advOwnNamespace)
    : advMetaRefs;
  resolver.attachMetaCallers(advIndex, advStrippedRefs);
  advIndex.flowFilePaths = advMetaOut.filter((p) => /\.flow-meta\.xml$/i.test(p));

  const advT0 = Date.now();
  const advCatalog = resolver.buildEntryCatalog(advIndex);
  const advT1 = Date.now();
  const advCatalog2 = resolver.buildEntryCatalog(advIndex);
  console.log(`\nadv-org catalog build: ${advT1 - advT0}ms (informational -- the < 50ms bar is a gauntlet-org-only requirement).`);
  console.log('adv-org stats:', JSON.stringify(advCatalog.stats));
  if (JSON.stringify(advCatalog) !== JSON.stringify(advCatalog2)) {
    bug('EC-determinism-advorg', 'v0.12.0 [MUST]: buildEntryCatalog(index) is not deterministic across two calls on the SAME adv-org index.');
  }

  const advExpectedByKind = { trigger: 4, aura: 8, invocable: 2, rest: 2, soap: 1, async: 6, email: 1, platform: 3, flow: 6, anonymous: 1 };
  for (const [kind, expected] of Object.entries(advExpectedByKind)) {
    const actual = (advCatalog.stats.byKind && advCatalog.stats.byKind[kind]) || 0;
    if (actual !== expected) {
      bug('EC-count-advorg-' + kind, `MANIFEST.md '## Entry catalog' [MUST]: kind='${kind}' expected count ${expected}, got ${actual}.`);
    }
  }
  if (advCatalog.stats.total !== 34) bug('EC-total-advorg', `MANIFEST.md [MUST]: expected total=34, got ${advCatalog.stats.total}.`);
  if (advCatalog.stats.excludedTestEntries !== 0) bug('EC-excluded-advorg', `MANIFEST.md [MUST]: expected excludedTestEntries=0, got ${advCatalog.stats.excludedTestEntries}.`);
  if (!Array.isArray(advCatalog.stats.packages) || advCatalog.stats.packages.length !== 0) bug('EC-packages-advorg', `MANIFEST.md [MUST]: every annotated class lives in the default package -- expected packages=[], got ${JSON.stringify(advCatalog.stats.packages)}.`);

  function advCheckEntry(id, kind, label, expectedDetail) {
    const g = advCatalog.groups.find((x) => x.kind === kind);
    const e = g && g.entries.find((x) => x.label === label);
    if (!e) {
      bug('EC-adv-' + id + '-missing', `MANIFEST.md '## Entry catalog' [MUST]: expected [${kind}] '${label}' -- entry missing entirely.`);
    } else if (e.detail !== expectedDetail) {
      bug('EC-adv-' + id + '-detail', `MANIFEST.md '## Entry catalog' [MUST]: [${kind}] '${label}' expected detail '${expectedDetail}', got '${e.detail}'.`);
    } else {
      console.log(`  OK [${kind}] ${label} -- ${e.detail}`);
    }
  }

  // MANIFEST.md's own "15 representative spot entries" table, verbatim.
  advCheckEntry('spot01', 'trigger', 'AcmeOrderTrigger', 'on Acme_Order__c (before insert, before update, after insert, after update)');
  advCheckEntry('spot02', 'trigger', 'AcmeShipmentLifecycleTrigger', 'on Acme_Shipment__c (before delete, after undelete)');
  advCheckEntry('spot03', 'trigger', 'AcmeNoteEventTrigger', 'on Acme_Note__e (after insert)');
  advCheckEntry('spot04', 'aura', 'AcmeQuoteAuraService.getRecentQuotes', '@AuraEnabled (LWC/Aura)');
  advCheckEntry('spot05', 'aura', 'AcmeOrderApprovalController.approveOrder', '@AuraEnabled (LWC/Aura)');
  advCheckEntry('spot06', 'invocable', 'AcmeOrderInvocable.execute', '@InvocableMethod (Flow)');
  advCheckEntry('spot07', 'rest', 'AcmeOrderRestResource.handleGet', '@HttpGet');
  advCheckEntry('spot08', 'rest', 'AcmeOrderRestResource.handlePost', '@HttpPost');
  advCheckEntry('spot09', 'soap', 'AcmeLegacyOrderSoapService.legacyApproveOrder', 'webservice (SOAP API)');
  advCheckEntry('spot10', 'async', 'AcmeOrderBatchProcessor.start', 'Batchable');
  advCheckEntry('spot11', 'async', 'AcmeNightlyReconciliationScheduler.execute', 'Schedulable');
  advCheckEntry('spot12', 'async', 'AcmeFutureNotifier.sendApprovalEmail', '@future');
  advCheckEntry('spot13', 'email', 'AcmeSupportEmailHandler.handleInboundEmail', 'InboundEmailHandler (Email Service)');
  advCheckEntry('spot14', 'platform', 'AcmeReconciliationFinalizer.execute', 'Finalizer (async)');
  advCheckEntry('spot15', 'flow', 'AcmeOrderCreatedWelcomeFlow', 'RecordAfterSave on Acme_Order__c');

  // MANIFEST.md's "Additional flow details" paragraph -- the other 5 of
  // the corpus's 6 flow files, exercising all 3 flow detail shapes
  // (record-triggered, platform-event [the ruling-1 lowercase-string
  // case], and the 'screen or autolaunched' fallback).
  advCheckEntry('flow-note', 'flow', 'AcmeNoteEventFlow', 'platform event on Acme_Note__e');
  advCheckEntry('flow-statustrig', 'flow', 'AcmeOrderStatusRecordTriggeredFlow', 'RecordAfterSave on Acme_Order__c');
  advCheckEntry('flow-backorder', 'flow', 'AcmeBackorderResolutionFlow', 'screen or autolaunched');
  // v0.13.0: MANIFEST.md's "## v0.13 subflow chains (adv-org)" -> "Entry
  // catalog delta (v0.13)" -- AcmeNotifyCustomerSubflow now has exactly 1
  // parent (AcmeBackorderResolutionFlow, via the newly-promoted <subflows>
  // edge) and no <start> trigger info of its own, so it gains the v0.13
  // 'subflow of <parent>' suffix. AcmeBackorderResolutionFlow/
  // AcmeQuoteApprovalScreenFlow have zero parents each -- unchanged.
  advCheckEntry('flow-notifysub', 'flow', 'AcmeNotifyCustomerSubflow', 'screen or autolaunched (subflow of AcmeBackorderResolutionFlow)');
  advCheckEntry('flow-quoteapproval', 'flow', 'AcmeQuoteApprovalScreenFlow', 'screen or autolaunched');

  console.log('adv-org: counts-per-kind + all 15 representative spot entries + the 5 remaining flow details checked.');

  // v0.13.0: MANIFEST.md "## v0.13 subflow chains (adv-org)" -> "The
  // promoted edge" table -- the famous historically-invisible
  // AcmeBackorderResolutionFlow -> AcmeNotifyCustomerSubflow reference,
  // promoted from documented-invisible to [MUST] this round. buildEntryCatalog
  // already ran finalizeFlowSubflowRefs (see resolver.js's own note on that
  // function being invoked lazily by buildCallerTree/buildCalleeTree/
  // buildEntryCatalog) so advIndex.flowGraph is fully resolved at this point.
  console.log('\n-- v0.13 subflow chains (adv-org): the promoted edge --');
  const advBackorderGraph = advIndex.flowGraph instanceof Map ? advIndex.flowGraph.get('acmebackorderresolutionflow') : null;
  const advNotifysubGraph = advIndex.flowGraph instanceof Map ? advIndex.flowGraph.get('acmenotifycustomersubflow') : null;
  if (!advBackorderGraph || JSON.stringify(advBackorderGraph.parents) !== '[]' || JSON.stringify(advBackorderGraph.children) !== '["acmenotifycustomersubflow"]') {
    bug('V13-adv-flowgraph-backorder', `MANIFEST.md '## v0.13 subflow chains (adv-org)' [MUST]: expected flowGraph.acmebackorderresolutionflow = {parents:[],children:['acmenotifycustomersubflow']}, got ${JSON.stringify(advBackorderGraph)}.`);
  } else {
    console.log("  OK: flowGraph['acmebackorderresolutionflow'] = {parents:[], children:['acmenotifycustomersubflow']}");
  }
  if (!advNotifysubGraph || JSON.stringify(advNotifysubGraph.parents) !== '["acmebackorderresolutionflow"]' || JSON.stringify(advNotifysubGraph.children) !== '[]') {
    bug('V13-adv-flowgraph-notifysub', `MANIFEST.md '## v0.13 subflow chains (adv-org)' [MUST]: expected flowGraph.acmenotifycustomersubflow = {parents:['acmebackorderresolutionflow'],children:[]}, got ${JSON.stringify(advNotifysubGraph)}.`);
  } else {
    console.log("  OK: flowGraph['acmenotifycustomersubflow'] = {parents:['acmebackorderresolutionflow'], children:[]}");
  }
  // This pair resolves cleanly (both are real files) -- contributes 0 to
  // adv-org's own unknownSubflowRefs.
  if (advIndex.stats.unknownSubflowRefs !== 0) {
    bug('V13-adv-unknownsubflowrefs', `MANIFEST.md [MUST]: adv-org's promoted pair contributes 0 to unknownSubflowRefs (both flows are real files) -- got advIndex.stats.unknownSubflowRefs=${advIndex.stats.unknownSubflowRefs}.`);
  } else {
    console.log('  OK: advIndex.stats.unknownSubflowRefs = 0 (both flows in the promoted pair are real files)');
  }
}

// =======================================================================
// ## v0.13 subflow chains (gauntlet-org) -- mechanically diffed against
// example-data/gauntlet-org/GROUND-TRUTH.md's own "## v0.13 subflow chains"
// section: flowGraph table (7 new flows + the pre-existing namespace-probe
// flow's own unchanged empty entry), stats.unknownSubflowRefs (the
// unknown-subflow-ref negative), the req-1 caller-direction chain (apex <-
// subflow <- parent flow <- launcher), the req-2 3-deep chain, the req-3
// mutual cycle (must not hang), and the req-4 callee-direction chain (DML ->
// parent flow -> subflow -> subflow's own apex action). Uses the SAME
// `index` this file already built for gauntlet-org at the top (buildEntryCatalog
// above already ran finalizeFlowSubflowRefs, so index.flowGraph is fully
// resolved by now).
// =======================================================================
console.log('\n\n########## v0.13 SUBFLOW CHAINS (gauntlet-org) ##########');
{
  const expectedFlowGraph = {
    vtx_widgetlifecycleflow: { parents: [], children: ['vtx_widgetlifecyclenotifysubflow'] },
    vtx_widgetlifecyclenotifysubflow: { parents: ['vtx_widgetlifecycleflow'], children: [] },
    vtx_flowchaintop: { parents: [], children: ['vtx_flowchainmid'] },
    vtx_flowchainmid: { parents: ['vtx_flowchaintop'], children: ['vtx_flowchainleaf'] },
    vtx_flowchainleaf: { parents: ['vtx_flowchainmid'], children: [] },
    vtx_flowcyclea: { parents: ['vtx_flowcycleb'], children: ['vtx_flowcycleb'] },
    vtx_flowcycleb: { parents: ['vtx_flowcyclea'], children: ['vtx_flowcyclea'] },
  };
  for (const [flowLower, expected] of Object.entries(expectedFlowGraph)) {
    const actual = index.flowGraph instanceof Map ? index.flowGraph.get(flowLower) : null;
    if (!actual || JSON.stringify(actual.parents) !== JSON.stringify(expected.parents) || JSON.stringify(actual.children) !== JSON.stringify(expected.children)) {
      bug('V13-flowgraph-' + flowLower, `GROUND-TRUTH.md '## v0.13 subflow chains' [MUST]: flowGraph['${flowLower}'] expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}.`);
    } else {
      console.log(`  OK: flowGraph['${flowLower}'] = ${JSON.stringify(actual)}`);
    }
  }
  // Pre-existing flow, unaffected: no <subflows> element anywhere in that
  // file, so it must still have empty parents/children (v0.13 REGRESSION
  // POLICY: additive-only).
  const probeGraph = index.flowGraph instanceof Map ? index.flowGraph.get('vtx_namespace_probe_flow') : null;
  if (probeGraph && (probeGraph.parents.length || probeGraph.children.length)) {
    bug('V13-flowgraph-probe-regression', `GROUND-TRUTH.md [MUST]: Vtx_Namespace_Probe_Flow has no <subflows> element anywhere -- flowGraph entry (if any) must stay empty, got ${JSON.stringify(probeGraph)}.`);
  } else {
    console.log('  OK: vtx_namespace_probe_flow unaffected (no <subflows> element pre-v0.13, still empty/absent)');
  }

  // stats.unknownSubflowRefs: exactly 1 (Vtx_WidgetLifecycleFlow's
  // Call_Ghost_Followup -> Vtx_Nonexistent_Ghost_Flow, no such file) -- the
  // reference is counted, and NO flowGraph entry/node is ever fabricated for it.
  if (index.stats.unknownSubflowRefs !== 1) {
    bug('V13-unknownsubflowrefs', `GROUND-TRUTH.md [MUST]: expected stats.unknownSubflowRefs=1 (the Vtx_Nonexistent_Ghost_Flow negative), got ${index.stats.unknownSubflowRefs}.`);
  } else {
    console.log('  OK: stats.unknownSubflowRefs = 1 (Call_Ghost_Followup -> Vtx_Nonexistent_Ghost_Flow, counted, no fabricated node)');
  }
  if (index.flowGraph instanceof Map && index.flowGraph.has('vtx_nonexistent_ghost_flow')) {
    bug('V13-ghost-fabricated-node', "GROUND-TRUTH.md [MUST]: flowGraph must NEVER have a 'vtx_nonexistent_ghost_flow' key -- an unresolvable subflow name must never fabricate a node.");
  } else {
    console.log('  OK: no fabricated flowGraph entry for vtx_nonexistent_ghost_flow');
  }

  // --- req-1: apex <- subflow <- parent flow <- launcher (caller direction) ---
  console.log('\n-- req-1: VtxFlowWidgetNotifier.notifyTeam (apex <- subflow <- parent <- launcher) --');
  const req1Tree = printTree('req-1 VtxFlowWidgetNotifier.notifyTeam callers', resolver.buildCallerTree(index, { classLower: 'vtxflowwidgetnotifier', methodLower: 'notifyteam' }, {}));
  const req1Subflow = req1Tree.root.children.find((c) => c.kind === 'flow');
  if (!req1Subflow || req1Subflow.label !== 'Vtx_WidgetLifecycleNotifySubflow' || req1Subflow.via !== 'metadata') {
    bug('V13-req1-subflowmeta', `GROUND-TRUTH.md req-1 [MUST]: expected Vtx_WidgetLifecycleNotifySubflow (via=metadata) as notifyTeam's direct caller, got ${JSON.stringify(req1Subflow)}.`);
  } else {
    const req1Parent = req1Subflow.children.find((c) => c.kind === 'flow');
    if (!req1Parent || req1Parent.label !== 'Vtx_WidgetLifecycleFlow' || req1Parent.via !== 'subflow' || req1Parent.approximate !== false) {
      bug('V13-req1-parentflow', `GROUND-TRUTH.md req-1 [MUST]: expected Vtx_WidgetLifecycleFlow (via=subflow, approximate:false) under Vtx_WidgetLifecycleNotifySubflow -- got ${JSON.stringify(req1Parent)}.`);
    } else {
      const req1Launcher = req1Parent.children.find((c) => c.label === 'VtxFlowWidgetDmlSource.createWidget');
      if (!req1Launcher || req1Launcher.via !== 'dml') {
        bug('V13-req1-launcher', `GROUND-TRUTH.md req-1 [MUST]: expected VtxFlowWidgetDmlSource.createWidget (via=dml) under Vtx_WidgetLifecycleFlow -- got ${JSON.stringify(req1Launcher)}.`);
      } else {
        console.log('req-1: apex <- subflow [metadata] <- parent flow [subflow, NEW v0.13] <- DML launcher -- OK [MUST], full chain confirmed.');
      }
    }
  }

  // --- req-2: 3-deep chain (caller direction) ---
  console.log('\n-- req-2: VtxFlowChainRelay.relayLeaf (3-deep chain) --');
  const req2Tree = printTree('req-2 VtxFlowChainRelay.relayLeaf callers', resolver.buildCallerTree(index, { classLower: 'vtxflowchainrelay', methodLower: 'relayleaf' }, {}));
  const req2Leaf = req2Tree.root.children.find((c) => c.kind === 'flow');
  const req2Mid = req2Leaf && req2Leaf.children.find((c) => c.kind === 'flow');
  const req2Top = req2Mid && req2Mid.children.find((c) => c.kind === 'flow');
  if (!req2Leaf || req2Leaf.label !== 'Vtx_FlowChainLeaf' || !req2Mid || req2Mid.label !== 'Vtx_FlowChainMid' || req2Mid.via !== 'subflow' || !req2Top || req2Top.label !== 'Vtx_FlowChainTop' || req2Top.via !== 'subflow') {
    bug('V13-req2-chain', `GROUND-TRUTH.md req-2 [MUST]: expected Vtx_FlowChainLeaf[metadata] -> Vtx_FlowChainMid[subflow] -> Vtx_FlowChainTop[subflow] -- got leaf=${JSON.stringify(req2Leaf && req2Leaf.label)} mid=${JSON.stringify(req2Mid && req2Mid.label)} top=${JSON.stringify(req2Top && req2Top.label)}.`);
  } else if ((req2Top.children || []).length !== 0) {
    bug('V13-req2-terminal', `GROUND-TRUTH.md req-2 [MUST]: Vtx_FlowChainTop has no parent (nobody subflows Top) -- must be terminal, got children ${JSON.stringify((req2Top.children || []).map((c) => c.label))}.`);
  } else {
    console.log('req-2: VtxFlowChainRelay.relayLeaf -- 3-deep chain Leaf[metadata]->Mid[subflow]->Top[subflow, terminal] -- OK [MUST].');
  }
  // Cross-check: relayMid's own caller-tree is 2-deep, proving the chain
  // genuinely recurses per-node rather than being hardcoded to exactly 3.
  const req2MidTree = resolver.buildCallerTree(index, { classLower: 'vtxflowchainrelay', methodLower: 'relaymid' }, {});
  const req2MidDirect = req2MidTree.root.children.find((c) => c.kind === 'flow');
  const req2MidToTop = req2MidDirect && req2MidDirect.children.find((c) => c.kind === 'flow');
  if (!req2MidDirect || req2MidDirect.label !== 'Vtx_FlowChainMid' || !req2MidToTop || req2MidToTop.label !== 'Vtx_FlowChainTop' || (req2MidToTop.children || []).length !== 0) {
    bug('V13-req2-relaymid-2deep', `GROUND-TRUTH.md req-2 [MUST]: relayMid's caller-tree must be exactly 2-deep (Vtx_FlowChainMid[metadata] -> Vtx_FlowChainTop[subflow], terminal) -- got ${JSON.stringify(req2MidDirect && req2MidDirect.label)} -> ${JSON.stringify(req2MidToTop && req2MidToTop.label)}.`);
  } else {
    console.log('req-2 cross-check: relayMid caller-tree is 2-deep (recursion genuinely per-node, not hardcoded) -- OK [MUST].');
  }

  // --- req-3: mutual cycle, must not hang (caller direction, both members) ---
  console.log('\n-- req-3: VtxFlowCycleHelper.pingA/pingB (mutual cycle) --');
  function checkCycle(methodLower, startLabel, midLabel) {
    const t = resolver.buildCallerTree(index, { classLower: 'vtxflowcyclehelper', methodLower }, {});
    const meta = t.root.children.find((c) => c.kind === 'flow');
    const sub = meta && meta.children.find((c) => c.kind === 'flow');
    const back = sub && sub.children.find((c) => c.kind === 'flow');
    if (!meta || meta.label !== startLabel || !sub || sub.label !== midLabel || sub.via !== 'subflow' || !back || back.label !== startLabel || back.via !== 'subflow') {
      bug('V13-req3-' + methodLower, `GROUND-TRUTH.md req-3 [MUST]: expected ${startLabel}[metadata] -> ${midLabel}[subflow] -> ${startLabel}[subflow,cyclic] for VtxFlowCycleHelper.${methodLower} -- got meta=${JSON.stringify(meta && meta.label)} sub=${JSON.stringify(sub && sub.label)} back=${JSON.stringify(back && back.label)}.`);
      return;
    }
    if (back.cyclic !== true) {
      bug('V13-req3-' + methodLower + '-cyclic-flag', `GROUND-TRUTH.md req-3 [MUST]: the re-occurrence of ${startLabel} must carry cyclic:true -- got cyclic=${back.cyclic}.`);
      return;
    }
    if ((back.children || []).length !== 0) {
      bug('V13-req3-' + methodLower + '-hang-risk', `GROUND-TRUTH.md req-3 [MUST]: the cyclic node must have ZERO children (recursion stops the instant the ancestor-path key repeats) -- got children ${JSON.stringify((back.children || []).map((c) => c.label))}.`);
      return;
    }
    console.log(`req-3: VtxFlowCycleHelper.${methodLower} -- ${startLabel}[metadata] -> ${midLabel}[subflow] -> ${startLabel}[subflow,cyclic:true,0 children] -- OK [MUST], no hang.`);
  }
  checkCycle('pinga', 'Vtx_FlowCycleA', 'Vtx_FlowCycleB');
  checkCycle('pingb', 'Vtx_FlowCycleB', 'Vtx_FlowCycleA');

  // --- req-4: DML -> parent flow -> subflow -> subflow's apex action (callee direction) ---
  console.log('\n-- req-4: VtxFlowWidgetDmlSource.createWidget (DML -> parent flow -> subflow -> apex) --');
  const req4Tree = printTree('req-4 VtxFlowWidgetDmlSource.createWidget callees', resolver.buildCalleeTree(index, { classLower: 'vtxflowwidgetdmlsource', methodLower: 'createwidget' }, {}));
  const req4Parent = req4Tree.root.children.find((c) => c.kind === 'flow' && c.via === 'dml');
  if (!req4Parent || req4Parent.label !== 'Vtx_WidgetLifecycleFlow') {
    bug('V13-req4-parent', `GROUND-TRUTH.md req-4 [MUST]: expected Vtx_WidgetLifecycleFlow (via=dml) as createWidget's direct callee -- got ${JSON.stringify(req4Parent)}.`);
  } else {
    const req4Subflow = req4Parent.children.find((c) => c.kind === 'flow');
    if (!req4Subflow || req4Subflow.label !== 'Vtx_WidgetLifecycleNotifySubflow' || req4Subflow.via !== 'subflow' || req4Subflow.approximate !== false) {
      bug('V13-req4-subflow', `GROUND-TRUTH.md req-4 [MUST]: expected Vtx_WidgetLifecycleNotifySubflow (via=subflow, approximate:false) under Vtx_WidgetLifecycleFlow -- got ${JSON.stringify(req4Subflow)}.`);
    } else {
      const req4Apex = req4Subflow.children.find((c) => c.label === 'VtxFlowWidgetNotifier.notifyTeam');
      if (!req4Apex || req4Apex.via !== 'metadata') {
        bug('V13-req4-apextarget', `GROUND-TRUTH.md req-4 [MUST]: expected VtxFlowWidgetNotifier.notifyTeam (via=metadata) under Vtx_WidgetLifecycleNotifySubflow -- got ${JSON.stringify(req4Apex)}.`);
      } else {
        console.log('req-4: DML -> Vtx_WidgetLifecycleFlow[dml] -> Vtx_WidgetLifecycleNotifySubflow[subflow, NEW v0.13] -> notifyTeam[metadata] -- OK [MUST], full forward chain confirmed.');
      }
    }
  }

  console.log('\nGROUND-TRUTH.md "## v0.13 subflow chains" section: all [MUST] assertions checked above (flowGraph table, unknown-subflow-ref negative, req-1..4).');
}

// =======================================================================
// v0.13 hardening: H1 magnet cap, H2 rollup, H3 scoped mentions, and the
// long-identifier rendering fixture. These use the real new defaults; all
// older sections above intentionally use the flat compatibility mode.
// =======================================================================
console.log('\n\n########## v0.13 HARDENING (H1-H3 + LONG NAMES) ##########');
{
  const executionChildren = (tree) => (tree.root.children || []).filter((n) => n.kind !== 'unresolved-mentions');
  const visit = (node, out = []) => {
    out.push(node);
    for (const child of node.children || []) visit(child, out);
    return out;
  };
  const edgeKey = (node) => [node.label, node.via, node.path, node.line].join('|');

  // H1 + H3 flagship magnet: only the typed static test and LWC import are
  // real callers. The 40 noisy receiver sites remain inspectable as scoped
  // unresolved mentions, never as approximate caller edges.
  const magnetTree = buildCallerTreeRaw(
    index,
    { classLower: 'vertexbindtarget', methodLower: 'bind' },
    { showUnconfirmed: 'expand' }
  );
  const magnetEdges = executionChildren(magnetTree);
  const magnetExpected = ['VertexBindTargetTest.testBindReturnsOpInfo', 'vertexBindPanel'].sort();
  const magnetActual = magnetEdges.map((n) => n.label).sort();
  if (JSON.stringify(magnetActual) !== JSON.stringify(magnetExpected)) {
    bug('V13-H1-magnet-callers', `expected exactly ${JSON.stringify(magnetExpected)}, got ${JSON.stringify(magnetActual)}.`);
  } else if (magnetEdges.some((n) => n.approximate || n.via === 'unique-name')) {
    bug('V13-H1-magnet-confidence', `the two real callers must be confirmed static/LWC edges, got ${JSON.stringify(magnetEdges.map((n) => ({ label: n.label, via: n.via, approximate: n.approximate })))}.`);
  } else {
    console.log('  OK: H1 magnet has exactly two confirmed callers (static test + LWC), with zero unique-name edges');
  }
  if (magnetEdges.some((n) => n.kind === 'rollup')) {
    bug('V13-H2-empty-magnet-rollup', 'the magnet target has no approximate edges and must not render an empty rollup.');
  }
  const magnetMentions = (magnetTree.root.children || []).find((n) => n.kind === 'unresolved-mentions');
  const expectedMentionLabel = '40 unresolved sites elsewhere mention bind( — potential unconfirmed callers';
  if (!magnetMentions || magnetMentions.label !== expectedMentionLabel || magnetMentions.children.length !== 40) {
    bug('V13-H3-magnet-mentions', `expected ${JSON.stringify(expectedMentionLabel)} with 40 inspectable sites, got ${JSON.stringify(magnetMentions && { label: magnetMentions.label, children: magnetMentions.children.length })}.`);
  } else {
    console.log('  OK: H3 caller header exposes all 40 unresolved bind( mentions without fabricating edges');
  }
  if (index.stats.unresolvedByReason['name-too-common'] !== 30 || index.stats.magnetSuppressedAttachments !== 30) {
    bug('V13-H1-magnet-diagnostics', `expected 30 name-too-common sites and 30 suppressed attachments, got ${JSON.stringify({ unresolvedByReason: index.stats.unresolvedByReason, magnetSuppressedAttachments: index.stats.magnetSuppressedAttachments })}.`);
  } else {
    console.log('  OK: H1/H8 diagnostics report 30 cap-suppressed arity-compatible attachments');
  }

  // H1 control: two sites are below the cap, so they remain approximate
  // unique-name callers. Default mode groups them; expand exposes both.
  const controlDefault = buildCallerTreeRaw(index, { classLower: 'vertexnoticerelay', methodLower: 'relaynotice' });
  const controlDefaultEdges = executionChildren(controlDefault);
  const controlRollup = controlDefaultEdges.find((n) => n.kind === 'rollup');
  const controlMentions = (controlDefault.root.children || []).find((n) => n.kind === 'unresolved-mentions');
  const controlExpand = buildCallerTreeRaw(
    index,
    { classLower: 'vertexnoticerelay', methodLower: 'relaynotice' },
    { showUnconfirmed: 'expand' }
  );
  const controlExpandedEdges = executionChildren(controlExpand);
  if (!controlRollup || controlDefaultEdges.length !== 1 || controlRollup.children.length !== 2
      || controlExpandedEdges.length !== 2
      || controlExpandedEdges.some((n) => n.via !== 'unique-name' || n.approximate !== true)
      || controlMentions) {
    bug('V13-H1-control', `expected one default rollup containing two unique-name callers, two flat callers in expand mode, and K=0 mentions; got ${JSON.stringify({ default: controlDefaultEdges.map((n) => ({ label: n.label, kind: n.kind, children: (n.children || []).length })), expand: controlExpandedEdges.map((n) => ({ label: n.label, via: n.via, approximate: n.approximate })), mentions: Boolean(controlMentions) })}.`);
  } else {
    console.log('  OK: H1 control keeps both under-cap unique-name callers; H2 rolls them up by default; H3 omits K=0');
  }

  // H2 worked example: default=16 confirmed + one rollup, hide=16, and
  // expand=the historical flat 17. Flattening the rollup must be set-equal
  // to the expand-mode execution edges.
  const pricingTarget = { classLower: 'vertexpricingservice', methodLower: 'reprice' };
  const pricingDefault = buildCallerTreeRaw(index, pricingTarget);
  const pricingHide = buildCallerTreeRaw(index, pricingTarget, { showUnconfirmed: 'hide' });
  const pricingExpand = buildCallerTreeRaw(index, pricingTarget, { showUnconfirmed: 'expand' });
  const defaultExecution = executionChildren(pricingDefault);
  const hideExecution = executionChildren(pricingHide);
  const expandExecution = executionChildren(pricingExpand);
  const pricingRollups = defaultExecution.filter((n) => n.kind === 'rollup');
  const defaultFlattened = defaultExecution.flatMap((n) => n.kind === 'rollup' ? n.children : [n]);
  const flattenedKeys = defaultFlattened.map(edgeKey).sort();
  const expandedKeys = expandExecution.map(edgeKey).sort();
  if (defaultExecution.filter((n) => n.kind !== 'rollup').length !== 16
      || pricingRollups.length !== 1
      || pricingRollups[0].label !== '1 possible caller (unconfirmed)'
      || pricingRollups[0].children.length !== 1
      || hideExecution.length !== 16
      || expandExecution.length !== 17
      || JSON.stringify(flattenedKeys) !== JSON.stringify(expandedKeys)) {
    bug('V13-H2-pricing-rollup', `expected default 16+rollup(1), hide 16, expand 17, and exact flatten equivalence; got ${JSON.stringify({ defaultPlain: defaultExecution.filter((n) => n.kind !== 'rollup').length, rollups: pricingRollups.map((n) => ({ label: n.label, children: n.children.length })), hide: hideExecution.length, expand: expandExecution.length, flattenEqual: JSON.stringify(flattenedKeys) === JSON.stringify(expandedKeys) })}.`);
  } else {
    console.log('  OK: H2 reprice rollup preserves the exact historical edge set across rollup/hide/expand modes');
  }

  // H2/map long-name fixture: every expected 60+-character class/method
  // label resolves exactly, remains confirmed, and survives tree shaping.
  const longTree = buildCalleeTreeRaw(index, {
    classLower: 'vertexenterpriseorderfulfillmentreconciliationorchestratorservice',
    methodLower: 'reconcilefulfillmentdiscrepanciesacrossalldistributioncenters',
  }, { showUnconfirmed: 'expand', maxDepth: 12 });
  const longExpected = [
    'VertexCrossRegionInventoryAvailabilitySynchronizationCoordinator.synchronizeInventoryAvailabilitySnapshotsForDistributionRegion',
    'VertexThirdPartyLogisticsProviderIntegrationAdapterFactoryImpl.createAdapterInstanceForCarrierAccountIntegrationConfiguration',
    'VertexThirdPartyLogisticsProviderIntegrationAdapterImplementation.buildCarrierAccountIntegrationConfigurationForRegionalPartner',
  ];
  const longNodes = visit(longTree.root);
  const longResolved = longExpected.map((label) => longNodes.find((n) => n.label === label));
  const longLengthsValid = longExpected.every((label) => {
    const dot = label.indexOf('.');
    return dot >= 60 && label.length - dot - 1 >= 60;
  });
  if (!longLengthsValid || longResolved.some((n) => !n || n.approximate === true || n.truncated === true)) {
    bug('V13-H2-long-identifiers', `all three long-name edges must render in full as confirmed nodes; got ${JSON.stringify(longExpected.map((label, i) => ({ label, found: Boolean(longResolved[i]), approximate: longResolved[i] && longResolved[i].approximate, truncated: longResolved[i] && longResolved[i].truncated })))}.`);
  } else {
    console.log('  OK: all 60+-character class/method labels resolve and render in full as confirmed edges');
  }
}

// =======================================================================
// v0.14 Impact Analysis: real 266-file corpus report over the hardening
// flagship.  The exact counts are intentionally pinned here so a future
// overload-classification change cannot silently promote uncertain evidence
// into BREAKS (or lose a contract surface) while the ordinary caller tree
// still looks plausible.
// =======================================================================
console.log('\n\n########## v0.14 IMPACT ANALYSIS ##########');
{
  const compactImpact = (report) => report && ({
    target: report.target.label,
    breaks: report.breaks.map((site) => ({ caller: `${site.callerClass}.${site.callerMethod}`, line: site.line, via: site.via, pick: site.overloadPick, sig: site.overloadSig })),
    mightBreak: report.mightBreak.map((site) => ({ caller: `${site.callerClass}.${site.callerMethod}`, line: site.line, via: site.via, pick: site.overloadPick, sig: site.overloadSig })),
    interfaces: report.contract.interfaces.map((row) => ({ label: `${row.iface}.${row.overloadSig}`, callers: row.callers.map((site) => `${site.callerClass}.${site.callerMethod}`) })),
    base: report.contract.overrides.base && report.contract.overrides.base.label,
    overriddenBy: report.contract.overrides.overriddenBy.map((row) => row.label),
    callersOfBase: report.contract.overrides.callersOfBase.map((site) => `${site.callerClass}.${site.callerMethod}`),
    metadata: report.metadata.map((row) => ({ kind: row.kind, label: row.label, line: row.line, parents: row.parentFlows.map((parent) => parent.label) })),
    otherOverloads: report.otherOverloads.map((row) => ({ sig: row.overloadSig, callers: row.callerCount })),
    stats: report.stats,
  });
  const checkImpact = (id, target, expected) => {
    const report = resolver.buildImpactReport(index, target);
    const actual = compactImpact(report);
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      bug(`V14-${id}`, `GROUND-TRUTH.md '## Impact' [MUST]: full report mismatch. expected=${JSON.stringify(expected)} actual=${JSON.stringify(actual)}.`);
      return report;
    }
    const sections = uitree.shapeImpactReport(report);
    if (JSON.stringify(sections.map((section) => section.label)) !== JSON.stringify(['BREAKS', 'MIGHT BREAK', 'CONTRACT', 'METADATA', 'OTHER OVERLOADS'])) {
      bug(`V14-${id}-ui`, `expected the fixed five-section UI, got ${JSON.stringify(sections.map((section) => section.label))}.`);
    } else {
      console.log(`  OK [MUST]: ${expected.target} -- full report + five-section UI match ground truth`);
    }
    return report;
  };

  const choice = resolver.buildImpactReport(index, { classLower: 'verteximpactservice', methodLower: 'change' });
  const choiceSigs = choice && choice.availableOverloads.map((row) => row.overloadSig);
  if (!choice || choice.needsOverloadChoice !== true || JSON.stringify(choiceSigs) !== JSON.stringify(['change(String)', 'change(Integer)', 'change(Boolean)', 'change(Decimal)'])) {
    bug('V14-overload-choice', `overloaded family must require an explicit four-signature choice, got ${JSON.stringify(choice && { needsOverloadChoice: choice.needsOverloadChoice, signatures: choiceSigs })}.`);
  } else {
    console.log('  OK [MUST]: overloaded target requires explicit String/Integer/Boolean/Decimal signature selection');
  }

  checkImpact('service-string',
    { classLower: 'verteximpactservice', methodLower: 'change', overloadSig: 'change(String)' },
    {
      target: 'VertexImpactService.change(String)',
      breaks: [
        { caller: 'VertexImpactChild.change', line: 3, via: 'super', pick: 'exact', sig: 'change(String)' },
        { caller: 'VertexImpactExactCaller.changeString', line: 4, via: 'typed', pick: 'exact', sig: 'change(String)' },
      ],
      mightBreak: [
        { caller: 'VertexImpactBaseCaller.changeThroughBase', line: 3, via: 'override', pick: 'exact', sig: 'change(String)' },
        { caller: 'VertexImpactFallbackCaller.changeWithExtraContext', line: 4, via: 'typed', pick: 'fallback', sig: 'change(String)' },
        { caller: 'VertexImpactInterfaceCaller.changeThroughContract', line: 3, via: 'interface', pick: 'exact', sig: 'change(String)' },
        { caller: 'VertexImpactTieCaller.changeUnknown', line: 4, via: 'typed', pick: 'arity-tie', sig: 'change(String)' },
      ],
      interfaces: [{ label: 'VertexImpactContract.change(String)', callers: ['VertexImpactInterfaceCaller.changeThroughContract'] }],
      base: 'VertexImpactBase.change(String)',
      overriddenBy: ['VertexImpactChild.change(String)'],
      callersOfBase: ['VertexImpactBaseCaller.changeThroughBase', 'VertexImpactFallbackCaller.changeWithExtraContext'],
      metadata: [],
      otherOverloads: [
        { sig: 'change(Integer)', callers: 3 },
        { sig: 'change(Boolean)', callers: 3 },
        { sig: 'change(Decimal)', callers: 2 },
      ],
      stats: { breaks: 2, mightBreak: 4, contractSurfaces: 3, metadataSurfaces: 0, otherOverloads: 3 },
    }
  );
  checkImpact('action-flow-chain',
    { classLower: 'verteximpactaction', methodLower: 'run', overloadSig: 'run(List<String>)' },
    {
      target: 'VertexImpactAction.run(List<String>)',
      breaks: [], mightBreak: [], interfaces: [], base: null, overriddenBy: [], callersOfBase: [],
      metadata: [{ kind: 'flow', label: 'Vtx_ImpactChildFlow', line: 19, parents: ['Vtx_ImpactParentFlow'] }],
      otherOverloads: [],
      stats: { breaks: 0, mightBreak: 0, contractSurfaces: 0, metadataSurfaces: 1, otherOverloads: 0 },
    }
  );
  checkImpact('controller-metadata',
    { classLower: 'verteximpactcontroller', methodLower: 'refresh', overloadSig: 'refresh()' },
    {
      target: 'VertexImpactController.refresh()',
      breaks: [], mightBreak: [], interfaces: [], base: null, overriddenBy: [], callersOfBase: [],
      metadata: [
        { kind: 'lwc', label: 'vertexImpactPanel', line: 1, parents: [] },
        { kind: 'vf', label: 'VtxImpactPage', line: 1, parents: [] },
      ],
      otherOverloads: [],
      stats: { breaks: 0, mightBreak: 0, contractSurfaces: 0, metadataSurfaces: 2, otherOverloads: 0 },
    }
  );
  checkImpact('decimal-no-exact',
    { classLower: 'verteximpactservice', methodLower: 'change', overloadSig: 'change(Decimal)' },
    {
      target: 'VertexImpactService.change(Decimal)',
      breaks: [],
      mightBreak: [
        { caller: 'VertexImpactFallbackCaller.changeWithExtraContext', line: 4, via: 'typed', pick: 'fallback', sig: 'change(Decimal)' },
        { caller: 'VertexImpactTieCaller.changeUnknown', line: 4, via: 'typed', pick: 'arity-tie', sig: 'change(String)' },
      ],
      interfaces: [], base: null, overriddenBy: [], callersOfBase: [], metadata: [],
      otherOverloads: [
        { sig: 'change(String)', callers: 6 },
        { sig: 'change(Integer)', callers: 3 },
        { sig: 'change(Boolean)', callers: 3 },
      ],
      stats: { breaks: 0, mightBreak: 2, contractSurfaces: 0, metadataSurfaces: 0, otherOverloads: 3 },
    }
  );
  checkImpact('private-empty',
    { classLower: 'verteximpactservice', methodLower: 'unusedprivate', overloadSig: 'unusedPrivate()' },
    {
      target: 'VertexImpactService.unusedPrivate()',
      breaks: [], mightBreak: [], interfaces: [], base: null, overriddenBy: [], callersOfBase: [], metadata: [], otherOverloads: [],
      stats: { breaks: 0, mightBreak: 0, contractSurfaces: 0, metadataSurfaces: 0, otherOverloads: 0 },
    }
  );

  const impact = resolver.buildImpactReport(index, {
    classLower: 'vertexpricingservice',
    methodLower: 'reprice',
    overloadSig: 'reprice(Vertex_Order__c)',
  });
  if (!impact) {
    bug('V14-impact-missing', 'expected a report for VertexPricingService.reprice(Vertex_Order__c), got null.');
  } else {
    if (impact.breaks.length !== 18 || impact.mightBreak.length !== 1) {
      bug('V14-impact-classification', `expected 18 direct breaks and 1 uncertain site, got breaks=${impact.breaks.length} mightBreak=${impact.mightBreak.length}.`);
    } else if (impact.breaks.some((site) => site.overloadPick !== 'exact')
        || !impact.mightBreak.every((site) => site.overloadPick === 'fallback'
          || site.overloadPick === 'arity-tie'
          || site.approximate === true
          || ['interface', 'override', 'unique-name', 'ambiguous', 'lexical', 'dynamic', 'narrowed'].includes(site.via))) {
      bug('V14-impact-confidence', 'BREAKS must contain exact overload picks only; every uncertain site must carry explicit uncertainty evidence.');
    } else {
      console.log('  OK: 18 exact direct breaks and 1 uncertain site remain separated by overload confidence');
    }

    const ifaceLabels = impact.contract.interfaces.map((row) => `${row.iface}.${row.overloadSig}`);
    const childLabels = impact.contract.overrides.overriddenBy.map((row) => row.label);
    if (!ifaceLabels.includes('VertexRepriceable.reprice(Vertex_Order__c)')
        || !childLabels.includes('VertexPremiumPricingService.reprice(Vertex_Order__c)')) {
      bug('V14-impact-contract', `expected interface + child override surfaces, got interfaces=${JSON.stringify(ifaceLabels)} children=${JSON.stringify(childLabels)}.`);
    } else {
      console.log('  OK: interface and descendant-override contract surfaces are present and source-linked');
    }

    const sections = uitree.shapeImpactReport(impact);
    if (sections.length !== 5
        || JSON.stringify(sections.map((section) => section.label)) !== JSON.stringify(['BREAKS', 'MIGHT BREAK', 'CONTRACT', 'METADATA', 'OTHER OVERLOADS'])) {
      bug('V14-impact-ui', `expected the fixed five-section UI, got ${JSON.stringify(sections.map((section) => section.label))}.`);
    } else {
      console.log('  OK: five-section Impact UI shaped successfully -- ' + uitree.shapeImpactHeaderLine(impact));
    }
  }
}

// =======================================================================
// Global: index.stats.unresolvedSites sanity + parse-error-free assertion
// =======================================================================
console.log('\n\n########## GLOBAL CHECKS ##########');
{
  if (parseErrors.length > 0) {
    bug('GLOBAL-parseerrors', `${parseErrors.length} file(s) had parseError != null; GROUND-TRUTH.md states this corpus has NO deliberately-broken-syntax file, so any parse error is a genuine builder or parser-robustness defect: ${JSON.stringify(parseErrors.map((p) => path.relative(ORG_ROOT, p.path)))}`);
  } else {
    console.log('All ' + factsList.length + ' files parsed with parseError == null: OK');
  }
  console.log('Final index.stats:', JSON.stringify(index.stats));
}

// =======================================================================
// SUMMARY
// =======================================================================
console.log('\n\n########## SUMMARY ##########');
console.log('BUG count:', findings.BUG.length);
console.log('KNOWN_GAP count:', findings.KNOWN_GAP.length);
console.log('NEW_GAP count:', findings.NEW_GAP.length);
console.log('NOTE count:', findings.NOTE.length);
console.log('\nFull findings JSON:');
console.log(JSON.stringify(findings, null, 2));
if (findings.BUG.length || findings.KNOWN_GAP.length || findings.NEW_GAP.length || findings.NOTE.length) {
  process.exitCode = 1;
}

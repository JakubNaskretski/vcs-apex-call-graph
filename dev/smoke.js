'use strict';
// Smoke test / perf spike for the semantic engine against real (fictional,
// example-only) Salesforce corpora. Not part of the test suite (not required
// to be green in CI-style runs) — a manual dev tool.
//
// Usage: node dev/smoke.js [path-to-force-app]
// Defaults to /Users/agent/work/code/example-data/inz-org/force-app per the
// integrator task brief. Prints caller trees (with argsRendered) for:
//   - RawMaterialsPriceUpdateService.updateRawMaterialsPrice
//     (must surface the Batch<-Schedulable chain when tracing the Batch class)
//   - ProductTriggerService.handleBeforeUpdate (must surface the Trigger chain)
// and reports cold parse+index timing.
//
// v0.3.0 (A7): ALSO indexes the adv-org advanced corpus (Apex + metadata --
// LWC/Aura/Flow/OmniScript) at a hardcoded path (that corpus is a fixed,
// read-only fixture, unlike the CLI-overridable inz-org ROOT above) and
// prints the amendment-coverage spot checks called out in the integrator
// task brief -- see runAdvOrg() below.

const fs = require('fs');
const path = require('path');
const parser = require('../parser');
const resolver = require('../resolver');
const metascan = require('../metascan');
const uitree = require('../uitree');
const targets = require('../targets');

const ROOT = process.argv[2] || '/Users/agent/work/code/example-data/inz-org/force-app';
const SKIP_DIRS = new Set(['.sfdx', '.sf', 'node_modules', '.git']);

// adv-org corpus root and its metadata-file skip set (adds __tests__: LWC
// Jest specs under a bundle import the same '@salesforce/apex/Cls.method'
// specifier to jest.mock() it, but represent zero real Apex call edges --
// metascan.js already excludes these by path too; skipping the directory
// here just avoids reading them at all).
const ADV_ORG_ROOT = '/Users/agent/work/code/example-data/adv-org/force-app/main/default';
const ADV_ORG_SKIP_DIRS = new Set(['.sfdx', '.sf', 'node_modules', '.git', '__tests__']);
// v0.5.0 (G4): anonymous-Apex scripts live OUTSIDE force-app entirely, in
// their own top-level scripts/ dir (same shape a real sfdx-project.json-
// rooted workspace uses) -- extension.js's real glob is '**/*.apex'
// workspace-wide, so this dev tool walks this sibling root separately
// rather than teaching walkAdvOrg about a path outside ADV_ORG_ROOT.
const ADV_ORG_SCRIPTS_ROOT = '/Users/agent/work/code/example-data/adv-org/scripts';

// v0.7.0 (B1): the adv-org project root and its 2 NEW packageDirectories
// (pkg-billing, pkg-shared) -- ADV_ORG_ROOT above only ever walked
// force-app; the PACKAGE MATRIX section below needs all 3 package roots
// indexed together, with a REAL packageOf(fsPath) derived from the REAL
// sfdx-project.json (mirrors extension.js's discoverPackageMap algorithm --
// same longest-prefix-wins map, same label fallback rule -- just without
// the vscode.workspace plumbing, since this is a plain node dev tool).
const ADV_ORG_PROJECT_ROOT = '/Users/agent/work/code/example-data/adv-org';
const ADV_ORG_PKG_ROOTS = [
  path.join(ADV_ORG_PROJECT_ROOT, 'pkg-billing', 'main', 'default'),
  path.join(ADV_ORG_PROJECT_ROOT, 'pkg-shared', 'main', 'default'),
];

function buildAdvOrgPackageOf() {
  const sfdxProjectPath = path.join(ADV_ORG_PROJECT_ROOT, 'sfdx-project.json');
  let json;
  try {
    json = JSON.parse(fs.readFileSync(sfdxProjectPath, 'utf8'));
  } catch (e) {
    return () => null;
  }
  const dirs = Array.isArray(json.packageDirectories) ? json.packageDirectories : [];
  const prefixes = [];
  for (const dir of dirs) {
    if (!dir || typeof dir.path !== 'string' || !dir.path.trim()) continue;
    const relPath = dir.path.replace(/^[\\/]+/, '').replace(/[\\/]+$/, '');
    if (!relPath) continue;
    const label = typeof dir.package === 'string' && dir.package.trim() ? dir.package.trim() : relPath.split(/[\\/]/).pop();
    prefixes.push({ prefix: path.join(ADV_ORG_PROJECT_ROOT, relPath), label });
  }
  prefixes.sort((a, b) => b.prefix.length - a.prefix.length);
  return function packageOf(fsPath) {
    if (!fsPath || !prefixes.length) return null;
    for (const { prefix, label } of prefixes) {
      if (fsPath === prefix || fsPath.startsWith(prefix + path.sep)) return label;
    }
    return null;
  };
}

function walk(dir, out) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (e) {
    return;
  }
  for (const e of entries) {
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue;
      walk(path.join(dir, e.name), out);
    } else if (/\.(cls|trigger)$/i.test(e.name)) {
      out.push(path.join(dir, e.name));
    }
  }
}

// Walks ADV_ORG_ROOT once, splitting into Apex files and metadata files
// (the same file-type union metascan.js's parseMetaFile dispatches on).
function walkAdvOrg(dir, apexOut, metaOut) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (e) {
    return;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (ADV_ORG_SKIP_DIRS.has(e.name)) continue;
      walkAdvOrg(full, apexOut, metaOut);
    } else if (/\.(cls|trigger|apex)$/i.test(e.name)) {
      apexOut.push(full);
    } else if (
      /\.js$/i.test(e.name) ||
      /\.(cmp|app)$/i.test(e.name) ||
      /\.flow-meta\.xml$/i.test(e.name) ||
      /\.os-meta\.xml$/i.test(e.name) ||
      /\.json$/i.test(e.name) ||
      /\.(page|component)$/i.test(e.name) ||
      /\.md-meta\.xml$/i.test(e.name)
    ) {
      metaOut.push(full);
    }
  }
}

// Groups a flat {path,text}[] of Aura-bundle files by directory and runs
// metascan.js's parseMetaFile/scanBundle per bundle so every resulting
// MetaRef can be tagged with the exact physical file it came from --
// metascan.js's MetaRef contract deliberately has no `path` field (see its
// header comment); this mirrors extension.js's computeMetaRefs (A7) so the
// dev tool and the real extension integration agree on how meta callers get
// attached to the index.
function computeAdvOrgMetaRefs(files) {
  const refs = [];
  const auraFiles = files.filter((f) => /(^|[\\/])aura[\\/]/i.test(f.path));
  const otherFiles = files.filter((f) => !/(^|[\\/])aura[\\/]/i.test(f.path));

  for (const f of otherFiles) {
    for (const ref of metascan.parseMetaFile(f)) {
      ref.path = f.path;
      refs.push(ref);
    }
  }

  const groups = new Map(); // dir -> { markup, jsFiles: [] }
  for (const f of auraFiles) {
    const dir = path.dirname(f.path);
    let g = groups.get(dir);
    if (!g) {
      g = { markup: null, jsFiles: [] };
      groups.set(dir, g);
    }
    if (/\.(cmp|app)$/i.test(f.path)) g.markup = f;
    else if (/\.js$/i.test(f.path)) g.jsFiles.push(f);
  }
  for (const g of groups.values()) {
    if (!g.markup) continue;
    for (const ref of metascan.parseMetaFile(g.markup)) {
      ref.path = g.markup.path;
      refs.push(ref);
    }
    for (const jsFile of g.jsFiles) {
      for (const ref of metascan.scanBundle([g.markup, jsFile])) {
        if (ref.methodName == null) continue; // class-level ref, already captured above
        ref.path = jsFile.path;
        refs.push(ref);
      }
    }
  }

  return refs;
}

// v0.6.0 (H9): renders through the REAL uitree.js shaping pipeline (the
// exact same shapeResult/shapeNode/shapeSite functions extension.js hands
// to vscode.TreeItem) instead of a hand-rolled parallel renderer -- this is
// what makes smoke.js's printed output a byte-faithful preview of what the
// real product shows, so the README hero can be pasted verbatim from it
// rather than hand-illustrated (which is exactly how the pre-H9 hero drifted
// into fabricating an 'args:' row shape and a root glyph the product never
// actually rendered).
//
// A UiNode's `children` array interleaves site rows (from shapeSite, always
// iconId 'arrow-small-right', a leaf with collapsible:false) with deeper
// caller UiNodes (from shapeNode) -- iconId is the only reliable
// discriminator between the two (see shapeSite/iconForNode in uitree.js;
// iconForNode never returns 'arrow-small-right').
function renderUiNode(node, depth, lines) {
  const pad = '  '.repeat(depth);
  const badge = node.description ? '  [' + node.description + ']' : '';
  lines.push(`${pad}${node.label}${badge}`);
  for (const c of node.children || []) {
    if (c.iconId === 'arrow-small-right') {
      // Site row: siteLabel() may be two lines -- 'L<n>: <lineText>' plus,
      // when present, a second '-> overloadSig · argsRendered' line (H3).
      for (const siteLine of c.label.split('\n')) lines.push(`${pad}    ${siteLine}`);
    } else {
      renderUiNode(c, depth + 1, lines);
    }
  }
}

// v0.6.0 (H1/H4): also prints the header lines (note / capped / workspace-
// wide unresolved-sites count) exactly as shapeHeaderLines would surface
// them in the real TreeView, plus a raw nodes/unique/unresolved/capped stats
// line straight off TreeResult.stats -- so a perf/dedup regression (or a
// target that starts producing unresolved sites) is visible in every smoke
// run, not just the dedicated dev/perf-fanin.js probe.
function printTree(title, index, target) {
  const tree = resolver.buildCallerTree(index, target, { maxDepth: 8 });
  console.log('\n=== ' + title + ' ===');
  for (const line of uitree.shapeHeaderLines(tree)) console.log(line);
  const stats = tree.stats || {};
  console.log(`stats: nodes=${stats.nodes} unique=${stats.uniqueMethods} unresolved=${stats.unresolvedSites} capped=${stats.capped}`);
  const lines = [];
  for (const uiNode of uitree.shapeResult(tree)) renderUiNode(uiNode, 0, lines);
  console.log(lines.join('\n'));
  return tree;
}

// v0.7.0 (A2/B3): forward-direction counterpart to printTree -- same
// header/stats/render shape, buildCalleeTree instead of buildCallerTree.
function printCalleeTree(title, index, target) {
  const tree = resolver.buildCalleeTree(index, target, { maxDepth: 8 });
  console.log('\n=== ' + title + ' ===');
  for (const line of uitree.shapeHeaderLines(tree)) console.log(line);
  const stats = tree.stats || {};
  console.log(`stats: nodes=${stats.nodes} unique=${stats.uniqueMethods} unresolved=${stats.unresolvedSites} capped=${stats.capped} direction=${tree.direction}`);
  const lines = [];
  for (const uiNode of uitree.shapeResult(tree)) renderUiNode(uiNode, 0, lines);
  console.log(lines.join('\n'));
  return tree;
}

function main() {
  console.log('Indexing: ' + ROOT);
  const filePaths = [];
  walk(ROOT, filePaths);
  console.log(`Found ${filePaths.length} .cls/.trigger file(s).`);

  const t0 = Date.now();
  const factsList = filePaths.map((p) => parser.parseFile({ path: p, text: fs.readFileSync(p, 'utf8') }));
  const t1 = Date.now();
  const index = resolver.buildSemanticIndex(factsList);
  const t2 = Date.now();

  const parseMs = t1 - t0;
  const indexMs = t2 - t1;
  const totalMs = t2 - t0;

  const errCount = factsList.filter((f) => f.parseError).length;
  console.log(`Parse: ${parseMs}ms, Index: ${indexMs}ms, Total cold: ${totalMs}ms`);
  console.log(`Parse errors: ${errCount}/${factsList.length}`);
  if (index.duplicates.length) console.log('Duplicates: ' + index.duplicates.join(', '));

  printTree(
    'RawMaterialsPriceUpdateService.updateRawMaterialsPrice',
    index,
    { classLower: 'rawmaterialspriceupdateservice', methodLower: 'updaterawmaterialsprice' }
  );

  // Class-level trace on the Batch itself: this is where the Schedulable ->
  // Batch 'new' edge (Database.executeBatch(new RawMaterialsPriceUpdateBatch()))
  // surfaces, since nothing calls .execute() directly (it's a Batchable
  // entry point invoked by the platform, not user code).
  printTree(
    'RawMaterialsPriceUpdateBatch (class-level, shows Schedulable<-Batch chain)',
    index,
    { classLower: 'rawmaterialspriceupdatebatch', methodLower: null }
  );

  printTree(
    'ProductTriggerService.handleBeforeUpdate',
    index,
    { classLower: 'producttriggerservice', methodLower: 'handlebeforeupdate' }
  );
}

// v0.3.0 (A7): adv-org corpus -- Apex + metadata (LWC/Aura/Flow/OmniScript),
// exercising every amendment (A1-A6) end-to-end against the real ground-
// truth fixture (see /Users/agent/work/code/example-data/adv-org/MANIFEST.md).
function runAdvOrg() {
  console.log('\n\n########################################################');
  console.log('# adv-org (Apex + metadata)');
  console.log('########################################################');
  console.log('Indexing: ' + ADV_ORG_ROOT);

  const apexPaths = [];
  const metaPaths = [];
  walkAdvOrg(ADV_ORG_ROOT, apexPaths, metaPaths);
  // v0.5.0 (G4): pick up scripts/*.apex from the sibling root too, same
  // apexOut array -- parser.parseFile routes .apex paths to
  // parser.anonymousUnit() regardless of which directory they came from.
  let anonScriptCount = 0;
  try {
    for (const name of fs.readdirSync(ADV_ORG_SCRIPTS_ROOT)) {
      if (/\.apex$/i.test(name)) {
        apexPaths.push(path.join(ADV_ORG_SCRIPTS_ROOT, name));
        anonScriptCount++;
      }
    }
  } catch (e) {
    // scripts/ dir optional -- older corpus snapshots may not have it yet.
  }
  console.log(`Found ${apexPaths.length} .cls/.trigger/.apex file(s) (${anonScriptCount} anonymous script(s)), ${metaPaths.length} metadata file(s).`);

  const t0 = Date.now();
  const factsList = apexPaths.map((p) => parser.parseFile({ path: p, text: fs.readFileSync(p, 'utf8') }));
  const index = resolver.buildSemanticIndex(factsList);
  const t1 = Date.now();

  const metaFiles = metaPaths.map((p) => ({ path: p, text: fs.readFileSync(p, 'utf8') }));
  const metaRefs = computeAdvOrgMetaRefs(metaFiles);
  resolver.attachMetaCallers(index, metaRefs);
  const t2 = Date.now();

  const errCount = factsList.filter((f) => f.parseError).length;
  console.log(`Apex parse+index: ${t1 - t0}ms (perf bar: < 3000ms). Metascan: ${t2 - t1}ms (perf bar: < 300ms).`);
  console.log(`Parse errors: ${errCount}/${factsList.length} (expect exactly 1: AcmeBrokenParser.cls).`);
  console.log(`Metadata refs extracted: ${metaRefs.length}.`);
  if (index.duplicates.length) console.log('Duplicates: ' + index.duplicates.join(', '));

  // --- A1/A2: property accessor edges ------------------------------------
  printTree(
    "AcmeQuote.(set Status) -- A1/A2 property accessor edges",
    index,
    { classLower: 'acmequote', methodLower: '(set status)' }
  );

  // --- A4: overload signatures --------------------------------------------
  // overloadSig is printed inline on each site line above (see renderTree);
  // AcmePricingEngine.calculatePrice has 4 same-arity overloads
  // (String/Integer/Acme_Order__c/AcmeQuote) that collapse onto one
  // 'class#method' key -- overloadSig is what tells each call site apart.
  printTree(
    'AcmePricingEngine.calculatePrice -- A4 overload signatures (see overloadSig per site)',
    index,
    { classLower: 'acmepricingengine', methodLower: 'calculateprice' }
  );

  // --- A3(c): chained receiver ---------------------------------------------
  printTree(
    'AcmeQuoteBuilder.build -- A3(c) chained receiver (builder.withCustomer(...).build())',
    index,
    { classLower: 'acmequotebuilder', methodLower: 'build' }
  );

  // --- A5/A6: metadata callers ----------------------------------------------
  // AcmeBackorderResolutionFlow's <actionCalls> references the bare class
  // name (Flow XML never names the method -- see MANIFEST.md's note on this
  // edge), so the Flow caller is a CLASS-level metadata ref and only
  // surfaces on a class-level trace, not a method-level 'execute' trace.
  printTree(
    'AcmeOrderInvocable.execute -- method-level (Apex-only caller)',
    index,
    { classLower: 'acmeorderinvocable', methodLower: 'execute' }
  );
  printTree(
    'AcmeOrderInvocable (class-level -- MUST show the AcmeBackorderResolutionFlow apex-action caller)',
    index,
    { classLower: 'acmeorderinvocable', methodLower: null }
  );

  // one LWC-called controller method
  printTree(
    'AcmeQuoteAuraService.getRecentQuotes -- one LWC-called controller method (acmeOrderDashboard wire)',
    index,
    { classLower: 'acmequoteauraservice', methodLower: 'getrecentquotes' }
  );

  // one OmniScript-called method
  printTree(
    'AcmeShipmentService.scheduleDelivery -- one OmniScript-called method (AcmeOrderIntegrationProcedure_DataPack)',
    index,
    { classLower: 'acmeshipmentservice', methodLower: 'scheduledelivery' }
  );

  // --- v0.4.0 transaction story: F1 DML -> trigger, several hops deep ------
  // Tracing callers of AcmeShipmentTrigger's own '(trigger)' pseudo-method
  // surfaces the full F1 DML->trigger transaction story in one tree:
  //   - AcmeShipmentService.scheduleDelivery -> AcmeShipmentTrigger [via=dml,
  //     op=update] (a v0.3 call site newly exposed by F1, per MANIFEST.md).
  //   - AcmeShipmentRollupHandler.rollupTotals -> AcmeShipmentTrigger
  //     [via=dml, op=update], itself called by AcmeShipmentTriggerHandler
  //     .handle, itself called by... AcmeShipmentTrigger again -- closing
  //     the "handler does DML on its own object" cycle (must print CYCLE).
  printTree(
    'AcmeShipmentTrigger (trigger-level) -- v0.4.0 transaction story: F1 DML->trigger linkage + DML-induced cycle',
    index,
    { classLower: 'acmeshipmenttrigger', methodLower: '(trigger)' }
  );

  // ===================================================================
  // v0.5.0 stories -- see MANIFEST.md's "v0.5 ground-truth edges" section
  // for the full node-by-node ground truth each of these is checked
  // against.
  // ===================================================================

  // --- G2: EXCEPTION STORY -- throw deep in a service, callers up the
  // chain with all four catch-depth scenarios (exact/supertype/bare
  // catches, badged caughtHere, plus one uncaught path to an @isTest
  // entry), AND the async-hop ancestors G5 stacks onto the exact-type
  // catcher (AcmeOrderBatchProcessor.execute). Tracing the exception CLASS
  // itself (no methodLower) surfaces both v0.5/G2 throw sites as
  // root-level via='throws' children.
  printTree(
    'AcmeValidationException (class-level) -- v0.5.0 EXCEPTION STORY: G2 throw/catch tracing (4 catch-depth scenarios) + G5 async ancestors stacked on the exact-type catcher',
    index,
    { classLower: 'acmevalidationexception', methodLower: null }
  );

  // --- G1: PUBLISH STORY -- EventBus.publish (both single-record and
  // List<X__e> collection forms) -> platform-event trigger (G1(a)); flow
  // reachability is checked below via the shared AcmeOrderInvocable target.
  printTree(
    'AcmeNoteEventTrigger (trigger-level) -- v0.5.0 PUBLISH STORY: G1(a) EventBus.publish -> platform-event trigger linkage (both call-site shapes)',
    index,
    { classLower: 'acmenoteeventtrigger', methodLower: null }
  );
  // Same AcmeOrderInvocable target as the pre-existing A5/A6 class-level
  // trace above -- v0.5 additionally surfaces AcmeNoteEventFlow (G1(b):
  // platform-event flow -> publish children) alongside the pre-existing
  // AcmeBackorderResolutionFlow/AcmeOrderCreatedWelcomeFlow callers.
  printTree(
    'AcmeOrderInvocable (class-level) -- v0.5.0 PUBLISH STORY continued: G1(b) platform-event flow (AcmeNoteEventFlow) now carries publish-site children',
    index,
    { classLower: 'acmeorderinvocable', methodLower: null }
  );

  // --- G3: instanceof narrowing (labeled fallback only) -- positive (must
  // fall back to the narrowed type) and negative (declared-type resolution
  // already succeeds, narrowing must NOT be consulted) twins.
  printTree(
    'AcmeShapeConcrete.crateLabel -- v0.5.0 G3 instanceof-narrowing fallback (positive: declared type AcmeShapeBase lacks crateLabel())',
    index,
    { classLower: 'acmeshapeconcrete', methodLower: 'cratelabel' }
  );
  printTree(
    'AcmeShapeBase.describeShape -- v0.5.0 G3 instanceof-narrowing negative twin (declared-type resolution already succeeds -- narrowing must NOT be consulted)',
    index,
    { classLower: 'acmeshapebase', methodLower: 'describeshape' }
  );

  // --- G4: anonymous Apex -- scripts/adhoc-recalc.apex is a pure root with
  // two static-call edges and one DML->trigger edge (composing G4 with the
  // pre-existing v0.4 F1 DML->trigger machinery). Traced from the callee
  // side since the script itself has no callers to show on its own tree.
  printTree(
    'AcmeOrderService.recalculatePricing -- v0.5.0 G4 anonymous Apex: scripts/adhoc-recalc.apex#(anonymous) as a static-call root',
    index,
    { classLower: 'acmeorderservice', methodLower: 'recalculatepricing' }
  );
  printTree(
    'AcmeOrderTrigger (trigger-level) -- v0.5.0 G4 anonymous Apex composed with F1: adhoc-recalc.apex#(anonymous)\'s "update openOrders;" -> AcmeOrderTrigger',
    index,
    { classLower: 'acmeordertrigger', methodLower: null }
  );

  // --- G5: async-hop edges -- System.enqueueJob/Database.executeBatch/
  // System.schedule call sites with an inline 'new KnownClass(...)' arg get
  // an additional via='async' edge to that class's execute() method, in
  // ADDITION to the ordinary via='new' constructor edge from the same
  // call site.
  printTree(
    'AcmeOrderBatchProcessor.execute (class-level) -- v0.5.0 G5 async-hop edges: 3 async ancestors converge here (processOrders, scheduler, orchestrator)',
    index,
    { classLower: 'acmeorderbatchprocessor', methodLower: 'execute' }
  );
  printTree(
    'AcmeAsyncOrchestrator.runNightlyMaintenance -- v0.5.0 G5: pure root exercising all three async entry points in one method',
    index,
    { classLower: 'acmeasyncorchestrator', methodLower: 'runnightlymaintenance' }
  );

  // --- G6: interface-extends-interface fan-out -- AcmePingPongHandler is
  // reachable from an AcmeParentIntf-typed caller ONLY through the
  // AcmeChildIntf-extends-AcmeParentIntf transitive closure; AcmeDirect
  // PingHandler is the already-resolves-today direct-implementer control.
  printTree(
    'AcmePingPongHandler.ping -- v0.5.0 G6 interface-extends-interface fan-out (reachable only via the AcmeChildIntf transitive closure)',
    index,
    { classLower: 'acmepingponghandler', methodLower: 'ping' }
  );
  printTree(
    'AcmeDirectPingHandler.ping -- v0.5.0 G6 control case (direct implementer, already resolves-today)',
    index,
    { classLower: 'acmedirectpinghandler', methodLower: 'ping' }
  );

  // ===================================================================
  // v0.7.0 FORWARD STORY -- Feature A (forward tracing / buildCalleeTree)
  // against the real adv-org corpus. See MANIFEST.md's "Feature A --
  // Forward tracing ground truth" A1/A2/A3 chains for the full node-by-
  // node ground truth each of these is checked against. Uses the SAME
  // `index` as every printTree() call above (force-app + scripts only,
  // no packageOf) -- Feature A is orthogonal to Feature B.
  // ===================================================================
  console.log('\n\n########################################################');
  console.log('# v0.7.0 FORWARD STORY (Feature A -- buildCalleeTree)');
  console.log('########################################################');

  // --- A1: the full forward transaction story, 3 hops deep -- controller
  // -> service -> util (markApproved), whose DML fans out to BOTH the
  // matching trigger AND the matching record-triggered flow, with the
  // @future email notifier as a sibling third child.
  printCalleeTree(
    'AcmeOrderApprovalController.approveOrder -- A1 forward transaction story, hop 1/3 (controller -> service)',
    index,
    { classLower: 'acmeorderapprovalcontroller', methodLower: 'approveorder' }
  );
  printCalleeTree(
    'AcmeOrderService.approveOrder -- A1 forward transaction story, hop 2/3 (service -> util)',
    index,
    { classLower: 'acmeorderservice', methodLower: 'approveorder' }
  );
  printCalleeTree(
    'AcmeOrderUtil.markApproved -- A1 forward transaction story, hop 3/3: DML fans out to trigger + flow, plus the @future sibling',
    index,
    { classLower: 'acmeorderutil', methodLower: 'markapproved' }
  );

  // --- A2: async-forward -- one orchestrator method reaching all 3 async
  // entry points, each collapsing to a single via='async' child (no
  // separate '<init>' child for the inline 'new AcmeXxx(...)' argument).
  printCalleeTree(
    'AcmeAsyncOrchestrator.runNightlyMaintenance -- A2 async-forward: 3 via=async children, G5 forward-collapse (no separate <init> children)',
    index,
    { classLower: 'acmeasyncorchestrator', methodLower: 'runnightlymaintenance' }
  );

  // --- A3: throw-forward -- a terminal, non-approximate 'exception' node
  // (see this round's resolver.js reconciliation: via='throws' is not in
  // APPROX_VIA, so this node's approximate flag is now computed, not
  // hardcoded true), alongside an ordinary second child (delegation call).
  printCalleeTree(
    'AcmeOrderValidator.validate(Id,Integer) -- A3 throw-forward: terminal exception node (via=throws, NOT approximate) + ordinary delegation child',
    index,
    { classLower: 'acmeordervalidator', methodLower: 'validate' }
  );

  // --- A4: publish-forward -- EventBus.publish -> platform-event trigger +
  // PE-triggered flow, mirroring A1's trigger+flow pairing for a publish
  // site instead of a DML site.
  printCalleeTree(
    'AcmeNoteEventPublisher.publishNote -- A4 publish-forward: EventBus.publish -> trigger + PE flow',
    index,
    { classLower: 'acmenoteeventpublisher', methodLower: 'publishnote' }
  );

  // --- A5: interface-forward fan-out -- the call site collapses onto the
  // INTERFACE method node; that node's OWN forward children fan out to
  // every implementer.
  printCalleeTree(
    'AcmeNotificationDispatcher.dispatchToAll -- A5 interface-forward: the call site collapses onto AcmeNotifiable.notify',
    index,
    { classLower: 'acmenotificationdispatcher', methodLower: 'dispatchtoall' }
  );
  printCalleeTree(
    'AcmeNotifiable.notify -- A5 interface-forward continued: fans out to all 3 implementers (including AcmeSlackNotifier, attributed through inherited AcmeBaseNotifier.notify)',
    index,
    { classLower: 'acmenotifiable', methodLower: 'notify' }
  );

  // --- A6: unresolved-leaf aggregation -- every platform dot-call in this
  // method collapses into ONE 'N unresolved sites' leaf.
  printCalleeTree(
    'AcmeSmsNotifier.sendSms -- A6 unresolved-forward aggregation: 5 platform calls collapse into ONE leaf',
    index,
    { classLower: 'acmesmsnotifier', methodLower: 'sendsms' }
  );

  // --- bonus chain #12: a '(trigger)' node is NOT terminal forward --
  // tracing continues into its handler exactly like any other method.
  printCalleeTree(
    'AcmeOrderTrigger (trigger-level) -- bonus chain #12: a (trigger) node is NOT terminal forward, unlike a flow node',
    index,
    { classLower: 'acmeordertrigger', methodLower: null }
  );

  // ===================================================================
  // v0.7.0 PACKAGE MATRIX -- Feature B (multi-package awareness) against
  // the real adv-org corpus, now including pkg-billing/pkg-shared and a
  // REAL packageOf(fsPath) derived from sfdx-project.json. See MANIFEST
  // .md's "Feature B -- Multi-package awareness ground truth (package
  // matrix)" B1-B4 for the full ground truth. Built as its OWN index
  // (force-app + pkg-billing + pkg-shared + scripts, WITH packageOf) --
  // deliberately separate from the packageOf-less `index` used everywhere
  // above, so this section can never perturb any pre-v0.7 printTree() call.
  // ===================================================================
  console.log('\n\n########################################################');
  console.log('# v0.7.0 PACKAGE MATRIX (Feature B -- multi-package awareness)');
  console.log('########################################################');

  const pkgApexPaths = apexPaths.slice(); // force-app + scripts, already walked above
  for (const pkgRoot of ADV_ORG_PKG_ROOTS) walkAdvOrg(pkgRoot, pkgApexPaths, []);
  console.log(`Package-aware corpus: ${pkgApexPaths.length} .cls/.trigger/.apex file(s) (force-app + pkg-billing + pkg-shared + scripts).`);

  const pkgFactsList = pkgApexPaths.map((p) => parser.parseFile({ path: p, text: fs.readFileSync(p, 'utf8') }));
  const packageOf = buildAdvOrgPackageOf();
  const pkgIndex = resolver.buildSemanticIndex(pkgFactsList, { packageOf, defaultPackage: 'force-app' });

  console.log(`stats.duplicateNames: ${pkgIndex.stats.duplicateNames} (MANIFEST bar: 2 -- AcmeOrderUtil force-app+pkg-billing, NovaBillingUtil pkg-billing+pkg-shared)`);
  console.log(`index.duplicates: ${pkgIndex.duplicates.join(', ')}`);

  // MUST-FIX #1: reach every duplicate-class candidate through the REAL
  // public QuickPick flow -- resolver.suggestTargets(index) ->
  // targets.refineTargets(...) -- exactly what extension.js's
  // buildSuggestPicks -> resolveTarget does, instead of reaching into the
  // non-exported index.classBuckets map directly (the old approach here
  // bypassed suggestTargets()/refineTargets() entirely and could never have
  // caught suggestTargets() handing out the wrong classLower for a
  // duplicate-name candidate -- see MUST-FIX #1's own header note in
  // resolver.js's suggestTargets()).
  const pkgPicks = targets.refineTargets(resolver.suggestTargets(pkgIndex));
  const findPick = (labelRe, methodLower, pkgLabel) =>
    pkgPicks.find((p) => p.methodLower === methodLower && p.package === pkgLabel && labelRe.test(p.label));
  const forceAppOrderUtil = { classLower: (findPick(/^AcmeOrderUtil\b/, null, 'force-app') || {}).classLower };
  const billingOrderUtil = { classLower: (findPick(/AcmeOrderUtil/i, 'reconcilebillingstatus', 'nova-billing') || {}).classLower };
  const billingBillingUtil = { classLower: (findPick(/NovaBillingUtil/i, 'auditpricingsync', 'nova-billing') || {}).classLower };
  const sharedBillingUtil = { classLower: (findPick(/NovaBillingUtil/i, 'auditpricingsync', 'nova-shared') || {}).classLower };
  console.log(`suggestTargets/refineTargets duplicate picks resolved: AcmeOrderUtil(force-app)=${JSON.stringify(forceAppOrderUtil.classLower)}, AcmeOrderUtil(nova-billing)=${JSON.stringify(billingOrderUtil.classLower)}, NovaBillingUtil(nova-billing)=${JSON.stringify(billingBillingUtil.classLower)}, NovaBillingUtil(nova-shared)=${JSON.stringify(sharedBillingUtil.classLower)}`);

  // --- B1: same-package preference (2 edges) --------------------------
  printTree(
    'AcmeOrderUtil.reconcileBillingStatus (pkg-billing candidate) -- B1 same-package preference: NovaPaymentProcessor (pkg-billing) resolves HERE, not to force-app',
    pkgIndex,
    { classLower: billingOrderUtil.classLower, methodLower: 'reconcilebillingstatus' }
  );
  printTree(
    'AcmeOrderUtil.normalize (force-app candidate) -- B1 regression-safety half: the pre-existing v0.3 force-app->force-app edge keeps resolving via the SAME rule 1',
    pkgIndex,
    { classLower: forceAppOrderUtil.classLower, methodLower: 'normalize' }
  );

  // --- B2: default-package fallback (1 edge) ---------------------------
  printTree(
    'AcmeOrderUtil.buildQuery (force-app/default candidate) -- B2 default-package fallback: NovaSharedBillingBridge (pkg-shared, no AcmeOrderUtil of its own) falls through to the DEFAULT package',
    pkgIndex,
    { classLower: forceAppOrderUtil.classLower, methodLower: 'buildquery' }
  );

  // --- B3: ambiguous fan-out (1 call site -> 2 edges) -------------------
  printTree(
    'NovaBillingUtil.auditPricingSync (pkg-billing candidate) -- B3 ambiguous fan-out, edge 1/2: AcmeOrderRestResource.handleGet (force-app) fans out to BOTH candidates',
    pkgIndex,
    { classLower: billingBillingUtil.classLower, methodLower: 'auditpricingsync' }
  );
  printTree(
    'NovaBillingUtil.auditPricingSync (pkg-shared candidate) -- B3 ambiguous fan-out, edge 2/2: the SAME call site, second candidate',
    pkgIndex,
    { classLower: sharedBillingUtil.classLower, methodLower: 'auditpricingsync' }
  );

  // --- B4: cross-package badges, forward direction ----------------------
  // Case 1: AcmeOrderBatchProcessor.finish (force-app) -> NovaBillingService
  // .recordBatchCompletion (nova-billing) -- badge on the child.
  printCalleeTree(
    'AcmeOrderBatchProcessor.finish -- B4 case 1: forward child NovaBillingService.recordBatchCompletion carries badge (nova-billing)',
    pkgIndex,
    { classLower: 'acmeorderbatchprocessor', methodLower: 'finish' }
  );
  // Case 4: NovaSharedBillingBridge.syncSharedQuery (nova-shared) ->
  // AcmeOrderUtil.buildQuery (force-app, the DEFAULT package) -- badge
  // applies uniformly, even against the default package.
  printCalleeTree(
    'NovaSharedBillingBridge.syncSharedQuery -- B4 case 4: forward child AcmeOrderUtil.buildQuery carries badge (force-app), badges apply even against the default package',
    pkgIndex,
    { classLower: 'novasharedbillingbridge', methodLower: 'syncsharedquery' }
  );
  // Case 2: AcmeOrderService.recalculatePricing (force-app) callers --
  // the new v0.7 NovaBillingService.generateInvoice caller carries badge
  // (nova-billing), while the pre-existing force-app caller carries none.
  printTree(
    'AcmeOrderService.recalculatePricing -- B4 case 2: caller NovaBillingService.generateInvoice carries badge (nova-billing); pre-existing force-app caller AcmeOrderRestResource.handleGet carries none',
    pkgIndex,
    { classLower: 'acmeorderservice', methodLower: 'recalculatepricing' }
  );

  // --- B5: packageless-identity note -- a SEPARATE index over the SAME
  // pkgFactsList with NO opts at all must reproduce first-wins-drop
  // behavior exactly (byte-identical to pre-v0.7).
  const pkgIndexNoOpts = resolver.buildSemanticIndex(pkgFactsList);
  console.log(`\nB5 packageless-identity check: stats.duplicateNames=${pkgIndexNoOpts.stats.duplicateNames} (bar: 0, no opts -> first-wins-drop, byte-identical to pre-v0.7)`);
}

main();
runAdvOrg();

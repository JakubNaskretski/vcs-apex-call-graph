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
}

main();
runAdvOrg();

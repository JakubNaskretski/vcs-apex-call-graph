'use strict';
// Render caller trees EXACTLY as the shipping VS Code UI shows them, by using
// the real uitree.shapeResult (the same pure shaper extension.js feeds to
// vscode.TreeItem). For each call SITE I also print, in <angle brackets>, the
// data that is NOT visible inline in the tree: argsRendered (tooltip-only) and
// overloadSig (dropped by every renderer) -- so the critique can judge
// visible-vs-hidden information. No vscode needed.
const fs = require('fs');
const path = require('path');
const parser = require('../parser');
const resolver = require('../resolver');
const metascan = require('../metascan');
const { shapeResult } = require('../uitree');

const SKIP = new Set(['.sfdx', '.sf', 'node_modules', '.git']);
const METASKIP = new Set(['.sfdx', '.sf', 'node_modules', '.git', '__tests__']);
function walk(dir, out, re) { let es; try { es = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; } for (const e of es) { const full = path.join(dir, e.name); if (e.isDirectory()) { if (!SKIP.has(e.name)) walk(full, out, re); } else if (re.test(e.name)) out.push(full); } }
function walkMeta(dir, out) { let es; try { es = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; } for (const e of es) { const full = path.join(dir, e.name); if (e.isDirectory()) { if (!METASKIP.has(e.name)) walkMeta(full, out); } else if (/\.(js|cmp|app|flow-meta\.xml|os-meta\.xml|json|page|component|md-meta\.xml)$/i.test(e.name)) out.push(full); } }
function computeMetaRefs(files) { const refs = []; const aura = files.filter(f => /(^|[\\/])aura[\\/]/i.test(f.path)); const other = files.filter(f => !/(^|[\\/])aura[\\/]/i.test(f.path)); for (const f of other) for (const r of metascan.parseMetaFile(f)) { r.path = f.path; refs.push(r); } const groups = new Map(); for (const f of aura) { const d = path.dirname(f.path); let g = groups.get(d); if (!g) { g = { markup: null, js: [] }; groups.set(d, g); } if (/\.(cmp|app)$/i.test(f.path)) g.markup = f; else if (/\.js$/i.test(f.path)) g.js.push(f); } for (const g of groups.values()) { if (!g.markup) continue; for (const r of metascan.parseMetaFile(g.markup)) { r.path = g.markup.path; refs.push(r); } for (const jf of g.js) for (const r of metascan.scanBundle([g.markup, jf])) { if (r.methodName == null) continue; r.path = jf.path; refs.push(r); } } return refs; }

function buildIndex(root, scripts) {
  const apex = []; walk(root, apex, /\.(cls|trigger)$/i); if (scripts) walk(scripts, apex, /\.apex$/i);
  const facts = apex.map(p => parser.parseFile({ path: p, text: fs.readFileSync(p, 'utf8') }));
  const index = resolver.buildSemanticIndex(facts);
  const mp = []; walkMeta(root, mp);
  resolver.attachMetaCallers(index, computeMetaRefs(mp.map(p => ({ path: p, text: fs.readFileSync(p, 'utf8') }))));
  return index;
}

// Render a UiNode subtree the way the tree widget stacks label + description.
// A UiNode's children are: site-nodes (label 'L..: ..', description=via) then
// caller-nodes. I re-derive the hidden site data from the ORIGINAL TNode in
// parallel so I can show argsRendered/overloadSig contrast.
function renderUi(ui, depth, lines) {
  const pad = '  '.repeat(depth);
  const desc = ui.description ? '   « ' + ui.description + ' »' : '';
  lines.push(pad + ui.label + desc);
  for (const c of ui.children || []) renderUi(c, depth + 1, lines);
}

// Parallel walk of the raw TNode tree to expose hidden site fields.
function rawSites(node, depth, lines) {
  const pad = '  '.repeat(depth);
  for (const s of node.sites || []) {
    const hidden = [];
    hidden.push('args=' + (s.argsRendered == null ? '(none)' : s.argsRendered));
    if (s.overloadSig) hidden.push('overloadSig=' + s.overloadSig);
    lines.push(pad + '  site L' + s.line + ' [' + s.via + ']  HIDDEN{ ' + hidden.join(' ; ') + ' }');
  }
  for (const c of node.children || []) rawSites(c, depth + 1, lines);
}

function trace(index, label, classLower, methodLower) {
  const tree = resolver.buildCallerTree(index, { classLower, methodLower }, { maxDepth: 8 });
  console.log('\n\n=========================================================');
  console.log('TARGET: ' + label);
  console.log('targetLabel=' + JSON.stringify(tree.targetLabel) + '  note=' + JSON.stringify(tree.note));
  const ui = shapeResult(tree);
  const lines = [];
  if (!ui.length) { console.log('(shapeResult returned [] -> tree view shows NOTHING)'); }
  for (const r of ui) renderUi(r, 0, lines);
  console.log('--- AS THE TREE RENDERS (label  « badges ») ---');
  console.log(lines.join('\n'));
  const hl = [];
  rawSites(tree.root, 0, hl);
  if (hl.length) { console.log('--- PER-SITE DATA NOT SHOWN INLINE (tooltip-only args + dropped overloadSig) ---'); console.log(hl.join('\n')); }
}

const adv = buildIndex('/Users/agent/work/code/example-data/adv-org/force-app/main/default', '/Users/agent/work/code/example-data/adv-org/scripts');

// adv-org — Batch<-Schedulable chain / trigger-service chain
trace(adv, 'adv: AcmeOrderBatchProcessor.execute (method-level, Schedulable<-Batch chain)', 'acmeorderbatchprocessor', 'execute');
trace(adv, 'adv: AcmeOrderTriggerHandler.handle (trigger chain)', 'acmeordertriggerhandler', 'handle');

// adv-org — overloads (overloadSig visibility)
trace(adv, 'adv: AcmePricingEngine.calculatePrice (4 overloads)', 'acmepricingengine', 'calculateprice');
// exception story
trace(adv, 'adv: AcmeValidationException (class, exception story)', 'acmevalidationexception', null);
// big fan-out / overwhelming
trace(adv, 'adv: AcmeQuote (class, fan-out 13)', 'acmequote', null);
// metadata callers
trace(adv, 'adv: AcmeOrderInvocable (class, metadata callers)', 'acmeorderinvocable', null);
// LWC
trace(adv, 'adv: AcmeQuoteAuraService.getRecentQuotes (LWC wire)', 'acmequoteauraservice', 'getrecentquotes');
// interface fan-out (approximate)
trace(adv, 'adv: AcmePingPongHandler.ping (interface-extends-interface, ~approx)', 'acmepingponghandler', 'ping');
// async convergence
trace(adv, 'adv: AcmeOrderBatchProcessor.execute (async hops)', 'acmeorderbatchprocessor', 'execute');

// ===== FAILURE / EDGE EXPERIENCES =====
// dead code (zero callers) — what does the UI show?
trace(adv, 'adv: AcmeFulfillmentDmlService (ZERO callers — dead code / or entry?)', 'acmefulfillmentdmlservice', null);
// a "pure root" entry point (also zero callers, but semantically the TOP)
trace(adv, 'adv: AcmeAsyncOrchestrator.runNightlyMaintenance (pure root entry, zero callers)', 'acmeasyncorchestrator', 'runnightlymaintenance');
// platform call: simulate cursor on Database.insert -> "database" not a class
trace(adv, 'adv: SIMULATED cursor on platform call (classLower=database, not in index)', 'database', 'insert');

// empty index
console.log('\n\n========== EMPTY WORKSPACE (0 apex files) ==========');
const empty = resolver.buildSemanticIndex([]);
console.log('suggestTargets(emptyIndex) length = ' + resolver.suggestTargets(empty).length);
const et = resolver.buildCallerTree(empty, { classLower: 'anything', methodLower: null }, { maxDepth: 8 });
console.log('buildCallerTree on empty -> note=' + JSON.stringify(et.note) + ', shapeResult len=' + shapeResult(et).length);

'use strict';
// Dev preview for pathmap.js: runs the REAL parser.js/resolver.js/metascan.js
// engine over a real (fictional-org, example-only) Salesforce corpus, builds
// the caller tree for a target, renders it with pathmap.js, and writes the
// result to dev/pathmap-preview.html so it can be opened directly in a
// browser (no vscode/webview needed — this is exactly why pathmap.js has no
// vscode dependency).
//
// Usage: node dev/pathmap-preview.js [path-to-force-app-main-default]
// v0.8.0: defaults to the gauntlet-org corpus, targeting
// VertexLedgerBridge.postToLedger in the FORWARD (callees) direction --
// GROUND-TRUTH.md's v0.8-A1 story: the local Billing.charge edge stays
// exactly as it was pre-v0.8, PLUS two brand-new EXTERNAL (managed-package)
// terminal leaves appear as siblings -- zenq.Billing (method call) and
// kwx__Ledger__c (DML object) -- so this is the richest single-node forward
// shape demonstrating kind='external' rendering (N6: distinct accent,
// 'managed: <ns>' badge, glossary entry) in the map. opts.ownNamespace is
// wired from gauntlet-org's own sfdx-project.json (namespace 'vtx'),
// mirroring extension.js's real discoverPackageMap plumbing, so this preview
// also proves N3 stripping doesn't accidentally touch this trace (none of
// its 3 callee children carry ns='vtx').
// (Prior versions of this preview targeted, in order: AcmeValidationException
// in the reverse/callers direction -- the v0.5.0 "EXCEPTION STORY" -- then
// AcmeOrderUtil.markApproved forward on adv-org for v0.7.0's trigger+flow+
// async fan-out story. Both renders are still fully exercised by
// test-pathmap.js's own self-check, which is the actual required-green gate
// for pathmap.js -- this dev tool just previews whichever single shape is
// most illustrative for the CURRENT round, and is free to move.)
// metascan.js only runs when ROOT looks like an SFDX force-app default dir
// (has lwc/aura/flows/omniscripts siblings) — an inz-org-style override
// still works Apex-only, same as before.
//
// Not part of the test suite (test-pathmap.js is the self-check that must
// stay green) — this is a manual, human-eyeball dev tool.

const fs = require('fs');
const path = require('path');
const parser = require('../parser');
const resolver = require('../resolver');
const metascan = require('../metascan');
const { renderPathMapHtml } = require('../pathmap');

const ROOT = process.argv[2] || '/Users/agent/work/code/example-data/gauntlet-org/force-app/main/default';
// v0.5.0 (G4): scripts/*.apex lives outside force-app entirely -- same
// sibling-root shape dev/smoke.js's ADV_ORG_SCRIPTS_ROOT uses. Only
// consulted when ROOT is left at its adv-org default (an inz-org-style
// override has no such sibling, same guard smoke.js doesn't need since it
// hardcodes the adv-org path for this corpus). gauntlet-org's own
// force-app/ has no sibling scripts/ dir, so this is simply a silent no-op
// (readdirSync throw -> caught below) for the new v0.8.0 default.
const SCRIPTS_ROOT = path.join(path.dirname(path.dirname(path.dirname(ROOT))), 'scripts');
// v0.8.0: sfdx-project.json's own `namespace` property, read exactly like
// extension.js's real discoverPackageMap -> opts.ownNamespace plumbing (N3).
// Absent/unreadable sfdx-project.json (e.g. an inz-org-style ROOT override
// with no project file at all) -> null, current pre-v0.8 behavior.
const PROJECT_ROOT = path.dirname(path.dirname(path.dirname(ROOT)));
let ownNamespace = null;
try {
  const sfdxProject = JSON.parse(fs.readFileSync(path.join(PROJECT_ROOT, 'sfdx-project.json'), 'utf8'));
  ownNamespace = typeof sfdxProject.namespace === 'string' && sfdxProject.namespace.trim() ? sfdxProject.namespace.trim() : null;
} catch (e) { /* no sfdx-project.json / unreadable / no namespace property -> null */ }
const OUT_FILE = path.join(__dirname, 'pathmap-preview.html');
const SKIP_DIRS = new Set(['.sfdx', '.sf', 'node_modules', '.git']);
const META_SKIP_DIRS = new Set(['.sfdx', '.sf', 'node_modules', '.git', '__tests__']);

const TARGET = { classLower: 'vertexledgerbridge', methodLower: 'posttoledger' };

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

// Same file-type union metascan.js's parseMetaFile dispatches on.
function walkMeta(dir, out) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (e) {
    return;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (META_SKIP_DIRS.has(e.name)) continue;
      walkMeta(full, out);
    } else if (
      /\.js$/i.test(e.name) ||
      /\.(cmp|app)$/i.test(e.name) ||
      /\.flow-meta\.xml$/i.test(e.name) ||
      /\.os-meta\.xml$/i.test(e.name) ||
      /\.md-meta\.xml$/i.test(e.name) ||
      /\.json$/i.test(e.name) ||
      /\.(page|component)$/i.test(e.name)
    ) {
      out.push(full);
    }
  }
}

// Mirrors extension.js's computeMetaRefs (A7) / dev/smoke.js's
// computeAdvOrgMetaRefs: metascan.js's MetaRef contract has no `path` field,
// so this stamps one on, and Aura needs per-(markup, one-js-file) pairing to
// keep every ref traceable to the exact file it came from.
function computeMetaRefs(files) {
  const refs = [];
  const auraFiles = files.filter((f) => /(^|[\\/])aura[\\/]/i.test(f.path));
  const otherFiles = files.filter((f) => !/(^|[\\/])aura[\\/]/i.test(f.path));

  for (const f of otherFiles) {
    for (const ref of metascan.parseMetaFile(f)) {
      ref.path = f.path;
      refs.push(ref);
    }
  }

  const groups = new Map();
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
        if (ref.methodName == null) continue;
        ref.path = jsFile.path;
        refs.push(ref);
      }
    }
  }

  return refs;
}

function countNodes(node) {
  if (!node) return 0;
  let n = 1;
  for (const c of node.children || []) n += countNodes(c);
  return n;
}

function main() {
  console.log('Indexing: ' + ROOT);
  const filePaths = [];
  walk(ROOT, filePaths);
  if (!filePaths.length) {
    console.error('No .cls/.trigger files found under ' + ROOT + ' — nothing to preview.');
    process.exit(1);
  }

  // v0.5.0 (G4): scripts/*.apex (anonymous Apex) lives outside ROOT -- add
  // it here rather than teaching walk() about a sibling directory.
  let anonScriptCount = 0;
  try {
    for (const name of fs.readdirSync(SCRIPTS_ROOT)) {
      if (/\.apex$/i.test(name)) {
        filePaths.push(path.join(SCRIPTS_ROOT, name));
        anonScriptCount++;
      }
    }
  } catch (e) {
    // scripts/ dir optional -- an inz-org-style override may not have one.
  }
  console.log('Found ' + filePaths.length + ' .cls/.trigger/.apex file(s) (' + anonScriptCount + ' anonymous script(s)).');

  console.log('ownNamespace (from sfdx-project.json): ' + JSON.stringify(ownNamespace));
  const factsList = filePaths.map((p) => parser.parseFile({ path: p, text: fs.readFileSync(p, 'utf8') }));
  const index = resolver.buildSemanticIndex(factsList, { ownNamespace });

  const errCount = factsList.filter((f) => f.parseError).length;
  console.log('Parse errors: ' + errCount + '/' + factsList.length);
  if (index.duplicates && index.duplicates.length) {
    console.log('Duplicate class names ignored: ' + index.duplicates.join(', '));
  }

  const metaPaths = [];
  walkMeta(ROOT, metaPaths);
  const metaFiles = metaPaths.map((p) => ({ path: p, text: fs.readFileSync(p, 'utf8') }));
  const metaRefs = computeMetaRefs(metaFiles);
  // v0.8.0 (N3): mirrors extension.js's real call order -- strip the
  // workspace's own namespace off metaRefs BEFORE attachMetaCallers.
  const strippedMetaRefs = ownNamespace && typeof metascan.stripOwnNamespace === 'function'
    ? metascan.stripOwnNamespace(metaRefs, ownNamespace)
    : metaRefs;
  resolver.attachMetaCallers(index, strippedMetaRefs);
  console.log('Found ' + metaPaths.length + ' metadata file(s), ' + metaRefs.length + ' meta ref(s) attached.');
  console.log('index.stats: ' + JSON.stringify(index.stats));

  if (!index.classes.has(TARGET.classLower)) {
    console.error(
      'Target class "' + TARGET.classLower + '" not found in the index — is ' + ROOT + ' the right corpus?'
    );
    process.exit(1);
  }

  // v0.7.0: FORWARD (callees) direction -- see this file's own header note.
  const tree = resolver.buildCalleeTree(index, TARGET, { maxDepth: 8 });
  console.log('Target: ' + tree.targetLabel + ' (direction=' + tree.direction + ')' + (tree.note ? '  (note: ' + tree.note + ')' : ''));
  console.log('Tree node count: ' + countNodes(tree.root));

  const html = renderPathMapHtml(tree, { legendOpen: true });
  fs.writeFileSync(OUT_FILE, html, 'utf8');

  const stat = fs.statSync(OUT_FILE);
  console.log('Wrote ' + OUT_FILE + ' (' + stat.size + ' bytes).');

  if (stat.size < 2000) {
    console.error('Output looks suspiciously small (<2000 bytes) for a real callee tree — check the target resolved.');
    process.exit(1);
  }
  if (countNodes(tree.root) <= 1) {
    console.error('Callee tree has no callees beyond the target itself — check the target/corpus.');
    process.exit(1);
  }

  console.log('OK: non-trivial path map written successfully.');
}

main();

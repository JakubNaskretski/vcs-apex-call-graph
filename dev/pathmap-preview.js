'use strict';
// Dev preview for pathmap.js: runs the REAL parser.js/resolver.js/metascan.js
// engine over a real (fictional-org, example-only) Salesforce corpus, builds
// the caller tree for a target, renders it with pathmap.js, and writes the
// result to dev/pathmap-preview.html so it can be opened directly in a
// browser (no vscode/webview needed — this is exactly why pathmap.js has no
// vscode dependency).
//
// Usage: node dev/pathmap-preview.js [path-to-force-app-main-default]
// Defaults to the adv-org advanced corpus (Apex + metadata: LWC/Aura/Flow/
// OmniScript), targeting AcmeOrderUtil.markApproved in the FORWARD
// (callees) direction -- v0.7.0's A1 forward transaction story (see
// dev/smoke.js's own FORWARD STORY section): tracing what markApproved
// calls surfaces the update DML statement fanning out to BOTH the matching
// '(trigger)' node AND the matching record-triggered flow node (terminal),
// with the @future email notifier as a sibling third child -- so the
// preview shows the map mirrored (target on the LEFT, callees flowing
// RIGHT) with a real trigger+flow+async fan-out, the richest single-node
// forward shape in the corpus. (Prior versions of this preview targeted
// AcmeValidationException in the reverse/callers direction -- the v0.5.0
// "EXCEPTION STORY"; that render is still fully exercised by
// test-pathmap.js's own self-check, this dev tool just previews the OTHER
// direction now that both exist.)
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

const ROOT = process.argv[2] || '/Users/agent/work/code/example-data/adv-org/force-app/main/default';
// v0.5.0 (G4): scripts/*.apex lives outside force-app entirely -- same
// sibling-root shape dev/smoke.js's ADV_ORG_SCRIPTS_ROOT uses. Only
// consulted when ROOT is left at its adv-org default (an inz-org-style
// override has no such sibling, same guard smoke.js doesn't need since it
// hardcodes the adv-org path for this corpus).
const SCRIPTS_ROOT = path.join(path.dirname(path.dirname(path.dirname(ROOT))), 'scripts');
const OUT_FILE = path.join(__dirname, 'pathmap-preview.html');
const SKIP_DIRS = new Set(['.sfdx', '.sf', 'node_modules', '.git']);
const META_SKIP_DIRS = new Set(['.sfdx', '.sf', 'node_modules', '.git', '__tests__']);

const TARGET = { classLower: 'acmeorderutil', methodLower: 'markapproved' };

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

  const factsList = filePaths.map((p) => parser.parseFile({ path: p, text: fs.readFileSync(p, 'utf8') }));
  const index = resolver.buildSemanticIndex(factsList);

  const errCount = factsList.filter((f) => f.parseError).length;
  console.log('Parse errors: ' + errCount + '/' + factsList.length);
  if (index.duplicates && index.duplicates.length) {
    console.log('Duplicate class names ignored: ' + index.duplicates.join(', '));
  }

  const metaPaths = [];
  walkMeta(ROOT, metaPaths);
  const metaFiles = metaPaths.map((p) => ({ path: p, text: fs.readFileSync(p, 'utf8') }));
  const metaRefs = computeMetaRefs(metaFiles);
  resolver.attachMetaCallers(index, metaRefs);
  console.log('Found ' + metaPaths.length + ' metadata file(s), ' + metaRefs.length + ' meta ref(s) attached.');

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

'use strict';
// Read-only discovery pass: build the index over a corpus, then for EVERY
// class/method target report caller-tree size + max fan-out, so I can pick
// diverse targets (deep chains, high fan-out, dead code) for the UX critique.
const fs = require('fs');
const path = require('path');
const parser = require('../parser');
const resolver = require('../resolver');
const metascan = require('../metascan');

const ROOT = process.argv[2];
const SCRIPTS_ROOT = process.argv[3] || null;
const SKIP = new Set(['.sfdx', '.sf', 'node_modules', '.git']);
const METASKIP = new Set(['.sfdx', '.sf', 'node_modules', '.git', '__tests__']);

function walk(dir, out, re) {
  let es; try { es = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of es) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) { if (!SKIP.has(e.name)) walk(full, out, re); }
    else if (re.test(e.name)) out.push(full);
  }
}
function walkMeta(dir, out) {
  let es; try { es = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of es) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) { if (!METASKIP.has(e.name)) walkMeta(full, out); }
    else if (/\.(js|cmp|app|flow-meta\.xml|os-meta\.xml|json|page|component|md-meta\.xml)$/i.test(e.name)) out.push(full);
  }
}
function computeMetaRefs(files) {
  const refs = [];
  const aura = files.filter(f => /(^|[\\/])aura[\\/]/i.test(f.path));
  const other = files.filter(f => !/(^|[\\/])aura[\\/]/i.test(f.path));
  for (const f of other) for (const r of metascan.parseMetaFile(f)) { r.path = f.path; refs.push(r); }
  const groups = new Map();
  for (const f of aura) { const d = path.dirname(f.path); let g = groups.get(d); if (!g) { g = { markup: null, js: [] }; groups.set(d, g); } if (/\.(cmp|app)$/i.test(f.path)) g.markup = f; else if (/\.js$/i.test(f.path)) g.js.push(f); }
  for (const g of groups.values()) { if (!g.markup) continue; for (const r of metascan.parseMetaFile(g.markup)) { r.path = g.markup.path; refs.push(r); } for (const jf of g.js) for (const r of metascan.scanBundle([g.markup, jf])) { if (r.methodName == null) continue; r.path = jf.path; refs.push(r); } }
  return refs;
}
function count(node) { if (!node) return 0; let n = 1; for (const c of node.children || []) n += count(c); return n; }
function maxFan(node) { if (!node) return 0; let m = (node.children || []).length; for (const c of node.children || []) m = Math.max(m, maxFan(c)); return m; }
function depth(node) { if (!node || !(node.children || []).length) return 0; return 1 + Math.max(...node.children.map(depth)); }

const apex = [];
walk(ROOT, apex, /\.(cls|trigger)$/i);
if (SCRIPTS_ROOT) walk(SCRIPTS_ROOT, apex, /\.apex$/i);
const facts = apex.map(p => parser.parseFile({ path: p, text: fs.readFileSync(p, 'utf8') }));
const index = resolver.buildSemanticIndex(facts);
const metaPaths = []; walkMeta(ROOT, metaPaths);
const metaRefs = computeMetaRefs(metaPaths.map(p => ({ path: p, text: fs.readFileSync(p, 'utf8') })));
resolver.attachMetaCallers(index, metaRefs);

console.log(`ROOT=${ROOT}`);
console.log(`apex files=${apex.length}, parseErrors=${facts.filter(f => f.parseError).length}, metaRefs=${metaRefs.length}, classes=${index.classes.size}`);

const targets = resolver.suggestTargets(index);
const rows = [];
for (const t of targets) {
  const tree = resolver.buildCallerTree(index, { classLower: t.classLower, methodLower: t.methodLower }, { maxDepth: 8 });
  const n = count(tree.root);
  rows.push({ label: t.label, nodes: n, fan: maxFan(tree.root), depth: depth(tree.root) });
}
rows.sort((a, b) => b.nodes - a.nodes);
console.log('\n== TOP 15 by node count (biggest trees) ==');
for (const r of rows.slice(0, 15)) console.log(`  ${String(r.nodes).padStart(4)} nodes  fan=${String(r.fan).padStart(2)}  depth=${r.depth}  ${r.label}`);
const dead = rows.filter(r => r.nodes === 1);
console.log(`\n== DEAD (zero-caller) targets: ${dead.length} of ${rows.length} ==`);
for (const r of dead.slice(0, 12)) console.log(`  ${r.label}`);

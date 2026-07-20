'use strict';
// Compare path-map density: render AcmeQuote (fan-out 13, ~77 nodes, heavy
// subtree duplication) and measure canvas dimensions + leaf count vs the
// current committed exception preview. Writes to a SEPARATE file so the
// committed dev/pathmap-preview.html is left untouched.
const fs = require('fs');
const path = require('path');
const parser = require('../parser');
const resolver = require('../resolver');
const metascan = require('../metascan');
const { renderPathMapHtml } = require('../pathmap');

const ROOT = 'test-fixtures/adv-org/force-app/main/default';
const SKIP = new Set(['.sfdx', '.sf', 'node_modules', '.git']);
const METASKIP = new Set(['.sfdx', '.sf', 'node_modules', '.git', '__tests__']);
function walk(d, o, re) { let es; try { es = fs.readdirSync(d, { withFileTypes: true }); } catch { return; } for (const e of es) { const f = path.join(d, e.name); if (e.isDirectory()) { if (!SKIP.has(e.name)) walk(f, o, re); } else if (re.test(e.name)) o.push(f); } }
function walkMeta(d, o) { let es; try { es = fs.readdirSync(d, { withFileTypes: true }); } catch { return; } for (const e of es) { const f = path.join(d, e.name); if (e.isDirectory()) { if (!METASKIP.has(e.name)) walkMeta(f, o); } else if (/\.(js|cmp|app|flow-meta\.xml|os-meta\.xml|json|page|component|md-meta\.xml)$/i.test(e.name)) o.push(f); } }
function metaRefsFor(files) { const refs = []; const aura = files.filter(f => /(^|[\\/])aura[\\/]/i.test(f.path)); const other = files.filter(f => !/(^|[\\/])aura[\\/]/i.test(f.path)); for (const f of other) for (const r of metascan.parseMetaFile(f)) { r.path = f.path; refs.push(r); } const groups = new Map(); for (const f of aura) { const d = path.dirname(f.path); let g = groups.get(d); if (!g) { g = { markup: null, js: [] }; groups.set(d, g); } if (/\.(cmp|app)$/i.test(f.path)) g.markup = f; else if (/\.js$/i.test(f.path)) g.js.push(f); } for (const g of groups.values()) { if (!g.markup) continue; for (const r of metascan.parseMetaFile(g.markup)) { r.path = g.markup.path; refs.push(r); } for (const jf of g.js) for (const r of metascan.scanBundle([g.markup, jf])) { if (r.methodName == null) continue; r.path = jf.path; refs.push(r); } } return refs; }

const apex = []; walk(ROOT, apex, /\.(cls|trigger)$/i); walk('test-fixtures/adv-org/scripts', apex, /\.apex$/i);
const index = resolver.buildSemanticIndex(apex.map(p => parser.parseFile({ path: p, text: fs.readFileSync(p, 'utf8') })));
const mp = []; walkMeta(ROOT, mp); resolver.attachMetaCallers(index, metaRefsFor(mp.map(p => ({ path: p, text: fs.readFileSync(p, 'utf8') }))));

function measure(name, target) {
  const tree = resolver.buildCallerTree(index, target, { maxDepth: 8 });
  const html = renderPathMapHtml(tree, { legendOpen: true });
  // canvas dims are embedded as width/height on the SVG/canvas element
  const dm = html.match(/const CANVAS = \{[^}]*\}/) || html.match(/width["':\s]+(\d+)[^0-9].{0,40}height["':\s]+(\d+)/);
  const wh = [...html.matchAll(/"width":(\d+),"height":(\d+)/g)];
  const nodeCount = (html.match(/"parentId"/g) || []).length;
  // count distinct node objects in DATA
  const nodes = (html.match(/"id":\d+,"parentId"/g) || []).length;
  const out = path.join(__dirname, 'probe-pathmap-' + name + '.html');
  fs.writeFileSync(out, html);
  console.log(`\n${name}: nodes-in-map=${nodes}, html=${html.length}B`);
  if (wh.length) console.log(`  canvas width x height = ${wh[0][1]} x ${wh[0][2]} px  (viewport ~800px tall)`);
  console.log(`  wrote ${out}`);
  return { nodes, h: wh.length ? +wh[0][2] : null };
}

measure('acmequote', { classLower: 'acmequote', methodLower: null });
measure('exception', { classLower: 'acmevalidationexception', methodLower: null });
measure('bigvalidator', { classLower: 'acmeordervalidator', methodLower: null });

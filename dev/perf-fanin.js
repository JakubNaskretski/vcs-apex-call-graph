'use strict';
// H1 perf probe (integrator, v0.6.0) -- reproduces the GOAL's documented
// pre-fix baseline scenario through the REAL parser -> resolver pipeline
// (not resolver.js's own synthetic-ClassMeta functional probe in
// test-resolver.js, which checks node count only, in-process, without real
// Apex source text or a timing/heap measurement):
//
//   "generate classes L0..L11, W classes per layer, every layer-N method
//   called by all W layer-N+1 methods; trace a layer-0 method."
//   Baseline (pre-H1): 6.7M nodes / 5.4s / 3.08GB heap on an 84-file corpus
//   (W=7, 12 layers, 12*7=84 files -- exactly this generator's W=7 shape).
//
// REQUIRED BAR (H1): the W=7/84-file probe must complete < 500ms, use
// < 150MB heap, and produce < 5000 nodes.
//
// Usage: node dev/perf-fanin.js
//   (optionally: node --expose-gc dev/perf-fanin.js for a more accurate
//   heap-delta reading -- gc() is called before each measurement when
//   available; without --expose-gc the heap numbers are still reported but
//   are noisier, since a GC may or may not have run between measurements.)

const parser = require('../parser');
const resolver = require('../resolver');

const LAYERS = 12; // L0..L11

// Every layer has W classes (including L0 -- matches the GOAL's literal "W
// classes per layer" wording and reproduces the exact 84-file count for
// W=7). Layer N+1's classes each call EVERY layer-N class's method 'm' --
// i.e. layer-N is "called by all W layer-N+1 methods", the fan-in shape
// that explodes combinatorially without H1's DAG memoization. We trace a
// single layer-0 method (WFan0_0); the other W-1 layer-0 siblings exist
// purely to make the file count match the documented 84-file baseline --
// they're still real callees reached by every layer-1 class, just not the
// traced target.
function buildFanInFiles(W) {
  const layerNames = [];
  for (let layer = 0; layer < LAYERS; layer++) {
    const names = [];
    for (let w = 0; w < W; w++) names.push(`WFan${layer}_${w}`);
    layerNames.push(names);
  }
  const files = [];
  for (let layer = 0; layer < LAYERS; layer++) {
    for (const name of layerNames[layer]) {
      let body;
      if (layer === 0) {
        body = '  public void m() { System.debug(\'leaf\'); }';
      } else {
        const calls = layerNames[layer - 1].map((tgt) => `    new ${tgt}().m();`).join('\n');
        body = '  public void m() {\n' + calls + '\n  }';
      }
      const text = `public class ${name} {\n${body}\n}`;
      files.push({ path: `/ws/force-app/main/default/classes/${name}.cls`, text });
    }
  }
  return { files, layerNames };
}

function heapMB() {
  if (typeof global.gc === 'function') global.gc();
  return process.memoryUsage().heapUsed / (1024 * 1024);
}

function runProbe(W) {
  const { files, layerNames } = buildFanInFiles(W);

  const heapBefore = heapMB();
  const t0 = Date.now();

  const factsList = files.map((f) => parser.parseFile(f));
  const index = resolver.buildSemanticIndex(factsList);
  const target = { classLower: layerNames[0][0].toLowerCase(), methodLower: 'm' };
  const tree = resolver.buildCallerTree(index, target, {});

  const t1 = Date.now();
  const heapAfter = heapMB();

  const ms = t1 - t0;
  const heapDeltaMB = heapAfter - heapBefore;
  const nodes = tree.stats.nodes;
  const capped = tree.stats.capped;

  return { W, fileCount: files.length, ms, heapDeltaMB, heapAfterMB: heapAfter, nodes, uniqueMethods: tree.stats.uniqueMethods, capped };
}

function main() {
  if (typeof global.gc !== 'function') {
    console.log('(run with `node --expose-gc dev/perf-fanin.js` for a tighter heap-delta reading -- proceeding without it)\n');
  }

  console.log('H1 perf probe: L0..L11 (12 layers) fan-in, W classes/layer, tracing a single layer-0 method.\n');
  console.log('W'.padEnd(4) + 'files'.padEnd(7) + 'ms'.padEnd(8) + 'heapDeltaMB'.padEnd(14) + 'heapAfterMB'.padEnd(14) + 'nodes'.padEnd(8) + 'uniqueMethods'.padEnd(16) + 'capped');

  const results = [];
  for (const W of [5, 6, 7]) {
    const r = runProbe(W);
    results.push(r);
    console.log(
      String(r.W).padEnd(4) +
      String(r.fileCount).padEnd(7) +
      String(r.ms).padEnd(8) +
      r.heapDeltaMB.toFixed(2).padEnd(14) +
      r.heapAfterMB.toFixed(2).padEnd(14) +
      String(r.nodes).padEnd(8) +
      String(r.uniqueMethods).padEnd(16) +
      String(r.capped)
    );
  }

  console.log('\n=== H1 BAR CHECK (W=7, 84-file corpus) ===');
  const w7 = results.find((r) => r.W === 7);
  const msPass = w7.ms < 500;
  const heapPass = w7.heapDeltaMB < 150;
  const nodesPass = w7.nodes < 5000;
  console.log(`files: ${w7.fileCount} (target: 84) -> ${w7.fileCount === 84 ? 'MATCH' : 'MISMATCH'}`);
  console.log(`ms: ${w7.ms} (target: < 500) -> ${msPass ? 'PASS' : 'FAIL'}`);
  console.log(`heap delta: ${w7.heapDeltaMB.toFixed(2)}MB (target: < 150MB) -> ${heapPass ? 'PASS' : 'FAIL'}`);
  console.log(`nodes: ${w7.nodes} (target: < 5000) -> ${nodesPass ? 'PASS' : 'FAIL'}`);
  console.log(`capped: ${w7.capped} (target: false -- memoization alone should keep this well under the maxNodes cap)`);

  const overallPass = msPass && heapPass && nodesPass && !w7.capped;
  console.log(`\nOVERALL: ${overallPass ? 'PASS' : 'FAIL'}`);
  process.exitCode = overallPass ? 0 : 1;
}

main();

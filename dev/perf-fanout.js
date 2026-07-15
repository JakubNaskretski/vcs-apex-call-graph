'use strict';
// v0.7 integrator perf probe -- mirrors dev/perf-fanin.js (H1, callers
// direction) for Feature A's forward direction: "one method calling W
// targets per layer" instead of "one method called by W callers per
// layer", depth 12, through the REAL parser -> resolver pipeline (real
// Apex source text, real timing/heap, not resolver.js's own synthetic
// functional probe).
//
//   generate classes L0..L11, W classes per layer; EVERY layer-N method
//   calls all W layer-(N+1) methods (the fan-OUT shape); trace a single
//   layer-0 method FORWARD (buildCalleeTree) and confirm the same DAG
//   memoization that keeps the callers-direction probe cheap also keeps
//   this cheap, since both directions share the walker (H1 note in
//   resolver.js, parameterized by ctx.direction).
//
// REQUIRED BAR (mirrors H1): the W=7/84-file probe must complete < 500ms,
// use < 150MB heap, and produce < 5000 nodes, same as the fan-in probe.
//
// Usage: node dev/perf-fanout.js
//   (optionally: node --expose-gc dev/perf-fanout.js for a tighter heap
//   delta reading, same caveat as perf-fanin.js)

const parser = require('../parser');
const resolver = require('../resolver');

const LAYERS = 12; // L0..L11

// Layer N's classes each call EVERY layer-(N+1) class's method 'm' -- the
// fan-OUT mirror of perf-fanin.js's fan-IN generator. We trace a single
// layer-0 method forward; it alone reaches the full W-wide fan-out at every
// subsequent layer (this is the combinatorial-explosion shape forward
// tracing needs the SAME DAG memoization to tame).
function buildFanOutFiles(W) {
  const layerNames = [];
  for (let layer = 0; layer < LAYERS; layer++) {
    const names = [];
    for (let w = 0; w < W; w++) names.push(`WOut${layer}_${w}`);
    layerNames.push(names);
  }
  const files = [];
  for (let layer = 0; layer < LAYERS; layer++) {
    for (const name of layerNames[layer]) {
      let body;
      if (layer === LAYERS - 1) {
        body = '  public void m() { System.debug(\'leaf\'); }';
      } else {
        const calls = layerNames[layer + 1].map((tgt) => `    new ${tgt}().m();`).join('\n');
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
  const { files, layerNames } = buildFanOutFiles(W);

  const heapBefore = heapMB();
  const t0 = Date.now();

  const factsList = files.map((f) => parser.parseFile(f));
  const index = resolver.buildSemanticIndex(factsList);
  const target = { classLower: layerNames[0][0].toLowerCase(), methodLower: 'm' };
  const tree = resolver.buildCalleeTree(index, target, {});

  const t1 = Date.now();
  const heapAfter = heapMB();

  const ms = t1 - t0;
  const heapDeltaMB = heapAfter - heapBefore;
  const nodes = tree.stats.nodes;
  const capped = tree.stats.capped;

  return { W, fileCount: files.length, ms, heapDeltaMB, heapAfterMB: heapAfter, nodes, uniqueMethods: tree.stats.uniqueMethods, capped, direction: tree.direction };
}

function main() {
  if (typeof global.gc !== 'function') {
    console.log('(run with `node --expose-gc dev/perf-fanout.js` for a tighter heap-delta reading -- proceeding without it)\n');
  }

  console.log('v0.7 forward perf probe: L0..L11 (12 layers) fan-out, W classes/layer, tracing a single layer-0 method FORWARD.\n');
  console.log('W'.padEnd(4) + 'files'.padEnd(7) + 'ms'.padEnd(8) + 'heapDeltaMB'.padEnd(14) + 'heapAfterMB'.padEnd(14) + 'nodes'.padEnd(8) + 'uniqueMethods'.padEnd(16) + 'capped'.padEnd(9) + 'direction');

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
      String(r.capped).padEnd(9) +
      r.direction
    );
  }

  console.log('\n=== FORWARD FAN-OUT BAR CHECK (W=7, 84-file corpus) ===');
  const w7 = results.find((r) => r.W === 7);
  const msPass = w7.ms < 500;
  const heapPass = w7.heapDeltaMB < 150;
  const nodesPass = w7.nodes < 5000;
  const dirPass = w7.direction === 'callees';
  console.log(`files: ${w7.fileCount} (target: 84) -> ${w7.fileCount === 84 ? 'MATCH' : 'MISMATCH'}`);
  console.log(`ms: ${w7.ms} (target: < 500) -> ${msPass ? 'PASS' : 'FAIL'}`);
  console.log(`heap delta: ${w7.heapDeltaMB.toFixed(2)}MB (target: < 150MB) -> ${heapPass ? 'PASS' : 'FAIL'}`);
  console.log(`nodes: ${w7.nodes} (target: < 5000) -> ${nodesPass ? 'PASS' : 'FAIL'}`);
  console.log(`direction: ${w7.direction} (target: callees) -> ${dirPass ? 'PASS' : 'FAIL'}`);
  console.log(`capped: ${w7.capped} (target: false -- shared H1 memoization should keep this well under the maxNodes cap)`);

  const overallPass = msPass && heapPass && nodesPass && dirPass && !w7.capped;
  console.log(`\nOVERALL: ${overallPass ? 'PASS' : 'FAIL'}`);
  process.exitCode = overallPass ? 0 : 1;
}

main();

'use strict';
// Independent, from-scratch H1 fan-in probe (adversarial verifier pass,
// v0.6.0 hardening). Written directly from the GOAL text WITHOUT reading or
// reusing dev/perf-fanin.js's corpus-generation code, so it can cross-check
// that probe rather than trust it.
//
//   "layered corpus, W in {5,6,7}, depth 12, trace layer-0, measure wall
//   time, node count, and peak heap (--max-old-space-size=512 must NOT
//   crash for W=7)."
//
// Corpus shape (independently written):
//   - 12 layers, L0..L11 (depth 12).
//   - W classes per layer -> 12*W files total (84 for W=7).
//   - Every layer-(k+1) class's method calls ALL W layer-k classes' method
//     (fan-in W per layer -- "every layer-N method called by all W
//     layer-N+1 methods").
//   - Trace target: the first layer-0 class's method.
//
// Differs from dev/perf-fanin.js deliberately (belt-and-suspenders, not a
// copy): body statements are distinct filler ('Integer x = 1 + 1;' at L0
// vs. 'System.debug(...)'), method name is 'doWork' not 'm', class naming
// scheme is 'Fan<layer>Cls<idx>' not 'WFan<layer>_<idx>'.
//
// Usage: node dev/verify-h1-fanin-independent.js <W>
//   node --expose-gc dev/verify-h1-fanin-independent.js <W>   (tighter heap delta)
// Prints one JSON line: { W, files, ms, heapBeforeMB, heapAfterMB,
// heapDeltaMB, rssMB, nodes, uniqueMethods, capped, note }

const path = require('path');
const parser = require(path.join(__dirname, '..', 'parser.js'));
const resolver = require(path.join(__dirname, '..', 'resolver.js'));

const LAYERS = 12;

function layerClassName(layer, idx) {
  return 'Fan' + layer + 'Cls' + idx;
}

function buildCorpus(W) {
  const files = [];
  for (let layer = 0; layer < LAYERS; layer++) {
    for (let idx = 0; idx < W; idx++) {
      const name = layerClassName(layer, idx);
      let body;
      if (layer === 0) {
        body = '    Integer x = 1 + 1;';
      } else {
        const callLines = [];
        for (let j = 0; j < W; j++) {
          const calleeName = layerClassName(layer - 1, j);
          callLines.push('    new ' + calleeName + '().doWork();');
        }
        body = callLines.join('\n');
      }
      const src = 'public class ' + name + ' {\n' +
        '  public void doWork() {\n' + body + '\n  }\n' +
        '}\n';
      files.push({ path: '/ws/force-app/main/default/classes/' + name + '.cls', text: src });
    }
  }
  return files;
}

function main() {
  const W = parseInt(process.argv[2], 10);
  if (![5, 6, 7].includes(W)) {
    console.error('usage: node dev/verify-h1-fanin-independent.js <5|6|7>');
    process.exit(2);
  }

  const files = buildCorpus(W);

  if (typeof global.gc === 'function') global.gc();
  const heapBeforeMB = process.memoryUsage().heapUsed / (1024 * 1024);

  const t0 = process.hrtime.bigint();

  const factsList = files.map((f) => parser.parseFile(f));
  const index = resolver.buildSemanticIndex(factsList);
  const target = { classLower: layerClassName(0, 0).toLowerCase(), methodLower: 'dowork' };
  const tree = resolver.buildCallerTree(index, target, {});

  const t1 = process.hrtime.bigint();
  const ms = Number(t1 - t0) / 1e6;

  if (typeof global.gc === 'function') global.gc();
  const heapAfterMB = process.memoryUsage().heapUsed / (1024 * 1024);
  const rssMB = process.memoryUsage().rss / (1024 * 1024);

  const result = {
    W,
    files: files.length,
    ms: Math.round(ms * 100) / 100,
    heapBeforeMB: Math.round(heapBeforeMB * 100) / 100,
    heapAfterMB: Math.round(heapAfterMB * 100) / 100,
    heapDeltaMB: Math.round((heapAfterMB - heapBeforeMB) * 100) / 100,
    rssMB: Math.round(rssMB * 100) / 100,
    nodes: tree.stats.nodes,
    uniqueMethods: tree.stats.uniqueMethods,
    capped: tree.stats.capped,
    note: tree.note,
  };
  console.log(JSON.stringify(result));
}

main();

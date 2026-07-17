'use strict';
// v0.10/A1 chain-heavy perf probe -- proves resolveChainedReceiver's
// per-chain visited-guard (and the CHAIN_MAX=12 cap itself) bounds work PER
// CHAIN, so a corpus with many long fluent-chain call sites doesn't blow up
// perf/memory even though CHAIN_MAX rose 4 -> 12 (3x the pre-v0.10 walk
// depth) and every chain segment gets its OWN independent resolution
// attempt (parser.js emits one CallFacts entry per `.method()` link, not
// just the outermost traced call -- see resolver.js's own A1-i-style doc
// note on this, and GROUND-TRUTH.md's "v0.10 ground-truth edges" section).
//
// Shape: ONE shared 30-stage fluent ladder (PerfChainStage0..Stage30, 31
// classes -- StageK declares hopK() -> Stage(K+1) for K=0..29, and every
// stage from Stage1..Stage30 ALSO declares a shared, deliberately NON-
// UNIQUE `terminal()` -- same anti-rule-7-fallback-masking purpose
// GROUND-TRUTH.md's VtxReportQueryStage*.cls ladder and this repo's own
// Chain5E/Chain5F fixtures already establish), consumed by 50 SEPARATE
// caller classes (PerfChainCaller0..Caller49), each building its OWN
// 30-segment chain (q.hop0().hop1()....hop29().terminal()) off a fresh
// Stage0 instance -- "30-segment chain file x 50 classes" per the task
// brief. 30 segments is 18 past CHAIN_MAX=12, so EVERY one of these 50
// traced .terminal() calls must drop to no edge (never a guess) -- the
// perf question is whether 50 x (a 30-link chain, each link independently
// attempting its own bounded walk) stays fast and bounded, not whether any
// of them resolve.
//
// REQUIRED BAR: completes well under a generous ceiling (2000ms / 150MB
// heap delta) with capped:false, and -- the actual correctness half of
// "the guard bounds work per chain" -- zero false edges anywhere in the
// 50-class fan-out.
//
// Usage: node dev/perf-chains.js
//   (optionally: node --expose-gc dev/perf-chains.js for a tighter heap
//   reading -- same convention as dev/perf-fanin.js/perf-fanout.js.)

const parser = require('../parser');
const resolver = require('../resolver');

const STAGE_COUNT = 30; // Stage0..Stage30 (31 classes total, 30 hops)
const CALLER_COUNT = 50; // PerfChainCaller0..Caller49

function buildChainFiles() {
  const files = [];

  // Stage0..Stage29 each declare hopK() -> Stage(K+1).
  for (let k = 0; k < STAGE_COUNT; k++) {
    const nextK = k + 1;
    let body = `  public PerfChainStage${nextK} hop${k}() { return new PerfChainStage${nextK}(); }`;
    // Stage1..Stage30 (i.e. every stage reachable AFTER at least one hop)
    // also declares the shared, non-unique `terminal()` -- Stage0 does NOT
    // (it's the chain's own entry point, never a landing spot).
    if (k >= 1) {
      body += `\n  public String terminal() { return 'stage${k}'; }`;
    }
    const text = `public class PerfChainStage${k} {\n${body}\n}`;
    files.push({ path: `/ws/force-app/main/default/classes/PerfChainStage${k}.cls`, text });
  }
  // Stage30 (the final landing class -- reachable via hop29 off Stage29):
  // ALSO declares terminal(), same non-unique-name convention as every
  // other stage from Stage1 up.
  {
    const text = `public class PerfChainStage${STAGE_COUNT} {\n  public String terminal() { return 'stage${STAGE_COUNT}'; }\n}`;
    files.push({ path: `/ws/force-app/main/default/classes/PerfChainStage${STAGE_COUNT}.cls`, text });
  }

  // 50 independent caller classes, each with its OWN 30-segment chain call
  // site off a FRESH PerfChainStage0 instance (never sharing a local var
  // across classes -- each is a fully independent resolution attempt).
  const hops = [];
  for (let k = 0; k < STAGE_COUNT; k++) hops.push(`hop${k}()`);
  const chainExpr = 'q.' + hops.join('.') + '.terminal()';
  for (let c = 0; c < CALLER_COUNT; c++) {
    const text = [
      `public class PerfChainCaller${c} {`,
      '  public void run() {',
      '    PerfChainStage0 q = new PerfChainStage0();',
      `    ${chainExpr};`,
      '  }',
      '}',
    ].join('\n');
    files.push({ path: `/ws/force-app/main/default/classes/PerfChainCaller${c}.cls`, text });
  }

  return files;
}

function heapMB() {
  if (typeof global.gc === 'function') global.gc();
  return process.memoryUsage().heapUsed / (1024 * 1024);
}

function main() {
  if (typeof global.gc !== 'function') {
    console.log('(run with `node --expose-gc dev/perf-chains.js` for a tighter heap-delta reading -- proceeding without it)\n');
  }

  console.log('v0.10/A1 chain-heavy perf probe: 1 shared 30-stage fluent ladder, 50 independent 30-segment chain callers.\n');

  const files = buildChainFiles();
  console.log(`Corpus: ${files.length} files (${STAGE_COUNT + 1} stage classes + ${CALLER_COUNT} caller classes).`);

  const heapBefore = heapMB();
  const t0 = Date.now();

  const factsList = files.map((f) => parser.parseFile(f));
  const parseMs = Date.now() - t0;
  for (const f of factsList) {
    if (f.parseError) {
      console.log(`FAIL: unexpected parseError in ${f.path}: ${f.parseError}`);
      process.exitCode = 1;
      return;
    }
  }

  const index = resolver.buildSemanticIndex(factsList);
  const indexMs = Date.now() - t0 - parseMs;

  // Trace all 50 callers' run() methods to confirm none crash and none
  // produce a phantom edge; also trace every stage's terminal() as a
  // CALLEE target to confirm zero of the 50 callers show up as a caller of
  // ANY stage's terminal() -- the "never a false edge" half of the bar.
  let anyCallerCrash = false;
  for (let c = 0; c < CALLER_COUNT; c++) {
    try {
      resolver.buildCallerTree(index, { classLower: `perfchaincaller${c}`, methodLower: 'run' }, {});
    } catch (e) {
      anyCallerCrash = true;
      console.log(`FAIL: buildCallerTree threw for PerfChainCaller${c}.run -- ${e && e.message}`);
    }
  }

  let falseEdges = 0;
  let cappedAny = false;
  for (let k = 1; k <= STAGE_COUNT; k++) {
    const tree = resolver.buildCallerTree(index, { classLower: `perfchainstage${k}`, methodLower: 'terminal' }, {});
    if (tree.stats.capped) cappedAny = true;
    const labels = (tree.root.children || []).map((n) => n.label);
    const hit = labels.filter((l) => /^PerfChainCaller\d+\.run$/.test(l));
    if (hit.length) {
      falseEdges += hit.length;
      console.log(`FAIL: PerfChainStage${k}.terminal has ${hit.length} unexpected caller(s) -- a 30-segment chain (18 past CHAIN_MAX=12) must NEVER resolve: ${JSON.stringify(hit)}`);
    }
  }

  const t1 = Date.now();
  const heapAfter = heapMB();

  const totalMs = t1 - t0;
  const heapDeltaMB = heapAfter - heapBefore;

  console.log(`\nparse: ${parseMs}ms, buildSemanticIndex: ${indexMs}ms, total (incl. 50+30 tree builds): ${totalMs}ms`);
  console.log(`heap delta: ${heapDeltaMB.toFixed(2)}MB, heap after: ${heapAfter.toFixed(2)}MB`);
  console.log(`index.stats: ${JSON.stringify(index.stats)}`);
  console.log(`false edges found: ${falseEdges} (target: 0)`);
  console.log(`any tree capped: ${cappedAny} (target: false)`);
  console.log(`any buildCallerTree crash: ${anyCallerCrash} (target: false)`);

  console.log('\n=== BAR CHECK ===');
  const msPass = totalMs < 2000;
  const heapPass = heapDeltaMB < 150;
  const correctnessPass = falseEdges === 0 && !anyCallerCrash;
  console.log(`ms: ${totalMs} (target: < 2000) -> ${msPass ? 'PASS' : 'FAIL'}`);
  console.log(`heap delta: ${heapDeltaMB.toFixed(2)}MB (target: < 150MB) -> ${heapPass ? 'PASS' : 'FAIL'}`);
  console.log(`capped: ${cappedAny} (target: false) -> ${!cappedAny ? 'PASS' : 'FAIL'}`);
  console.log(`correctness (0 false edges, 0 crashes): -> ${correctnessPass ? 'PASS' : 'FAIL'}`);

  const overallPass = msPass && heapPass && !cappedAny && correctnessPass;
  console.log(`\nOVERALL: ${overallPass ? 'PASS' : 'FAIL'}`);
  process.exitCode = overallPass ? 0 : 1;
}

main();

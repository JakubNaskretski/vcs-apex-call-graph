#!/usr/bin/env node
'use strict';

const path = require('path');
const { spawnSync } = require('child_process');
const corpora = require('./corpus-paths');

corpora.requireDirectory('adv-org', corpora.advOrgRoot);
corpora.requireDirectory('gauntlet-org', corpora.gauntletOrgRoot);
corpora.requireDirectory('v0.7.1 baseline', corpora.v071Root);

const env = {
  ...process.env,
  APEX_CALL_GRAPH_ADV_ORG_ROOT: corpora.advOrgRoot,
  APEX_CALL_GRAPH_GAUNTLET_ORG_ROOT: corpora.gauntletOrgRoot,
  APEX_CALL_GRAPH_V071_ROOT: corpora.v071Root,
};

const checks = [
  ['build', 'npm', ['run', 'build']],
  ['cache store', process.execPath, ['test-cachestore.js']],
  ['parser', process.execPath, ['test-parser.js']],
  ['metadata scan', process.execPath, ['test-metascan.js']],
  ['target selection', process.execPath, ['test-targets.js']],
  ['resolver', process.execPath, ['test-resolver.js']],
  ['UI shaping', process.execPath, ['test-uitree.js']],
  ['path map', process.execPath, ['test-pathmap.js']],
  ['scan coordination', process.execPath, ['test-scanflow.js']],
  ['worker pool', process.execPath, ['test-workerpool.js']],
  ['end-to-end', process.execPath, ['test.js']],
  ['ground truth', process.execPath, ['dev/ground-truth-check.js']],
  ['gauntlet', process.execPath, ['dev/gauntlet-run.js']],
  ['smoke', process.execPath, ['dev/smoke.js']],
  ['published-baseline regression', process.execPath, ['dev/regress-v08.js']],
  ['performance fan-in', process.execPath, ['dev/perf-fanin.js']],
  ['performance fan-out', process.execPath, ['dev/perf-fanout.js']],
  ['performance chains', process.execPath, ['dev/perf-chains.js']],
  ['performance cold parse', process.execPath, ['dev/perf-coldparse.js']],
  ['privacy preflight', process.execPath, ['dev/privacy-check.js']],
  ['diff whitespace', 'git', ['diff', '--check']],
];

const started = Date.now();
for (let i = 0; i < checks.length; i++) {
  const [label, command, args] = checks[i];
  console.log(`\n[${i + 1}/${checks.length}] ${label}`);
  const result = spawnSync(command, args, {
    cwd: path.join(__dirname, '..'),
    env,
    stdio: 'inherit',
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    console.error(`\nverify: FAIL at "${label}" (exit ${result.status})`);
    process.exit(result.status || 1);
  }
}

console.log(`\nverify: PASS (${checks.length} gates in ${((Date.now() - started) / 1000).toFixed(1)}s)`);

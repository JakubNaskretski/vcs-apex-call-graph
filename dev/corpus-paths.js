'use strict';

const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.join(__dirname, '..');

function firstExisting(candidates) {
  for (const candidate of candidates) {
    if (candidate && fs.existsSync(candidate)) return path.resolve(candidate);
  }
  return path.resolve(candidates.find(Boolean));
}

function corpusRoot(name, envName) {
  return firstExisting([
    process.env[envName],
    path.join(REPO_ROOT, 'test-fixtures', name),
    path.join(REPO_ROOT, '..', '..', 'example-data', name),
  ]);
}

const advOrgRoot = corpusRoot('adv-org', 'APEX_CALL_GRAPH_ADV_ORG_ROOT');
const gauntletOrgRoot = corpusRoot('gauntlet-org', 'APEX_CALL_GRAPH_GAUNTLET_ORG_ROOT');
const v071Root = firstExisting([
  process.env.APEX_CALL_GRAPH_V071_ROOT,
  path.join(REPO_ROOT, 'test-fixtures', 'v071-extension'),
]);

function requireDirectory(label, dir) {
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
    throw new Error(`${label} fixture not found at ${dir}`);
  }
  return dir;
}

module.exports = {
  REPO_ROOT,
  advOrgRoot,
  gauntletOrgRoot,
  v071Root,
  requireDirectory,
};

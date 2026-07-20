#!/usr/bin/env node
'use strict';

// VSIX prepublish step: retain dependency runtime/package-resolution fields
// and license identifiers, but remove author/contact/repository metadata that
// must not cross this project's strict anonymization boundary.

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const packageFiles = [
  path.join(ROOT, 'node_modules', '@apexdevtools', 'apex-parser', 'package.json'),
  path.join(ROOT, 'node_modules', '@apexdevtools', 'apex-parser', 'node_modules', 'antlr4', 'package.json'),
];
const identityFields = [
  'author', 'contributors', 'maintainers', 'funding', 'homepage', 'repository', 'bugs',
];

for (const packageFile of packageFiles) {
  if (!fs.existsSync(packageFile)) throw new Error(`dependency package metadata not found: ${path.relative(ROOT, packageFile)}`);
  const pkg = JSON.parse(fs.readFileSync(packageFile, 'utf8'));
  for (const field of identityFields) delete pkg[field];
  fs.writeFileSync(packageFile, JSON.stringify(pkg, null, 2) + '\n');
}

console.log('dependency metadata sanitized for packaging');

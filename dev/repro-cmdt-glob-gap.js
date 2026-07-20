'use strict';
// Adversarial-verifier repro: extension.js's META_GLOBS (the list of glob
// patterns scanMetaWorkspaceUris() passes to vscode.workspace.findFiles())
// never includes a pattern that can match a customMetadata/*.md-meta.xml
// path -- so F4b (CMDT -> class linkage), which IS correctly implemented at
// the metascan.js/resolver.js layer (see test-metascan.js's 16f/16g/16h
// cases and test-resolver.js's CMDT assertions), can never actually surface
// in the real running extension: scanMetaWorkspaceUris() simply never finds
// those files to read/pass to metascan.parseMetaFile() in the first place.
//
// This is provable without vscode: extension.js's META_GLOBS array is a
// plain JS literal, extracted here via a scoped read, and matched against
// the real adv-org corpus's actual customMetadata file paths using a small
// glob matcher (supports '**' and '*', the only two glob tokens
// META_GLOBS uses) equivalent to minimatch's default behavior for these
// patterns.
//
// Usage: node dev/repro-cmdt-glob-gap.js

const fs = require('fs');
const path = require('path');

const EXT_PATH = path.join(__dirname, '..', 'extension.js');
const extSource = fs.readFileSync(EXT_PATH, 'utf8');

const m = extSource.match(/const META_GLOBS = \[([\s\S]*?)\];/);
if (!m) {
  console.log('FAIL: could not locate META_GLOBS array in extension.js -- has the variable been renamed?');
  process.exit(1);
}
const globLines = m[1].match(/'[^']*'/g) || [];
const globs = globLines.map((s) => s.slice(1, -1));
console.log('extension.js META_GLOBS (as actually shipped):');
for (const g of globs) console.log('  ' + g);

// Minimal glob -> RegExp, sufficient for the '**/x/**/*.ext' shape used
// throughout META_GLOBS (double-star = any depth incl. zero, single-star =
// any chars within one path segment). Mirrors standard glob semantics
// closely enough for a yes/no "could this ever match" check.
function globToRegExp(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*' && glob[i + 1] === '*') {
      // '**' consumes across path separators, including the surrounding
      // slash so '**/lwc/**/*.js' can match 'lwc/x.js' (zero-depth prefix).
      re += '.*';
      i++;
      if (glob[i + 1] === '/') i++;
    } else if (c === '*') {
      re += '[^/]*';
    } else if ('.+^${}()|[]\\'.includes(c)) {
      re += '\\' + c;
    } else {
      re += c;
    }
  }
  return new RegExp('^' + re + '$');
}

const ADV_ORG_ROOT = 'test-fixtures/adv-org/force-app/main/default';
const cmdtFiles = fs
  .readdirSync(path.join(ADV_ORG_ROOT, 'customMetadata'))
  .filter((f) => f.endsWith('.md-meta.xml'))
  .map((f) => `force-app/main/default/customMetadata/${f}`);

console.log(`\nReal adv-org customMetadata files (relative to sfdx project root):`);
for (const f of cmdtFiles) console.log('  ' + f);

let anyMatch = false;
console.log('\nMatching each real CMDT file path against every META_GLOBS pattern:');
for (const f of cmdtFiles) {
  const matched = globs.filter((g) => globToRegExp(g).test(f));
  console.log(`  ${f} -> matched by: [${matched.join(', ')}]`);
  if (matched.length) anyMatch = true;
}

console.log('\n=== RESULT ===');
if (anyMatch) {
  console.log('PASS: at least one META_GLOBS pattern matches a real CMDT file path.');
  process.exit(0);
} else {
  console.log(
    'FAIL (confirmed gap): NO pattern in extension.js META_GLOBS can ever match a ' +
      "customMetadata/*.md-meta.xml path. scanMetaWorkspaceUris() -> vscode.workspace.findFiles() " +
      'will therefore never discover these files in a real workspace, so metascan.parseMetaFile() ' +
      'is never called on them and F4b (CMDT -> class linkage) can never fire in the shipped extension, ' +
      'despite being correctly implemented in metascan.js/resolver.js and covered by direct-call unit ' +
      'tests in test-metascan.js/test-resolver.js (which bypass the glob layer entirely by constructing ' +
      '{path, text} objects by hand).'
  );
  process.exit(1);
}

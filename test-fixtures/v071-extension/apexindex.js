'use strict';
// Pure-Node lexical helper — no vscode dependency, testable with `node test.js`.
//
// H7(a) cleanup: this file used to also carry a v1 lexical (regex/token)
// call-graph engine (buildIndex/buildCallerTree/methodSites/baseName) that
// buildSemanticIndex/buildCallerTree in resolver.js's real semantic engine
// superseded. Confirmed zero call sites anywhere in this repo (only
// `apexindex.strip()` is required, from resolver.js and test.js) before
// deleting it -- `grep -rn "apexindex" .` (excluding node_modules/.vsix)
// turned up only extension.js's build-check script line, resolver.js's
// `apexindex.strip(...)` call, and test.js's `const { strip } = require(...)`.
// No dead tests for the deleted functions existed elsewhere either (test.js
// already only exercised strip(); there was never a test-apexindex.js).
// strip() is the one piece every other module still depends on (comment/
// string-literal blanking that keeps line numbers intact) -- kept verbatim.

// Blank out comments and string literals (keep newlines so line numbers survive).
function strip(text) {
  const out = text.split('');
  const n = text.length;
  const blank = (from, to) => {
    for (let k = from; k < to && k < n; k++) if (out[k] !== '\n') out[k] = ' ';
  };
  let i = 0;
  while (i < n) {
    const c = text[i];
    const d = i + 1 < n ? text[i + 1] : '';
    if (c === '/' && d === '/') {
      let j = i;
      while (j < n && text[j] !== '\n') j++;
      blank(i, j);
      i = j;
    } else if (c === '/' && d === '*') {
      let j = text.indexOf('*/', i + 2);
      j = j === -1 ? n : j + 2;
      blank(i, j);
      i = j;
    } else if (c === "'") {
      // Apex strings are single-quoted, cannot span lines
      let j = i + 1;
      while (j < n && text[j] !== "'" && text[j] !== '\n') {
        if (text[j] === '\\') j++;
        j++;
      }
      blank(i + 1, j);
      i = j + 1;
    } else {
      i++;
    }
  }
  return out.join('');
}

module.exports = { strip };

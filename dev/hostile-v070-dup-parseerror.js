#!/usr/bin/env node
'use strict';
// Adversarial semantics-attack probe: a duplicated class name where ONE copy
// has a parseError. Bucket resolution (B2) must not crash, and the pre-
// existing parse-error lexical fallback (pass E, reverse-direction) must
// stay sane (no self-reference edges, no phantom bucket entries, no crash
// when resolveDuplicateBucket's bucket.filter touches a duplicate set that
// includes/excludes the broken copy).

const parser = require('../parser');
const resolver = require('../resolver');

let failures = [];
function check(label, cond, detail) {
  if (cond) console.log(`PASS  ${label}`);
  else { console.log(`FAIL  ${label}${detail ? ' -- ' + detail : ''}`); failures.push(label); }
}
function fact(p, t) { return parser.parseFile({ path: p, text: t }); }

// --- Scenario 1: 2 total copies of DupWidget, ONE broken. Pass A silently
// skips the broken file entirely, so classBuckets should see bucket length 1
// (NOT counted as a v0.7 duplicate at all) -- confirm this, and confirm no
// crash anywhere in the pipeline (index build, caller trace, callee trace,
// suggestTargets).
(function scenario1() {
  const goodFile = fact('pkgA/DupWidget.cls', `public class DupWidget {
  public void widgetWork() {
    System.debug('good copy');
  }
}`);
  // Deliberately broken: missing closing brace.
  const brokenFile = fact('pkgB/DupWidget.cls', `public class DupWidget {
  public void widgetWork() {
    System.debug('broken copy'
`);
  check('8a-pre. broken fixture actually carries parseError (sanity)', !!brokenFile.parseError, JSON.stringify(brokenFile.parseError));

  const callerFile = fact('pkgC/DupCaller.cls', `public class DupCaller {
  public void invoke() {
    DupWidget.widgetWork();
  }
}`);

  const packageOf = (fsPath) => {
    if (fsPath.startsWith('pkgA/')) return 'pkg-a';
    if (fsPath.startsWith('pkgB/')) return 'pkg-b';
    if (fsPath.startsWith('pkgC/')) return 'pkg-c';
    return null;
  };

  let threw = null, index;
  try {
    index = resolver.buildSemanticIndex([goodFile, brokenFile, callerFile], { packageOf, defaultPackage: 'pkg-a' });
  } catch (e) {
    threw = e;
  }
  check('8a. buildSemanticIndex does not crash with a parseError-carrying duplicate class name in the mix', !threw, threw && threw.stack);
  if (!index) return;

  check('8b. parseFallbacks records the broken file', (index.parseFallbacks || []).includes('pkgB/DupWidget.cls'), JSON.stringify(index.parseFallbacks));

  // Because pass A skips parseError files outright, the broken copy never
  // gets a classBuckets slot -- only the good copy is registered, so this is
  // NOT actually a v0.7 duplicate-name bucket scenario internally (bucket
  // length 1), even though there are genuinely 2 files with the same class
  // name on disk. Confirm this is what happens (documents actual behavior;
  // flags it if it silently regresses into a crash-prone 2-entry bucket
  // pointing partly at a non-existent ClassMeta).
  const bucket = index.classBuckets ? index.classBuckets.get('dupwidget') : null;
  check('8c. classBuckets sees exactly ONE entry for the duplicated name (broken copy never registers)', bucket && bucket.length === 1, bucket ? `length=${bucket.length}` : 'no bucket at all');

  check('8d. index.stats.duplicateNames does NOT count the broken-copy pair (only fully-parseable duplicates count)', index.stats.duplicateNames === 0, `got ${index.stats.duplicateNames}`);
  check('8e. index.duplicates (flat legacy list) also empty -- broken copy was never a registration race, just dropped', (index.duplicates || []).length === 0, JSON.stringify(index.duplicates));

  let threwTree = null, callerTree, calleeTree;
  try {
    callerTree = resolver.buildCallerTree(index, { classLower: 'dupwidget', methodLower: 'widgetwork' }, {});
    calleeTree = resolver.buildCalleeTree(index, { classLower: 'dupwidget', methodLower: 'widgetwork' }, {});
  } catch (e) {
    threwTree = e;
  }
  check('8f. buildCallerTree/buildCalleeTree on the surviving good copy do not crash', !threwTree, threwTree && threwTree.stack);
  if (callerTree) {
    const callerChild = (callerTree.root.children || []).find((c) => /DupCaller/i.test(c.label));
    check('8g. caller (DupCaller.invoke) resolves normally, via=static (no ambiguity leaked in from the dead broken copy)', callerChild && callerChild.via === 'static', callerChild ? JSON.stringify({ via: callerChild.via }) : 'no caller child found');
  }

  let threwSuggest = null;
  try {
    resolver.suggestTargets(index);
  } catch (e) {
    threwSuggest = e;
  }
  check('8h. suggestTargets does not crash over an index containing a parseError-duplicate pair', !threwSuggest, threwSuggest && threwSuggest.stack);

  // Pass-E lexical fallback sanity: the broken file's own text mentions its
  // own declared name ('DupWidget') -- must be excluded as a self-reference,
  // not turned into a bogus 'lexical' caller edge pointing DupWidget at
  // itself (which would show up as a nonsensical self-caller in the UI).
  const dupwidgetCallers = (index.classCallers && index.classCallers.get('dupwidget')) || [];
  const selfLexicalEdge = dupwidgetCallers.find((s) => s.via === 'lexical' && lcSafe(s.callerClass) === 'dupwidget');
  check('8i. lexical fallback does not create a DupWidget -> DupWidget self-caller edge from the broken copy mentioning its own name', !selfLexicalEdge, selfLexicalEdge && JSON.stringify(selfLexicalEdge));
})();

function lcSafe(s) { return String(s == null ? '' : s).toLowerCase(); }

// --- Scenario 2: a GENUINE duplicate (2 good copies, different packages)
// PLUS a third, unrelated, broken file that happens to share the SAME class
// name too (3 files total, only 2 parseable). Confirms the broken third
// copy neither inflates duplicateNames beyond 1 nor corrupts
// resolveDuplicateBucket's ambiguous fan-out (which must still see exactly
// the 2 real candidates, not 3).
(function scenario2() {
  const good1 = fact('pkgA/TriWidget.cls', `public class TriWidget {
  public void work() { System.debug('a'); }
}`);
  const good2 = fact('pkgB/TriWidget.cls', `public class TriWidget {
  public void work() { System.debug('b'); }
}`);
  const broken3 = fact('pkgC/TriWidget.cls', `public class TriWidget {
  public void work() { System.debug('c'
`); // missing closing paren+brace
  check('8j-pre. third copy really is broken (sanity)', !!broken3.parseError);

  const caller = fact('pkgD/TriCaller.cls', `public class TriCaller {
  public void invoke() {
    TriWidget.work();
  }
}`);

  const packageOf = (fsPath) => {
    if (fsPath.startsWith('pkgA/')) return 'pkg-a';
    if (fsPath.startsWith('pkgB/')) return 'pkg-b';
    if (fsPath.startsWith('pkgC/')) return 'pkg-c';
    if (fsPath.startsWith('pkgD/')) return 'pkg-d';
    return null;
  };

  let threw = null, index;
  try {
    index = resolver.buildSemanticIndex([good1, good2, broken3, caller], { packageOf, defaultPackage: 'pkg-a' });
  } catch (e) {
    threw = e;
  }
  check('8j. buildSemanticIndex does not crash with 2 good + 1 broken same-named class', !threw, threw && threw.stack);
  if (!index) return;

  const bucket = index.classBuckets.get('triwidget');
  check('8k. bucket has exactly 2 entries (the 2 parseable copies), NOT 3', bucket && bucket.length === 2, bucket ? `length=${bucket.length}` : 'missing');
  check('8l. duplicateNames counts exactly 1 (the 2-good-copy pair), unaffected by the 3rd broken copy', index.stats.duplicateNames === 1, `got ${index.stats.duplicateNames}`);

  let threwTree = null, calleeTree;
  try {
    // TriCaller is in pkg-d, neither pkg-a nor pkg-b nor the default (pkg-a
    // IS the default here) -- wait pkg-a IS default, so rule 2 should win:
    // via=static, winner=pkg-a's TriWidget.
    calleeTree = resolver.buildCalleeTree(index, { classLower: 'tricaller', methodLower: 'invoke' }, {});
  } catch (e) {
    threwTree = e;
  }
  check('8m. forward trace from the caller does not crash', !threwTree, threwTree && threwTree.stack);
  if (calleeTree) {
    const children = calleeTree.root.children || [];
    check('8n. default-package rule picks exactly the pkg-a candidate, via=static (2-candidate bucket, not corrupted to 3)', children.length === 1 && children[0].via === 'static' && children[0].path === 'pkgA/TriWidget.cls', JSON.stringify(children.map((c) => ({ via: c.via, path: c.path }))));
  }
})();

console.log('\n=== Summary ===');
console.log(`failures: ${failures.length}`);
if (failures.length) console.log(failures.map((f) => ' - ' + f).join('\n'));
process.exitCode = failures.length ? 1 : 0;

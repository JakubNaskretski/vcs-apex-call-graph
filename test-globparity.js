'use strict';

const assert = require('assert');
const {
  normalizeExcludeGlobs,
  compileExcludeGlob,
  compileExcludeGlobs,
  validExcludeGlobs,
  matchesExcludeGlobs,
} = require('./scanflow');

function expectMatch(pattern, candidate, expected, note) {
  assert.strictEqual(matchesExcludeGlobs(candidate, [pattern]), expected, `${note}: ${pattern} vs ${candidate}`);
}

// VS Code-style wildcard and segment semantics.
const cases = [
  ['**/*.cls', 'Root.cls', true, 'globstar may consume zero directories'],
  ['**/*.cls', 'force-app/classes/Deep.cls', true, 'globstar crosses directories'],
  ['*.cls', 'Root.cls', true, 'single star matches within root segment'],
  ['*.cls', 'classes/Deep.cls', false, 'single star never crosses slash'],
  ['scripts/?.apex', 'scripts/a.apex', true, 'question mark matches one character'],
  ['scripts/?.apex', 'scripts/ab.apex', false, 'question mark matches exactly one character'],
  ['foo/**/bar.cls', 'foo/bar.cls', true, 'middle globstar consumes zero segments'],
  ['foo/**/bar.cls', 'foo/a/b/bar.cls', true, 'middle globstar consumes many segments'],
  ['foo**bar.cls', 'foo/a/bar.cls', false, 'embedded double-star is segment-local'],
  ['foo**bar.cls', 'fooZZbar.cls', true, 'embedded double-star behaves as a segment star'],
  ['**/.Hidden.cls', '.Hidden.cls', true, 'dotfiles are ordinary path characters'],
  ['**/*.cls', '.Hidden.cls', true, 'star may begin with a dot'],
];
for (const [pattern, candidate, expected, note] of cases) expectMatch(pattern, candidate, expected, note);

// Repeated/nested braces, ranges, negation, and literal bracket spellings.
const advanced = [
  ['**/*.{cls,trigger,apex}', 'force-app/classes/A.cls', true],
  ['**/*.{cls,trigger,apex}', 'force-app/classes/A.java', false],
  ['{classes,scripts}/{A,B}.{cls,apex}', 'classes/A.cls', true],
  ['{classes,scripts}/{A,B}.{cls,apex}', 'scripts/B.apex', true],
  ['{classes,{legacy,archive}}/*.cls', 'legacy/Old.cls', true],
  ['{classes,{legacy,archive}}/*.cls', 'archive/Old.cls', true],
  ['**/Shard[0-9].cls', 'classes/Shard7.cls', true],
  ['**/Shard[0-9].cls', 'classes/ShardX.cls', false],
  ['**/Shard[!0-9].cls', 'classes/ShardX.cls', true],
  ['**/Shard[!0-9].cls', 'classes/Shard7.cls', false],
  ['**/[[]draft[]].cls', 'classes/[draft].cls', true],
  ['**/Name[,,].cls', 'classes/Name,.cls', true],
];
for (const [pattern, candidate, expected] of advanced) expectMatch(pattern, candidate, expected, 'advanced syntax');

// Matching an excluded directory prunes every descendant, as findFiles does.
expectMatch('**/generated', 'force-app/generated/deep/Generated.cls', true, 'directory match excludes descendants');
expectMatch('force-app/*', 'force-app/generated/deep/Generated.cls', true, 'matched child directory is pruned');
expectMatch('**/generated/**', 'force-app/not-generated/Generated.cls', false, 'nearby directory names do not match');
expectMatch('**/__tests__/**', 'force-app/__tests__/Fixture.cls', true, 'Apex and metadata share the __tests__ hard exclude');

// Workspace-relative and platform path hygiene.
expectMatch('force-app/**/*.cls', '.\\force-app\\classes\\Win.cls', true, 'Windows separators normalize to slash');
expectMatch('**/*.cls', '../outside/External.cls', false, 'parent traversal is never a workspace-relative match');
expectMatch('**/*.cls', '..', false, 'workspace parent itself is rejected');
expectMatch('**/*.cls', '', false, 'empty candidate is rejected');

// Malformed and adversarial settings never throw or turn into partial rules.
assert.deepStrictEqual(validExcludeGlobs(['[z-a].cls']), [], 'invalid character range is ignored consistently');
assert.doesNotThrow(() => matchesExcludeGlobs('classes/A.cls', ['[z-a].cls']));
const expansionBomb = Array.from({ length: 9 }, () => '{a,b}').join('') + '.cls'; // 512 alternatives > cap
assert.deepStrictEqual(compileExcludeGlob(expansionBomb), [], 'brace expansion is capped');
assert.deepStrictEqual(validExcludeGlobs([expansionBomb]), [], 'over-cap pattern is invalid for full and incremental paths');
assert.strictEqual(matchesExcludeGlobs('aaaaaaaaa.cls', [expansionBomb]), false);
expectMatch('**/(A|B).cls', 'classes/A.cls', false, 'regex punctuation is literal, never executable syntax');
expectMatch('**/A+.cls', 'classes/AAAA.cls', false, 'regex quantifiers are literal');
expectMatch('foo,bar.cls', 'foo,bar.cls', true, 'literal commas retain one meaning in full and incremental scans');
expectMatch('foo,bar.cls', 'foo', false, 'literal comma never becomes an outer-brace alternative');
expectMatch('foo[!x]bar.cls', 'foo/bar.cls', false, 'negated classes never consume a path separator');
expectMatch('foo[a/]bar.cls', 'foo/bar.cls', false, 'positive classes never consume a path separator');

const starHeavy = Array.from({ length: 80 }, () => '*a').join('') + '*b';
const longNonMatch = 'a'.repeat(600) + 'c';
const adversarialStarted = Date.now();
assert.strictEqual(matchesExcludeGlobs(longNonMatch, [starHeavy]), false);
assert.ok(Date.now() - adversarialStarted < 500, 'star-heavy non-match remains linear and responsive');

// Budgets apply to the complete setting, not independently to each pattern.
// This combines the old worst-case multipliers: 256 brace alternatives and
// hundreds of wildcard/literal tokens in every alternative. It must be
// rejected before it can become per-file scan work.
const multiplicativePattern =
  Array.from({ length: 8 }, () => '{a,b}').join('') +
  Array.from({ length: 700 }, () => '*a').join('');
const multiplicativeStarted = Date.now();
const rejectedMultiplicative = compileExcludeGlobs([multiplicativePattern]);
assert.deepStrictEqual(rejectedMultiplicative.globs, []);
assert.strictEqual(rejectedMultiplicative.patterns.length, 0);
assert.ok(Date.now() - multiplicativeStarted < 500, 'multiplicative expansion/token work is rejected responsively');

const tooManyPatterns = Array.from({ length: 100 }, (_, i) => `generated-${i}/**`);
const boundedPatterns = compileExcludeGlobs(tooManyPatterns);
assert.strictEqual(boundedPatterns.globs.length, 64, 'at most 64 unique user patterns are accepted');
assert.ok(boundedPatterns.tokensTotal <= 4096, 'the complete matcher has one aggregate token budget');
assert.ok(boundedPatterns.alternatives <= 256, 'the complete matcher has one aggregate expansion budget');
assert.strictEqual(
  matchesExcludeGlobs('generated-7/deep/Unit.cls', boundedPatterns),
  true,
  'the precompiled settings snapshot is consumed directly by the hot matcher'
);
assert.strictEqual(matchesExcludeGlobs('x'.repeat(8193), ['*']), false, 'path work is bounded too');
const slashHeavyCandidate = Array.from({ length: 1200 }, () => 's').join('/') + '/Unit.cls';
const matchBudgetStarted = Date.now();
assert.strictEqual(
  matchesExcludeGlobs(slashHeavyCandidate, tooManyPatterns),
  false,
  'the per-path DP cell budget fails open instead of freezing on thousands of ancestor candidates'
);
assert.ok(Date.now() - matchBudgetStarted < 500, 'aggregate per-path matching work remains responsive');

// A character class is one syntactic token but matching it scans all class
// parts. Its parts therefore count toward both compile and per-path work
// budgets; otherwise a few maximum-length classes multiply into a scan stall.
const classHeavyPatterns = Array.from({ length: 16 }, (_, i) =>
  `*[${'a'.repeat(2038)}${String.fromCharCode(0x0100 + i)}]`
);
const classHeavyCompiled = compileExcludeGlobs(classHeavyPatterns);
assert.ok(classHeavyCompiled.tokensTotal <= 4096);
const classBudgetStarted = Date.now();
assert.strictEqual(matchesExcludeGlobs('b'.repeat(8192), classHeavyCompiled), false);
assert.ok(Date.now() - classBudgetStarted < 500, 'character-class part work is included in the DP budget');

// Normalization/fingerprinting inputs are deterministic across ordering,
// duplicates, whitespace, leading ./, and Windows separators.
assert.deepStrictEqual(
  normalizeExcludeGlobs([' **/generated/** ', '.\\scripts\\?.apex', '**/generated/**', null]),
  ['**/generated/**', 'scripts/?.apex']
);

// A generated matrix guards against regressions across extensions, depths,
// brace alternatives, and negated digit classes.
for (const extension of ['cls', 'trigger', 'apex']) {
  for (let depth = 0; depth < 5; depth++) {
    const prefix = Array.from({ length: depth }, (_, i) => `d${i}`).join('/');
    const path = (prefix ? prefix + '/' : '') + `Unit${depth}.${extension}`;
    expectMatch(`**/Unit[0-4].{cls,trigger,apex}`, path, true, 'generated supported matrix');
    expectMatch(`**/Unit[!0-4].{cls,trigger,apex}`, path, false, 'generated negated matrix');
  }
}

console.log('apex-call-graph full/incremental glob parity self-check: all assertions passed');

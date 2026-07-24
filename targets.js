'use strict';
// targets.js — H5(b) suggestTargets picker-hygiene post-filter.
//
// Pure function with no vscode/fs dependency. It is a decoupled post-filter
// layered on top of whatever shape resolver.suggestTargets() returns.
//
// Contract:
//
//   refineTargets(list) -> [{ label, classLower, methodLower }]
//   (an output item ALSO carries `package` iff its source item
//   did -- see the B3 addendum below the H5(b) rules.)
//
//   `list` is expected to be resolver.js's suggestTargets(index) output --
//   an array of { label, classLower, methodLower } items (methodLower is
//   `null` for a class-level entry, else the lowercased method name, with
//   two synthetic conventions this module cares about:
//     - '<init>'  -- the real, resolver-merged constructor MethodMeta.
//     - '(init)'  -- the synthetic field-initializer scope (a call-graph
//                    SOURCE only, exactly like the '(get X)'/'(set X)'
//                    accessor scopes resolver.js already suppresses in
//                    suggestTargets() -- nothing ever calls it, so it is
//                    never a valid trace target and would always render as
//                    a silent zero-caller result).
//   Any other item shape/methodLower value passes through unchanged (aside
//   from the dedupe/sort passes below).
//
// extension.js calls refineTargets() on the result of
// resolver.suggestTargets(index) wherever resolveTarget()'s QuickPick is
// built (currently `const picks = resolver.suggestTargets(index);` right
// before the showQuickPick() call) -- i.e.
//   const picks = targets.refineTargets(resolver.suggestTargets(index));
// The returned items keep the same { label, classLower, methodLower } shape
// the QuickPick/`chosen.target.*` code already reads (plus an optional
// `package` field; see below), so no other change is required
// at that call site beyond forwarding `package` onto `target` when present.
//
// H5(b) rules, applied in order:
//
//   1. Suppress '(init)' targets entirely (see rationale above).
//   2. Relabel every '<init>' entry from its raw 'ClassName.<init>' label
//      to the human-legible 'ClassName (constructor)' -- methodLower stays
//      '<init>' unchanged (that's still exactly what resolver.js's
//      buildCallerTree()/methodLevelPairs() route on; only the *display*
//      label changes).
//   3. Dedupe: after step 2, two entries can end up with the identical
//      (classLower, label) pair even though their methodLower differs --
//      e.g. a trigger's class-level entry
//      ({methodLower:null, label:'AcmeOrderTrigger'}) and its '(trigger)'
//      pseudo-method entry ({methodLower:'(trigger)', label:
//      'AcmeOrderTrigger'}) both render the exact same bare trigger name.
//      Collapse same-(classLower,label) duplicates to one entry, keeping
//      the first occurrence in input order (resolver.js pushes a class's
//      own class-level entry before that same class's method entries, and
//      Array.prototype.sort is stable, so "first occurrence" naturally
//      prefers the class-level entry over a same-labelled method entry).
//      Cross-class label collisions (two different real classes/inner
//      classes that happen to share a bare simple name) are NOT deduped --
//      classLower still disambiguates them as genuinely different targets,
//      so both are kept.
//   4. Re-sort by label (localeCompare), matching resolver.js's own
//      suggestTargets() sortedness guarantee -- step 2's relabeling can
//      move a '<init>' entry's sort position relative to its siblings
//      (' (constructor)' sorts before '.anyMethod' -- space < '.').
//
// Defensive: tolerates a non-array/missing `list` (returns []) and
// malformed items -- missing/non-string label or classLower -- (dropped,
// never throws).
//
// Package-aware target labels (additive and backward compatible):
//   Each input item MAY now also carry an optional `package` field --
//   string | null -- mirroring TNode's own optional `package` field.
//   resolver.js's package-aware suggestTargets() stamps this on every item.
//   When an input item has NO `package` property at all (today's shape,
//   and every pre-v0.7 fixture in test-targets.js), refineTargets()'s
//   output for that item is untouched -- no `package` key appears on the
//   output object either, so a packageless workspace (or an older resolver)
//   is BYTE-IDENTICAL to pre-v0.7 output. This
//   file never itself decides "there is no package here"; it only ever
//   reacts to what's actually present on the item.
//
//   When 2+ items share the same classLower AND carry 2+ DISTINCT
//   `package` values between them -- a duplicate qualified name surfaced
//   across packages (index.stats
//   .duplicateNames counts these at the classLower/qualified-name level,
//   not per display label) -- EVERY item in that classLower group gets its
//   label suffixed ' (pkgLabel)', using that item's OWN package (a
//   null/empty package renders as ' (no package)', so the group's members
//   stay distinguishable even in that edge case). Suffixing every entry
//   under the duplicated classLower (not just entries whose pre-suffix
//   label happens to literally collide) is deliberate: it's what makes two
//   otherwise-identical-looking class-level rows (e.g. two different real
//   classes both display as bare "AcmeOrderUtil") distinguishable in the
//   QuickPick, which is the actual bug this closes -- without it, rule 3's
//   same-(classLower,label) dedupe below would silently collapse them into
//   one, recreating the old first-wins behavior. A
//   classLower whose items all carry the SAME package (the overwhelmingly
//   common case -- a class that isn't duplicated) is left alone: no
//   suffix, matching "ONLY for duplicated names" from the spec.
//
//   Grouping/suffixing runs AFTER rules 1-3 (suppression/relabel/dedupe)
//   below and BEFORE the final re-sort (rule 4), since suffixing can
//   itself change label sort order the same way constructor-relabeling
//   already does. It is idempotent: re-applying refineTargets() to its own
//   suffixed output never double-appends the same suffix (mirroring
//   ctorLabel's ALREADY_RELABELED_RE guard above).
//
// Managed-reference addition: each input item MAY also
// carry an optional `kind` field -- mirroring TNode.kind's new 'external'
// value -- resolver.js includes external targets that have at least one
// local reference.
// This file reacts to it exactly the way it already reacts to the optional
// `package` field (B3, above): an item with NO `kind` property at all
// (today's shape, and every pre-v0.8 fixture in test-targets.js) is
// COMPLETELY untouched -- no code path here even looks at `item.kind`
// unless it's present, so a resolver.js without external target support
// yet keeps this file byte-identical to pre-v0.8 output.
//
//   When an item's `kind === 'external'`, its (post steps 1-3) label gets a
//   ' (managed)' suffix appended. The transform is idempotent (mirrors
//   ctorLabel's ALREADY_RELABELED_RE
//   guard), applied in the SAME per-item pass as rule 2's constructor
//   relabel, so it participates correctly in rule 3's dedupe key and rule
//   4's final re-sort exactly like every other label transform here.
//   `kind` itself is carried through onto the output item (mirroring how
//   `package` is carried through) whenever the source item had one, so a
//   downstream caller can distinguish an external pick
//   from a local one without re-deriving it from the suffixed label text.
//
//   External items never carry a `package` field in N4's design (they are
//   not local files living under an sfdx package directory), so this never
//   interacts with rule 3's B3 duplicate-package suffixing pass -- the two
//   suffixes are independent and never compound in practice.

const CTOR_METHOD = '<init>';
const FIELD_INIT_METHOD = '(init)';
const CTOR_SUFFIX_RE = /\.?<init>\s*$/;
const ALREADY_RELABELED_RE = / \(constructor\)$/;
const LEFTOVER_CTOR_TOKEN_RE = /<init>/;
// Managed-reference display suffix.
const MANAGED_SUFFIX = ' (managed)';
const ALREADY_MANAGED_RE = / \(managed\)$/;

function isPlainTargetItem(item) {
  return (
    !!item &&
    typeof item === 'object' &&
    typeof item.label === 'string' &&
    typeof item.classLower === 'string' &&
    item.classLower.length > 0
  );
}

// 'ClassName.<init>' -> 'ClassName (constructor)'. Idempotent (calling it
// again on an already-relabeled string is a no-op) and never leaks the raw
// '<init>' synthetic token into the displayed label, even for a
// malformed/unexpected raw label shape.
function ctorLabel(rawLabel) {
  const s = typeof rawLabel === 'string' ? rawLabel : '';
  if (ALREADY_RELABELED_RE.test(s)) return s;
  const stripped = s.replace(CTOR_SUFFIX_RE, '').trim();
  if (!stripped || LEFTOVER_CTOR_TOKEN_RE.test(stripped)) return 'Constructor';
  return stripped + ' (constructor)';
}

// 'zenq.Billing' -> 'zenq.Billing (managed)'. Idempotent
// (calling it again on an already-suffixed string is a no-op), same
// convention as ctorLabel above.
function managedLabel(rawLabel) {
  const s = typeof rawLabel === 'string' ? rawLabel : '';
  if (ALREADY_MANAGED_RE.test(s)) return s;
  return s + MANAGED_SUFFIX;
}

// v0.14 Impact Analysis: canonical overload text and declaration-line
// disambiguation kept pure so cursor behavior can be unit-tested without a
// VS Code host. MethodMeta.line and the incoming cursor line are 1-based.
function methodSignature(method) {
  if (!method || typeof method.name !== 'string') return null;
  return `${method.name}(${(method.params || []).map((p) => p.type || 'Object').join(', ')})`;
}

function findDeclarationOverload(methods, methodLower, cursorLine) {
  if (!Array.isArray(methods) || typeof methodLower !== 'string' || !Number.isFinite(cursorLine)) return null;
  const wanted = methodLower.toLowerCase();
  const method = methods.find((m) =>
    m && typeof m.name === 'string' && m.name.toLowerCase() === wanted && Number(m.line) === cursorLine
  );
  if (!method) return null;
  return { method, overloadSig: methodSignature(method) };
}

function refineTargets(list) {
  if (!Array.isArray(list)) return [];

  const out = [];
  const seen = new Set(); // 'classLower::finalLabel::packageBucket'

  for (const item of list) {
    if (!isPlainTargetItem(item)) continue;

    const methodLower = item.methodLower == null ? null : String(item.methodLower);

    // Rule 1: field-initializer synthetic scope is never a valid target.
    if (methodLower === FIELD_INIT_METHOD) continue;

    // Rule 2: relabel the merged-constructor synthetic method.
    let label = methodLower === CTOR_METHOD ? ctorLabel(item.label) : item.label;

    // A suggestTargets entry for an external (managed-package)
    // target gets a ' (managed)' suffix -- see the header comment above for
    // the full contract. Applied right after rule 2's constructor relabel,
    // BEFORE the dedupe key below is built, so it participates correctly in
    // rule 3's dedupe/rule 4's sort exactly like the constructor relabel
    // does. `item.kind` is read directly (not defaulted) -- absent on every
    // pre-v0.8 item, which is what keeps this a complete no-op until
    // resolver.js starts stamping kind:'external' on
    // suggestTargets() output.
    if (item.kind === 'external') label = managedLabel(label);

    // Only items whose SOURCE actually carried a 'package'
    // property participate in package-aware dedupe/suffixing below --
    // hasPkg is false for every item in a packageless workspace (or
    // against a pre-B2 resolver.js), which is exactly what keeps that case
    // byte-identical to pre-v0.7 (see the header comment above).
    const hasPkg = Object.prototype.hasOwnProperty.call(item, 'package');
    const pkg = hasPkg ? (typeof item.package === 'string' && item.package.length ? item.package : null) : undefined;
    const pkgBucket = hasPkg ? (pkg === null ? 'no-package' : pkg) : 'unknown-package';

    // Rule 3: dedupe same-class same-label (same-package, when known)
    // entries, keep first occurrence. Folding the package bucket into the
    // key is what stops two genuinely different duplicate-name classes
    // (same classLower, same pre-suffix label, different package) from
    // wrongly collapsing into one here -- the B3 suffixing pass below then
    // makes their labels distinguishable before the final sort.
    const key = item.classLower + '::' + label + '::' + pkgBucket;
    if (seen.has(key)) continue;
    seen.add(key);

    const outItem = { label, classLower: item.classLower, methodLower };
    if (hasPkg) outItem.package = pkg;
    // Carry `kind` through onto the output item, same
    // "only when the source actually had it" convention as `package`
    // above. This file stops at carrying the field through rather than wiring it into
    // extension.js's `target` object itself.
    if (typeof item.kind === 'string' && item.kind) outItem.kind = item.kind;
    out.push(outItem);
  }

  // B3: duplicate-name package suffixing -- see the header comment above
  // for the full rationale. Only items carrying a 'package' field
  // participate; a classLower group where every member shares the same
  // package (including "no package here" as its own value) is untouched.
  const pkgsByClass = new Map(); // classLower -> Set of distinct package buckets
  for (const item of out) {
    if (!Object.prototype.hasOwnProperty.call(item, 'package')) continue;
    let bucketSet = pkgsByClass.get(item.classLower);
    if (!bucketSet) {
      bucketSet = new Set();
      pkgsByClass.set(item.classLower, bucketSet);
    }
    bucketSet.add(item.package === null ? 'no-package' : item.package);
  }
  for (const item of out) {
    if (!Object.prototype.hasOwnProperty.call(item, 'package')) continue;
    const bucketSet = pkgsByClass.get(item.classLower);
    if (!bucketSet || bucketSet.size <= 1) continue;
    const pkgLabel = item.package === null ? 'no package' : item.package;
    const suffix = ' (' + pkgLabel + ')';
    if (!item.label.endsWith(suffix)) item.label = item.label + suffix; // idempotency guard
  }

  // Rule 4: re-sort, since relabeling/suffixing can change relative order.
  out.sort((a, b) => a.label.localeCompare(b.label));
  return out;
}

module.exports = { refineTargets, methodSignature, findDeclarationOverload };

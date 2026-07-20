'use strict';
// Self-check for targets.js (H5(b) suggestTargets picker hygiene):
//   node test-targets.js
//
// Deliberately does NOT require resolver.js -- targets.js is a decoupled
// pure post-filter, so every fixture below hand-builds the documented
// { label, classLower, methodLower } shape resolver.js's suggestTargets()
// produces (cross-checked by inspection against a live run over the
// read-only adv-org corpus while writing this file: real '<init>' items look
// like { label:'AcmeBaseNotifier.<init>', classLower:'acmebasenotifier',
// methodLower:'<init>' }, real '(init)' items look like
// { label:'AcmeOrderTrigger.(init)', classLower:'acmeordertrigger',
// methodLower:'(init)' }, and the trigger label-collision fixture in test 6
// below mirrors an ACTUAL collision resolver.js's suggestTargets() produces
// today for AcmeOrderTrigger/AcmeShipmentTrigger: a class-level entry
// {methodLower:null} and a '(trigger)' pseudo-method entry both rendering
// the exact same bare trigger name).
const assert = require('assert');
const { refineTargets, methodSignature, findDeclarationOverload } = require('./targets');

// ===========================================================================
// Rule 1: '(init)' suppressed entirely
// ===========================================================================

// 1. A field-initializer '(init)' entry never survives, its class-level and
//    other-method siblings are untouched.
{
  const input = [
    { label: 'AcmeDiscountUtil', classLower: 'acmediscountutil', methodLower: null },
    { label: 'AcmeDiscountUtil.(init)', classLower: 'acmediscountutil', methodLower: '(init)' },
    { label: 'AcmeDiscountUtil.applyDiscount', classLower: 'acmediscountutil', methodLower: 'applydiscount' },
  ];
  const out = refineTargets(input);
  assert.strictEqual(out.length, 2);
  assert.ok(!out.some((o) => o.methodLower === '(init)'), '(init) must never survive');
  assert.ok(out.some((o) => o.label === 'AcmeDiscountUtil' && o.methodLower === null));
  assert.ok(out.some((o) => o.label === 'AcmeDiscountUtil.applyDiscount' && o.methodLower === 'applydiscount'));
}

// 2. Multiple different classes' '(init)' entries are all suppressed, none
//    of it leaks through as a false accidental survivor.
{
  const input = [
    { label: 'A.(init)', classLower: 'a', methodLower: '(init)' },
    { label: 'B.(init)', classLower: 'b', methodLower: '(init)' },
    { label: 'C', classLower: 'c', methodLower: null },
  ];
  const out = refineTargets(input);
  assert.deepStrictEqual(out, [{ label: 'C', classLower: 'c', methodLower: null }]);
}

// ===========================================================================
// Rule 2: '<init>' relabeled to '<Class> (constructor)'
// ===========================================================================

// 3. Standard shape: 'ClassName.<init>' -> 'ClassName (constructor)',
//    methodLower stays '<init>' (buildCallerTree routes on it verbatim).
{
  const input = [{ label: 'AcmeBaseNotifier.<init>', classLower: 'acmebasenotifier', methodLower: '<init>' }];
  const out = refineTargets(input);
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].label, 'AcmeBaseNotifier (constructor)');
  assert.strictEqual(out[0].classLower, 'acmebasenotifier');
  assert.strictEqual(out[0].methodLower, '<init>', 'methodLower must stay <init> for buildCallerTree routing');
}

// 4. Inner-class-shaped label (dotted qualified name) still strips only the
//    trailing '.<init>' suffix, not any earlier dot.
{
  const input = [{ label: 'OuterA.InnerB.<init>', classLower: 'outera.innerb', methodLower: '<init>' }];
  const out = refineTargets(input);
  assert.strictEqual(out[0].label, 'OuterA.InnerB (constructor)');
}

// 5. Defensive: an unexpected raw label shape (no '.<init>' suffix at all,
//    or literally just '<init>') never leaks the raw synthetic token into
//    the displayed label.
{
  const weird = refineTargets([{ label: 'SomethingWeird', classLower: 'x', methodLower: '<init>' }]);
  assert.strictEqual(weird[0].label, 'SomethingWeird (constructor)');
  assert.ok(!/<init>/.test(weird[0].label));

  const bare = refineTargets([{ label: '<init>', classLower: 'y', methodLower: '<init>' }]);
  assert.strictEqual(bare[0].label, 'Constructor');
  assert.ok(!/<init>/.test(bare[0].label));
}

// ===========================================================================
// Rule 3: dedupe same-class same-label collisions
// ===========================================================================

// 6. Real-shaped trigger collision: class-level entry + '(trigger)'
//    pseudo-method entry share the exact same bare label -- collapse to the
//    class-level entry (first occurrence, per resolver.js's push order).
{
  const input = [
    { label: 'AcmeOrderTrigger', classLower: 'acmeordertrigger', methodLower: null },
    { label: 'AcmeOrderTrigger', classLower: 'acmeordertrigger', methodLower: '(trigger)' },
    { label: 'AcmeOrderTrigger.(init)', classLower: 'acmeordertrigger', methodLower: '(init)' },
  ];
  const out = refineTargets(input);
  assert.strictEqual(out.length, 1, '(trigger) collapses into the class-level entry; (init) is separately suppressed');
  assert.deepStrictEqual(out[0], { label: 'AcmeOrderTrigger', classLower: 'acmeordertrigger', methodLower: null });
}

// 7. Cross-class label collision (two DIFFERENT classes sharing a bare
//    simple name) must NOT be deduped -- classLower disambiguates them as
//    genuinely different real targets.
{
  const input = [
    { label: 'Helper', classLower: 'outera.helper', methodLower: null },
    { label: 'Helper', classLower: 'outerb.helper', methodLower: null },
  ];
  const out = refineTargets(input);
  assert.strictEqual(out.length, 2, 'different real classes must both survive even with an identical display label');
  assert.deepStrictEqual(
    out.map((o) => o.classLower).sort(),
    ['outera.helper', 'outerb.helper']
  );
}

// 8. Exact literal duplicate input items (defensive, in case an upstream
//    source ever double-emits) also collapse to one.
{
  const dupe = { label: 'AcmeOrderService.applyDiscount', classLower: 'acmeorderservice', methodLower: 'applydiscount' };
  const out = refineTargets([dupe, { ...dupe }]);
  assert.strictEqual(out.length, 1);
}

// ===========================================================================
// Rule 4: re-sorted by label after relabeling
// ===========================================================================

// 9. A '<init>' entry's relabeled text can change its sort position
//    relative to siblings (' (constructor)' sorts before '.anyMethod',
//    space < '.') -- output must still come out fully label-sorted.
{
  const input = [
    { label: 'AcmeOrderService.applyDiscount', classLower: 'acmeorderservice', methodLower: 'applydiscount' },
    { label: 'AcmeOrderService', classLower: 'acmeorderservice', methodLower: null },
    { label: 'AcmeOrderService.<init>', classLower: 'acmeorderservice', methodLower: '<init>' },
    { label: 'AcmeOrderService.zzLastMethod', classLower: 'acmeorderservice', methodLower: 'zzlastmethod' },
  ];
  const out = refineTargets(input);
  const labels = out.map((o) => o.label);
  const sorted = labels.slice().sort((a, b) => a.localeCompare(b));
  assert.deepStrictEqual(labels, sorted, 'output must be fully label-sorted after relabeling');
  assert.ok(labels.includes('AcmeOrderService (constructor)'));
}

// ===========================================================================
// Defensive input handling
// ===========================================================================

// 10. Non-array / missing input never throws, always returns [].
{
  assert.doesNotThrow(() => refineTargets(undefined));
  assert.deepStrictEqual(refineTargets(undefined), []);
  assert.deepStrictEqual(refineTargets(null), []);
  assert.deepStrictEqual(refineTargets('not-an-array'), []);
  assert.deepStrictEqual(refineTargets(42), []);
  assert.deepStrictEqual(refineTargets({}), []);
  assert.deepStrictEqual(refineTargets([]), []);
}

// 11. Malformed individual items are dropped, never fatal to the whole list.
{
  const input = [
    { label: 'Good', classLower: 'good', methodLower: null },
    { label: 'NoClassLower', methodLower: null }, // missing classLower
    { classLower: 'nolabel', methodLower: null }, // missing label
    { label: 42, classLower: 'badlabeltype', methodLower: null }, // non-string label
    { label: 'EmptyClassLower', classLower: '', methodLower: null }, // empty classLower
    null,
    undefined,
    'garbage',
    42,
  ];
  assert.doesNotThrow(() => refineTargets(input));
  const out = refineTargets(input);
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].label, 'Good');
}

// ===========================================================================
// Idempotency: applying refineTargets twice (defensive robustness, not part
// of the real integration path, which calls it exactly once) must not
// double-append ' (constructor)' or otherwise corrupt an already-refined list.
// ===========================================================================

// 12. Double-application is a no-op on an already-refined list.
{
  const input = [
    { label: 'AcmeBaseNotifier.<init>', classLower: 'acmebasenotifier', methodLower: '<init>' },
    { label: 'AcmeDiscountUtil.(init)', classLower: 'acmediscountutil', methodLower: '(init)' },
    { label: 'AcmeOrderService.applyDiscount', classLower: 'acmeorderservice', methodLower: 'applydiscount' },
  ];
  const once = refineTargets(input);
  const twice = refineTargets(once);
  assert.deepStrictEqual(twice, once, 'refineTargets must be idempotent when re-applied to its own output');
  assert.ok(!twice.some((o) => / \(constructor\) \(constructor\)$/.test(o.label)), 'must never double-suffix');
}

// ===========================================================================
// End-to-end-shaped fixture: a whole small class list, mirroring the shape
// resolver.js's suggestTargets() actually returns (sorted input, mixed
// entry kinds) -- verifies the four rules compose correctly together.
// ===========================================================================

// 13. Composite fixture.
{
  const input = [
    { label: 'AcmeOrderService', classLower: 'acmeorderservice', methodLower: null },
    { label: 'AcmeOrderService.(init)', classLower: 'acmeorderservice', methodLower: '(init)' },
    { label: 'AcmeOrderService.<init>', classLower: 'acmeorderservice', methodLower: '<init>' },
    { label: 'AcmeOrderService.applyDiscount', classLower: 'acmeorderservice', methodLower: 'applydiscount' },
    { label: 'AcmeOrderTrigger', classLower: 'acmeordertrigger', methodLower: null },
    { label: 'AcmeOrderTrigger', classLower: 'acmeordertrigger', methodLower: '(trigger)' },
    { label: 'AcmeOrderTrigger.(init)', classLower: 'acmeordertrigger', methodLower: '(init)' },
  ].sort((a, b) => a.label.localeCompare(b.label));

  const out = refineTargets(input);
  assert.deepStrictEqual(
    out.map((o) => o.label),
    ['AcmeOrderService (constructor)', 'AcmeOrderService.applyDiscount', 'AcmeOrderTrigger', 'AcmeOrderService'].sort(
      (a, b) => a.localeCompare(b)
    )
  );
  assert.strictEqual(out.length, 4);
  const ctor = out.find((o) => o.methodLower === '<init>');
  assert.strictEqual(ctor.label, 'AcmeOrderService (constructor)');
  const trig = out.find((o) => o.classLower === 'acmeordertrigger');
  assert.strictEqual(trig.methodLower, null, 'trigger collision must resolve to the class-level entry');
}

// ===========================================================================
// v0.7 / B3: duplicate-name package-label suffixing.
//
// Fixtures below hand-build the shape resolver.js's suggestTargets() is
// expected to produce ONCE it lands B2's duplicate-name buckets + packageOf
// plumbing: an optional `package` field (string | null) alongside the
// pre-existing { label, classLower, methodLower }. Package names mirror the
// v0.7 adv-org corpus fixture (MANIFEST.md's "## v0.7 ground-truth edges"):
// `force-app` (default package, label falls back to the path segment since
// it declares no `package` field of its own), `nova-billing` (pkg-billing),
// `nova-shared` (pkg-shared) -- and the corpus's own duplicate pair names,
// `AcmeOrderUtil` (force-app + pkg-billing) and `NovaBillingUtil`
// (pkg-billing + pkg-shared).
// ===========================================================================

// 14. Backward compatibility: an item with NO `package` property at all
//     (today's shape, and every fixture above) produces an output item with
//     no `package` key either -- exact 3-key shape, unaffected by the B3
//     machinery being present in the module.
{
  const input = [{ label: 'AcmeDiscountUtil', classLower: 'acmediscountutil', methodLower: null }];
  const out = refineTargets(input);
  assert.deepStrictEqual(out, [{ label: 'AcmeDiscountUtil', classLower: 'acmediscountutil', methodLower: null }]);
  assert.ok(!('package' in out[0]), 'no package key when the source item never had one');
}

// 15. A single-package class (every entry under one classLower carries the
//     SAME package) is left alone: no suffix, even though `package` IS
//     present and threaded through onto the output item ("ONLY for
//     duplicated names").
{
  const input = [
    { label: 'AcmeOrderService', classLower: 'acmeorderservice', methodLower: null, package: 'force-app' },
    {
      label: 'AcmeOrderService.processOrders',
      classLower: 'acmeorderservice',
      methodLower: 'processorders',
      package: 'force-app',
    },
  ];
  const out = refineTargets(input);
  assert.strictEqual(out.length, 2);
  assert.ok(
    out.every((o) => o.label === 'AcmeOrderService' || o.label === 'AcmeOrderService.processOrders'),
    'no non-duplicated class ever gets a package suffix'
  );
  assert.ok(
    out.every((o) => o.package === 'force-app'),
    'package field is still threaded through even when not duplicated'
  );
}

// 16. Genuine duplicate: two DIFFERENT real classes share the same
//     classLower/qualified name ('AcmeOrderUtil') across two packages.
//     Their class-level entries would otherwise be an EXACT (classLower,
//     label) collision -- rule 3's dedupe must not merge them, and both
//     must come out suffixed with their own package.
{
  const input = [
    { label: 'AcmeOrderUtil', classLower: 'acmeorderutil', methodLower: null, package: 'force-app' },
    { label: 'AcmeOrderUtil', classLower: 'acmeorderutil', methodLower: null, package: 'nova-billing' },
  ];
  const out = refineTargets(input);
  assert.strictEqual(out.length, 2, 'both duplicate-name candidates must survive, not collapse');
  const labels = out.map((o) => o.label).sort();
  assert.deepStrictEqual(labels, ['AcmeOrderUtil (force-app)', 'AcmeOrderUtil (nova-billing)']);
  assert.ok(out.every((o) => o.classLower === 'acmeorderutil'));
}

// 17. Full duplicate-pair shape mirroring the adv-org corpus:
//     force-app's AcmeOrderUtil declares normalize/markApproved/buildQuery,
//     pkg-billing's (unrelated) AcmeOrderUtil declares
//     reconcileBillingStatus/applyLateFee. The class-level rows collide and
//     must be suffixed; the deliberate design choice (see targets.js's
//     header comment) is that EVERY entry under the duplicated classLower
//     gets suffixed too, even method-level rows whose own label never
//     collided with anything (e.g. '.normalize' vs '.reconcileBillingStatus')
//     -- because the underlying class identity is still ambiguous without
//     package context, and it keeps the whole duplicated group visually
//     consistent in the QuickPick.
{
  const input = [
    { label: 'AcmeOrderUtil', classLower: 'acmeorderutil', methodLower: null, package: 'force-app' },
    { label: 'AcmeOrderUtil.normalize', classLower: 'acmeorderutil', methodLower: 'normalize', package: 'force-app' },
    {
      label: 'AcmeOrderUtil.markApproved',
      classLower: 'acmeorderutil',
      methodLower: 'markapproved',
      package: 'force-app',
    },
    { label: 'AcmeOrderUtil.buildQuery', classLower: 'acmeorderutil', methodLower: 'buildquery', package: 'force-app' },
    { label: 'AcmeOrderUtil', classLower: 'acmeorderutil', methodLower: null, package: 'nova-billing' },
    {
      label: 'AcmeOrderUtil.reconcileBillingStatus',
      classLower: 'acmeorderutil',
      methodLower: 'reconcilebillingstatus',
      package: 'nova-billing',
    },
    {
      label: 'AcmeOrderUtil.applyLateFee',
      classLower: 'acmeorderutil',
      methodLower: 'applylatefee',
      package: 'nova-billing',
    },
  ];
  const out = refineTargets(input);
  assert.strictEqual(out.length, 7, 'no entry lost -- every distinct (class,method,package) triple survives');
  const labels = out.map((o) => o.label).sort();
  assert.deepStrictEqual(labels, [
    'AcmeOrderUtil (force-app)',
    'AcmeOrderUtil (nova-billing)',
    'AcmeOrderUtil.applyLateFee (nova-billing)',
    'AcmeOrderUtil.buildQuery (force-app)',
    'AcmeOrderUtil.markApproved (force-app)',
    'AcmeOrderUtil.normalize (force-app)',
    'AcmeOrderUtil.reconcileBillingStatus (nova-billing)',
  ]);
  assert.ok(out.every((o) => o.classLower === 'acmeorderutil'));
  assert.deepStrictEqual(
    out.map((o) => o.label).slice().sort(),
    out.map((o) => o.label),
    'output must still be fully label-sorted after suffixing'
  );
}

// 18. Second corpus duplicate pair, 'NovaBillingUtil' (pkg-billing +
//     pkg-shared) -- confirms the suffixing logic isn't hard-coded to one
//     pair name, and that two INDEPENDENT duplicate groups in the same
//     refineTargets() call are each suffixed correctly without cross-talk.
{
  const input = [
    { label: 'AcmeOrderUtil', classLower: 'acmeorderutil', methodLower: null, package: 'force-app' },
    { label: 'AcmeOrderUtil', classLower: 'acmeorderutil', methodLower: null, package: 'nova-billing' },
    { label: 'NovaBillingUtil', classLower: 'novabillingutil', methodLower: null, package: 'nova-billing' },
    { label: 'NovaBillingUtil', classLower: 'novabillingutil', methodLower: null, package: 'nova-shared' },
    {
      label: 'NovaBillingUtil.auditPricingSync',
      classLower: 'novabillingutil',
      methodLower: 'auditpricingsync',
      package: 'nova-billing',
    },
    {
      label: 'NovaBillingUtil.auditPricingSync',
      classLower: 'novabillingutil',
      methodLower: 'auditpricingsync',
      package: 'nova-shared',
    },
  ];
  const out = refineTargets(input);
  const labels = out.map((o) => o.label).sort();
  assert.deepStrictEqual(labels, [
    'AcmeOrderUtil (force-app)',
    'AcmeOrderUtil (nova-billing)',
    'NovaBillingUtil (nova-billing)',
    'NovaBillingUtil (nova-shared)',
    'NovaBillingUtil.auditPricingSync (nova-billing)',
    'NovaBillingUtil.auditPricingSync (nova-shared)',
  ]);
}

// 19. Null/empty package, mixed with a real one, still distinguishes the
//     group via a '(no package)' fallback suffix rather than crashing or
//     silently merging the two.
{
  const input = [
    { label: 'Orphan', classLower: 'orphan', methodLower: null, package: null },
    { label: 'Orphan', classLower: 'orphan', methodLower: null, package: 'nova-shared' },
  ];
  const out = refineTargets(input);
  const labels = out.map((o) => o.label).sort();
  assert.deepStrictEqual(labels, ['Orphan (no package)', 'Orphan (nova-shared)'].sort());
}

// 20. Same-package trigger-collision dedupe (existing rule 3 behavior, test
//     6 above) is unaffected by the package field being present: a
//     class-level entry and its '(trigger)' pseudo-method sibling IN THE
//     SAME PACKAGE still collapse to one, exactly as before.
{
  const input = [
    { label: 'AcmeOrderTrigger', classLower: 'acmeordertrigger', methodLower: null, package: 'force-app' },
    { label: 'AcmeOrderTrigger', classLower: 'acmeordertrigger', methodLower: '(trigger)', package: 'force-app' },
  ];
  const out = refineTargets(input);
  assert.strictEqual(out.length, 1, 'same-package trigger collision must still collapse');
  assert.strictEqual(out[0].label, 'AcmeOrderTrigger', 'a non-duplicated (single-package) name is never suffixed');
  assert.strictEqual(out[0].package, 'force-app');
}

// 21. Idempotency: re-applying refineTargets() to its own package-suffixed
//     output must not double-append the suffix (mirrors test 12's
//     constructor-relabeling idempotency check).
{
  const input = [
    { label: 'AcmeOrderUtil', classLower: 'acmeorderutil', methodLower: null, package: 'force-app' },
    { label: 'AcmeOrderUtil', classLower: 'acmeorderutil', methodLower: null, package: 'nova-billing' },
  ];
  const once = refineTargets(input);
  const twice = refineTargets(once);
  assert.deepStrictEqual(twice, once, 'refineTargets must be idempotent when re-applied to its own suffixed output');
  assert.ok(
    !twice.some((o) => /\([^()]*\)\s*\([^()]*\)$/.test(o.label)),
    'must never double-suffix a package label'
  );
}

// 22. Defensive: a non-string `package` value (e.g. a stray number) is
//     treated as null-ish (falls back to the 'no package' bucket) rather
//     than throwing or producing a garbled label.
{
  const input = [
    { label: 'Weird', classLower: 'weird', methodLower: null, package: 42 },
    { label: 'Weird', classLower: 'weird', methodLower: null, package: 'nova-shared' },
  ];
  assert.doesNotThrow(() => refineTargets(input));
  const out = refineTargets(input);
  const labels = out.map((o) => o.label).sort();
  assert.deepStrictEqual(labels, ['Weird (no package)', 'Weird (nova-shared)'].sort());
}

// ===========================================================================
// v0.8 (N4/N6, forward-compat): '(managed)' suffix for external targets.
// resolver.js does not stamp kind:'external' onto suggestTargets() output
// yet (a different phase's job) -- every fixture below hand-builds the
// documented `{ ..., kind: 'external' }` shape rather than a real
// resolver.js run, exactly like this file's existing header comment already
// does for `package` (B3).
// ===========================================================================

// 23. A plain external target gets the exact ' (managed)' suffix, and its
//     `kind` is carried through onto the output item.
{
  const input = [{ label: 'zenq.Billing', classLower: 'zenq.billing', methodLower: null, kind: 'external' }];
  const out = refineTargets(input);
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].label, 'zenq.Billing (managed)', "exact N4/N6 CONTRACT-pinned wording, e.g. 'zenq.Billing (managed)'");
  assert.strictEqual(out[0].kind, 'external', 'kind is carried through onto the output item');
}

// 24. A non-external item (no `kind` at all -- every pre-v0.8 fixture) is
//     completely untouched: no suffix, no `kind` key on the output either.
{
  const input = [{ label: 'AcmeOrderUtil', classLower: 'acmeorderutil', methodLower: null }];
  const out = refineTargets(input);
  assert.strictEqual(out[0].label, 'AcmeOrderUtil', 'REGRESSION: no kind field -> no managed suffix');
  assert.ok(!Object.prototype.hasOwnProperty.call(out[0], 'kind'), 'REGRESSION: no kind field on input -> none on output either');
}

// 25. A non-'external' kind value (defensive -- resolver.js's contract only
//     ever stamps 'external' today, but this file reacts to the literal
//     string, not "any truthy kind") is carried through without a suffix.
{
  const input = [{ label: 'Foo', classLower: 'foo', methodLower: null, kind: 'method' }];
  const out = refineTargets(input);
  assert.strictEqual(out[0].label, 'Foo', "a kind other than 'external' never gets the managed suffix");
  assert.strictEqual(out[0].kind, 'method', 'kind is still carried through verbatim');
}

// 26. Idempotency: re-applying refineTargets() to its own managed-suffixed
//     output must not double-append the suffix (mirrors test 21's
//     package-suffix idempotency check and test 12's constructor one).
{
  const input = [{ label: 'kwx.LedgerService', classLower: 'kwx.ledgerservice', methodLower: null, kind: 'external' }];
  const once = refineTargets(input);
  const twice = refineTargets(once);
  assert.deepStrictEqual(twice, once, 'refineTargets must be idempotent when re-applied to its own managed-suffixed output');
  assert.ok(!twice.some((o) => / \(managed\) \(managed\)$/.test(o.label)), 'must never double-suffix "(managed)"');
}

// 27. The managed suffix combines correctly with constructor relabeling
//     (rule 2 runs first, then the managed suffix, per the header comment's
//     documented ordering) and still dedupes/sorts correctly alongside it.
{
  const input = [
    { label: 'zenq.Billing.<init>', classLower: 'zenq.billing', methodLower: '<init>', kind: 'external' },
    { label: 'AcmeOrderUtil', classLower: 'acmeorderutil', methodLower: null },
  ];
  const out = refineTargets(input);
  const billing = out.find((o) => o.classLower === 'zenq.billing');
  assert.strictEqual(billing.label, 'zenq.Billing (constructor) (managed)', 'constructor relabel happens BEFORE the managed suffix, per the documented rule ordering');
  assert.deepStrictEqual(out.map((o) => o.label), [...out.map((o) => o.label)].sort((a, b) => a.localeCompare(b)), 'output stays label-sorted with a managed entry mixed in');
}

// 28. An external item never participates in B3's duplicate-package
//     suffixing (it carries no `package` field at all in N4's design) --
//     confirms the two suffix mechanisms stay independent, no crash/
//     unexpected interaction when both an external and a same-classLower
//     dup-package item happen to coexist in one list.
{
  const input = [
    { label: 'Billing', classLower: 'billing', methodLower: null, package: 'force-app' },
    { label: 'Billing', classLower: 'billing', methodLower: null, package: 'nova-billing' },
    { label: 'zenq.Billing', classLower: 'zenq.billing', methodLower: null, kind: 'external' },
  ];
  assert.doesNotThrow(() => refineTargets(input));
  const out = refineTargets(input);
  const ext = out.find((o) => o.classLower === 'zenq.billing');
  assert.strictEqual(ext.label, 'zenq.Billing (managed)', 'external item unaffected by the unrelated same-list package-duplicate group');
  assert.ok(!Object.prototype.hasOwnProperty.call(ext, 'package'), 'external item never gains a package field it never had');
}

// 29. v0.14 Impact Analysis: a declaration-line cursor selects the exact
// overload; a call-site/other line deliberately returns null so the host
// can ask with a QuickPick instead of guessing.
{
  const methods = [
    { name: 'change', line: 4, params: [{ name: 'value', type: 'String' }] },
    { name: 'change', line: 8, params: [{ name: 'value', type: 'Integer' }] },
  ];
  assert.strictEqual(methodSignature(methods[0]), 'change(String)');
  const exact = findDeclarationOverload(methods, 'change', 8);
  assert(exact && exact.method === methods[1]);
  assert.strictEqual(exact.overloadSig, 'change(Integer)');
  assert.strictEqual(findDeclarationOverload(methods, 'change', 12), null, 'non-declaration line never guesses an overload');
  assert.strictEqual(findDeclarationOverload(methods, 'other', 8), null);
  assert.strictEqual(findDeclarationOverload(null, 'change', 8), null);
}

console.log('apex-trace targets.js self-check: all assertions passed');

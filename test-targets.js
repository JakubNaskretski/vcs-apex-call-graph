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
const { refineTargets } = require('./targets');

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

console.log('apex-trace targets.js self-check: all assertions passed');

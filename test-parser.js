'use strict';
// Self-check for parser.js: node test-parser.js
const assert = require('assert');
const { parseFile, baseName } = require('./parser');

const src = (lines) => lines.join('\n');

function findType(facts, qualified) {
  return facts.types.find((t) => t.qualified === qualified);
}

function findMethod(type, name) {
  return type.methods.find((m) => m.name === name);
}

// ===========================================================================
// baseName
// ===========================================================================
assert.strictEqual(baseName('/ws/force-app/classes/OppService.cls'), 'OppService');
assert.strictEqual(baseName('C:\\ws\\triggers\\OppTrigger.trigger'), 'OppTrigger');
assert.strictEqual(baseName('OppService.cls-meta.xml'), 'OppService');

// ===========================================================================
// 1. Methods + params + typed locals (incl. enhanced-for + catch variables,
//    which are NOT delivered via enterLocalVariableDeclaration)
// ===========================================================================
{
  const text = src([
    'public class OppService {',
    '  public Decimal applyDiscount(Id oppId, Decimal pct) {',
    '    Decimal total = 100;',
    '    List<Opportunity> opps = [SELECT Id FROM Opportunity WHERE Id = :oppId];',
    '    for (Opportunity opp : opps) {',
    '      total = total - pct;',
    '    }',
    '    try {',
    '      total = total / 1;',
    '    } catch (DivisionByZeroException dbze) {',
    '      total = 0;',
    '    }',
    '    return total;',
    '  }',
    '}',
  ]);
  const facts = parseFile({ path: 'OppService.cls', text });
  assert.strictEqual(facts.parseError, null, 'clean file parses without error');
  assert.strictEqual(facts.kind, 'class');
  assert.strictEqual(facts.name, 'OppService');
  assert.strictEqual(facts.types.length, 1);
  const type = facts.types[0];
  assert.strictEqual(type.name, 'OppService');
  assert.strictEqual(type.qualified, 'OppService');

  const m = findMethod(type, 'applyDiscount');
  assert.ok(m, 'method found');
  assert.strictEqual(m.isCtor, false);
  assert.strictEqual(m.isStatic, false);
  assert.strictEqual(m.returnType, 'Decimal');
  assert.deepStrictEqual(m.params, [
    { name: 'oppId', type: 'Id' },
    { name: 'pct', type: 'Decimal' },
  ]);
  const localNames = m.locals.map((l) => l.name);
  assert.ok(localNames.includes('total'), 'plain local variable captured');
  assert.ok(localNames.includes('opps'), 'typed collection local captured');
  assert.ok(localNames.includes('opp'), 'enhanced-for loop variable captured (pitfall fix)');
  assert.ok(localNames.includes('dbze'), 'catch-clause variable captured (pitfall fix)');
  const oppLocal = m.locals.find((l) => l.name === 'opp');
  assert.strictEqual(oppLocal.type, 'Opportunity');
  const dbzeLocal = m.locals.find((l) => l.name === 'dbze');
  assert.strictEqual(dbzeLocal.type, 'DivisionByZeroException');
  for (const l of m.locals) assert.strictEqual(typeof l.line, 'number');
}

// ===========================================================================
// 2/3. Dot calls (receiver + argTexts + source-faithful lineText) and bare calls
// ===========================================================================
{
  const text = src([
    'public class Caller {',
    '  public void run(Id oppId) {',
    '    OppService svc = new OppService();',
    "    svc.applyDiscount(oppId, 10 );",
    '    recompute();',
    '  }',
    '}',
  ]);
  const facts = parseFile({ path: 'Caller.cls', text });
  assert.strictEqual(facts.parseError, null);
  const m = findMethod(facts.types[0], 'run');
  const dot = m.calls.find((c) => c.kind === 'dot');
  assert.ok(dot, 'dot call captured');
  assert.strictEqual(dot.receiver, 'svc');
  assert.strictEqual(dot.method, 'applyDiscount');
  assert.deepStrictEqual(dot.argTexts, ['oppId', '10']);
  assert.strictEqual(dot.lineText, 'svc.applyDiscount(oppId, 10 );', 'lineText is the trimmed original source line');
  assert.strictEqual(dot.line, 4);
  assert.strictEqual(typeof dot.col, 'number');

  const bare = m.calls.find((c) => c.kind === 'bare' && c.method === 'recompute');
  assert.ok(bare, 'bare call captured');
  assert.strictEqual(bare.receiver, null);
  assert.deepStrictEqual(bare.argTexts, []);
}

// ===========================================================================
// 4. this()/super() constructor chains
// ===========================================================================
{
  const text = src([
    'public class Base {',
    '  public Base() {}',
    '}',
    'public class Sub extends Base {',
    '  public Sub() {',
    '    this(1);',
    '  }',
    '  public Sub(Integer x) {',
    '    super();',
    '  }',
    '}',
  ]);
  // Apex source files can only declare one top-level type; split into two
  // parses so each stays syntactically valid on its own.
  const baseFacts = parseFile({ path: 'Base.cls', text: src(['public class Base {', '  public Base() {}', '}']) });
  assert.strictEqual(baseFacts.parseError, null);

  const subFacts = parseFile({
    path: 'Sub.cls',
    text: src([
      'public class Sub extends Base {',
      '  public Sub() {',
      '    this(1);',
      '  }',
      '  public Sub(Integer x) {',
      '    super();',
      '  }',
      '}',
    ]),
  });
  assert.strictEqual(subFacts.parseError, null);
  const subType = subFacts.types[0];
  assert.strictEqual(subType.extendsType, 'Base');
  const ctors = subType.methods.filter((m) => m.isCtor);
  assert.strictEqual(ctors.length, 2, 'both constructor overloads present');
  const zeroArg = ctors.find((c) => c.params.length === 0);
  const oneArg = ctors.find((c) => c.params.length === 1);
  assert.strictEqual(zeroArg.calls[0].kind, 'bare');
  assert.strictEqual(zeroArg.calls[0].method, 'this');
  assert.deepStrictEqual(zeroArg.calls[0].argTexts, ['1']);
  assert.strictEqual(oneArg.calls[0].kind, 'bare');
  assert.strictEqual(oneArg.calls[0].method, 'super');
  assert.deepStrictEqual(oneArg.calls[0].argTexts, []);
}

// ===========================================================================
// 5/6. new-expressions (generics stripped from head) + constructors
// ===========================================================================
{
  const text = src([
    'public class Factory {',
    '  public Factory() {}',
    '  public Factory(Integer seed) {}',
    '  public void build() {',
    "    Handler h = new Handler(1, 'two');",
    '    Map<String, Object> m = new Map<String, Object>();',
    '    Outer.Inner nested = new Outer.Inner();',
    '  }',
    '}',
  ]);
  const facts = parseFile({ path: 'Factory.cls', text });
  assert.strictEqual(facts.parseError, null);
  const type = facts.types[0];
  const ctors = type.methods.filter((m) => m.isCtor);
  assert.strictEqual(ctors.length, 2);
  assert.ok(ctors.every((c) => c.name === 'Factory'), 'ctor MethodFacts.name is the declared (simple) class name');

  const m = findMethod(type, 'build');
  const newCalls = m.calls.filter((c) => c.kind === 'new');
  assert.strictEqual(newCalls.length, 3);
  const handlerNew = newCalls.find((c) => c.method === 'Handler');
  assert.deepStrictEqual(handlerNew.argTexts, ['1', "'two'"]);
  assert.strictEqual(handlerNew.receiver, null);
  const mapNew = newCalls.find((c) => c.method === 'Map');
  assert.ok(mapNew, 'generic head stripped: Map<String,Object> -> Map');
  const innerNew = newCalls.find((c) => c.method === 'Outer.Inner');
  assert.ok(innerNew, 'dotted created-type name preserved (not generics, left intact)');
}

// ===========================================================================
// 7. Inner classes qualified as Outer.Inner
// ===========================================================================
{
  const text = src([
    'public class Outer {',
    '  public void run() {',
    '    Inner i = new Inner();',
    '  }',
    '  public class Inner {',
    '    public void go() {',
    '      helper();',
    '    }',
    '    public class Deepest {',
    '      public void deep() {}',
    '    }',
    '  }',
    '}',
  ]);
  const facts = parseFile({ path: 'Outer.cls', text });
  assert.strictEqual(facts.parseError, null);
  assert.strictEqual(facts.types.length, 3, 'top-level + both inner types flattened');
  const outer = findType(facts, 'Outer');
  const inner = findType(facts, 'Outer.Inner');
  const deepest = findType(facts, 'Outer.Inner.Deepest');
  assert.ok(outer && inner && deepest, 'all three qualified names present');
  assert.strictEqual(inner.name, 'Inner');
  const go = findMethod(inner, 'go');
  assert.strictEqual(go.calls[0].method, 'helper', "Inner's own method calls attach to Inner, not Outer");
  const outerRun = findMethod(outer, 'run');
  assert.strictEqual(outerRun.calls.length, 1);
  assert.strictEqual(outerRun.calls[0].kind, 'new');
}

// ===========================================================================
// 8. Interfaces (incl. multi-extends -> first entry kept) + abstract methods
// ===========================================================================
{
  const text = src([
    'public interface Greeter extends Formal, Casual {',
    '  String greet(String name);',
    '  void reset();',
    '}',
  ]);
  const facts = parseFile({ path: 'Greeter.cls', text });
  assert.strictEqual(facts.parseError, null);
  const type = facts.types[0];
  assert.strictEqual(type.isInterface, true);
  assert.strictEqual(type.isEnum, false);
  assert.strictEqual(type.extendsType, 'Formal', 'multi-extends: first entry kept in the singular field (back-compat)');
  assert.deepStrictEqual(
    type.extendsTypes,
    ['Formal', 'Casual'],
    'G6: extendsTypes additively carries the FULL raw extends list (fixes diamond fan-out losing every parent after the first)'
  );
  assert.strictEqual(type.methods.length, 2);
  const greet = findMethod(type, 'greet');
  assert.strictEqual(greet.returnType, 'String');
  assert.deepStrictEqual(greet.params, [{ name: 'name', type: 'String' }]);
  assert.deepStrictEqual(greet.calls, [], 'interface methods have no body -> no calls');
  const reset = findMethod(type, 'reset');
  assert.strictEqual(reset.returnType, 'void');
}

// ===========================================================================
// 9. Properties with accessor bodies (+ auto-property gets an empty-calls
//    synthetic scope, so resolver.js A2 always has a real accessor to land
//    edges on -- auto-implemented accessors just have nothing to walk).
// ===========================================================================
{
  const text = src([
    'public class WithProps {',
    '  public Integer Total {',
    '    get { return computeTotal(); }',
    '    set { Total = recompute(value); }',
    '  }',
    '  public Integer AutoProp { get; set; }',
    '}',
  ]);
  const facts = parseFile({ path: 'WithProps.cls', text });
  assert.strictEqual(facts.parseError, null);
  const type = facts.types[0];
  assert.strictEqual(type.properties.length, 2);
  assert.ok(type.properties.some((p) => p.name === 'Total' && p.type === 'Integer'));
  assert.ok(type.properties.some((p) => p.name === 'AutoProp'));

  const getter = findMethod(type, '(get Total)');
  const setter = findMethod(type, '(set Total)');
  assert.ok(getter, 'getter body -> synthetic (get NAME) scope');
  assert.ok(setter, 'setter body -> synthetic (set NAME) scope');
  assert.strictEqual(getter.calls[0].method, 'computeTotal');
  assert.strictEqual(setter.calls[0].method, 'recompute');

  const autoGetter = findMethod(type, '(get AutoProp)');
  const autoSetter = findMethod(type, '(set AutoProp)');
  assert.ok(autoGetter, 'auto-implemented accessor STILL gets a synthetic (get NAME) scope');
  assert.ok(autoSetter, 'auto-implemented accessor STILL gets a synthetic (set NAME) scope');
  assert.strictEqual(autoGetter.calls.length, 0, 'no body -> nothing to walk -> empty calls');
  assert.strictEqual(autoSetter.calls.length, 0, 'no body -> nothing to walk -> empty calls');
}

// ===========================================================================
// 10/11. Annotations (incl. @AuraEnabled/@isTest, args stripped) + modifiers
//         (incl. webservice/testmethod)
// ===========================================================================
{
  const text = src([
    '@IsTest',
    'private class AnnotatedTest {',
    '  @AuraEnabled(cacheable=true)',
    '  public static Integer countThings() {',
    '    return 1;',
    '  }',
    '  @future',
    '  public static void runAsync() {}',
    '  webservice static void soapEntry() {}',
    '  static testMethod void legacyTest() {}',
    '}',
  ]);
  const facts = parseFile({ path: 'AnnotatedTest.cls', text });
  assert.strictEqual(facts.parseError, null);
  const type = facts.types[0];
  assert.deepStrictEqual(type.annotations, ['istest'], 'class annotation lowercased, no @');
  assert.strictEqual(
    Object.prototype.hasOwnProperty.call(type, 'modifiers'),
    false,
    'TypeFacts has no modifiers field per the frozen contract (only annotations)'
  );

  const countThings = findMethod(type, 'countThings');
  assert.deepStrictEqual(countThings.annotations, ['auraenabled'], 'annotation args stripped, bare name only');
  assert.ok(countThings.modifiers.includes('static'));
  assert.ok(countThings.modifiers.includes('public'));

  const runAsync = findMethod(type, 'runAsync');
  assert.deepStrictEqual(runAsync.annotations, ['future']);

  const soapEntry = findMethod(type, 'soapEntry');
  assert.ok(soapEntry.modifiers.includes('webservice'), 'webservice modifier captured lowercased');

  const legacyTest = findMethod(type, 'legacyTest');
  assert.ok(legacyTest.modifiers.includes('testmethod'), 'testmethod modifier captured lowercased');
}

// ===========================================================================
// 12. Trigger file (parser.triggerUnit()) — object/events, body calls,
//     nested method-in-trigger, field-in-trigger routed to '(init)'
// ===========================================================================
{
  const text = src([
    'trigger OppTrigger on Opportunity (before insert, after update) {',
    '  Integer counter = seedCounter();',
    '  handleThings();',
    '  static void helper() {',
    '    innerHelp();',
    '  }',
    '  for (Opportunity o : Trigger.new) {',
    '    o.validate();',
    '  }',
    '}',
  ]);
  const facts = parseFile({ path: 'OppTrigger.trigger', text });
  assert.strictEqual(facts.parseError, null);
  assert.strictEqual(facts.kind, 'trigger');
  assert.ok(facts.triggerInfo, 'triggerInfo populated');
  assert.strictEqual(facts.triggerInfo.object, 'Opportunity');
  assert.deepStrictEqual(facts.triggerInfo.events, ['before insert', 'after update']);
  assert.strictEqual(facts.types.length, 1, 'trigger pseudo-type is types[0]');
  const type = facts.types[0];
  assert.strictEqual(type.name, 'OppTrigger');

  const triggerScope = findMethod(type, '(trigger)');
  assert.ok(triggerScope, 'synthetic (trigger) method present');
  const triggerCallNames = triggerScope.calls.map((c) => c.method);
  assert.ok(triggerCallNames.includes('handleThings'), 'top-level trigger-body statement call captured');
  const dotCall = triggerScope.calls.find((c) => c.kind === 'dot');
  assert.strictEqual(dotCall.receiver, 'o');
  assert.strictEqual(dotCall.method, 'validate');

  const helper = findMethod(type, 'helper');
  assert.ok(helper, 'method declared directly inside a trigger body is captured');
  assert.strictEqual(helper.calls[0].method, 'innerHelp');
  assert.ok(
    !triggerScope.calls.some((c) => c.method === 'innerHelp'),
    "nested method's calls do not leak into the (trigger) scope"
  );

  const initScope = findMethod(type, '(init)');
  assert.ok(initScope, 'top-level trigger variable declaration routed through field+init handling');
  assert.strictEqual(initScope.calls[0].method, 'seedCounter');
  assert.ok(type.fields.some((f) => f.name === 'counter'), 'top-level trigger var registered as a field');
}

// ===========================================================================
// 13. Syntax-error file: parseFile NEVER throws, parseError set, partial facts kept
// ===========================================================================
{
  const text = src([
    'public class Broken {',
    '  public void run( {',
    '    doThing();',
    '  }',
    '  public void ok() {',
    '    fine();',
    '  }',
    '}',
  ]);
  let facts;
  assert.doesNotThrow(() => {
    facts = parseFile({ path: 'Broken.cls', text });
  }, 'parseFile must never throw on malformed syntax');
  assert.strictEqual(typeof facts.parseError, 'string');
  assert.ok(facts.parseError.length > 0);
  assert.strictEqual(facts.path, 'Broken.cls');
  assert.strictEqual(facts.name, 'Broken');
  // Partial facts: whatever the parser's error-recovery managed to salvage
  // before giving up is still present, not thrown away wholesale.
  assert.ok(facts.types.length >= 1, 'partial facts retained despite syntax error');
  assert.strictEqual(facts.types[0].name, 'Broken');
}

// ===========================================================================
// 14. BUG FIX regression: astral-plane (surrogate-pair) unicode character
//     earlier in the file must not corrupt later receiver/argTexts slicing.
//     @apexdevtools/apex-parser's CharStream counts Unicode CODE POINTS
//     (decodeToUnicodeCodePoints=true), while JS string indexing/slice()
//     counts UTF-16 code units -- a surrogate-pair character (e.g. an
//     emoji) anywhere earlier, even inside a comment, makes every later
//     char-offset slice land one JS index short without parser.js noticing.
// ===========================================================================
{
  const text = src([
    'public class AstralSlice {',
    '  // note: \u{1F389} celebrate', // 🎉, a surrogate pair in UTF-16
    '  public void m() {',
    '    svc.process(a, b);',
    '  }',
    '}',
  ]);
  const facts = parseFile({ path: 'AstralSlice.cls', text });
  assert.strictEqual(facts.parseError, null, 'a unicode comment must not itself cause a parse error');
  const type = findType(facts, 'AstralSlice');
  const call = findMethod(type, 'm').calls[0];
  assert.strictEqual(call.receiver, 'svc', 'receiver must slice correctly despite an earlier surrogate-pair character');
  assert.deepStrictEqual(call.argTexts, ['a', 'b'], 'argTexts must slice correctly despite an earlier surrogate-pair character');
}

// ===========================================================================
// 15. AMENDMENT A1: property accessor CallFacts (kind 'prop') -- plain read,
//     plain write, compound-assign write, and the "method-call-not-prop"
//     guard (x.Prop( must stay a 'dot' call, never also emit a 'prop').
// ===========================================================================
{
  const text = src([
    'public class PropAccess {',
    '  public void run(Holder h) {',
    '    Integer x = h.Total;',
    "    h.Status = 'Active';",
    '    h.Count += 5;',
    '    h.Total();',
    '  }',
    '}',
  ]);
  const facts = parseFile({ path: 'PropAccess.cls', text });
  assert.strictEqual(facts.parseError, null);
  const m = findMethod(facts.types[0], 'run');
  const propCalls = m.calls.filter((c) => c.kind === 'prop');

  const getTotal = propCalls.find((c) => c.accessor === 'get' && c.method === 'Total');
  assert.ok(getTotal, 'plain property read emits kind prop, accessor get');
  assert.strictEqual(getTotal.receiver, 'h');
  assert.deepStrictEqual(getTotal.argTexts, [], 'get has no argTexts');
  assert.strictEqual(getTotal.line, 3);
  assert.strictEqual(typeof getTotal.col, 'number');

  const setStatus = propCalls.find((c) => c.accessor === 'set' && c.method === 'Status');
  assert.ok(setStatus, 'plain property write emits kind prop, accessor set');
  assert.strictEqual(setStatus.receiver, 'h');
  assert.deepStrictEqual(setStatus.argTexts, ["'Active'"], 'set argTexts is [assignedValueText]');
  assert.strictEqual(setStatus.line, 4);

  const setCount = propCalls.find((c) => c.method === 'Count');
  assert.ok(setCount, 'compound-assign write (+=) also emits kind prop');
  assert.strictEqual(setCount.accessor, 'set', 'compound assign classified as set only, not get+set');
  assert.deepStrictEqual(setCount.argTexts, ['5'], 'compound-assign argTexts is just the RHS value text');
  assert.strictEqual(propCalls.filter((c) => c.method === 'Count').length, 1, 'compound assign yields exactly one prop entry, not a get+set pair');

  // method-call-not-prop guard: `h.Total()` must stay a plain 'dot' call and
  // must NOT also produce a 'prop' CallFacts entry for that same site.
  const dotTotal = m.calls.find((c) => c.kind === 'dot' && c.method === 'Total');
  assert.ok(dotTotal, 'h.Total() still captured as an ordinary dot call');
  assert.strictEqual(dotTotal.receiver, 'h');
  const propTotalCalls = propCalls.filter((c) => c.method === 'Total');
  assert.strictEqual(propTotalCalls.length, 1, 'h.Total() must not ALSO emit a prop CallFacts');
  assert.strictEqual(propTotalCalls[0].line, 3, 'the sole Total prop entry is the line-3 read, not the line-6 call site');
}

// ===========================================================================
// 16. MANIFEST validation (adv-org corpus, real file, read-only): parsing
//     AcmePropertyConsumer.cls must now yield kind 'prop' CallFacts for its
//     AcmeQuote.Status/.TotalAmount access sites -- this was the documented
//     `needs: accessors` gap (parser.js emitted NO CallFacts at all for a
//     bare property get/set). See MANIFEST.md's "Accessor-owning property
//     class" spot check and its `needs: accessors` ground-truth edges.
// ===========================================================================
{
  const fs = require('fs');
  const corpusPath =
    '/Users/agent/work/code/example-data/adv-org/force-app/main/default/classes/AcmePropertyConsumer.cls';
  const corpusText = fs.readFileSync(corpusPath, 'utf8');
  const facts = parseFile({ path: corpusPath, text: corpusText });
  assert.strictEqual(facts.parseError, null, 'AcmePropertyConsumer.cls parses cleanly');
  const type = facts.types[0];
  assert.strictEqual(type.name, 'AcmePropertyConsumer');

  const review = findMethod(type, 'reviewQuoteTotal');
  assert.ok(review, 'reviewQuoteTotal method found');
  const reviewNew = review.calls.find((c) => c.kind === 'new' && c.method === 'AcmeQuote');
  assert.ok(reviewNew, 'reviewQuoteTotal: new AcmeQuote(customerName) still resolves-today (via=new), unaffected');
  const reviewSet = review.calls.find((c) => c.kind === 'prop' && c.accessor === 'set');
  assert.ok(reviewSet, 'reviewQuoteTotal: quote.Status = ... now yields a prop set (closes needs:accessors gap)');
  assert.strictEqual(reviewSet.receiver, 'quote');
  assert.strictEqual(reviewSet.method, 'Status');
  assert.deepStrictEqual(reviewSet.argTexts, ["'Submitted'"]);
  const reviewGet = review.calls.find((c) => c.kind === 'prop' && c.accessor === 'get');
  assert.ok(reviewGet, 'reviewQuoteTotal: quote.TotalAmount now yields a prop get (closes needs:accessors gap)');
  assert.strictEqual(reviewGet.receiver, 'quote');
  assert.strictEqual(reviewGet.method, 'TotalAmount');
  assert.deepStrictEqual(reviewGet.argTexts, []);

  const sync = findMethod(type, 'syncQuoteStatus');
  assert.ok(sync, 'syncQuoteStatus method found');
  const syncSet = sync.calls.find((c) => c.kind === 'prop' && c.accessor === 'set');
  assert.ok(syncSet, 'syncQuoteStatus: quote.Status = newStatus yields a prop set');
  assert.strictEqual(syncSet.receiver, 'quote');
  assert.strictEqual(syncSet.method, 'Status');
  assert.deepStrictEqual(syncSet.argTexts, ['newStatus']);
  const syncGet = sync.calls.find((c) => c.kind === 'prop' && c.accessor === 'get' && c.method === 'TotalAmount');
  assert.ok(syncGet, 'syncQuoteStatus: quote.TotalAmount nested inside System.debug(...) still yields a prop get');
  assert.strictEqual(syncGet.receiver, 'quote');
  const debugCall = sync.calls.find((c) => c.kind === 'dot' && c.method === 'debug');
  assert.ok(debugCall, 'System.debug(...) dot call is untouched by the nested prop extraction');
  assert.strictEqual(debugCall.receiver, 'System');
  assert.strictEqual(
    debugCall.argTexts.length,
    1,
    'System.debug(...) keeps its single concatenation argText; nested prop extraction does not fragment it'
  );

  const threshold = findMethod(type, 'isQuoteOverThreshold');
  assert.ok(threshold, 'isQuoteOverThreshold method found');
  const thresholdProps = threshold.calls.filter((c) => c.kind === 'prop');
  assert.strictEqual(thresholdProps.length, 1, 'isQuoteOverThreshold has exactly one property access');
  assert.strictEqual(thresholdProps[0].accessor, 'get');
  assert.strictEqual(thresholdProps[0].receiver, 'quote');
  assert.strictEqual(thresholdProps[0].method, 'TotalAmount');
}

// ===========================================================================
// 17. AMENDMENT F1: DML statement facts (MethodFacts.dml[]) -- the five
//     "plain single-expression" statement forms (insert/update/delete/
//     undelete/upsert), attributed to the enclosing method-like scope the
//     same way calls are, and NOT double-emitted as CallFacts.
// ===========================================================================
{
  const text = src([
    'public class DmlOps {',
    '  public void doInsert(List<Account> accs) {',
    '    insert accs;',
    '  }',
    '  public void doUpdate(Account acc) {',
    '    update acc;',
    '  }',
    '  public void doDelete(List<Account> accs) {',
    '    delete accs;',
    '  }',
    '  public void doUndelete(List<Account> accs) {',
    '    undelete accs;',
    '  }',
    '  public void doUpsert(List<Account> accs) {',
    '    upsert accs;',
    '  }',
    '}',
  ]);
  const facts = parseFile({ path: 'DmlOps.cls', text });
  assert.strictEqual(facts.parseError, null);
  const type = facts.types[0];

  const doInsert = findMethod(type, 'doInsert');
  assert.strictEqual(doInsert.dml.length, 1);
  assert.strictEqual(doInsert.dml[0].op, 'insert');
  assert.strictEqual(doInsert.dml[0].targetText, 'accs');
  assert.strictEqual(doInsert.dml[0].line, 3);
  assert.strictEqual(typeof doInsert.dml[0].col, 'number');
  assert.strictEqual(doInsert.dml[0].lineText, 'insert accs;');
  assert.strictEqual(doInsert.calls.length, 0, 'a bare DML statement must not ALSO surface as a CallFacts entry');

  const doUpdate = findMethod(type, 'doUpdate');
  assert.strictEqual(doUpdate.dml.length, 1);
  assert.strictEqual(doUpdate.dml[0].op, 'update');
  assert.strictEqual(doUpdate.dml[0].targetText, 'acc');
  assert.strictEqual(doUpdate.dml[0].line, 6);

  const doDelete = findMethod(type, 'doDelete');
  assert.strictEqual(doDelete.dml.length, 1);
  assert.strictEqual(doDelete.dml[0].op, 'delete');
  assert.strictEqual(doDelete.dml[0].targetText, 'accs');

  const doUndelete = findMethod(type, 'doUndelete');
  assert.strictEqual(doUndelete.dml.length, 1);
  assert.strictEqual(doUndelete.dml[0].op, 'undelete');
  assert.strictEqual(doUndelete.dml[0].targetText, 'accs');

  const doUpsert = findMethod(type, 'doUpsert');
  assert.strictEqual(doUpsert.dml.length, 1);
  assert.strictEqual(doUpsert.dml[0].op, 'upsert');
  assert.strictEqual(doUpsert.dml[0].targetText, 'accs');
}

// ===========================================================================
// 18. F1: upsert-with-external-id-field form (`upsert x Field__c;`) -- the
//     trailing qualifiedName() external-id field is NOT part of targetText
//     (only the list/record expression is), though it still shows up in the
//     full lineText. Contrasted with the Database.insert()/update() METHOD
//     form, which needs no parser change at all -- it stays an ordinary
//     'dot' CallFacts (receiver 'Database') and produces NO dml fact.
// ===========================================================================
{
  const text = src([
    'public class UpsertVariants {',
    '  public void withExternalId(List<Account> accs) {',
    '    upsert accs External_Id__c;',
    '  }',
    '  public void withNamespacedExternalId(List<Account> accs) {',
    '    upsert accs Acme.External_Id__c;',
    '  }',
    '  public void viaDatabaseMethod(List<Account> accs) {',
    '    Database.insert(accs, false);',
    '  }',
    '}',
  ]);
  const facts = parseFile({ path: 'UpsertVariants.cls', text });
  assert.strictEqual(facts.parseError, null);
  const type = facts.types[0];

  const withExt = findMethod(type, 'withExternalId');
  assert.strictEqual(withExt.dml.length, 1, 'upsert-with-external-id-field still yields exactly one dml fact');
  assert.strictEqual(withExt.dml[0].op, 'upsert');
  assert.strictEqual(withExt.dml[0].targetText, 'accs', 'targetText is just the list expression; the external-id field is not folded in');
  assert.strictEqual(withExt.dml[0].lineText, 'upsert accs External_Id__c;', 'lineText still carries the full source line incl. the field');

  const withNs = findMethod(type, 'withNamespacedExternalId');
  assert.strictEqual(withNs.dml.length, 1, 'namespaced external-id field form also parses to exactly one dml fact');
  assert.strictEqual(withNs.dml[0].op, 'upsert');
  assert.strictEqual(withNs.dml[0].targetText, 'accs');

  const viaDb = findMethod(type, 'viaDatabaseMethod');
  assert.strictEqual(viaDb.dml.length, 0, 'Database.insert(...) method-form is NOT a DML statement -- no dml fact from parser.js');
  const dbCall = viaDb.calls.find((c) => c.kind === 'dot' && c.receiver === 'Database' && c.method === 'insert');
  assert.ok(dbCall, 'Database.insert(...) still flows through as an ordinary dot CallFacts (resolver.js maps the op name)');
}

// ===========================================================================
// 19. F1: merge two-arg statement forms -- targetText is the FIRST
//     (master/kept) expression, not the second (record(s)-to-merge), for
//     both the single-record and list-of-duplicates argument shapes.
// ===========================================================================
{
  const text = src([
    'public class MergeDemo {',
    '  public void run(Account master, Account dupe) {',
    '    merge master dupe;',
    '  }',
    '  public void runList(Account master, List<Account> dupes) {',
    '    merge master dupes;',
    '  }',
    '}',
  ]);
  const facts = parseFile({ path: 'MergeDemo.cls', text });
  assert.strictEqual(facts.parseError, null);
  const type = facts.types[0];

  const run = findMethod(type, 'run');
  assert.strictEqual(run.dml.length, 1);
  assert.strictEqual(run.dml[0].op, 'merge');
  assert.strictEqual(run.dml[0].targetText, 'master', 'merge targetText is the FIRST (master) expression, not the second');
  assert.strictEqual(run.dml[0].lineText, 'merge master dupe;', 'lineText still carries both operands');

  const runList = findMethod(type, 'runList');
  assert.strictEqual(runList.dml.length, 1);
  assert.strictEqual(runList.dml[0].op, 'merge');
  assert.strictEqual(runList.dml[0].targetText, 'master', 'merge master + list-of-duplicates form still targets the master record');
}

// ===========================================================================
// 20. F1: DML statement directly inside a trigger body (not inside any
//     nested method declared in the trigger) -- attributes to the synthetic
//     '(trigger)' scope, the same way top-level trigger-body CallFacts do.
// ===========================================================================
{
  const text = src([
    'trigger AccountTrigger on Account (before insert, after delete) {',
    '  handlePreamble();',
    '  if (Trigger.isBefore) {',
    '    List<Account> newAccs = Trigger.new;',
    '    insert newAccs;',
    '  }',
    '  for (Account a : Trigger.old) {',
    '    delete a;',
    '  }',
    '}',
  ]);
  const facts = parseFile({ path: 'AccountTrigger.trigger', text });
  assert.strictEqual(facts.parseError, null);
  assert.strictEqual(facts.kind, 'trigger');
  const type = facts.types[0];
  const triggerScope = findMethod(type, '(trigger)');
  assert.ok(triggerScope, 'synthetic (trigger) method present');

  assert.strictEqual(triggerScope.dml.length, 2, 'both trigger-body DML statements attribute to the (trigger) scope');
  const insertFact = triggerScope.dml.find((d) => d.op === 'insert');
  assert.ok(insertFact, 'insert statement inside an if-block in the trigger body is captured');
  assert.strictEqual(insertFact.targetText, 'newAccs');
  const deleteFact = triggerScope.dml.find((d) => d.op === 'delete');
  assert.ok(deleteFact, 'delete statement inside a for-loop in the trigger body is captured');
  assert.strictEqual(deleteFact.targetText, 'a');

  assert.ok(
    triggerScope.calls.some((c) => c.kind === 'bare' && c.method === 'handlePreamble'),
    'ordinary bare call in the trigger body is unaffected by DML extraction'
  );
}

// ===========================================================================
// 21. MANIFEST validation (adv-org corpus, real files, read-only): F1's
//     "DML -> trigger / record-triggered-flow linkage" section. Verifies
//     every AcmeFulfillmentDmlService.cls DML site against the MANIFEST's
//     "DML-site -> trigger edges" ground truth (op + targetText per method,
//     incl. the Database.xxx() method-form negative case), the four
//     pre-existing call sites newly exposed by F1, the DML-induced-cycle
//     fixture (AcmeShipmentRollupHandler.rollupTotals), and a full-corpus
//     regression pass confirming F1 adds no new parseError anywhere (same
//     invariant the Corpus agent's own verification pass checked: 59
//     .cls/.trigger files, exactly 1 parseError, AcmeBrokenParser.cls).
// ===========================================================================
{
  const fs = require('fs');
  const path = require('path');
  const forceAppRoot = '/Users/agent/work/code/example-data/adv-org/force-app';
  const classesDir = path.join(forceAppRoot, 'main/default/classes');
  const triggersDir = path.join(forceAppRoot, 'main/default/triggers');

  const parseCorpusFile = (p) => parseFile({ path: p, text: fs.readFileSync(p, 'utf8') });

  // --- AcmeFulfillmentDmlService.cls: every statement-form DML site ---
  const dmlServicePath = path.join(classesDir, 'AcmeFulfillmentDmlService.cls');
  const dmlServiceFacts = parseCorpusFile(dmlServicePath);
  assert.strictEqual(dmlServiceFacts.parseError, null, 'AcmeFulfillmentDmlService.cls parses cleanly');
  const dmlServiceType = dmlServiceFacts.types[0];
  assert.strictEqual(dmlServiceType.name, 'AcmeFulfillmentDmlService');

  const expectedDmlSites = {
    insertOrders: { op: 'insert', targetText: 'orders' },
    insertSingleShipment: { op: 'insert', targetText: 'shipment' },
    updateShipments: { op: 'update', targetText: 'shipments' },
    updateSingleOrder: { op: 'update', targetText: 'order' },
    deleteShipments: { op: 'delete', targetText: 'shipments' },
    deleteSingleOrder: { op: 'delete', targetText: 'order' },
    upsertOrders: { op: 'upsert', targetText: 'orders' },
    upsertSingleShipment: { op: 'upsert', targetText: 'shipment' },
    mergeShipments: { op: 'merge', targetText: 'masterShipment' },
    mergeOrders: { op: 'merge', targetText: 'masterOrder' },
    undeleteShipments: { op: 'undelete', targetText: 'shipments' },
  };
  for (const [methodName, expected] of Object.entries(expectedDmlSites)) {
    const m = findMethod(dmlServiceType, methodName);
    assert.ok(m, `${methodName} found in AcmeFulfillmentDmlService.cls`);
    assert.strictEqual(m.dml.length, 1, `${methodName} has exactly one dml fact`);
    assert.strictEqual(m.dml[0].op, expected.op, `${methodName} op`);
    assert.strictEqual(m.dml[0].targetText, expected.targetText, `${methodName} targetText`);
    assert.strictEqual(typeof m.dml[0].line, 'number');
    assert.strictEqual(typeof m.dml[0].col, 'number');
  }

  // Database.xxx() method-form sites: per the MANIFEST's documented
  // shadow-fixture caveat, parser.js emits NO dml fact for these -- they
  // stay ordinary 'dot' CallFacts with receiver 'Database' (verified live
  // by the Corpus agent; the DML-op-name special case is a resolver.js
  // ordering concern, not a parser.js extraction concern).
  const insertViaDb = findMethod(dmlServiceType, 'insertOrdersViaDatabase');
  assert.ok(insertViaDb, 'insertOrdersViaDatabase found');
  assert.strictEqual(insertViaDb.dml.length, 0, 'Database.insert() method-form yields no dml fact');
  assert.ok(
    insertViaDb.calls.some((c) => c.kind === 'dot' && c.receiver === 'Database' && c.method === 'insert'),
    'Database.insert(...) still an ordinary dot CallFacts'
  );
  const updateViaDb = findMethod(dmlServiceType, 'updateShipmentsViaDatabase');
  assert.ok(updateViaDb, 'updateShipmentsViaDatabase found');
  assert.strictEqual(updateViaDb.dml.length, 0, 'Database.update() method-form yields no dml fact');
  assert.ok(
    updateViaDb.calls.some((c) => c.kind === 'dot' && c.receiver === 'Database' && c.method === 'update'),
    'Database.update(...) still an ordinary dot CallFacts'
  );

  // --- pre-existing call sites newly exposed by F1 (see MANIFEST) ---
  const orderServiceFacts = parseCorpusFile(path.join(classesDir, 'AcmeOrderService.cls'));
  assert.strictEqual(orderServiceFacts.parseError, null);
  const recalc = findMethod(orderServiceFacts.types[0], 'recalculatePricing');
  assert.strictEqual(recalc.dml.length, 1);
  assert.strictEqual(recalc.dml[0].op, 'update');
  assert.strictEqual(recalc.dml[0].targetText, 'ord');
  assert.strictEqual(recalc.dml[0].line, 39, 'matches MANIFEST-cited classes/AcmeOrderService.cls:39');

  const orderUtilFacts = parseCorpusFile(path.join(classesDir, 'AcmeOrderUtil.cls'));
  assert.strictEqual(orderUtilFacts.parseError, null);
  const markApproved = findMethod(orderUtilFacts.types[0], 'markApproved');
  assert.strictEqual(markApproved.dml.length, 1);
  assert.strictEqual(markApproved.dml[0].op, 'update');
  assert.strictEqual(markApproved.dml[0].targetText, 'ord');
  assert.strictEqual(markApproved.dml[0].line, 22, 'matches MANIFEST-cited classes/AcmeOrderUtil.cls:22');

  const discountInvocableFacts = parseCorpusFile(path.join(classesDir, 'AcmeDiscountApprovalInvocable.cls'));
  assert.strictEqual(discountInvocableFacts.parseError, null);
  const discountExecute = findMethod(discountInvocableFacts.types[0], 'execute');
  assert.strictEqual(discountExecute.dml.length, 1);
  assert.strictEqual(discountExecute.dml[0].op, 'update');
  assert.strictEqual(discountExecute.dml[0].targetText, 'ord');
  assert.strictEqual(discountExecute.dml[0].line, 30, 'matches MANIFEST-cited classes/AcmeDiscountApprovalInvocable.cls:30');

  const shipmentServiceFacts = parseCorpusFile(path.join(classesDir, 'AcmeShipmentService.cls'));
  assert.strictEqual(shipmentServiceFacts.parseError, null);
  const scheduleDelivery = findMethod(shipmentServiceFacts.types[0], 'scheduleDelivery');
  assert.strictEqual(scheduleDelivery.dml.length, 1);
  assert.strictEqual(scheduleDelivery.dml[0].op, 'update');
  assert.strictEqual(
    scheduleDelivery.dml[0].targetText,
    'new Acme_Shipment__c(Id = shipmentId, EstimatedDelivery__c = eta)',
    'targetText is source-faithful even when the DML target is a `new` expression, not a plain identifier'
  );
  assert.strictEqual(scheduleDelivery.dml[0].line, 19, 'matches MANIFEST-cited classes/AcmeShipmentService.cls:19');

  // --- DML-induced-cycle fixture ---
  const rollupHandlerFacts = parseCorpusFile(path.join(classesDir, 'AcmeShipmentRollupHandler.cls'));
  assert.strictEqual(rollupHandlerFacts.parseError, null);
  const rollupTotals = findMethod(rollupHandlerFacts.types[0], 'rollupTotals');
  assert.strictEqual(rollupTotals.dml.length, 1);
  assert.strictEqual(rollupTotals.dml[0].op, 'update');
  assert.strictEqual(rollupTotals.dml[0].targetText, 'shipments');
  assert.strictEqual(rollupTotals.dml[0].line, 37);

  // --- new trigger + its handler wiring (ordinary, resolves-today; just a
  //     clean-parse regression check here, resolver.js owns the edges) ---
  const lifecycleTriggerFacts = parseCorpusFile(path.join(triggersDir, 'AcmeShipmentLifecycleTrigger.trigger'));
  assert.strictEqual(lifecycleTriggerFacts.parseError, null);
  assert.deepStrictEqual(lifecycleTriggerFacts.triggerInfo, { object: 'Acme_Shipment__c', events: ['before delete', 'after undelete'] });

  // --- full-corpus regression: F1 must not introduce any new parseError,
  //     and the total dml-fact count across the whole corpus must match the
  //     MANIFEST's accounting exactly (11 AcmeFulfillmentDmlService.cls
  //     statement-form sites + 4 pre-existing newly-exposed update sites +
  //     1 AcmeShipmentRollupHandler.rollupTotals site = 16; the 2
  //     Database.xxx() method-form sites are correctly excluded).
  function walkClsAndTriggerFiles(dir, out) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walkClsAndTriggerFiles(full, out);
      else if (/\.(cls|trigger)$/i.test(entry.name)) out.push(full);
    }
    return out;
  }
  const allFiles = walkClsAndTriggerFiles(forceAppRoot, []);
  // NOTE: this count tracks the corpus's actual .cls/.trigger file total,
  // which legitimately grows across rounds as later phases add fixtures
  // (59 at F1/v0.4 time -> 71 after the v0.5 round's initial 12 new
  // .cls/.trigger files -> 73 after the v0.5-round G6-diamond regression
  // fixture added 2 more: AcmeSecondaryIntf.cls + AcmeIntfDispatchSecondaryDemo.cls
  // -> 77 after this round's H2 (interface x override composition) Corpus
  // phase added 4 more: AcmeSurchargeStrategy.cls, AcmeStandardSurchargeStrategy.cls,
  // AcmeExpeditedSurchargeStrategy.cls, AcmeSurchargeRouter.cls
  // -- see test 28's MANIFEST validation section for the v0.5 count
  // cross-check). This literal is corpus-state, not parser-behavior; update
  // it here whenever the corpus grows rather than treating a drift as a
  // parser.js regression.
  assert.strictEqual(allFiles.length, 77, 'corpus has exactly 77 .cls/.trigger files (post-v0.5 + G6-diamond fix + H2 corpus fixtures)');
  let parseErrorCount = 0;
  let parseErrorPaths = [];
  let dmlFactTotal = 0;
  for (const p of allFiles) {
    const f = parseCorpusFile(p);
    if (f.parseError) {
      parseErrorCount++;
      parseErrorPaths.push(p);
    }
    for (const t of f.types || []) {
      for (const m of t.methods || []) {
        dmlFactTotal += (m.dml || []).length;
      }
    }
  }
  assert.strictEqual(parseErrorCount, 1, 'F1 introduces no new parseError across the whole corpus');
  assert.ok(parseErrorPaths[0].endsWith('AcmeBrokenParser.cls'), 'the sole parseError is still the deliberately-broken fixture');
  assert.strictEqual(dmlFactTotal, 16, 'total dml facts across the corpus matches the MANIFEST F1 site count');
}

// ===========================================================================
// 22. AMENDMENT G2: throw-new -- 'throw new AcmeX(...)' captures the
//     creator's (generics-stripped) type name into throwsSites, varName
//     null. The inner `new` expression is ALSO still an ordinary 'new'
//     CallFacts entry (same non-suppression convention F1 already
//     established for DML statements whose target is itself a `new`
//     expression -- see test 21's AcmeShipmentService.scheduleDelivery case).
// ===========================================================================
{
  const text = src([
    'public class ThrowNew {',
    '  public void run(Id x) {',
    "    throw new MyCustomException('bad input');",
    '  }',
    '}',
  ]);
  const facts = parseFile({ path: 'ThrowNew.cls', text });
  assert.strictEqual(facts.parseError, null);
  const m = findMethod(facts.types[0], 'run');
  assert.strictEqual(m.throwsSites.length, 1);
  const site = m.throwsSites[0];
  assert.strictEqual(site.typeName, 'MyCustomException');
  assert.strictEqual(site.varName, null, 'throw-new form: no varName');
  assert.strictEqual(site.line, 3);
  assert.strictEqual(typeof site.col, 'number');
  assert.strictEqual(site.lineText, "throw new MyCustomException('bad input');");

  const newCall = m.calls.find((c) => c.kind === 'new' && c.method === 'MyCustomException');
  assert.ok(newCall, "throw new X(...)'s creator sub-expression is still an ordinary 'new' CallFacts too");
}

// ===========================================================================
// 23. AMENDMENT G2: throw-var (caught-and-rethrown) -- 'throw e;' captures
//     typeName null + varName 'e' (resolver.js resolves e's type later via
//     the enclosing method's catches[]/locals[]/params). The catch clause
//     itself also lands in catches[], separate from throwsSites.
// ===========================================================================
{
  const text = src([
    'public class ThrowVar {',
    '  public void run() {',
    '    try {',
    '      risky();',
    '    } catch (MyCustomException e) {',
    '      throw e;',
    '    }',
    '  }',
    '}',
  ]);
  const facts = parseFile({ path: 'ThrowVar.cls', text });
  assert.strictEqual(facts.parseError, null);
  const m = findMethod(facts.types[0], 'run');

  assert.strictEqual(m.catches.length, 1);
  assert.deepStrictEqual(m.catches[0], { typeName: 'MyCustomException', varName: 'e', line: 5 });

  assert.strictEqual(m.throwsSites.length, 1);
  assert.strictEqual(m.throwsSites[0].typeName, null, 'throw-var form: typeName left null for resolver.js to resolve');
  assert.strictEqual(m.throwsSites[0].varName, 'e');
  assert.strictEqual(m.throwsSites[0].line, 6);
  assert.strictEqual(m.throwsSites[0].lineText, 'throw e;');

  // the catch var is ALSO still registered as an ordinary local (pre-existing
  // pitfall-fix behavior from test 1), unaffected by the new catches[] field.
  const eLocal = m.locals.find((l) => l.name === 'e');
  assert.ok(eLocal, 'catch var still registered in locals[] too');
  assert.strictEqual(eLocal.type, 'MyCustomException');
}

// ===========================================================================
// 24. AMENDMENT G2: multi-catch -- several catch clauses on ONE try
//     statement each produce their own catches[] entry, in source order.
// ===========================================================================
{
  const text = src([
    'public class MultiCatch {',
    '  public void run() {',
    '    try {',
    '      risky();',
    '    } catch (DmlException de) {',
    '      handleDml();',
    '    } catch (NullPointerException npe) {',
    '      handleNpe();',
    '    } catch (Exception ex) {',
    '      handleAny();',
    '    }',
    '  }',
    '}',
  ]);
  const facts = parseFile({ path: 'MultiCatch.cls', text });
  assert.strictEqual(facts.parseError, null);
  const m = findMethod(facts.types[0], 'run');
  assert.strictEqual(m.catches.length, 3, 'all three catch clauses on one try captured, in source order');
  assert.deepStrictEqual(m.catches.map((c) => c.typeName), ['DmlException', 'NullPointerException', 'Exception']);
  assert.deepStrictEqual(m.catches.map((c) => c.varName), ['de', 'npe', 'ex']);
  assert.deepStrictEqual(m.catches.map((c) => c.line), [5, 7, 9]);
  assert.deepStrictEqual(
    m.calls.map((c) => c.method),
    ['risky', 'handleDml', 'handleNpe', 'handleAny'],
    'each catch body call still attributes to the one enclosing method scope'
  );
}

// ===========================================================================
// 25. AMENDMENT G2: nested try -- a try/catch/finally block is NOT a
//     MethodFacts scope boundary, so a try nested inside another try's body
//     still attributes its throwsSites/catches to the SAME flat enclosing
//     method scope as the outer try, in source (depth-first) order.
// ===========================================================================
{
  const text = src([
    'public class NestedTry {',
    '  public void run() {',
    '    try {',
    '      try {',
    '        risky();',
    '      } catch (DmlException inner) {',
    '        throw inner;',
    '      }',
    '    } catch (Exception outer) {',
    '      handleOuter();',
    '    } finally {',
    '      cleanup();',
    '    }',
    '  }',
    '}',
  ]);
  const facts = parseFile({ path: 'NestedTry.cls', text });
  assert.strictEqual(facts.parseError, null);
  const m = findMethod(facts.types[0], 'run');

  assert.strictEqual(m.catches.length, 2, 'inner and outer catch clauses both land in the one flat catches[] list');
  assert.deepStrictEqual(m.catches.map((c) => c.typeName), ['DmlException', 'Exception']);
  assert.deepStrictEqual(m.catches.map((c) => c.varName), ['inner', 'outer']);

  assert.strictEqual(m.throwsSites.length, 1, 'the inner rethrow is captured');
  assert.strictEqual(m.throwsSites[0].varName, 'inner');
  assert.strictEqual(m.throwsSites[0].typeName, null);

  assert.ok(m.calls.some((c) => c.method === 'risky'), 'innermost try-body call captured');
  assert.ok(m.calls.some((c) => c.method === 'handleOuter'), 'outer catch-body call captured');
  assert.ok(m.calls.some((c) => c.method === 'cleanup'), 'finally-body call captured');
}

// ===========================================================================
// 26. AMENDMENT G3: instanceof narrowing -- 'x instanceof T' captures
//     {varName, typeName, line} for a simple-identifier receiver, wherever
//     the expression occurs (if-condition tested here; G3's "labeled
//     fallback" resolver behavior is not this parser test's concern -- the
//     parser records the narrowing unconditionally, regardless of whether
//     declared-type resolution would later succeed or fail). A non-
//     identifier receiver (a dotted method-call result) is never captured.
// ===========================================================================
{
  const text = src([
    'public class Narrowing {',
    '  public String label(Base b) {',
    '    if (b instanceof Concrete) {',
    '      return b.crateLabel();',
    '    }',
    '    return null;',
    '  }',
    '  public Boolean flag(Base b) {',
    '    return b instanceof Concrete;',
    '  }',
    '  public String other(Base b) {',
    '    if (b.getWrapped() instanceof Concrete) {',
    '      return null;',
    '    }',
    '    return null;',
    '  }',
    '}',
  ]);
  const facts = parseFile({ path: 'Narrowing.cls', text });
  assert.strictEqual(facts.parseError, null);
  const type = facts.types[0];

  const label = findMethod(type, 'label');
  assert.strictEqual(label.narrowings.length, 1);
  assert.deepStrictEqual(label.narrowings[0], { varName: 'b', typeName: 'Concrete', line: 3 });
  assert.ok(label.calls.some((c) => c.method === 'crateLabel'), 'narrowed-branch call still captured normally as an ordinary dot call');

  const flag = findMethod(type, 'flag');
  assert.strictEqual(flag.narrowings.length, 1, 'instanceof captured wherever it appears, not only inside an if-condition');
  assert.deepStrictEqual(flag.narrowings[0], { varName: 'b', typeName: 'Concrete', line: 9 });

  const other = findMethod(type, 'other');
  assert.strictEqual(
    other.narrowings.length,
    0,
    'non-identifier receiver (b.getWrapped()) is never captured -- G3 is simple-identifier-receiver only'
  );
}

// ===========================================================================
// 27. AMENDMENT G4: an .apex (anonymous Apex) fixture -- FileFacts.kind
//     'anonymous', a single pseudo-type named from the file stem, one
//     '(anonymous)' method carrying entries ['Anonymous Apex script'], and
//     ordinary call/dml/throw/catch/narrowing extraction all working
//     normally inside that one synthetic scope (scripts are pure roots, no
//     caller-side concerns at the parser level).
//
//     A top-level `Type x = expr;` declaration (no preceding statement) is
//     grammatically an anonymousMemberDeclaration -> fieldDeclaration, NOT a
//     statement -- verified live, and exactly the same shape a trigger
//     body's top-level var declarations already take (test 12: "top-level
//     trigger variable declaration routed through field+init handling").
//     Reusing that existing, already-tested field/(init) plumbing for
//     anonymous scripts is what "resolve normally" means here: `x`'s
//     initializer attributes to the type's synthetic '(init)' scope and `x`
//     itself is registered as a field, while every subsequent top-level
//     statement (the DML, the calls, the try/catch, the instanceof) still
//     attributes to '(anonymous)' as expected. This is exactly what the
//     real corpus fixture (scripts/adhoc-recalc.apex, validated in test 28)
//     does too -- both its `openOrders`/`pendingShipments` declarations are
//     top-level and take this same path.
// ===========================================================================
{
  const text = src([
    "Account acc = new Account(Name = 'Acme');",
    'insert acc;',
    'MyService.doWork(acc.Id);',
    'try {',
    '  MyService.risky();',
    '} catch (MyException e) {',
    '  System.debug(e.getMessage());',
    '  throw e;',
    '}',
    'if (acc instanceof SObject) {',
    "  System.debug('is sobject');",
    '}',
  ]);
  const facts = parseFile({ path: '/scripts/adhoc-test.apex', text });
  assert.strictEqual(facts.parseError, null, 'anonymous script parses cleanly via parser.anonymousUnit()');
  assert.strictEqual(facts.kind, 'anonymous');
  assert.strictEqual(facts.name, 'adhoc-test', 'pseudo-type name derived from the file stem, same baseName() as .cls/.trigger');
  assert.strictEqual(facts.triggerInfo, null, 'anonymous scripts carry no triggerInfo');
  assert.strictEqual(facts.types.length, 1, 'single synthetic pseudo-type');

  const type = facts.types[0];
  assert.strictEqual(type.name, 'adhoc-test');
  assert.strictEqual(type.qualified, 'adhoc-test');
  assert.ok(type.fields.some((f) => f.name === 'acc' && f.type === 'Account'), "top-level 'Account acc = ...' registered as a field, same as a trigger body's top-level var decl");

  const m = findMethod(type, '(anonymous)');
  assert.ok(m, 'synthetic (anonymous) method present');
  assert.strictEqual(m.isCtor, false);
  assert.deepStrictEqual(m.entries, ['Anonymous Apex script']);

  const initScope = findMethod(type, '(init)');
  assert.ok(initScope, "top-level declaration's initializer routed through the synthetic (init) scope, exactly like a trigger body");
  assert.ok(initScope.calls.some((c) => c.kind === 'new' && c.method === 'Account'), 'new Account(...) initializer call attributes to (init), not (anonymous)');

  assert.strictEqual(m.dml.length, 1, "'insert acc;' is its own top-level statement (not part of the field declaration) -- attributes to (anonymous)");
  assert.strictEqual(m.dml[0].op, 'insert');
  assert.strictEqual(m.dml[0].targetText, 'acc');

  const doWork = m.calls.find((c) => c.kind === 'dot' && c.method === 'doWork');
  assert.ok(doWork, 'ordinary dot call inside the anonymous script resolves normally');
  assert.strictEqual(doWork.receiver, 'MyService');
  assert.deepStrictEqual(doWork.argTexts, ['acc.Id']);

  assert.strictEqual(m.throwsSites.length, 1);
  assert.strictEqual(m.throwsSites[0].varName, 'e');
  assert.strictEqual(m.throwsSites[0].typeName, null);
  assert.strictEqual(m.catches.length, 1);
  assert.strictEqual(m.catches[0].typeName, 'MyException');
  assert.strictEqual(m.catches[0].varName, 'e');

  assert.strictEqual(m.narrowings.length, 1);
  assert.strictEqual(m.narrowings[0].varName, 'acc');
  assert.strictEqual(m.narrowings[0].typeName, 'SObject');

  // baseName() itself also strips the .apex extension directly.
  assert.strictEqual(baseName('/scripts/adhoc-test.apex'), 'adhoc-test');
  assert.strictEqual(baseName('adhoc-test.apex'), 'adhoc-test');
}

// ===========================================================================
// 28. MANIFEST validation (adv-org corpus, v0.5 section, real files,
//     read-only): G2 throw/catch sites, G3 narrowings, and the G4 anonymous
//     script fixture, cross-checked against MANIFEST.md's "## v0.5
//     ground-truth edges" section (G2/G3/G4 subsections + "Existing files
//     adjusted (v0.5)"), plus a full-corpus regression confirming the new
//     parser.js logic introduces no new parseError anywhere and the total
//     throwsSites/catches/narrowings counts across the whole corpus match
//     what MANIFEST.md documents.
// ===========================================================================
{
  const fs = require('fs');
  const path = require('path');
  const forceAppRoot = '/Users/agent/work/code/example-data/adv-org/force-app';
  const classesDir = path.join(forceAppRoot, 'main/default/classes');
  const triggersDir = path.join(forceAppRoot, 'main/default/triggers');
  const scriptsDir = '/Users/agent/work/code/example-data/adv-org/scripts';

  const parseCorpusFile = (p) => parseFile({ path: p, text: fs.readFileSync(p, 'utf8') });

  // --- G2 throw site 1: AcmeOrderValidator.cls#validate(Id,Integer) --------
  const validatorFacts = parseCorpusFile(path.join(classesDir, 'AcmeOrderValidator.cls'));
  assert.strictEqual(validatorFacts.parseError, null, 'AcmeOrderValidator.cls parses cleanly');
  const validate2 = validatorFacts.types[0].methods.find((m) => m.name === 'validate' && m.params.length === 2);
  assert.ok(validate2, 'validate(Id,Integer) overload found');
  assert.strictEqual(validate2.throwsSites.length, 1);
  assert.strictEqual(validate2.throwsSites[0].typeName, 'AcmeValidationException');
  assert.strictEqual(validate2.throwsSites[0].varName, null);
  assert.strictEqual(validate2.throwsSites[0].line, 9, 'matches MANIFEST-cited classes/AcmeOrderValidator.cls:9');

  // --- G2 throw site 2 + catch: AcmeShipmentService.cls#reprocessFailedShipment ---
  const shipmentServiceFacts = parseCorpusFile(path.join(classesDir, 'AcmeShipmentService.cls'));
  assert.strictEqual(shipmentServiceFacts.parseError, null, 'AcmeShipmentService.cls parses cleanly');
  const reprocess = shipmentServiceFacts.types[0].methods.find((m) => m.name === 'reprocessFailedShipment');
  assert.ok(reprocess, 'reprocessFailedShipment found (zero-caller-by-design leaf, per MANIFEST)');
  assert.strictEqual(reprocess.catches.length, 1);
  assert.strictEqual(reprocess.catches[0].typeName, 'AcmeValidationException');
  assert.strictEqual(reprocess.catches[0].varName, 'e');
  assert.strictEqual(reprocess.catches[0].line, 26, 'matches MANIFEST-cited classes/AcmeShipmentService.cls:26');
  assert.strictEqual(reprocess.throwsSites.length, 1);
  assert.strictEqual(reprocess.throwsSites[0].typeName, null, 'rethrow form -- resolver.js resolves via the catch above');
  assert.strictEqual(reprocess.throwsSites[0].varName, 'e');
  assert.strictEqual(reprocess.throwsSites[0].line, 28, 'matches MANIFEST-cited classes/AcmeShipmentService.cls:28');

  // --- G2 catch site 1 (exact type): AcmeOrderBatchProcessor.cls#execute ---
  const batchFacts = parseCorpusFile(path.join(classesDir, 'AcmeOrderBatchProcessor.cls'));
  assert.strictEqual(batchFacts.parseError, null);
  const batchExecute = batchFacts.types[0].methods.find((m) => m.name === 'execute');
  assert.strictEqual(batchExecute.catches.length, 1);
  assert.deepStrictEqual(batchExecute.catches[0], { typeName: 'AcmeValidationException', varName: 've', line: 29 });

  // --- G2 catch site 2 (supertype): AcmeOrderRestResource.cls#handlePost ---
  const restFacts = parseCorpusFile(path.join(classesDir, 'AcmeOrderRestResource.cls'));
  assert.strictEqual(restFacts.parseError, null);
  const handlePost = restFacts.types[0].methods.find((m) => m.name === 'handlePost');
  assert.strictEqual(handlePost.catches.length, 1);
  assert.deepStrictEqual(handlePost.catches[0], { typeName: 'AcmeBaseException', varName: 'be', line: 25 });
  const handleGet = restFacts.types[0].methods.find((m) => m.name === 'handleGet');
  assert.strictEqual(handleGet.catches.length, 0, 'handleGet is untouched (no try/catch)');

  // --- G2 catch site 3 (bare Exception): AcmeOrderTrigger.trigger ----------
  const orderTriggerFacts = parseCorpusFile(path.join(triggersDir, 'AcmeOrderTrigger.trigger'));
  assert.strictEqual(orderTriggerFacts.parseError, null);
  const orderTriggerScope = findMethod(orderTriggerFacts.types[0], '(trigger)');
  assert.strictEqual(orderTriggerScope.catches.length, 1);
  assert.deepStrictEqual(orderTriggerScope.catches[0], { typeName: 'Exception', varName: 'ex', line: 17 });
  // AcmeShipmentTrigger.trigger is documented as diverging from this (no try/catch at all).
  const shipmentTriggerFacts = parseCorpusFile(path.join(triggersDir, 'AcmeShipmentTrigger.trigger'));
  assert.strictEqual(shipmentTriggerFacts.parseError, null);
  const shipmentTriggerScope = findMethod(shipmentTriggerFacts.types[0], '(trigger)');
  assert.strictEqual(shipmentTriggerScope.catches.length, 0, 'AcmeShipmentTrigger.trigger has no try/catch, unlike AcmeOrderTrigger.trigger');

  // --- G2 negative: AcmeOrderServiceTest.cls#testProcessOrders has no catch ---
  const orderServiceTestFacts = parseCorpusFile(path.join(classesDir, 'AcmeOrderServiceTest.cls'));
  assert.strictEqual(orderServiceTestFacts.parseError, null);
  const testProcessOrders = orderServiceTestFacts.types[0].methods.find((m) => m.name === 'testProcessOrders');
  assert.ok(testProcessOrders, 'testProcessOrders found');
  assert.strictEqual(testProcessOrders.catches.length, 0, 'no try/catch anywhere -- the explicit no-badge negative from the MANIFEST');

  // --- G2 user exception hierarchy: AcmeValidationException -> AcmeBaseException -> Exception ---
  const baseExcFacts = parseCorpusFile(path.join(classesDir, 'AcmeBaseException.cls'));
  assert.strictEqual(baseExcFacts.parseError, null);
  assert.strictEqual(baseExcFacts.types[0].extendsType, 'Exception');
  const validationExcFacts = parseCorpusFile(path.join(classesDir, 'AcmeValidationException.cls'));
  assert.strictEqual(validationExcFacts.parseError, null);
  assert.strictEqual(validationExcFacts.types[0].extendsType, 'AcmeBaseException');

  // --- G3: AcmeShapeNarrowingAuditor.cls positive + negative -------------
  const narrowingAuditorFacts = parseCorpusFile(path.join(classesDir, 'AcmeShapeNarrowingAuditor.cls'));
  assert.strictEqual(narrowingAuditorFacts.parseError, null);
  const narrowingType = narrowingAuditorFacts.types[0];

  const auditLabel = findMethod(narrowingType, 'auditLabel');
  assert.strictEqual(auditLabel.narrowings.length, 1);
  assert.deepStrictEqual(auditLabel.narrowings[0], { varName: 'shape', typeName: 'AcmeShapeConcrete', line: 15 });
  assert.ok(
    auditLabel.calls.some((c) => c.kind === 'dot' && c.method === 'crateLabel' && c.receiver === 'shape'),
    'auditLabel: shape.crateLabel() call captured as an ordinary dot call, for narrowed resolution to land on'
  );

  const auditDescribeShape = findMethod(narrowingType, 'auditDescribeShape');
  assert.strictEqual(
    auditDescribeShape.narrowings.length,
    1,
    'the instanceof guard is textually present here too, so the parser records it -- whether resolver.js CONSULTS it is a resolver-side concern (declared-type resolution succeeds first), not a parser-side one'
  );
  assert.deepStrictEqual(auditDescribeShape.narrowings[0], { varName: 'shape', typeName: 'AcmeShapeConcrete', line: 22 });
  assert.ok(
    auditDescribeShape.calls.some((c) => c.kind === 'dot' && c.method === 'describeShape' && c.receiver === 'shape'),
    'auditDescribeShape: shape.describeShape() call captured normally'
  );

  // --- G4: scripts/adhoc-recalc.apex --------------------------------------
  const recalcPath = path.join(scriptsDir, 'adhoc-recalc.apex');
  const recalcFacts = parseCorpusFile(recalcPath);
  assert.strictEqual(recalcFacts.parseError, null, 'scripts/adhoc-recalc.apex now parses cleanly via parser.anonymousUnit() (was parseError-only pre-G4, per MANIFEST)');
  assert.strictEqual(recalcFacts.kind, 'anonymous');
  assert.strictEqual(recalcFacts.name, 'adhoc-recalc');
  assert.strictEqual(recalcFacts.types.length, 1);
  const recalcType = recalcFacts.types[0];
  // Both of the script's top-level declarations (openOrders, pendingShipments)
  // route through the field/(init) plumbing (see test 27's header note) --
  // '(anonymous)' + '(init)' is the correct, expected method set here, not
  // just '(anonymous)' alone.
  assert.ok(
    recalcType.fields.some((f) => f.name === 'openOrders') && recalcType.fields.some((f) => f.name === 'pendingShipments'),
    "both top-level SOQL-initialized locals registered as fields"
  );
  const recalcMethod = findMethod(recalcType, '(anonymous)');
  assert.ok(recalcMethod, 'synthetic (anonymous) method present');
  assert.deepStrictEqual(recalcMethod.entries, ['Anonymous Apex script']);

  const recalcPricingCall = recalcMethod.calls.find((c) => c.kind === 'dot' && c.receiver === 'AcmeOrderService' && c.method === 'recalculatePricing');
  assert.ok(recalcPricingCall, 'AcmeOrderService.recalculatePricing(...) call inside the for-loop captured');
  assert.strictEqual(recalcPricingCall.line, 15, 'matches MANIFEST-cited scripts/adhoc-recalc.apex:15');

  const scheduleDeliveryCall = recalcMethod.calls.find((c) => c.kind === 'dot' && c.receiver === 'AcmeShipmentService' && c.method === 'scheduleDelivery');
  assert.ok(scheduleDeliveryCall, 'AcmeShipmentService.scheduleDelivery(...) call inside the second for-loop captured');
  assert.strictEqual(scheduleDeliveryCall.line, 26, 'matches MANIFEST-cited scripts/adhoc-recalc.apex:26');

  assert.strictEqual(recalcMethod.dml.length, 1);
  assert.strictEqual(recalcMethod.dml[0].op, 'update');
  assert.strictEqual(recalcMethod.dml[0].targetText, 'openOrders');
  assert.strictEqual(recalcMethod.dml[0].line, 29, 'matches MANIFEST-cited scripts/adhoc-recalc.apex:29');

  assert.strictEqual(recalcMethod.throwsSites.length, 0);
  assert.strictEqual(recalcMethod.catches.length, 0);
  assert.strictEqual(recalcMethod.narrowings.length, 0);

  // --- G6 (diamond): classes/AcmeChildIntf.cls extends TWO parents --------
  const childIntfFacts = parseCorpusFile(path.join(classesDir, 'AcmeChildIntf.cls'));
  assert.strictEqual(childIntfFacts.parseError, null, 'AcmeChildIntf.cls parses cleanly');
  const childIntfType = childIntfFacts.types[0];
  assert.strictEqual(childIntfType.extendsType, 'AcmeParentIntf', 'singular field keeps the first entry (back-compat)');
  assert.deepStrictEqual(
    childIntfType.extendsTypes,
    ['AcmeParentIntf', 'AcmeSecondaryIntf'],
    'G6 fix: extendsTypes carries the FULL raw 2-parent extends list from the real corpus fixture, matching MANIFEST-cited classes/AcmeChildIntf.cls'
  );

  // --- full-corpus regression: G2/G3/G4 introduce no new parseError, and
  //     the total throwsSites/catches/narrowings tallies across the whole
  //     corpus match what's actually in the fixture files (verified above:
  //     4 throw sites -- AcmeOrderValidator.cls:9, AcmeShipmentService.cls:28,
  //     and 2 PRE-EXISTING v0.3/v0.4 throw sites in AcmeQuote.cls's
  //     validateStatusTransition that G2 newly exposes as parsed facts;
  //     4 catch sites -- the 4 MANIFEST-cited ones above; 2 narrowings --
  //     both AcmeShapeNarrowingAuditor.cls methods). ---
  function walkClsAndTriggerFiles(dir, out) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walkClsAndTriggerFiles(full, out);
      else if (/\.(cls|trigger)$/i.test(entry.name)) out.push(full);
    }
    return out;
  }
  const allFiles = walkClsAndTriggerFiles(forceAppRoot, []);
  assert.strictEqual(allFiles.length, 77, 'corpus has exactly 77 .cls/.trigger files (v0.5 round + G6-diamond regression fixture + H2 corpus fixtures)');
  let parseErrorCount = 0;
  let parseErrorPaths = [];
  let throwsSitesTotal = 0;
  let catchesTotal = 0;
  let narrowingsTotal = 0;
  for (const p of allFiles) {
    const f = parseCorpusFile(p);
    if (f.parseError) {
      parseErrorCount++;
      parseErrorPaths.push(p);
    }
    for (const t of f.types || []) {
      for (const m of t.methods || []) {
        throwsSitesTotal += (m.throwsSites || []).length;
        catchesTotal += (m.catches || []).length;
        narrowingsTotal += (m.narrowings || []).length;
      }
    }
  }
  assert.strictEqual(parseErrorCount, 1, 'G2/G3/G4 introduce no new parseError across the whole corpus');
  assert.ok(parseErrorPaths[0].endsWith('AcmeBrokenParser.cls'), 'the sole parseError is still the deliberately-broken fixture');
  assert.strictEqual(throwsSitesTotal, 4, 'total throw sites across the .cls/.trigger corpus (the .apex script is walked separately above)');
  assert.strictEqual(catchesTotal, 4, 'total catch sites across the corpus matches the 4 MANIFEST-cited G2 catch sites');
  assert.strictEqual(narrowingsTotal, 2, 'total narrowings across the corpus matches AcmeShapeNarrowingAuditor.cls\'s 2 methods');
}

// ===========================================================================
// 29. PARSER CONTRACT (v0.11 Round B / B1): locals[].literal -- single
//     string-literal initializer, cleared if the parser proves a
//     reassignment (assignment/compound-assignment/inc-dec, anywhere in the
//     method body). Uses the real corpus fixture (VtxDynamicFactory.cls)
//     that was purpose-built for this contract, one method per sub-shape.
// ===========================================================================
{
  const fs = require('fs');
  const path = require('path');
  const classesDir = '/Users/agent/work/code/example-data/gauntlet-org/force-app/main/default/classes';
  const parseCorpusFile = (p) => parseFile({ path: p, text: fs.readFileSync(p, 'utf8') });

  const factoryFacts = parseCorpusFile(path.join(classesDir, 'VtxDynamicFactory.cls'));
  assert.strictEqual(factoryFacts.parseError, null, 'VtxDynamicFactory.cls parses cleanly');
  const factoryType = factoryFacts.types[0];

  const literalLocal = findMethod(factoryType, 'createFromLiteralLocal');
  const hn1 = literalLocal.locals.find((l) => l.name === 'handlerName');
  assert.ok(hn1, '(a) handlerName local found');
  assert.strictEqual(hn1.literal, 'VtxRouterHandler', '(a) single-literal initializer, never reassigned -> literal set to the unquoted value');

  const reassignedLocal = findMethod(factoryType, 'createFromReassignedLocal');
  const hn2 = reassignedLocal.locals.find((l) => l.name === 'handlerName');
  assert.ok(hn2, '(a-neg) handlerName local found');
  assert.strictEqual(
    Object.prototype.hasOwnProperty.call(hn2, 'literal'),
    false,
    '(a-neg) same single-literal-initializer shape, but reassigned later in the method (even inside a conditional) -> literal must be absent'
  );

  // (b)/(b-neg) shapes touch cross-class constant resolution -- a
  // resolver.js concern. The LOCAL side of this same method (handlerType)
  // is itself declared via Type.forName(...), a non-literal initializer --
  // not a param, but still correctly ineligible for locals[].literal.
  const ownConstant = findMethod(factoryType, 'createFromOwnConstant');
  const handlerTypeLocal = ownConstant.locals.find((l) => l.name === 'handlerType');
  assert.ok(handlerTypeLocal, '(b) own-constant method declares one local (handlerType)');
  assert.strictEqual(
    Object.prototype.hasOwnProperty.call(handlerTypeLocal, 'literal'),
    false,
    '(b) handlerType is initialized from a Type.forName(...) call, not a literal -- literal must be absent'
  );

  const paramFed = findMethod(factoryType, 'createFromParam');
  assert.deepStrictEqual(paramFed.locals.map((l) => l.name), ['handlerType'], '(e) createFromParam declares one local (handlerType); handlerName is a param, never eligible for literal[]');
}

// ===========================================================================
// 30. PARSER CONTRACT (v0.11 Round B / B1): locals[].literal reassignment
//     proof, exhaustive operator coverage -- plain '=', every compound-
//     assign operator, prefix/postfix '++'/'--', and the negative case
//     (unary +/- must NOT count as a mutation, since PreOpExpressionContext
//     covers both shapes in one grammar production).
// ===========================================================================
{
  const text = src([
    'public class LiteralReassignCoverage {',
    '  public void plainAssign() {',
    "    String a = 'x';",
    "    a = 'y';",
    '  }',
    '  public void compoundAssign() {',
    "    String b = 'x';",
    "    b += 'y';",
    '  }',
    '  public void postIncrement() {',
    "    String c = 'x';",
    '    c++;',
    '  }',
    '  public void preDecrement() {',
    "    String d = 'x';",
    '    --d;',
    '  }',
    '  public void unaryMinusIsNotAMutation() {',
    '    Integer e = 5;',
    '    Integer f = -e;',
    '  }',
    '  public void neverReassigned() {',
    "    String g = 'x';",
    '    System.debug(g);',
    '  }',
    '  public void concatenationInitializer() {',
    "    String h = 'x' + 'y';",
    '  }',
    '  public void methodCallInitializer() {',
    '    String i = computeName();',
    '  }',
    '  public String computeName() { return null; }',
    '}',
  ]);
  const facts = parseFile({ path: 'LiteralReassignCoverage.cls', text });
  assert.strictEqual(facts.parseError, null);
  const type = facts.types[0];
  const localOf = (methodName, varName) => findMethod(type, methodName).locals.find((l) => l.name === varName);
  const hasLiteral = (methodName, varName) => Object.prototype.hasOwnProperty.call(localOf(methodName, varName), 'literal');

  assert.strictEqual(hasLiteral('plainAssign', 'a'), false, "plain '=' reassignment clears literal");
  assert.strictEqual(hasLiteral('compoundAssign', 'b'), false, "compound '+=' reassignment clears literal");
  assert.strictEqual(hasLiteral('postIncrement', 'c'), false, "postfix '++' clears literal");
  assert.strictEqual(hasLiteral('preDecrement', 'd'), false, "prefix '--' clears literal");
  assert.strictEqual(localOf('neverReassigned', 'g').literal, 'x', 'never-reassigned single-literal local keeps literal');
  assert.strictEqual(hasLiteral('concatenationInitializer', 'h'), false, 'concatenation initializer is not a single literal -> literal absent from the start');
  assert.strictEqual(hasLiteral('methodCallInitializer', 'i'), false, 'method-call initializer is not a literal -> literal absent from the start');

  // unary minus: `Integer f = -e;` must NOT mark `e` reassigned (PreOpExpressionContext
  // ADD()/SUB() shape, not INC()/DEC()) -- there is no String literal local
  // in this method to check directly, so assert on a parallel local instead.
  const unaryText = src([
    'public class UnaryMinusCoverage {',
    '  public void run() {',
    "    String j = 'x';",
    '    Integer k = 5;',
    '    Integer m = -k;',
    '    System.debug(j);',
    '  }',
    '}',
  ]);
  const unaryFacts = parseFile({ path: 'UnaryMinusCoverage.cls', text: unaryText });
  assert.strictEqual(unaryFacts.parseError, null);
  const unaryMethod = findMethod(unaryFacts.types[0], 'run');
  const jLocal = unaryMethod.locals.find((l) => l.name === 'j');
  assert.strictEqual(jLocal.literal, 'x', "unrelated local 'j' unaffected by a unary-minus expression on a different variable ('k')");
}

// ===========================================================================
// 31. PARSER CONTRACT (v0.11 Round B / B1): TypeFacts.constants -- static
//     final String fields with a single-literal initializer, using the real
//     corpus fixture (VtxHandlerNames.cls) purpose-built for this contract:
//     ROUTER qualifies; LEGACY_HANDLER_NAME (non-final) and
//     COMPUTED_HANDLER_NAME (final but non-literal initializer) both must
//     NOT appear in TypeFacts.constants at all.
// ===========================================================================
{
  const fs = require('fs');
  const path = require('path');
  const classesDir = '/Users/agent/work/code/example-data/gauntlet-org/force-app/main/default/classes';
  const parseCorpusFile = (p) => parseFile({ path: p, text: fs.readFileSync(p, 'utf8') });

  const namesFacts = parseCorpusFile(path.join(classesDir, 'VtxHandlerNames.cls'));
  assert.strictEqual(namesFacts.parseError, null, 'VtxHandlerNames.cls parses cleanly');
  const namesType = namesFacts.types[0];

  assert.deepStrictEqual(
    namesType.constants,
    [{ name: 'ROUTER', literal: 'VtxRouterHandler' }],
    'ONLY the static-final-String-literal ROUTER qualifies; the non-final and non-literal-init siblings are excluded entirely, not just marked'
  );
  assert.ok(
    namesType.fields.some((f) => f.name === 'LEGACY_HANDLER_NAME'),
    'LEGACY_HANDLER_NAME is still an ordinary field -- only excluded from constants[], not from fields[]'
  );
  assert.ok(
    namesType.fields.some((f) => f.name === 'COMPUTED_HANDLER_NAME'),
    'COMPUTED_HANDLER_NAME is still an ordinary field -- only excluded from constants[], not from fields[]'
  );

  // Own-class qualifying constant (VtxDynamicFactory.cls's ESCALATION_HANDLER)
  // -- cross-checked here too since it's the "bare-reference, own class"
  // half of the (b) contract shape (VtxHandlerNames.ROUTER above covers the
  // "qualified, cross-class" half).
  const factoryFacts = parseCorpusFile(path.join(classesDir, 'VtxDynamicFactory.cls'));
  assert.strictEqual(factoryFacts.parseError, null);
  assert.deepStrictEqual(
    factoryFacts.types[0].constants,
    [{ name: 'ESCALATION_HANDLER', literal: 'VtxEscalationHandler' }],
    'own-class static-final-String-literal constant captured'
  );
}

// ===========================================================================
// 32. PARSER CONTRACT (v0.11 Round B / B1): TypeFacts.constants negative
//     coverage the real corpus fixtures don't isolate individually -- non-
//     static final String (instance-level), non-String static final
//     (Integer), and multi-declarator field lines where only some
//     declarators qualify.
// ===========================================================================
{
  const text = src([
    'public class ConstantsCoverage {',
    "  public static final String QUALIFIES = 'yes';",
    "  public final String instanceLevelNotStatic = 'no';", // final but not static
    '  public static final Integer NOT_A_STRING = 5;', // static+final but not String
    "  public static String notFinal = 'no';", // static but not final
    "  public static final String multiA = 'a', multiB = computeIt();", // mixed declarators on one line
    '  private static String computeIt() { return \'z\'; }',
    '}',
  ]);
  const facts = parseFile({ path: 'ConstantsCoverage.cls', text });
  assert.strictEqual(facts.parseError, null);
  const type = facts.types[0];

  const names = type.constants.map((c) => c.name).sort();
  assert.deepStrictEqual(names, ['QUALIFIES', 'multiA'].sort(), 'only the two genuinely static+final+String+single-literal fields qualify');
  assert.strictEqual(type.constants.find((c) => c.name === 'QUALIFIES').literal, 'yes');
  assert.strictEqual(type.constants.find((c) => c.name === 'multiA').literal, 'a', 'multi-declarator line: the literal-initialized declarator qualifies even though its sibling on the same line does not');
  assert.ok(!type.constants.some((c) => c.name === 'multiB'), 'multi-declarator line: the method-call-initialized sibling does NOT qualify');
  assert.ok(!type.constants.some((c) => c.name === 'instanceLevelNotStatic'), 'final-but-not-static excluded');
  assert.ok(!type.constants.some((c) => c.name === 'NOT_A_STRING'), 'static+final-but-not-String excluded');
  assert.ok(!type.constants.some((c) => c.name === 'notFinal'), 'static-but-not-final excluded');

  // Every TypeFacts still carries `constants` as an array uniformly, even
  // when empty -- checked on a plain interface (which can never itself
  // declare a field, but should still get the shape).
  const ifaceFacts = parseFile({ path: 'Empty.cls', text: src(['public interface Empty {', '  void go();', '}']) });
  assert.strictEqual(ifaceFacts.parseError, null);
  assert.deepStrictEqual(ifaceFacts.types[0].constants, [], 'interfaces get an empty constants[] uniformly, never undefined/absent');
}

// ===========================================================================
// 33. FileFacts SNAPSHOT PIN (v0.11 Round B / B1): 3 diverse PRE-EXISTING
//     gauntlet-org corpus files (none touched by the v0.11 Round B corpus
//     phase -- a class with fields/generics/DML/nested-dot-chains, a plain
//     trigger, and a class with SOQL/casts/an existing Type.forName(param)
//     call), deep-compared against parseFile() output CAPTURED BEFORE this
//     round's parser.js changes existed (commit 0e3d24a, "0.10.0"), with
//     the two new additive fields (TypeFacts.constants, locals[].literal)
//     stripped from the FRESH output first. Proves every other field --
//     calls/dml/throwsSites/catches/narrowings/fields/properties/params/
//     annotations/modifiers/line/col/lineText/kind/triggerInfo/... -- is
//     byte-identical, i.e. this round's parser.js changes are additive-only,
//     exactly per the v0.11 REGRESSION POLICY ("Everything else byte-
//     identical"). Regenerate BASELINE_JSON only if these 3 specific corpus
//     files are ever legitimately edited upstream (they are frozen fixtures
//     from earlier gauntlet-org rounds, not this round's own additions, so
//     that should never happen in the ordinary course of this contract).
// ===========================================================================
{
  const fs = require('fs');

  const BASELINE_JSON = `[{"path":"/Users/agent/work/code/example-data/gauntlet-org/force-app/main/default/classes/KappaUnitOfWork.cls","kind":"class","name":"KappaUnitOfWork","parseError":null,"triggerInfo":null,"types":[{"name":"KappaUnitOfWork","qualified":"KappaUnitOfWork","isInterface":false,"isEnum":false,"extendsType":null,"implementsTypes":[],"annotations":[],"fields":[{"name":"newRecordsByType","type":"Map<Schema.SObjectType,List<SObject>>","isStatic":false}],"properties":[],"methods":[{"name":"(init)","isCtor":false,"isStatic":false,"returnType":null,"line":13,"endLine":13,"annotations":[],"modifiers":[],"params":[],"locals":[],"calls":[{"kind":"new","receiver":null,"method":"Map","argTexts":[],"lineText":"private Map<Schema.SObjectType, List<SObject>> newRecordsByType = new Map<Schema.SObjectType, List<SObject>>();","line":13,"col":70}],"dml":[],"throwsSites":[],"catches":[],"narrowings":[]},{"name":"registerNew","isCtor":false,"isStatic":false,"returnType":"void","line":15,"endLine":21,"annotations":[],"modifiers":["public"],"params":[{"name":"record","type":"SObject"}],"locals":[{"name":"tkey","type":"Schema.SObjectType","line":16}],"calls":[{"kind":"dot","receiver":"record","method":"getSObjectType","argTexts":[],"lineText":"Schema.SObjectType tkey = record.getSObjectType();","line":16,"col":34},{"kind":"dot","receiver":"newRecordsByType","method":"containsKey","argTexts":["tkey"],"lineText":"if (!newRecordsByType.containsKey(tkey)) {","line":17,"col":13},{"kind":"dot","receiver":"newRecordsByType","method":"put","argTexts":["tkey","new List<SObject>()"],"lineText":"newRecordsByType.put(tkey, new List<SObject>());","line":18,"col":12},{"kind":"new","receiver":null,"method":"List","argTexts":[],"lineText":"newRecordsByType.put(tkey, new List<SObject>());","line":18,"col":39},{"kind":"dot","receiver":"newRecordsByType.get(tkey)","method":"add","argTexts":["record"],"lineText":"newRecordsByType.get(tkey).add(record);","line":20,"col":8},{"kind":"dot","receiver":"newRecordsByType","method":"get","argTexts":["tkey"],"lineText":"newRecordsByType.get(tkey).add(record);","line":20,"col":8}],"dml":[],"throwsSites":[],"catches":[],"narrowings":[]},{"name":"commitWork","isCtor":false,"isStatic":false,"returnType":"void","line":23,"endLine":28,"annotations":[],"modifiers":["public"],"params":[],"locals":[{"name":"tkey","type":"Schema.SObjectType","line":24},{"name":"records","type":"List<SObject>","line":25}],"calls":[{"kind":"dot","receiver":"newRecordsByType","method":"keySet","argTexts":[],"lineText":"for (Schema.SObjectType tkey : newRecordsByType.keySet()) {","line":24,"col":39},{"kind":"dot","receiver":"newRecordsByType","method":"get","argTexts":["tkey"],"lineText":"List<SObject> records = newRecordsByType.get(tkey);","line":25,"col":36}],"dml":[{"op":"insert","targetText":"records","line":26,"col":12,"lineText":"insert records;"}],"throwsSites":[],"catches":[],"narrowings":[]},{"name":"insertDirect","isCtor":false,"isStatic":false,"returnType":"void","line":34,"endLine":36,"annotations":[],"modifiers":["public"],"params":[{"name":"order","type":"Kappa_Order__c"}],"locals":[],"calls":[],"dml":[{"op":"insert","targetText":"order","line":35,"col":8,"lineText":"insert order;"}],"throwsSites":[],"catches":[],"narrowings":[]}]}]},{"path":"/Users/agent/work/code/example-data/gauntlet-org/force-app/main/default/triggers/KappaOrderUowTrigger.trigger","kind":"trigger","name":"KappaOrderUowTrigger","parseError":null,"triggerInfo":{"object":"Kappa_Order__c","events":["after insert"]},"types":[{"name":"KappaOrderUowTrigger","qualified":"KappaOrderUowTrigger","isInterface":false,"isEnum":false,"extendsType":null,"implementsTypes":[],"annotations":[],"fields":[],"properties":[],"methods":[{"name":"(trigger)","isCtor":false,"isStatic":false,"returnType":null,"line":5,"endLine":7,"annotations":[],"modifiers":[],"params":[],"locals":[],"calls":[{"kind":"dot","receiver":"System","method":"debug","argTexts":["'kappa order uow trigger fired'"],"lineText":"System.debug('kappa order uow trigger fired');","line":6,"col":4}],"dml":[],"throwsSites":[],"catches":[],"narrowings":[]}]}]},{"path":"/Users/agent/work/code/example-data/gauntlet-org/force-app/main/default/classes/KappaGenericTriggerDispatcher.cls","kind":"class","name":"KappaGenericTriggerDispatcher","parseError":null,"triggerInfo":null,"types":[{"name":"KappaGenericTriggerDispatcher","qualified":"KappaGenericTriggerDispatcher","isInterface":false,"isEnum":false,"extendsType":null,"implementsTypes":[],"annotations":[],"fields":[],"properties":[],"methods":[{"name":"dispatch","isCtor":false,"isStatic":false,"returnType":"void","line":11,"endLine":26,"annotations":[],"modifiers":["public"],"params":[{"name":"sobjectApiName","type":"String"}],"locals":[{"name":"configs","type":"List<Kappa_Trigger_Config__mdt>","line":12},{"name":"config","type":"Kappa_Trigger_Config__mdt","line":18},{"name":"handlerType","type":"Type","line":19},{"name":"handler","type":"KappaTriggerHandler","line":23}],"calls":[{"kind":"dot","receiver":"Type","method":"forName","argTexts":["config.Handler_Class_Name__c"],"lineText":"Type handlerType = Type.forName(config.Handler_Class_Name__c);","line":19,"col":31},{"kind":"prop","accessor":"get","receiver":"config","method":"Handler_Class_Name__c","argTexts":[],"lineText":"Type handlerType = Type.forName(config.Handler_Class_Name__c);","line":19,"col":44},{"kind":"dot","receiver":"handlerType","method":"newInstance","argTexts":[],"lineText":"KappaTriggerHandler handler = (KappaTriggerHandler) handlerType.newInstance();","line":23,"col":64},{"kind":"dot","receiver":"handler","method":"run","argTexts":[],"lineText":"handler.run();","line":24,"col":12}],"dml":[],"throwsSites":[],"catches":[],"narrowings":[]}]}]}]`;

  const baseline = JSON.parse(BASELINE_JSON);
  assert.strictEqual(baseline.length, 3, 'pin covers exactly 3 files');

  // Strips ONLY the two additive B1 fields from a fresh parseFile() result,
  // round-tripped through JSON first so `undefined`-vs-absent and other
  // non-JSON-shape quirks can never produce a false mismatch or false pass.
  function stripB1Additions(facts) {
    const clone = JSON.parse(JSON.stringify(facts));
    for (const t of clone.types || []) {
      delete t.constants;
      for (const m of t.methods || []) {
        for (const l of m.locals || []) {
          delete l.literal;
        }
      }
    }
    return clone;
  }

  for (const base of baseline) {
    const text = fs.readFileSync(base.path, 'utf8');
    const fresh = parseFile({ path: base.path, text });
    assert.strictEqual(fresh.parseError, null, `${base.path} still parses cleanly`);
    const stripped = stripB1Additions(fresh);
    assert.deepStrictEqual(
      stripped,
      base,
      `${base.path}: FileFacts byte-identical to the pre-B1 baseline once locals[].literal/TypeFacts.constants are stripped`
    );

    // Sanity check the pin is exercising real shape, not a no-op strip: these
    // 3 files legitimately have zero qualifying constants and zero literal
    // locals, so `constants` must be present-but-empty and no local may
    // carry `literal` at all (never present-but-falsy).
    for (const t of fresh.types) {
      assert.ok(Array.isArray(t.constants), `${base.path}: TypeFacts.constants present as an array`);
      assert.deepStrictEqual(t.constants, [], `${base.path}: no qualifying static-final-String constant in this pinned file`);
      for (const m of t.methods) {
        for (const l of m.locals) {
          assert.strictEqual(
            Object.prototype.hasOwnProperty.call(l, 'literal'),
            false,
            `${base.path}#${m.name} local '${l.name}': no single-string-literal initializer in this pinned file`
          );
        }
      }
    }
  }
}

// --- also: completely unparseable garbage never throws, and empty text never throws ---
{
  assert.doesNotThrow(() => parseFile({ path: 'Garbage.cls', text: '{{{ not apex at all ]]] ###' }));
  const g = parseFile({ path: 'Garbage.cls', text: '{{{ not apex at all ]]] ###' });
  assert.strictEqual(typeof g.parseError, 'string');

  assert.doesNotThrow(() => parseFile({ path: 'Empty.cls', text: '' }));
  const e = parseFile({ path: 'Empty.cls', text: '' });
  assert.strictEqual(e.types.length, 0);

  assert.doesNotThrow(() => parseFile({ path: 'NoText.cls', text: undefined }));
}

console.log('apex-trace parser.js self-check: all assertions passed');

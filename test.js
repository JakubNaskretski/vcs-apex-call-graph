'use strict';
// End-to-end self-check for Apex Call Graph v0.2.0's semantic pipeline:
// real Apex source strings -> parser.parseFile -> resolver.buildSemanticIndex
// -> resolver.buildCallerTree, asserting every item in the integrator's
// required coverage list. Run with `node test.js`.
//
// v1's apexindex.js stays as the parse-error fallback engine (used inside
// resolver.js, not directly here) — its own `strip()` self-check is kept
// verbatim below per the task brief ("Keep apexindex.js strip() tests").

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { strip } = require('./apexindex');
const parser = require('./parser');
const resolver = require('./resolver');
const metascan = require('./metascan');
const uitree = require('./uitree');
const pathmap = require('./pathmap');

// ---------------------------------------------------------------------------
// apexindex.js strip() self-check (kept from v1's test.js)
// ---------------------------------------------------------------------------

const st = strip("a // line B\nb /* C\nD */ e 'F' g");
assert(!st.includes('B') && !st.includes('C') && !st.includes('D') && !st.includes('F'), 'strip removes comments+strings');
assert.strictEqual(st.split('\n').length, 3, 'strip preserves newlines');

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const files = [];
function addFile(relPath, text) {
  files.push(parser.parseFile({ path: `/ws/force-app/main/default/${relPath}`, text }));
}

// Covers: typed call + argsRendered mapping, static, new -> '<init>', bare
// call, this-dot call, overload declarations (arity tested via LogCaller.cls).
addFile('classes/OppService.cls', [
  'public with sharing class OppService {',
  '  public void applyDiscount(Id oppId, Decimal pct) { System.debug(pct); }',
  '  public static void staticHelper() { System.debug(\'static\'); }',
  '  public void log(String msg) { System.debug(msg); }',
  '  public void log(String msg, Integer level) { System.debug(msg + level); }',
  '  public void recalc() { this.log(\'recalc\'); helper(); }',
  '  private void helper() { System.debug(\'helper\'); }',
  '}',
].join('\n'));

// Covers: new -> '<init>', static dispatch, typed instance dispatch with
// argsRendered param-name zip, and is itself a trigger-chain link.
addFile('classes/OppTriggerHandler.cls', [
  'public class OppTriggerHandler {',
  '  public void afterUpdate() {',
  '    OppService svc = new OppService();',
  '    svc.applyDiscount(oppIdVar, 0.15);',
  '    OppService.staticHelper();',
  '  }',
  '}',
].join('\n'));

// Covers: trigger -> handler -> service chain to root.
addFile('triggers/OppTrigger.trigger', [
  'trigger OppTrigger on Opportunity (after update, after insert) {',
  '  new OppTriggerHandler().afterUpdate();',
  '}',
].join('\n'));

// Covers: overload arity (log/1 vs log/2 zipped independently at each site).
addFile('classes/LogCaller.cls', [
  'public class LogCaller {',
  '  public void go() {',
  '    OppService svc = new OppService();',
  '    svc.log(\'hello\', 1);',
  '    svc.log(\'hi\');',
  '  }',
  '}',
].join('\n'));

// Covers: method-level @AuraEnabled entry.
addFile('classes/QuoteController.cls', [
  'public class QuoteController {',
  '  @AuraEnabled',
  '  public static void recalcQuote() { OppService svc = new OppService(); svc.recalc(); }',
  '}',
].join('\n'));

// Covers: interface dispatch (approximate fan-out to every implementer).
addFile('classes/Notifier.cls', 'public interface Notifier { void notify(String msg); }');
addFile('classes/EmailNotifier.cls', [
  'public class EmailNotifier implements Notifier {',
  '  public void notify(String msg) { System.debug(msg); }',
  '}',
].join('\n'));
addFile('classes/SmsNotifier.cls', [
  'public class SmsNotifier implements Notifier {',
  '  public void notify(String msg) { System.debug(msg); }',
  '}',
].join('\n'));
addFile('classes/NotifyService.cls', [
  'public class NotifyService {',
  '  public void broadcast(Notifier n, String msg) { n.notify(msg); }',
  '}',
].join('\n'));

// Covers: inheritance resolution (bare call inside a subclass resolves up
// the extends chain to the base class's method).
addFile('classes/BaseCtrl.cls', [
  'public virtual class BaseCtrl {',
  '  public void audit(String s) { System.debug(s); }',
  '}',
].join('\n'));
addFile('classes/SubCtrl.cls', [
  'public class SubCtrl extends BaseCtrl {',
  '  public void run() { audit(\'x\'); }',
  '}',
].join('\n'));

// Covers: inner class (qualified 'Outer.Inner' lookup, bare self-reference).
addFile('classes/Outer.cls', [
  'public class Outer {',
  '  public class Inner {',
  '    public void go() { System.debug(\'inner\'); }',
  '  }',
  '  public void useInner() {',
  '    Inner i = new Inner();',
  '    i.go();',
  '  }',
  '}',
].join('\n'));

// Covers: platform denylist (System.debug produces no edge) + user-class
// shadowing (a local variable named `database`, typed to a real user class,
// still resolves to that class instead of being denylisted).
addFile('classes/ShadowDatabase.cls', [
  'public class ShadowDatabase {',
  '  public void run() { System.debug(\'shadow\'); }',
  '}',
].join('\n'));
addFile('classes/ShadowUser.cls', [
  'public class ShadowUser {',
  '  public void go() {',
  '    ShadowDatabase database = new ShadowDatabase();',
  '    database.run();',
  '    System.debug(\'platform call, no edge\');',
  '  }',
  '}',
].join('\n'));

// Covers: explicit mutual-recursion cycle guard.
addFile('classes/CycleA.cls', [
  'public class CycleA {',
  '  public void go() { CycleB inst = new CycleB(); inst.go(); }',
  '}',
].join('\n'));
addFile('classes/CycleB.cls', [
  'public class CycleB {',
  '  public void go() { CycleA inst = new CycleA(); inst.go(); }',
  '}',
].join('\n'));

// Covers: duplicate qualified-class-name, first-parsed-wins policy.
addFile('classes/Dup1/Dup.cls', 'public class Dup { public void one() {} }');
addFile('classes/Dup2/Dup.cls', 'public class Dup { public void two() {} }');

// Covers: parse-error lexical fallback (mentions OppService by name; the
// syntax error keeps the real AST walk from ever seeing that reference).
addFile('classes/BrokenClass.cls', [
  'public class BrokenClass {',
  '  public void broken( {',
  '    OppService x;',
  '  }',
  '}',
].join('\n'));

// =========================================================================
// v0.3.0 amendment coverage (A1-A6): property accessors, chained/cast
// receivers, overload signatures, and metascan-fed meta callers. Kept as a
// small, self-contained mini fixture set (per the integrator task brief),
// distinct from the fixtures above so neither set has to be touched to add
// the other.
// =========================================================================

// Covers: A1/A2 property accessor edges. `Status` has an EXPLICIT get/set
// body (per parser.js's documented rule that '(get NAME)'/'(set NAME)'
// synthetic scopes are only created when the accessor has a real
// `.block()` — the auto-implemented `{ get; set; }` shorthand synthesizes
// no method at all, matching how the real adv-org corpus's AcmeQuote.cls
// declares Status/TotalAmount); `Total` is a plain field (no accessor
// methods exist for it at all, so there is nothing to resolve to).
addFile('classes/PropTarget.cls', [
  'public class PropTarget {',
  '  private String status;',
  '  public String Status {',
  '    get { return status; }',
  '    set { status = value; }',
  '  }',
  '  public Integer Total;',
  '}',
].join('\n'));
addFile('classes/PropConsumer.cls', [
  'public class PropConsumer {',
  '  public void touch() {',
  '    PropTarget t = new PropTarget();',
  '    t.Status = \'Open\';',
  '    String s = t.Status;',
  '  }',
  '}',
].join('\n'));

// Covers: A3(c) chained receiver — b.withName(...).create().build() walks
// through withName()'s and create()'s declared return types to attribute
// build() to ChainTarget2, not ChainBuilder2.
addFile('classes/ChainTarget2.cls', [
  'public class ChainTarget2 {',
  '  public void build() { System.debug(\'build\'); }',
  '}',
].join('\n'));
addFile('classes/ChainBuilder2.cls', [
  'public class ChainBuilder2 {',
  '  public ChainBuilder2 withName(String n) { return this; }',
  '  public ChainTarget2 create() { return new ChainTarget2(); }',
  '}',
].join('\n'));
addFile('classes/ChainCaller2.cls', [
  'public class ChainCaller2 {',
  '  public void go() {',
  '    ChainBuilder2 b = new ChainBuilder2();',
  '    b.withName(\'x\').create().build();',
  '  }',
  '}',
].join('\n'));

// Covers: A3(a) cast receiver — ((CastTarget2) o).act() resolves via the
// cast type head, not the declared (Object) type of `o`.
addFile('classes/CastTarget2.cls', [
  'public class CastTarget2 {',
  '  public void act() { System.debug(\'act\'); }',
  '}',
].join('\n'));
addFile('classes/CastCaller2.cls', [
  'public class CastCaller2 {',
  '  public void go(Object o) {',
  '    ((CastTarget2) o).act();',
  '  }',
  '}',
].join('\n'));

// Covers: A4 overload signatures — two same-arity overloads distinguished
// by argument literal type, each call site carrying its own overloadSig.
addFile('classes/OverloadTarget2.cls', [
  'public class OverloadTarget2 {',
  '  public void calc(String s) { System.debug(s); }',
  '  public void calc(Integer i) { System.debug(i); }',
  '}',
].join('\n'));
addFile('classes/OverloadCaller2.cls', [
  'public class OverloadCaller2 {',
  '  public void go() {',
  '    OverloadTarget2 t = new OverloadTarget2();',
  '    t.calc(\'hello\');',
  '    t.calc(5);',
  '  }',
  '}',
].join('\n'));

// Covers: A5/A6 metascan-fed meta callers — @AuraEnabled target reachable
// from an LWC's '@salesforce/apex' import, through the full
// parseFile + metascan -> buildSemanticIndex + attachMetaCallers ->
// buildCallerTree pipeline (metascan.js runs below, right after the index
// is built).
addFile('classes/MetaTarget2.cls', [
  'public class MetaTarget2 {',
  '  @AuraEnabled',
  '  public static String getData() { return \'x\'; }',
  '}',
].join('\n'));

// =========================================================================
// v0.4.0 TRANSACTION-STORY fixture: a full LWC -> @AuraEnabled controller ->
// service (does 'update' DML) -> trigger -> handler -> invocable chain,
// where that same invocable is ALSO reachable from a record-triggered flow
// whose meta node (per F1(b)) carries DML children. Exercises F1(a) (DML->
// trigger linkage), F1(b) (flow->DML children) and the pre-existing A5/A6
// metadata-caller machinery together, end to end, node by node. Kept as its
// own self-contained mini fixture set (TxStory* prefix, no overlap with any
// other fixture in this file).
// =========================================================================

// Link 1: @AuraEnabled controller, imperatively called from the LWC below.
addFile('classes/TxStoryController.cls', [
  'public class TxStoryController {',
  '  @AuraEnabled',
  '  public static void submitStory(TxStory__c story) {',
  '    TxStoryService svc = new TxStoryService();',
  '    svc.recalcStory(story);',
  '  }',
  '}',
].join('\n'));

// Link 2: service layer method that performs the 'update' DML statement
// that F1(a) links forward to TxStoryTrigger.
addFile('classes/TxStoryService.cls', [
  'public class TxStoryService {',
  '  public void recalcStory(TxStory__c story) {',
  '    story.Total__c = 100;',
  '    update story;',
  '  }',
  '}',
].join('\n'));

// Link 3: the trigger the DML statement above fires (before/after update on
// TxStory__c) -> its handler.
addFile('triggers/TxStoryTrigger.trigger', [
  'trigger TxStoryTrigger on TxStory__c (before update, after update) {',
  '  new TxStoryTriggerHandler().handle();',
  '}',
].join('\n'));

// Link 4: handler -> invocable (ordinary static dispatch, resolves-today).
addFile('classes/TxStoryTriggerHandler.cls', [
  'public class TxStoryTriggerHandler {',
  '  public void handle() {',
  '    TxStoryInvocable.execute();',
  '  }',
  '}',
].join('\n'));

// Link 5: the invocable -- reachable both from the handler above AND (per
// F1(b), via the record-triggered flow meta ref registered below) from
// TxStoryFollowUpFlow.
addFile('classes/TxStoryInvocable.cls', [
  'public class TxStoryInvocable {',
  '  @InvocableMethod',
  '  public static void execute() {',
  '    System.debug(\'invocable\');',
  '  }',
  '}',
].join('\n'));

// =========================================================================
// v0.5.0 EXCEPTION-STORY fixture: a throw deep in a service, with callers up
// the chain exercising all four G2 catch-depth scenarios (exact-type catch,
// supertype catch, bare-Exception catch, and one path that reaches an entry
// point fully uncaught) -- mirrors example-data/adv-org/MANIFEST.md's v0.5
// G2 section node for node, as its own self-contained mini fixture set
// (ExcStory* prefix, no overlap with any other fixture in this file).
// =========================================================================

// G2: two-level user exception hierarchy -- extends chain reaches
// 'Exception' one hop removed from the root, so isExceptionTargetClass must
// walk the chain, not just check the immediate extendsType.
addFile('classes/ExcStoryBaseException.cls', 'public class ExcStoryBaseException extends Exception {}');
addFile('classes/ExcStoryValidationException.cls', 'public class ExcStoryValidationException extends ExcStoryBaseException {}');

// Throw site: creator-type 'throw new X(...)' form.
addFile('classes/ExcStoryValidator.cls', [
  'public class ExcStoryValidator {',
  '  public void validate(Id recId) {',
  '    if (recId == null) {',
  '      throw new ExcStoryValidationException(\'Id is required\');',
  '    }',
  '  }',
  '}',
].join('\n'));

// Branch point every catch-depth scenario below shares (via=static, no
// catch of its own -- mirrors AcmeOrderService.processOrders in the corpus).
addFile('classes/ExcStoryProcessor.cls', [
  'public class ExcStoryProcessor {',
  '  public static void process(Id recId) {',
  '    ExcStoryValidator v = new ExcStoryValidator();',
  '    v.validate(recId);',
  '  }',
  '}',
].join('\n'));

// Scenario 1: catches the EXACT type.
addFile('classes/ExcStoryBatchProcessor.cls', [
  'public class ExcStoryBatchProcessor {',
  '  public void execute() {',
  '    try {',
  '      ExcStoryProcessor.process(null);',
  '    } catch (ExcStoryValidationException ve) {',
  '      System.debug(ve);',
  '    }',
  '  }',
  '}',
].join('\n'));

// Scenario 2: catches a SUPERTYPE (ExcStoryBaseException, not the exact
// thrown type) -- must match via the USER exception hierarchy walk.
addFile('classes/ExcStoryRestResource.cls', [
  'public class ExcStoryRestResource {',
  '  public void handlePost() {',
  '    try {',
  '      ExcStoryProcessor.process(null);',
  '    } catch (ExcStoryBaseException be) {',
  '      System.debug(be);',
  '    }',
  '  }',
  '}',
].join('\n'));

// Scenario 3: catches bare 'Exception', one hop deeper than the other three
// (process -> handle (no catch) -> trigger (catches)) -- exercises
// traversal continuing through an uncaught intermediate frame.
addFile('classes/ExcStoryTriggerHandler.cls', [
  'public class ExcStoryTriggerHandler {',
  '  public void handle() {',
  '    ExcStoryProcessor.process(null);',
  '  }',
  '}',
].join('\n'));
addFile('triggers/ExcStoryTrigger.trigger', [
  'trigger ExcStoryTrigger on ExcStory__c (before insert) {',
  '  try {',
  '    new ExcStoryTriggerHandler().handle();',
  '  } catch (Exception ex) {',
  '    System.debug(ex);',
  '  }',
  '}',
].join('\n'));

// Scenario 4: NO catch anywhere -- reaches a terminal @isTest entry with the
// exception still formally "in flight." Negative case: absence of a badge
// is itself part of the ground truth.
addFile('classes/ExcStoryTest.cls', [
  '@isTest',
  'public class ExcStoryTest {',
  '  @isTest',
  '  static void testProcess() {',
  '    ExcStoryProcessor.process(null);',
  '  }',
  '}',
].join('\n'));

// G2: caught-and-rethrown 'throw e' form, resolved via the enclosing catch
// clause -- a second, structurally different throw site with ZERO callers
// of its own (a valid terminal via='throws' leaf). Per the G2 spec, this
// method's OWN catch clause must NOT badge itself with caughtHere: it is
// the throw site's own frame (via='throws'), not an ancestor intercepting
// propagation from below.
addFile('classes/ExcStoryOrphanService.cls', [
  'public class ExcStoryOrphanService {',
  '  public void reprocess(Id recId) {',
  '    try {',
  '      ExcStoryUtil.computeSomething(recId);',
  '    } catch (ExcStoryValidationException e) {',
  '      System.debug(e);',
  '      throw e;',
  '    }',
  '  }',
  '}',
].join('\n'));
addFile('classes/ExcStoryUtil.cls', [
  'public class ExcStoryUtil {',
  '  public static void computeSomething(Id recId) { System.debug(recId); }',
  '}',
].join('\n'));

// =========================================================================
// v0.5.0 PUBLISH-STORY fixture: a service publishes a platform event (__e)
// via both the single-record and List<X__e> collection forms of
// EventBus.publish(...), which resolves to every trigger on that object
// (G1(a)) and, once the platform-event-triggered flow's meta node is
// reachable, to the publish sites shown as flow children (G1(b)) -- mirrors
// example-data/adv-org/MANIFEST.md's v0.5 G1 section node for node.
// (PubStory* prefix, no overlap with any other fixture in this file.)
// =========================================================================

// Single-record inline-constructor form.
addFile('classes/PubStoryPublisher.cls', [
  'public class PubStoryPublisher {',
  '  public void publishNote(String msg) {',
  '    EventBus.publish(new PubStoryNote__e(Msg__c = msg));',
  '  }',
  '  public void publishNotes(List<String> msgs) {',
  '    List<PubStoryNote__e> events = new List<PubStoryNote__e>();',
  '    for (String m : msgs) {',
  '      events.add(new PubStoryNote__e(Msg__c = m));',
  '    }',
  '    EventBus.publish(events);',
  '  }',
  '}',
].join('\n'));

// After-insert platform-event trigger -> thin handler (ordinary wiring,
// resolves-today via=static).
addFile('triggers/PubStoryNoteTrigger.trigger', [
  'trigger PubStoryNoteTrigger on PubStoryNote__e (after insert) {',
  '  new PubStoryNoteHandler().handle();',
  '}',
].join('\n'));
addFile('classes/PubStoryNoteHandler.cls', [
  'public class PubStoryNoteHandler {',
  '  public void handle() { System.debug(\'handled\'); }',
  '}',
].join('\n'));

// Dedicated invocable for the platform-event-triggered flow's actionCalls
// node (see the pubStoryFlowFile comment below for why this isn't shared
// with TxStoryInvocable).
addFile('classes/PubStoryFlowInvocable.cls', [
  'public class PubStoryFlowInvocable {',
  '  @InvocableMethod',
  '  public static void execute() {',
  '    System.debug(\'pubstory invocable\');',
  '  }',
  '}',
].join('\n'));

// =========================================================================
// v0.6.0 fixtures (integrator phase): H1 seenElsewhere dedup, H2 interface x
// override composition, H4 zero-caller note -- each exercised through the
// REAL parser -> resolver pipeline (not synthetic TNode/ClassMeta fixtures
// the way test-resolver.js's own H1/H2 unit tests are built), so the
// assertions below prove the full integration, not just the isolated
// resolver.js logic. See the "v0.6.0 integrator assertions" block near the
// end of this file.
// =========================================================================

// --- H1: seenElsewhere DAG-dedup diamond. doWork() is called by both Q and
//     R; Q and R are BOTH called by the same S.viaS() -- so S.viaS() appears
//     as a node TWICE in doWork()'s caller tree (once under Q, once under
//     R). The first occurrence (alphabetically, under Q) expands normally;
//     the second (under R) must become a seenElsewhere reference node: its
//     own sites (how R.viaR is called) still show, but its subtree (its own
//     caller, V06DedupTop.entry) is not re-walked. ---
addFile('classes/V06DedupTarget.cls', [
  'public class V06DedupTarget {',
  '  public void doWork() { }',
  '}',
].join('\n'));
addFile('classes/V06DedupQ.cls', [
  'public class V06DedupQ {',
  '  public void viaQ() { new V06DedupTarget().doWork(); }',
  '}',
].join('\n'));
addFile('classes/V06DedupR.cls', [
  'public class V06DedupR {',
  '  public void viaR() { new V06DedupTarget().doWork(); }',
  '}',
].join('\n'));
addFile('classes/V06DedupS.cls', [
  'public class V06DedupS {',
  '  public void viaS() {',
  '    new V06DedupQ().viaQ();',
  '    new V06DedupR().viaR();',
  '  }',
  '}',
].join('\n'));
addFile('classes/V06DedupTop.cls', [
  'public class V06DedupTop {',
  '  public void entry() { new V06DedupS().viaS(); }',
  '}',
].join('\n'));

// --- H2: interface x override composition. V06CompSubImpl overrides m() in
//     a SUBCLASS of the direct implementer (V06CompImpl), never redeclaring
//     `implements` itself -- the confirmed missing-edge repro from the goal
//     spec. Pre-H2 fix, tracing V06CompSubImpl.m showed ZERO callers even
//     though V06CompDispatcher.fan(V06CompIface) reaches it through the
//     interface-typed parameter at runtime. ---
addFile('classes/V06CompIface.cls', [
  'public interface V06CompIface {',
  '  void m();',
  '}',
].join('\n'));
addFile('classes/V06CompImpl.cls', [
  'public virtual class V06CompImpl implements V06CompIface {',
  '  public virtual void m() { }',
  '}',
].join('\n'));
addFile('classes/V06CompSubImpl.cls', [
  'public class V06CompSubImpl extends V06CompImpl {',
  '  public override void m() { }',
  '}',
].join('\n'));
addFile('classes/V06CompDispatcher.cls', [
  'public class V06CompDispatcher {',
  '  public void fan(V06CompIface i) { i.m(); }',
  '}',
].join('\n'));

// --- H4: a class/method with genuinely zero callers anywhere in this whole
//     corpus -- must render an honest note, not a silently empty tree. ---
addFile('classes/V06ZeroCallerTarget.cls', [
  'public class V06ZeroCallerTarget {',
  '  public void neverCalled() { }',
  '}',
].join('\n'));

// =========================================================================
// v0.7.0 A2 FORWARD-ASYNC fixture: System.enqueueJob(new X()) -> the job's
// own execute() method, via='async', with the G5 forward-collapse rule
// (the inline `new FwdAsyncJob()` constructor argument must NOT ALSO
// surface as a separate '<init>' forward child) asserted end to end. Kept
// as its own self-contained mini fixture set (FwdAsync* prefix, no overlap
// with any other fixture in this file). Deliberately uses a denylisted
// 'System.debug(...)' body (not an indexed call) so this fixture adds ZERO
// new entries to the corpus-wide unresolvedSites count the H4 block above
// already pins at 1.
// =========================================================================
addFile('classes/FwdAsyncOrchestrator.cls', [
  'public class FwdAsyncOrchestrator {',
  '  public void runMaintenance() {',
  '    System.enqueueJob(new FwdAsyncJob());',
  '  }',
  '}',
].join('\n'));
addFile('classes/FwdAsyncJob.cls', [
  'public class FwdAsyncJob implements Queueable {',
  '  public void execute(QueueableContext qc) { System.debug(\'async\'); }',
  '}',
].join('\n'));

// =========================================================================
// v0.7.1/R1 e2e fixture: namespaced-reference honesty. `Ns071Caller.probe()`
// calls `zenq.Ns071Target.run(...)` -- a dotted receiver whose head segment
// ('zenq') is not a known local class/inner-class/variable, i.e. a reference
// into a namespace/managed package this workspace never declared. Pre-R1,
// resolveType()'s bare-last-segment fallback collapsed this straight onto
// the unrelated LOCAL `Ns071Target.run` (VALIDATION-REPORT.md Tier-1 #2).
// The honest contract this fixture pins: (a) ZERO edge to the local class
// with the same bare tail, (b) the call site IS counted in the workspace-
// wide unresolvedSites tally (an out-of-scope namespaced reference is a
// real, countable gap -- not silently and invisibly dropped). This is the
// ONE fixture in this file's main corpus that deliberately adds to the H4
// unresolvedSites pin below (see that assertion's own updated count).
// =========================================================================
addFile('classes/Ns071Target.cls', [
  'public class Ns071Target {',
  '  public void run() { System.debug(\'local target\'); }',
  '}',
].join('\n'));
addFile('classes/Ns071Caller.cls', [
  'public class Ns071Caller {',
  '  public void probe() {',
  '    zenq.Ns071Target.run();',
  '  }',
  '}',
].join('\n'));

// =========================================================================
// v0.7.1/R4 e2e fixture: template-method hook callers via override fan-out.
// `Tpl071Base.run()` (the framework's own dispatch entry point) calls its
// OWN virtual `hook()` via an implicit bare `this` self-call -- exactly the
// fflib_SObjectDomain / hand-rolled TriggerHandler shape. `Tpl071Sub`
// overrides `hook()` with the real logic. Pre-R4, bare/this self-calls from
// within the DECLARING base class's own body never routed through the
// override fan-out machinery (rule 6/typed-interface dispatch already had
// it; self-calls didn't) -- buildCallerTree on Tpl071Sub.hook returned "No
// callers found", even though it is reached at runtime via
// Tpl071Base.run() -> this.hook(). The honest contract this fixture pins:
// tracing the OVERRIDE's own callers must surface the BASE class's
// self-dispatching method as a caller, via='override', approximate.
// =========================================================================
addFile('classes/Tpl071Base.cls', [
  'public virtual class Tpl071Base {',
  '  public virtual void run() {',
  '    hook();',
  '  }',
  '  public virtual void hook() { }',
  '}',
].join('\n'));
addFile('classes/Tpl071Sub.cls', [
  'public class Tpl071Sub extends Tpl071Base {',
  '  public override void hook() { System.debug(\'real logic\'); }',
  '}',
].join('\n'));

// Sanity: no fixture should crash parseFile, and exactly the one deliberate
// syntax error should carry parseError.
for (const f of files) {
  if (f.name === 'BrokenClass') {
    assert(f.parseError, 'BrokenClass.cls must have a parseError');
    assert.strictEqual(typeof f.text, 'string', 'parse-error file must echo back its source text for the lexical fallback');
  } else {
    assert.strictEqual(f.parseError, null, `${f.name} should parse cleanly, got: ${f.parseError}`);
  }
}

const index = resolver.buildSemanticIndex(files);

// A5/A6 pipeline: real metascan.js run over a real (inline) LWC main-module
// source string -> attachMetaCallers mutates the already-built index. The
// MetaRef contract deliberately has no `path` field (see metascan.js's
// header) -- extension.js is the one place that stamps it on for the real
// vscode integration (A7); this test reproduces that same step by hand so
// the meta child TNode below has somewhere to "jump" to.
const lwcFile = {
  path: '/ws/force-app/main/default/lwc/acmeWidget/acmeWidget.js',
  text: "import getData from '@salesforce/apex/MetaTarget2.getData';\nexport default class AcmeWidget {}",
};
const lwcMetaRefs = metascan.parseMetaFile(lwcFile).map((ref) => Object.assign(ref, { path: lwcFile.path }));
resolver.attachMetaCallers(index, lwcMetaRefs);

// v0.4.0 TRANSACTION-STORY: LWC leg (link 1's caller) -- imperative
// '@salesforce/apex' import into TxStoryController.submitStory.
const txStoryLwcFile = {
  path: '/ws/force-app/main/default/lwc/txStoryPanel/txStoryPanel.js',
  text: "import submitStory from '@salesforce/apex/TxStoryController.submitStory';\nexport default class TxStoryPanel {}",
};
const txStoryLwcMetaRefs = metascan.parseMetaFile(txStoryLwcFile).map((ref) => Object.assign(ref, { path: txStoryLwcFile.path }));
resolver.attachMetaCallers(index, txStoryLwcMetaRefs);

// v0.4.0 TRANSACTION-STORY: record-triggered flow leg -- a real
// .flow-meta.xml run through the real metascan.js F1(b) <start> extraction,
// on the SAME object (TxStory__c) and matching recordTriggerType (Update)
// as the service's DML statement above, so buildMetaChildren's F1(b)
// children-materialization rule lands on TxStoryService.recalcStory.
const txStoryFlowFile = {
  path: '/ws/force-app/main/default/flows/TxStoryFollowUpFlow.flow-meta.xml',
  text: [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<Flow xmlns="http://soap.sforce.com/2006/04/metadata">',
    '  <start>',
    '    <object>TxStory__c</object>',
    '    <triggerType>RecordAfterSave</triggerType>',
    '    <recordTriggerType>Update</recordTriggerType>',
    '  </start>',
    '  <actionCalls>',
    '    <actionName>TxStoryInvocable</actionName>',
    '    <actionType>apex</actionType>',
    '  </actionCalls>',
    '</Flow>',
  ].join('\n'),
};
const txStoryFlowMetaRefs = metascan.parseMetaFile(txStoryFlowFile).map((ref) => Object.assign(ref, { path: txStoryFlowFile.path }));
resolver.attachMetaCallers(index, txStoryFlowMetaRefs);

// v0.5.0 PUBLISH-STORY: platform-event-triggered flow leg -- a real
// .flow-meta.xml run through the real metascan.js G1(b) <start> extraction
// (<triggerType>PlatformEvent</triggerType> + <object>PubStoryNote__e</object>),
// so buildPublishChildrenForFlow's G1(b) children-materialization rule lands
// on both PubStoryPublisher publish sites. Its one actionCalls node points
// at its own dedicated invocable (PubStoryFlowInvocable, declared below) --
// deliberately NOT reusing TxStoryInvocable, so this fixture's flow child
// doesn't collide with (and destabilize the sort order/singular .find() of)
// the pre-existing v0.4.0 TRANSACTION-STORY's flow-child assertions.
const pubStoryFlowFile = {
  path: '/ws/force-app/main/default/flows/PubStoryNoteFlow.flow-meta.xml',
  text: [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<Flow xmlns="http://soap.sforce.com/2006/04/metadata">',
    '  <start>',
    '    <triggerType>PlatformEvent</triggerType>',
    '    <object>PubStoryNote__e</object>',
    '  </start>',
    '  <actionCalls>',
    '    <actionName>PubStoryFlowInvocable</actionName>',
    '    <actionType>apex</actionType>',
    '  </actionCalls>',
    '</Flow>',
  ].join('\n'),
};
const pubStoryFlowMetaRefs = metascan.parseMetaFile(pubStoryFlowFile).map((ref) => Object.assign(ref, { path: pubStoryFlowFile.path }));
resolver.attachMetaCallers(index, pubStoryFlowMetaRefs);

// ---------------------------------------------------------------------------
// Assertions
// ---------------------------------------------------------------------------

function callers(classLower, methodLower) {
  const tree = resolver.buildCallerTree(index, { classLower, methodLower }, {});
  return tree;
}

// v0.7.0 A2: forward-direction counterpart to callers() -- same corpus/index,
// same {}-opts convention, just buildCalleeTree instead of buildCallerTree.
function callees(classLower, methodLower) {
  const tree = resolver.buildCalleeTree(index, { classLower, methodLower }, {});
  return tree;
}

function findChild(tree, label) {
  return tree.root.children.find((c) => c.label === label);
}

// --- typed call with argsRendered mapping -------------------------------
{
  const tree = callers('oppservice', 'applydiscount');
  assert.strictEqual(tree.root.methodLower, 'applydiscount', 'root TNode carries machine-readable methodLower');
  const handler = findChild(tree, 'OppTriggerHandler.afterUpdate');
  assert.strictEqual(handler.methodLower, 'afterupdate', 'caller TNode carries machine-readable methodLower');
  assert(handler, 'OppTriggerHandler.afterUpdate should call OppService.applyDiscount');
  assert.strictEqual(handler.via, 'typed');
  assert.strictEqual(handler.sites.length, 1);
  assert.strictEqual(handler.sites[0].argsRendered, 'oppId: oppIdVar, pct: 0.15', 'args zipped against declared param names');
}

// --- static ---------------------------------------------------------------
{
  const tree = callers('oppservice', 'statichelper');
  const handler = findChild(tree, 'OppTriggerHandler.afterUpdate');
  assert(handler, 'OppTriggerHandler.afterUpdate should call OppService.staticHelper');
  assert.strictEqual(handler.via, 'static');
}

// --- new -> '<init>' --------------------------------------------------------
{
  const tree = callers('oppservice', '<init>');
  const handler = findChild(tree, 'OppTriggerHandler.afterUpdate');
  assert(handler, 'OppTriggerHandler.afterUpdate should construct OppService');
  assert.strictEqual(handler.via, 'new');
}

// --- bare + this-dot call (both resolve within the same declaring class) --
{
  const bareTree = callers('oppservice', 'helper');
  const bareCaller = findChild(bareTree, 'OppService.recalc');
  assert(bareCaller, 'OppService.recalc should call bare helper()');
  assert.strictEqual(bareCaller.via, 'this');

  const dotTree = callers('oppservice', 'log');
  const dotCaller = dotTree.root.children.find((c) => c.label === 'OppService.recalc');
  assert(dotCaller, 'OppService.recalc should call this.log(...)');
  assert.strictEqual(dotCaller.via, 'this');
}

// --- inheritance ------------------------------------------------------------
{
  const tree = callers('basectrl', 'audit');
  const sub = findChild(tree, 'SubCtrl.run');
  assert(sub, 'SubCtrl.run should resolve bare audit() up the extends chain to BaseCtrl');
  assert.strictEqual(sub.via, 'this');
}

// --- interface dispatch (approximate fan-out) -------------------------------
{
  const tree = callers('notifier', 'notify');
  const bcast = findChild(tree, 'NotifyService.broadcast');
  assert(bcast, 'NotifyService.broadcast should call Notifier.notify');
  assert.strictEqual(bcast.via, 'interface');
  assert.strictEqual(bcast.approximate, true, 'interface dispatch is approximate');
}

// --- overload arity ---------------------------------------------------------
{
  const tree = callers('oppservice', 'log');
  const caller = findChild(tree, 'LogCaller.go');
  assert(caller, 'LogCaller.go should call OppService.log');
  assert.strictEqual(caller.sites.length, 2, 'both log(...) call sites present');
  const twoArg = caller.sites.find((s) => s.argsRendered.includes('level'));
  const oneArg = caller.sites.find((s) => !s.argsRendered.includes('level'));
  assert.strictEqual(twoArg.argsRendered, "msg: 'hello', level: 1", 'log/2 overload zipped correctly');
  assert.strictEqual(oneArg.argsRendered, "msg: 'hi'", 'log/1 overload zipped correctly');
}

// --- inner class --------------------------------------------------------
{
  const tree = callers('outer.inner', 'go');
  const outer = findChild(tree, 'Outer.useInner');
  assert(outer, 'Outer.useInner should call Outer.Inner.go');
  assert.strictEqual(outer.via, 'typed');
}

// --- trigger -> handler -> service chain to root ---------------------------
{
  const tree = callers('oppservice', 'applydiscount');
  const handler = findChild(tree, 'OppTriggerHandler.afterUpdate');
  assert(handler);
  assert.strictEqual(handler.children.length, 1, 'handler is itself called exactly once');
  const trg = handler.children[0];
  assert.strictEqual(trg.kind, 'trigger');
  assert.strictEqual(trg.label, 'OppTrigger');
  assert.strictEqual(trg.entries[0], 'trigger on Opportunity (after update, after insert)');
  assert.strictEqual(trg.children.length, 0, 'the trigger is an entry point / root — no further callers');
}

// --- method-level @AuraEnabled entry ----------------------------------------
{
  const tree = callers('quotecontroller', 'recalcquote');
  assert.deepStrictEqual(tree.root.entries, ['@AuraEnabled (LWC/Aura)']);
}

// --- parse-error lexical fallback -------------------------------------------
{
  assert(index.parseFallbacks.includes('/ws/force-app/main/default/classes/BrokenClass.cls'));
  const classTree = callers('oppservice', null);
  const lex = classTree.root.children.find((c) => c.via === 'lexical');
  assert(lex, 'BrokenClass should still surface as a lexical-fallback caller of OppService');
  assert.strictEqual(lex.label, 'BrokenClass');
  assert.strictEqual(lex.approximate, true);
}

// --- platform denylist + user-class shadowing -------------------------------
{
  assert(!index.classCallers.has('system'), 'System.debug must never create a class entry/edge');
  const tree = callers('shadowdatabase', 'run');
  const shadow = findChild(tree, 'ShadowUser.go');
  assert(shadow, 'a local named `database` typed to a real user class must still resolve (shadowing wins over denylist)');
  assert.strictEqual(shadow.via, 'typed');
}

// --- recursion cycle guard ---------------------------------------------------
{
  const tree = callers('cyclea', 'go');
  const b = findChild(tree, 'CycleB.go');
  assert(b, 'CycleA.go is called by CycleB.go');
  assert.strictEqual(b.children.length, 1);
  assert.strictEqual(b.children[0].label, 'CycleA.go');
  assert.strictEqual(b.children[0].cyclic, true, 'cycle detected, no infinite recursion');
  assert.strictEqual(b.children[0].children.length, 0);
}

// --- duplicate first-wins -----------------------------------------------
{
  assert(index.duplicates.includes('Dup'), 'second Dup.cls should be flagged as a duplicate');
  const dup = index.classes.get('dup');
  assert.strictEqual(dup.path, '/ws/force-app/main/default/classes/Dup1/Dup.cls', 'first-parsed file wins the slot');
  assert(dup.methods.some((m) => m.name === 'one'), 'Dup1 (first-parsed) contributes its methods');
  assert(!dup.methods.some((m) => m.name === 'two'), 'Dup2 (second-parsed) never gets indexed');
}

// =========================================================================
// v0.3.0 amendment assertions (A1-A6)
// =========================================================================

// --- A1/A2: property accessor edges -----------------------------------
{
  const setTree = callers('proptarget', '(set status)');
  const setCaller = findChild(setTree, 'PropConsumer.touch');
  assert(setCaller, 'PropConsumer.touch should call the Status setter (bare property write)');
  assert.strictEqual(setCaller.via, 'typed');

  const getTree = callers('proptarget', '(get status)');
  const getCaller = findChild(getTree, 'PropConsumer.touch');
  assert(getCaller, 'PropConsumer.touch should call the Status getter (bare property read)');
  assert.strictEqual(getCaller.via, 'typed');
}

// --- A3(c): chained receiver --------------------------------------------
{
  const tree = callers('chaintarget2', 'build');
  const caller = findChild(tree, 'ChainCaller2.go');
  assert(caller, 'ChainCaller2.go should resolve build() through the b.withName(...).create() chain');
  assert.strictEqual(caller.via, 'typed');
  assert.strictEqual(caller.approximate, false, 'chain resolution through declared return types is exact, not approximate');
}

// --- A3(a): cast receiver -------------------------------------------------
{
  const tree = callers('casttarget2', 'act');
  const caller = findChild(tree, 'CastCaller2.go');
  assert(caller, 'CastCaller2.go should resolve act() through the explicit cast receiver');
  assert.strictEqual(caller.via, 'typed');
}

// --- A4: overload signatures ----------------------------------------------
{
  const tree = callers('overloadtarget2', 'calc');
  const caller = findChild(tree, 'OverloadCaller2.go');
  assert(caller, 'OverloadCaller2.go should call calc(...)');
  assert.strictEqual(caller.sites.length, 2, 'both calc(...) call sites present');
  const strSite = caller.sites.find((s) => s.overloadSig === 'calc(String)');
  const intSite = caller.sites.find((s) => s.overloadSig === 'calc(Integer)');
  assert(strSite, "String-literal call site carries overloadSig 'calc(String)'");
  assert(intSite, "Integer-literal call site carries overloadSig 'calc(Integer)'");
}

// --- A5/A6: metascan-fed meta caller ---------------------------------------
{
  const tree = callers('metatarget2', 'getdata');
  const metaChild = tree.root.children.find((c) => c.kind === 'lwc');
  assert(metaChild, 'MetaTarget2.getData should surface acmeWidget as a terminal lwc metadata caller');
  assert.strictEqual(metaChild.via, 'metadata');
  assert.strictEqual(metaChild.label, 'acmeWidget');
  assert.strictEqual(metaChild.path, lwcFile.path, 'meta child carries the path stamped onto the MetaRef');
  assert.strictEqual(metaChild.children.length, 0, 'metadata caller is a terminal node, no further callers');
}

// =========================================================================
// v0.4.0 TRANSACTION-STORY: LWC -> @AuraEnabled controller -> service (does
// 'update' DML) -> trigger -> handler -> invocable, with that same invocable
// also reachable from a record-triggered flow whose meta node (F1(b))
// carries DML children. Asserted node by node.
// =========================================================================

// --- link 1: LWC -> @AuraEnabled controller (A5/A6 metadata caller) -------
{
  const tree = callers('txstorycontroller', 'submitstory');
  const lwcChild = tree.root.children.find((c) => c.kind === 'lwc');
  assert(lwcChild, 'TxStoryController.submitStory should surface txStoryPanel as an lwc metadata caller');
  assert.strictEqual(lwcChild.via, 'metadata');
  assert.strictEqual(lwcChild.label, 'txStoryPanel');
  assert.strictEqual(lwcChild.path, txStoryLwcFile.path, 'meta child carries the path stamped onto the MetaRef');
  assert.strictEqual(lwcChild.children.length, 0, 'metadata caller is a terminal node, no further callers');
}

// --- links 2-5, in one deep tree rooted at the invocable -------------------
// controller -> service(DML) -> trigger -> handler -> invocable, plus the
// sibling record-triggered-flow branch off the same root.
{
  const tree = callers('txstoryinvocable', 'execute');

  // link 5: handler -> invocable (ordinary static dispatch).
  const handlerChild = findChild(tree, 'TxStoryTriggerHandler.handle');
  assert(handlerChild, 'TxStoryTriggerHandler.handle should call TxStoryInvocable.execute');
  assert.strictEqual(handlerChild.via, 'static');

  // link 4: trigger -> handler (trigger body calls new Handler().handle()).
  const trgChild = handlerChild.children.find((c) => c.kind === 'trigger');
  assert(trgChild, 'TxStoryTriggerHandler.handle should itself be called from TxStoryTrigger');
  assert.strictEqual(trgChild.label, 'TxStoryTrigger');
  assert.strictEqual(trgChild.entries[0], 'trigger on TxStory__c (before update, after update)');

  // link 3 (F1a): DML statement -> trigger. TxStoryService.recalcStory's
  // 'update story;' fires TxStoryTrigger (before/after update both match op
  // 'update'), so it shows up as a via='dml' caller of the trigger's
  // '(trigger)' pseudo-method -- exactly the DML->trigger linkage F1(a) adds.
  const dmlChild = trgChild.children.find((c) => c.label === 'TxStoryService.recalcStory');
  assert(dmlChild, 'TxStoryTrigger should be called (via dml) by TxStoryService.recalcStory\'s update statement');
  assert.strictEqual(dmlChild.via, 'dml');
  assert.strictEqual(dmlChild.kind, 'method');
  assert.strictEqual(dmlChild.cyclic, false, 'this DML site is not part of a cycle');
  assert.strictEqual(dmlChild.approximate, false, 'dml edges are exact, not approximate');

  // link 2: controller -> service (svc.recalcStory(story), svc typed local).
  const controllerChild = dmlChild.children.find((c) => c.label === 'TxStoryController.submitStory');
  assert(controllerChild, 'TxStoryService.recalcStory should be called by TxStoryController.submitStory');
  assert.strictEqual(controllerChild.via, 'typed');

  // F1(b): the invocable is ALSO reachable from a record-triggered flow --
  // its meta node is no longer terminal: its children are the DML sites on
  // its object (TxStory__c) matching its recordTriggerType (Update ->
  // update/upsert/merge), landing on the same recalcStory DML site.
  const flowChild = tree.root.children.find((c) => c.kind === 'flow');
  assert(flowChild, 'TxStoryInvocable.execute should surface TxStoryFollowUpFlow as a flow metadata caller');
  assert.strictEqual(flowChild.via, 'metadata');
  assert.strictEqual(flowChild.label, 'TxStoryFollowUpFlow');
  const flowDmlChild = flowChild.children.find((c) => c.label === 'TxStoryService.recalcStory');
  assert(flowDmlChild, 'TxStoryFollowUpFlow (recordTriggerType=Update) should carry TxStoryService.recalcStory as a DML child');
  assert.strictEqual(flowDmlChild.via, 'dml');
  assert.strictEqual(flowDmlChild.kind, 'method');
}

// =========================================================================
// F4b reachability regression: extension.js's real META_GLOBS must include
// a pattern that can match customMetadata/*.md-meta.xml, otherwise the
// CMDT -> class linkage that metascan.js/resolver.js implement correctly
// (see the cmdt assertions in test-metascan.js/test-resolver.js) never
// gets exercised by a real workspace scan (extension.js requires the
// 'vscode' module, so it can't be require()'d directly outside the
// extension host -- read its source and check the glob list instead).
// =========================================================================
{
  const extSrc = fs.readFileSync(path.join(__dirname, 'extension.js'), 'utf8');
  const globsBlockMatch = extSrc.match(/const META_GLOBS = \[([\s\S]*?)\];/);
  assert(globsBlockMatch, 'could not locate META_GLOBS array in extension.js');
  const globsBlock = globsBlockMatch[1];
  assert(
    /customMetadata/.test(globsBlock) && /md-meta\.xml/.test(globsBlock),
    'META_GLOBS must include a customMetadata/**/*.md-meta.xml pattern -- otherwise F4b (Custom Metadata linkage) is unreachable from a real workspace scan even though metascan.js/resolver.js implement it correctly'
  );
}

// =========================================================================
// v0.5.0 EXCEPTION-STORY: end-to-end assertions, node by node -- see the
// fixture block near the top of this file for the shape of the story.
// =========================================================================
{
  const tree = callers('excstoryvalidationexception', null);
  assert.strictEqual(tree.root.kind, 'class');
  assert.strictEqual(tree.root.label, 'ExcStoryValidationException');

  // Throw site 1: creator-type 'throw new X(...)' form -- root-level
  // via='throws' child, not approximate.
  const throwerNode = findChild(tree, 'ExcStoryValidator.validate');
  assert.ok(throwerNode, "'throw new ExcStoryValidationException(...)' must produce a via=throws root-level child");
  assert.strictEqual(throwerNode.via, 'throws');
  assert.strictEqual(throwerNode.approximate, false);
  assert.strictEqual(throwerNode.caughtHere, undefined, 'the throw site itself carries no catch of its own');

  // Throw site 2: rethrow form ('throw e;'), resolved via the enclosing
  // catch clause -- a second, structurally different thrower with ZERO
  // callers of its own, valid as a terminal via=throws leaf. Its own
  // enclosing catch clause matches the traced exception syntactically, but
  // must NOT self-badge (it's the throw site's own frame, not an ancestor
  // intercepting propagation from below).
  const orphanNode = findChild(tree, 'ExcStoryOrphanService.reprocess');
  assert.ok(orphanNode, "'throw e;' rethrow form must resolve e's type via the enclosing catch and produce a via=throws root-level child");
  assert.strictEqual(orphanNode.via, 'throws');
  assert.strictEqual(orphanNode.approximate, false);
  assert.deepStrictEqual(orphanNode.children, [], 'a thrower node needs no callers of its own to be valid ground truth');
  assert.strictEqual(orphanNode.caughtHere, undefined, "a thrower's own enclosing catch clause must not badge the thrower node itself");

  // Branch point shared by all four catch-depth scenarios: no catch of its
  // own, so no badge.
  const processorNode = throwerNode.children.find((c) => c.label === 'ExcStoryProcessor.process');
  assert.ok(processorNode, 'ExcStoryValidator.validate should be reached from ExcStoryProcessor.process');
  assert.strictEqual(processorNode.caughtHere, undefined, 'process() has no catch of its own -- must not carry the badge');

  // Scenario 1: catches the EXACT type.
  const batchNode = processorNode.children.find((c) => c.label === 'ExcStoryBatchProcessor.execute');
  assert.ok(batchNode, 'ExcStoryProcessor.process should be reached from ExcStoryBatchProcessor.execute');
  assert.strictEqual(batchNode.caughtHere, true, 'catch (ExcStoryValidationException ve) is an EXACT type match -- caughtHere must be true');
  assert.ok(batchNode.entries.includes('catches ExcStoryValidationException'), 'exact-type catcher must carry the "catches <Exc>" entries badge');

  // Scenario 2: catches a SUPERTYPE (matched via the USER exception
  // hierarchy: ExcStoryValidationException extends ExcStoryBaseException).
  const restNode = processorNode.children.find((c) => c.label === 'ExcStoryRestResource.handlePost');
  assert.ok(restNode, 'ExcStoryProcessor.process should be reached from ExcStoryRestResource.handlePost');
  assert.strictEqual(restNode.caughtHere, true, 'catch (ExcStoryBaseException be) matches via the USER exception hierarchy -- caughtHere must be true');
  assert.ok(restNode.entries.includes('catches ExcStoryValidationException'), 'supertype catcher must carry the "catches <Exc>" entries badge (named after the TRACED exception, not the catch clause\'s own declared type)');

  // Scenario 3: catches bare 'Exception', one hop deeper than the other
  // three (process -> handle (no catch) -> trigger (catches)) -- traversal
  // continues through the uncaught intermediate frame.
  const handleNode = processorNode.children.find((c) => c.label === 'ExcStoryTriggerHandler.handle');
  assert.ok(handleNode, 'ExcStoryProcessor.process should be reached from ExcStoryTriggerHandler.handle');
  assert.strictEqual(handleNode.caughtHere, undefined, 'handle() has no catch of its own -- must not carry the badge');
  const trigNode = handleNode.children.find((c) => c.kind === 'trigger');
  assert.ok(trigNode, 'ExcStoryTriggerHandler.handle should itself be called from ExcStoryTrigger');
  assert.strictEqual(trigNode.label, 'ExcStoryTrigger');
  assert.strictEqual(trigNode.caughtHere, true, "catch (Exception ex) is a bare-Exception catch -- matches everything, caughtHere must be true");
  assert.ok(trigNode.entries.includes('catches ExcStoryValidationException'), 'bare-Exception catcher must carry the "catches <Exc>" entries badge');

  // Scenario 4: NO catch anywhere -- reaches a terminal @isTest entry fully
  // uncaught. Negative case: absence of the badge is itself the ground
  // truth, not an omission.
  const testNode = processorNode.children.find((c) => c.label === 'ExcStoryTest.testProcess');
  assert.ok(testNode, 'ExcStoryProcessor.process should be reached from ExcStoryTest.testProcess');
  assert.strictEqual(testNode.caughtHere, undefined, 'no catch anywhere in this branch -- absence of the badge is itself the ground truth');
  assert.ok(!testNode.entries.some((e) => e.startsWith('catches ')), 'no "catches <Exc>" entries badge should appear on the uncaught path');
}

// =========================================================================
// v0.5.0 PUBLISH-STORY: end-to-end assertions, node by node -- a service
// publishes a platform event via both the single-record and List<X__e>
// collection forms of EventBus.publish(...), reaching an after-insert
// platform-event trigger (G1(a)) and, separately, showing up as children of
// the platform-event-triggered flow's meta node (G1(b)).
// =========================================================================
{
  // G1(a): publish-site -> trigger edges, both call-site shapes.
  const trigTree = callers('pubstorynotetrigger', null);
  assert.strictEqual(trigTree.root.kind, 'trigger');
  assert.strictEqual(trigTree.root.entries[0], 'trigger on PubStoryNote__e (after insert)');

  const noteChild = findChild(trigTree, 'PubStoryPublisher.publishNote');
  assert.ok(noteChild, 'EventBus.publish(new PubStoryNote__e(...)) (single-record inline form) must trigger PubStoryNoteTrigger');
  assert.strictEqual(noteChild.via, 'publish');
  assert.strictEqual(noteChild.approximate, false, "via='publish' must NOT be approximate -- the platform event genuinely does fire the trigger");

  const notesChild = findChild(trigTree, 'PubStoryPublisher.publishNotes');
  assert.ok(notesChild, 'EventBus.publish(events) with events:List<PubStoryNote__e> (collection form) must ALSO trigger PubStoryNoteTrigger');
  assert.strictEqual(notesChild.via, 'publish');
  assert.strictEqual(notesChild.approximate, false);

  // Ordinary wiring (resolves-today): trigger -> handler, unaffected by G1.
  const handlerTree = callers('pubstorynotehandler', 'handle');
  const handlerCaller = findChild(handlerTree, 'PubStoryNoteTrigger');
  assert.ok(handlerCaller, 'ordinary trigger -> handler wiring must resolve today via plain static/new dispatch, unaffected by G1');

  // G1(b): the platform-event-triggered flow's meta node is no longer
  // terminal -- its children are the publish sites on its object
  // (PubStoryNote__e), materialized the same way F1(b) materializes DML
  // children on a record-triggered flow.
  const invocableTree = callers('pubstoryflowinvocable', 'execute');
  const flowChild = invocableTree.root.children.find((c) => c.kind === 'flow');
  assert.ok(flowChild, 'PubStoryFlowInvocable.execute should surface PubStoryNoteFlow as a flow metadata caller');
  assert.strictEqual(flowChild.via, 'metadata');
  assert.strictEqual(flowChild.label, 'PubStoryNoteFlow');
  const flowPublishLabels = flowChild.children.map((c) => c.label);
  assert.ok(flowPublishLabels.includes('PubStoryPublisher.publishNote'), 'platform-event flow children must include the single-record publish site');
  assert.ok(flowPublishLabels.includes('PubStoryPublisher.publishNotes'), 'platform-event flow children must include the collection-form publish site');
  for (const c of flowChild.children) {
    assert.strictEqual(c.via, 'publish');
    assert.strictEqual(c.approximate, false);
    assert.deepStrictEqual(c.children, [], 'flow-publish children are themselves terminal');
  }
}

// =========================================================================
// v0.6.0 integrator assertions -- H1 seenElsewhere dedup, H3 inline
// overloadSig/argsRendered through the real uitree shaping step, H4
// zero-caller note, and H2 interface x override composition, ALL exercised
// end-to-end (real Apex source text -> parser.parseFile ->
// resolver.buildSemanticIndex -> resolver.buildCallerTree, and for H3 also
// -> uitree.shapeResult), against the fixtures added above.
// =========================================================================

// --- H1: seenElsewhere DAG-dedup diamond, end-to-end -------------------
{
  const tree = callers('v06deduptarget', 'dowork');
  assert.strictEqual(tree.stats.nodes, 6, 'H1 e2e: root(doWork) + Q + R + S(first, under Q) + Top.entry(under S#1) + S(second, seenElsewhere, under R) = 6 nodes');
  assert.strictEqual(tree.stats.uniqueMethods, 4, 'H1 e2e: 4 distinct child identities across the whole tree -- viaQ, viaR, viaS (once), entry');
  assert.strictEqual(tree.stats.capped, false, 'this tiny fixture never approaches the maxNodes cap');

  const qNode = findChild(tree, 'V06DedupQ.viaQ');
  const rNode = findChild(tree, 'V06DedupR.viaR');
  assert.ok(qNode && rNode, 'doWork() must show both direct callers Q.viaQ and R.viaR');
  assert.strictEqual(qNode.seenElsewhere, false, 'Q.viaQ is a first, ordinary occurrence');
  assert.strictEqual(rNode.seenElsewhere, false, 'R.viaR is a first, ordinary occurrence');

  const sUnderQ = qNode.children.find((c) => c.label === 'V06DedupS.viaS');
  const sUnderR = rNode.children.find((c) => c.label === 'V06DedupS.viaS');
  assert.ok(sUnderQ && sUnderR, 'S.viaS calls BOTH Q.viaQ and R.viaR, so it appears as a node under each');
  assert.strictEqual(sUnderQ.seenElsewhere, false, "S.viaS's FIRST occurrence (alphabetically, under Q) must expand normally");
  assert.strictEqual(sUnderQ.children.length, 1, "S.viaS's first occurrence keeps its own subtree (V06DedupTop.entry)");
  assert.strictEqual(sUnderQ.children[0].label, 'V06DedupTop.entry');

  assert.strictEqual(sUnderR.seenElsewhere, true, "S.viaS's SECOND occurrence (under R) must be a seenElsewhere reference node -- its subtree was already expanded once, under Q");
  assert.deepStrictEqual(sUnderR.children, [], 'H1: a seenElsewhere node\'s children are forced empty -- the subtree is not re-walked');
  assert.strictEqual(sUnderR.sites.length, 1, "H1: a seenElsewhere node's OWN sites (how R.viaR calls it) are still kept -- only the deeper subtree is deduped");
  assert.strictEqual(sUnderR.cyclic, false, 'seenElsewhere is not cyclic -- S is not an ancestor of R on this path');
}

// --- H2: interface x override composition, end-to-end -------------------
{
  // Control: the direct implementer's own method, unaffected by the H2 fix.
  const treeImpl = callers('v06compimpl', 'm');
  const implCaller = findChild(treeImpl, 'V06CompDispatcher.fan');
  assert.ok(implCaller, 'ordinary direct-implementer interface fan-out must keep working (control case)');
  assert.strictEqual(implCaller.via, 'interface');
  assert.strictEqual(implCaller.approximate, true);

  // The confirmed-missing edge: V06CompSubImpl overrides m() in a subclass
  // of the direct implementer, without redeclaring `implements` itself --
  // pre-H2, this returned zero callers.
  const treeSub = callers('v06compsubimpl', 'm');
  const subCaller = findChild(treeSub, 'V06CompDispatcher.fan');
  assert.ok(
    subCaller,
    'H2 e2e: V06CompSubImpl.m (an override in a SUBCLASS of the direct implementer) must be reachable from V06CompDispatcher.fan through the interface-typed parameter -- the confirmed missing-edge bug'
  );
  assert.strictEqual(subCaller.via, 'interface', "H2: the fan-down edge is still labeled via='interface' (dispatch is still through the interface-typed parameter), not 'override'");
  assert.strictEqual(subCaller.approximate, true, 'interface dispatch (including the H2 fan-down leg) stays approximate');
}

// --- H4: honest zero-caller note, end-to-end -----------------------------
{
  const tree = callers('v06zerocallertarget', 'nevercalled');
  assert.deepStrictEqual(tree.root.children, [], 'a genuinely uncalled method has no caller children');
  assert.strictEqual(
    tree.note,
    'No callers found — this is likely an entry point or unused code.',
    'H4 e2e: a resolved target with zero callers gets the exact required honest note text, not a silent empty tree'
  );
  const headerLines = uitree.shapeHeaderLines(tree);
  assert.strictEqual(headerLines[0], 'No callers found — this is likely an entry point or unused code.', 'H4 e2e: the note reaches the rendered header line via the real uitree.shapeHeaderLines step, and comes first');
  // This whole test.js corpus's index also carries a genuine workspace-wide
  // unresolvedSites count (unrelated to this specific target -- H4's
  // unresolvedSites stat is global to the index, not per-trace), which
  // surfaces here too as a second header line -- itself a real H4 behavior
  // worth pinning, not noise to suppress.
  // v0.7.1: was pinned at 1 pre-round; the Ns071Caller.probe() fixture below
  // (R1 e2e) used to add exactly one more real unresolved site (the
  // namespaced zenq.Ns071Target.run() reference), pinning this at 2.
  // v0.8/N1(a)/N2: that reference is now a 3-segment dotted call whose Head
  // ('zenq') is not a local var/class -- it is promoted to an EXTERNAL node
  // (zenq.Ns071Target, method run) per REGRESSION POLICY category (a)
  // ("references previously counted unresolved/metaUnresolved that match N1
  // shapes become external edges/nodes"). It is therefore REMOVED from the
  // unresolved tally (N5) and this pin moves back down to 1 (the original,
  // pre-R1 contributor -- see that fixture's own comment above, still
  // unaffected by v0.8 since it is a denylisted System.debug(...) body, not
  // a namespaced call). The reference is NOT silently dropped, though: it
  // now surfaces via the NEW externalRefs/externalNamespaces half of this
  // same header line (N5) instead of the plain unresolved-count sentence.
  assert.strictEqual(tree.stats.unresolvedSites, 1, 'sanity: this corpus has exactly 1 real unresolved call site elsewhere (see resolver.js contract -- global to the index); zenq.Ns071Target.run() moved to externalRefs under v0.8');
  assert.strictEqual(tree.stats.externalRefs, 1, 'v0.8/N5: zenq.Ns071Target.run() is the corpus\'s one managed-package (external) reference');
  assert.deepStrictEqual(tree.stats.externalNamespaces, ['zenq'], 'v0.8/N5: externalNamespaces lists the one namespace this corpus references');
  assert.strictEqual(headerLines.length, 2, 'note + the workspace-wide unresolved/managed-package line');
  assert.strictEqual(headerLines[1], '1 unresolved · 1 managed-package ref (zenq).', 'v0.8/N5: header now shows BOTH counts on one line once externalRefs > 0, per uitree.js shapeHeaderLines');
}

// --- v0.7.1/R1 e2e (superseded by v0.8/N1/N2, see below): namespaced-----
// reference honesty -- still true, for a different reason ------------------
{
  // No edge to the unrelated local class of the same bare tail: the
  // namespace-qualified reference must never fabricate a caller. Pre-v0.8
  // this was "unresolved, but counted"; post-v0.8 it is "external, and
  // counted differently" (see the H4 block immediately above) -- the "zero
  // false edge onto the local class" guarantee itself is unchanged.
  const targetTree = callers('ns071target', 'run');
  assert.deepStrictEqual(targetTree.root.children, [], 'R1 e2e: zenq.Ns071Target.run() must NOT collapse onto the local Ns071Target.run -- zero callers, not a fabricated static edge');
  assert.strictEqual(
    targetTree.note,
    'No callers found — this is likely an entry point or unused code.',
    'R1 e2e: the honest H4 note fires exactly as it would for a genuinely uncalled method -- the namespaced reference leaves no trace of a false edge'
  );
  // v0.8/N1(a)/N4: the reference now has a POSITIVE landing spot -- the
  // external node 'zenq.Ns071Target' -- tracing THAT as a caller-direction
  // target must surface Ns071Caller.probe as a local referencing site.
  const externalTree = callers('zenq.ns071target', null);
  assert.strictEqual(externalTree.root.kind, 'external', 'v0.8/N4: tracing the external node itself yields a root of kind=external');
  assert.strictEqual(externalTree.root.label, 'zenq.Ns071Target', 'v0.8/N4: external root label is the ns.className pair');
  const nsCaller = findChild(externalTree, 'Ns071Caller.probe');
  assert.ok(nsCaller, 'v0.8/N4: the external node\'s caller tree includes the local Ns071Caller.probe referencing site');
  assert.strictEqual(nsCaller.via, 'external', "v0.8/N2 step 3: the edge into the external node is labeled via='external'");
  assert.strictEqual(nsCaller.approximate, false, 'v0.8/N2: an external edge is NOT approximate -- it is a confident (namespace-precedence) resolution, not a guess');
}

// --- v0.7.1/R4 e2e: template-method hook callers via override fan-out ----
{
  const subTree = callers('tpl071sub', 'hook');
  const baseCaller = findChild(subTree, 'Tpl071Base.run');
  assert.ok(
    baseCaller,
    'R4 e2e: Tpl071Base.run() (a bare, implicit-this self-call to its own virtual hook()) must reach the SUBCLASS override Tpl071Sub.hook -- pre-R4 this returned "No callers found" despite being reached at runtime via run() -> hook()'
  );
  assert.strictEqual(baseCaller.via, 'override', "R4 e2e: the self-dispatch fan-out edge is via='override', mirroring the pre-existing typed/interface override fan-out convention");
  assert.strictEqual(baseCaller.approximate, true, 'R4 e2e: override fan-out stays approximate, same as every other override-fanout edge in this engine');
}

// --- H3: inline overloadSig/argsRendered through the real uitree shaping
//     step (not just resolver.js's site data -- the RENDERED label text) --
{
  const tree = callers('overloadtarget2', 'calc');
  const shaped = uitree.shapeResult(tree);
  assert.strictEqual(shaped.length, 1, 'shapeResult wraps the traced target as the sole top-level UiNode');
  const callerUiNode = shaped[0].children.find((c) => c.label === 'OverloadCaller2.go');
  assert.ok(callerUiNode, 'OverloadCaller2.go must appear as a shaped caller node');
  const siteLabels = callerUiNode.children.map((s) => s.label);
  assert.ok(
    siteLabels.includes("L4: t.calc('hello');\n-> calc(String) · s: 'hello'"),
    "H3 e2e: the String-literal overload's site label carries the inline 'L<line>: <lineText>' PLUS a second '-> overloadSig · argsRendered' line, through the real uitree shaping step"
  );
  assert.ok(
    siteLabels.includes('L5: t.calc(5);\n-> calc(Integer) · i: 5'),
    'H3 e2e: the Integer-literal overload site is rendered the same way, with its own overloadSig/argsRendered'
  );
}

// =========================================================================
// v0.7.0 integrator assertions -- Feature A (forward tracing) and Feature B
// (multi-package awareness), end to end (real Apex source text ->
// parser.parseFile -> resolver.buildSemanticIndex -> both
// resolver.buildCallerTree/buildCalleeTree). Mirrors the MANIFEST.md v0.7
// "Feature A -- Forward tracing ground truth" A1/A2/A3 chains and the
// package matrix, as a synthetic parallel proof (test.js's own stated
// purpose -- see this file's header note -- is proving the pipeline
// end-to-end through its own self-contained fixtures, distinct from
// dev/regress-callers-v07.js and the groundtruth harness, which exercise
// the real adv-org corpus).
// =========================================================================

// --- FORWARD TRANSACTION STORY, asserted node by node: controller ->
//     service -> DML -> {trigger, record-triggered flow}; trigger ->
//     handler -> invocable. REUSES the pre-existing v0.4.0 TxStory*
//     fixtures verbatim (no new files) -- the exact same corpus already
//     proven correct in the REVERSE direction above (see the "v0.4.0
//     TRANSACTION-STORY" assertions block), now traced FORWARD. -------------
{
  // Link 1 (controller -> service): 'TxStoryService svc = new
  // TxStoryService(); svc.recalcStory(story);' is TWO ordinary forward call
  // sites (unlike the async-collapse rule, a plain new+typed-call pair is
  // NOT collapsed) -- the constructor and the typed dispatch each get their
  // own child.
  const controllerTree = callees('txstorycontroller', 'submitstory');
  assert.strictEqual(controllerTree.direction, 'callees');
  const svcCtor = controllerTree.root.children.find((c) => c.label === 'TxStoryService.<init>');
  assert.ok(svcCtor, 'forward link 1a: TxStoryController.submitStory constructs TxStoryService');
  assert.strictEqual(svcCtor.via, 'new');
  const svcCall = controllerTree.root.children.find((c) => c.label === 'TxStoryService.recalcStory');
  assert.ok(svcCall, 'forward link 1b: TxStoryController.submitStory calls svc.recalcStory(story)');
  assert.strictEqual(svcCall.via, 'typed');
  assert.strictEqual(controllerTree.root.children.length, 2, 'submitStory has exactly 2 forward call sites, no more');

  // Link 2 (service -> DML fan-out): the SAME 'update story;' statement
  // forwards to BOTH the matching trigger AND the matching record-triggered
  // flow -- the A1 transaction-story shape.
  const serviceTree = callees('txstoryservice', 'recalcstory');
  const trigChild = serviceTree.root.children.find((c) => c.kind === 'trigger');
  assert.ok(trigChild, 'forward link 2a: the update DML statement must forward to TxStoryTrigger');
  assert.strictEqual(trigChild.label, 'TxStoryTrigger');
  assert.strictEqual(trigChild.via, 'dml');
  assert.strictEqual(trigChild.approximate, false, "via='dml' must not be approximate -- the trigger genuinely fires");

  const flowChild = serviceTree.root.children.find((c) => c.kind === 'flow');
  assert.ok(flowChild, 'forward link 2b: the SAME update DML statement must ALSO forward to TxStoryFollowUpFlow');
  assert.strictEqual(flowChild.label, 'TxStoryFollowUpFlow');
  assert.strictEqual(flowChild.via, 'dml');
  assert.strictEqual(flowChild.truncated, true, 'A2: a record-triggered flow node is TERMINAL in the forward direction');
  assert.deepStrictEqual(flowChild.children, [], 'a terminal flow node must have no children');

  // Link 3 (trigger -> handler): unlike a flow node, a '(trigger)' node is
  // NOT terminal forward -- tracing continues into its handler exactly like
  // tracing forward from any other method (union of the '(init)' and
  // '(trigger)' scopes, per buildCalleeTree's own trigger-target header
  // note).
  const trigTree = callees('txstorytrigger', null);
  assert.strictEqual(trigTree.root.kind, 'trigger');
  const handlerCtor = trigTree.root.children.find((c) => c.label === 'TxStoryTriggerHandler.<init>');
  assert.ok(handlerCtor, 'forward link 3a: TxStoryTrigger constructs TxStoryTriggerHandler');
  assert.strictEqual(handlerCtor.via, 'new');
  const handlerCall = trigTree.root.children.find((c) => c.label === 'TxStoryTriggerHandler.handle');
  assert.ok(handlerCall, 'forward link 3b: TxStoryTrigger calls .handle() on the freshly constructed handler');
  assert.strictEqual(handlerCall.via, 'typed');

  // Link 4 (handler -> invocable): ordinary static dispatch, resolves-today.
  const handlerTree = callees('txstorytriggerhandler', 'handle');
  const invocableChild = handlerTree.root.children.find((c) => c.label === 'TxStoryInvocable.execute');
  assert.ok(invocableChild, 'forward link 4: TxStoryTriggerHandler.handle calls TxStoryInvocable.execute');
  assert.strictEqual(invocableChild.via, 'static');
  assert.strictEqual(handlerTree.root.children.length, 1, 'handle() has exactly 1 forward call site');
}

// --- FORWARD ASYNC CHAIN: System.enqueueJob(new FwdAsyncJob()) collapses
//     to a single via='async' child at the job's own execute() method -- no
//     separate '<init>' child for the inline constructor argument (G5
//     forward-collapse). ------------------------------------------------
{
  const tree = callees('fwdasyncorchestrator', 'runmaintenance');
  assert.strictEqual(tree.root.children.length, 1, 'runMaintenance() collapses to exactly ONE forward child, not two');
  const asyncChild = tree.root.children[0];
  assert.strictEqual(asyncChild.label, 'FwdAsyncJob.execute');
  assert.strictEqual(asyncChild.via, 'async');
  assert.ok(
    !tree.root.children.some((c) => c.label === 'FwdAsyncJob.<init>'),
    'G5 forward-collapse: the inline `new FwdAsyncJob()` argument must NOT ALSO appear as a separate <init> child'
  );
}

// --- FORWARD THROW TERMINAL: reuses the pre-existing v0.5.0 ExcStory*
//     fixtures (no new files) -- ExcStoryValidator.validate's guard-clause
//     throw forwards to a terminal, non-approximate 'exception' node.
//     Directly exercises this round's resolver.js reconciliation fix: the
//     exception-class node's approximate flag is now computed from
//     APPROX_VIA (via='throws' is NOT a member) instead of being hardcoded
//     true -- see resolver.js's own A3 comment and MANIFEST.md's A3 ground
//     truth, which tags this node terminal but never approximate. -------
{
  const tree = callees('excstoryvalidator', 'validate');
  assert.strictEqual(tree.root.children.length, 1, "validate(Id)'s only statement is the guard-clause throw");
  const excChild = tree.root.children[0];
  assert.strictEqual(excChild.label, 'ExcStoryValidationException');
  assert.strictEqual(excChild.kind, 'exception');
  assert.strictEqual(excChild.via, 'throws');
  assert.strictEqual(excChild.truncated, true, 'A3: an exception-class node is TERMINAL in the forward direction');
  assert.strictEqual(excChild.approximate, false, "A3/reconciliation: via='throws' is not in APPROX_VIA -- an exception-class node must NOT be flagged approximate, matching MANIFEST.md's A3 ground truth");
  assert.deepStrictEqual(excChild.children, [], 'a terminal exception node must have no children');
  assert.ok(
    !tree.root.children.some((c) => c.label === 'ExcStoryValidationException.<init>'),
    "G2 forward-collapse: the throw statement's own `new ExcStoryValidationException(...)` must NOT ALSO appear as a separate <init> child"
  );
}

// =========================================================================
// v0.7.0 B PACKAGE MATRIX: multi-package awareness through the FULL
// pipeline (real Apex source text -> parser.parseFile -> packageOf(fsPath)
// -> resolver.buildSemanticIndex -> BOTH tree directions), as its own
// self-contained mini-corpus (Pkg* prefix) indexed SEPARATELY from the main
// `files`/`index` above -- packageOf's presence must never perturb any
// pre-v0.7 assertion elsewhere in this file, notably the pre-existing
// Dup1/Dup.cls vs Dup2/Dup.cls first-wins-drop fixture (still indexed with
// no opts at all, still first-wins, completely untouched by this section).
// =========================================================================

const pkgFiles = [];
function addPkgFile(relPath, text) {
  pkgFiles.push(parser.parseFile({ path: `/ws/${relPath}`, text }));
}

// 'PkgDup' declared in 3 packages (alpha/beta/delta), deliberately
// different bodies, same method name -- the duplicate-name fixture used for
// same-package-preference and default-package-fallback below. pkg-alpha is
// the DEFAULT package, and is deliberately ONE OF THE 3 CANDIDATES here --
// see PkgDup2 below for why genuine ambiguity needs a DIFFERENT shape.
addPkgFile('pkg-alpha/classes/PkgDup.cls', [
  'public class PkgDup {',
  '  public static void identify() { System.debug(\'alpha\'); }',
  '}',
].join('\n'));
addPkgFile('pkg-beta/classes/PkgDup.cls', [
  'public class PkgDup {',
  '  public static void identify() { System.debug(\'beta\'); }',
  '}',
].join('\n'));
addPkgFile('pkg-delta/classes/PkgDup.cls', [
  'public class PkgDup {',
  '  public static void identify() { System.debug(\'delta\'); }',
  '}',
].join('\n'));

// Same-package preference: a pkg-alpha caller referencing PkgDup.identify().
addPkgFile('pkg-alpha/classes/PkgAlphaCaller.cls', [
  'public class PkgAlphaCaller {',
  '  public void go() { PkgDup.identify(); }',
  '}',
].join('\n'));

// Default-package fallback: pkg-gamma declares no PkgDup of its own, and is
// not one of the 3 candidate packages -- falls through to the DEFAULT
// package (pkg-alpha).
addPkgFile('pkg-gamma/classes/PkgGammaCaller.cls', [
  'public class PkgGammaCaller {',
  '  public void go() { PkgDup.identify(); }',
  '}',
].join('\n'));

// 'PkgDup2' declared ONLY in pkg-beta/pkg-delta -- NEITHER is the default
// package (pkg-alpha), which is exactly the shape genuine ambiguity
// requires (mirrors test-resolver.js's own B3 fixture design note: rule 2's
// default-package fallback trivially "succeeds" whenever the default
// happens to be one of the colliding candidates, as PkgDup above
// demonstrates for pkg-gamma -- ambiguity is only reachable when the
// default package is NOT among the candidates at all).
addPkgFile('pkg-beta/classes/PkgDup2.cls', [
  'public class PkgDup2 {',
  '  public static void identify() { System.debug(\'beta2\'); }',
  '}',
].join('\n'));
addPkgFile('pkg-delta/classes/PkgDup2.cls', [
  'public class PkgDup2 {',
  '  public static void identify() { System.debug(\'delta2\'); }',
  '}',
].join('\n'));

// Genuinely ambiguous: pkg-epsilon is outside BOTH PkgDup2 candidate
// packages (beta/delta) AND is not the default (alpha) -- rule 1
// (same-package) and rule 2 (default-package) both fail, so resolution
// fans out to ALL candidates, via='ambiguous'.
addPkgFile('pkg-epsilon/classes/PkgEpsilonCaller.cls', [
  'public class PkgEpsilonCaller {',
  '  public void go() { PkgDup2.identify(); }',
  '}',
].join('\n'));

// packageOf(fsPath) -- mirrors how the REAL extension.js derives this from
// sfdx-project.json's packageDirectories (B1); resolver.js itself never
// parses paths, see buildSemanticIndex's own opts contract.
function pkgPackageOf(fsPath) {
  const m = /\/ws\/(pkg-[a-z]+)\//.exec(fsPath || '');
  return m ? m[1] : null;
}
const PKG_DEFAULT_PACKAGE = 'pkg-alpha';

const pkgIndex = resolver.buildSemanticIndex(pkgFiles, { packageOf: pkgPackageOf, defaultPackage: PKG_DEFAULT_PACKAGE });

{
  assert.strictEqual(pkgIndex.stats.duplicateNames, 2, 'v0.7 e2e: PkgDup (3-way) and PkgDup2 (2-way) are the 2 duplicated qualified names, through the real parser pipeline');
  const bucket = pkgIndex.classBuckets.get('pkgdup');
  assert.strictEqual(bucket.length, 3, 'classBuckets exposes all 3 same-name PkgDup candidates');

  const alphaEntry = bucket.find((b) => b.package === 'pkg-alpha');
  const betaEntry = bucket.find((b) => b.package === 'pkg-beta');
  const deltaEntry = bucket.find((b) => b.package === 'pkg-delta');
  assert.ok(alphaEntry && betaEntry && deltaEntry, 'all 3 package candidates present in the PkgDup bucket');

  // Same-package preference (reverse direction).
  const treeAlpha = resolver.buildCallerTree(pkgIndex, { classLower: alphaEntry.classLower, methodLower: 'identify' }, {});
  const alphaCaller = treeAlpha.root.children.find((c) => c.label === 'PkgAlphaCaller.go');
  assert.ok(alphaCaller, 'B1 e2e: PkgAlphaCaller (in pkg-alpha) resolves to the pkg-alpha PkgDup candidate (same-package preference)');
  assert.strictEqual(alphaCaller.via, 'static');

  const treeBeta = resolver.buildCallerTree(pkgIndex, { classLower: betaEntry.classLower, methodLower: 'identify' }, {});
  assert.ok(!treeBeta.root.children.some((c) => c.label === 'PkgAlphaCaller.go'), 'B1 e2e: same-package preference wins outright -- no ALSO fanning out to the pkg-beta candidate too');

  // Default-package fallback (reverse direction): pkg-gamma has no PkgDup
  // of its own -> falls through to the default package (pkg-alpha).
  const gammaCaller = treeAlpha.root.children.find((c) => c.label === 'PkgGammaCaller.go');
  assert.ok(gammaCaller, 'B2 rule 2 e2e: PkgGammaCaller (outside every candidate package) resolves to the DEFAULT package candidate (pkg-alpha)');
  assert.strictEqual(gammaCaller.via, 'static');
  assert.ok(!treeBeta.root.children.some((c) => c.label === 'PkgGammaCaller.go'), 'B2 rule 2 e2e: the non-default pkg-beta candidate must NOT be chosen instead');

  // Genuinely ambiguous (both directions), on PkgDup2 (beta/delta only, no
  // default-package candidate to fall back to): pkg-epsilon fans out to
  // both candidates.
  const bucket2 = pkgIndex.classBuckets.get('pkgdup2');
  assert.strictEqual(bucket2.length, 2, 'classBuckets exposes both PkgDup2 candidates');
  const beta2Entry = bucket2.find((b) => b.package === 'pkg-beta');
  const delta2Entry = bucket2.find((b) => b.package === 'pkg-delta');
  const treeBeta2 = resolver.buildCallerTree(pkgIndex, { classLower: beta2Entry.classLower, methodLower: 'identify' }, {});
  const treeDelta2 = resolver.buildCallerTree(pkgIndex, { classLower: delta2Entry.classLower, methodLower: 'identify' }, {});
  const epsilonInBeta2 = treeBeta2.root.children.find((c) => c.label === 'PkgEpsilonCaller.go');
  const epsilonInDelta2 = treeDelta2.root.children.find((c) => c.label === 'PkgEpsilonCaller.go');
  assert.ok(epsilonInBeta2 && epsilonInDelta2, 'B3 e2e: the ambiguous call site produces an edge to BOTH candidates, from the same call site');
  for (const c of [epsilonInBeta2, epsilonInDelta2]) {
    assert.strictEqual(c.via, 'ambiguous');
    assert.strictEqual(c.approximate, true, "B3 e2e: via='ambiguous' must join the approximate set");
  }

  // Forward direction sees the same fan-out from the caller's own side, and
  // each candidate node carries its own package label (B3 badge plumbing).
  const calleeTreeEps = resolver.buildCalleeTree(pkgIndex, { classLower: 'pkgepsiloncaller', methodLower: 'go' }, {});
  assert.strictEqual(calleeTreeEps.root.children.length, 2, 'B3 forward e2e: the ambiguous call site forwards to both candidates');
  for (const c of calleeTreeEps.root.children) {
    assert.strictEqual(c.label, 'PkgDup2.identify');
    assert.strictEqual(c.via, 'ambiguous');
    assert.strictEqual(c.approximate, true);
  }
  const badgePackages = calleeTreeEps.root.children.map((c) => c.package).sort();
  assert.deepStrictEqual(badgePackages, ['pkg-beta', 'pkg-delta'], 'B3 e2e: each forward candidate node carries its own package label for the UI badge');

  // Forward direction, same-package (non-ambiguous) call site for contrast
  // -- resolves to exactly ONE candidate, no fan-out.
  const calleeTreeAlphaCaller = resolver.buildCalleeTree(pkgIndex, { classLower: 'pkgalphacaller', methodLower: 'go' }, {});
  assert.strictEqual(calleeTreeAlphaCaller.root.children.length, 1, 'B1 forward e2e: same-package call site resolves to exactly ONE candidate, no fan-out');
  assert.strictEqual(calleeTreeAlphaCaller.root.children[0].via, 'static');
  assert.strictEqual(calleeTreeAlphaCaller.root.children[0].package, 'pkg-alpha');

  // B5 (through the real parser pipeline this time): a SEPARATE index over
  // the SAME pkgFiles with NO opts at all must reproduce first-wins-drop
  // behavior exactly, byte-identical to pre-v0.7.
  const pkgIndexNoOpts = resolver.buildSemanticIndex(pkgFiles);
  assert.strictEqual(pkgIndexNoOpts.stats.duplicateNames, 0, 'B5 e2e: stats.duplicateNames stays 0 when opts.packageOf is inactive, even with real duplicate names present, through the real parser pipeline');
  const treeNoOpts = resolver.buildCallerTree(pkgIndexNoOpts, { classLower: 'pkgdup', methodLower: 'identify' }, {});
  const noOptsCallers = treeNoOpts.root.children.map((c) => c.label).sort();
  assert.deepStrictEqual(
    noOptsCallers,
    ['PkgAlphaCaller.go', 'PkgGammaCaller.go'],
    'B5 e2e: BOTH callers resolve to the single first-wins PkgDup slot (pkg-alpha, first-parsed) -- no package-based split at all'
  );
  for (const c of treeNoOpts.root.children) {
    assert.strictEqual(c.via, 'static', "B5 e2e: via stays 'static' -- 'ambiguous' must never appear when packageOf is inactive");
  }
}

// =========================================================================
// v0.8/N1/N2/N4 e2e: external-node story, forward direction. A local
// service calls into a managed namespace (zenq.Billing.charge) -- the
// callee-direction trace must show a TERMINAL external leaf (kind
// 'external'), and (mirroring the H4/R1 block far above, which already
// pins the REVERSE direction via the Ns071 fixtures) tracing that SAME
// external node as a caller-direction root target must list the local
// caller. Built as its OWN isolated fixture set/index (like pkgFiles/
// pkgIndex above) so it cannot perturb the main corpus's pinned
// unresolvedSites/externalRefs counts.
// =========================================================================
const v08Files = [];
function addV08File(relPath, text) {
  const p = '/v08ws/' + relPath;
  v08Files.push(parser.parseFile({ path: p, text }));
}
addV08File('classes/V08BillingCaller.cls', [
  'public class V08BillingCaller {',
  '  public void runBilling(Decimal amount) {',
  '    zenq.Billing.charge(amount);',
  '  }',
  '}',
].join('\n'));
const v08Index = resolver.buildSemanticIndex(v08Files);

{
  // Forward (callee) direction: local service -> zenq.Billing.charge
  // external TERMINAL leaf. (parser.js's own dot-chain shape emits a SECOND,
  // unrelated 'prop'-kind pseudo-call for the same source line -- e.g. a
  // property-style get on 'zenq' -- which resolver.js aggregates into the
  // ordinary "N unresolved sites" leaf; this is pre-existing chained-
  // expression behavior confirmed live against the real gauntlet-org corpus
  // (VertexLedgerBridge.postToLedger's own callee tree shows the same
  // pattern), unrelated to v0.8, so this e2e only pins the EXTERNAL child.)
  const calleeTree = resolver.buildCalleeTree(v08Index, { classLower: 'v08billingcaller', methodLower: 'runbilling' }, {});
  const extChild = calleeTree.root.children.find((c) => c.kind === 'external');
  assert.ok(extChild, 'v0.8/N4 e2e: V08BillingCaller.runBilling has a forward external-node child');
  assert.strictEqual(extChild.kind, 'external', 'v0.8/N4: the forward child is kind=external');
  assert.strictEqual(extChild.label, 'zenq.Billing', 'v0.8/N1(a): external node label is the ns.className pair');
  assert.strictEqual(extChild.via, 'external', "v0.8/N2 step 3: edge into the external is via='external'");
  assert.strictEqual(extChild.approximate, false, 'v0.8/N2: external edges are confident, not approximate');
  assert.deepStrictEqual(extChild.children, [], 'v0.8/N4: an external node is TERMINAL in the callees direction -- no source to recurse into');

  // Reverse (caller) direction, rooted directly AT the external node:
  // tracing 'zenq.billing' as a target must return the local referencing
  // site as a normal caller-tree node above it.
  const externalCallerTree = resolver.buildCallerTree(v08Index, { classLower: 'zenq.billing', methodLower: null }, {});
  assert.strictEqual(externalCallerTree.root.kind, 'external', 'v0.8/N4 e2e: tracing the external node as a target yields kind=external at the root');
  assert.strictEqual(externalCallerTree.root.label, 'zenq.Billing');
  assert.strictEqual(externalCallerTree.root.children.length, 1, 'v0.8/N4 e2e: exactly one local referencing site (caller) above the external root');
  assert.strictEqual(externalCallerTree.root.children[0].label, 'V08BillingCaller.runBilling', "v0.8/N4 e2e: 'its callers are all local referencing sites -- full normal caller tree above them'");
}

// =========================================================================
// v0.8/N3 e2e: own-namespace local resolution. A workspace whose OWN
// declared namespace (opts.ownNamespace, mirroring sfdx-project.json's
// `namespace` property via extension.js) matches the prefix of a dotted
// receiver/DML-object token must resolve LOCALLY (prefix stripped before
// resolution), never create an external node for its own namespace. Own
// isolated fixture set/index, deliberately reusing the SAME v08Files
// source text with a DIFFERENT opts.ownNamespace -- pins that ownNamespace
// is a pure per-buildSemanticIndex-call opt, not global state.
// =========================================================================
{
  const v08NsFiles = [];
  const addNsFile = (relPath, text) => v08NsFiles.push(parser.parseFile({ path: '/v08nsws/' + relPath, text }));
  addNsFile('classes/AcmeOwnNsTarget.cls', [
    'public class AcmeOwnNsTarget {',
    '  public static void doWork() { System.debug(\'own-ns local target\'); }',
    '}',
  ].join('\n'));
  addNsFile('classes/AcmeOwnNsCaller.cls', [
    'public class AcmeOwnNsCaller {',
    '  public void call() {',
    '    acme.AcmeOwnNsTarget.doWork();',
    '  }',
    '}',
  ].join('\n'));

  const ownNsIndex = resolver.buildSemanticIndex(v08NsFiles, { ownNamespace: 'acme' });
  assert.strictEqual(ownNsIndex.stats.externalRefs, 0, 'v0.8/N3 e2e: the own-namespace-prefixed reference resolves locally -- zero external refs, not one');
  assert.deepStrictEqual(ownNsIndex.stats.externalNamespaces, [], 'v0.8/N3 e2e: the workspace\'s own namespace never appears as an external namespace');

  const ownNsTree = resolver.buildCallerTree(ownNsIndex, { classLower: 'acmeownnstarget', methodLower: 'dowork' }, {});
  assert.strictEqual(ownNsTree.root.children.length, 1, 'v0.8/N3 e2e: acme.AcmeOwnNsTarget.doWork() resolves as ONE local caller edge, not zero (and not an external)');
  assert.strictEqual(ownNsTree.root.children[0].label, 'AcmeOwnNsCaller.call');
  assert.strictEqual(ownNsTree.root.children[0].via, 'static', 'v0.8/N3: post-strip, this is an ordinary local static call -- via stays \'static\', never \'external\'');

  // Negative control: building the IDENTICAL source WITHOUT opts.ownNamespace
  // must treat 'acme' as a foreign namespace token instead -- external node,
  // not a local edge. Proves the v0.8/N3 fixture above is actually exercising
  // the stripping path, not some unrelated always-resolves-locally rule.
  const noOwnNsIndex = resolver.buildSemanticIndex(v08NsFiles);
  const noOwnNsTree = resolver.buildCallerTree(noOwnNsIndex, { classLower: 'acmeownnstarget', methodLower: 'dowork' }, {});
  assert.deepStrictEqual(noOwnNsTree.root.children, [], 'v0.8/N3 negative control: WITHOUT opts.ownNamespace, acme.AcmeOwnNsTarget.doWork() must NOT resolve locally');
  assert.ok(noOwnNsIndex.externals instanceof Map && noOwnNsIndex.externals.has('acme.acmeownnstarget'), 'v0.8/N3 negative control: without ownNamespace, the SAME reference becomes an external node instead');
}

// =========================================================================
// v0.9 (integrator): full-pipeline progressive-depth e2e story --
// parser.parseFile -> resolver.buildSemanticIndex -> resolver.buildCallerTree
// (initialDepth) -> uitree.shapeResult/shapeNode -> pathmap.buildPathMapData,
// proving all three consuming modules agree on one node's frontier identity
// end to end (not just resolver.js's own unit-level P1 pins in
// test-resolver.js, or uitree.js/pathmap.js's own bare-TNode-fixture pins in
// test-uitree.js/test-pathmap.js).
//
// Shape ("gauntlet-org"-style two-branch fork, real parsed Apex source, own
// isolated fixture set/index like v08Files/v08NsFiles above so it cannot
// perturb the main corpus's pinned counts):
//
//   GtOrgLeafService.process()                          <- depth 0 (target)
//     <- GtOrgCallerA.callA()                            <- depth 1 (auto)
//          <- GtOrgMidA.viaA()                           <- depth 2 (FRONTIER, pendingCount 2)
//               <- GtOrgRootA1.upA1()                    <- depth 3 (leaf)
//               <- GtOrgRootA2.upA2()                    <- depth 3 (leaf)
//     <- GtOrgCallerB.callB()                            <- depth 1 (auto)
//          <- GtOrgMidB.viaB()                           <- depth 2 (FRONTIER, pendingCount 1)
//               <- GtOrgRootB1.upB1()                    <- depth 3 (leaf)
//
// With initialDepth=2, depth-1 nodes auto-expand (1 < 2) but depth-2 nodes
// (viaA/viaB) hit the frontier (2 >= 2) -- exactly TWO frontier nodes,
// with DIFFERING pendingCounts (2 vs 1), so a single pendingCount getting
// silently hardcoded/copy-pasted across both branches would be caught.
// =========================================================================
{
  const gtOrgFiles = [];
  const addGtOrgFile = (relPath, text) => gtOrgFiles.push(parser.parseFile({ path: '/gtorgws/' + relPath, text }));

  addGtOrgFile('classes/GtOrgLeafService.cls', [
    'public class GtOrgLeafService {',
    '  public static void process() { System.debug(\'leaf\'); }',
    '}',
  ].join('\n'));
  addGtOrgFile('classes/GtOrgCallerA.cls', [
    'public class GtOrgCallerA {',
    '  public static void callA() { GtOrgLeafService.process(); }',
    '}',
  ].join('\n'));
  addGtOrgFile('classes/GtOrgCallerB.cls', [
    'public class GtOrgCallerB {',
    '  public static void callB() { GtOrgLeafService.process(); }',
    '}',
  ].join('\n'));
  addGtOrgFile('classes/GtOrgMidA.cls', [
    'public class GtOrgMidA {',
    '  public static void viaA() { GtOrgCallerA.callA(); }',
    '}',
  ].join('\n'));
  addGtOrgFile('classes/GtOrgMidB.cls', [
    'public class GtOrgMidB {',
    '  public static void viaB() { GtOrgCallerB.callB(); }',
    '}',
  ].join('\n'));
  addGtOrgFile('classes/GtOrgRootA1.cls', [
    'public class GtOrgRootA1 {',
    '  public static void upA1() { GtOrgMidA.viaA(); }',
    '}',
  ].join('\n'));
  addGtOrgFile('classes/GtOrgRootA2.cls', [
    'public class GtOrgRootA2 {',
    '  public static void upA2() { GtOrgMidA.viaA(); }',
    '}',
  ].join('\n'));
  addGtOrgFile('classes/GtOrgRootB1.cls', [
    'public class GtOrgRootB1 {',
    '  public static void upB1() { GtOrgMidB.viaB(); }',
    '}',
  ].join('\n'));

  const gtOrgIndex = resolver.buildSemanticIndex(gtOrgFiles);
  const gtOrgTarget = { classLower: 'gtorgleafservice', methodLower: 'process' };

  const keyOfTNode = (n) => `${(n.className || '').toLowerCase()}#${n.methodLower || ''}`;
  const walkTNode = (n, fn) => { fn(n); for (const c of n.children || []) walkTNode(c, fn); };
  const findChildByLabel = (n, label) => (n.children || []).find((c) => c.label === label);

  // ---- step 1: initialDepth=2 trace -> exactly 2 frontier nodes, correct
  // (and DIFFERING) pendingCounts -------------------------------------------
  const shallow = resolver.buildCallerTree(gtOrgIndex, gtOrgTarget, { initialDepth: 2 });
  assert.strictEqual(shallow.stats.frontierNodes, 2, 'e2e: initialDepth=2 -- exactly 2 frontier nodes (viaA, viaB)');

  const callA = findChildByLabel(shallow.root, 'GtOrgCallerA.callA');
  const callB = findChildByLabel(shallow.root, 'GtOrgCallerB.callB');
  assert.ok(callA && callB, 'e2e: both depth-1 direct callers present, auto-expanded');
  assert.strictEqual(callA.expandable, undefined, 'e2e: depth1 < initialDepth(2) -- callA auto-expands, never marked expandable');

  const viaA = findChildByLabel(callA, 'GtOrgMidA.viaA');
  const viaB = findChildByLabel(callB, 'GtOrgMidB.viaB');
  assert.ok(viaA && viaB, 'e2e: both depth-2 frontier nodes present (empty children, not pruned)');
  assert.strictEqual(viaA.expandable, true, 'e2e: viaA hit the depth-2 frontier');
  assert.strictEqual(viaB.expandable, true, 'e2e: viaB hit the depth-2 frontier');
  assert.deepStrictEqual(viaA.children, [], 'e2e: a frontier node has empty children this pass');
  assert.strictEqual(viaA.pendingCount, 2, 'e2e: viaA pendingCount is exactly 2 (upA1, upA2) -- not copy-pasted from viaB');
  assert.strictEqual(viaB.pendingCount, 1, 'e2e: viaB pendingCount is exactly 1 (upB1) -- differs from viaA, proving both were computed independently');

  // ---- step 2: uitree shaping agrees with resolver.js on both frontier
  // nodes' identity/badge/synthetic load-more child --------------------------
  const shallowUiRoots = uitree.shapeResult(shallow, 'target-first');
  assert.strictEqual(shallowUiRoots.length, 1);
  function findUiNodeByLabel(uiNode, label) {
    if (uiNode.label === label) return uiNode;
    for (const c of uiNode.children || []) {
      const found = findUiNodeByLabel(c, label);
      if (found) return found;
    }
    return null;
  }
  const viaAUi = findUiNodeByLabel(shallowUiRoots[0], 'GtOrgMidA.viaA');
  const viaBUi = findUiNodeByLabel(shallowUiRoots[0], 'GtOrgMidB.viaB');
  assert.ok(viaAUi && viaBUi, 'e2e/uitree: both frontier UiNodes located by label');
  assert.ok(viaAUi.description.includes('+2'), "e2e/uitree: viaA's badge string includes the '+2' frontier marker");
  assert.ok(viaBUi.description.includes('+1'), "e2e/uitree: viaB's badge string includes the '+1' frontier marker");
  const viaALoadMore = (viaAUi.children || []).find((c) => c.loadMore);
  const viaBLoadMore = (viaBUi.children || []).find((c) => c.loadMore);
  assert.ok(viaALoadMore, 'e2e/uitree: viaA got a synthetic load-more child');
  assert.ok(viaBLoadMore, 'e2e/uitree: viaB got a synthetic load-more child');
  assert.strictEqual(viaALoadMore.expandKey, uitree.frontierMethodKey(viaA), "e2e/uitree: load-more child's expandKey matches uitree.frontierMethodKey(viaA)");
  assert.strictEqual(viaBLoadMore.expandKey, uitree.frontierMethodKey(viaB), "e2e/uitree: load-more child's expandKey matches uitree.frontierMethodKey(viaB)");
  assert.strictEqual(viaALoadMore.expandKey, 'gtorgmida#viaa', 'e2e/uitree: viaA expandKey is the expected classlower#methodlower identity');
  assert.strictEqual(viaBLoadMore.expandKey, 'gtorgmidb#viab', 'e2e/uitree: viaB expandKey is the expected classlower#methodlower identity');

  // ---- step 3: pathmap shaping agrees on the SAME identity/pendingCount ----
  const shallowMapData = pathmap.buildPathMapData(shallow);
  const viaAMapNode = shallowMapData.nodes.find((n) => n.label === 'GtOrgMidA.viaA');
  const viaBMapNode = shallowMapData.nodes.find((n) => n.label === 'GtOrgMidB.viaB');
  assert.ok(viaAMapNode && viaBMapNode, 'e2e/pathmap: both frontier map nodes located by label');
  assert.strictEqual(viaAMapNode.expandable, true);
  assert.strictEqual(viaAMapNode.pendingCount, 2);
  assert.strictEqual(viaAMapNode.expandKey, 'gtorgmida#viaa', 'e2e/pathmap: expandKey agrees with uitree/resolver');
  assert.strictEqual(viaBMapNode.expandable, true);
  assert.strictEqual(viaBMapNode.pendingCount, 1);
  assert.strictEqual(viaBMapNode.expandKey, 'gtorgmidb#viab', 'e2e/pathmap: expandKey agrees with uitree/resolver');

  // ---- step 4: expand TWO frontiers (viaA's key, then viaB's key,
  // mirroring extension.js's expandFrontierKey adding one clicked key at a
  // time) -> converged tree matches a full-depth trace ----------------------
  const expandedKeys = new Set();
  expandedKeys.add(uitree.frontierMethodKey(viaA));
  expandedKeys.add(uitree.frontierMethodKey(viaB));
  const converged = resolver.buildCallerTree(gtOrgIndex, gtOrgTarget, { initialDepth: 2, expandedKeys });
  assert.strictEqual(converged.stats.frontierNodes, 0, 'e2e: after expanding both frontier keys, zero frontier nodes remain (both branches bottom out at genuine leaves)');

  const convCallA = findChildByLabel(converged.root, 'GtOrgCallerA.callA');
  const convViaA = findChildByLabel(convCallA, 'GtOrgMidA.viaA');
  const convUpA1 = findChildByLabel(convViaA, 'GtOrgRootA1.upA1');
  const convUpA2 = findChildByLabel(convViaA, 'GtOrgRootA2.upA2');
  assert.ok(convUpA1 && convUpA2, 'e2e: expanding viaA reveals BOTH of its direct callers (upA1, upA2)');
  assert.strictEqual(convUpA1.expandable, undefined, 'e2e: upA1 is a genuine leaf -- no further callers, so never marked expandable (no dangling +0)');
  assert.deepStrictEqual(convUpA1.children, [], 'e2e: upA1 has no callers of its own');

  const convCallB = findChildByLabel(converged.root, 'GtOrgCallerB.callB');
  const convViaB = findChildByLabel(convCallB, 'GtOrgMidB.viaB');
  const convUpB1 = findChildByLabel(convViaB, 'GtOrgRootB1.upB1');
  assert.ok(convUpB1, 'e2e: expanding viaB reveals its one direct caller (upB1)');

  // The converged (initialDepth=2, both frontiers expanded) tree must be
  // BYTE-IDENTICAL (deep-equal) to a plain full-depth trace (no
  // initialDepth -- defaults to maxDepth, eager expansion throughout, same
  // as pre-v0.9): progressive expansion one click at a time must reach
  // exactly the same destination as tracing everything eagerly up front.
  const fullDepth = resolver.buildCallerTree(gtOrgIndex, gtOrgTarget, {});
  assert.deepStrictEqual(converged, fullDepth, 'e2e: converged (initialDepth=2 + both frontiers expanded) subtree matches a full-depth trace exactly');

  // ---- step 5: the converged tree also shapes identically through uitree/
  // pathmap (no residual frontier badges/pills/synthetic children anywhere) --
  const convergedUiRoots = uitree.shapeResult(converged, 'target-first');
  const fullDepthUiRoots = uitree.shapeResult(fullDepth, 'target-first');
  assert.deepStrictEqual(convergedUiRoots, fullDepthUiRoots, 'e2e/uitree: converged tree shapes identically to the full-depth trace');
  let anyLoadMore = false;
  walkTNode(converged.root, (n) => { if (n.expandable) anyLoadMore = true; });
  assert.strictEqual(anyLoadMore, false, 'e2e: no TNode anywhere in the converged tree is still marked expandable');

  const convergedMapData = pathmap.buildPathMapData(converged);
  const fullDepthMapData = pathmap.buildPathMapData(fullDepth);
  assert.deepStrictEqual(convergedMapData, fullDepthMapData, 'e2e/pathmap: converged tree\'s map data matches the full-depth trace\'s map data exactly');
  assert.ok(convergedMapData.nodes.every((n) => n.expandable === false), 'e2e/pathmap: no residual expandable:true pill anywhere once converged');
}

console.log('apex-trace end-to-end self-check: all assertions passed');

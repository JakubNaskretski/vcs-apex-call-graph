#!/usr/bin/env node
'use strict';
// Adversarial semantics-attack probe for v0.7 (forward tracing + multi-package
// awareness). Hand-built hostile fixtures, in-memory (no disk writes outside
// this dir, NO git). Each section is a standalone repro with its own PASS/FAIL
// assertion so a single failure doesn't hide the rest.

const parser = require('../parser');
const resolver = require('../resolver');

let failures = [];
function check(label, cond, detail) {
  if (cond) {
    console.log(`PASS  ${label}`);
  } else {
    console.log(`FAIL  ${label}${detail ? ' -- ' + detail : ''}`);
    failures.push(label);
  }
}

function fact(path, text) {
  return parser.parseFile({ path, text });
}

function findNode(node, pred) {
  if (!node) return null;
  if (pred(node)) return node;
  for (const c of node.children || []) {
    const r = findNode(c, pred);
    if (r) return r;
  }
  return null;
}
function countNodes(node) {
  if (!node) return 0;
  let n = 1;
  for (const c of node.children || []) n += countNodes(c);
  return n;
}

// =========================================================================
// 1. Forward recursion + mutual recursion (cycle flags, no hang)
// =========================================================================
(function testForwardRecursion() {
  const files = [
    fact('Rec.cls', `public class Rec {
  public Integer factorial(Integer n) {
    if (n <= 1) return 1;
    return n * factorial(n - 1);
  }
}`),
  ];
  const index = resolver.buildSemanticIndex(files);
  const t0 = Date.now();
  const tree = resolver.buildCalleeTree(index, { classLower: 'rec', methodLower: 'factorial' }, { maxDepth: 50, maxNodes: 2000 });
  const elapsed = Date.now() - t0;
  check('1a. self-recursion forward terminates fast', elapsed < 2000, `took ${elapsed}ms`);
  const selfChild = (tree.root.children || []).find((c) => c.methodLower === 'factorial' && c.className.toLowerCase() === 'rec');
  check('1b. self-recursion forward produces a child edge', !!selfChild);
  if (selfChild) {
    check('1c. self-recursion child flagged cyclic', selfChild.cyclic === true, JSON.stringify({ cyclic: selfChild.cyclic, children: (selfChild.children || []).length }));
    check('1d. cyclic node does not re-expand children (empty or absent)', (selfChild.children || []).length === 0, `children=${(selfChild.children || []).length}`);
  }
})();

(function testForwardMutualRecursion() {
  const files = [
    fact('MutA.cls', `public class MutA {
  public void ping() {
    MutB.pong();
  }
}`),
    fact('MutB.cls', `public class MutB {
  public static void pong() {
    MutA a = new MutA();
    a.ping();
  }
}`),
  ];
  const index = resolver.buildSemanticIndex(files);
  const t0 = Date.now();
  const tree = resolver.buildCalleeTree(index, { classLower: 'muta', methodLower: 'ping' }, { maxDepth: 50, maxNodes: 2000 });
  const elapsed = Date.now() - t0;
  check('1e. mutual recursion forward terminates fast', elapsed < 2000, `took ${elapsed}ms`);
  const totalNodes = countNodes(tree.root);
  check('1f. mutual recursion forward tree bounded (not exploding)', totalNodes < 50, `nodes=${totalNodes}`);
  // walk down: ping -> pong -> (new MutA, ping) -- the second 'ping' occurrence
  // at depth 2 must be flagged cyclic since ancestorPath already has muta#ping.
  const pongNode = findNode(tree.root, (n) => n.methodLower === 'pong');
  check('1g. mutual recursion reaches pong node', !!pongNode);
  if (pongNode) {
    const pingAgain = (pongNode.children || []).find((c) => c.methodLower === 'ping');
    check('1h. re-entrant ping (depth 2) flagged cyclic', pingAgain && pingAgain.cyclic === true, pingAgain ? JSON.stringify({ cyclic: pingAgain.cyclic }) : 'no ping child found under pong');
  }
})();

// =========================================================================
// 2. Forward through interface fan-out at cap
// =========================================================================
(function testInterfaceFanoutAtCap() {
  // Build an interface with MANY implementers, then trace forward from a
  // dispatcher with a tiny maxNodes cap to see if the fan-out respects the
  // cap cleanly (no crash, capped=true, node count <= maxNodes).
  const N = 30;
  const files = [
    fact('Notifiable.cls', `public interface Notifiable {
  void notify(String msg);
}`),
  ];
  let dispatcherBody = 'public class Dispatcher {\n  public void dispatchAll(String message) {\n    List<Notifiable> notifiers = new List<Notifiable>{\n';
  const ctorLines = [];
  for (let i = 0; i < N; i++) {
    const cls = `Impl${i}`;
    files.push(fact(`${cls}.cls`, `public class ${cls} implements Notifiable {
  public void notify(String msg) {
    System.debug(msg);
  }
}`));
    ctorLines.push(`      new ${cls}()`);
  }
  dispatcherBody += ctorLines.join(',\n') + '\n    };\n';
  dispatcherBody += '    for (Notifiable n : notifiers) {\n      n.notify(message);\n    }\n  }\n}';
  files.push(fact('Dispatcher.cls', dispatcherBody));

  const index = resolver.buildSemanticIndex(files);
  const smallCap = 10;
  let threw = null;
  let tree;
  try {
    tree = resolver.buildCalleeTree(index, { classLower: 'dispatcher', methodLower: 'dispatchall' }, { maxDepth: 10, maxNodes: smallCap });
  } catch (e) {
    threw = e;
  }
  check('2a. interface fan-out at tiny cap does not throw', !threw, threw && threw.stack);
  if (tree) {
    const totalNodes = countNodes(tree.root);
    check('2b. interface fan-out at cap respects maxNodes (<=cap, some slack allowed for root)', totalNodes <= smallCap + 1, `nodes=${totalNodes} cap=${smallCap}`);
    check('2c. stats.capped is true when fan-out exceeds cap', tree.stats.capped === true, JSON.stringify(tree.stats));
  }

  // Now uncapped: should reach interface node with N approximate implementer children.
  const treeFull = resolver.buildCalleeTree(index, { classLower: 'dispatcher', methodLower: 'dispatchall' }, { maxDepth: 10, maxNodes: 5000 });
  const ifaceNode = findNode(treeFull.root, (n) => n.className.toLowerCase() === 'notifiable' && n.methodLower === 'notify');
  check('2d. uncapped: interface method node reached', !!ifaceNode);
  if (ifaceNode) {
    check('2e. uncapped: interface node approximate=true, via=interface', ifaceNode.via === 'interface' && ifaceNode.approximate === true, JSON.stringify({ via: ifaceNode.via, approximate: ifaceNode.approximate }));
    check('2f. uncapped: interface fans out to all N implementers', (ifaceNode.children || []).length === N, `got ${(ifaceNode.children || []).length}, want ${N}`);
    const allApprox = (ifaceNode.children || []).every((c) => c.approximate === true && c.via === 'interface');
    check('2g. uncapped: every implementer child is approximate/via=interface', allApprox);
  }
})();

// =========================================================================
// 3. DML-forward on an object with NO trigger (no phantom node)
// =========================================================================
(function testDmlNoTrigger() {
  const files = [
    fact('NoTriggerObjUpdater.cls', `public class NoTriggerObjUpdater {
  public void doUpdate(Acme_Untriggered__c rec) {
    update rec;
  }
}`),
  ];
  const index = resolver.buildSemanticIndex(files);
  const tree = resolver.buildCalleeTree(index, { classLower: 'notriggerobjupdater', methodLower: 'doupdate' }, {});
  const triggerNode = findNode(tree.root, (n) => n.kind === 'trigger');
  check('3a. DML on object with no registered trigger creates NO trigger node', !triggerNode, triggerNode && JSON.stringify(triggerNode.label));
  const flowNode = findNode(tree.root, (n) => n.kind === 'flow');
  check('3b. DML on object with no matching flow creates NO flow node either', !flowNode, flowNode && JSON.stringify(flowNode.label));
  // Also must not silently manufacture an 'unresolved' leaf for the DML
  // statement (DML facts are a distinct fact type from ordinary calls, per
  // resolver.js's own comment on why 'new'/'prop' are excluded from the
  // unresolved-aggregate).
  const unresolvedNode = findNode(tree.root, (n) => n.kind === 'unresolved');
  check('3c. DML with no trigger/flow match does not manufacture an unresolved leaf', !unresolvedNode, unresolvedNode && JSON.stringify(unresolvedNode.label));
  check('3d. tree note reflects no traceable outbound calls', tree.note === 'This method makes no traceable outbound calls.', tree.note);
})();

// Contrast: DML on an object WITH a trigger DOES produce a trigger node
// (sanity check that 3a isn't just "trigger nodes never work").
(function testDmlWithTriggerSanity() {
  const files = [
    fact('TrigObjHandler.cls', `public class TrigObjHandler {
  public void handle() { System.debug('h'); }
}`),
    fact('TrigObjTrigger.trigger', `trigger TrigObjTrigger on Acme_Triggered__c (before update) {
  TrigObjHandler h = new TrigObjHandler();
  h.handle();
}`),
    fact('TrigObjUpdater.cls', `public class TrigObjUpdater {
  public void doUpdate(Acme_Triggered__c rec) {
    update rec;
  }
}`),
  ];
  const index = resolver.buildSemanticIndex(files);
  const tree = resolver.buildCalleeTree(index, { classLower: 'trigobjupdater', methodLower: 'doupdate' }, {});
  const triggerNode = findNode(tree.root, (n) => n.kind === 'trigger');
  check('3e. sanity: DML WITH a matching trigger DOES produce a trigger node', !!triggerNode, JSON.stringify(tree.root.children));
})();

// =========================================================================
// 4. '(trigger)' as the forward-trace TARGET (its callees = handler chain)
// =========================================================================
(function testTriggerAsForwardTarget() {
  const files = [
    fact('TrigHandler.cls', `public class TrigHandler {
  public void handle() {
    System.debug('handling');
  }
}`),
    fact('MyObjTrigger.trigger', `trigger MyObjTrigger on Acme_Obj__c (before insert, before update) {
  TrigHandler handler = new TrigHandler();
  handler.handle();
}`),
  ];
  const index = resolver.buildSemanticIndex(files);
  const tree = resolver.buildCalleeTree(index, { classLower: 'myobjtrigger', methodLower: null }, {});
  check('4a. trigger-as-target root kind is trigger', tree.root.kind === 'trigger', tree.root.kind);
  const ctorChild = (tree.root.children || []).find((c) => c.methodLower === '<init>');
  const handleChild = (tree.root.children || []).find((c) => c.methodLower === 'handle');
  check('4b. trigger forward children include handler <init>', !!ctorChild, JSON.stringify(tree.root.children.map((c) => c.methodLower)));
  check('4c. trigger forward children include handler.handle()', !!handleChild, JSON.stringify(tree.root.children.map((c) => c.methodLower)));
  check('4d. trigger node itself is NOT terminal/truncated (per A2 spec, unlike flow nodes)', tree.root.truncated !== true, tree.root.truncated);
})();

// Also verify targeting via classLower with explicit methodLower='(trigger)'
// (mirrors how buildCallerTree normalizes trigger targets) behaves the same.
(function testTriggerAsForwardTargetExplicitMethod() {
  const files = [
    fact('TrigHandler2.cls', `public class TrigHandler2 {
  public void handle() { System.debug('x'); }
}`),
    fact('AnotherTrigger.trigger', `trigger AnotherTrigger on Acme_Obj2__c (before insert) {
  TrigHandler2 h = new TrigHandler2();
  h.handle();
}`),
  ];
  const index = resolver.buildSemanticIndex(files);
  const tree = resolver.buildCalleeTree(index, { classLower: 'anothertrigger', methodLower: '(trigger)' }, {});
  check('4e. explicit (trigger) methodLower target still yields handler chain', (tree.root.children || []).some((c) => c.methodLower === 'handle'), JSON.stringify(tree.root.children.map((c) => c.methodLower)));
})();

// =========================================================================
// 5. Exception node must be terminal forward
// =========================================================================
(function testExceptionTerminal() {
  const files = [
    fact('MyValidationException.cls', `public class MyValidationException extends Exception {
  public void extraHelper() {
    System.debug('should never be reached forward from a throw site');
  }
}`),
    fact('Validator.cls', `public class Validator {
  public void validate(Id recId) {
    if (recId == null) {
      throw new MyValidationException('bad id');
    }
    doWork();
  }
  public void doWork() {
    System.debug('working');
  }
}`),
  ];
  const index = resolver.buildSemanticIndex(files);
  const tree = resolver.buildCalleeTree(index, { classLower: 'validator', methodLower: 'validate' }, {});
  const excNode = (tree.root.children || []).find((c) => c.kind === 'exception');
  check('5a. throw site produces an exception-kind node', !!excNode, JSON.stringify(tree.root.children.map((c) => ({ kind: c.kind, label: c.label }))));
  if (excNode) {
    check('5b. exception node via=throws', excNode.via === 'throws', excNode.via);
    check('5c. exception node is terminal (truncated=true)', excNode.truncated === true, excNode.truncated);
    check('5d. exception node has NO children (does not expand extraHelper)', (excNode.children || []).length === 0, JSON.stringify(excNode.children));
  }
  const doWorkChild = (tree.root.children || []).find((c) => c.methodLower === 'dowork');
  check('5e. ordinary sibling call (doWork) still present, ordered after throw', !!doWorkChild);
})();

// =========================================================================
// 6. Unresolved-leaf count accuracy (hand-count 2 methods)
// =========================================================================
(function testUnresolvedLeafCount() {
  // Method A: exactly 3 genuinely-unresolved dot/bare call sites (platform
  // receivers absent from the index) plus 1 resolved call -- expect leaf
  // count == 3, not 4 (the resolved one must not be counted) and not
  // conflated with the DML/new/prop exclusions.
  const files = [
    fact('LeafHelper.cls', `public class LeafHelper {
  public void resolved() { System.debug('ok'); }
}`),
    fact('LeafCounter.cls', `public class LeafCounter {
  public void methodA(HttpRequest req, Http http) {
    req.setEndpoint('callout:X');
    req.setMethod('GET');
    http.send(req);
    LeafHelper h = new LeafHelper();
    h.resolved();
  }
  public void methodB() {
    unknownGlobalHelper();
    AnotherUnknownType.staticThing();
  }
}`),
  ];
  const index = resolver.buildSemanticIndex(files);

  const treeA = resolver.buildCalleeTree(index, { classLower: 'leafcounter', methodLower: 'methoda' }, {});
  const unresolvedA = (treeA.root.children || []).filter((c) => c.kind === 'unresolved');
  check('6a. methodA: exactly ONE aggregated unresolved leaf (not one per site)', unresolvedA.length === 1, `got ${unresolvedA.length} leaves: ${JSON.stringify(unresolvedA.map((n) => n.label))}`);
  if (unresolvedA.length === 1) {
    // hand count: setEndpoint, setMethod, send = 3 unresolved dot calls.
    // System.debug is not present in methodA. resolved() call is resolved
    // and must NOT be folded in.
    check('6b. methodA: hand-counted 3 unresolved sites', unresolvedA[0].label === '3 unresolved sites', unresolvedA[0].label);
  }
  const resolvedChild = (treeA.root.children || []).find((c) => c.methodLower === 'resolved');
  check('6c. methodA: the one resolved call site still appears as its own child', !!resolvedChild);

  const treeB = resolver.buildCalleeTree(index, { classLower: 'leafcounter', methodLower: 'methodb' }, {});
  const unresolvedB = (treeB.root.children || []).filter((c) => c.kind === 'unresolved');
  check('6d. methodB: exactly ONE aggregated unresolved leaf', unresolvedB.length === 1, `got ${unresolvedB.length}`);
  if (unresolvedB.length === 1) {
    // hand count: unknownGlobalHelper() bare call + AnotherUnknownType.staticThing() dot call = 2
    check('6e. methodB: hand-counted 2 unresolved sites', unresolvedB[0].label === '2 unresolved sites', unresolvedB[0].label);
  }
})();

// =========================================================================
// 9. Direction toggle semantics: trace X callers, then toggle = X callees,
//    same target -- children sets must be the genuinely-opposite relation,
//    not a re-run of the same direction, and no state bleed between calls
//    (shared index / shared DAG memoization must not cross-contaminate).
// =========================================================================
(function testDirectionToggle() {
  const files = [
    fact('ToggleA.cls', `public class ToggleA {
  public void outer() {
    ToggleB.middle();
  }
}`),
    fact('ToggleB.cls', `public class ToggleB {
  public static void middle() {
    ToggleC c = new ToggleC();
    c.innerLeaf();
  }
}`),
    fact('ToggleC.cls', `public class ToggleC {
  public void innerLeaf() {
    System.debug('leaf');
  }
}`),
  ];
  const index = resolver.buildSemanticIndex(files);
  const target = { classLower: 'toggleb', methodLower: 'middle' };

  const callerTree = resolver.buildCallerTree(index, target, {});
  const calleeTree = resolver.buildCalleeTree(index, target, {});

  check('9a. same target: callerTree.direction=callers', callerTree.direction === 'callers', callerTree.direction);
  check('9b. same target: calleeTree.direction=callees', calleeTree.direction === 'callees', calleeTree.direction);
  check('9c. same target: root label identical across directions', callerTree.root.label === calleeTree.root.label, `${callerTree.root.label} vs ${calleeTree.root.label}`);
  check('9d. same target: root path identical across directions', callerTree.root.path === calleeTree.root.path);

  const callerChildLabels = (callerTree.root.children || []).map((c) => c.label).sort();
  const calleeChildLabels = (calleeTree.root.children || []).map((c) => c.label).sort();
  check('9e. callers children = [ToggleA.outer] (who calls middle)', callerChildLabels.some((l) => /ToggleA/i.test(l)), JSON.stringify(callerChildLabels));
  check('9f. callees children = [ToggleC ctor/innerLeaf] (what middle calls)', calleeChildLabels.some((l) => /ToggleC/i.test(l)), JSON.stringify(calleeChildLabels));
  // The two directions must NOT share the same child set (this is the
  // sharpest possible regression: a toggle that silently re-runs the same
  // direction twice would show IDENTICAL children here).
  const overlap = callerChildLabels.filter((l) => calleeChildLabels.includes(l));
  check('9g. callers/callees child sets are NOT identical (toggle genuinely flips relation)', JSON.stringify(callerChildLabels) !== JSON.stringify(calleeChildLabels), `callers=${JSON.stringify(callerChildLabels)} callees=${JSON.stringify(calleeChildLabels)}`);

  // Re-run the SAME direction twice to confirm no memoization/statefulness
  // bleeds between independent buildCalleeTree/buildCallerTree calls on the
  // same shared index (the DAG memo/ctx must be per-call, not shared/global).
  const calleeTree2 = resolver.buildCalleeTree(index, target, {});
  check('9h. repeated buildCalleeTree call on same index/target is idempotent', JSON.stringify(calleeTree.root.children.map(c=>c.label)) === JSON.stringify(calleeTree2.root.children.map(c=>c.label)));

  // Toggle back: callees of middle, then callers of middle again -- must
  // match the FIRST callerTree run exactly (no leftover state from the
  // intervening callee run corrupting a subsequent caller run).
  const callerTree2 = resolver.buildCallerTree(index, target, {});
  check('9i. toggling back to callers after a callees run reproduces original callers result', JSON.stringify(callerTree.root.children.map(c=>c.label)) === JSON.stringify(callerTree2.root.children.map(c=>c.label)), `${JSON.stringify(callerTree.root.children.map(c=>c.label))} vs ${JSON.stringify(callerTree2.root.children.map(c=>c.label))}`);
})();

console.log('\n=== Summary ===');
console.log(`failures: ${failures.length}`);
if (failures.length) {
  console.log(failures.map((f) => ' - ' + f).join('\n'));
}
process.exitCode = failures.length ? 1 : 0;

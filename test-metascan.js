'use strict';
// Self-check for metascan.js (amendment A5): node test-metascan.js
//
// Four parts:
//   1. Inline-string fixtures for every source kind (lwc/aura/flow/
//      omniscript/vf) plus edge cases (multi-line imports, namespace-dotted
//      specifiers, __tests__ exclusion, non-apex Flow actions, the
//      escaped-string JSON decoy, malformed input never throwing) -- plus,
//      as its final subsections: v0.8's N1(c) metascan half (Flow/CMDT/
//      os-meta namespace-field extraction) and N3's stripOwnNamespace() hook,
//      and v0.10 (Round A, A2)'s Visualforce ACTION-binding extraction
//      (action="{!method}" on apex:page/commandButton/commandLink/
//      actionFunction/actionSupport/actionPoller, single-identifier
//      expressions only -- dotted/compound expressions and value= bindings
//      deliberately skipped).
//   2. A real pass over the read-only example-data/
//      adv-org corpus, asserting the EXACT refs MANIFEST.md's "UI / metadata
//      callers" ground-truth section promises -- this is the bar the task
//      brief sets ("assert the exact refs the MANIFEST promises").
//   3. v0.7.1 (M1) gauntlet-round regression: a real pass over the read-only
//      test-fixtures/gauntlet-org corpus pinning
//      VALIDATION-REPORT.md Tier-1 #1 -- `LWC_IMPORT_RE` must retain the
//      namespace segment of `@salesforce/apex/ns.Class.method` specifiers
//      instead of silently discarding it (the M2 fix that USES this field to
//      gate attachMetaCallers() against a false attach onto a same-bare-name
//      local class lives in resolver.js, out of scope for this file) -- plus,
//      as its final subsections: v0.8-A5/B5 real-corpus regression (the
//      actual Vtx_Namespace_Probe_Flow.flow-meta.xml and
//      Kappa_Trigger_Config.Namespace_Handler.md-meta.xml gauntlet-org
//      fixtures, cross-checked against the LWC probe for the
//      three-surface (Apex+LWC+Flow / Flow+CMDT) namespace+className
//      consistency GROUND-TRUTH.md's v0.8 section documents), and v0.10-B
//      real-corpus regression (the 4 real .page/.component gauntlet-org
//      fixtures, asserting the EXACT refs GROUND-TRUTH.md's v0.10-B section
//      promises for every action= binding, including the extension-only,
//      declared-on-both, matches-no-class, and dotted-skip shapes).
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { parseMetaFile, scanBundle, stripOwnNamespace } = require('./metascan');

const src = (lines) => lines.join('\n');

function refsOf(kind, refs) {
  return refs.filter((r) => r.kind === kind);
}

// ===========================================================================
// LWC — @salesforce/apex imports
// ===========================================================================

// 1. Single-line import (wire adapter shape)
{
  const text = src([
    "import { LightningElement, wire } from 'lwc';",
    "import getRecentQuotes from '@salesforce/apex/AcmeQuoteAuraService.getRecentQuotes';",
    '',
    'export default class AcmeOrderDashboard extends LightningElement {',
    '  @wire(getRecentQuotes) recentQuotes;',
    '}',
  ]);
  const refs = parseMetaFile({ path: 'lwc/acmeOrderDashboard/acmeOrderDashboard.js', text });
  assert.strictEqual(refs.length, 1);
  assert.strictEqual(refs[0].kind, 'lwc');
  assert.strictEqual(refs[0].label, 'acmeOrderDashboard');
  assert.strictEqual(refs[0].className, 'AcmeQuoteAuraService');
  assert.strictEqual(refs[0].methodName, 'getRecentQuotes');
  assert.strictEqual(refs[0].line, 2);
  assert.strictEqual(
    refs[0].lineText,
    "import getRecentQuotes from '@salesforce/apex/AcmeQuoteAuraService.getRecentQuotes';"
  );
  assert.strictEqual(refs[0].namespace, null, 'bare 2-segment specifier (Class.method) -- no namespace prefix');
}

// 2. Multi-line import (identifier and `from` on separate lines)
{
  const text = src([
    "import { LightningElement, track } from 'lwc';",
    'import',
    '    createQuote',
    "    from '@salesforce/apex/AcmeQuoteAuraService.createQuote';",
    '',
    'export default class AcmeQuoteWizard extends LightningElement {}',
  ]);
  const refs = parseMetaFile({ path: 'lwc/acmeQuoteWizard/acmeQuoteWizard.js', text });
  assert.strictEqual(refs.length, 1, 'multi-line import must still be found');
  assert.strictEqual(refs[0].className, 'AcmeQuoteAuraService');
  assert.strictEqual(refs[0].methodName, 'createQuote');
  assert.strictEqual(refs[0].line, 4, 'line should point at the `from \'...\'` line, not the `import` line');
  assert.strictEqual(refs[0].namespace, null);
}

// 3. Two imports in one file (wire + imperative), both attributed correctly
{
  const text = src([
    "import { LightningElement, api, wire } from 'lwc';",
    "import { refreshApex } from '@salesforce/apex';",
    "import getInvoiceSummary from '@salesforce/apex/AcmeQuoteAuraService.getInvoiceSummary';",
    "import recalculateInvoice from '@salesforce/apex/AcmeQuoteAuraService.recalculateInvoice';",
    '',
    'export default class AcmeInvoiceViewer extends LightningElement {}',
  ]);
  const refs = parseMetaFile({ path: 'lwc/acmeInvoiceViewer/acmeInvoiceViewer.js', text });
  assert.strictEqual(refs.length, 2, "'@salesforce/apex' (no /Cls.method path) must NOT produce a ref");
  assert.deepStrictEqual(
    refs.map((r) => r.methodName).sort(),
    ['getInvoiceSummary', 'recalculateInvoice'].sort()
  );
  for (const r of refs) {
    assert.strictEqual(r.className, 'AcmeQuoteAuraService');
    assert.strictEqual(r.namespace, null);
  }
}

// 4. Namespace-dotted specifier (3 segments): className/methodName are still
//    the last two segments (unchanged since v0.3), but (v0.7.1, M1) the
//    leading segment is now RETAINED on `namespace` instead of discarded.
{
  const text = "import doThing from '@salesforce/apex/acme_pkg.AcmeNamespacedService.doThing';";
  const refs = parseMetaFile({ path: 'lwc/acmeNsWidget/acmeNsWidget.js', text });
  assert.strictEqual(refs.length, 1);
  assert.strictEqual(refs[0].className, 'AcmeNamespacedService');
  assert.strictEqual(refs[0].methodName, 'doThing');
  assert.strictEqual(refs[0].namespace, 'acme_pkg', 'M1: namespace segment must be captured, not discarded');
}

// 4a. Two-segment (bare, no namespace) vs three-segment (namespaced) import
//     of THE SAME bare Class.method, side by side -- pins the exact signal
//     M2's attachMetaCallers() gate (resolver.js, out of scope here) needs
//     to tell "this is a genuine local reference" apart from "this merely
//     SHARES a bare tail with a local class but is not one" (M2 spec: "a
//     meta ref only attaches when it unambiguously matches exactly one local
//     class under the ref's own namespace context"). This is the gauntlet
//     Tier-1 #1 false-edge shape in miniature (see VALIDATION-REPORT.md):
//     both refs resolve to identical className/methodName, so any consumer
//     keying ONLY on `lc(className)` (the pre-fix behavior) cannot tell them
//     apart -- `namespace` is the only field that can.
{
  const bareText = "import dispatch from '@salesforce/apex/KappaGateway.dispatch';";
  const nsText = "import dispatch from '@salesforce/apex/zenq.KappaGateway.dispatch';";
  const bareRefs = parseMetaFile({ path: 'lwc/kappaGatewayLocalPanel/kappaGatewayLocalPanel.js', text: bareText });
  const nsRefs = parseMetaFile({ path: 'lwc/kappaGatewayPanel/kappaGatewayPanel.js', text: nsText });
  assert.strictEqual(bareRefs.length, 1);
  assert.strictEqual(nsRefs.length, 1);
  // Same bare className/methodName in both -- the collision the bug exploited.
  assert.strictEqual(bareRefs[0].className, nsRefs[0].className);
  assert.strictEqual(bareRefs[0].methodName, nsRefs[0].methodName);
  // But the namespace field distinguishes them: null means "no namespace
  // prefix in source -- safe to consider for local attach"; a non-null
  // namespace means "this ref names a method in a DIFFERENT namespace than
  // the local no-namespace workspace, and must never be re-pointed at a
  // local same-bare-name class purely on tail-segment equality" (M2).
  assert.strictEqual(bareRefs[0].namespace, null, 'no-prefix specifier -- eligible for local attach');
  assert.strictEqual(nsRefs[0].namespace, 'zenq', 'namespace-prefixed specifier -- must NOT local-attach (M2)');
  assert.notStrictEqual(
    bareRefs[0].namespace,
    nsRefs[0].namespace,
    'bare and namespaced refs to the same bare Class.method must be distinguishable'
  );
}

// 4b. Different namespace tokens (second namespace, case-insensitive variant)
//     -- namespace is preserved VERBATIM (not case-normalized; that is a
//     resolver-level concern, matching how className/methodName are also
//     preserved verbatim today).
{
  const kwxRefs = parseMetaFile({
    path: 'lwc/boltRelayPanel/boltRelayPanel.js',
    text: "import fire from '@salesforce/apex/kwx.BoltRelay.fire';",
  });
  assert.strictEqual(kwxRefs.length, 1);
  assert.strictEqual(kwxRefs[0].className, 'BoltRelay');
  assert.strictEqual(kwxRefs[0].methodName, 'fire');
  assert.strictEqual(kwxRefs[0].namespace, 'kwx');

  const caseRefs = parseMetaFile({
    path: 'lwc/kappaGatewayCasePanel/kappaGatewayCasePanel.js',
    text: "import dispatch from '@salesforce/apex/ZENQ.kappagateway.DISPATCH';",
  });
  assert.strictEqual(caseRefs.length, 1);
  assert.strictEqual(caseRefs[0].className, 'kappagateway', 'className preserved verbatim, no case-folding');
  assert.strictEqual(caseRefs[0].methodName, 'DISPATCH');
  assert.strictEqual(caseRefs[0].namespace, 'ZENQ', 'namespace preserved verbatim, no case-folding');
}

// 4c. 4-segment specifier (namespace + inner-class-shaped tail): every
//     leading segment before the trailing Class.method pair folds into one
//     dot-joined namespace string -- tolerant, deterministic, never throws.
{
  const refs = parseMetaFile({
    path: 'lwc/boltContainerPanel/boltContainerPanel.js',
    text: "import fire from '@salesforce/apex/zenq.BoltContainer.Relay.fire';",
  });
  assert.strictEqual(refs.length, 1);
  assert.strictEqual(refs[0].className, 'Relay');
  assert.strictEqual(refs[0].methodName, 'fire');
  assert.strictEqual(refs[0].namespace, 'zenq.BoltContainer');
}

// 4d. Multiple namespaced imports in one file, each with its own distinct
//     namespace segment -- no cross-contamination between refs.
{
  const text = src([
    "import dispatchZenq from '@salesforce/apex/zenq.KappaGateway.dispatch';",
    "import fireKwx from '@salesforce/apex/kwx.BoltRelay.fire';",
    "import bareLocal from '@salesforce/apex/KappaGateway.dispatch';",
  ]);
  const refs = parseMetaFile({ path: 'lwc/mixedNsPanel/mixedNsPanel.js', text });
  assert.strictEqual(refs.length, 3);
  const zenqRef = refs.find((r) => r.methodName === 'dispatch' && r.namespace === 'zenq');
  const kwxRef = refs.find((r) => r.methodName === 'fire' && r.namespace === 'kwx');
  const bareRef = refs.find((r) => r.methodName === 'dispatch' && r.namespace === null);
  assert.ok(zenqRef, 'zenq.KappaGateway.dispatch ref must be found with namespace=zenq');
  assert.ok(kwxRef, 'kwx.BoltRelay.fire ref must be found with namespace=kwx');
  assert.ok(bareRef, 'bare KappaGateway.dispatch ref must be found with namespace=null');
  assert.strictEqual(zenqRef.className, 'KappaGateway');
  assert.strictEqual(kwxRef.className, 'BoltRelay');
  assert.strictEqual(bareRef.className, 'KappaGateway');
}

// 5. __tests__ exclusion: a Jest spec importing the SAME specifier (to
//    jest.mock() it) yields NO refs, even though the string is present.
{
  const text = src([
    "import { createElement } from 'lwc';",
    "import AcmeQuoteWizard from 'c/acmeQuoteWizard';",
    "import createQuote from '@salesforce/apex/AcmeQuoteAuraService.createQuote';",
    '',
    "jest.mock('@salesforce/apex/AcmeQuoteAuraService.createQuote', () => ({ default: jest.fn() }), { virtual: true });",
  ]);
  const refs = parseMetaFile({
    path: 'lwc/acmeQuoteWizard/__tests__/acmeQuoteWizard.test.js',
    text,
  });
  assert.deepStrictEqual(refs, [], '__tests__ path must yield zero refs regardless of content');
}

// 5a. __tests__ exclusion also applies to a NAMESPACED specifier -- the
//     namespace field is orthogonal to the __tests__ path exclusion.
{
  const text = "import dispatch from '@salesforce/apex/zenq.KappaGateway.dispatch';";
  const refs = parseMetaFile({
    path: 'lwc/kappaGatewayPanel/__tests__/kappaGatewayPanel.test.js',
    text,
  });
  assert.deepStrictEqual(refs, [], '__tests__ path must yield zero refs even for a namespaced specifier');
}

// ===========================================================================
// Aura — class-level controller= attribute (single-file) + bundle pairing
// ===========================================================================

// 6. parseMetaFile on a lone .cmp: class-level ref only, no bundle context
{
  const text = src([
    '<aura:component controller="AcmeOrderApprovalController"',
    '                 implements="flexipage:availableForRecordHome,force:hasRecordId"',
    '                 access="global">',
    '    <aura:attribute name="recordId" type="Id" />',
    '</aura:component>',
  ]);
  const refs = parseMetaFile({
    path: 'aura/AcmeOrderApprovalPanel/AcmeOrderApprovalPanel.cmp',
    text,
  });
  assert.strictEqual(refs.length, 1);
  assert.strictEqual(refs[0].kind, 'aura');
  assert.strictEqual(refs[0].label, 'AcmeOrderApprovalPanel');
  assert.strictEqual(refs[0].className, 'AcmeOrderApprovalController');
  assert.strictEqual(refs[0].methodName, null);
  assert.strictEqual(refs[0].line, 1);
}

// 7. parseMetaFile on a lone controller/helper .js: NO refs (no bundle context)
{
  const text = src([
    '({',
    "    handleApprove: function (component, event, helper) {",
    "        var action = component.get('c.approveOrder');",
    '    }',
    '})',
  ]);
  const refs = parseMetaFile({
    path: 'aura/AcmeOrderApprovalPanel/AcmeOrderApprovalPanelController.js',
    text,
  });
  assert.deepStrictEqual(
    refs,
    [],
    'a controller/helper .js alone (no sibling .cmp) has no class to attribute component.get() to via parseMetaFile'
  );
}

// 8. scanBundle: markup + controller.js together yield BOTH class-level and
//    method-level refs, correctly paired.
{
  const cmpText = src([
    '<aura:component controller="AcmeShipmentAuraService"',
    '                 implements="flexipage:availableForAllPageTypes"',
    '                 access="global">',
    '    <aura:handler name="init" value="{!this}" action="{!c.doInit}" />',
    '</aura:component>',
  ]);
  const jsText = src([
    '({',
    '    doInit: function (component, event, helper) {',
    "        var action = component.get('c.getShipmentStatuses');",
    '    }',
    '})',
  ]);
  const refs = scanBundle([
    { path: 'aura/AcmeShipmentStatusBoard/AcmeShipmentStatusBoard.cmp', text: cmpText },
    { path: 'aura/AcmeShipmentStatusBoard/AcmeShipmentStatusBoardController.js', text: jsText },
  ]);
  assert.strictEqual(refs.length, 2);
  const classRef = refs.find((r) => r.methodName === null);
  const methodRef = refs.find((r) => r.methodName !== null);
  assert.ok(classRef, 'class-level ref present');
  assert.strictEqual(classRef.className, 'AcmeShipmentAuraService');
  assert.strictEqual(classRef.label, 'AcmeShipmentStatusBoard');
  assert.ok(methodRef, 'method-level ref present');
  assert.strictEqual(methodRef.className, 'AcmeShipmentAuraService');
  assert.strictEqual(methodRef.methodName, 'getShipmentStatuses');
  assert.strictEqual(methodRef.label, 'AcmeShipmentStatusBoard');
}

// 9. scanBundle: a .js file with NO sibling .cmp/.app in its directory
//    produces nothing (no controller class to attribute it to).
{
  const jsText = "component.get('c.orphanMethod');";
  const refs = scanBundle([
    { path: 'aura/AcmeOrphanBundle/AcmeOrphanBundleHelper.js', text: jsText },
  ]);
  assert.deepStrictEqual(refs, []);
}

// 10. scanBundle: multiple component.get() calls across BOTH a controller.js
//     and a helper.js in the same bundle all pair to the one controller class.
{
  const cmpText = '<aura:component controller="AcmeMultiActionController" access="global"></aura:component>';
  const controllerJs = "({ a: function(cmp){ cmp.get('c.actionOne'); } })";
  const helperJs = "({ b: function(cmp){ var x = component.get('c.actionTwo'); } })";
  const refs = scanBundle([
    { path: 'aura/AcmeMultiActionBundle/AcmeMultiActionBundle.cmp', text: cmpText },
    { path: 'aura/AcmeMultiActionBundle/AcmeMultiActionBundleController.js', text: controllerJs },
    { path: 'aura/AcmeMultiActionBundle/AcmeMultiActionBundleHelper.js', text: helperJs },
  ]);
  // controllerJs uses `cmp.get(...)` (not `component.get(...)`) so it must NOT match --
  // only helperJs's `component.get('c.actionTwo')` plus the class-level ref.
  assert.strictEqual(refs.length, 2);
  assert.ok(refs.some((r) => r.methodName === null && r.className === 'AcmeMultiActionController'));
  assert.ok(refs.some((r) => r.methodName === 'actionTwo' && r.className === 'AcmeMultiActionController'));
}

// 11. scanBundle ignores non-Aura files mixed into the same array (e.g. an
//     LWC .js dropped in by a caller that batches everything together).
{
  const refs = scanBundle([
    {
      path: 'lwc/acmeOrderDashboard/acmeOrderDashboard.js',
      text: "import x from '@salesforce/apex/SomeClass.someMethod';",
    },
  ]);
  assert.deepStrictEqual(refs, []);
}

// 12. Aura self-closing root tag + <aura:application> variant both work
{
  const refsComponent = parseMetaFile({
    path: 'aura/AcmeSelfClosing/AcmeSelfClosing.cmp',
    text: '<aura:component controller="AcmeSelfClosingController"/>',
  });
  assert.strictEqual(refsComponent.length, 1);
  assert.strictEqual(refsComponent[0].className, 'AcmeSelfClosingController');

  const refsApp = parseMetaFile({
    path: 'aura/AcmeAppShell/AcmeAppShell.app',
    text: '<aura:application controller="AcmeAppShellController"></aura:application>',
  });
  assert.strictEqual(refsApp.length, 1);
  assert.strictEqual(refsApp[0].className, 'AcmeAppShellController');
}

// 13. A .cmp with NO controller attribute yields no class-level ref, and its
//     bundle's .js therefore yields no method-level refs either.
{
  const cmpText = '<aura:component implements="flexipage:availableForAllPageTypes"></aura:component>';
  const jsText = "component.get('c.someMethod');";
  const refsAlone = parseMetaFile({ path: 'aura/AcmeNoController/AcmeNoController.cmp', text: cmpText });
  assert.deepStrictEqual(refsAlone, []);
  const refsBundle = scanBundle([
    { path: 'aura/AcmeNoController/AcmeNoController.cmp', text: cmpText },
    { path: 'aura/AcmeNoController/AcmeNoControllerController.js', text: jsText },
  ]);
  assert.deepStrictEqual(refsBundle, []);
}

// ===========================================================================
// Flow — actionCalls with actionType 'apex'
// ===========================================================================

// 14. Dotted actionName (Class.method) and bare actionName (class only)
{
  const dottedText = src([
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<Flow xmlns="http://soap.sforce.com/2006/04/metadata">',
    '    <actionCalls>',
    '        <name>Recalc</name>',
    '        <actionName>AcmeOrderService.recalculatePricing</actionName>',
    '        <actionType>apex</actionType>',
    '        <nameSegment>AcmeOrderService.recalculatePricing</nameSegment>',
    '    </actionCalls>',
    '</Flow>',
  ]);
  const dottedRefs = parseMetaFile({
    path: 'flows/AcmeOrderStatusRecordTriggeredFlow.flow-meta.xml',
    text: dottedText,
  });
  assert.strictEqual(dottedRefs.length, 1);
  assert.strictEqual(dottedRefs[0].kind, 'flow');
  assert.strictEqual(dottedRefs[0].label, 'AcmeOrderStatusRecordTriggeredFlow');
  assert.strictEqual(dottedRefs[0].className, 'AcmeOrderService');
  assert.strictEqual(dottedRefs[0].methodName, 'recalculatePricing');

  const bareText = src([
    '<Flow xmlns="http://soap.sforce.com/2006/04/metadata">',
    '    <actionCalls>',
    '        <name>Resolve_Backorders</name>',
    '        <actionName>AcmeOrderInvocable</actionName>',
    '        <actionType>apex</actionType>',
    '        <nameSegment>AcmeOrderInvocable</nameSegment>',
    '    </actionCalls>',
    '</Flow>',
  ]);
  const bareRefs = parseMetaFile({ path: 'flows/AcmeBackorderResolutionFlow.flow-meta.xml', text: bareText });
  assert.strictEqual(bareRefs.length, 1);
  assert.strictEqual(bareRefs[0].className, 'AcmeOrderInvocable');
  assert.strictEqual(bareRefs[0].methodName, null, 'a bare actionName is class-only -- Flow XML never names the method');
}

// 15. Non-apex actionType (emailSimple) excluded; only the apex block counts.
//     Also: a <subflows> block is not an <actionCalls> block at all and must
//     never produce a ref (flow-to-flow, not Apex -- out of this amendment's
//     scope per the task brief).
{
  const text = src([
    '<Flow xmlns="http://soap.sforce.com/2006/04/metadata">',
    '    <actionCalls>',
    '        <name>Resolve_Backorders</name>',
    '        <actionName>AcmeOrderInvocable</actionName>',
    '        <actionType>apex</actionType>',
    '    </actionCalls>',
    '    <subflows>',
    '        <name>Notify_Customer</name>',
    '        <flowName>AcmeNotifyCustomerSubflow</flowName>',
    '    </subflows>',
    '</Flow>',
  ]);
  const refs = parseMetaFile({ path: 'flows/AcmeBackorderResolutionFlow.flow-meta.xml', text });
  assert.strictEqual(refs.length, 1, 'only the apex actionCalls block should surface, subflow ignored');
  assert.strictEqual(refs[0].className, 'AcmeOrderInvocable');

  const emailOnlyText = src([
    '<Flow xmlns="http://soap.sforce.com/2006/04/metadata">',
    '    <actionCalls>',
    '        <name>Send_Customer_Notification</name>',
    '        <actionName>emailSimple</actionName>',
    '        <actionType>emailSimple</actionType>',
    '    </actionCalls>',
    '</Flow>',
  ]);
  const emailOnlyRefs = parseMetaFile({ path: 'flows/AcmeNotifyCustomerSubflow.flow-meta.xml', text: emailOnlyText });
  assert.deepStrictEqual(emailOnlyRefs, [], 'non-apex actionType must yield zero refs');
}

// 16. Multiple actionCalls blocks in one Flow: mixed apex + non-apex, each
//     independently classified.
{
  const text = src([
    '<Flow xmlns="http://soap.sforce.com/2006/04/metadata">',
    '    <actionCalls>',
    '        <name>Invoke_Discount_Approval</name>',
    '        <actionName>AcmeDiscountApprovalInvocable</actionName>',
    '        <actionType>apex</actionType>',
    '    </actionCalls>',
    '    <actionCalls>',
    '        <name>Send_Email</name>',
    '        <actionName>emailSimple</actionName>',
    '        <actionType>emailSimple</actionType>',
    '    </actionCalls>',
    '    <actionCalls>',
    '        <name>Recalc</name>',
    '        <actionName>AcmeOrderService.recalculatePricing</actionName>',
    '        <actionType>apex</actionType>',
    '    </actionCalls>',
    '</Flow>',
  ]);
  const refs = parseMetaFile({ path: 'flows/AcmeMultiActionFlow.flow-meta.xml', text });
  assert.strictEqual(refs.length, 2);
  assert.deepStrictEqual(
    refs.map((r) => r.className).sort(),
    ['AcmeDiscountApprovalInvocable', 'AcmeOrderService'].sort()
  );
}

// ===========================================================================
// F1(b) — record-triggered flow <start> extraction (flowObject /
// flowRecordTriggerType stamped onto every ref from the same file)
// ===========================================================================

// 16a. Record-triggered flow (RecordAfterSave/Update): both fields populated
// on the sole actionCalls ref.
{
  const text = src([
    '<Flow xmlns="http://soap.sforce.com/2006/04/metadata">',
    '    <start>',
    '        <connector><targetReference>Recalc</targetReference></connector>',
    '        <object>Acme_Order__c</object>',
    '        <recordTriggerType>Update</recordTriggerType>',
    '        <triggerType>RecordAfterSave</triggerType>',
    '    </start>',
    '    <actionCalls>',
    '        <name>Recalc</name>',
    '        <actionName>AcmeOrderService.recalculatePricing</actionName>',
    '        <actionType>apex</actionType>',
    '    </actionCalls>',
    '</Flow>',
  ]);
  const refs = parseMetaFile({ path: 'flows/AcmeOrderStatusRecordTriggeredFlow.flow-meta.xml', text });
  assert.strictEqual(refs.length, 1);
  assert.strictEqual(refs[0].flowObject, 'Acme_Order__c');
  assert.strictEqual(refs[0].flowRecordTriggerType, 'Update');
}

// 16b. Record-triggered flow (RecordAfterSave/Create) — the new-in-v0.4
// AcmeOrderCreatedWelcomeFlow shape.
{
  const text = src([
    '<Flow xmlns="http://soap.sforce.com/2006/04/metadata">',
    '    <start>',
    '        <connector><targetReference>Notify</targetReference></connector>',
    '        <object>Acme_Order__c</object>',
    '        <recordTriggerType>Create</recordTriggerType>',
    '        <triggerType>RecordAfterSave</triggerType>',
    '    </start>',
    '    <actionCalls>',
    '        <name>Notify</name>',
    '        <actionName>AcmeOrderInvocable</actionName>',
    '        <actionType>apex</actionType>',
    '    </actionCalls>',
    '</Flow>',
  ]);
  const refs = parseMetaFile({ path: 'flows/AcmeOrderCreatedWelcomeFlow.flow-meta.xml', text });
  assert.strictEqual(refs.length, 1);
  assert.strictEqual(refs[0].flowObject, 'Acme_Order__c');
  assert.strictEqual(refs[0].flowRecordTriggerType, 'Create');
}

// 16c. Non-record-triggered flow (Screen Flow: <start> present but no
// <object>/<triggerType> at all) -> both fields null.
{
  const text = src([
    '<Flow xmlns="http://soap.sforce.com/2006/04/metadata">',
    '    <start>',
    '        <connector><targetReference>Screen1</targetReference></connector>',
    '    </start>',
    '    <actionCalls>',
    '        <name>Invoke</name>',
    '        <actionName>AcmeDiscountApprovalInvocable</actionName>',
    '        <actionType>apex</actionType>',
    '    </actionCalls>',
    '</Flow>',
  ]);
  const refs = parseMetaFile({ path: 'flows/AcmeQuoteApprovalScreenFlow.flow-meta.xml', text });
  assert.strictEqual(refs.length, 1);
  assert.strictEqual(refs[0].flowObject, null, 'screen flow has no record-trigger object');
  assert.strictEqual(refs[0].flowRecordTriggerType, null);
}

// 16d. Autolaunched flow with no <start> record-trigger fields at all
// (matches AcmeBackorderResolutionFlow's shape) -> both fields null; a Flow
// with no <start> block whatsoever also degrades to {null, null}, never throws.
{
  const withStartNoObject = src([
    '<Flow xmlns="http://soap.sforce.com/2006/04/metadata">',
    '    <start>',
    '        <connector><targetReference>Resolve</targetReference></connector>',
    '    </start>',
    '    <actionCalls>',
    '        <name>Resolve</name>',
    '        <actionName>AcmeOrderInvocable</actionName>',
    '        <actionType>apex</actionType>',
    '    </actionCalls>',
    '</Flow>',
  ]);
  const refs1 = parseMetaFile({ path: 'flows/AcmeBackorderResolutionFlow.flow-meta.xml', text: withStartNoObject });
  assert.strictEqual(refs1[0].flowObject, null);
  assert.strictEqual(refs1[0].flowRecordTriggerType, null);

  const noStartAtAll = src([
    '<Flow xmlns="http://soap.sforce.com/2006/04/metadata">',
    '    <actionCalls>',
    '        <name>Resolve</name>',
    '        <actionName>AcmeOrderInvocable</actionName>',
    '        <actionType>apex</actionType>',
    '    </actionCalls>',
    '</Flow>',
  ]);
  assert.doesNotThrow(() => parseMetaFile({ path: 'flows/AcmeNoStartFlow.flow-meta.xml', text: noStartAtAll }));
  const refs2 = parseMetaFile({ path: 'flows/AcmeNoStartFlow.flow-meta.xml', text: noStartAtAll });
  assert.strictEqual(refs2[0].flowObject, null);
  assert.strictEqual(refs2[0].flowRecordTriggerType, null);
}

// 16e. RecordBeforeDelete (the third record-triggered triggerType, exercised
// nowhere else in this file) with no <recordTriggerType> at all (a real
// before-delete <start> block never carries one) -> flowObject populated,
// flowRecordTriggerType null.
{
  const text = src([
    '<Flow xmlns="http://soap.sforce.com/2006/04/metadata">',
    '    <start>',
    '        <connector><targetReference>Block</targetReference></connector>',
    '        <object>Acme_Shipment__c</object>',
    '        <triggerType>RecordBeforeDelete</triggerType>',
    '    </start>',
    '    <actionCalls>',
    '        <name>Block</name>',
    '        <actionName>AcmeOrderInvocable</actionName>',
    '        <actionType>apex</actionType>',
    '    </actionCalls>',
    '</Flow>',
  ]);
  const refs = parseMetaFile({ path: 'flows/AcmeShipmentDeleteBlockFlow.flow-meta.xml', text });
  assert.strictEqual(refs[0].flowObject, 'Acme_Shipment__c');
  assert.strictEqual(refs[0].flowRecordTriggerType, null);
}

// ===========================================================================
// F4(b) — Custom Metadata identifier-shaped <value> extraction (kind 'cmdt')
// ===========================================================================

// 16f. Real class-name-shaped value -> one ref, kind 'cmdt', terminal shape.
{
  const text = src([
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<CustomMetadata xmlns="http://soap.sforce.com/2006/04/metadata" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" fields="Handler_Class__c">',
    '    <label>Order Sync Handler</label>',
    '    <protected>false</protected>',
    '    <values>',
    '        <field>Handler_Class__c</field>',
    '        <value xsi:type="xsd:string">AcmeOrderService</value>',
    '    </values>',
    '</CustomMetadata>',
  ]);
  const refs = parseMetaFile({
    path: 'customMetadata/Acme_Integration_Config.Order_Sync_Handler.md-meta.xml',
    text,
  });
  assert.strictEqual(refs.length, 1);
  assert.strictEqual(refs[0].kind, 'cmdt');
  assert.strictEqual(refs[0].label, 'Acme_Integration_Config.Order_Sync_Handler', 'md-meta.xml compound extension stripped correctly');
  assert.strictEqual(refs[0].className, 'AcmeOrderService');
  assert.strictEqual(refs[0].methodName, null);
  assert.strictEqual(refs[0].fieldName, 'Handler_Class__c');
  assert.strictEqual(refs[0].line, 7);
}

// 16g. Value naming no real class still extracts (metascan does not judge
// realness -- that's resolver.js's job); only the identifier SHAPE gates it.
{
  const text = src([
    '<CustomMetadata xmlns="http://soap.sforce.com/2006/04/metadata" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" fields="Handler_Class__c">',
    '    <values>',
    '        <field>Handler_Class__c</field>',
    '        <value xsi:type="xsd:string">AcmeLegacyHandlerRemoved</value>',
    '    </values>',
    '</CustomMetadata>',
  ]);
  const refs = parseMetaFile({
    path: 'customMetadata/Acme_Integration_Config.Legacy_Sync_Handler.md-meta.xml',
    text,
  });
  assert.strictEqual(refs.length, 1);
  assert.strictEqual(refs[0].className, 'AcmeLegacyHandlerRemoved');
}

// 16h. Non-identifier-shaped values (spaces, dots, pure numeric, empty) are
// skipped; only the identifier-shaped sibling <values> block yields a ref.
{
  const text = src([
    '<CustomMetadata xmlns="http://soap.sforce.com/2006/04/metadata">',
    '    <values>',
    '        <field>Description__c</field>',
    '        <value xsi:type="xsd:string">Not a class name, has spaces</value>',
    '    </values>',
    '    <values>',
    '        <field>Namespace_Dotted__c</field>',
    '        <value xsi:type="xsd:string">acme.NamespacedClass</value>',
    '    </values>',
    '    <values>',
    '        <field>Priority__c</field>',
    '        <value xsi:type="xsd:double">42</value>',
    '    </values>',
    '    <values>',
    '        <field>Handler_Class__c</field>',
    '        <value xsi:type="xsd:string">AcmeShipmentService</value>',
    '    </values>',
    '</CustomMetadata>',
  ]);
  const refs = parseMetaFile({
    path: 'customMetadata/Acme_Integration_Config.Shipment_Sync_Handler.md-meta.xml',
    text,
  });
  assert.strictEqual(refs.length, 1, 'only the one identifier-shaped value qualifies');
  assert.strictEqual(refs[0].className, 'AcmeShipmentService');
  assert.strictEqual(refs[0].fieldName, 'Handler_Class__c');
}

// 16i. Multiple identifier-shaped <values> blocks in one record each yield
// their own ref.
{
  const text = src([
    '<CustomMetadata xmlns="http://soap.sforce.com/2006/04/metadata">',
    '    <values>',
    '        <field>Primary_Handler__c</field>',
    '        <value xsi:type="xsd:string">AcmeOrderService</value>',
    '    </values>',
    '    <values>',
    '        <field>Fallback_Handler__c</field>',
    '        <value xsi:type="xsd:string">AcmeShipmentService</value>',
    '    </values>',
    '</CustomMetadata>',
  ]);
  const refs = parseMetaFile({ path: 'customMetadata/Acme_Integration_Config.Dual_Handler.md-meta.xml', text });
  assert.strictEqual(refs.length, 2);
  assert.deepStrictEqual(
    refs.map((r) => r.className).sort(),
    ['AcmeOrderService', 'AcmeShipmentService'].sort()
  );
}

// 16j. Malformed / empty CMDT never throws, yields no refs.
{
  assert.doesNotThrow(() => parseMetaFile({ path: 'customMetadata/Broken.md-meta.xml', text: '<CustomMetadata>' }));
  assert.deepStrictEqual(parseMetaFile({ path: 'customMetadata/Broken.md-meta.xml', text: '<CustomMetadata>' }), []);
  assert.deepStrictEqual(
    parseMetaFile({ path: 'customMetadata/NoValues.md-meta.xml', text: '<CustomMetadata></CustomMetadata>' }),
    []
  );
}

// ===========================================================================
// v0.5 G1(b) — platform-event flow <start> extraction (flowTriggerType,
// plus flowObject now also populated for triggerType='PlatformEvent')
// ===========================================================================

// 16k. Platform-event flow (triggerType=PlatformEvent): flowObject populated
// from <start><object>, flowTriggerType='PlatformEvent', and
// flowRecordTriggerType stays null (a real platform-event <start> block never
// carries a <recordTriggerType> element -- that element is exclusive to the
// three RecordBefore*/RecordAfterSave shapes tested in 16a/16b/16e above).
{
  const text = src([
    '<Flow xmlns="http://soap.sforce.com/2006/04/metadata">',
    '    <start>',
    '        <connector><targetReference>Notify</targetReference></connector>',
    '        <object>Acme_Note__e</object>',
    '        <triggerType>PlatformEvent</triggerType>',
    '    </start>',
    '    <actionCalls>',
    '        <name>Notify</name>',
    '        <actionName>AcmeOrderInvocable</actionName>',
    '        <actionType>apex</actionType>',
    '    </actionCalls>',
    '</Flow>',
  ]);
  const refs = parseMetaFile({ path: 'flows/AcmeNoteEventFlow.flow-meta.xml', text });
  assert.strictEqual(refs.length, 1);
  assert.strictEqual(refs[0].className, 'AcmeOrderInvocable');
  assert.strictEqual(refs[0].flowObject, 'Acme_Note__e', "G1(b): platform-event <start><object> extracted");
  assert.strictEqual(refs[0].flowRecordTriggerType, null, 'platform-event <start> never carries <recordTriggerType>');
  assert.strictEqual(refs[0].flowTriggerType, 'PlatformEvent');
}

// 16l. flowTriggerType is also stamped (additively) onto the pre-existing
// record-triggered shapes from 16a/16b/16e, and stays null for the
// non-record-triggered shapes from 16c/16d -- re-verified here directly
// against extractFlowStart's four-way branch (record-triggered / platform-
// event / recognized-but-absent / unrecognized) in one place.
{
  const recordAfterSave = parseMetaFile({
    path: 'flows/AcmeOrderStatusRecordTriggeredFlow.flow-meta.xml',
    text: src([
      '<Flow xmlns="http://soap.sforce.com/2006/04/metadata">',
      '    <start>',
      '        <connector><targetReference>Recalc</targetReference></connector>',
      '        <object>Acme_Order__c</object>',
      '        <recordTriggerType>Update</recordTriggerType>',
      '        <triggerType>RecordAfterSave</triggerType>',
      '    </start>',
      '    <actionCalls>',
      '        <name>Recalc</name>',
      '        <actionName>AcmeOrderService.recalculatePricing</actionName>',
      '        <actionType>apex</actionType>',
      '    </actionCalls>',
      '</Flow>',
    ]),
  });
  assert.strictEqual(recordAfterSave[0].flowTriggerType, 'RecordAfterSave');

  const recordBeforeDelete = parseMetaFile({
    path: 'flows/AcmeShipmentDeleteBlockFlow.flow-meta.xml',
    text: src([
      '<Flow xmlns="http://soap.sforce.com/2006/04/metadata">',
      '    <start>',
      '        <connector><targetReference>Block</targetReference></connector>',
      '        <object>Acme_Shipment__c</object>',
      '        <triggerType>RecordBeforeDelete</triggerType>',
      '    </start>',
      '    <actionCalls>',
      '        <name>Block</name>',
      '        <actionName>AcmeOrderInvocable</actionName>',
      '        <actionType>apex</actionType>',
      '    </actionCalls>',
      '</Flow>',
    ]),
  });
  assert.strictEqual(recordBeforeDelete[0].flowTriggerType, 'RecordBeforeDelete');

  const screenFlow = parseMetaFile({
    path: 'flows/AcmeQuoteApprovalScreenFlow.flow-meta.xml',
    text: src([
      '<Flow xmlns="http://soap.sforce.com/2006/04/metadata">',
      '    <start>',
      '        <connector><targetReference>Screen1</targetReference></connector>',
      '    </start>',
      '    <actionCalls>',
      '        <name>Invoke</name>',
      '        <actionName>AcmeDiscountApprovalInvocable</actionName>',
      '        <actionType>apex</actionType>',
      '    </actionCalls>',
      '</Flow>',
    ]),
  });
  assert.strictEqual(screenFlow[0].flowTriggerType, null, 'screen flow has no recognized <start> triggerType');

  const unrecognizedTriggerType = parseMetaFile({
    path: 'flows/AcmeFutureShapeFlow.flow-meta.xml',
    text: src([
      '<Flow xmlns="http://soap.sforce.com/2006/04/metadata">',
      '    <start>',
      '        <connector><targetReference>Go</targetReference></connector>',
      '        <object>Acme_Order__c</object>',
      '        <triggerType>Scheduled</triggerType>',
      '    </start>',
      '    <actionCalls>',
      '        <name>Go</name>',
      '        <actionName>AcmeOrderInvocable</actionName>',
      '        <actionType>apex</actionType>',
      '    </actionCalls>',
      '</Flow>',
    ]),
  });
  assert.strictEqual(
    unrecognizedTriggerType[0].flowTriggerType,
    null,
    'unrecognized triggerType (e.g. Scheduled) is not one of the four metascan recognizes -- degrades to null, never throws'
  );
  assert.strictEqual(unrecognizedTriggerType[0].flowObject, null);
}

// ===========================================================================
// OmniScript — os-meta.xml + DataPack JSON remoteClass/remoteMethod
// ===========================================================================

// 17. os-meta.xml: single remote action
{
  const text = src([
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<OmniScript xmlns="http://soap.sforce.com/2006/04/metadata">',
    '    <type>Acme</type>',
    '    <subType>Shipment</subType>',
    '    <elements>',
    '        <name>RefreshTrackingAction</name>',
    '        <elementType>RemoteAction</elementType>',
    '        <remoteClass>AcmeShipmentAuraService</remoteClass>',
    '        <remoteMethod>refreshTracking</remoteMethod>',
    '    </elements>',
    '</OmniScript>',
  ]);
  const refs = parseMetaFile({ path: 'omniscripts/AcmeShipmentOmniScript.os-meta.xml', text });
  assert.strictEqual(refs.length, 1);
  assert.strictEqual(refs[0].kind, 'omniscript');
  assert.strictEqual(refs[0].label, 'AcmeShipmentOmniScript');
  assert.strictEqual(refs[0].className, 'AcmeShipmentAuraService');
  assert.strictEqual(refs[0].methodName, 'refreshTracking');
}

// 18. os-meta.xml: two remote actions, paired sequentially in source order
{
  const text = src([
    '<OmniScript xmlns="http://soap.sforce.com/2006/04/metadata">',
    '    <elements>',
    '        <name>ActionOne</name>',
    '        <remoteClass>AcmeFirstService</remoteClass>',
    '        <remoteMethod>firstMethod</remoteMethod>',
    '    </elements>',
    '    <elements>',
    '        <name>ActionTwo</name>',
    '        <remoteClass>AcmeSecondService</remoteClass>',
    '        <remoteMethod>secondMethod</remoteMethod>',
    '    </elements>',
    '</OmniScript>',
  ]);
  const refs = parseMetaFile({ path: 'omniscripts/AcmeMultiActionOmniScript.os-meta.xml', text });
  assert.strictEqual(refs.length, 2);
  assert.strictEqual(refs[0].className, 'AcmeFirstService');
  assert.strictEqual(refs[0].methodName, 'firstMethod');
  assert.strictEqual(refs[1].className, 'AcmeSecondService');
  assert.strictEqual(refs[1].methodName, 'secondMethod');
  assert.ok(refs[1].line > refs[0].line, 'line numbers must advance monotonically');
}

// 19. DataPack JSON: recursive walk finds remoteClass/remoteMethod pairs
//     nested inside PropertySetJSON, and the escaped-string decoy field
//     (..._PropertySet__c, a JSON-encoded STRING with the same pair baked in
//     compact/escaped form) does NOT produce a duplicate or wrong-line ref.
{
  const obj = {
    VlocityDataPackKey: 'OmniScriptDataPack/Acme-Quote-English-1',
    VlocityRecordData: {
      Name: 'Acme-Quote-English-1',
      '%vlocity_namespace%__Element__r': {
        records: [
          {
            VlocityRecordData: {
              Name: 'CreateQuoteAction',
              '%vlocity_namespace%__PropertySet__c':
                '{"remoteClass":"AcmeQuoteAuraService","remoteMethod":"createQuote","remoteOptions":{}}',
              PropertySetJSON: {
                remoteClass: 'AcmeQuoteAuraService',
                remoteMethod: 'createQuote',
                remoteOptions: {},
              },
            },
          },
          {
            VlocityRecordData: {
              Name: 'GetInvoiceSummaryAction',
              '%vlocity_namespace%__PropertySet__c':
                '{"remoteClass":"AcmeQuoteAuraService","remoteMethod":"getInvoiceSummary","remoteOptions":{}}',
              PropertySetJSON: {
                remoteClass: 'AcmeQuoteAuraService',
                remoteMethod: 'getInvoiceSummary',
                remoteOptions: {},
              },
            },
          },
        ],
      },
    },
  };
  const text = JSON.stringify(obj, null, 2);
  const refs = parseMetaFile({ path: 'omniscripts/AcmeQuoteOmniScript/AcmeQuoteOmniScript_DataPack.json', text });
  assert.strictEqual(refs.length, 2, 'exactly one ref per remote action -- the escaped decoy must not double-count');
  assert.strictEqual(refs[0].kind, 'omniscript');
  assert.strictEqual(refs[0].label, 'AcmeQuoteOmniScript_DataPack');
  assert.strictEqual(refs[0].className, 'AcmeQuoteAuraService');
  assert.strictEqual(refs[0].methodName, 'createQuote');
  assert.strictEqual(refs[1].methodName, 'getInvoiceSummary');
  assert.ok(refs[1].line > refs[0].line, 'second pair must be located later in the file than the first');
  // The located line must be inside the real (unescaped) PropertySetJSON
  // object, never inside the escaped ..._PropertySet__c string field.
  assert.ok(!/\\"/.test(refs[0].lineText), 'matched line must not be the backslash-escaped decoy');
}

// 20. Top-level array DataPack shape also walks correctly
{
  const arr = [
    { remoteClass: 'AcmeArrayServiceOne', remoteMethod: 'methodOne' },
    { nested: { remoteClass: 'AcmeArrayServiceTwo', remoteMethod: 'methodTwo' } },
  ];
  const refs = parseMetaFile({ path: 'omniscripts/AcmeArrayShaped_DataPack.json', text: JSON.stringify(arr, null, 2) });
  assert.strictEqual(refs.length, 2);
  assert.deepStrictEqual(
    refs.map((r) => r.className).sort(),
    ['AcmeArrayServiceOne', 'AcmeArrayServiceTwo'].sort()
  );
}

// 21. Malformed / irrelevant JSON never throws and yields no refs
{
  assert.doesNotThrow(() => parseMetaFile({ path: 'omniscripts/Broken_DataPack.json', text: '{ not valid json' }));
  assert.deepStrictEqual(parseMetaFile({ path: 'omniscripts/Broken_DataPack.json', text: '{ not valid json' }), []);
  assert.deepStrictEqual(
    parseMetaFile({ path: 'omniscripts/NoRemote_DataPack.json', text: JSON.stringify({ a: 1, b: [1, 2, 3] }) }),
    []
  );
}

// ===========================================================================
// H7(c) regression: extractOmniscriptXml index-based scan (was a
// text.slice(afterIdx)-per-match O(N*len) loop) + walkJsonForRemotePairs
// depth cap (64)
// ===========================================================================

// 21a. Many <remoteClass>/<remoteMethod> pairs in one file: every pair must
// still be found, in the correct source order, with correctly advancing
// line numbers -- the index-based rewrite (REMOTE_METHOD_XML_RE now global,
// driven by `.lastIndex` against the unsliced text) must find EXACTLY the
// same "next <remoteMethod> after this <remoteClass>" match the old
// slice-per-match loop did. Also locks in the perf fix: this file is large
// enough (300 remote actions) that the old O(N*len) slicing would be
// unmistakably slow, so a generous wall-clock bound catches a regression
// back to slicing without being flaky on a loaded CI box.
{
  const N = 300;
  const lines = ['<OmniScript xmlns="http://soap.sforce.com/2006/04/metadata">'];
  for (let i = 0; i < N; i++) {
    lines.push('    <elements>');
    lines.push(`        <name>Action${i}</name>`);
    lines.push(`        <remoteClass>AcmeService${i}</remoteClass>`);
    lines.push(`        <remoteMethod>method${i}</remoteMethod>`);
    lines.push('    </elements>');
  }
  lines.push('</OmniScript>');
  const text = src(lines);

  const t0 = Date.now();
  const refs = parseMetaFile({ path: 'omniscripts/AcmeManyActionsOmniScript.os-meta.xml', text });
  const elapsed = Date.now() - t0;

  assert.strictEqual(refs.length, N, 'every remoteClass/remoteMethod pair must be found');
  for (let i = 0; i < N; i++) {
    assert.strictEqual(refs[i].className, `AcmeService${i}`, `pair ${i} className in source order`);
    assert.strictEqual(refs[i].methodName, `method${i}`, `pair ${i} methodName in source order`);
  }
  // strictly increasing line numbers -- confirms `.lastIndex`-driven scanning
  // never re-finds an EARLIER <remoteMethod> than the one immediately after
  // its <remoteClass>.
  for (let i = 1; i < refs.length; i++) {
    assert.ok(refs[i].line > refs[i - 1].line, `line numbers must strictly advance at pair ${i}`);
  }
  assert.ok(elapsed < 200, `${N}-pair os-meta.xml scan must stay well under 200ms (took ${elapsed}ms) -- catches an O(N*len) slicing regression`);
}

// 21b. Unpaired <remoteClass> (no following <remoteMethod> anywhere in the
// rest of the file) must yield nothing for that dangling entry and never
// throw -- exercises the "REMOTE_METHOD_XML_RE.exec returns null" branch of
// the index-based rewrite exactly like the old slice-based version's
// `if (!mm) continue;` did.
{
  const text = src([
    '<OmniScript xmlns="http://soap.sforce.com/2006/04/metadata">',
    '    <elements>',
    '        <remoteClass>AcmeDanglingService</remoteClass>',
    '    </elements>',
    '</OmniScript>',
  ]);
  const refs = parseMetaFile({ path: 'omniscripts/AcmeDanglingOmniScript.os-meta.xml', text });
  assert.deepStrictEqual(refs, [], 'a remoteClass with no following remoteMethod anywhere yields no ref');
}

// 21c. walkJsonForRemotePairs depth cap: a remoteClass/remoteMethod pair
// nested WITHIN the 64-level cap is still found; one nested BEYOND it is
// silently not descended into (never throws, never a RangeError from stack
// exhaustion on pathological nesting).
{
  const WITHIN = 30;
  const BEYOND = 100;

  function nest(depth, leaf) {
    let node = leaf;
    for (let i = 0; i < depth; i++) node = { child: node };
    return node;
  }

  const withinCap = nest(WITHIN, { remoteClass: 'AcmeWithinCapService', remoteMethod: 'withinCapMethod' });
  const refsWithin = parseMetaFile({
    path: 'omniscripts/AcmeWithinCap_DataPack.json',
    text: JSON.stringify(withinCap),
  });
  assert.strictEqual(refsWithin.length, 1, `a pair nested ${WITHIN} levels deep (under the 64 cap) must still be found`);
  assert.strictEqual(refsWithin[0].className, 'AcmeWithinCapService');

  const beyondCap = nest(BEYOND, { remoteClass: 'AcmeBeyondCapService', remoteMethod: 'beyondCapMethod' });
  const textBeyond = JSON.stringify(beyondCap);
  assert.doesNotThrow(() => parseMetaFile({ path: 'omniscripts/AcmeBeyondCap_DataPack.json', text: textBeyond }));
  const refsBeyond = parseMetaFile({ path: 'omniscripts/AcmeBeyondCap_DataPack.json', text: textBeyond });
  assert.strictEqual(refsBeyond.length, 0, `a pair nested ${BEYOND} levels deep (beyond the 64 cap) must not be found`);

  // A genuinely deep (thousands of levels) nesting must never stack-overflow
  // -- this is the actual DoS/robustness concern the cap defends against.
  const veryDeep = nest(5000, { remoteClass: 'AcmeVeryDeepService', remoteMethod: 'veryDeepMethod' });
  const textVeryDeep = JSON.stringify(veryDeep);
  assert.doesNotThrow(
    () => parseMetaFile({ path: 'omniscripts/AcmeVeryDeep_DataPack.json', text: textVeryDeep }),
    'walkJsonForRemotePairs must never stack-overflow on pathologically deep JSON nesting'
  );
}

// ===========================================================================
// Visualforce — controller= / extensions= on the root tag (no adv-org
// fixtures; inline-only per the task brief)
// ===========================================================================

// 22. controller= alone
{
  const text = src([
    '<apex:page controller="AcmeQuoteController" showHeader="false">',
    '    <apex:outputText value="{!quoteName}"/>',
    '</apex:page>',
  ]);
  const refs = parseMetaFile({ path: 'pages/AcmeQuotePage.page', text });
  assert.strictEqual(refs.length, 1);
  assert.strictEqual(refs[0].kind, 'vf');
  assert.strictEqual(refs[0].label, 'AcmeQuotePage');
  assert.strictEqual(refs[0].className, 'AcmeQuoteController');
  assert.strictEqual(refs[0].methodName, null);
}

// 23. extensions= with multiple comma-separated classes, plus controller=
//     together on one root tag -> one ref per class.
{
  const text = '<apex:page controller="AcmeBaseController" extensions="AcmeExtOne,AcmeExtTwo, AcmeExtThree">';
  const refs = parseMetaFile({ path: 'pages/AcmeMultiExtPage.page', text });
  assert.strictEqual(refs.length, 4, '1 controller + 3 extensions');
  assert.deepStrictEqual(
    refs.map((r) => r.className).sort(),
    ['AcmeBaseController', 'AcmeExtOne', 'AcmeExtThree', 'AcmeExtTwo'].sort()
  );
  assert.ok(refs.every((r) => r.methodName === null));
}

// 24. Self-closing tag + apex:component root
{
  const pageRefs = parseMetaFile({
    path: 'pages/AcmeSelfClosingPage.page',
    text: '<apex:page controller="AcmeSelfClosingController" />',
  });
  assert.strictEqual(pageRefs.length, 1);
  assert.strictEqual(pageRefs[0].className, 'AcmeSelfClosingController');

  const componentRefs = parseMetaFile({
    path: 'components/AcmeReusableComponent.component',
    text: '<apex:component controller="AcmeComponentController"></apex:component>',
  });
  assert.strictEqual(componentRefs.length, 1);
  assert.strictEqual(componentRefs[0].kind, 'vf');
  assert.strictEqual(componentRefs[0].className, 'AcmeComponentController');
}

// ===========================================================================
// Defensive: never throw, unknown extensions yield nothing
// ===========================================================================
{
  assert.doesNotThrow(() => parseMetaFile(undefined));
  assert.deepStrictEqual(parseMetaFile(undefined), []);
  assert.doesNotThrow(() => parseMetaFile({}));
  assert.deepStrictEqual(parseMetaFile({}), []);
  assert.doesNotThrow(() => parseMetaFile({ path: 'x.js', text: undefined }));
  assert.deepStrictEqual(parseMetaFile({ path: 'x.js', text: undefined }), []);
  assert.doesNotThrow(() => parseMetaFile({ path: 'x.unknownextension', text: 'whatever' }));
  assert.deepStrictEqual(parseMetaFile({ path: 'x.unknownextension', text: 'whatever' }), []);
  assert.doesNotThrow(() => parseMetaFile({ path: 'x.js', text: '' }));
  assert.deepStrictEqual(parseMetaFile({ path: 'x.js', text: '' }), []);

  assert.doesNotThrow(() => scanBundle(undefined));
  assert.deepStrictEqual(scanBundle(undefined), []);
  assert.doesNotThrow(() => scanBundle(null));
  assert.deepStrictEqual(scanBundle(null), []);
  assert.doesNotThrow(() => scanBundle([]));
  assert.deepStrictEqual(scanBundle([]), []);
  assert.doesNotThrow(() =>
    scanBundle([null, undefined, {}, { path: 'aura/X/X.cmp' }, { text: 'no path' }])
  );
}

// ===========================================================================
// v0.8 — namespace/managed-package modeling: N1(c) (metascan half -- LWC was
// already done in v0.7.1's M1; this amendment extends the same `namespace`
// field to Flow actionNames, CMDT values, and os-meta remoteClass) + N3's
// metascan-side stripOwnNamespace() hook. resolver.js's attachMetaCallers()
// routing (the other half of N1(c)) and the extension's opts.ownNamespace
// plumbing (N3) are both out of scope for this file/owner.
// ===========================================================================

// 25. Flow: dotted 3-segment 'ns.Class.method' actionName -- namespace folds
//     the one leading segment, className/methodName are the trailing pair,
//     exactly the shape v0.8-B5's GROUND-TRUTH pins for
//     'zenq.KappaGateway.dispatch'.
{
  const text = src([
    '<Flow xmlns="http://soap.sforce.com/2006/04/metadata">',
    '    <actionCalls>',
    '        <name>Call_Zenq_Dotted</name>',
    '        <actionName>zenq.KappaGateway.dispatch</actionName>',
    '        <actionType>apex</actionType>',
    '    </actionCalls>',
    '</Flow>',
  ]);
  const refs = parseMetaFile({ path: 'flows/AcmeNamespaceProbeFlow.flow-meta.xml', text });
  assert.strictEqual(refs.length, 1);
  assert.strictEqual(refs[0].className, 'KappaGateway');
  assert.strictEqual(refs[0].methodName, 'dispatch');
  assert.strictEqual(refs[0].namespace, 'zenq', "N1(c): dotted 'ns.Class.method' actionName must carry namespace");
}

// 26. Flow: dotted 4-segment 'ns.Outer.Inner.method' -- parity with the
//     pre-existing LWC 4+-segment fold (M1's own header comment: "every
//     leading segment before the trailing pair" folds into one dot-joined
//     namespace string). Not a GROUND-TRUTH-pinned shape, but Flow's fix is
//     documented as "the same kind of namespace-field fix M1 already gave
//     lwc refs" -- this pins that the generalization is real, not just the
//     3-segment special case.
{
  const text = src([
    '<Flow xmlns="http://soap.sforce.com/2006/04/metadata">',
    '    <actionCalls>',
    '        <actionName>zenq.Outer.Inner.method</actionName>',
    '        <actionType>apex</actionType>',
    '    </actionCalls>',
    '</Flow>',
  ]);
  const refs = parseMetaFile({ path: 'flows/AcmeDeepNamespaceFlow.flow-meta.xml', text });
  assert.strictEqual(refs.length, 1);
  assert.strictEqual(refs[0].namespace, 'zenq.Outer', '4-segment actionName folds every leading segment before the trailing pair');
  assert.strictEqual(refs[0].className, 'Inner');
  assert.strictEqual(refs[0].methodName, 'method');
}

// 27. Flow: bare 'ns__Class' actionName (no dot -- Invocable-style) --
//     managed-object-style double-underscore split, methodName stays null
//     (same shape a local bare actionName already produced). Exact
//     GROUND-TRUTH v0.8-B5 shape for 'kwx__PostLedgerEntry'.
{
  const text = src([
    '<Flow xmlns="http://soap.sforce.com/2006/04/metadata">',
    '    <actionCalls>',
    '        <name>Call_Kwx_Bare</name>',
    '        <actionName>kwx__PostLedgerEntry</actionName>',
    '        <actionType>apex</actionType>',
    '    </actionCalls>',
    '</Flow>',
  ]);
  const refs = parseMetaFile({ path: 'flows/AcmeNamespaceProbeFlow.flow-meta.xml', text });
  assert.strictEqual(refs.length, 1);
  assert.strictEqual(refs[0].className, 'PostLedgerEntry');
  assert.strictEqual(refs[0].methodName, null);
  assert.strictEqual(refs[0].namespace, 'kwx', "N1(c): bare 'ns__Class' actionName must carry namespace");
}

// 28. Flow: bare LOCAL actionName (no dot, no '__') -- byte-identical to
//     pre-v0.8 output, namespace stays null.
{
  const refs = parseMetaFile({
    path: 'flows/AcmeBackorderResolutionFlow.flow-meta.xml',
    text: src([
      '<Flow xmlns="http://soap.sforce.com/2006/04/metadata">',
      '    <actionCalls>',
      '        <actionName>AcmeOrderInvocable</actionName>',
      '        <actionType>apex</actionType>',
      '    </actionCalls>',
      '</Flow>',
    ]),
  });
  assert.strictEqual(refs.length, 1);
  assert.strictEqual(refs[0].className, 'AcmeOrderInvocable');
  assert.strictEqual(refs[0].methodName, null);
  assert.strictEqual(refs[0].namespace, null, 'ordinary local bare actionName -- no false namespace');
}

// 29. Flow: dotted LOCAL 'Class.method' (2-segment, no namespace prefix) --
//     byte-identical to pre-v0.8 output, namespace stays null. Regression
//     pin for test #14's exact fixture shape.
{
  const refs = parseMetaFile({
    path: 'flows/AcmeOrderStatusRecordTriggeredFlow.flow-meta.xml',
    text: src([
      '<Flow xmlns="http://soap.sforce.com/2006/04/metadata">',
      '    <actionCalls>',
      '        <actionName>AcmeOrderService.recalculatePricing</actionName>',
      '        <actionType>apex</actionType>',
      '    </actionCalls>',
      '</Flow>',
    ]),
  });
  assert.strictEqual(refs.length, 1);
  assert.strictEqual(refs[0].className, 'AcmeOrderService');
  assert.strictEqual(refs[0].methodName, 'recalculatePricing');
  assert.strictEqual(refs[0].namespace, null, 'bare 2-segment Class.method -- no namespace prefix, unchanged from pre-v0.8');
}

// 30. CMDT: 'ns__Class' value -- same double-underscore split as Flow's bare
//     form. Exact GROUND-TRUTH v0.8-B5 shape for 'kwx__PostLedgerEntry' --
//     must land on className='PostLedgerEntry', namespace='kwx', the SAME
//     pair Flow's bare actionName (#27 above) produces, proving the
//     cross-surface consistency the doc calls for.
{
  const text = src([
    '<CustomMetadata xmlns="http://soap.sforce.com/2006/04/metadata" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">',
    '    <values>',
    '        <field>Handler_Class_Name__c</field>',
    '        <value xsi:type="xsd:string">kwx__PostLedgerEntry</value>',
    '    </values>',
    '</CustomMetadata>',
  ]);
  const refs = parseMetaFile({ path: 'customMetadata/Acme_Trigger_Config.Namespace_Handler.md-meta.xml', text });
  assert.strictEqual(refs.length, 1);
  assert.strictEqual(refs[0].className, 'PostLedgerEntry');
  assert.strictEqual(refs[0].namespace, 'kwx', "N1(c): CMDT 'ns__Class' value must carry namespace");
  assert.strictEqual(refs[0].fieldName, 'Handler_Class_Name__c');
}

// 31. CMDT: an ordinary custom-object/field-style API name value (internal
//     single-underscore word separators + a trailing '__c' suffix) must NOT
//     be misparsed as namespaced -- the false-positive risk the design note
//     above calls out by name. Real corpus regression pin: gauntlet-org's
//     own 'Kappa_Order__c' SobjectApiName__c value (verified live against
//     the actual fixture file further below) is the concrete instance of
//     exactly this shape.
{
  const text = src([
    '<CustomMetadata xmlns="http://soap.sforce.com/2006/04/metadata">',
    '    <values>',
    '        <field>SobjectApiName__c</field>',
    '        <value xsi:type="xsd:string">Kappa_Order__c</value>',
    '    </values>',
    '</CustomMetadata>',
  ]);
  const refs = parseMetaFile({ path: 'customMetadata/Acme_Trigger_Config.Decoy.md-meta.xml', text });
  assert.strictEqual(refs.length, 1);
  assert.strictEqual(refs[0].className, 'Kappa_Order__c', 'object-API-name value must stay verbatim, not split');
  assert.strictEqual(
    refs[0].namespace,
    null,
    "'Kappa_Order__c' must NOT be misread as namespace='Kappa_Order' -- namespace tokens never contain '_'"
  );
}

// 32. CMDT: ordinary local value (no '__' at all) -- byte-identical to
//     pre-v0.8 output, namespace stays null. Regression pin for test #16f's
//     exact fixture shape.
{
  const refs = parseMetaFile({
    path: 'customMetadata/Acme_Integration_Config.Order_Sync_Handler.md-meta.xml',
    text: src([
      '<CustomMetadata xmlns="http://soap.sforce.com/2006/04/metadata">',
      '    <values>',
      '        <field>Handler_Class__c</field>',
      '        <value xsi:type="xsd:string">AcmeOrderService</value>',
      '    </values>',
      '</CustomMetadata>',
    ]),
  });
  assert.strictEqual(refs.length, 1);
  assert.strictEqual(refs[0].className, 'AcmeOrderService');
  assert.strictEqual(refs[0].namespace, null, 'ordinary local CMDT value -- no false namespace');
}

// 33. os-meta remoteClass: dotted 'ns.Class' -- everything before the
//     trailing SINGLE class segment folds into namespace (a remoteClass
//     value never embeds a method -- that always comes from the paired
//     remoteMethod element, unlike LWC/Flow's trailing PAIR).
{
  const text = src([
    '<OmniScript xmlns="http://soap.sforce.com/2006/04/metadata">',
    '    <elements>',
    '        <remoteClass>zenq.KappaGateway</remoteClass>',
    '        <remoteMethod>dispatch</remoteMethod>',
    '    </elements>',
    '</OmniScript>',
  ]);
  const refs = parseMetaFile({ path: 'omniscripts/AcmeNamespaceProbeOmniScript.os-meta.xml', text });
  assert.strictEqual(refs.length, 1);
  assert.strictEqual(refs[0].className, 'KappaGateway');
  assert.strictEqual(refs[0].methodName, 'dispatch');
  assert.strictEqual(refs[0].namespace, 'zenq', "N1(c): os-meta dotted 'ns.Class' remoteClass must carry namespace");
}

// 34. os-meta remoteClass: bare 'ns__Class' (no dot) -- same
//     double-underscore split as Flow/CMDT's bare forms.
{
  const text = src([
    '<OmniScript xmlns="http://soap.sforce.com/2006/04/metadata">',
    '    <elements>',
    '        <remoteClass>kwx__PostLedgerEntry</remoteClass>',
    '        <remoteMethod>run</remoteMethod>',
    '    </elements>',
    '</OmniScript>',
  ]);
  const refs = parseMetaFile({ path: 'omniscripts/AcmeNamespaceProbeOmniScript.os-meta.xml', text });
  assert.strictEqual(refs.length, 1);
  assert.strictEqual(refs[0].className, 'PostLedgerEntry');
  assert.strictEqual(refs[0].methodName, 'run');
  assert.strictEqual(refs[0].namespace, 'kwx', "N1(c): os-meta bare 'ns__Class' remoteClass must carry namespace");
}

// 35. os-meta remoteClass: ordinary local value (no dot, no '__') --
//     byte-identical to pre-v0.8 output, namespace stays null. Regression
//     pin for test #17's exact fixture shape.
{
  const refs = parseMetaFile({
    path: 'omniscripts/AcmeShipmentOmniScript.os-meta.xml',
    text: src([
      '<OmniScript xmlns="http://soap.sforce.com/2006/04/metadata">',
      '    <elements>',
      '        <remoteClass>AcmeShipmentAuraService</remoteClass>',
      '        <remoteMethod>refreshTracking</remoteMethod>',
      '    </elements>',
      '</OmniScript>',
    ]),
  });
  assert.strictEqual(refs.length, 1);
  assert.strictEqual(refs[0].className, 'AcmeShipmentAuraService');
  assert.strictEqual(refs[0].namespace, null, 'ordinary local os-meta remoteClass -- no false namespace');
}

// 36. os-meta remoteClass: object-API-name-style decoy ('Kappa_Order__c'
//     shape) must not misfire here either -- same guard as CMDT test #31,
//     exercised on the XML remoteClass surface.
{
  const refs = parseMetaFile({
    path: 'omniscripts/AcmeDecoyOmniScript.os-meta.xml',
    text: src([
      '<OmniScript xmlns="http://soap.sforce.com/2006/04/metadata">',
      '    <elements>',
      '        <remoteClass>Kappa_Order__c</remoteClass>',
      '        <remoteMethod>whatever</remoteMethod>',
      '    </elements>',
      '</OmniScript>',
    ]),
  });
  assert.strictEqual(refs.length, 1);
  assert.strictEqual(refs[0].className, 'Kappa_Order__c');
  assert.strictEqual(refs[0].namespace, null);
}

// 37. OmniScript/IP DataPack *.json remoteClass: deliberately OUT OF SCOPE
//     for this amendment (see the v0.8 header note) -- a namespace-shaped
//     remoteClass value in the JSON surface stays completely untouched
//     (className verbatim, no `namespace` field set at all), proving this is
//     a documented scope boundary and not an oversight or an inconsistent
//     half-fix.
{
  const obj = { remoteClass: 'zenq.KappaGateway', remoteMethod: 'dispatch' };
  const refs = parseMetaFile({
    path: 'omniscripts/AcmeNamespaceProbe_DataPack.json',
    text: JSON.stringify(obj),
  });
  assert.strictEqual(refs.length, 1);
  assert.strictEqual(refs[0].className, 'zenq.KappaGateway', 'JSON DataPack remoteClass amendment out of scope -- verbatim');
  assert.strictEqual(refs[0].methodName, 'dispatch');
  assert.strictEqual('namespace' in refs[0], false, 'JSON DataPack refs never gain a namespace field in this amendment');
}

// ===========================================================================
// N3 — stripOwnNamespace(refs, ownNamespace): metascan's own-namespace
// stripping hook. Pure function; the extension (out of scope here) is
// expected to call this once, after scanning, before handing refs to
// resolver.js's attachMetaCallers().
// ===========================================================================

// 38. Absent/empty/non-string ownNamespace -> no stripping at all (N3:
//     "Absent/empty namespace property -> no stripping, current behavior")
//     -- returns the EXACT SAME array reference, not just an equal one.
{
  const refs = parseMetaFile({
    path: 'lwc/kappaGatewayPanel/kappaGatewayPanel.js',
    text: "import dispatch from '@salesforce/apex/vtx.VertexPricingService.repriceOrder';",
  });
  assert.strictEqual(stripOwnNamespace(refs, undefined), refs, 'undefined ownNamespace -> same array, no-op');
  assert.strictEqual(stripOwnNamespace(refs, null), refs, 'null ownNamespace -> same array, no-op');
  assert.strictEqual(stripOwnNamespace(refs, ''), refs, "empty-string ownNamespace -> same array, no-op");
  assert.strictEqual(stripOwnNamespace(refs, '   '), refs, 'whitespace-only ownNamespace -> same array, no-op');
  assert.strictEqual(stripOwnNamespace(refs, 42), refs, 'non-string ownNamespace -> same array, no-op');
}

// 39. Own-namespace refs fold to local (namespace -> null, className/
//     methodName untouched -- already the split local name); other-namespace
//     refs pass through unchanged; case-insensitive match (Apex identifiers
//     are case-insensitive, same as every other lookup in this engine
//     family). Exercises the exact B1 fixture shape
//     ('vtx.VertexPricingService.repriceOrder' with own namespace 'vtx').
{
  const refs = parseMetaFile({
    path: 'flows/VtxOwnNamespaceProbeFlow.flow-meta.xml',
    text: src([
      '<Flow xmlns="http://soap.sforce.com/2006/04/metadata">',
      '    <actionCalls>',
      '        <actionName>vtx.VertexPricingService.repriceOrder</actionName>',
      '        <actionType>apex</actionType>',
      '    </actionCalls>',
      '    <actionCalls>',
      '        <actionName>zenq.KappaGateway.dispatch</actionName>',
      '        <actionType>apex</actionType>',
      '    </actionCalls>',
      '</Flow>',
    ]),
  });
  assert.strictEqual(refs.length, 2);

  const stripped = stripOwnNamespace(refs, 'vtx');
  const own = stripped.find((r) => r.className === 'VertexPricingService');
  const other = stripped.find((r) => r.className === 'KappaGateway');
  assert.strictEqual(own.namespace, null, 'own-namespace (vtx) ref must fold to local -- no external node');
  assert.strictEqual(own.methodName, 'repriceOrder', 'className/methodName untouched -- already the split local name');
  assert.strictEqual(other.namespace, 'zenq', 'a DIFFERENT namespace must never be stripped just because SOME ownNamespace was passed');

  // Case-insensitive match: Apex identifiers are case-insensitive.
  const strippedUpper = stripOwnNamespace(refs, 'VTX');
  assert.strictEqual(
    strippedUpper.find((r) => r.className === 'VertexPricingService').namespace,
    null,
    'own-namespace match must be case-insensitive'
  );
}

// 40. Refs with no `namespace` field at all (aura/vf, or any kind this
//     amendment doesn't touch) pass through as the exact SAME object
//     reference, never copied -- stripOwnNamespace must be a true no-op for
//     kinds it has nothing to do.
{
  const auraRefs = parseMetaFile({
    path: 'aura/AcmeSelfClosing/AcmeSelfClosing.cmp',
    text: '<aura:component controller="AcmeSelfClosingController"/>',
  });
  const vfRefs = parseMetaFile({
    path: 'pages/AcmeQuotePage.page',
    text: '<apex:page controller="AcmeQuoteController"/>',
  });
  const strippedAura = stripOwnNamespace(auraRefs, 'anyns');
  const strippedVf = stripOwnNamespace(vfRefs, 'anyns');
  assert.strictEqual(strippedAura[0], auraRefs[0], 'aura ref (no namespace field) must pass through as the same object');
  assert.strictEqual(strippedVf[0], vfRefs[0], 'vf ref (no namespace field) must pass through as the same object');
}

// 41. Purity: stripOwnNamespace never mutates its input array or any input
//     ref object, even when it DOES fold a matching namespace to null.
{
  const refs = parseMetaFile({
    path: 'lwc/kappaGatewayPanel/kappaGatewayPanel.js',
    text: "import dispatch from '@salesforce/apex/vtx.KappaGateway.dispatch';",
  });
  const refsSnapshot = JSON.parse(JSON.stringify(refs));
  const original = refs[0];
  const stripped = stripOwnNamespace(refs, 'vtx');
  assert.deepStrictEqual(refs, refsSnapshot, 'input array/objects must be byte-identical after the call -- pure function');
  assert.notStrictEqual(stripped[0], original, 'a folded ref must be a NEW object, not the mutated original');
  assert.strictEqual(original.namespace, 'vtx', 'the ORIGINAL ref object must be untouched -- namespace still vtx');
  assert.strictEqual(stripped[0].namespace, null, 'the NEW ref reflects the fold');
}

// 42. Defensive: non-array `refs` input is returned verbatim, never throws
//     (mirrors this file's "never throw, degrade gracefully" posture).
{
  assert.doesNotThrow(() => stripOwnNamespace(undefined, 'vtx'));
  assert.strictEqual(stripOwnNamespace(undefined, 'vtx'), undefined);
  assert.doesNotThrow(() => stripOwnNamespace(null, 'vtx'));
  assert.strictEqual(stripOwnNamespace(null, 'vtx'), null);
  assert.doesNotThrow(() => stripOwnNamespace([], 'vtx'));
  assert.deepStrictEqual(stripOwnNamespace([], 'vtx'), []);
}

// ===========================================================================
// v0.10 (Round A, A2) — Visualforce ACTION-binding extraction. metascan-only
// half of the amendment: resolver.js's attach logic (which of a page's
// controller/extensions classes DECLARES the bound method) is out of scope
// for this file/owner and is not exercised here — only the raw MetaRef
// extraction (className:null, methodName, controllerClass, extensionClasses)
// per GROUND-TRUTH.md's v0.10-B section.
// ===========================================================================

// 43. apex:page root action= (single identifier) -> method-level ref,
//     alongside the pre-existing class-level controller= ref (untouched).
{
  const text = src([
    '<apex:page controller="AcmeAssistController" action="{!initAssist}">',
    '  <apex:outputText value="{!label}"/>',
    '</apex:page>',
  ]);
  const refs = parseMetaFile({ path: 'pages/AcmeAssistPage.page', text });
  assert.strictEqual(refs.length, 2, '1 class-level controller ref + 1 method-level action ref');

  const classRef = refs.find((r) => r.className === 'AcmeAssistController');
  assert.ok(classRef, 'pre-existing class-level controller= ref must be untouched');
  assert.strictEqual(classRef.methodName, null);

  const actionRef = refs.find((r) => r.methodName === 'initAssist');
  assert.ok(actionRef, 'apex:page root action= must be extracted');
  assert.strictEqual(actionRef.kind, 'vf');
  assert.strictEqual(actionRef.className, null, 'A2: className is ALWAYS null on the method-level shape');
  assert.strictEqual(actionRef.line, 1);
  assert.strictEqual(actionRef.controllerClass, 'AcmeAssistController');
  assert.deepStrictEqual(actionRef.extensionClasses, []);
}

// 44. apex:commandButton action= -- multiple buttons in one file, each its
//     own ref with the correct line number; extensions= list carried
//     verbatim (comma-split, trimmed) onto every action ref.
{
  const text = src([
    '<apex:page controller="AcmeOrderController" extensions="AcmeOrderExtOne,AcmeOrderExtTwo">',
    '  <apex:form>',
    '    <apex:commandButton value="Save" action="{!saveOrder}"/>',
    '    <apex:commandButton value="Cancel" action="{!cancelOrder}"/>',
    '  </apex:form>',
    '</apex:page>',
  ]);
  const refs = parseMetaFile({ path: 'pages/AcmeOrderPage.page', text });
  const actionRefs = refs.filter((r) => r.className === null);
  assert.strictEqual(actionRefs.length, 2);

  const save = actionRefs.find((r) => r.methodName === 'saveOrder');
  assert.ok(save);
  assert.strictEqual(save.line, 3);
  assert.strictEqual(save.controllerClass, 'AcmeOrderController');
  assert.deepStrictEqual(save.extensionClasses, ['AcmeOrderExtOne', 'AcmeOrderExtTwo']);

  const cancel = actionRefs.find((r) => r.methodName === 'cancelOrder');
  assert.ok(cancel);
  assert.strictEqual(cancel.line, 4);
  assert.deepStrictEqual(cancel.extensionClasses, ['AcmeOrderExtOne', 'AcmeOrderExtTwo']);
}

// 45. apex:commandLink action=
{
  const text = src([
    '<apex:page controller="AcmeLinkController">',
    '  <apex:commandLink value="Retry" action="{!retry}"/>',
    '</apex:page>',
  ]);
  const refs = parseMetaFile({ path: 'pages/AcmeLinkPage.page', text });
  const actionRef = refs.find((r) => r.methodName === 'retry');
  assert.ok(actionRef, 'apex:commandLink action= must be extracted');
  assert.strictEqual(actionRef.line, 2);
}

// 46. apex:actionFunction action=
{
  const text = src([
    '<apex:page controller="AcmeFnController">',
    '  <apex:actionFunction name="doSort" action="{!sortResults}" reRender="panel"/>',
    '</apex:page>',
  ]);
  const refs = parseMetaFile({ path: 'pages/AcmeFnPage.page', text });
  const actionRef = refs.find((r) => r.methodName === 'sortResults');
  assert.ok(actionRef, 'apex:actionFunction action= must be extracted');
  assert.strictEqual(actionRef.line, 2);
}

// 47. apex:actionPoller action=
{
  const text = src([
    '<apex:page controller="AcmePollController">',
    '  <apex:actionPoller interval="30" action="{!refreshStatus}"/>',
    '</apex:page>',
  ]);
  const refs = parseMetaFile({ path: 'pages/AcmePollPage.page', text });
  const actionRef = refs.find((r) => r.methodName === 'refreshStatus');
  assert.ok(actionRef, 'apex:actionPoller action= must be extracted');
  assert.strictEqual(actionRef.line, 2);
}

// 48. apex:actionSupport with a DOTTED (non-identifier) expression -- must be
//     SKIPPED entirely: no MetaRef emitted for that attribute at all.
{
  const text = src([
    '<apex:page controller="AcmeSupportController" extensions="AcmeSupportExt">',
    '  <apex:actionSupport event="onchange" action="{!supportExt.legacyReset}"/>',
    '</apex:page>',
  ]);
  const refs = parseMetaFile({ path: 'pages/AcmeSupportPage.page', text });
  assert.strictEqual(refs.length, 2, 'only the 2 pre-existing class-level refs -- the dotted action= contributes nothing');
  assert.ok(refs.every((r) => r.className !== null), 'no method-level ref must appear');
  assert.ok(
    !refs.some((r) => r.methodName === 'legacyReset' || r.methodName === 'supportExt'),
    'legacyReset must never appear as a methodName, whole or split'
  );
}

// 49. Compound expression `{!a && b}` -- same skip as a dotted expression.
{
  const text = '<apex:page controller="AcmeCompoundController"><apex:commandButton action="{!a && b}"/></apex:page>';
  const refs = parseMetaFile({ path: 'pages/AcmeCompoundPage.page', text });
  assert.strictEqual(refs.length, 1, 'only the class-level controller= ref -- compound action= must be skipped');
  assert.strictEqual(refs[0].className, 'AcmeCompoundController');
}

// 50. Empty `{!}` expression -- skipped (not a bare identifier).
{
  const text = '<apex:page controller="AcmeEmptyController"><apex:commandButton action="{!}"/></apex:page>';
  const refs = parseMetaFile({ path: 'pages/AcmeEmptyPage.page', text });
  assert.strictEqual(refs.length, 1, 'empty {!} action= must be skipped, not extracted as an empty-string method');
}

// 51. Whitespace-tolerant single identifier `{! methodName }` -- still
//     extracted, identifier trimmed.
{
  const text = '<apex:page controller="AcmeSpacedController"><apex:commandButton action="{! spacedMethod }"/></apex:page>';
  const refs = parseMetaFile({ path: 'pages/AcmeSpacedPage.page', text });
  const actionRef = refs.find((r) => r.className === null);
  assert.ok(actionRef);
  assert.strictEqual(actionRef.methodName, 'spacedMethod');
}

// 52. value="{!prop}" bindings are OUT OF SCOPE this round -- must never be
//     mistaken for an action= binding, on either the root tag or a child tag.
{
  const text = src([
    '<apex:page controller="AcmeValueController" value="{!somethingIgnored}">',
    '  <apex:outputText value="{!displayLabel}"/>',
    '  <apex:commandButton value="{!buttonLabel}"/>',
    '</apex:page>',
  ]);
  const refs = parseMetaFile({ path: 'pages/AcmeValuePage.page', text });
  assert.strictEqual(refs.length, 1, 'only the class-level controller= ref -- no value= binding is ever extracted');
  assert.strictEqual(refs[0].className, 'AcmeValueController');
}

// 53. Multi-line tag: the action= attribute lands on a DIFFERENT physical
//     line than the tag's own opening `<apex:commandButton` -- the emitted
//     `line` must point at the action= attribute's own line, not the tag's
//     opening line (this is the literal "line numbers correct" requirement
//     for a multi-line tag).
{
  const text = src([
    '<apex:page controller="AcmeMultiLineController">',
    '  <apex:commandButton',
    '      value="Go"',
    '      action="{!doGo}"',
    '      reRender="panel"/>',
    '</apex:page>',
  ]);
  const refs = parseMetaFile({ path: 'pages/AcmeMultiLinePage.page', text });
  const actionRef = refs.find((r) => r.methodName === 'doGo');
  assert.ok(actionRef, 'action= on a multi-line tag must still be found');
  assert.strictEqual(actionRef.line, 4, 'line must be the action= attribute\'s OWN line, not the tag-opening line (2)');
  assert.strictEqual(actionRef.lineText, 'action="{!doGo}"');
}

// 54. Multi-line apex:page ROOT tag whose own action= is on a later line
//     than controller=/extensions= -- same "line points at the attribute,
//     not the tag start" rule applies to the root tag too.
{
  const text = src([
    '<apex:page',
    '    controller="AcmeRootMultiLineController"',
    '    extensions="AcmeRootMultiLineExt"',
    '    action="{!rootInit}">',
    '</apex:page>',
  ]);
  const refs = parseMetaFile({ path: 'pages/AcmeRootMultiLinePage.page', text });
  assert.strictEqual(refs.length, 3, '1 controller + 1 extension (class-level) + 1 action (method-level)');
  const ctrlRef = refs.find((r) => r.className === 'AcmeRootMultiLineController');
  assert.strictEqual(ctrlRef.line, 2, 'class-level controller= ref line -- unaffected by A2, still its own attribute line');
  const extRef = refs.find((r) => r.className === 'AcmeRootMultiLineExt');
  assert.strictEqual(extRef.line, 3);
  const actionRef = refs.find((r) => r.methodName === 'rootInit');
  assert.ok(actionRef);
  assert.strictEqual(actionRef.line, 4, 'root action= line must be its own line (4), not the tag-opening line (1)');
  assert.strictEqual(actionRef.controllerClass, 'AcmeRootMultiLineController');
  assert.deepStrictEqual(actionRef.extensionClasses, ['AcmeRootMultiLineExt']);
}

// 55. `standardController`-only page (no controller=/extensions= at all) --
//     action= bindings are still extracted (metascan does syntactic
//     extraction only, unconditional on whether there's a class to attach
//     to), but with controllerClass:null and extensionClasses:[] -- exactly
//     GROUND-TRUTH.md's v0.10-B3 real-corpus shape
//     (VtxAccountSummaryPage.page's `{!edit}`/`{!save}`).
{
  const text = src([
    '<apex:page standardController="Account">',
    '  <apex:commandButton value="Edit" action="{!edit}"/>',
    '  <apex:commandButton value="Save" action="{!save}"/>',
    '</apex:page>',
  ]);
  const refs = parseMetaFile({ path: 'pages/AcmeStandardControllerPage.page', text });
  assert.strictEqual(refs.length, 2, 'no class-level ref at all (standardController is not controller=), 2 action refs');
  assert.ok(refs.every((r) => r.className === null));
  for (const r of refs) {
    assert.strictEqual(r.controllerClass, null, 'no controller= attribute anywhere on this page');
    assert.deepStrictEqual(r.extensionClasses, [], 'no extensions= attribute anywhere on this page');
  }
  assert.deepStrictEqual(refs.map((r) => r.methodName).sort(), ['edit', 'save']);
}

// 56. apex:component (not apex:page) -- action bindings extracted identically
//     on a component's child tags (apex:component has no `action=` attribute
//     of its own in real Visualforce, and no `extensions=` attribute at all,
//     but the extraction logic must not special-case that away).
{
  const text = src([
    '<apex:component controller="AcmeCompController">',
    '  <apex:commandButton value="Apply" action="{!applyFilter}"/>',
    '  <apex:actionFunction name="clearAll" action="{!clearAll}"/>',
    '</apex:component>',
  ]);
  const refs = parseMetaFile({ path: 'components/AcmeCompComponent.component', text });
  assert.strictEqual(refs.length, 3, '1 class-level controller + 2 method-level action refs');
  const applyRef = refs.find((r) => r.methodName === 'applyFilter');
  assert.ok(applyRef);
  assert.strictEqual(applyRef.controllerClass, 'AcmeCompController');
  assert.deepStrictEqual(applyRef.extensionClasses, []);
  const clearRef = refs.find((r) => r.methodName === 'clearAll');
  assert.ok(clearRef);
  assert.strictEqual(clearRef.line, 3);
}

// 57. Adjacent action tags on the SAME physical line -- the lazy tag regex
//     must not let one tag's match bleed into the next; each gets its own
//     ref at the correct (shared) line.
{
  const text =
    '<apex:page controller="AcmeAdjacentController">' +
    '<apex:commandButton action="{!first}"/>' +
    '<apex:commandButton action="{!second}"/>' +
    '</apex:page>';
  const refs = parseMetaFile({ path: 'pages/AcmeAdjacentPage.page', text });
  const actionRefs = refs.filter((r) => r.className === null);
  assert.strictEqual(actionRefs.length, 2);
  assert.deepStrictEqual(actionRefs.map((r) => r.methodName).sort(), ['first', 'second']);
  assert.ok(actionRefs.every((r) => r.line === 1));
}

// 58. Purity: extensionClasses on each ref is its OWN array copy -- mutating
//     one ref's extensionClasses must never affect a sibling ref's.
{
  const text = src([
    '<apex:page controller="AcmePurityController" extensions="AcmePurityExt">',
    '  <apex:commandButton action="{!methodOne}"/>',
    '  <apex:commandButton action="{!methodTwo}"/>',
    '</apex:page>',
  ]);
  const refs = parseMetaFile({ path: 'pages/AcmePurityPage.page', text });
  const actionRefs = refs.filter((r) => r.className === null);
  assert.strictEqual(actionRefs.length, 2);
  assert.notStrictEqual(
    actionRefs[0].extensionClasses,
    actionRefs[1].extensionClasses,
    'each ref must own a fresh array, not share one mutable reference'
  );
  actionRefs[0].extensionClasses.push('Mutated');
  assert.deepStrictEqual(actionRefs[1].extensionClasses, ['AcmePurityExt'], 'sibling ref must be unaffected by the mutation above');
}

// 59. Defensive: a file with no apex:page/apex:component root tag at all --
//     the WHOLE extractor (class-level AND action-level) yields nothing, and
//     never throws, even though it contains action= look-alikes.
{
  assert.doesNotThrow(() =>
    parseMetaFile({ path: 'pages/AcmeNotVfPage.page', text: '<div action="{!notReal}">not visualforce</div>' })
  );
  assert.deepStrictEqual(
    parseMetaFile({ path: 'pages/AcmeNotVfPage.page', text: '<div action="{!notReal}">not visualforce</div>' }),
    []
  );
}

console.log('metascan.js inline-fixture self-check: all assertions passed');

// ===========================================================================
// v0.13 (S1) — Flow <subflows> extraction: the `subflows` field on 'flow'
// MetaRefs, stamped file-wide onto every apex-actionCalls ref, plus the
// zero-actionCalls synthetic-ref exception (see metascan.js's top-of-file
// v0.13 contract note and extractFlowSubflows()'s own header note for the
// full rationale).
// ===========================================================================

// 60. Basic extraction: one apex actionCalls ref + one <subflows> block ->
//     subflows: [<flowName>] stamped onto the sole ref.
{
  const text = src([
    '<Flow xmlns="http://soap.sforce.com/2006/04/metadata">',
    '    <actionCalls>',
    '        <name>Recalc</name>',
    '        <actionName>AcmeOrderService.recalculatePricing</actionName>',
    '        <actionType>apex</actionType>',
    '    </actionCalls>',
    '    <subflows>',
    '        <name>Notify_Customer</name>',
    '        <flowName>AcmeChildFlow</flowName>',
    '    </subflows>',
    '</Flow>',
  ]);
  const refs = parseMetaFile({ path: 'flows/AcmeParentFlow.flow-meta.xml', text });
  assert.strictEqual(refs.length, 1, 'a <subflows> block does not add its own ref -- it is a field on the existing one');
  assert.deepStrictEqual(refs[0].subflows, ['AcmeChildFlow']);
}

// 60a. Multiple distinct <subflows> blocks -> both names present, in document
//      order.
{
  const text = src([
    '<Flow xmlns="http://soap.sforce.com/2006/04/metadata">',
    '    <actionCalls>',
    '        <actionName>AcmeOrderInvocable</actionName>',
    '        <actionType>apex</actionType>',
    '    </actionCalls>',
    '    <subflows>',
    '        <name>First</name>',
    '        <flowName>AcmeFirstChildFlow</flowName>',
    '    </subflows>',
    '    <subflows>',
    '        <name>Second</name>',
    '        <flowName>AcmeSecondChildFlow</flowName>',
    '    </subflows>',
    '</Flow>',
  ]);
  const refs = parseMetaFile({ path: 'flows/AcmeMultiSubflow.flow-meta.xml', text });
  assert.strictEqual(refs.length, 1);
  assert.deepStrictEqual(refs[0].subflows, ['AcmeFirstChildFlow', 'AcmeSecondChildFlow'], 'document order preserved');
}

// 60b. Two <subflows> blocks naming the SAME child Flow (two branches routing
//      to one shared subflow) -> deduped to a single entry.
{
  const text = src([
    '<Flow xmlns="http://soap.sforce.com/2006/04/metadata">',
    '    <actionCalls>',
    '        <actionName>AcmeOrderInvocable</actionName>',
    '        <actionType>apex</actionType>',
    '    </actionCalls>',
    '    <subflows>',
    '        <name>BranchA</name>',
    '        <flowName>AcmeDupeFlow</flowName>',
    '    </subflows>',
    '    <subflows>',
    '        <name>BranchB</name>',
    '        <flowName>AcmeDupeFlow</flowName>',
    '    </subflows>',
    '</Flow>',
  ]);
  const refs = parseMetaFile({ path: 'flows/AcmeDupeSubflow.flow-meta.xml', text });
  assert.deepStrictEqual(refs[0].subflows, ['AcmeDupeFlow'], 'exact-duplicate flowName must be deduped to one entry');
}

// 60c. Dedup is case-SENSITIVE (documented design decision -- metascan never
//      normalizes case; matching a subflow name to a real flow file by stem,
//      case-insensitively, is resolver.js's job): two differently-cased
//      names are NOT deduped, both survive.
{
  const text = src([
    '<Flow xmlns="http://soap.sforce.com/2006/04/metadata">',
    '    <actionCalls>',
    '        <actionName>AcmeOrderInvocable</actionName>',
    '        <actionType>apex</actionType>',
    '    </actionCalls>',
    '    <subflows>',
    '        <name>BranchA</name>',
    '        <flowName>AcmeCaseFlow</flowName>',
    '    </subflows>',
    '    <subflows>',
    '        <name>BranchB</name>',
    '        <flowName>acmecaseflow</flowName>',
    '    </subflows>',
    '</Flow>',
  ]);
  const refs = parseMetaFile({ path: 'flows/AcmeCaseSubflow.flow-meta.xml', text });
  assert.deepStrictEqual(
    refs[0].subflows,
    ['AcmeCaseFlow', 'acmecaseflow'],
    'dedup is exact-string/case-sensitive -- differently-cased names are distinct entries here'
  );
}

// 60d. Nested-element tolerance: three real-world <subflows> shapes in one
//      file -- (1) <connector> BEFORE and <inputAssignments> AFTER <flowName>,
//      (2) <inputAssignments> only (no connector), (3) bare (neither) --
//      <flowName> must be found regardless of what surrounds it or in what
//      order (matches the exact shapes gauntlet-org's real v0.13 fixtures use
//      -- see GROUND-TRUTH.md's "Nested-element tolerance" note).
{
  const text = src([
    '<Flow xmlns="http://soap.sforce.com/2006/04/metadata">',
    '    <actionCalls>',
    '        <actionName>AcmeOrderInvocable</actionName>',
    '        <actionType>apex</actionType>',
    '    </actionCalls>',
    '    <subflows>',
    '        <name>CallA</name>',
    '        <label>Call A</label>',
    '        <locationX>0</locationX>',
    '        <locationY>150</locationY>',
    '        <connector>',
    '            <targetReference>CallB</targetReference>',
    '        </connector>',
    '        <flowName>AcmeChildA</flowName>',
    '        <inputAssignments>',
    '            <name>recordId</name>',
    '            <value><elementReference>varId</elementReference></value>',
    '        </inputAssignments>',
    '    </subflows>',
    '    <subflows>',
    '        <name>CallB</name>',
    '        <label>Call B</label>',
    '        <flowName>AcmeChildB</flowName>',
    '        <inputAssignments>',
    '            <name>recordId</name>',
    '            <value><elementReference>varId</elementReference></value>',
    '        </inputAssignments>',
    '    </subflows>',
    '    <subflows>',
    '        <name>CallC</name>',
    '        <label>Call C</label>',
    '        <flowName>AcmeChildC</flowName>',
    '    </subflows>',
    '</Flow>',
  ]);
  const refs = parseMetaFile({ path: 'flows/AcmeNestedSubflow.flow-meta.xml', text });
  assert.deepStrictEqual(
    refs[0].subflows,
    ['AcmeChildA', 'AcmeChildB', 'AcmeChildC'],
    'v0.13: <flowName> must be found regardless of connector/inputAssignments presence or order'
  );
}

// 60e. Malformed/placeholder <subflows> block with no <flowName> at all is
//      tolerated (skipped, never throws), same posture every other extractor
//      in this file already takes.
{
  const text = src([
    '<Flow xmlns="http://soap.sforce.com/2006/04/metadata">',
    '    <actionCalls>',
    '        <actionName>AcmeOrderInvocable</actionName>',
    '        <actionType>apex</actionType>',
    '    </actionCalls>',
    '    <subflows>',
    '        <name>Placeholder</name>',
    '        <label>Not Yet Wired</label>',
    '    </subflows>',
    '    <subflows>',
    '        <name>RealOne</name>',
    '        <flowName>AcmeRealChildFlow</flowName>',
    '    </subflows>',
    '</Flow>',
  ]);
  assert.doesNotThrow(() => parseMetaFile({ path: 'flows/AcmeMalformedSubflow.flow-meta.xml', text }));
  const refs = parseMetaFile({ path: 'flows/AcmeMalformedSubflow.flow-meta.xml', text });
  assert.deepStrictEqual(refs[0].subflows, ['AcmeRealChildFlow'], 'the flowName-less block contributes nothing');
}

// 60f. A flow with zero <subflows> blocks anywhere gets subflows: [] on its
//      ref -- explicit regression check alongside the pre-existing tests
//      #14/#16 above, which predate this field.
{
  const text = src([
    '<Flow xmlns="http://soap.sforce.com/2006/04/metadata">',
    '    <actionCalls>',
    '        <actionName>AcmeOrderInvocable</actionName>',
    '        <actionType>apex</actionType>',
    '    </actionCalls>',
    '</Flow>',
  ]);
  const refs = parseMetaFile({ path: 'flows/AcmeNoSubflow.flow-meta.xml', text });
  assert.deepStrictEqual(refs[0].subflows, []);
}

// 60g. Multiple apex actionCalls refs in the same file all carry an IDENTICAL
//      subflows list -- and each ref owns its OWN copy (mutating one must not
//      affect a sibling), same "never hand out data a caller could
//      accidentally corrupt for a sibling ref" posture v0.10-A2 established
//      for extensionClasses (test #58).
{
  const text = src([
    '<Flow xmlns="http://soap.sforce.com/2006/04/metadata">',
    '    <actionCalls>',
    '        <actionName>AcmeFirstInvocable</actionName>',
    '        <actionType>apex</actionType>',
    '    </actionCalls>',
    '    <actionCalls>',
    '        <actionName>AcmeSecondService.doWork</actionName>',
    '        <actionType>apex</actionType>',
    '    </actionCalls>',
    '    <subflows>',
    '        <name>Notify</name>',
    '        <flowName>AcmeSharedChildFlow</flowName>',
    '    </subflows>',
    '</Flow>',
  ]);
  const refs = parseMetaFile({ path: 'flows/AcmeMultiActionSubflow.flow-meta.xml', text });
  assert.strictEqual(refs.length, 2);
  assert.deepStrictEqual(refs[0].subflows, ['AcmeSharedChildFlow']);
  assert.deepStrictEqual(refs[1].subflows, ['AcmeSharedChildFlow']);
  refs[0].subflows.push('Mutated');
  assert.deepStrictEqual(refs[1].subflows, ['AcmeSharedChildFlow'], 'sibling ref must own its own array, unaffected by the mutation above');
}

// 60h. LOAD-BEARING stress case: a flow with >=1 <subflows> reference but
//      ZERO apex <actionCalls> blocks of its own must NOT vanish -- exactly
//      one synthetic ref (className/methodName both null) carries the
//      subflows fact. Mirrors the real gauntlet-org Vtx_FlowChainTop fixture
//      (GROUND-TRUTH.md's "Load-bearing stress case" note) exactly: an
//      autolaunched flow whose <start> has no record-trigger info, whose
//      ONLY content is a <subflows> element.
{
  const text = src([
    '<Flow xmlns="http://soap.sforce.com/2006/04/metadata">',
    '    <start>',
    '        <connector><targetReference>Call_Chain_Mid</targetReference></connector>',
    '    </start>',
    '    <subflows>',
    '        <name>Call_Chain_Mid</name>',
    '        <flowName>AcmeChainMidFlow</flowName>',
    '    </subflows>',
    '</Flow>',
  ]);
  const refs = parseMetaFile({ path: 'flows/AcmeChainTopFlow.flow-meta.xml', text });
  assert.strictEqual(refs.length, 1, 'v0.13 LOAD-BEARING: a zero-apex flow with a <subflows> element must still surface');
  assert.strictEqual(refs[0].kind, 'flow');
  assert.strictEqual(refs[0].label, 'AcmeChainTopFlow');
  assert.strictEqual(refs[0].className, null, 'synthetic ref carries no apex target -- className is null');
  assert.strictEqual(refs[0].methodName, null);
  assert.strictEqual(refs[0].namespace, null);
  assert.deepStrictEqual(refs[0].subflows, ['AcmeChainMidFlow']);
  assert.strictEqual(refs[0].flowObject, null, 'this flow has no record-trigger info at all');
  assert.strictEqual(refs[0].flowRecordTriggerType, null);
  assert.strictEqual(refs[0].flowTriggerType, null);
  assert.strictEqual(refs[0].line, 7, 'line points at the <flowName> element -- the only concrete fact this ref carries');
}

// 60i. A flow with ZERO apex actionCalls AND ZERO subflows produces nothing
//      at all -- unchanged, pre-existing behavior (a pure Screen/Decision-only
//      flow with no apex and no subflow children).
{
  const text = src([
    '<Flow xmlns="http://soap.sforce.com/2006/04/metadata">',
    '    <start>',
    '        <connector><targetReference>Foo</targetReference></connector>',
    '    </start>',
    '</Flow>',
  ]);
  assert.deepStrictEqual(parseMetaFile({ path: 'flows/AcmePureScreenFlow.flow-meta.xml', text }), []);
}

// 60j. The zero-apex synthetic-ref gate is keyed on APEX refs specifically,
//      not "any actionCalls block": a non-apex actionType (emailSimple) does
//      not count, so a flow with only an emailSimple action plus a <subflows>
//      element still gets the synthetic ref.
{
  const text = src([
    '<Flow xmlns="http://soap.sforce.com/2006/04/metadata">',
    '    <actionCalls>',
    '        <name>Send_Email</name>',
    '        <actionName>emailSimple</actionName>',
    '        <actionType>emailSimple</actionType>',
    '    </actionCalls>',
    '    <subflows>',
    '        <name>Notify</name>',
    '        <flowName>AcmeEmailThenSubflow</flowName>',
    '    </subflows>',
    '</Flow>',
  ]);
  const refs = parseMetaFile({ path: 'flows/AcmeEmailSubflow.flow-meta.xml', text });
  assert.strictEqual(refs.length, 1, 'the emailSimple action never counts as an apex ref -- the synthetic-ref gate still fires');
  assert.strictEqual(refs[0].className, null);
  assert.deepStrictEqual(refs[0].subflows, ['AcmeEmailThenSubflow']);
}

// 60k. The synthetic ref also carries real <start> record-trigger info when
//      present -- flowObject/flowRecordTriggerType/flowTriggerType are NOT
//      hardcoded to null on this shape, they come from the same
//      extractFlowStart() file-level fact every other ref uses.
{
  const text = src([
    '<Flow xmlns="http://soap.sforce.com/2006/04/metadata">',
    '    <start>',
    '        <connector><targetReference>Notify</targetReference></connector>',
    '        <object>Acme_Widget__c</object>',
    '        <recordTriggerType>Create</recordTriggerType>',
    '        <triggerType>RecordAfterSave</triggerType>',
    '    </start>',
    '    <subflows>',
    '        <name>Notify</name>',
    '        <flowName>AcmeWidgetNotifySubflow</flowName>',
    '    </subflows>',
    '</Flow>',
  ]);
  const refs = parseMetaFile({ path: 'flows/AcmeWidgetParentFlow.flow-meta.xml', text });
  assert.strictEqual(refs.length, 1);
  assert.strictEqual(refs[0].flowObject, 'Acme_Widget__c');
  assert.strictEqual(refs[0].flowRecordTriggerType, 'Create');
  assert.strictEqual(refs[0].flowTriggerType, 'RecordAfterSave');
  assert.deepStrictEqual(refs[0].subflows, ['AcmeWidgetNotifySubflow']);
}

console.log('metascan.js v0.13 subflow-extraction inline self-check: all assertions passed');

// ===========================================================================
// REAL CORPUS PASS — test-fixtures/adv-org (read-only)
// Asserts the exact refs MANIFEST.md's "UI / metadata callers" ground-truth
// section promises: LWC class.method pairs, dotted + bare Flow actionNames,
// Aura controller pairs (class-level + method-level), and every
// remoteClass/remoteMethod pair (os-meta.xml + DataPack JSON).
// ===========================================================================

const CORPUS_ROOT = 'test-fixtures/adv-org/force-app/main/default';

function readCorpus(relPath) {
  const p = path.join(CORPUS_ROOT, relPath);
  return { path: p, text: fs.readFileSync(p, 'utf8') };
}

function findRef(refs, className, methodName) {
  return refs.find((r) => r.className === className && r.methodName === methodName);
}

if (!fs.existsSync(CORPUS_ROOT)) {
  throw new Error('adv-org corpus not found at ' + CORPUS_ROOT + ' -- test-metascan.js requires it (read-only).');
}

const t0 = Date.now();

// --- LWC ---------------------------------------------------------------
{
  const dashboard = parseMetaFile(readCorpus('lwc/acmeOrderDashboard/acmeOrderDashboard.js'));
  assert.strictEqual(dashboard.length, 1);
  assert.ok(findRef(dashboard, 'AcmeQuoteAuraService', 'getRecentQuotes'), 'acmeOrderDashboard.js -> AcmeQuoteAuraService.getRecentQuotes');

  const wizard = parseMetaFile(readCorpus('lwc/acmeQuoteWizard/acmeQuoteWizard.js'));
  assert.strictEqual(wizard.length, 1);
  assert.ok(findRef(wizard, 'AcmeQuoteAuraService', 'createQuote'), 'acmeQuoteWizard.js -> AcmeQuoteAuraService.createQuote');

  const invoiceViewer = parseMetaFile(readCorpus('lwc/acmeInvoiceViewer/acmeInvoiceViewer.js'));
  assert.strictEqual(invoiceViewer.length, 2);
  assert.ok(findRef(invoiceViewer, 'AcmeQuoteAuraService', 'getInvoiceSummary'));
  assert.ok(findRef(invoiceViewer, 'AcmeQuoteAuraService', 'recalculateInvoice'));

  const shipmentTracker = parseMetaFile(readCorpus('lwc/acmeShipmentTracker/acmeShipmentTracker.js'));
  assert.strictEqual(shipmentTracker.length, 2);
  assert.ok(findRef(shipmentTracker, 'AcmeShipmentAuraService', 'getShipmentStatuses'));
  assert.ok(findRef(shipmentTracker, 'AcmeShipmentAuraService', 'refreshTracking'));

  // MANIFEST: "lwc/acmeQuoteWizard/__tests__/acmeQuoteWizard.test.js -- no Apex edges (Jest unit test)"
  const jestSpec = parseMetaFile(readCorpus('lwc/acmeQuoteWizard/__tests__/acmeQuoteWizard.test.js'));
  assert.deepStrictEqual(jestSpec, [], 'the __tests__ jest mock must yield NO refs');
}

// --- Aura (scanBundle, both bundles together) ---------------------------
{
  const auraFiles = [
    readCorpus('aura/AcmeOrderApprovalPanel/AcmeOrderApprovalPanel.cmp'),
    readCorpus('aura/AcmeOrderApprovalPanel/AcmeOrderApprovalPanelController.js'),
    readCorpus('aura/AcmeShipmentStatusBoard/AcmeShipmentStatusBoard.cmp'),
    readCorpus('aura/AcmeShipmentStatusBoard/AcmeShipmentStatusBoardController.js'),
  ];
  const refs = scanBundle(auraFiles);
  assert.strictEqual(refs.length, 4, '2 bundles x (1 class-level + 1 method-level) = 4');

  assert.ok(
    findRef(refs, 'AcmeOrderApprovalController', null),
    'AcmeOrderApprovalPanel.cmp -> AcmeOrderApprovalController (controller= attribute)'
  );
  assert.ok(
    findRef(refs, 'AcmeOrderApprovalController', 'approveOrder'),
    "AcmeOrderApprovalPanelController.js -> AcmeOrderApprovalController.approveOrder (component.get('c.approveOrder'))"
  );
  assert.ok(
    findRef(refs, 'AcmeShipmentAuraService', null),
    'AcmeShipmentStatusBoard.cmp -> AcmeShipmentAuraService (controller= attribute)'
  );
  assert.ok(
    findRef(refs, 'AcmeShipmentAuraService', 'getShipmentStatuses'),
    "AcmeShipmentStatusBoardController.js -> AcmeShipmentAuraService.getShipmentStatuses (component.get('c.getShipmentStatuses'))"
  );
}

// --- Flow ----------------------------------------------------------------
{
  const quoteApproval = parseMetaFile(readCorpus('flows/AcmeQuoteApprovalScreenFlow.flow-meta.xml'));
  assert.strictEqual(quoteApproval.length, 1);
  assert.ok(
    findRef(quoteApproval, 'AcmeDiscountApprovalInvocable', null),
    'AcmeQuoteApprovalScreenFlow -> AcmeDiscountApprovalInvocable (bare actionName, class-only)'
  );
  assert.strictEqual(quoteApproval[0].flowObject, null, 'screen flow -- not record-triggered');
  assert.strictEqual(quoteApproval[0].flowRecordTriggerType, null);

  const orderStatus = parseMetaFile(readCorpus('flows/AcmeOrderStatusRecordTriggeredFlow.flow-meta.xml'));
  assert.strictEqual(orderStatus.length, 1);
  assert.ok(
    findRef(orderStatus, 'AcmeOrderService', 'recalculatePricing'),
    'AcmeOrderStatusRecordTriggeredFlow -> AcmeOrderService.recalculatePricing (dotted actionName)'
  );
  assert.strictEqual(orderStatus[0].flowObject, 'Acme_Order__c', 'F1(b): <start><object> extracted');
  assert.strictEqual(orderStatus[0].flowRecordTriggerType, 'Update', 'F1(b): <start><recordTriggerType> extracted');

  const backorder = parseMetaFile(readCorpus('flows/AcmeBackorderResolutionFlow.flow-meta.xml'));
  assert.strictEqual(backorder.length, 1, 'only the apex actionCalls block -- the subflow is not an Apex ref');
  assert.ok(
    findRef(backorder, 'AcmeOrderInvocable', null),
    'AcmeBackorderResolutionFlow -> AcmeOrderInvocable (bare actionName, class-only)'
  );
  assert.strictEqual(backorder[0].flowObject, null, 'autolaunched, not record-triggered');
  assert.strictEqual(backorder[0].flowRecordTriggerType, null);

  const subflow = parseMetaFile(readCorpus('flows/AcmeNotifyCustomerSubflow.flow-meta.xml'));
  assert.deepStrictEqual(subflow, [], 'AcmeNotifyCustomerSubflow only has an emailSimple action, no apex actionCalls');

  // v0.4 (F1b): new record-triggered flow, RecordAfterSave/Create on Acme_Order__c.
  const welcomeFlow = parseMetaFile(readCorpus('flows/AcmeOrderCreatedWelcomeFlow.flow-meta.xml'));
  assert.strictEqual(welcomeFlow.length, 1);
  assert.ok(
    findRef(welcomeFlow, 'AcmeOrderInvocable', null),
    'AcmeOrderCreatedWelcomeFlow -> AcmeOrderInvocable (bare actionName, class-only)'
  );
  assert.strictEqual(welcomeFlow[0].flowObject, 'Acme_Order__c');
  assert.strictEqual(welcomeFlow[0].flowRecordTriggerType, 'Create');

  // v0.5 (G1(b)): new platform-event flow, triggerType=PlatformEvent on
  // Acme_Note__e -- MANIFEST.md "G1(b): platform-event flow -> publish
  // children" fixture.
  const noteEventFlow = parseMetaFile(readCorpus('flows/AcmeNoteEventFlow.flow-meta.xml'));
  assert.strictEqual(noteEventFlow.length, 1);
  assert.ok(
    findRef(noteEventFlow, 'AcmeOrderInvocable', null),
    'AcmeNoteEventFlow -> AcmeOrderInvocable (bare actionName, class-only) -- MANIFEST\'s "Informational" pre-existing-gap edge'
  );
  assert.strictEqual(noteEventFlow[0].flowObject, 'Acme_Note__e', 'G1(b): platform-event <start><object> extracted');
  assert.strictEqual(
    noteEventFlow[0].flowRecordTriggerType,
    null,
    'platform-event <start> has no <recordTriggerType> element'
  );
  assert.strictEqual(noteEventFlow[0].flowTriggerType, 'PlatformEvent', 'G1(b): <start><triggerType> captured verbatim');
}

// v0.13 (S1): the real adv-org AcmeBackorderResolutionFlow -> AcmeNotifyCustomerSubflow
// reference -- the historically-invisible flow-to-flow edge this whole round
// exists to surface. metascan's own contribution: the subflows field on the
// existing ref (ref COUNT is unchanged -- see the pre-existing assertion
// above, `backorder.length === 1`).
{
  const backorder = parseMetaFile(readCorpus('flows/AcmeBackorderResolutionFlow.flow-meta.xml'));
  assert.deepStrictEqual(
    backorder[0].subflows,
    ['AcmeNotifyCustomerSubflow'],
    'v0.13: the real AcmeBackorderResolutionFlow -> AcmeNotifyCustomerSubflow subflow reference must be captured'
  );

  // None of the OTHER adv-org flow fixtures have a <subflows> element at all
  // (confirmed via corpus grep) -- every one of them must get subflows: []
  // on its ref(s), byte-identical in every other respect (regression).
  const quoteApproval = parseMetaFile(readCorpus('flows/AcmeQuoteApprovalScreenFlow.flow-meta.xml'));
  assert.deepStrictEqual(quoteApproval[0].subflows, []);
  const orderStatus = parseMetaFile(readCorpus('flows/AcmeOrderStatusRecordTriggeredFlow.flow-meta.xml'));
  assert.deepStrictEqual(orderStatus[0].subflows, []);
  const welcomeFlow = parseMetaFile(readCorpus('flows/AcmeOrderCreatedWelcomeFlow.flow-meta.xml'));
  assert.deepStrictEqual(welcomeFlow[0].subflows, []);
  const noteEventFlow = parseMetaFile(readCorpus('flows/AcmeNoteEventFlow.flow-meta.xml'));
  assert.deepStrictEqual(noteEventFlow[0].subflows, []);

  // AcmeNotifyCustomerSubflow itself has zero apex actionCalls AND zero of
  // its OWN <subflows> elements -- stays [] entirely (regression: the
  // pre-existing `assert.deepStrictEqual(subflow, [])` above already pins
  // this; the zero-apex synthetic-ref exception does not fire here because
  // subflows.length is also 0 for this file).
  const notifySubflow = parseMetaFile(readCorpus('flows/AcmeNotifyCustomerSubflow.flow-meta.xml'));
  assert.deepStrictEqual(notifySubflow, [], 'v0.13 regression: no <subflows> element in this file -- must stay []');
}

// --- Custom Metadata (F4b) ------------------------------------------------
{
  const orderHandler = parseMetaFile(readCorpus('customMetadata/Acme_Integration_Config.Order_Sync_Handler.md-meta.xml'));
  assert.strictEqual(orderHandler.length, 1);
  assert.strictEqual(orderHandler[0].kind, 'cmdt');
  assert.strictEqual(orderHandler[0].className, 'AcmeOrderService');
  assert.strictEqual(orderHandler[0].fieldName, 'Handler_Class__c');

  const shipmentHandler = parseMetaFile(
    readCorpus('customMetadata/Acme_Integration_Config.Shipment_Sync_Handler.md-meta.xml')
  );
  assert.strictEqual(shipmentHandler.length, 1);
  assert.strictEqual(shipmentHandler[0].className, 'AcmeShipmentService');

  // Negative case: names no real class anywhere in the org -- metascan still
  // extracts it (identifier-shaped), resolver.js is the one that finds no match.
  const legacyHandler = parseMetaFile(
    readCorpus('customMetadata/Acme_Integration_Config.Legacy_Sync_Handler.md-meta.xml')
  );
  assert.strictEqual(legacyHandler.length, 1);
  assert.strictEqual(legacyHandler[0].className, 'AcmeLegacyHandlerRemoved');
}

// --- OmniScript ------------------------------------------------------------
{
  const shipmentOs = parseMetaFile(readCorpus('omniscripts/AcmeShipmentOmniScript.os-meta.xml'));
  assert.strictEqual(shipmentOs.length, 1);
  assert.ok(
    findRef(shipmentOs, 'AcmeShipmentAuraService', 'refreshTracking'),
    'AcmeShipmentOmniScript.os-meta.xml -> AcmeShipmentAuraService.refreshTracking'
  );

  const quoteDataPack = parseMetaFile(readCorpus('omniscripts/AcmeQuoteOmniScript/AcmeQuoteOmniScript_DataPack.json'));
  assert.strictEqual(quoteDataPack.length, 2);
  assert.ok(findRef(quoteDataPack, 'AcmeQuoteAuraService', 'createQuote'));
  assert.ok(findRef(quoteDataPack, 'AcmeQuoteAuraService', 'getInvoiceSummary'));

  const orderIpDataPack = parseMetaFile(
    readCorpus('omniscripts/AcmeOrderIntegrationProcedure/AcmeOrderIntegrationProcedure_DataPack.json')
  );
  assert.strictEqual(orderIpDataPack.length, 2);
  assert.ok(findRef(orderIpDataPack, 'AcmeOrderService', 'recalculatePricing'));
  assert.ok(findRef(orderIpDataPack, 'AcmeShipmentService', 'scheduleDelivery'));
}

// --- tally cross-check: 6 LWC + 4 Aura + 3 Flow (Apex-bearing) + 5 OmniScript = 18
{
  const lwcCount =
    parseMetaFile(readCorpus('lwc/acmeOrderDashboard/acmeOrderDashboard.js')).length +
    parseMetaFile(readCorpus('lwc/acmeQuoteWizard/acmeQuoteWizard.js')).length +
    parseMetaFile(readCorpus('lwc/acmeInvoiceViewer/acmeInvoiceViewer.js')).length +
    parseMetaFile(readCorpus('lwc/acmeShipmentTracker/acmeShipmentTracker.js')).length;
  assert.strictEqual(lwcCount, 6);

  const auraCount = scanBundle([
    readCorpus('aura/AcmeOrderApprovalPanel/AcmeOrderApprovalPanel.cmp'),
    readCorpus('aura/AcmeOrderApprovalPanel/AcmeOrderApprovalPanelController.js'),
    readCorpus('aura/AcmeShipmentStatusBoard/AcmeShipmentStatusBoard.cmp'),
    readCorpus('aura/AcmeShipmentStatusBoard/AcmeShipmentStatusBoardController.js'),
  ]).length;
  assert.strictEqual(auraCount, 4);

  const flowCount =
    parseMetaFile(readCorpus('flows/AcmeQuoteApprovalScreenFlow.flow-meta.xml')).length +
    parseMetaFile(readCorpus('flows/AcmeOrderStatusRecordTriggeredFlow.flow-meta.xml')).length +
    parseMetaFile(readCorpus('flows/AcmeBackorderResolutionFlow.flow-meta.xml')).length +
    parseMetaFile(readCorpus('flows/AcmeNotifyCustomerSubflow.flow-meta.xml')).length;
  assert.strictEqual(flowCount, 3, 'the 3 apex actionCalls edges (subflow-to-flow is out of scope)');

  const omniCount =
    parseMetaFile(readCorpus('omniscripts/AcmeShipmentOmniScript.os-meta.xml')).length +
    parseMetaFile(readCorpus('omniscripts/AcmeQuoteOmniScript/AcmeQuoteOmniScript_DataPack.json')).length +
    parseMetaFile(readCorpus('omniscripts/AcmeOrderIntegrationProcedure/AcmeOrderIntegrationProcedure_DataPack.json'))
      .length;
  assert.strictEqual(omniCount, 5, 'matches MANIFEST.md\'s needs:omniscript tally of 5');
}

const elapsedMs = Date.now() - t0;
assert.ok(elapsedMs < 300, `metascan over the adv-org corpus must stay under 300ms (took ${elapsedMs}ms)`);

console.log(
  `metascan.js real-corpus self-check: all assertions passed (adv-org metadata scan: ${elapsedMs}ms)`
);

// ===========================================================================
// GAUNTLET-ORG REGRESSION PASS -- example-data/
// gauntlet-org (read-only). Pins VALIDATION-REPORT.md Tier-1 #1 / Ranked
// backlog #4 as a named regression: parseMetaFile() on the real
// kappaGatewayPanel LWC bundle must retain the 'zenq' namespace segment of
// `@salesforce/apex/zenq.KappaGateway.dispatch` instead of silently
// discarding it. This test only exercises metascan.js's OWN output (the
// extraction half of M1/M2) -- it deliberately does NOT call
// resolver.js's attachMetaCallers(), which implements the actual M2
// candidate-count gate and is out of scope for this file/owner; that gate is
// pinned as its own regression in test-resolver.js.
// ===========================================================================

const GAUNTLET_ROOT = 'test-fixtures/gauntlet-org/force-app/main/default';

function readGauntlet(relPath) {
  const p = path.join(GAUNTLET_ROOT, relPath);
  return { path: p, text: fs.readFileSync(p, 'utf8') };
}

if (!fs.existsSync(GAUNTLET_ROOT)) {
  throw new Error(
    'gauntlet-org corpus not found at ' + GAUNTLET_ROOT + ' -- test-metascan.js requires it (read-only).'
  );
}

// GAUNTLET Tier-1 #1 (VALIDATION-REPORT.md): "attachMetaCallers() /
// metascan.js: LWC -> namespaced-Apex import collapses onto an unrelated
// local class, ZERO uniqueness gating". Repro: kappaGatewayPanel.js imports
// `@salesforce/apex/zenq.KappaGateway.dispatch`; the corpus ALSO has an
// unrelated local class classes/KappaGateway.cls with its own `dispatch`
// method -- the exact same-bare-name collision the bug exploited. This test
// pins that metascan.js's extraction now hands the resolver everything it
// needs to decline that attach: a non-null `namespace` field.
{
  const refs = parseMetaFile(readGauntlet('lwc/kappaGatewayPanel/kappaGatewayPanel.js'));
  assert.strictEqual(refs.length, 1, 'GAUNTLET Tier-1 #1: exactly one LWC import ref');
  assert.strictEqual(refs[0].kind, 'lwc');
  assert.strictEqual(refs[0].label, 'kappaGatewayPanel');
  assert.strictEqual(refs[0].className, 'KappaGateway', 'bare className unchanged -- still last-but-one segment');
  assert.strictEqual(refs[0].methodName, 'dispatch');
  assert.strictEqual(
    refs[0].namespace,
    'zenq',
    "GAUNTLET Tier-1 #1: 'zenq' namespace segment must be retained, not discarded (M1 fix)"
  );
  assert.ok(
    /zenq\.KappaGateway\.dispatch/.test(refs[0].lineText),
    'lineText must show the real namespaced specifier verbatim'
  );
}

// ===========================================================================
// v0.8-A5/B5 GAUNTLET-ORG REGRESSION -- real corpus fixtures for N1(c)'s
// metascan half. Cross-checks that an Apex call site (KappaGatewayCaller.cls,
// out of scope here -- resolver-owned), the LWC import above, a Flow
// actionName, and a CMDT value ALL land on the same (namespace, className)
// pair for the two shared namespace probes ('zenq'+'KappaGateway',
// 'kwx'+'PostLedgerEntry') -- the three/two-surface consistency check
// GROUND-TRUTH.md's v0.8-A5/B5 sections document. This test only exercises
// metascan.js's OWN extraction; attachMetaCallers() actually routing these
// to a shared external node is resolver.js's job, out of scope here.
// ===========================================================================

// v0.8-B5: the real Vtx_Namespace_Probe_Flow.flow-meta.xml fixture --
// 'zenq.KappaGateway.dispatch' (dotted) must land on the exact same
// (namespace, className, methodName) triple as the LWC probe above, and
// 'kwx__PostLedgerEntry' (bare) must be split.
{
  const refs = parseMetaFile(readGauntlet('flows/Vtx_Namespace_Probe_Flow.flow-meta.xml'));
  assert.strictEqual(refs.length, 2, 'v0.8-B5: exactly 2 apex actionCalls in the real Flow fixture');

  const dotted = refs.find((r) => r.namespace === 'zenq');
  assert.ok(dotted, 'v0.8-B5: the zenq-namespaced actionCall must be present');
  assert.strictEqual(dotted.className, 'KappaGateway');
  assert.strictEqual(dotted.methodName, 'dispatch');
  assert.strictEqual(
    dotted.className,
    'KappaGateway',
    'v0.8-A5/B5 cross-surface check: Flow must land on the SAME className as the LWC probe (zenq.KappaGateway)'
  );

  const bare = refs.find((r) => r.namespace === 'kwx');
  assert.ok(bare, 'v0.8-B5: the kwx-namespaced bare actionCall must be present');
  assert.strictEqual(bare.className, 'PostLedgerEntry');
  assert.strictEqual(bare.methodName, null, 'bare ns__Class actionName is class-only');

  assert.ok(refs.every((r) => r.flowObject === 'Vertex_Order__c'), 'F1(b) flowObject fields untouched by this amendment');
}

// v0.8-B5: the real Kappa_Trigger_Config.Namespace_Handler.md-meta.xml CMDT
// record -- 'kwx__PostLedgerEntry' must split to the SAME (namespace,
// className) pair the Flow's bare actionCall (above) produces, a second
// cross-surface (Flow+CMDT) consistency check on one shared external node.
{
  const refs = parseMetaFile(readGauntlet('customMetadata/Kappa_Trigger_Config.Namespace_Handler.md-meta.xml'));
  const handler = refs.find((r) => r.fieldName === 'Handler_Class_Name__c');
  assert.ok(handler, 'v0.8-B5: the Handler_Class_Name__c value must be extracted');
  assert.strictEqual(handler.className, 'PostLedgerEntry');
  assert.strictEqual(handler.namespace, 'kwx', 'v0.8-B5: CMDT value must carry the namespace field');

  // The pre-existing SobjectApiName__c value ('Kappa_Order__c') is an
  // object-API-name-style decoy sitting in the SAME record -- must not be
  // misread as a namespace token (see the inline test #31 for the isolated
  // case; this is its real-corpus instance).
  const decoy = refs.find((r) => r.fieldName === 'SobjectApiName__c');
  assert.ok(decoy, 'the pre-existing SobjectApiName__c value is still extracted (identifier-shaped)');
  assert.strictEqual(decoy.className, 'Kappa_Order__c');
  assert.strictEqual(decoy.namespace, null, "real-corpus 'Kappa_Order__c' decoy must not be split as a namespace");
}

// v0.8: the pre-existing Kappa_Trigger_Config.Order_Handler.md-meta.xml
// record (LOCAL, non-namespaced control) must be completely unaffected by
// this amendment -- same class, same shape, namespace null.
{
  const refs = parseMetaFile(readGauntlet('customMetadata/Kappa_Trigger_Config.Order_Handler.md-meta.xml'));
  const handler = refs.find((r) => r.fieldName === 'Handler_Class_Name__c');
  assert.ok(handler);
  assert.strictEqual(handler.className, 'KappaOrderTriggerHandler');
  assert.strictEqual(handler.namespace, null, 'pre-existing LOCAL control record unaffected by v0.8');
}

console.log('metascan.js gauntlet-org regression self-check: all assertions passed (M1: namespace retained)');

// ===========================================================================
// v0.10-B GAUNTLET-ORG REAL-CORPUS PASS -- Visualforce ACTION-binding
// extraction (A2), asserting the EXACT refs GROUND-TRUTH.md's "v0.10-B.
// Visualforce method-level action bindings" section (B1-B4) promises for the
// four real .page/.component fixtures. Metascan-only: className is always
// null on the method-level shape and controllerClass/extensionClasses are
// asserted alongside it, but WHICH class a method actually attaches to is
// resolver.js's job (out of scope here, pinned separately in
// test-resolver.js once that phase lands).
// ===========================================================================

function methodRefsOf(refs) {
  return refs.filter((r) => r.className === null);
}

// v0.10-B1: pages/VtxCatalogPage.page -- controller= + one extensions=;
// covers ALL FIVE B1 shapes: page-root action, extension-only action,
// ambiguous (declared on both) action, "matches no class" action, and the
// dotted (skipped) actionSupport expression.
{
  const refs = parseMetaFile(readGauntlet('pages/VtxCatalogPage.page'));
  assert.strictEqual(refs.length, 6, 'v0.10-B1: 2 class-level (controller+extension) + 4 method-level action refs');

  const controllerRef = refs.find((r) => r.className === 'VtxCatalogController');
  assert.ok(controllerRef, 'v0.10-B1: class-level controller= ref must be untouched by A2');
  assert.strictEqual(controllerRef.methodName, null);
  assert.strictEqual(controllerRef.line, 1);

  const extRef = refs.find((r) => r.className === 'VtxCatalogFilterExtension');
  assert.ok(extRef, 'v0.10-B1: class-level extensions= ref must be untouched by A2');
  assert.strictEqual(extRef.methodName, null);
  assert.strictEqual(extRef.line, 1);

  const methodRefs = methodRefsOf(refs);
  assert.strictEqual(methodRefs.length, 4);
  for (const r of methodRefs) {
    assert.strictEqual(r.kind, 'vf');
    assert.strictEqual(r.className, null);
    assert.strictEqual(r.label, 'VtxCatalogPage');
    assert.strictEqual(r.controllerClass, 'VtxCatalogController', 'v0.10-B1: controllerClass carried on every action ref');
    assert.deepStrictEqual(
      r.extensionClasses,
      ['VtxCatalogFilterExtension'],
      'v0.10-B1: extensionClasses carried on every action ref'
    );
  }

  // L1: apex:page root action="{!initCatalog}"
  const initCatalog = methodRefs.find((r) => r.methodName === 'initCatalog');
  assert.ok(initCatalog, 'v0.10-B1 L1: apex:page root action= must be extracted');
  assert.strictEqual(initCatalog.line, 1);

  // L6: apex:commandButton action="{!refreshResults}" -- declared on the
  // EXTENSION only (not the controller); metascan doesn't know or care which
  // class declares it -- it just extracts the raw binding.
  const refreshResults = methodRefs.find((r) => r.methodName === 'refreshResults');
  assert.ok(refreshResults, 'v0.10-B1 L6: extension-only action= must be extracted');
  assert.strictEqual(refreshResults.line, 6);

  // L7: apex:commandButton action="{!resetAll}" -- declared on BOTH
  // controller and extension (ambiguous, bonus case); metascan extracts it
  // identically either way, disambiguation is resolver-side.
  const resetAll = methodRefs.find((r) => r.methodName === 'resetAll');
  assert.ok(resetAll, 'v0.10-B1 L7: ambiguous (declared-on-both) action= must be extracted');
  assert.strictEqual(resetAll.line, 7);

  // L13: apex:actionFunction action="{!vanishedSortHandler}" -- matches NO
  // declaring class; metascan extracts it anyway (it has no class index),
  // resolver.js is what finds zero matches.
  const vanishedSortHandler = methodRefs.find((r) => r.methodName === 'vanishedSortHandler');
  assert.ok(vanishedSortHandler, 'v0.10-B1 L13: "matches no class" action= must still be extracted by metascan');
  assert.strictEqual(vanishedSortHandler.line, 13);

  // L14: apex:actionSupport action="{!filterExt.legacyReset}" -- DOTTED, not
  // a single identifier -- must be SKIPPED entirely, no MetaRef at all.
  assert.ok(
    !refs.some((r) => r.methodName === 'legacyReset' || r.methodName === 'filterExt'),
    'v0.10-B1 L14: dotted {!filterExt.legacyReset} must never appear as a methodName, whole or split'
  );

  // L10: apex:outputText value="{!statusLabel}" -- value=, not action=, must
  // never be extracted.
  assert.ok(!refs.some((r) => r.methodName === 'statusLabel'), 'v0.10-B1 L10: value= binding must never be extracted');
}

// v0.10-B2: pages/VtxOrderHistoryPage.page -- clean contrast page, one
// controller, no extensions, no traps.
{
  const refs = parseMetaFile(readGauntlet('pages/VtxOrderHistoryPage.page'));
  assert.strictEqual(refs.length, 4, 'v0.10-B2: 1 class-level controller + 3 method-level action refs');

  const controllerRef = refs.find((r) => r.className === 'VtxOrderHistoryController');
  assert.ok(controllerRef);
  assert.strictEqual(controllerRef.methodName, null);

  const methodRefs = methodRefsOf(refs);
  assert.strictEqual(methodRefs.length, 3);
  assert.deepStrictEqual(
    methodRefs.map((r) => r.methodName).sort(),
    ['exportHistory', 'refreshStatus', 'retryFailedSync']
  );
  for (const r of methodRefs) {
    assert.strictEqual(r.controllerClass, 'VtxOrderHistoryController');
    assert.deepStrictEqual(r.extensionClasses, [], 'v0.10-B2: no extensions= on this page at all');
  }

  const exportHistory = methodRefs.find((r) => r.methodName === 'exportHistory');
  assert.strictEqual(exportHistory.line, 6, 'v0.10-B2 L6: apex:commandButton action=');
  const retryFailedSync = methodRefs.find((r) => r.methodName === 'retryFailedSync');
  assert.strictEqual(retryFailedSync.line, 7, 'v0.10-B2 L7: apex:commandLink action=');
  const refreshStatus = methodRefs.find((r) => r.methodName === 'refreshStatus');
  assert.strictEqual(refreshStatus.line, 11, 'v0.10-B2 L11: apex:actionPoller action=');

  // L9: apex:outputText value="{!lastSyncedLabel}" -- must never be extracted.
  assert.ok(
    !refs.some((r) => r.methodName === 'lastSyncedLabel'),
    'v0.10-B2 L9: value= binding must never be extracted'
  );
}

// v0.10-B3: pages/VtxAccountSummaryPage.page -- standardController="Account"
// ONLY, no controller=/extensions= at all -- the literal "no class list to
// attach to" case. Metascan still extracts both action= bindings
// syntactically (it has no class index and does not pre-judge
// attachability), but controllerClass/extensionClasses are null/[] on both,
// which is what lets the (out-of-scope) resolver decide there is no edge.
{
  const refs = parseMetaFile(readGauntlet('pages/VtxAccountSummaryPage.page'));
  assert.strictEqual(
    refs.length,
    2,
    'v0.10-B3: ZERO class-level refs (standardController is not controller=/extensions=) + 2 method-level action refs'
  );
  assert.ok(refs.every((r) => r.className === null), 'v0.10-B3: no class-level ref at all on this page');
  for (const r of refs) {
    assert.strictEqual(r.controllerClass, null, 'v0.10-B3: no controller= attribute exists on this page');
    assert.deepStrictEqual(r.extensionClasses, [], 'v0.10-B3: no extensions= attribute exists on this page');
  }
  assert.deepStrictEqual(refs.map((r) => r.methodName).sort(), ['edit', 'save']);
  const editRef = refs.find((r) => r.methodName === 'edit');
  assert.strictEqual(editRef.line, 6);
  const saveRef = refs.find((r) => r.methodName === 'save');
  assert.strictEqual(saveRef.line, 7);
}

// v0.10-B4: components/VtxFilterPanel.component -- apex:component controller=,
// no extensions= attribute possible at all (apex:component doesn't support
// one) -- confirms A2 applies identically to .component, not just .page.
{
  const refs = parseMetaFile(readGauntlet('components/VtxFilterPanel.component'));
  assert.strictEqual(refs.length, 3, 'v0.10-B4: 1 class-level controller + 2 method-level action refs');

  const controllerRef = refs.find((r) => r.className === 'VtxFilterPanelController');
  assert.ok(controllerRef);

  const methodRefs = methodRefsOf(refs);
  assert.strictEqual(methodRefs.length, 2);
  for (const r of methodRefs) {
    assert.strictEqual(r.controllerClass, 'VtxFilterPanelController');
    assert.deepStrictEqual(r.extensionClasses, [], 'apex:component has no extensions= attribute at all');
  }

  const applyFilter = methodRefs.find((r) => r.methodName === 'applyFilter');
  assert.strictEqual(applyFilter.line, 5, 'v0.10-B4 L5: apex:commandButton action=');
  const clearFilters = methodRefs.find((r) => r.methodName === 'clearFilters');
  assert.strictEqual(clearFilters.line, 6, 'v0.10-B4 L6: apex:actionFunction action=');
}

// v0.10-D tally cross-check: 6 + 4 + 2 + 3 = 15 total refs across the 4 new
// VF fixtures (matches the per-file counts asserted individually above).
{
  const total =
    parseMetaFile(readGauntlet('pages/VtxCatalogPage.page')).length +
    parseMetaFile(readGauntlet('pages/VtxOrderHistoryPage.page')).length +
    parseMetaFile(readGauntlet('pages/VtxAccountSummaryPage.page')).length +
    parseMetaFile(readGauntlet('components/VtxFilterPanel.component')).length;
  assert.strictEqual(total, 15, 'v0.10-B: 6 + 4 + 2 + 3 = 15 refs across the 4 new gauntlet-org VF fixtures');
}

console.log('metascan.js v0.10-B gauntlet-org VF regression self-check: all assertions passed (A2: action bindings)');

// ===========================================================================
// v0.13 (S1) GAUNTLET-ORG REAL-CORPUS PASS -- the 7 new .flow-meta.xml
// fixtures GROUND-TRUTH.md's "v0.13 subflow chains" section documents:
// widget-lifecycle pair (own-apex subflow + unknown-subflow-ref negative),
// 3-deep chain (incl. the LOAD-BEARING apex-less Top), and the mutual A<->B
// cycle. metascan-only: this file asserts extraction shape (subflows/
// className/methodName/flowObject-family fields), NOT flowGraph/cyclic
// flags/entry-catalog details -- those are resolver.js's job (S2, out of
// scope here).
// ===========================================================================

// v0.13: Vtx_WidgetLifecycleFlow -- record-triggered parent (Create on
// Vertex_Widget__c) with its own apex action AND two <subflows> references:
// a real one (Vtx_WidgetLifecycleNotifySubflow) and the unknown-subflow-ref
// negative (Vtx_Nonexistent_Ghost_Flow, no such file -- metascan has no file
// index and extracts it identically to a real one; classifying it as
// "unknown" is resolver.js's stats.unknownSubflowRefs job, out of scope
// here).
{
  const refs = parseMetaFile(readGauntlet('flows/Vtx_WidgetLifecycleFlow.flow-meta.xml'));
  assert.strictEqual(refs.length, 1, 'exactly the one apex actionCalls ref (Log_Widget_Created)');
  assert.ok(
    findRef(refs, 'VtxFlowWidgetDmlSource', 'logWidgetCreated'),
    'Vtx_WidgetLifecycleFlow -> VtxFlowWidgetDmlSource.logWidgetCreated'
  );
  assert.strictEqual(refs[0].flowObject, 'Vertex_Widget__c');
  assert.strictEqual(refs[0].flowRecordTriggerType, 'Create');
  assert.strictEqual(refs[0].flowTriggerType, 'RecordAfterSave');
  assert.deepStrictEqual(
    refs[0].subflows,
    ['Vtx_WidgetLifecycleNotifySubflow', 'Vtx_Nonexistent_Ghost_Flow'],
    'v0.13: BOTH <subflows> references extracted verbatim, in document order -- metascan does not judge resolvability'
  );
}

// v0.13: Vtx_WidgetLifecycleNotifySubflow -- the child/subflow, own apex
// action (Send_Widget_Notification -> VtxFlowWidgetNotifier.notifyTeam), NO
// <object>/trigger info of its own (reached only as a subflow), and zero
// <subflows> of its own.
{
  const refs = parseMetaFile(readGauntlet('flows/Vtx_WidgetLifecycleNotifySubflow.flow-meta.xml'));
  assert.strictEqual(refs.length, 1);
  assert.ok(
    findRef(refs, 'VtxFlowWidgetNotifier', 'notifyTeam'),
    'Vtx_WidgetLifecycleNotifySubflow -> VtxFlowWidgetNotifier.notifyTeam'
  );
  assert.strictEqual(refs[0].flowObject, null, 'reached only as a subflow -- no <object>/trigger info of its own');
  assert.strictEqual(refs[0].flowRecordTriggerType, null);
  assert.strictEqual(refs[0].flowTriggerType, null);
  assert.deepStrictEqual(refs[0].subflows, []);
}

// v0.13 LOAD-BEARING: Vtx_FlowChainTop -- depth-1 of the 3-deep chain,
// DELIBERATELY apex-less (zero <actionCalls> anywhere in the real file).
// This is GROUND-TRUTH.md's own named stress case: if S1 had attached
// `subflows` only onto per-ref objects, this flow's outgoing edge would be
// silently lost (zero refs from this file at all, on any pre-v0.13 version).
// A live run showing anything other than exactly 1 synthetic ref here is a
// strong signal the per-ref-only shortcut was taken instead.
{
  const refs = parseMetaFile(readGauntlet('flows/Vtx_FlowChainTop.flow-meta.xml'));
  assert.strictEqual(refs.length, 1, 'v0.13 LOAD-BEARING: Vtx_FlowChainTop must not vanish despite zero apex actionCalls');
  assert.strictEqual(refs[0].kind, 'flow');
  assert.strictEqual(refs[0].label, 'Vtx_FlowChainTop');
  assert.strictEqual(refs[0].className, null, 'synthetic ref -- no apex target on this file at all');
  assert.strictEqual(refs[0].methodName, null);
  assert.deepStrictEqual(refs[0].subflows, ['Vtx_FlowChainMid']);
  assert.strictEqual(refs[0].flowObject, null, 'plain autolaunched -- no record-trigger info');
  assert.strictEqual(refs[0].flowRecordTriggerType, null);
  assert.strictEqual(refs[0].flowTriggerType, null);
}

// v0.13: Vtx_FlowChainMid -- depth-2, has its own apex action
// (Relay_Mid_Action -> VtxFlowChainRelay.relayMid) AND a <subflows>
// reference forward to Leaf (Call_Chain_Leaf -> Vtx_FlowChainLeaf).
{
  const refs = parseMetaFile(readGauntlet('flows/Vtx_FlowChainMid.flow-meta.xml'));
  assert.strictEqual(refs.length, 1);
  assert.ok(findRef(refs, 'VtxFlowChainRelay', 'relayMid'), 'Vtx_FlowChainMid -> VtxFlowChainRelay.relayMid');
  assert.deepStrictEqual(refs[0].subflows, ['Vtx_FlowChainLeaf']);
}

// v0.13: Vtx_FlowChainLeaf -- depth-3, terminal (own apex action, zero
// subflows of its own).
{
  const refs = parseMetaFile(readGauntlet('flows/Vtx_FlowChainLeaf.flow-meta.xml'));
  assert.strictEqual(refs.length, 1);
  assert.ok(findRef(refs, 'VtxFlowChainRelay', 'relayLeaf'), 'Vtx_FlowChainLeaf -> VtxFlowChainRelay.relayLeaf');
  assert.deepStrictEqual(refs[0].subflows, [], 'terminal -- no <subflows> element of its own');
}

// v0.13: Vtx_FlowCycleA / Vtx_FlowCycleB -- the mutual cycle. Each has its
// own apex action AND a <subflows> reference naming the OTHER -- metascan
// extracts each file completely independently (it has no cross-file graph
// concept at all; detecting/flagging the cycle is resolver.js's flowGraph
// job, out of scope here), so this only pins that BOTH halves of the raw
// data are captured correctly, symmetric to each other.
{
  const refsA = parseMetaFile(readGauntlet('flows/Vtx_FlowCycleA.flow-meta.xml'));
  assert.strictEqual(refsA.length, 1);
  assert.ok(findRef(refsA, 'VtxFlowCycleHelper', 'pingA'), 'Vtx_FlowCycleA -> VtxFlowCycleHelper.pingA');
  assert.deepStrictEqual(refsA[0].subflows, ['Vtx_FlowCycleB']);

  const refsB = parseMetaFile(readGauntlet('flows/Vtx_FlowCycleB.flow-meta.xml'));
  assert.strictEqual(refsB.length, 1);
  assert.ok(findRef(refsB, 'VtxFlowCycleHelper', 'pingB'), 'Vtx_FlowCycleB -> VtxFlowCycleHelper.pingB');
  assert.deepStrictEqual(refsB[0].subflows, ['Vtx_FlowCycleA']);
}

// v0.13 regression: the pre-existing Vtx_Namespace_Probe_Flow fixture (v0.8)
// has no <subflows> element anywhere in it -- must be completely unaffected,
// subflows: [] on both its pre-existing refs, every other field byte-identical.
{
  const refs = parseMetaFile(readGauntlet('flows/Vtx_Namespace_Probe_Flow.flow-meta.xml'));
  assert.strictEqual(refs.length, 2, 'v0.13 regression: ref count unchanged from the v0.8-B5 pass above');
  assert.ok(refs.every((r) => Array.isArray(r.subflows) && r.subflows.length === 0), 'no <subflows> element in this file');
}

// v0.13 tally cross-check: 1 + 1 + 1 (synthetic) + 1 + 1 + 1 + 1 = 7 total
// refs across the 7 new gauntlet-org flow fixtures (matches the per-file
// counts asserted individually above -- Vtx_FlowChainTop's is the synthetic
// one).
{
  const total =
    parseMetaFile(readGauntlet('flows/Vtx_WidgetLifecycleFlow.flow-meta.xml')).length +
    parseMetaFile(readGauntlet('flows/Vtx_WidgetLifecycleNotifySubflow.flow-meta.xml')).length +
    parseMetaFile(readGauntlet('flows/Vtx_FlowChainTop.flow-meta.xml')).length +
    parseMetaFile(readGauntlet('flows/Vtx_FlowChainMid.flow-meta.xml')).length +
    parseMetaFile(readGauntlet('flows/Vtx_FlowChainLeaf.flow-meta.xml')).length +
    parseMetaFile(readGauntlet('flows/Vtx_FlowCycleA.flow-meta.xml')).length +
    parseMetaFile(readGauntlet('flows/Vtx_FlowCycleB.flow-meta.xml')).length;
  assert.strictEqual(total, 7, 'v0.13: 1 ref per new fixture (incl. the Top synthetic ref) = 7 total');
}

console.log('metascan.js v0.13 gauntlet-org subflow-chains regression self-check: all assertions passed');

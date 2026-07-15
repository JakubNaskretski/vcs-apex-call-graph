'use strict';
// Self-check for metascan.js (amendment A5): node test-metascan.js
//
// Two halves:
//   1. Inline-string fixtures for every source kind (lwc/aura/flow/
//      omniscript/vf) plus edge cases (multi-line imports, namespace-dotted
//      specifiers, __tests__ exclusion, non-apex Flow actions, the
//      escaped-string JSON decoy, malformed input never throwing).
//   2. A real pass over the read-only /Users/agent/work/code/example-data/
//      adv-org corpus, asserting the EXACT refs MANIFEST.md's "UI / metadata
//      callers" ground-truth section promises -- this is the bar the task
//      brief sets ("assert the exact refs the MANIFEST promises").
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { parseMetaFile, scanBundle } = require('./metascan');

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
  for (const r of refs) assert.strictEqual(r.className, 'AcmeQuoteAuraService');
}

// 4. Namespace-dotted specifier tolerated: last two segments are Class.method
{
  const text = "import doThing from '@salesforce/apex/acme_pkg.AcmeNamespacedService.doThing';";
  const refs = parseMetaFile({ path: 'lwc/acmeNsWidget/acmeNsWidget.js', text });
  assert.strictEqual(refs.length, 1);
  assert.strictEqual(refs[0].className, 'AcmeNamespacedService');
  assert.strictEqual(refs[0].methodName, 'doThing');
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

console.log('metascan.js inline-fixture self-check: all assertions passed');

// ===========================================================================
// REAL CORPUS PASS — /Users/agent/work/code/example-data/adv-org (read-only)
// Asserts the exact refs MANIFEST.md's "UI / metadata callers" ground-truth
// section promises: LWC class.method pairs, dotted + bare Flow actionNames,
// Aura controller pairs (class-level + method-level), and every
// remoteClass/remoteMethod pair (os-meta.xml + DataPack JSON).
// ===========================================================================

const CORPUS_ROOT = '/Users/agent/work/code/example-data/adv-org/force-app/main/default';

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

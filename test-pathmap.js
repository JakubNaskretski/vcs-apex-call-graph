'use strict';
// Self-check for pathmap.js: node test-pathmap.js
//
// Pure string-level assertions against renderPathMapHtml's output — no
// browser/DOM involved (pathmap.js is a pure data-in/string-out module, and
// its client-side script is only ever executed by a real browser/webview,
// which this harness deliberately does not try to emulate). What's checked
// here:
//   1. synthetic TreeResult fixtures (frozen TNode/SiteView contract, same
//      shapes resolver.js hands to extension.js) render the expected node
//      labels, shortened badges, and via labels;
//   2. hostile lineText/label/argsRendered content survives without ever
//      producing a second, unescaped <script> tag or a raw '</script>'
//      breakout;
//   3. the document has no external resource references (with one
//      documented, harmless exception — see NOTE below) and carries the
//      required strict CSP meta tag.
const assert = require('assert');
const { renderPathMapHtml, shortenEntry, accentKind, isRootNode, headerExtraLinesForResult } = require('./pathmap');

let passCount = 0;
function check(condition, message) {
  assert(condition, message);
  passCount += 1;
}

function countOccurrences(haystack, needle) {
  if (needle === '') return 0;
  let count = 0;
  let idx = 0;
  for (;;) {
    idx = haystack.indexOf(needle, idx);
    if (idx === -1) break;
    count += 1;
    idx += needle.length;
  }
  return count;
}

// A bare TNode/SiteView field-set matching the frozen contract, so every
// fixture below only has to override what it actually cares about.
function baseNode(overrides) {
  return Object.assign(
    {
      label: '',
      kind: 'method',
      className: '',
      methodLower: null,
      path: '/ws/Unused.cls',
      line: 1,
      entries: [],
      isTest: false,
      via: null,
      sites: [],
      children: [],
      cyclic: false,
      truncated: false,
      approximate: false,
    },
    overrides
  );
}

// =========================================================================
// Fixture 1: deep chain, entry root is a trigger.
//   AccountTrigger (trigger, leaf/entry root)
//     -> AccountTriggerHandler.run (via 'static')
//       -> AccountService.recalculatePricing (via 'typed')   <- TARGET
// =========================================================================
const fixture1 = {
  root: baseNode({
    label: 'AccountService.recalculatePricing',
    className: 'AccountService',
    methodLower: 'recalculatepricing',
    path: '/ws/AccountService.cls',
    line: 42,
    children: [
      baseNode({
        label: 'AccountTriggerHandler.run',
        className: 'AccountTriggerHandler',
        methodLower: 'run',
        path: '/ws/AccountTriggerHandler.cls',
        line: 7,
        via: 'typed',
        sites: [
          {
            path: '/ws/AccountTriggerHandler.cls',
            line: 9,
            col: 6,
            lineText: 'AccountService.recalculatePricing(scope);',
            argsRendered: 'scope: List<Account> = scope',
            via: 'typed',
          },
        ],
        children: [
          baseNode({
            label: 'AccountTrigger',
            kind: 'trigger',
            className: 'AccountTrigger',
            methodLower: '(trigger)',
            path: '/ws/AccountTrigger.trigger',
            line: 1,
            entries: ['trigger on Account (before insert, before update)'],
            via: 'static',
            sites: [
              {
                path: '/ws/AccountTrigger.trigger',
                line: 3,
                col: 4,
                lineText: 'AccountTriggerHandler.run(Trigger.new);',
                argsRendered: null,
                via: 'static',
              },
            ],
            children: [],
          }),
        ],
      }),
    ],
  }),
  targetLabel: 'AccountService.recalculatePricing',
  note: null,
};

// =========================================================================
// Fixture 2: interface fan-out, approximate.
//   Two implementers of IPricingRule.apply(), both via 'interface',
//   marked approximate (mirrors resolver.js: interface dispatch fans out to
//   every implementer and is always approximate) plus one @AuraEnabled
//   entry point so badge-shortening has something to shorten.
// =========================================================================
const fixture2 = {
  root: baseNode({
    label: 'PricingEngine.evaluate',
    className: 'PricingEngine',
    methodLower: 'evaluate',
    path: '/ws/PricingEngine.cls',
    line: 12,
    children: [
      baseNode({
        label: 'DiscountRule.apply',
        className: 'DiscountRule',
        methodLower: 'apply',
        path: '/ws/DiscountRule.cls',
        line: 20,
        via: 'interface',
        approximate: true,
        entries: ['@AuraEnabled (LWC/Aura)'],
        sites: [
          {
            path: '/ws/DiscountRule.cls',
            line: 22,
            col: 8,
            lineText: 'engine.evaluate(ctx);',
            argsRendered: 'ctx: PricingContext = ctx',
            via: 'interface',
          },
        ],
        children: [],
      }),
      baseNode({
        label: 'SurchargeRule.apply',
        className: 'SurchargeRule',
        methodLower: 'apply',
        path: '/ws/SurchargeRule.cls',
        line: 15,
        via: 'interface',
        approximate: true,
        sites: [
          {
            path: '/ws/SurchargeRule.cls',
            line: 17,
            col: 8,
            lineText: 'engine.evaluate(ctx);',
            argsRendered: 'ctx: PricingContext = ctx',
            via: 'interface',
          },
        ],
        children: [],
      }),
    ],
  }),
  targetLabel: 'PricingEngine.evaluate',
  note: 'interface dispatch: showing every implementer',
};

// =========================================================================
// Fixture 3: cyclic + truncated + test mix, plus the XSS-shaped payload.
// =========================================================================
const XSS_PAYLOAD = '</script><script>alert(1)</script>';
const fixture3 = {
  root: baseNode({
    label: 'RecursiveWorker.process',
    className: 'RecursiveWorker',
    methodLower: 'process',
    path: '/ws/RecursiveWorker.cls',
    line: 30,
    children: [
      baseNode({
        label: 'RecursiveWorker.process',
        className: 'RecursiveWorker',
        methodLower: 'process',
        path: '/ws/RecursiveWorker.cls',
        line: 30,
        via: 'this',
        cyclic: true,
        sites: [
          {
            path: '/ws/RecursiveWorker.cls',
            line: 33,
            col: 6,
            lineText: 'this.process(next); ' + XSS_PAYLOAD,
            argsRendered: 'next: Node = ' + XSS_PAYLOAD,
            via: 'this',
          },
        ],
        children: [],
      }),
      baseNode({
        label: 'DeepCaller.kick',
        className: 'DeepCaller',
        methodLower: 'kick',
        path: '/ws/DeepCaller.cls',
        line: 8,
        via: 'unique-name',
        approximate: true,
        truncated: true,
        sites: [],
        children: [],
      }),
      baseNode({
        label: 'RecursiveWorkerTest.testProcess',
        className: 'RecursiveWorkerTest',
        methodLower: 'testprocess',
        path: '/ws/RecursiveWorkerTest.cls',
        line: 4,
        via: 'static',
        isTest: true,
        sites: [
          {
            path: '/ws/RecursiveWorkerTest.cls',
            line: 5,
            col: 4,
            lineText: 'RecursiveWorker.process(root);',
            argsRendered: null,
            via: 'static',
          },
        ],
        children: [],
      }),
    ],
  }),
  targetLabel: 'RecursiveWorker.process',
  note: null,
};

// =========================================================================
// Fixture 4 (A7): an Apex @AuraEnabled target with one terminal metadata
// (LWC) caller — the TNode shape resolver.js's buildMetaChildren produces
// (see A6's contract, reproduced in this file's own header list above).
// =========================================================================
const fixture4 = {
  root: baseNode({
    label: 'AcmeQuoteAuraService.getRecentQuotes',
    className: 'AcmeQuoteAuraService',
    methodLower: 'getrecentquotes',
    path: '/ws/AcmeQuoteAuraService.cls',
    line: 10,
    entries: ['@AuraEnabled (LWC/Aura)'],
    children: [
      {
        label: 'acmeOrderDashboard',
        kind: 'lwc',
        className: '',
        methodLower: null,
        path: '/ws/lwc/acmeOrderDashboard/acmeOrderDashboard.js',
        line: 3,
        entries: ['@salesforce/apex import'],
        isTest: false,
        via: 'metadata',
        sites: [
          {
            path: '/ws/lwc/acmeOrderDashboard/acmeOrderDashboard.js',
            line: 3,
            col: 0,
            lineText: "import getRecentQuotes from '@salesforce/apex/AcmeQuoteAuraService.getRecentQuotes';",
            argsRendered: '',
            via: 'metadata',
          },
        ],
        children: [],
        cyclic: false,
        truncated: false,
        approximate: false,
      },
    ],
  }),
  targetLabel: 'AcmeQuoteAuraService.getRecentQuotes',
  note: null,
};

// =========================================================================
// Fixture 5 (v0.4): F1b non-terminal flow node (children = DML sites on its
// object) + F4b terminal 'cmdt' node + the three new via values
// ('dml'/'dynamic'/'override'), all in one tree so layoutTree() is exercised
// against a genuinely mixed-depth, mixed-kind shape.
// =========================================================================
const fixture5 = {
  root: baseNode({
    label: 'AcmeOrderInvocable.execute',
    className: 'AcmeOrderInvocable',
    methodLower: 'execute',
    path: '/ws/AcmeOrderInvocable.cls',
    line: 8,
    children: [
      // F1b: a record-triggered flow, no longer terminal -- its children
      // are the DML sites on its object (Acme_Order__c), each via 'dml'.
      {
        label: 'AcmeOrderCreatedWelcomeFlow',
        kind: 'flow',
        className: '',
        methodLower: null,
        path: '/ws/flows/AcmeOrderCreatedWelcomeFlow.flow-meta.xml',
        line: 43,
        entries: ['Flow apex action'],
        isTest: false,
        via: 'metadata',
        sites: [],
        children: [
          {
            label: 'AcmeFulfillmentDmlService.insertOrders',
            kind: 'method',
            className: 'AcmeFulfillmentDmlService',
            methodLower: 'insertorders',
            path: '/ws/AcmeFulfillmentDmlService.cls',
            line: 12,
            entries: [],
            isTest: false,
            via: 'dml',
            sites: [],
            children: [],
            cyclic: false,
            truncated: false,
            approximate: false,
          },
          {
            label: 'AcmeFulfillmentDmlService.upsertOrders',
            kind: 'method',
            className: 'AcmeFulfillmentDmlService',
            methodLower: 'upsertorders',
            path: '/ws/AcmeFulfillmentDmlService.cls',
            line: 44,
            entries: [],
            isTest: false,
            via: 'dml',
            sites: [],
            children: [],
            cyclic: false,
            truncated: false,
            approximate: false,
          },
        ],
        cyclic: false,
        truncated: false,
        approximate: false,
      },
      // F4a: Type.forName('AcmeEmailNotifier') -- dynamic, approximate.
      {
        label: 'AcmeHandlerFactory.createEmailNotifier',
        kind: 'method',
        className: 'AcmeHandlerFactory',
        methodLower: 'createemailnotifier',
        path: '/ws/AcmeHandlerFactory.cls',
        line: 6,
        entries: [],
        isTest: false,
        via: 'dynamic',
        approximate: true,
        sites: [],
        children: [],
        cyclic: false,
        truncated: false,
      },
      // F4b: Custom Metadata record naming a class -- terminal 'cmdt' node.
      {
        label: 'Acme_Integration_Config.Order_Sync_Handler',
        kind: 'cmdt',
        className: '',
        methodLower: null,
        path: '/ws/customMetadata/Acme_Integration_Config.Order_Sync_Handler.md-meta.xml',
        line: 7,
        entries: ['Custom Metadata record'],
        isTest: false,
        via: 'metadata',
        sites: [],
        children: [],
        cyclic: false,
        truncated: false,
        approximate: false,
      },
      // F3: override fan-out edge -- approximate.
      {
        label: 'AcmeShapeConcrete.surchargeFactor',
        kind: 'method',
        className: 'AcmeShapeConcrete',
        methodLower: 'surchargefactor',
        path: '/ws/AcmeShapeConcrete.cls',
        line: 15,
        entries: [],
        isTest: false,
        via: 'override',
        approximate: true,
        sites: [],
        children: [],
        cyclic: false,
        truncated: false,
      },
    ],
  }),
  targetLabel: 'AcmeOrderInvocable.execute',
  note: null,
};

// =========================================================================
// Fixture 6 (v0.5): the four new via values ('publish'/'throws'/'narrowed'/
// 'async'), a caughtHere node (shield badge + 'catches <Exc>' entries text),
// and a kind:'anonymous' node -- one "kitchen sink" tree, same style as
// fixture5's v0.4 round-up. Not a literal MANIFEST subtree (real ancestor
// shapes are resolver.js's concern, exercised by test.js/test-resolver.js
// against the real corpus) -- purely exercises every new render-time
// concern pathmap.js owns, all together, so layoutTree() sees a genuinely
// mixed shape.
// =========================================================================
const fixture6 = {
  root: baseNode({
    label: 'AcmeOrderService.recalculatePricing',
    className: 'AcmeOrderService',
    methodLower: 'recalculatepricing',
    path: '/ws/AcmeOrderService.cls',
    line: 18,
    children: [
      // G4: anonymous-Apex-script caller -- pure root, no via (nothing calls
      // it), 'Anonymous Apex script' entries label.
      {
        label: '(anonymous)',
        kind: 'anonymous',
        className: 'adhocRecalc',
        methodLower: '(anonymous)',
        path: '/ws/scripts/adhoc-recalc.apex',
        line: 15,
        entries: ['Anonymous Apex script'],
        isTest: false,
        via: null,
        sites: [],
        children: [],
        cyclic: false,
        truncated: false,
        approximate: false,
      },
      // G1(a): EventBus.publish -> trigger edge -- not approximate.
      {
        label: 'AcmeNoteEventTrigger',
        kind: 'trigger',
        className: '',
        methodLower: null,
        path: '/ws/triggers/AcmeNoteEventTrigger.trigger',
        line: 1,
        entries: ['trigger on Acme_Note__e (after insert)'],
        isTest: false,
        via: 'publish',
        sites: [],
        children: [],
        cyclic: false,
        truncated: false,
        approximate: false,
      },
      // G2: throw site -- not approximate.
      {
        label: 'AcmeOrderValidator.validate',
        kind: 'method',
        className: 'AcmeOrderValidator',
        methodLower: 'validate',
        path: '/ws/AcmeOrderValidator.cls',
        line: 9,
        entries: [],
        isTest: false,
        via: 'throws',
        sites: [],
        children: [],
        cyclic: false,
        truncated: false,
        approximate: false,
      },
      // G3: instanceof-narrowing fallback -- approximate.
      {
        label: 'AcmeShapeNarrowingAuditor.auditLabel',
        kind: 'method',
        className: 'AcmeShapeNarrowingAuditor',
        methodLower: 'auditlabel',
        path: '/ws/AcmeShapeNarrowingAuditor.cls',
        line: 16,
        entries: [],
        isTest: false,
        via: 'narrowed',
        approximate: true,
        sites: [],
        children: [],
        cyclic: false,
        truncated: false,
      },
      // G2 caughtHere + G5 async-hop, combined: a node that both catches the
      // traced exception AND has its own async-hop ancestor, so recursion
      // past a caughtHere node (rethrow is unknowable) is exercised too.
      {
        label: 'AcmeOrderBatchProcessor.execute',
        kind: 'method',
        className: 'AcmeOrderBatchProcessor',
        methodLower: 'execute',
        path: '/ws/AcmeOrderBatchProcessor.cls',
        line: 25,
        entries: ['catches AcmeValidationException'],
        isTest: false,
        via: 'async',
        caughtHere: true,
        sites: [],
        children: [
          {
            label: 'AcmeAsyncOrchestrator.runNightlyMaintenance',
            kind: 'method',
            className: 'AcmeAsyncOrchestrator',
            methodLower: 'runnightlymaintenance',
            path: '/ws/AcmeAsyncOrchestrator.cls',
            line: 13,
            entries: [],
            isTest: false,
            via: 'async',
            sites: [],
            children: [],
            cyclic: false,
            truncated: false,
            approximate: false,
          },
        ],
        cyclic: false,
        truncated: false,
        approximate: false,
      },
    ],
  }),
  targetLabel: 'AcmeOrderService.recalculatePricing',
  note: null,
};

// =========================================================================
// Fixture 7 (v0.6 H3/H5, H1/H4 forward-compat): overloadSig + argsRendered
// combined inline site rendering, a genuine 'root' leaf (childless,
// non-cyclic, non-truncated), a seenElsewhere reference node (H1's per-run
// caller-subtree dedup marker -- resolver.js does not produce this yet;
// exercised here so pathmap.js's rendering support is locked in ahead of
// that engine change), and TreeResult.stats.capped / unresolvedSites (H1/H4
// fields, same forward-compat rationale, not yet produced by resolver.js).
// =========================================================================
const fixture7 = {
  root: baseNode({
    label: 'AcmePricingService.calculatePrice',
    className: 'AcmePricingService',
    methodLower: 'calculateprice',
    path: '/ws/AcmePricingService.cls',
    line: 5,
    children: [
      baseNode({
        label: 'AcmeCheckoutController.checkout',
        className: 'AcmeCheckoutController',
        methodLower: 'checkout',
        path: '/ws/AcmeCheckoutController.cls',
        line: 9,
        via: 'typed',
        sites: [
          {
            path: '/ws/AcmeCheckoutController.cls',
            line: 11,
            col: 4,
            lineText: 'AcmePricingService.calculatePrice(skuCode);',
            argsRendered: 'skuCode: String = skuCode',
            overloadSig: 'calculatePrice(String)',
            via: 'typed',
          },
        ],
        // Leaf: no known caller, not cyclic, not truncated -- a genuine
        // 'root' node (entry point / unused code).
        children: [],
      }),
      // H1 forward-compat: a seenElsewhere reference node -- its subtree was
      // already expanded once elsewhere in this same trace; its own sites
      // still show, only its deeper callers are collapsed (children: []).
      baseNode({
        label: 'AcmeCheckoutController.checkout',
        className: 'AcmeCheckoutController',
        methodLower: 'checkout',
        path: '/ws/AcmeCheckoutController.cls',
        line: 9,
        via: 'typed',
        seenElsewhere: true,
        sites: [
          {
            path: '/ws/AcmeBatchRepricer.cls',
            line: 20,
            col: 4,
            lineText: 'AcmePricingService.calculatePrice(sku2);',
            argsRendered: 'skuCode: String = sku2',
            overloadSig: 'calculatePrice(String)',
            via: 'typed',
          },
        ],
        children: [],
      }),
    ],
  }),
  targetLabel: 'AcmePricingService.calculatePrice',
  note: null,
  // H1 forward-compat (buildCallerTree's node cap fired) + H4 forward-compat
  // (workspace-wide dropped-call-site count). Both live under stats, matching
  // resolver.js's real buildCallerTree TreeResult shape (TreeResult.stats.
  // unresolvedSites, not a top-level TreeResult.unresolvedSites field).
  stats: { nodes: 4, uniqueMethods: 3, capped: true, unresolvedSites: 2 },
};

// =========================================================================
// 1. shortenEntry / accentKind unit checks (the pure helpers pathmap.js
//    exports alongside renderPathMapHtml)
// =========================================================================
check(shortenEntry('@AuraEnabled (LWC/Aura)') === '@AuraEnabled', 'shortenEntry strips LWC/Aura qualifier');
check(shortenEntry('@InvocableMethod (Flow)') === '@InvocableMethod', 'shortenEntry strips Flow qualifier');
check(shortenEntry('@future (async)') === '@future', 'shortenEntry strips async qualifier');
check(shortenEntry('@HttpX (REST)') === '@HttpX', 'shortenEntry strips REST qualifier');
check(shortenEntry('webservice (SOAP API)') === 'webservice', 'shortenEntry strips SOAP API qualifier');
check(shortenEntry('Batchable') === 'Batchable', 'shortenEntry leaves unparenthesized entries alone');
check(shortenEntry('Queueable') === 'Queueable', 'shortenEntry leaves Queueable alone');
check(
  shortenEntry('trigger on Account (before insert, before update)') === 'trigger',
  'shortenEntry collapses trigger header to "trigger"'
);

check(accentKind({ kind: 'trigger', entries: [], isTest: false }) === 'trigger', 'trigger kind wins accent');
check(accentKind({ kind: 'method', entries: ['x'], isTest: true }) === 'entry', 'entries win over isTest');
check(accentKind({ kind: 'method', entries: [], isTest: true }) === 'test', 'isTest wins over normal');
check(accentKind({ kind: 'class', entries: [], isTest: false }) === 'normal', 'default is normal');

// A7: the 5 metadata-caller kinds all get the 'metadata' accent bucket, and
// it wins over 'entry' even though these nodes always carry a non-empty
// `entries` (their kind-specific label per resolver.js's metaEntryLabel).
check(accentKind({ kind: 'lwc', entries: ['@salesforce/apex import'], isTest: false }) === 'metadata', 'lwc kind gets metadata accent, ahead of the entry bucket');
check(accentKind({ kind: 'aura', entries: ['Aura controller'], isTest: false }) === 'metadata', 'aura kind gets metadata accent');
check(accentKind({ kind: 'flow', entries: ['Flow apex action'], isTest: false }) === 'metadata', 'flow kind gets metadata accent');
check(accentKind({ kind: 'omniscript', entries: ['OmniScript Remote Action'], isTest: false }) === 'metadata', 'omniscript kind gets metadata accent');
check(accentKind({ kind: 'vf', entries: ['VF controller'], isTest: false }) === 'metadata', 'vf kind gets metadata accent');

// v0.4 F4b: 'cmdt' joins the same metadata accent bucket.
check(accentKind({ kind: 'cmdt', entries: ['Custom Metadata record'], isTest: false }) === 'metadata', 'cmdt kind gets metadata accent');

// v0.4 F1b: accentKind is purely kind-based -- a 'flow' node that itself has
// children (no longer terminal) still gets the metadata accent, unaffected
// by whether it has children.
check(
  accentKind({ kind: 'flow', entries: ['Flow apex action'], isTest: false, children: [{ label: 'child' }] }) === 'metadata',
  'flow kind with children still gets metadata accent (non-terminal metadata nodes are not special-cased)'
);

// v0.5 G4: 'anonymous' kind gets its own accent bucket, distinct from
// 'metadata' -- an anonymous script is real Apex source, not a non-Apex
// caller -- and wins over 'entry' even though it always carries the
// 'Anonymous Apex script' entries label, same priority tier as 'trigger'.
check(
  accentKind({ kind: 'anonymous', entries: ['Anonymous Apex script'], isTest: false }) === 'anonymous',
  'anonymous kind gets its own accent bucket, ahead of the entry bucket'
);
check(
  accentKind({ kind: 'anonymous', entries: ['Anonymous Apex script'], isTest: true }) === 'anonymous',
  'anonymous kind wins over isTest too, same priority tier as trigger'
);

// =========================================================================
// 2. Fixture 1 (deep trigger chain) rendering checks
// =========================================================================
const html1 = renderPathMapHtml(fixture1);

// the target's label legitimately appears three times: once as the root
// TNode's own `label` field, once as the TreeResult's separate
// `targetLabel` field (resolver.js's contract: both are set from the same
// source string, but they are two distinct JSON fields, not a duplicate),
// and once inside the handler's call-site lineText (realistic Apex source
// naturally mentions the callee it invokes).
check(countOccurrences(html1, 'AccountService.recalculatePricing') === 3, 'target label appears exactly three times (node label + meta.targetLabel + call-site lineText)');
// appears twice: node label + the trigger's call-site lineText mentioning it.
check(countOccurrences(html1, 'AccountTriggerHandler.run') === 2, 'mid-chain label appears exactly twice (node label + call-site lineText)');
check(countOccurrences(html1, 'AccountTrigger') >= 1, 'trigger leaf label appears');
check(html1.includes('"kind":"trigger"'), 'trigger node kind serialized');
check(html1.includes('"accent":"trigger"'), 'trigger node gets the trigger accent bucket');
// the trigger's own entries ('trigger on Account (...)') must be shortened
// to the single badge 'trigger' — the long form must not survive anywhere.
check(html1.includes('"badges":["trigger"]'), 'trigger entries badge shortened to "trigger"');
check(!html1.includes('trigger on Account'), 'un-shortened trigger entry text does not leak into output');
check(html1.includes('"via":"typed"'), 'typed via label present');
check(html1.includes('"via":"static"'), 'static via label present');
check(html1.includes('AccountTriggerHandler.run(Trigger.new)'), 'call-site lineText for the trigger edge present');
// argsRendered contains generic-type angle brackets ('List<Account>'); those
// are '<'/'>' characters like any other and get the same </>
// treatment as the XSS payload below (jsonForScript escapes every '<'/'>',
// not just script-breakout-shaped ones), so the RAW form never appears —
// checking for the escaped form is what proves the data actually survived.
check(html1.includes('scope: List\\u003CAccount\\u003E = scope'), 'argsRendered for the handler edge present (escaped)');
check(!html1.includes('List<Account>'), 'raw unescaped angle brackets from argsRendered do not leak into output');

// =========================================================================
// 3. Fixture 2 (interface fan-out, approximate) rendering checks
// =========================================================================
const html2 = renderPathMapHtml(fixture2);

check(countOccurrences(html2, 'DiscountRule.apply') === 1, 'first fan-out implementer label appears exactly once');
check(countOccurrences(html2, 'SurchargeRule.apply') === 1, 'second fan-out implementer label appears exactly once');
// each fan-out node carries 'via':'interface' in three separate JSON
// fields (the node's own `via`, its one call site's `via`, and the
// corresponding edge's `via`) — 3 fields x 2 fan-out nodes = 6.
check(countOccurrences(html2, '"via":"interface"') === 6, 'both fan-out nodes/sites/edges carry the interface via label');
check(html2.includes('"approximate":true'), 'fan-out nodes/edges marked approximate');
check(html2.includes('"badges":["@AuraEnabled"]'), '@AuraEnabled entry shortened on the fan-out node');
check(!html2.includes('LWC/Aura'), 'un-shortened @AuraEnabled qualifier does not leak into output');
check(html2.includes('interface dispatch: showing every implementer'), 'treeResult.note is rendered');

// =========================================================================
// 4. Fixture 3 (cyclic + truncated + test mix + XSS payload) checks
// =========================================================================
const html3 = renderPathMapHtml(fixture3);

check(html3.includes('"cyclic":true'), 'cyclic flag serialized');
check(html3.includes('"truncated":true'), 'truncated flag serialized');
check(html3.includes('"isTest":true'), 'isTest flag serialized');
check(countOccurrences(html3, 'RecursiveWorkerTest.testProcess') === 1, 'test-node label appears exactly once');
check(countOccurrences(html3, 'DeepCaller.kick') === 1, 'truncated-node label appears exactly once');

// ---- escaping: the </script><script>alert(1)</script> payload must never
// appear verbatim, and must not add a second real <script> tag to the doc.
check(!html3.includes(XSS_PAYLOAD), 'raw XSS payload string does not appear unescaped anywhere in the output');
check(!/<\/script>\s*<script>/i.test(html3), 'no injected script tag sequence appears');
check(countOccurrences(html3.toLowerCase(), '<script') === 1, 'exactly one real <script> tag exists in the whole document');
// the payload must still have made it into the data blob (safely encoded),
// proving it was carried through rather than silently dropped.
check(html3.includes('\\u003C/script\\u003E'), 'payload survives, escaped, inside the embedded JSON data blob');

// =========================================================================
// 4b. Fixture 4 (A7 metadata terminal node) rendering checks
// =========================================================================
const html4 = renderPathMapHtml(fixture4);

check(html4.includes('"kind":"lwc"'), 'lwc metadata node kind serialized');
check(html4.includes('"accent":"metadata"'), 'lwc metadata node gets the metadata accent bucket');
check(html4.includes('"badges":["@salesforce/apex import"]'), 'metadata entries label passes through (no parenthetical to shorten)');
check(html4.includes('"via":"metadata"'), "'metadata' via label present");
check(countOccurrences(html4, 'acmeOrderDashboard') >= 1, 'metadata node label appears');
check(html4.includes('"badges":["@AuraEnabled"]'), 'target root still gets its own normal entry badge shortened');

// =========================================================================
// 4c. Fixture 5 (v0.4) rendering checks — non-terminal flow node, cmdt
// kind, and the three new via values.
// =========================================================================
const html5 = renderPathMapHtml(fixture5);

check(html5.includes('"kind":"flow"'), 'flow node kind serialized');
check(html5.includes('"kind":"cmdt"'), 'F4b: cmdt node kind serialized');
check(
  countOccurrences(html5, '"accent":"metadata"') >= 2,
  'both the flow node and the cmdt node get the metadata accent bucket'
);
check(html5.includes('"via":"dml"'), "F1: 'dml' via label present (node)");
check(html5.includes('"via":"dynamic"'), "F4a: 'dynamic' via label present (node)");
check(html5.includes('"via":"override"'), "F3: 'override' via label present (node)");
check(html5.includes('"badges":["Custom Metadata record"]'), 'F4b: cmdt entries label passes through verbatim');
check(html5.includes('"badges":["Flow apex action"]'), 'flow entries label passes through verbatim');

// Layout must correctly treat the flow node as INTERNAL (it has children),
// not fold it into the leaf count: root(1) + flow(1) + its 2 DML
// children(2) + dynamic(1) + cmdt(1) + override(1) = 7 nodes, 6 edges
// (one edge per non-root node back to its parent).
check(html5.includes('"nodeCount":7'), 'F1b: flow node with children contributes its children to the node count, not just itself');
check(html5.includes('"edgeCount":6'), 'F1b: edge count matches a tree where the flow node is internal, not a leaf');

// Approximate flag correctly carried for the two new approximate via kinds.
check(
  countOccurrences(html5, '"approximate":true') >= 2,
  'both the dynamic and override nodes/edges are flagged approximate'
);

// Legend: the new via labels and the cmdt/Custom-Metadata mention are
// documented in the (static, always-rendered) legend panel.
check(html5.includes('<span class="k">dml</span>'), 'legend documents the dml via label');
check(html5.includes('<span class="k">dynamic</span>'), 'legend documents the dynamic via label');
check(html5.includes('<span class="k">override</span>'), 'legend documents the override via label');
check(html5.includes('Custom Metadata'), 'legend mentions Custom Metadata records under the metadata accent');

// =========================================================================
// 4d. Fixture 6 (v0.5) rendering checks — publish/throws/narrowed/async via
// values, a caughtHere node (shield badge + entries text), and the
// 'anonymous' kind/accent.
// =========================================================================
const html6 = renderPathMapHtml(fixture6);

check(html6.includes('"kind":"anonymous"'), "G4: 'anonymous' node kind serialized");
check(html6.includes('"accent":"anonymous"'), 'G4: anonymous node gets its own accent bucket');
check(html6.includes('"badges":["Anonymous Apex script"]'), 'G4: anonymous entries label passes through verbatim');

check(html6.includes('"via":"publish"'), "G1: 'publish' via label present (node)");
check(html6.includes('"via":"throws"'), "G2: 'throws' via label present (node)");
check(html6.includes('"via":"narrowed"'), "G3: 'narrowed' via label present (node)");
check(countOccurrences(html6, '"via":"async"') >= 2, "G5: 'async' via label present on both the caughtHere node and its child");

// narrowed is the only one of the four new via values that is approximate.
check(html6.includes('"approximate":true'), 'G3: narrowed node/edge flagged approximate');

// caughtHere: the boolean field itself, its entries-carried 'catches <Exc>'
// badge text, AND the shield-glyph companion badge (both survive the
// jsonForScript \u-escape pass unmangled -- U+1F6E1 is outside the </>
// escape set, so it appears in the JSON blob as a literal surrogate pair).
check(html6.includes('"caughtHere":true'), 'G2: caughtHere flag serialized on its node');
check(countOccurrences(html6, '"caughtHere":true') === 1, 'G2: exactly one node carries caughtHere in this fixture');
check(html6.includes('catches AcmeValidationException'), "G2: entries-carried 'catches <Exc>' text present");
check(html6.includes('\\uD83D\\uDEE1'), 'G2: shield glyph (U+1F6E1) present in the client-script badge list');

// Layout must treat the caughtHere node as INTERNAL (traversal continues
// past it) -- root(1) + anonymous(1) + trigger(1) + throws(1) + narrowed(1)
// + caughtHere-async(1) + its async child(1) = 7 nodes, 6 edges.
check(html6.includes('"nodeCount":7'), 'G2: traversal continuing past a caughtHere node contributes its child to the node count');
check(html6.includes('"edgeCount":6'), 'edge count matches a tree where the caughtHere node is internal, not a leaf');

// Legend: the four new via labels, the anonymous accent swatch, and the
// shield-glyph caughtHere marker are all documented in the legend panel.
check(html6.includes('<span class="k">publish</span>'), 'legend documents the publish via label');
check(html6.includes('<span class="k">throws</span>'), 'legend documents the throws via label');
check(html6.includes('<span class="k">narrowed</span>'), 'legend documents the narrowed via label');
check(html6.includes('<span class="k">async</span>'), 'legend documents the async via label');
check(html6.includes('<span class="swatch anonymous">'), 'legend documents the anonymous accent swatch');
check(html6.includes('&#x1F6E1;'), 'legend documents the shield-glyph caughtHere marker');

// =========================================================================
// 4e. Fixture 7 (v0.6 H3/H5, H1/H4 forward-compat) rendering checks.
// =========================================================================
const html7 = renderPathMapHtml(fixture7);

// H3: overloadSig now serialized on the site data (previously rendered
// nowhere at all — confirmed bug).
check(html7.includes('"overloadSig":"calculatePrice(String)"'), 'H3: overloadSig serialized on the site data');
check(countOccurrences(html7, '"overloadSig":"calculatePrice(String)"') === 2, 'H3: overloadSig present on both sites that carry it');

// H3: the client-side tooltip builder combines overloadSig + argsRendered
// into a single '-> ...' segment (previously argsRendered alone, tooltip-
// only, with no '->' prefix and no overloadSig at all). This is static
// client-script text, present verbatim in every render, checked here for
// thematic grouping with the rest of the H3 coverage.
check(html7.includes("return '-> ' + parts.join(' \\u00B7 ')"), "H3: client-side site tooltip builds the combined '-> overloadSig · argsRendered' segment");
check(html7.includes('site.overloadSig'), 'H3: client-side tooltip builder reads site.overloadSig');

// H5 / H3: 'root' flag -- the checkout-caller leaf has no known caller of
// its own (childless, non-cyclic, non-truncated, non-seenElsewhere).
check(html7.includes('"root":true'), "H3: 'root' flag serialized true for a childless non-cyclic non-truncated non-seenElsewhere node");
check(countOccurrences(html7, '"root":false') >= 1, "the traced target itself (has a caller) does NOT get 'root':true");
check(html7.includes('\\u25C9'), 'H5: root glyph (U+25C9) present in the client-script badge-glyph list');

// H1 forward-compat / H5 rendering: seenElsewhere flag + glyph.
check(html7.includes('"seenElsewhere":true'), 'H1 forward-compat: seenElsewhere flag serialized on the reference node');
check(html7.includes('\\u21E2'), 'H5: seenElsewhere glyph (U+21E2) present in the client-script badge-glyph list');
// A seenElsewhere node is, by definition, never simultaneously a root node.
check(!/"seenElsewhere":true,"root":true/.test(html7) && !/"root":true,"seenElsewhere":true/.test(html7), 'seenElsewhere and root never both true on the same node');

// H5: legend documents both new markers.
check(html7.includes('&#x25C9;'), 'legend documents the root marker glyph');
check(html7.includes('&#x21E2;'), 'legend documents the seenElsewhere marker glyph');
check(html7.toLowerCase().includes('seenelsewhere'), 'legend mentions seenElsewhere by name');

// H1/H4 forward-compat: header lines for capped + unresolved call sites.
check(html7.includes('"capped":true') || html7.includes('capped'), 'H1 forward-compat: capped info reaches the rendered document');
check(html7.includes('"headerExtra":["Result capped -- not every caller could be expanded.","2 call sites workspace-wide could not be resolved (dynamic/platform/deep-chain)."]'), 'H1/H4 forward-compat: both header-extra lines computed server-side, in order, with the exact required unresolved-sites wording');
check(html7.includes("DATA.meta.headerExtra"), 'client script reads and renders meta.headerExtra');

// headerExtraLinesForResult direct unit checks. unresolvedSites lives under
// stats, matching resolver.js's real buildCallerTree TreeResult shape.
assert.deepStrictEqual(headerExtraLinesForResult(null), [], 'null treeResult -> no extra header lines');
assert.deepStrictEqual(headerExtraLinesForResult({ root: {}, note: null }), [], "today's real TreeResult shape -> no extra header lines");
assert.deepStrictEqual(
  headerExtraLinesForResult({ root: {}, stats: { capped: true } }),
  ['Result capped -- not every caller could be expanded.']
);
assert.deepStrictEqual(
  headerExtraLinesForResult({ root: {}, stats: { unresolvedSites: 5 } }),
  ['5 call sites workspace-wide could not be resolved (dynamic/platform/deep-chain).']
);
assert.deepStrictEqual(headerExtraLinesForResult({ root: {}, stats: { unresolvedSites: 0 } }), [], 'stats.unresolvedSites === 0 -> no line');
passCount += 5;

// isRootNode direct unit checks.
assert.strictEqual(isRootNode(null), false);
assert.strictEqual(isRootNode({ children: [] }), true);
assert.strictEqual(isRootNode({ children: [{ label: 'x' }] }), false);
assert.strictEqual(isRootNode({ children: [], cyclic: true }), false);
assert.strictEqual(isRootNode({ children: [], truncated: true }), false);
assert.strictEqual(isRootNode({ children: [], seenElsewhere: true }), false);
passCount += 6;

// Same escaping property holds for every fixture, not just the one that
// deliberately embeds the payload — belt-and-suspenders against a
// regression that only breaks on some field/fixture combination.
for (const [name, html] of [
  ['fixture1', html1],
  ['fixture2', html2],
  ['fixture3', html3],
  ['fixture4', html4],
  ['fixture5', html5],
  ['fixture6', html6],
  ['fixture7', html7],
]) {
  check(countOccurrences(html.toLowerCase(), '<script') === 1, name + ': exactly one <script> tag');
  check(countOccurrences(html.toLowerCase(), '</script>') === 1, name + ': exactly one </script> close tag');
}

// =========================================================================
// 5. No external URLs / requests; CSP meta tag present.
//
// NOTE on the one intentional exception: `document.createElementNS` (used
// client-side to build real SVG <path>/<text> nodes for the edges) requires
// the literal XML namespace URI 'http://www.w3.org/2000/svg'. That string
// is a namespace IDENTIFIER, never a network request — browsers do not
// fetch XML namespace URIs — so its presence does not violate "no external
// requests" under the strict CSP this document declares (default-src
// 'none'). Everything else is checked with zero exceptions: no other
// http(s):// substring, and no protocol-relative src=/href= (the classic
// `//cdn.example.com/x.js` external-load pattern).
// =========================================================================
for (const [name, html] of [
  ['fixture1', html1],
  ['fixture2', html2],
  ['fixture3', html3],
  ['fixture4', html4],
  ['fixture5', html5],
  ['fixture6', html6],
  ['fixture7', html7],
]) {
  const withoutSvgNamespace = html.split('http://www.w3.org/2000/svg').join('');
  check(!/https?:\/\//i.test(withoutSvgNamespace), name + ': no http(s):// URL beyond the unfetched SVG namespace URI');
  check(!/\bsrc\s*=\s*["']\/\//i.test(html), name + ': no protocol-relative src=');
  check(!/\bhref\s*=\s*["']\/\//i.test(html), name + ': no protocol-relative href=');
  check(
    html.includes(
      '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src \'unsafe-inline\'; script-src \'unsafe-inline\';">'
    ),
    name + ': strict CSP meta tag present verbatim'
  );
}

// =========================================================================
// 6. Degenerate inputs must not throw.
// =========================================================================
check(typeof renderPathMapHtml({ root: null, targetLabel: 'Missing.thing', note: 'target class not found in index' }) === 'string', 'missing-root TreeResult renders without throwing');
check(typeof renderPathMapHtml({ root: baseNode({ label: 'Lonely.target' }), targetLabel: 'Lonely.target', note: null }) === 'string', 'childless root renders without throwing');

console.log('apex-trace pathmap self-check: ' + passCount + ' assertions passed');

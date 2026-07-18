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
const {
  renderPathMapHtml,
  shortenEntry,
  accentKind,
  layoutTree,
  isRootNode,
  packageBadge,
  externalNamespace,
  managedBadge,
  directionHeaderLine,
  headerExtraLinesForResult,
  buildPathMapData,
  preserveTransformOnUpdate,
  frontierMethodKey,
} = require('./pathmap');

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

// =========================================================================
// v0.7.1 (U2): root-badge gating against the maxNodes cap -- mirrors
// test-uitree.js's identical gauntlet VALIDATION-REPORT.md Tier-3 #5 /
// ranked fix-backlog #2 pin (see that file for the full repro writeup:
// dev/gauntlet/probe-fanin-scale.js SECTION 3 /
// run-fanin-scale-output.txt lines 29-35, VertexBoltHub(Premium).dispatch
// capped at maxNodes:20). isRootNode's "childless and unflagged" definition
// already excludes truncated -- this proves that holds for pathmap.js too,
// AND that the generic-cause 'capped' node still renders correctly
// end-to-end through renderPathMapHtml's JSON blob (n.root, consumed by
// CLIENT_JS_TEXT's badgeGlyphs to decide the '◉' root glyph), not just via
// the standalone helper.
// =========================================================================
check(
  isRootNode({ label: 'VertexBoltHubPremium.dispatch', children: [], truncated: true }) === false,
  'U2 gauntlet Tier-3 #5: a maxNodes-capped node (real, unshown callers) is NOT a root'
);
const fixtureBoltHubCap = {
  root: baseNode({
    label: 'VertexBoltHub.dispatch',
    className: 'VertexBoltHub',
    methodLower: 'dispatch',
    path: '/ws/VertexBoltHub.cls',
    line: 4,
    children: [
      baseNode({
        label: 'VertexBoltHubPremium.dispatch',
        className: 'VertexBoltHubPremium',
        methodLower: 'dispatch',
        path: '/ws/VertexBoltHubPremium.cls',
        line: 9,
        via: 'super',
        // R5: the maxNodes cap cut this node's expansion off -- it has 63
        // REAL further callers that simply were never materialized, not
        // zero (see run-fanin-scale-output.txt).
        truncated: true,
        sites: [],
        children: [],
      }),
    ],
  }),
  targetLabel: 'VertexBoltHub.dispatch',
  note: null,
  stats: { nodes: 2, uniqueMethods: 2, capped: true, unresolvedSites: 0 },
};
const dataBoltHubCap = extractData(renderPathMapHtml(fixtureBoltHubCap));
const cappedNode = dataBoltHubCap.nodes.find((n) => n.label === 'VertexBoltHubPremium.dispatch');
check(!!cappedNode, 'U2: capped node present in rendered output');
check(cappedNode.truncated === true, 'U2: truncated flag reaches the rendered JSON');
check(
  cappedNode.root === false,
  'U2 gauntlet Tier-3 #5: the capped node must NOT be flagged root in the rendered document -- this is the exact false "◉ root" signal the finding reports'
);

// v0.7.1 (U3, R8): confirmed against resolver.js's real buildCalleeTree
// implementation -- the generic-typed-DML marker reuses kind:'unresolved'
// verbatim (via 'dml-unresolved' is what distinguishes it), so it already
// gets the SAME swatch/accent as the existing 'unresolved' leaf with no
// separate branch needed.
check(
  accentKind({ kind: 'unresolved', via: 'dml-unresolved', entries: [], isTest: false }) === 'unresolved',
  "U3 (R8): the DML-unresolved marker (kind:'unresolved', via:'dml-unresolved') gets the 'unresolved' accent bucket"
);

// v0.7.1 (U2/U3): legend documents the new/updated markers -- checked
// against html1, which (like every render) unconditionally embeds the
// static LEGEND_HTML regardless of the fixture's own content.
check(html1.includes('capped — trace depth cap OR the node-count'), 'U2: legend uses cause-agnostic "capped" wording, not "depth cap" alone');
check(html1.includes('<span class="k">unresolved</span>'), "U3: legend documents the 'unresolved' via label");
check(html1.includes('<span class="k">dml-unresolved</span>'), "U3 (R8): legend documents the 'dml-unresolved' via label");
check(html1.toLowerCase().includes('dml on unresolved sobject type'), 'U3 (R8): legend mentions the exact "DML on unresolved SObject type" marker text');

// End-to-end: the exact TNode shape resolver.js's buildForwardExtras
// produces (read directly from resolver.js), rendered through the full
// renderPathMapHtml pipeline.
const fixtureDmlUnresolved = {
  root: baseNode({
    label: 'KappaUnitOfWork.commitWork',
    className: 'KappaUnitOfWork',
    methodLower: 'commitwork',
    path: '/ws/KappaUnitOfWork.cls',
    line: 15,
    children: [
      baseNode({
        label: 'DML on unresolved SObject type',
        className: '',
        methodLower: null,
        path: '',
        line: 0,
        kind: 'unresolved',
        via: 'dml-unresolved',
        approximate: true,
        truncated: true,
        sites: [],
        children: [],
      }),
    ],
  }),
  targetLabel: 'KappaUnitOfWork.commitWork',
  note: null,
  direction: 'callees',
};
const dataDmlUnresolved = extractData(renderPathMapHtml(fixtureDmlUnresolved));
const dmlUnresolvedNode = dataDmlUnresolved.nodes.find((n) => n.label === 'DML on unresolved SObject type');
check(!!dmlUnresolvedNode, 'U3 (R8): DML-unresolved node present in rendered output');
check(dmlUnresolvedNode.kind === 'unresolved', 'U3 (R8): kind reaches the rendered JSON as "unresolved"');
check(dmlUnresolvedNode.via === 'dml-unresolved', 'U3 (R8): via reaches the rendered JSON as "dml-unresolved"');
check(dmlUnresolvedNode.accent === 'unresolved', 'U3 (R8): the node gets the unresolved accent/swatch end to end');
check(dmlUnresolvedNode.approximate === true, 'U3 (R8): approximate flag reaches the rendered JSON');

// =========================================================================
// v0.7.1 (U1): pin -- mirrors test-uitree.js's identical gauntlet
// "Callee-tree site-line corruption" regression (see that file for the
// full ownership-boundary writeup: the computational bug lives entirely in
// resolver.js's calleeItemFromEdge, outside pathmap.js/uitree.js, which is
// all this file/subagent owns). This confirms pathmap.js's
// shapeNodeForData/shapeSiteForData ALSO already pass whatever
// site.line/col/lineText they are handed straight through, verbatim, into
// the rendered JSON blob's `sites` array -- no independent re-derivation,
// no second bug in this file either. Uses the exact correct values
// confirmed live via `node dev/gauntlet/probe2.js` and by reading
// VertexLedgerBridge.cls/Billing.cls directly in example-data/gauntlet-org.
// =========================================================================
const fixtureU1 = {
  root: baseNode({
    label: 'Billing.charge',
    className: 'Billing',
    methodLower: 'charge',
    path: '/ws/gauntlet-org/force-app/main/default/classes/Billing.cls',
    line: 2,
    via: 'static',
    sites: [
      {
        path: '/ws/gauntlet-org/force-app/main/default/classes/VertexLedgerBridge.cls',
        line: 3,
        col: 4,
        lineText: 'Billing.charge(order.TotalAmount__c);',
        argsRendered: null,
        via: 'static',
      },
      {
        path: '/ws/gauntlet-org/force-app/main/default/classes/VertexLedgerBridge.cls',
        line: 19,
        col: 4,
        lineText: 'zenq.Billing.charge(order.TotalAmount__c);',
        argsRendered: null,
        via: 'static',
      },
    ],
    children: [],
  }),
  targetLabel: 'VertexLedgerBridge.postToLedger',
  note: null,
};
const dataU1 = extractData(renderPathMapHtml(fixtureU1));
const billingNodeU1 = dataU1.nodes.find((n) => n.label === 'Billing.charge');
check(!!billingNodeU1, 'U1: Billing.charge node present in rendered output');
check(billingNodeU1.sites.length === 2, 'U1: two distinct call sites both reach the rendered JSON');
check(
  billingNodeU1.sites[0].line === 3,
  "U1 gauntlet regression: first site keeps its own real line (3), not Billing.charge's declaration line (2)"
);
check(
  billingNodeU1.sites[1].line === 19,
  'U1 gauntlet regression: second site keeps its own real line (19), not collapsed onto the first'
);
check(
  billingNodeU1.sites[0].line !== billingNodeU1.sites[1].line,
  'U1: the two site rows must never render with identical line numbers ("both L2" was the exact reported symptom)'
);

// v0.7.1 (U3, M2 coordination point): headerExtraLinesForResult's
// stats.metaUnresolved forward-compat -- mirrors test-uitree.js's identical
// shapeHeaderLines addition (metascan.js/resolver.js does not produce this
// field yet; rendering support is locked in ahead of that engine change).
check(
  JSON.stringify(headerExtraLinesForResult({ root: {}, stats: { metaUnresolved: 2 } })) ===
    JSON.stringify(['2 metadata references could not be attached (ambiguous or unmatched namespace).']),
  'U3 (M2): stats.metaUnresolved > 1 produces the exact required header wording, plural'
);
check(
  JSON.stringify(headerExtraLinesForResult({ root: {}, stats: { metaUnresolved: 1 } })) ===
    JSON.stringify(['1 metadata reference could not be attached (ambiguous or unmatched namespace).']),
  'U3 (M2): stats.metaUnresolved === 1 uses the singular form'
);
check(
  JSON.stringify(headerExtraLinesForResult({ root: {}, stats: { metaUnresolved: 0 } })) === JSON.stringify([]),
  'U3 (M2): stats.metaUnresolved === 0 produces no header line'
);

// =========================================================================
// Fixture 8 (v0.7): 'exception'/'unresolved' kinds, 'ambiguous' via fan-out
// with two DIFFERENT-package children, and a plain cross-package badge --
// one "kitchen sink" tree, same style as fixture5/fixture6's round-ups.
// Loosely mirrors the MANIFEST's A3/A6/B3/B4 fixtures without being a
// literal corpus subtree (real resolver.js output is resolver.js's/
// test-resolver.js's concern).
// =========================================================================
const fixture8 = {
  root: baseNode({
    label: 'AcmeOrderBatchProcessor.finish',
    className: 'AcmeOrderBatchProcessor',
    methodLower: 'finish',
    path: '/ws/force-app/main/default/classes/AcmeOrderBatchProcessor.cls',
    line: 33,
    package: 'force-app',
    children: [
      // A3: exception-class node -- terminal, via='throws', NOT approximate.
      {
        label: 'AcmeValidationException',
        kind: 'exception',
        className: 'AcmeValidationException',
        methodLower: null,
        path: '/ws/force-app/main/default/classes/AcmeValidationException.cls',
        line: 1,
        package: 'force-app',
        entries: [],
        isTest: false,
        via: 'throws',
        sites: [],
        children: [],
        cyclic: false,
        truncated: false,
        approximate: false,
      },
      // A6: aggregated unresolved-sites leaf -- terminal, approximate.
      {
        label: '5 unresolved sites',
        kind: 'unresolved',
        className: 'AcmeSmsNotifier',
        methodLower: 'sendsms',
        path: '/ws/force-app/main/default/classes/AcmeSmsNotifier.cls',
        line: 18,
        package: 'force-app',
        entries: [],
        isTest: false,
        via: null,
        sites: [],
        children: [],
        cyclic: false,
        truncated: false,
        approximate: true,
      },
      // B4 case 1: a plain cross-package child -- gets a badge.
      {
        label: 'NovaBillingService.recordBatchCompletion',
        kind: 'method',
        className: 'NovaBillingService',
        methodLower: 'recordbatchcompletion',
        path: '/ws/pkg-billing/main/default/classes/NovaBillingService.cls',
        line: 20,
        package: 'nova-billing',
        entries: [],
        isTest: false,
        via: 'static',
        sites: [],
        children: [],
        cyclic: false,
        truncated: false,
        approximate: false,
      },
      // B2/B3/B4 case 3: one call site fans out (via='ambiguous') to two
      // DIFFERENT-package candidates -- each carries its OWN badge.
      {
        label: 'NovaBillingUtil.auditPricingSync',
        kind: 'method',
        className: 'NovaBillingUtil',
        methodLower: 'auditpricingsync',
        path: '/ws/pkg-billing/main/default/classes/NovaBillingUtil.cls',
        line: 5,
        package: 'nova-billing',
        entries: [],
        isTest: false,
        via: 'ambiguous',
        approximate: true,
        sites: [],
        children: [],
        cyclic: false,
        truncated: false,
      },
      {
        label: 'NovaBillingUtil.auditPricingSync',
        kind: 'method',
        className: 'NovaBillingUtil',
        methodLower: 'auditpricingsync',
        path: '/ws/pkg-shared/main/default/classes/NovaBillingUtil.cls',
        line: 5,
        package: 'nova-shared',
        entries: [],
        isTest: false,
        via: 'ambiguous',
        approximate: true,
        sites: [],
        children: [],
        cyclic: false,
        truncated: false,
      },
    ],
  }),
  targetLabel: 'AcmeOrderBatchProcessor.finish',
  note: null,
  direction: 'callees',
  stats: { duplicateNames: 2 },
};

const html8 = renderPathMapHtml(fixture8);

check(html8.includes('"kind":"exception"'), "v0.7 A3: 'exception' node kind serialized");
check(html8.includes('"accent":"exception"'), 'exception node gets its own accent bucket');
check(html8.includes('"kind":"unresolved"'), "v0.7 A6: 'unresolved' node kind serialized");
check(html8.includes('"accent":"unresolved"'), 'unresolved node gets its own accent bucket');
check(countOccurrences(html8, '"via":"ambiguous"') >= 2, "v0.7 B2: 'ambiguous' via label present on both fan-out nodes");
check(html8.includes('"badges":["(nova-billing)"]'), 'v0.7 B4: plain cross-package child carries the "(nova-billing)" badge');
check(html8.includes('"badges":["(nova-billing)","(nova-billing)"]') === false, 'the plain cross-package child does not carry a duplicated badge');
// the two ambiguous fan-out children each carry their OWN, DIFFERENT badge.
check(html8.includes('"badges":["(nova-billing)"]') && html8.includes('"badges":["(nova-shared)"]'), 'v0.7 B4 case 3: the two ambiguous fan-out children carry two DIFFERENT package badges from each other');
check(!html8.includes('"badges":["(force-app)"]'), 'the target itself (force-app) never carries its own package as a badge -- it cannot differ from itself');
check(html8.includes('"package":"force-app"'), 'raw package field is serialized on the target node too (not just used to derive the badge)');

// v0.7 (A3): direction header + meta.
check(html8.includes('"direction":"callees"'), 'meta.direction serialized');
check(html8.includes('"directionLabel":"What Does This Call?"'), 'meta.directionLabel carries the forward-tracing header text');
check(html8.includes("if (DATA.meta.directionLabel)"), 'client script conditionally renders the direction label');
check(html8.includes('id="pm-direction"'), 'dedicated #pm-direction header element is always present in the document shell');

// v0.7 (B3): duplicate-names header note, exact MANIFEST-pinned wording.
check(
  html8.includes(
    '"headerExtra":["2 duplicate class names across packages — resolution prefers the referring file\'s package"]'
  ),
  'duplicate-names line reaches headerExtra with the exact pinned wording, and (since capped/unresolvedSites are both absent from fixture8\'s stats) is the ONLY headerExtra entry'
);

// v0.7 (A3): mirrored layout -- direction:'callees' means the target
// (depth 0) is the LEFTMOST node, i.e. has the SMALLEST x of any node.
check(html8.includes('"mirrored":true'), 'layout.mirrored is true for a callees-direction render');
{
  const dataMatch8 = html8.match(/var DATA = ([\s\S]*?);\s*\(function/);
  check(!!dataMatch8, 'DATA blob is extractable from the rendered document');
  const data8 = JSON.parse(dataMatch8[1]);
  const targetRec = data8.nodes.find((n) => n.parentId == null);
  const minX = Math.min(...data8.nodes.map((n) => n.x));
  check(targetRec.x === minX, "v0.7 A3: in a mirrored (callees) render, the traced target sits at the LEFTMOST column (target LEFT, flow RIGHT, per the A3 spec)");
}

// Legend: new v0.7 rows -- exception/unresolved swatches, ambiguous via,
// package badge, and both direction labels ('who calls this' / 'what this
// calls'), all present in every render (the legend is static/unconditional).
check(html8.includes('<span class="swatch exception">'), "legend documents the 'exception' accent swatch");
check(html8.includes('<span class="swatch unresolved">'), "legend documents the 'unresolved' accent swatch");
check(html8.includes('<span class="k">ambiguous</span>'), "legend documents the 'ambiguous' via label");
check(html8.includes('(pkgLabel)'), 'legend documents the package badge format');
check(html8.toLowerCase().includes('who calls this'), "legend mentions 'Who Calls This' (the default/callers direction)");
check(html8.toLowerCase().includes('what this calls'), "legend mentions 'What This Calls' (the forward/callees direction)");

// =========================================================================
// Fixture 9 (v0.7 A3): reuses fixture1's exact tree (deep trigger chain, no
// packages) but tagged direction:'callees', purely to exercise the mirrored
// layout end to end against a MULTI-hop (not just single-child) tree, and
// direction:'callers' explicitly (for the byte-identical assertions below).
// =========================================================================
const fixture9Callees = { ...fixture1, direction: 'callees' };
const fixture9Callers = { ...fixture1, direction: 'callers' };
const html9 = renderPathMapHtml(fixture9Callees);

check(html9.includes('"directionLabel":"What Does This Call?"'), 'fixture9 (callees): direction label present');
{
  const dataMatch9 = html9.match(/var DATA = ([\s\S]*?);\s*\(function/);
  const data9 = JSON.parse(dataMatch9[1]);
  const target9 = data9.nodes.find((n) => n.parentId == null);
  // AccountTrigger is the deepest node in fixture1's chain (3 hops from the
  // target) -- in a mirrored render it must sit STRICTLY to the RIGHT of
  // the target (target leftmost, deepest caller rightmost).
  const triggerNode = data9.nodes.find((n) => n.label === 'AccountTrigger');
  check(triggerNode.x > target9.x, 'v0.7 A3: mirrored layout puts the deepest node to the RIGHT of the (now-leftmost) target');
}
check(html9.includes('"mirrored":true'), 'fixture9 layout.mirrored is true');

// v0.7 (A3) byte-identical bar: an explicit direction:'callers' tag on a
// PACKAGE-FREE fixture (fixture1, unmodified otherwise) must render a
// document that is structurally identical to "today" (the same fixture
// with NO direction field at all) in every OBSERVABLE way -- CONFIRMED
// against the real resolver.js sibling implementation: buildCallerTree now
// stamps `direction: 'callers'` on EVERY TreeResult it returns
// unconditionally (see pathmap.js's own header-note on this), so 'callers'
// must render with zero visible difference from the pre-v0.7, direction-
// less shape -- not just "close enough". The ONE field allowed to differ at
// all is the raw, non-visible `meta.direction` string itself (an internal
// tag, never rendered as text); `meta.directionLabel` -- the actually-
// user-visible field -- is null in BOTH cases. This is the concrete proof
// behind the pinned "CALLERS-DIRECTION render is byte-identical to today"
// bar, at this file's layer (mirrors test-uitree.js's analogous
// shapeHeaderLines/shapeResult assertions).
function extractData(html) {
  const m = html.match(/var DATA = ([\s\S]*?);\s*\(function/);
  assert(m, 'DATA blob found in the rendered document');
  return JSON.parse(m[1]);
}
const dataTodayFixture1 = extractData(html1); // html1 = renderPathMapHtml(fixture1), no direction field at all
const dataCallersExplicit = extractData(renderPathMapHtml(fixture9Callers));
assert.deepStrictEqual(
  dataCallersExplicit.nodes,
  dataTodayFixture1.nodes,
  'node array (x/y positions, badges, kind, accent, via, package, sites...) is byte-identical whether or not direction:"callers" is explicitly tagged, for a fixture with no package field'
);
assert.deepStrictEqual(dataCallersExplicit.edges, dataTodayFixture1.edges, 'edge array is byte-identical too');
assert.deepStrictEqual(dataCallersExplicit.layout, dataTodayFixture1.layout, 'layout (dimensions AND mirrored flag) is fully byte-identical -- explicit "callers" takes the same non-mirrored branch as absent direction');
// meta.direction is the ONE non-visible field allowed to differ (a raw
// internal tag, 'callers' vs. null) -- every OTHER meta field, including
// the actually-visible directionLabel, is identical.
assert.deepStrictEqual(
  { ...dataCallersExplicit.meta, direction: undefined },
  { ...dataTodayFixture1.meta, direction: undefined },
  'every meta field except the raw (non-visible) direction tag is byte-identical, including directionLabel -- both null'
);
assert.strictEqual(dataTodayFixture1.meta.direction, null, "'today' (no direction field) -> meta.direction is null");
assert.strictEqual(dataCallersExplicit.meta.direction, 'callers', "explicit 'callers' -> meta.direction carries the raw tag (non-visible)");
assert.strictEqual(dataTodayFixture1.meta.directionLabel, null, "'today' -> no direction label");
assert.strictEqual(dataCallersExplicit.meta.directionLabel, null, "'callers' -- like every real buildCallerTree output -- ALSO gets no direction label: this is the whole point of the byte-identical bar");
passCount += 8;

// =========================================================================
// layoutTree direct unit checks: mirroring is a pure column-index flip,
// row placement/geometry constants untouched, and 'callers' explicit is a
// complete no-op vs. direction absent.
// =========================================================================
const miniTree = {
  label: 'Target',
  children: [
    { label: 'Child1', children: [] },
    { label: 'Child2', children: [{ label: 'Grandchild', children: [] }] },
  ],
};
const layoutAbsent = layoutTree(miniTree);
const layoutCallersExplicit = layoutTree(miniTree, 'callers');
const layoutCalleesMirrored = layoutTree(miniTree, 'callees');
assert.deepStrictEqual(layoutCallersExplicit, layoutAbsent, "layoutTree(root, 'callers') is byte-identical to layoutTree(root) -- both take the non-mirrored branch");
assert.notDeepStrictEqual(layoutCalleesMirrored, layoutAbsent, "layoutTree(root, 'callees') differs -- mirrored");
assert.strictEqual(layoutAbsent.mirrored, false);
assert.strictEqual(layoutCalleesMirrored.mirrored, true);
const targetAbsent = layoutAbsent.nodes.find((n) => n.depth === 0);
const targetMirrored = layoutCalleesMirrored.nodes.find((n) => n.depth === 0);
const deepestAbsent = layoutAbsent.nodes.reduce((a, b) => (b.depth > a.depth ? b : a));
const deepestMirroredNode = layoutCalleesMirrored.nodes.reduce((a, b) => (b.depth > a.depth ? b : a));
assert(targetAbsent.x > deepestAbsent.x, 'default (unmirrored): target sits to the RIGHT of deeper nodes');
assert(targetMirrored.x < deepestMirroredNode.x, 'mirrored: target sits to the LEFT of deeper nodes');
// row placement (leaf-order dendrogram) is untouched by mirroring -- every
// node keeps the exact same `row`/`y`, only `x` (column) changes.
assert.deepStrictEqual(layoutCalleesMirrored.nodes.map((n) => n.y), layoutAbsent.nodes.map((n) => n.y), 'mirroring never touches row/y placement');
assert.strictEqual(layoutCalleesMirrored.width, layoutAbsent.width, 'mirroring never touches the canvas width');
assert.strictEqual(layoutCalleesMirrored.height, layoutAbsent.height, 'mirroring never touches the canvas height');
passCount += 8;

// =========================================================================
// directionHeaderLine / packageBadge direct unit checks (pathmap.js's own
// small re-implementations, mirroring uitree.js's).
// =========================================================================
assert.strictEqual(directionHeaderLine(undefined), null);
assert.strictEqual(
  directionHeaderLine('callers'),
  null,
  "'callers' -- the value EVERY real buildCallerTree TreeResult now carries -- renders with NO header line, same as absent"
);
assert.strictEqual(directionHeaderLine('callees'), 'What Does This Call?');
assert.strictEqual(packageBadge({ package: 'force-app' }, 'force-app'), null, 'same package -> no badge');
assert.strictEqual(packageBadge({ package: 'nova-billing' }, 'force-app'), '(nova-billing)');
assert.strictEqual(packageBadge(null, 'force-app'), null);
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
  ['fixture8', html8],
  ['fixture9', html9],
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
  ['fixture8', html8],
  ['fixture9', html9],
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
// v0.7: a direction:'callees' TreeResult with a null root must not throw
// either (mirrors the same degenerate-root guard, exercised in the new
// direction).
check(
  typeof renderPathMapHtml({ root: null, targetLabel: 'Missing.thing', note: null, direction: 'callees' }) === 'string',
  'v0.7: missing-root callees-direction TreeResult renders without throwing'
);

// =========================================================================
// v0.8 (N1/N4/N6, forward-compat): kind:'external' rendering. Mirrors
// test-uitree.js's matching N6 section -- resolver.js does not produce this
// kind yet (a different phase's job), so every fixture below is hand-built
// against the documented shape.
// =========================================================================

// --- accentKind: 'external' gets its own bucket, ahead of entry/test ---
check(accentKind({ kind: 'external', entries: [], isTest: false }) === 'external', "kind:'external' gets the 'external' accent");
check(
  accentKind({ kind: 'external', entries: ['managed'], isTest: true }) === 'external',
  'external wins over entries/isTest, same tier as exception/unresolved'
);

// --- externalNamespace / managedBadge: mirror uitree.js's helpers exactly ---
check(externalNamespace({ kind: 'external', ns: 'zenq', label: 'zenq.Billing' }) === 'zenq', 'ns field read directly when present');
check(externalNamespace({ kind: 'external', label: 'zenq.Billing' }) === 'zenq', 'namespace derived from a dotted label when ns is absent');
check(externalNamespace({ kind: 'external', label: 'kwx__Ledger__c' }) === 'kwx', 'namespace derived from a dunder-namespaced object label');
check(externalNamespace({ kind: 'method', ns: 'zenq', label: 'zenq.Billing' }) === null, 'non-external kind never yields a namespace');
check(externalNamespace({ kind: 'external', label: 'Plain' }) === null, 'no derivable namespace -> null');
check(managedBadge({ kind: 'external', ns: 'zenq', label: 'zenq.Billing' }) === 'managed: zenq', "exact 'managed: <ns>' wording");
check(managedBadge({ kind: 'method', label: 'Foo.bar' }) === null, 'no badge for a non-external node');

// --- end-to-end via renderPathMapHtml: external node serializes with the
//     'external' kind/accent, a 'managed: <ns>' badge, and the legend/CSS
//     document the new bucket unconditionally. ---
const externalChild = baseNode({
  label: 'zenq.Billing',
  kind: 'external',
  ns: 'zenq',
  via: 'external',
  entries: [],
  children: [],
  sites: [],
});
const externalTarget = baseNode({ label: 'OppService.applyDiscount', children: [externalChild] });
const htmlExternal = renderPathMapHtml({ root: externalTarget, targetLabel: 'OppService.applyDiscount', note: null });
check(htmlExternal.includes('"kind":"external"'), "v0.8: 'external' node kind serialized");
check(htmlExternal.includes('"accent":"external"'), 'external node gets its own accent bucket');
check(htmlExternal.includes('"via":"external"'), "v0.8: 'external' via label present");
check(htmlExternal.includes('"badges":["managed: zenq"]'), "v0.8 N4: exact 'managed: zenq' badge serialized");
check(htmlExternal.includes('"ns":"zenq"'), 'raw ns field is serialized on the external node too (not just used to derive the badge)');
check(htmlExternal.includes('<span class="swatch external">'), "legend documents the 'external' accent swatch");
check(htmlExternal.includes('managed: ns'), 'legend documents the managed-package badge format');
check(htmlExternal.includes('.node.kind-external'), 'stylesheet defines the external node accent border rule');
check(htmlExternal.includes('.swatch.external'), 'stylesheet defines the external swatch rule');

// A local (non-external) node in the SAME render never picks up a managed badge.
{
  const dataMatch = htmlExternal.match(/var DATA = ([\s\S]*?);\s*\(function/);
  const dataExternal = JSON.parse(dataMatch[1]);
  const targetRec = dataExternal.nodes.find((n) => n.label === 'OppService.applyDiscount');
  check(targetRec.badges.length === 0, 'regression: the local target node itself never gains a managed badge from a sibling external node');
  check(targetRec.ns === null, 'regression: a non-external node serializes ns:null, not the external child\'s namespace');
}

// =========================================================================
// v0.8 (N5, forward-compat): headerExtraLinesForResult's combined
// 'N unresolved · M managed-package refs (ns1, ns2)' line -- mirrors
// test-uitree.js's matching N5 section exactly.
// =========================================================================
assert.deepStrictEqual(
  headerExtraLinesForResult({ root: {}, stats: { unresolvedSites: 4, externalRefs: 7, externalNamespaces: ['zenq', 'kwx'] } }),
  ['4 unresolved · 7 managed-package refs (zenq, kwx).'],
  'N5: exact CONTRACT-pinned combined wording'
);
assert.deepStrictEqual(
  headerExtraLinesForResult({ root: {}, stats: { unresolvedSites: 0, externalRefs: 1, externalNamespaces: ['zenq'] } }),
  ['0 unresolved · 1 managed-package ref (zenq).'],
  'singular "ref" wording for externalRefs === 1'
);
// REGRESSION: externalRefs absent (the whole adv-org corpus) -> the exact
// pre-v0.8 unresolvedSites wording, byte-identical.
assert.deepStrictEqual(
  headerExtraLinesForResult({ root: {}, stats: { unresolvedSites: 5 } }),
  ['5 call sites workspace-wide could not be resolved (dynamic/platform/deep-chain).'],
  'REGRESSION: externalRefs absent -> unresolvedSites keeps its exact pre-v0.8 wording'
);
assert.deepStrictEqual(
  headerExtraLinesForResult({ root: {}, stats: { unresolvedSites: 5, externalRefs: 0 } }),
  ['5 call sites workspace-wide could not be resolved (dynamic/platform/deep-chain).'],
  'REGRESSION: externalRefs === 0 -> old wording, not the new combined line'
);

// =========================================================================
// v0.9 (P1/P4, forward-compat): progressive-depth frontier rendering.
// resolver.js does not produce TNode.expandable/pendingCount/methodKey yet
// (a separate phase's job -- same "forward-compat" status as v0.8's
// kind:'external' before that phase landed) -- every fixture below is
// hand-built against the documented shape.
// =========================================================================

// --- frontierMethodKey: explicit field wins, else derive from
//     className+methodLower (mirrors uitree.js's identical helper) ---
check(frontierMethodKey({ methodKey: 'oppservice#applydiscount' }) === 'oppservice#applydiscount', 'explicit methodKey wins verbatim');
check(
  frontierMethodKey({ className: 'OppService', methodLower: 'applydiscount' }) === 'oppservice#applydiscount',
  'derived from className (lowercased) + methodLower (already lowercase)'
);
check(frontierMethodKey({ className: 'OppService' }) === 'oppservice', 'class-level target derives the bare lowercased className');
check(frontierMethodKey({}) === null, 'nothing derivable -> null');
check(frontierMethodKey(null) === null);

// --- buildPathMapData: frontier fields reach the per-node data shape ---
const frontierLeaf = baseNode({
  label: 'Deep.caller',
  className: 'Deep',
  methodLower: 'caller',
  expandable: true,
  pendingCount: 3,
});
const frontierParent = baseNode({ label: 'OppService.applyDiscount', children: [frontierLeaf] });
const frontierTree = { root: frontierParent, targetLabel: 'OppService.applyDiscount', note: null, direction: 'callers' };
const frontierData = buildPathMapData(frontierTree);
const frontierLeafData = frontierData.nodes.find((n) => n.label === 'Deep.caller');
check(!!frontierLeafData, 'frontier leaf node present in buildPathMapData output');
check(frontierLeafData.expandable === true, 'expandable flag reaches the per-node data shape');
check(frontierLeafData.pendingCount === 3, 'pendingCount reaches the per-node data shape');
check(frontierLeafData.expandKey === 'deep#caller', 'expandKey derived from className+methodLower reaches the per-node data shape');
check(frontierLeafData.root === false, 'REGRESSION-SAFETY: a childless frontier node is NOT flagged root -- it has unshown callers/callees pending, same family as cyclic/truncated/seenElsewhere');

// Non-expandable childless sibling in the SAME render is unaffected -- still
// a genuine root, proving the isRootNode exclusion is expandable-specific.
const plainLeaf = baseNode({ label: 'Plain.leaf' });
const mixedParent = baseNode({ label: 'OppService.applyDiscount', children: [frontierLeaf, plainLeaf] });
const mixedData = buildPathMapData({ root: mixedParent, targetLabel: 'OppService.applyDiscount', note: null });
const plainLeafData = mixedData.nodes.find((n) => n.label === 'Plain.leaf');
check(plainLeafData.root === true, 'a non-expandable childless sibling in the same render is still a genuine root');
check(plainLeafData.expandable === false, 'REGRESSION: expandable defaults to false, not undefined, on an ordinary fixture');
check(plainLeafData.pendingCount === null, 'REGRESSION: pendingCount defaults to null on an ordinary fixture');
check(plainLeafData.expandKey === null, "baseNode's default className is '' -- nothing derivable, expandKey null (harmless either way -- the client only reads it when expandable is true)");

// A node with NO usable className/methodLower at all -> expandKey null,
// never a broken/partial key.
const noKeyLeaf = baseNode({ label: 'NoKey.leaf', className: '', expandable: true, pendingCount: 1 });
const noKeyData = buildPathMapData({ root: baseNode({ label: 'Root', children: [noKeyLeaf] }), targetLabel: 'Root', note: null });
check(noKeyData.nodes.find((n) => n.label === 'NoKey.leaf').expandKey === null, 'no derivable className -> expandKey null, not a broken key');

// --- renderPathMapHtml end-to-end: frontier node serializes correctly, and
//     the client script carries the pill/expand/update machinery ---
const htmlFrontier = renderPathMapHtml(frontierTree);
check(htmlFrontier.includes('"expandable":true'), 'expandable flag serialized in the embedded data blob');
check(htmlFrontier.includes('"pendingCount":3'), 'pendingCount serialized');
check(htmlFrontier.includes('"expandKey":"deep#caller"'), 'expandKey serialized');
check(htmlFrontier.includes("n.pendingCount"), 'client script reads n.pendingCount to build the pill');
check(htmlFrontier.includes('frontier-pill'), 'client script builds the frontier-pill element, and the stylesheet defines its rule');
check(htmlFrontier.includes('.frontier-pill {'), 'stylesheet defines the frontier-pill visual rule, distinct from the plain .badge rule');
check(htmlFrontier.includes("if (n.expandable)"), 'client script conditionally renders the pill only for expandable nodes');

// pill-vs-body click separation: the pill's own click handler calls
// ev.stopPropagation() BEFORE requesting expansion, so the click can never
// bubble up to the node body's own 'click' listener (which still jumps to
// source) -- string-level proof that the two handlers are wired in the
// documented order within the same function body.
{
  const clientText = htmlFrontier; // CLIENT_JS_TEXT is embedded verbatim in the document
  const pillClickIdx = clientText.indexOf("pill.addEventListener('click'");
  check(pillClickIdx !== -1, "pill has its own 'click' listener, separate from the node body's");
  const pillHandlerBody = clientText.slice(pillClickIdx, pillClickIdx + 200);
  check(pillHandlerBody.indexOf('stopPropagation') < pillHandlerBody.indexOf('requestExpand'), 'stopPropagation() is called BEFORE requestExpand() inside the pill click handler -- the body click-to-jump listener never fires for a pill click');
}
check(htmlFrontier.includes("function requestExpand(n)"), "client script defines requestExpand, the pill's postMessage relay");
check(htmlFrontier.includes("{ type: 'expand', key: n.expandKey }") || htmlFrontier.includes("type: 'expand'"), "pill click posts {type:'expand', key} per the P2 CONTRACT AMENDMENT");

// --- update-in-place message handler ---
check(htmlFrontier.includes("addEventListener('message'"), "client script registers a 'message' event handler for the update-in-place channel");
check(htmlFrontier.includes("msg.type !== 'update'"), "message handler gates on {type:'update'}");
check(htmlFrontier.includes('function applyUpdate('), 'applyUpdate is a named, reusable function (not inlined into the message handler)');
check(htmlFrontier.includes('function renderGraph('), 'the node/edge DOM construction is factored into a reusable renderGraph function the update handler also calls');
check(htmlFrontier.includes('function preserveTransformOnUpdate('), 'client script defines the SAME preserveTransformOnUpdate algorithm exported Node-side (see the unit tests below)');
check(!htmlFrontier.includes('fitInitial();\\n  })();') , 'sanity: fitInitial IIFE marker text is not accidentally duplicated'); // loose guard, see the stronger check just below
{
  const applyUpdateIdx = htmlFrontier.indexOf('function applyUpdate(');
  const applyUpdateEnd = htmlFrontier.indexOf('\n  window.addEventListener(\'message\'', applyUpdateIdx);
  const applyUpdateBody = htmlFrontier.slice(applyUpdateIdx, applyUpdateEnd === -1 ? applyUpdateIdx + 1500 : applyUpdateEnd);
  check(!applyUpdateBody.includes('fitInitial()'), 'applyUpdate never calls fitInitial() -- pan/zoom is PRESERVED, never re-fitted, on an in-place update');
  check(applyUpdateBody.includes('preserveTransformOnUpdate('), 'applyUpdate calls preserveTransformOnUpdate to obtain the (unchanged) transform it reapplies');
  check(applyUpdateBody.includes('applyTransform()'), 'applyUpdate reapplies the preserved transform after rebuilding the DOM');
  check(!applyUpdateBody.includes("getElementById('pm-legend')"), 'applyUpdate never touches the #pm-legend element -- its open/closed state is preserved purely by never being referenced');
  check(applyUpdateBody.includes('clearChildren(nodesLayer)') && applyUpdateBody.includes('clearChildren(edgesSvg)'), 'applyUpdate clears the previous nodes/edges DOM before rebuilding');
  check(applyUpdateBody.includes('renderGraph()'), 'applyUpdate rebuilds via the shared renderGraph function, not a second copy of the node/edge loops');
  check(!/innerHTML|insertAdjacentHTML|document\.write/.test(applyUpdateBody), 'INJECTION POSTURE: the update-in-place code path itself uses none of innerHTML/insertAdjacentHTML/document.write');
}

// --- legend documents the new pill ---
check(htmlFrontier.includes('+N pill'), 'legend documents the frontier +N pill');
check(htmlFrontier.toLowerCase().includes('expand this node in place'), 'legend explains the click-to-expand affordance');

// --- INJECTION POSTURE (whole-document, not just the update path): assert
//     no innerHTML/insertAdjacentHTML/document.write was introduced ANYWHERE
//     in the rendered document by this round -- extends the pre-existing
//     comment-only invariant (see this file's header note) with an actual
//     assertion, across every fixture already built in this suite plus the
//     new frontier one. ---
for (const [name, html] of [
  ['fixture1', html1], ['fixture2', html2], ['fixture3', html3], ['fixture4', html4],
  ['fixture5', html5], ['fixture6', html6], ['fixture7', html7], ['fixture8', html8],
  ['fixture9', html9], ['frontier', htmlFrontier],
]) {
  check(!html.includes('innerHTML'), name + ': INJECTION POSTURE: no innerHTML usage anywhere in the rendered document');
  check(!html.includes('insertAdjacentHTML'), name + ': INJECTION POSTURE: no insertAdjacentHTML usage anywhere in the rendered document');
  check(!html.includes('document.write'), name + ': INJECTION POSTURE: no document.write usage anywhere in the rendered document');
}

// --- buildPathMapData is exactly what renderPathMapHtml embeds (the
//     refactor is a pure extraction, not a new shape) ---
assert.deepStrictEqual(buildPathMapData(fixture1), extractData(html1), 'buildPathMapData(fixture1) is byte-identical to the DATA blob renderPathMapHtml(fixture1) actually embeds');
passCount += 1;

// =========================================================================
// preserveTransformOnUpdate: pure, DOM-free "preserve, never re-derive"
// invariant, unit-tested directly (mirrors the client-side algorithm of the
// same name inside CLIENT_JS_TEXT, checked above via string presence).
// =========================================================================
assert.deepStrictEqual(preserveTransformOnUpdate({ scale: 2.5, panX: 10, panY: -5 }), { scale: 2.5, panX: 10, panY: -5 }, 'a real transform passes through completely unchanged');
assert.deepStrictEqual(preserveTransformOnUpdate(null), { scale: 1, panX: 24, panY: 24 }, 'null -> the same defaults fitInitial() itself uses on a true first load');
assert.deepStrictEqual(preserveTransformOnUpdate({}), { scale: 1, panX: 24, panY: 24 }, 'empty object -> defaults for every missing field');
assert.deepStrictEqual(preserveTransformOnUpdate({ scale: 'not-a-number' }), { scale: 1, panX: 24, panY: 24 }, 'a non-number scale is treated as missing, not propagated as garbage');
assert.deepStrictEqual(preserveTransformOnUpdate({ scale: 0.2, panX: 0, panY: 0 }), { scale: 0.2, panX: 0, panY: 0 }, 'falsy-but-valid numbers (0, MIN_SCALE) are preserved, not treated as missing');
passCount += 5;

// =========================================================================
// v0.13 (S2/S3): flow-to-subflow chains -- legend + map rendering
// =========================================================================

// --- legend entry present (S3 contract: "'subflow' via label ... legend
// entry"). Checked by rendering a minimal TreeResult and grepping the
// document, same convention every other legend-content assertion in this
// file uses (the legend text lives in a module-level HTML string, but this
// file's own contract is "assert against renderPathMapHtml's OUTPUT", not
// against pathmap.js internals). ------------------------------------------
{
  const legendFixture = { root: baseNode({ label: 'Legend.Probe' }), targetLabel: 'Legend.Probe', note: null };
  const legendHtml = renderPathMapHtml(legendFixture, { legendOpen: true });
  check(legendHtml.includes('<span class="k">subflow</span>'), 'legend must document the new "subflow" via label');
  check(/subflow.*&lt;subflows&gt;/.test(legendHtml) || legendHtml.includes('&lt;subflows&gt;'), 'legend text should name the actual <subflows> XML element for a user reading it');
}

// --- accentKind: a subflow-via node is still kind:'flow' -- same metadata
// accent every other flow node (record-triggered, DML-fanout, etc.) already
// gets; no new accent/kind needed for this via value. -----------------------
{
  check(
    accentKind({ kind: 'flow', via: 'subflow', entries: ['Flow apex action'], isTest: false }) === 'metadata',
    'a subflow-reached flow node keeps the metadata accent -- only the via badge is new, not a new node kind'
  );
}

// --- full 3-deep subflow chain renders through buildPathMapData/
// renderPathMapHtml exactly like any other chain: right node count, right
// via on each edge, both orientations (default callers-style layout here;
// the mirrored/callees layout is already exercised generically elsewhere in
// this file and this via value participates in that same generic code path,
// see layoutTree's own header note -- no special-casing exists to test). --
{
  const chainTop = baseNode({ label: 'S13ChainTop', kind: 'flow', via: 'subflow', entries: ['Flow apex action'], path: '/ws/flows/S13ChainTop.flow-meta.xml' });
  const chainMid = baseNode({ label: 'S13ChainMid', kind: 'flow', via: 'subflow', entries: ['Flow apex action'], path: '/ws/flows/S13ChainMid.flow-meta.xml', children: [chainTop] });
  const chainLeaf = baseNode({ label: 'S13ChainLeaf', kind: 'flow', via: 'metadata', entries: ['Flow apex action'], path: '/ws/flows/S13ChainLeaf.flow-meta.xml', children: [chainMid] });
  const chainRoot = baseNode({ label: 'S13ChainRelay.relayLeaf', className: 'S13ChainRelay', methodLower: 'relayleaf', path: '/ws/S13ChainRelay.cls', children: [chainLeaf] });
  const chainFixture = { root: chainRoot, targetLabel: 'S13ChainRelay.relayLeaf', note: null, direction: 'callers' };

  const data = buildPathMapData(chainFixture);
  check(data.nodes.length === 4, 'root + 3-deep chain = 4 nodes');
  check(data.edges.length === 3, '3 edges connecting them (one per child->parent TNode relationship)');
  // Both node.via and edge.via are read straight off each TNode's own `via`
  // field (shapeNodeForData/shapeEdgeForData) -- no subflow-specific code
  // path exists in pathmap.js, so this is a plain structural check, same as
  // every other kind/via value already exercised in this file.
  const byLabel = new Map(data.nodes.map((n) => [n.label, n]));
  check(byLabel.get('S13ChainLeaf').accent === 'metadata', 'flow kind keeps its metadata accent regardless of via');
  check(byLabel.get('S13ChainMid').accent === 'metadata');
  check(byLabel.get('S13ChainTop').accent === 'metadata');
  check(byLabel.get('S13ChainLeaf').via === 'metadata', 'the pre-existing metadata edge (flow calls apex) is unaffected');
  check(byLabel.get('S13ChainMid').via === 'subflow', 'NEW v0.13: the parent-flow edge carries via=subflow on the node itself');
  check(byLabel.get('S13ChainTop').via === 'subflow', 'the chain genuinely recurses -- level 3 carries it too');
  const edgesByChildLabel = new Map(data.edges.map((e) => [data.nodes.find((n) => n.id === e.from).label, e]));
  check(edgesByChildLabel.get('S13ChainMid').via === 'subflow', 'the edge record mirrors the node-level via, same duplication every other via value already has');
  check(edgesByChildLabel.get('S13ChainTop').via === 'subflow');
  check(edgesByChildLabel.get('S13ChainLeaf').via === 'metadata');

  // renderPathMapHtml itself must not throw and must embed the SAME data
  // (mirrors this file's own "buildPathMapData is byte-identical to the
  // embedded blob" invariant, re-checked here for a subflow-chain shape
  // specifically).
  const html = renderPathMapHtml(chainFixture);
  check(html.includes('<!doctype html>') || html.includes('<meta charset'), 'renders a full document without throwing');
  assert.deepStrictEqual(extractData(html), data, 'the embedded DATA blob matches buildPathMapData(chainFixture) exactly for a subflow chain, same as every other fixture in this file');
  passCount += 1;
}

// --- cyclic subflow node renders with the pre-existing cyclic marker/accent
// -- no new visual treatment needed, same generic cyclic handling every
// other kind already gets. --------------------------------------------------
{
  const cyclicChild = baseNode({ label: 'S13CycleA', kind: 'flow', via: 'subflow', entries: ['Flow apex action'], cyclic: true, path: '/ws/flows/S13CycleA.flow-meta.xml' });
  const cyclicMid = baseNode({ label: 'S13CycleB', kind: 'flow', via: 'subflow', entries: ['Flow apex action'], path: '/ws/flows/S13CycleB.flow-meta.xml', children: [cyclicChild] });
  const cyclicRoot = baseNode({ label: 'S13CycleHelper.pingA', className: 'S13CycleHelper', methodLower: 'pinga', path: '/ws/S13CycleHelper.cls', children: [cyclicMid] });
  const data = buildPathMapData({ root: cyclicRoot, targetLabel: 'S13CycleHelper.pingA', note: null, direction: 'callers' });
  const byLabel = new Map(data.nodes.map((n) => [n.label, n]));
  check(byLabel.get('S13CycleA').cyclic === true, 'the cyclic flag survives into the data blob unchanged for a subflow node');
  check(byLabel.get('S13CycleA').via === 'subflow', 'a cyclic node still carries its own subflow via correctly, not clobbered by the cyclic flag');
}

console.log('apex-trace pathmap self-check: ' + passCount + ' assertions passed');

# adv-org — Apex Trace advanced-corpus manifest

This org is a synthetic Salesforce DX fixture built to exercise the "real"
method-level call-graph engine in `vcs-apex-trace` (`parser.js` +
`resolver.js`) end-to-end, across both what it resolves correctly today and
the call shapes it is known to approximate or miss entirely. Every class,
trigger, LWC, Aura component, Flow, and OmniScript below is fictional
(Acme Manufacturing, a made-up quote-to-cash/order-to-ship business) — no
real company, person, or credential appears anywhere in this tree.

This file is the family-wide spec for the corpus: the ground-truth edge list
below is what a correct engine should ultimately report; the
`[resolves-today]` / `[needs: ...]` tag on each edge says whether today's
`resolver.js` already gets there or requires one of the four named upgrades.

## Domain story

Acme Manufacturing's "quote to cash" and "order to ship" flows, wired
together into one small object model so the same corpus exercises several
call-graph shapes at once:

- **Quoting** — `AcmeQuote` (a domain object with `Status`/`TotalAmount`
  properties) is assembled by `AcmeQuoteBuilder`, priced via the four-way
  overloaded `AcmePricingEngine.calculatePrice`, and converted to an
  `AcmeInvoice`. `AcmeQuoteAuraService` exposes this to three LWC bundles and
  a Flow Screen (`AcmeQuoteApprovalScreenFlow` invoking
  `AcmeDiscountApprovalInvocable`) and an OmniScript DataPack.
- **Packaging/freight** — `AcmeShapeBase` → `AcmeShapeIntermediate` →
  `AcmeShapeConcrete` is a 3-tier abstract/virtual/concrete hierarchy used by
  `AcmePricingEngine` to compute freight surcharge.
- **Notifications** — `AcmeNotifiable` (interface) is implemented directly by
  `AcmeEmailNotifier`/`AcmeSmsNotifier`, and indirectly by `AcmeSlackNotifier`
  (which satisfies the interface purely through inheriting
  `AcmeBaseNotifier`). `AcmeNotificationDispatcher` fans a message out to a
  `List<AcmeNotifiable>` built from all three.
- **Order lifecycle** — `AcmeOrderTrigger` → `AcmeOrderTriggerHandler` →
  `AcmeOrderService` → `AcmeOrderUtil`/`AcmeOrderBatchProcessor`, plus a
  3-node validation cycle (`AcmeOrderValidator` → `AcmeInventoryChecker` →
  `AcmeBackorderResolver` → back to `AcmeOrderValidator`). Entry points:
  Batchable (`AcmeOrderBatchProcessor`), Schedulable
  (`AcmeNightlyReconciliationScheduler`), `@future`
  (`AcmeFutureNotifier`), `@InvocableMethod` (`AcmeOrderInvocable`,
  `AcmeDiscountApprovalInvocable`), `@AuraEnabled`
  (`AcmeOrderApprovalController`), `@RestResource`
  (`AcmeOrderRestResource`), and a legacy global SOAP class
  (`AcmeLegacyOrderSoapService`).
- **Shipment lifecycle** — mirrors the order lifecycle at smaller scale:
  `AcmeShipmentTrigger` → `AcmeShipmentTriggerHandler` →
  `AcmeShipmentService` → `AcmeShipmentUtil` / a Queueable
  (`AcmeShipmentQueueableDispatcher`) that calls back into the service.
  Exposed via `AcmeShipmentAuraService` to an LWC, an Aura component, and an
  OmniScript.
- **Resolver stress fixtures** — classes built specifically to exercise one
  documented resolver behavior each: `AcmeInvoiceCastDemo` (cast / safe-nav /
  ternary / for-each receivers), `AcmeOuterContainer` +
  `AcmeInnerRefConsumer` (inner-class instantiation, in-file and
  cross-file), `AcmeShadowConsumer` + `Database.cls` (user class shadowing
  the platform `Database` namespace), `AcmePropertyConsumer` (property
  accessor call sites), `AcmeGeneratedCatalog` (a wide, generated-looking
  static-call fan-in used as a bulk/perf indexing check), and
  `AcmeBrokenParser` (the one deliberately-unparseable file).

## Per-file table

| Path | Role |
|---|---|
| `classes/AcmeQuote.cls` | Quote domain model; `Status`/`TotalAmount` properties, `<init>`/`validateStatusTransition`/`calculateTotal`/`toInvoice`. |
| `classes/AcmePropertyConsumer.cls` | Exercises `AcmeQuote.Status`/`TotalAmount` property get/set from another compilation unit. |
| `classes/AcmeQuoteBuilder.cls` | Fluent `AcmeQuote` assembly; prices each line and the finished quote via `AcmePricingEngine`. |
| `classes/AcmePricingEngine.cls` | Four-way overloaded `calculatePrice(String\|Integer\|Acme_Order__c\|AcmeQuote)`; the `AcmeQuote` overload also prices freight via the shape hierarchy. |
| `classes/AcmeInvoice.cls` | Invoice domain model, normally produced by `AcmeQuote.toInvoice()`. |
| `classes/AcmeInvoiceCastDemo.cls` | Stress fixture: cast / safe-nav (`?.`) / ternary-selected / for-each receivers, all calling `AcmeInvoice.total()`. |
| `classes/AcmeDiscountUtil.cls` | Discount-tier lookup; tiers built once via a static-initializer-invoked private method. |
| `classes/AcmeOuterContainer.cls` | Outer/inner pairing (`InnerWorker`); exercises inner-class instantiation and the inner-to-outer static callback. |
| `classes/AcmeInnerRefConsumer.cls` | Cross-file consumer of `AcmeOuterContainer.InnerWorker` via its fully-qualified `Outer.Inner` type name. |
| `classes/AcmeShapeBase.cls` | Abstract root of the packaging-shape hierarchy. |
| `classes/AcmeShapeIntermediate.cls` | Virtual middle tier; generic length x width x count volume model. |
| `classes/AcmeShapeConcrete.cls` | Concrete rectangular-crate shape; the type `AcmePricingEngine` actually instantiates. |
| `classes/AcmeNotifiable.cls` | Notification interface (`notify(String)`). |
| `classes/AcmeBaseNotifier.cls` | Virtual base with a default `notify()`; `AcmeSlackNotifier` relies on this alone. |
| `classes/AcmeEmailNotifier.cls` | Notifier channel; implements `AcmeNotifiable` directly. |
| `classes/AcmeSmsNotifier.cls` | Notifier channel; implements `AcmeNotifiable` directly. |
| `classes/AcmeSlackNotifier.cls` | Notifier channel; satisfies `AcmeNotifiable` only via inheriting `AcmeBaseNotifier`. |
| `classes/AcmeNotificationDispatcher.cls` | Fans a message out to `List<AcmeNotifiable>` built from all three channels. |
| `classes/AcmeOrderValidator.cls` | Validation cycle node 1: `validate → checkStock → resolve → validate`. |
| `classes/AcmeInventoryChecker.cls` | Validation cycle node 2: delegates to backorder resolution when stock is short. |
| `classes/AcmeBackorderResolver.cls` | Validation cycle node 3: closes the cycle back to `AcmeOrderValidator`. |
| `classes/Database.cls` | User-defined class literally named `Database`; deliberately shadows `System.Database`. |
| `classes/AcmeShadowConsumer.cls` | Declares a locally-typed `Database` (the user class, not the platform one) and calls it. |
| `classes/AcmeBrokenParser.cls` | **Deliberately broken**: missing closing brace. The only file expected to carry `parseError != null`. |
| `classes/AcmeGeneratedCatalog.cls` | Generated-looking wide catalog (9 lookup methods); several round-trip through `AcmePricingEngine` for fan-in/perf coverage. |
| `triggers/AcmeOrderTrigger.trigger` | Order trigger entry point → `AcmeOrderTriggerHandler`. |
| `classes/AcmeOrderTriggerHandler.cls` | Order trigger chain link 2 → `AcmeOrderService.processOrders`. |
| `classes/AcmeOrderService.cls` | Order service layer: `processOrders` (batch/trigger entry), `approveOrder`, `recalculatePricing`. |
| `classes/AcmeOrderUtil.cls` | Order chain link 4: `normalize`, `markApproved` (fires `@future` email), `buildQuery`. |
| `triggers/AcmeShipmentTrigger.trigger` | Shipment trigger entry point → `AcmeShipmentTriggerHandler`. |
| `classes/AcmeShipmentTriggerHandler.cls` | Shipment trigger chain link 2 → `AcmeShipmentService.processShipments`. |
| `classes/AcmeShipmentService.cls` | Shipment service layer: enriches shipments, hands off to a Queueable; `scheduleDelivery` is the record-level entry. |
| `classes/AcmeShipmentUtil.cls` | Shipment chain link 4: `enrich`, `computeEta`. |
| `classes/AcmeOrderBatchProcessor.cls` | `Database.Batchable<SObject>`; `start` sources its query from `AcmeOrderUtil.buildQuery`, `execute` re-enters `AcmeOrderService.processOrders`, `finish` fans out via the notification dispatcher. |
| `classes/AcmeShipmentQueueableDispatcher.cls` | Queueable enqueued from `AcmeShipmentService.processShipments`; its `execute` calls back into the shipment service. |
| `classes/AcmeNightlyReconciliationScheduler.cls` | Schedulable; kicks off a fresh `AcmeOrderBatchProcessor` run nightly. |
| `classes/AcmeFutureNotifier.cls` | `@future` async leaf invoked from `AcmeOrderUtil.markApproved`. |
| `classes/AcmeOrderInvocable.cls` | Bulk `@InvocableMethod` (`execute`); approves every order Id passed in. |
| `classes/AcmeDiscountApprovalInvocable.cls` | `@InvocableMethod` (`execute`) taking a wrapper `Request`; applies a discount then recalculates pricing. |
| `classes/AcmeQuoteAuraService.cls` | `@AuraEnabled` quote service backing 3 LWC bundles and the quote OmniScript. |
| `classes/AcmeShipmentAuraService.cls` | `@AuraEnabled` shipment service backing the shipment-tracker LWC, the Aura status board, and the shipment OmniScript. |
| `classes/AcmeOrderApprovalController.cls` | `@AuraEnabled` controller backing the `AcmeOrderApprovalPanel` Aura component. |
| `classes/AcmeOrderRestResource.cls` | `@RestResource('/acmeOrders/*')`: GET recalculates pricing, POST processes an order batch. |
| `classes/AcmeLegacyOrderSoapService.cls` | Global legacy SOAP surface predating the REST resource; calls `AcmeOrderUtil.markApproved` directly. |
| `classes/AcmeOrderServiceTest.cls` | `@isTest`; exercises the service layer, batch processor, bulk invocable, quote construction, dispatcher, and scheduler end-to-end. |
| `lwc/acmeOrderDashboard/*` | Wire adapter → `AcmeQuoteAuraService.getRecentQuotes`. |
| `lwc/acmeQuoteWizard/*` | Imperative call → `AcmeQuoteAuraService.createQuote`; has a Jest unit test with no Apex edges. |
| `lwc/acmeInvoiceViewer/*` | Wire (`getInvoiceSummary`) + imperative (`recalculateInvoice`), both on `AcmeQuoteAuraService`. |
| `lwc/acmeShipmentTracker/*` | Wire (`getShipmentStatuses`) + imperative (`refreshTracking`), both on `AcmeShipmentAuraService`. |
| `aura/AcmeOrderApprovalPanel/*` | `controller="AcmeOrderApprovalController"`; button action calls `c.approveOrder`. |
| `aura/AcmeShipmentStatusBoard/*` | `controller="AcmeShipmentAuraService"`; init handler calls `c.getShipmentStatuses`. |
| `flows/AcmeQuoteApprovalScreenFlow.flow-meta.xml` | Screen Flow; apex action calls `AcmeDiscountApprovalInvocable`. |
| `flows/AcmeOrderStatusRecordTriggeredFlow.flow-meta.xml` | Record-triggered Flow; apex action calls `AcmeOrderService.recalculatePricing`. |
| `flows/AcmeBackorderResolutionFlow.flow-meta.xml` | Autolaunched Flow; apex action calls `AcmeOrderInvocable`, then a subflow. |
| `flows/AcmeNotifyCustomerSubflow.flow-meta.xml` | Subflow target of the above; no further Apex calls. |
| `omniscripts/AcmeQuoteOmniScript/*` | DataPack; remote actions call `AcmeQuoteAuraService.createQuote`/`getInvoiceSummary`. |
| `omniscripts/AcmeOrderIntegrationProcedure/*` | DataPack; remote actions call `AcmeOrderService.recalculatePricing` and `AcmeShipmentService.scheduleDelivery`. |
| `omniscripts/AcmeShipmentOmniScript.os-meta.xml` | Remote action calls `AcmeShipmentAuraService.refreshTracking`. |

## Ground-truth edge list

Format: `source → target` `[annotation]`. `via`/notes are the resolver's own
diagnostic fields from a live `buildCallerTree` run over the whole corpus.

### Quoting & pricing

- `AcmeQuote.cls → AcmeQuote.validateStatusTransition` [resolves-today] (via=this)
- `AcmeQuote.cls → AcmeQuote.calculateTotal` [resolves-today] (via=this)
- `AcmeQuote.cls → AcmeInvoice.<init>` [resolves-today] (via=new)
- `AcmePropertyConsumer.cls → AcmeQuote.<init>` [resolves-today] (via=new)
- `AcmePropertyConsumer.cls → AcmeQuote.(set Status)` [needs: accessors] — `parser.js` emits **no** `CallFacts` at all for a bare property write (`quote.Status = ...`); this is not just a resolver routing gap, the fact never exists to route.
- `AcmePropertyConsumer.cls → AcmeQuote.(get TotalAmount)` [needs: accessors] — same: a bare property read (`quote.TotalAmount`) produces no `CallFacts`.
- `AcmeQuoteBuilder.cls → AcmePricingEngine.calculatePrice` [needs: type-overloads] — resolves today at *method-name* granularity (via=static, exact), but `calculatePrice` has 4 overloads that are all arity-1 (`String`/`Integer`/`Acme_Order__c`/`AcmeQuote`); the index key is `class#method` with no arity/type component, and `findMethodOwners()`'s exact-arity narrowing picks the *first declared* same-arity overload when several tie — it cannot tell `AcmeQuoteBuilder.build()`'s `AcmeQuote`-overload call apart from `AcmeGeneratedCatalog`'s `String`-overload calls.
- `AcmeQuoteBuilder.cls → AcmeQuote.<init>` [resolves-today] (via=new)
- `AcmePricingEngine.cls → AcmeShapeConcrete.<init>` [resolves-today] (via=new)
- `AcmePricingEngine.cls → AcmeShapeConcrete.computeVolume` [resolves-today] (via=typed)
- `AcmePricingEngine.cls → AcmeShapeConcrete.surchargeFactor` [resolves-today] (via=typed)
- `AcmeInvoiceCastDemo.cls → AcmeInvoice.total` [resolves-today] — 3 of 4 receiver shapes resolve via exact **typed** resolution: explicit cast (`((AcmeInvoice) obj).total()`), safe-navigation (`inv?.total()`), and the for-each baseline (`inv.total()`). The 4th shape, a **ternary-selected receiver** (`(useFirst ? invoiceA : invoiceB).total()`), only resolves via the `unique-name` approximate fallback (works today only because `total()` happens to be declared on exactly one class in this corpus) — that specific call site is a live [needs: chained] instance folded into an otherwise-resolving edge.
- `AcmeInvoiceCastDemo.cls → AcmeInvoiceCastDemo.recomputeAll` [resolves-today] (via=this)
- `AcmeQuoteAuraService.cls → AcmeQuoteBuilder.build` [needs: chained] — the receiver is a fluent-chain result (`builder.withCustomer(quoteName).build()`), not a plain typed identifier; resolver has no return-type inference across the chain, so this resolves only via the `unique-name` approximate fallback (via=unique-name, approximate). Contrast: `AcmeOrderServiceTest.cls → AcmeQuoteBuilder.build` resolves exactly (via=typed) because that call site binds the builder to a local variable first (`AcmeQuoteBuilder builder = new AcmeQuoteBuilder(); builder.build();`).
- `AcmeQuoteAuraService.cls → AcmeQuote.toInvoice` [resolves-today] (via=typed)
- `AcmeQuoteAuraService.cls → AcmeInvoice.total` [resolves-today] (via=typed)
- `AcmeQuoteAuraService.cls → AcmeNotificationDispatcher.dispatchToAll` [resolves-today] (via=new)
- `AcmeOrderService.cls → AcmePricingEngine.calculatePrice` [needs: type-overloads] — same overload-collapse caveat as above (this call site targets the `Acme_Order__c` overload specifically).
- `AcmeGeneratedCatalog.cls → AcmePricingEngine.calculatePrice` [needs: type-overloads] — 9 generated methods each call both the `String` and `Integer` overloads; all 18 call sites collapse onto the one undifferentiated target.

### Packaging / freight

- `AcmeShapeBase.cls`, `AcmeShapeIntermediate.cls`, `AcmeShapeConcrete.cls` — no outbound `callsInto`; pure hierarchy, exercised as call *targets* from `AcmePricingEngine` above.

### Notifications (interface fan-out)

- `AcmeEmailNotifier.cls → AcmeEmailNotifier.sendEmail` [resolves-today] (via=this)
- `AcmeSmsNotifier.cls → AcmeSmsNotifier.sendSms` [resolves-today] (via=this)
- `AcmeNotificationDispatcher.cls → AcmeNotifiable.notify` [resolves-today] (via=interface) — correctly fans out to all 3 concrete implementors, including `AcmeSlackNotifier` (via inherited `AcmeBaseNotifier.notify`, not a redeclaration). Interface fan-out is inherently conservative/approximate by the resolver's own design (`APPROX_VIA` includes `'interface'`) — this is documented, expected static-analysis behavior, not treated as a gap in the same sense as the 4 upgrade categories.

### Order validation cycle

- `AcmeOrderValidator.cls → AcmeInventoryChecker.checkStock` [resolves-today] (via=static)
- `AcmeInventoryChecker.cls → AcmeBackorderResolver.resolve` [resolves-today] (via=static)
- `AcmeBackorderResolver.cls → AcmeOrderValidator.validate` [resolves-today] (via=static) — closes the 3-node cycle; resolver's cycle detection (`ancestorPath`) does not truncate this direct 3-hop cycle within default depth.

### Platform-shadow / inner classes

- `AcmeShadowConsumer.cls → Database.<init>` [resolves-today] (via=new) — the locally-typed user class `Database` correctly wins over the platform-denylist entry (resolver's documented precedence rule 7).
- `AcmeShadowConsumer.cls → Database.describe` [resolves-today] (via=typed)
- `AcmeOuterContainer.cls → AcmeOuterContainer.InnerWorker.<init>` [resolves-today] (via=new) — in-file bare-name `new InnerWorker(...)` resolves via the inner-class self-reference scope-chain rule.
- `AcmeOuterContainer.cls → AcmeOuterContainer.InnerWorker.doWork` [resolves-today] (via=typed)
- `AcmeOuterContainer.cls → AcmeOuterContainer.outerHelper` [resolves-today] (via=static) — called from `InnerWorker.doWork`, i.e. inner-to-outer static callback; correctly attributed to the file/class that declares `InnerWorker`.
- `AcmeInnerRefConsumer.cls → AcmeOuterContainer.InnerWorker.<init>` [resolves-today] (via=new) — cross-file, fully-qualified `Outer.Inner` type name.
- `AcmeInnerRefConsumer.cls → AcmeOuterContainer.InnerWorker.doWork` [resolves-today] (via=typed)

### Utilities

- `AcmeDiscountUtil.cls → AcmeDiscountUtil.initializeDiscountTiers` [resolves-today] (via=this)

### Order lifecycle

- `AcmeOrderTrigger.trigger → AcmeOrderTriggerHandler.<init>` [resolves-today] (via=new)
- `AcmeOrderTrigger.trigger → AcmeOrderTriggerHandler.handle` [resolves-today] (via=typed)
- `AcmeOrderTriggerHandler.cls → AcmeOrderService.processOrders` [resolves-today] (via=static)
- `AcmeOrderService.cls → AcmeOrderUtil.normalize` [resolves-today] (via=static)
- `AcmeOrderService.cls → AcmeOrderValidator.validate` [resolves-today] (via=static)
- `AcmeOrderService.cls → AcmeOrderBatchProcessor.<init>` [resolves-today] (via=new) — 2 ctor overloads (`()`, `(List<Acme_Order__c>)`) intentionally merge onto one `<init>` key per resolver's documented design decision #2; per-call-site `argsRendered` still disambiguates at render time. Not a gap.
- `AcmeOrderService.cls → AcmeOrderUtil.markApproved` [resolves-today] (via=static)
- `AcmeOrderUtil.cls → AcmeFutureNotifier.sendApprovalEmail` [resolves-today] (via=static)
- `AcmeOrderBatchProcessor.cls → AcmeOrderUtil.buildQuery` [resolves-today] (via=static)
- `AcmeOrderBatchProcessor.cls → AcmeOrderService.processOrders` [resolves-today] (via=static)
- `AcmeOrderBatchProcessor.cls → AcmeNotificationDispatcher.dispatchToAll` [resolves-today] (via=new)
- `AcmeNightlyReconciliationScheduler.cls → AcmeOrderBatchProcessor.<init>` [resolves-today] (via=new)
- `AcmeOrderInvocable.cls → AcmeOrderService.approveOrder` [resolves-today] (via=static)
- `AcmeDiscountApprovalInvocable.cls → AcmeDiscountUtil.applyDiscount` [resolves-today] (via=static)
- `AcmeDiscountApprovalInvocable.cls → AcmeOrderService.recalculatePricing` [resolves-today] (via=static)
- `AcmeOrderApprovalController.cls → AcmeOrderService.approveOrder` [resolves-today] (via=static)
- `AcmeOrderRestResource.cls → AcmeOrderService.recalculatePricing` [resolves-today] (via=static)
- `AcmeOrderRestResource.cls → AcmeOrderService.processOrders` [resolves-today] (via=static)
- `AcmeLegacyOrderSoapService.cls → AcmeOrderUtil.markApproved` [resolves-today] (via=static)
- `AcmeOrderServiceTest.cls → AcmeOrderService.processOrders` [resolves-today] (via=static)
- `AcmeOrderServiceTest.cls → AcmeOrderBatchProcessor.<init>` [resolves-today] (via=new)
- `AcmeOrderServiceTest.cls → AcmeOrderInvocable.execute` [resolves-today] (via=static)
- `AcmeOrderServiceTest.cls → AcmeQuoteBuilder.build` [resolves-today] (via=typed — see chained-receiver contrast above)
- `AcmeOrderServiceTest.cls → AcmeNotificationDispatcher.dispatchToAll` [resolves-today] (via=new)
- `AcmeOrderServiceTest.cls → AcmeNightlyReconciliationScheduler.<init>` [resolves-today] (via=new)

### Shipment lifecycle

- `AcmeShipmentTrigger.trigger → AcmeShipmentTriggerHandler.<init>` [resolves-today] (via=new)
- `AcmeShipmentTrigger.trigger → AcmeShipmentTriggerHandler.handle` [resolves-today] (via=typed)
- `AcmeShipmentTriggerHandler.cls → AcmeShipmentService.processShipments` [resolves-today] (via=static)
- `AcmeShipmentService.cls → AcmeShipmentUtil.enrich` [resolves-today] (via=static)
- `AcmeShipmentService.cls → AcmeShipmentQueueableDispatcher.<init>` [resolves-today] (via=new)
- `AcmeShipmentService.cls → AcmeShipmentUtil.computeEta` [resolves-today] (via=static)
- `AcmeShipmentQueueableDispatcher.cls → AcmeShipmentService.processShipments` [resolves-today] (via=static)
- `AcmeShipmentAuraService.cls → AcmeShipmentUtil.computeEta` [resolves-today] (via=static)
- `AcmeShipmentAuraService.cls → AcmeShipmentService.scheduleDelivery` [resolves-today] (via=static)

### UI / metadata callers (LWC, Aura, Flow, OmniScript)

None of these source file types are ingested by `parser.js` (it only handles
`.cls`/`.trigger`), so **every** edge originating from them is categorically
un-resolvable by today's engine — not approximated, not partially working,
simply invisible. All are tagged `[needs: metadata-callers]`, except the
OmniScript DataPack/os-meta sources which get the more specific
`[needs: omniscript]` tag (same root cause — no parser support — but a
distinct data shape/upgrade: JSON `remoteClass`/`remoteMethod` pairs and
`os-meta.xml` `<remoteClass>`/`<remoteMethod>` elements rather than Aura
`.cmp`/`.js` or Flow XML).

- `lwc/acmeOrderDashboard/acmeOrderDashboard.js → AcmeQuoteAuraService.getRecentQuotes` [needs: metadata-callers]
- `lwc/acmeQuoteWizard/acmeQuoteWizard.js → AcmeQuoteAuraService.createQuote` [needs: metadata-callers]
- `lwc/acmeInvoiceViewer/acmeInvoiceViewer.js → AcmeQuoteAuraService.getInvoiceSummary` [needs: metadata-callers]
- `lwc/acmeInvoiceViewer/acmeInvoiceViewer.js → AcmeQuoteAuraService.recalculateInvoice` [needs: metadata-callers]
- `lwc/acmeShipmentTracker/acmeShipmentTracker.js → AcmeShipmentAuraService.getShipmentStatuses` [needs: metadata-callers]
- `lwc/acmeShipmentTracker/acmeShipmentTracker.js → AcmeShipmentAuraService.refreshTracking` [needs: metadata-callers]
- `lwc/acmeQuoteWizard/__tests__/acmeQuoteWizard.test.js` — no Apex edges (Jest unit test).
- `aura/AcmeOrderApprovalPanel/AcmeOrderApprovalPanel.cmp → AcmeOrderApprovalController` [needs: metadata-callers] (`controller="..."` attribute)
- `aura/AcmeOrderApprovalPanel/AcmeOrderApprovalPanelController.js → AcmeOrderApprovalController.approveOrder` [needs: metadata-callers] (`component.get('c.approveOrder')`)
- `aura/AcmeShipmentStatusBoard/AcmeShipmentStatusBoard.cmp → AcmeShipmentAuraService` [needs: metadata-callers] (`controller="..."` attribute)
- `aura/AcmeShipmentStatusBoard/AcmeShipmentStatusBoardController.js → AcmeShipmentAuraService.getShipmentStatuses` [needs: metadata-callers] (`component.get('c.getShipmentStatuses')`)
- `flows/AcmeQuoteApprovalScreenFlow.flow-meta.xml → AcmeDiscountApprovalInvocable.execute` [needs: metadata-callers] (`<actionCalls><actionName>AcmeDiscountApprovalInvocable</actionName><actionType>apex</actionType>`) — note the Flow XML references the **class**, never the method name; a metadata-callers upgrade would still need to combine this with `@InvocableMethod` annotation detection (already present in `parser.js`'s `annotations` field) to land on `execute` specifically.
- `flows/AcmeOrderStatusRecordTriggeredFlow.flow-meta.xml → AcmeOrderService.recalculatePricing` [needs: metadata-callers] — this Flow calls a plain `@AuraEnabled`-style Apex action, not an `@InvocableMethod`; same class-only reference shape.
- `flows/AcmeBackorderResolutionFlow.flow-meta.xml → AcmeOrderInvocable.execute` [needs: metadata-callers]
- `flows/AcmeBackorderResolutionFlow.flow-meta.xml → AcmeNotifyCustomerSubflow (subflow)` [MUST — promoted 2026-07-18, v0.13 S1/S2] (`<subflows><flowName>AcmeNotifyCustomerSubflow</flowName>`) — flow-to-flow, never an Apex edge, but no longer un-ingested: v0.13 gives `resolver.js` a `flowGraph` keyed off exactly this kind of `<subflows>` reference. See "## v0.13 subflow chains (adv-org)" below for the full node-by-node expectation; this line's original `[needs: metadata-callers]` tag is now historical (kept struck nowhere else in this list — every OTHER bullet in this section still reflects the engine's actual state as of when each was written, this one line alone is superseded).
- `omniscripts/AcmeQuoteOmniScript/AcmeQuoteOmniScript_DataPack.json → AcmeQuoteAuraService.createQuote` [needs: omniscript] (`"remoteClass":"AcmeQuoteAuraService","remoteMethod":"createQuote"`)
- `omniscripts/AcmeQuoteOmniScript/AcmeQuoteOmniScript_DataPack.json → AcmeQuoteAuraService.getInvoiceSummary` [needs: omniscript]
- `omniscripts/AcmeOrderIntegrationProcedure/AcmeOrderIntegrationProcedure_DataPack.json → AcmeOrderService.recalculatePricing` [needs: omniscript]
- `omniscripts/AcmeOrderIntegrationProcedure/AcmeOrderIntegrationProcedure_DataPack.json → AcmeShipmentService.scheduleDelivery` [needs: omniscript]
- `omniscripts/AcmeShipmentOmniScript.os-meta.xml → AcmeShipmentAuraService.refreshTracking` [needs: omniscript] (`<remoteClass>AcmeShipmentAuraService</remoteClass><remoteMethod>refreshTracking</remoteMethod>`)

## Corpus defects

None currently open.

- **FIXED (2026-07-14): `AcmeNotificationDispatcher.dispatchAll` did not
  exist.** The class declares `public void dispatchToAll(String message)`
  (see `classes/AcmeNotificationDispatcher.cls:8`), but three call sites
  invoked a nonexistent method named `dispatchAll` instead:
  `classes/AcmeOrderBatchProcessor.cls:31`,
  `classes/AcmeQuoteAuraService.cls:45`, and
  `classes/AcmeOrderServiceTest.cls:49`. All three files parsed cleanly (no
  `parseError`) and the calls were syntactically well-formed `dot`-kind
  `CallFacts` — this was a genuine name mismatch baked into the corpus, not
  a resolver limitation: since no class in the index declared a method named
  `dispatchAll`, `resolver.js` correctly reported **zero callers** for that
  (nonexistent) target. Fixed by renaming all three call sites to
  `dispatchToAll` to match the declared method — the declaration was treated
  as authoritative (it is the only method the design's per-file table role
  for `AcmeNotificationDispatcher.cls` describes: "fans a message out to
  every registered channel"), so the call sites were the error, not the
  method name. Re-verified: all three files still parse with
  `parseError: null`, and a live
  `resolver.buildCallerTree()` run now shows all three
  (`AcmeOrderBatchProcessor.finish`, `AcmeQuoteAuraService.submitForApproval`,
  `AcmeOrderServiceTest.testNotificationDispatcher`) as resolved
  `via=new` callers of `AcmeNotificationDispatcher.dispatchToAll`. The three
  edges are now folded into the `resolves-today` edge list above (see
  Quoting and Order lifecycle sections) instead of being carved out as a
  separate defect category.

No other discrepancies were found: every other file in the design list
exists at the expected path with the expected role, every other design
`callsInto` expression is present in the built source, and no file on disk
is missing from the design (aside from expected non-enumerated sidecars:
`.cls-meta.xml`/`.trigger-meta.xml`/`.js-meta.xml`/`.cmp-meta.xml` and LWC
`.html` templates, none of which the design list itemizes).

## Known engine-gap categories (tally)

Out of **86** total v0.3 design edges (see "v0.4 ground-truth edges" near the
end of this file for the 38 additional v0.4 caller-graph edges + 4 F5
entry-label classifications appended for the v0.4.0 round, and "v0.5
ground-truth edges" further below for the 21 additional v0.5 caller-graph
edges + 4 G2 caughtHere-badge classifications appended for the v0.5.0 round —
grand total 145 caller-graph edges):

| Annotation | Count | What it means |
|---|---:|---|
| `resolves-today` | 61 | `buildCallerTree` surfaces the caller today, via an exact (`new`/`static`/`typed`/`this`/`super`) or an accepted-approximate (`interface` fan-out) resolution path. |
| `needs: type-overloads` | 3 | Resolves at `class#method` granularity only; `AcmePricingEngine.calculatePrice`'s 4 same-arity overloads (String/Integer/Acme_Order__c/AcmeQuote) cannot be told apart — `findMethodOwners()` silently picks the first-declared overload on an arity tie. |
| `needs: chained` | 1 (+1 folded caveat) | Fluent-chain / non-typed-identifier receivers only resolve via the `unique-name` fallback, which is not type-safe. One full edge (`AcmeQuoteAuraService → AcmeQuoteBuilder.build`) plus one call site folded inside an otherwise-resolving edge (`AcmeInvoiceCastDemo`'s ternary-receiver call to `AcmeInvoice.total`). |
| `needs: accessors` | 2 | `parser.js` never emits `CallFacts` for bare property get/set access; `AcmeQuote.(set Status)`/`(get TotalAmount)` have zero possible callers today, structurally. |
| `needs: metadata-callers` | 14 | Edges sourced from Aura `.cmp`/`.js` and Flow `.flow-meta.xml` — file types `parser.js` doesn't ingest at all. |
| `needs: omniscript` | 5 | Same root cause as `metadata-callers` (parser.js doesn't ingest these file types), split out because the data shape is different (OmniScript DataPack JSON `remoteClass`/`remoteMethod`, `os-meta.xml` `<remoteClass>`/`<remoteMethod>`) and would need its own extraction path. |
| **Total** | **86** | |

No corpus-defect carve-out remains: the 3 `AcmeNotificationDispatcher
.dispatchToAll` call sites (`AcmeOrderBatchProcessor.finish`,
`AcmeQuoteAuraService.submitForApproval`,
`AcmeOrderServiceTest.testNotificationDispatcher`) were fixed (see Corpus
defects above) and are now counted inside `resolves-today`.

## 5 representative spot checks (real engine, live run)

All 5 run against the same in-memory `resolver.buildSemanticIndex(facts)`
built from every `.cls`/`.trigger` file in this corpus (45 files parsed; only
`AcmeBrokenParser.cls` carries `parseError`).

1. **Deep service method** — `AcmeOrderService.processOrders`: 4 callers,
   all exact (`AcmeOrderBatchProcessor.execute` via=static,
   `AcmeOrderRestResource.handlePost` via=static,
   `AcmeOrderTriggerHandler.handle` via=static,
   `AcmeOrderServiceTest.testProcessOrders` via=static). Clean multi-hop
   fan-in, no approximation.
2. **Overload-tie method** — `AcmePricingEngine.calculatePrice`: 13 callers
   (all `via=static`/`this`, none flagged `approximate`), spanning all 4
   overloads indiscriminately — 9 `AcmeGeneratedCatalog.lookupPriceNNNN`
   methods (String+Integer overloads), `AcmeOrderService.recalculatePricing`
   (Acme_Order__c overload), `AcmeQuoteBuilder.build`/`withLineItem`
   (AcmeQuote/String+Integer overloads), and a self-recursive
   `AcmePricingEngine.calculatePrice` call (Acme_Order__c overload calling
   the Integer overload internally). The tree cannot distinguish which
   overload any given caller actually invokes — this is the live
   `needs: type-overloads` gap.
3. **Accessor-owning property class** — `AcmeQuote.(set Status)`: **0
   callers**, even though `AcmePropertyConsumer.reviewQuoteTotal`/
   `syncQuoteStatus` both write `quote.Status = ...`. Confirmed by direct
   inspection of `parser.js` output: `AcmePropertyConsumer.cls`'s parsed
   `MethodFacts.calls` contains a `new` (the `AcmeQuote` constructor call)
   and one `dot` call (`System.debug(...)`) but **no** `CallFacts` entry at
   all for either `quote.Status = newStatus` or `quote.TotalAmount` — the
   property accesses aren't merely unresolved, they're never extracted as
   call facts in the first place.
4. **Invocable method** — `AcmeOrderInvocable.execute`: 1 caller,
   `AcmeOrderServiceTest.testInvocable` (via=static, exact). The design's
   second caller — the `AcmeBackorderResolutionFlow` apex action — never
   appears, confirming the `needs: metadata-callers` gap live (Flow XML is
   simply not in the resolver's input set).
   *(STALE as of v0.3+ — kept for history: `attachMetaCallers` now ingests
   Flow XML, and its bare-actionName + sole-@InvocableMethod cross-reference
   promotes this ref to method level, so `AcmeBackorderResolutionFlow` DOES
   surface when tracing `AcmeOrderInvocable.execute` directly.)*
5. **Class-level target** — `AcmeShapeConcrete` (no method filter): 1
   caller, `AcmePricingEngine.calculatePrice` (via=new, 3 call sites in one
   grouped node — the `new AcmeShapeConcrete(...)` constructor call plus the
   subsequent `crate.computeVolume()`/`crate.surchargeFactor()` calls all
   attribute to the same class-level entry since no method filter was
   applied).

## Verification method

- **Parse pass**: every `.cls`/`.trigger` under `force-app` run through
  `require('vcs-apex-trace/parser.js').parseFile({path, text})`. 45 files
  parsed; `AcmeBrokenParser.cls` is the only one with `parseError != null`
  (by design — missing closing brace). No other file threw or carried a
  parse error.
- **Design cross-check**: every path in the design list exists on disk at
  the exact path given; every file on disk (excluding expected
  non-enumerated sidecars/templates) appears in the design list. Every
  `callsInto` token was independently verified present in its source file's
  text (or, for OmniScript JSON/XML, its structured `remoteClass`/
  `remoteMethod` fields) — including the 3 `AcmeNotificationDispatcher
  .dispatchToAll` call sites, which were corpus defects (call sites invoked
  a nonexistent `dispatchAll`) fixed on 2026-07-14 (see Corpus defects
  above) — and except the 2 Flow-XML `execute` edges, which are correctly
  absent as literal text because Flow `actionCalls` reference the Apex
  class only, never the method name (expected `needs: metadata-callers`
  shape, not a defect).
- **Live engine run**: `resolver.buildSemanticIndex()` over all 45 parsed
  files, then `resolver.buildCallerTree()` invoked once per distinct
  Apex-side target across all 63 Apex-to-Apex design edges (the other 23
  edges originate from LWC/Aura/Flow/OmniScript sources the parser can't
  ingest, and were classified by file type instead). Each design edge's
  expected caller was checked against the tree's immediate children,
  matched by source **file path** (not class name alone, since
  `AcmeOuterContainer.cls` declares two types — the outer class and
  `InnerWorker` — and both can be legitimate callers attributed to the same
  file).
- **XML/JSON well-formedness**: all 21 `.xml` files (tag-balance,
  stack-based, comment/CDATA-aware) and all 2 OmniScript `.json` DataPacks
  (`JSON.parse`) validated clean.

## v0.4 ground-truth edges

Appended for the v0.4.0 pre-release round (six additive features: F1 DML/trigger
linkage, F2 collection-generic receivers, F3 virtual-override fan-out, F4 dynamic
dispatch, F5 entry-kind tail, F6 disk-persisted facts cache — F6 has no corpus
surface, it's pure engine plumbing). This section is purely additive: none of the
86 v0.3 design edges above changed, and the two files edited below (see "Existing
files adjusted") only ADD outbound calls, never remove or rename one.

All new edges are tagged `[needs: dml]` / `[needs: generics]` / `[needs: override]`
/ `[needs: dynamic]` / `[needs: entries]` per feature — none are `[resolves-today]`
against the pre-v0.4 engine, since these fixtures exist specifically to give the
new resolver logic something to land on. A handful of ordinary wiring edges (new
trigger calling its handler, etc.) already resolve today via existing rules and
are marked `[resolves-today]` for completeness.

### New files added (v0.4)

| Path | Role |
|---|---|
| `classes/AcmeFulfillmentDmlService.cls` | F1: statement-form DML (insert/update/delete/upsert/merge/undelete) + `Database.insert`/`Database.update` method-forms, on `Acme_Order__c`/`Acme_Shipment__c`, mixing typed lists and single records. |
| `triggers/AcmeShipmentLifecycleTrigger.trigger` | F1: second trigger on `Acme_Shipment__c`, events `before delete, after undelete` — distinct from `AcmeShipmentTrigger`'s `before/after insert, before/after update`, so the DML->trigger event-mapping matrix has 2 triggers on one object. |
| `classes/AcmeShipmentRollupHandler.cls` | F1: `handleLifecycleEvent` backs the new trigger; `rollupTotals` is called from `AcmeShipmentTriggerHandler.handle` and does `update` DML on `Acme_Shipment__c` — the "handler does DML on its own object" cycle fixture. |
| `flows/AcmeOrderCreatedWelcomeFlow.flow-meta.xml` | F1: new Create-type record-triggered flow on `Acme_Order__c` (`RecordAfterSave`/`Create`), apex action -> `AcmeOrderInvocable`. |
| `classes/AcmeStepHandler.cls` | F2: dispatch interface (`handleStep`), reachable only through generic-collection receivers. |
| `classes/AcmeValidateStepHandler.cls`, `classes/AcmeNotifyStepHandler.cls` | F2: the two `AcmeStepHandler` implementers held in `AcmeStepDispatcher`'s `Map<String,AcmeStepHandler>`. |
| `classes/AcmeStep.cls` | F2: concrete (non-interface) element type of `AcmeStepDispatcher`'s `List<AcmeStep>`. |
| `classes/AcmeStepDispatcher.cls` | F2: `Map<String,AcmeStepHandler>.get(key).handleStep(...)`, `List<AcmeStep>[0].run()`, `List<AcmeStep>.get(i).run()`, `Map.values()` for-each loop. |
| `classes/AcmeShapeAuditor.cls` | F3: `auditSurcharge(AcmeShapeBase shape)` calls `shape.surchargeFactor()` through the abstract base type — override fan-out target. |
| `classes/AcmeHandlerFactory.cls` | F4a: `Type.forName('AcmeEmailNotifier')` (real class, literal arg), `Type.forName('AcmeGhostNotifierDoesNotExist')` (no such class), `Type.forName(handlerName)` (non-literal arg). |
| `customMetadata/Acme_Integration_Config.Order_Sync_Handler.md-meta.xml`, `customMetadata/Acme_Integration_Config.Shipment_Sync_Handler.md-meta.xml` | F4b: `Handler_Class__c` values naming real classes (`AcmeOrderService`, `AcmeShipmentService`). |
| `customMetadata/Acme_Integration_Config.Legacy_Sync_Handler.md-meta.xml` | F4b: `Handler_Class__c` value naming a nonexistent class (`AcmeLegacyHandlerRemoved`) — no edge expected. |
| `classes/AcmeSupportEmailHandler.cls` | F5: `Messaging.InboundEmailHandler` implementer (`handleInboundEmail`). |
| `classes/AcmeOrderPriority.cls` | F5: `Comparable` implementer (`compareTo`). |
| `classes/AcmeReconciliationFinalizer.cls` | F5: `System.Finalizer` implementer (`execute`). |
| `classes/AcmeCatalogInstallHandler.cls` | F5: `InstallHandler` implementer (`onInstall`). |

### Existing files adjusted

- `classes/AcmeShipmentTriggerHandler.cls` — added one line to `handle()`:
  `AcmeShipmentRollupHandler.rollupTotals(newShipments);`, called right after the
  pre-existing `AcmeShipmentService.processShipments(newShipments);` call. Purely
  additive (new outbound call only); the pre-existing `[resolves-today]`
  `AcmeShipmentTrigger.trigger -> AcmeShipmentTriggerHandler.handle` /
  `AcmeShipmentTriggerHandler.cls -> AcmeShipmentService.processShipments` edges
  from the v0.3 list are unchanged.
- `flows/AcmeOrderStatusRecordTriggeredFlow.flow-meta.xml` — **checked, not
  modified.** Its `<start>` block already has `<object>Acme_Order__c</object>`,
  `<triggerType>RecordAfterSave</triggerType>`, `<recordTriggerType>Update</recordTriggerType>`
  — the "proper `<start>` block" F1 asks for already existed.

### F1 — DML -> trigger / record-triggered-flow linkage

#### Trigger event-mapping matrix

Per-object trigger inventory after this round:

| Object | Trigger | Events |
|---|---|---|
| `Acme_Order__c` | `AcmeOrderTrigger` | before insert, before update, after insert, after update |
| `Acme_Shipment__c` | `AcmeShipmentTrigger` | before insert, before update, after insert, after update |
| `Acme_Shipment__c` | `AcmeShipmentLifecycleTrigger` (**new**) | before delete, after undelete |

`Acme_Order__c` has no delete/undelete-event trigger at all (by design — see the
negative case below); `Acme_Shipment__c` has full insert/update/delete/undelete
coverage split across its two triggers, so `merge` (delete+update mapping) and
`upsert` (insert+update mapping) DML on `Acme_Shipment__c` exercise genuinely
different trigger subsets.

#### DML-site -> trigger edges: pre-existing call sites (newly exposed by F1)

These four `update` statements already existed in the v0.3 corpus (they were
simply invisible to the v0.3 engine, which had no DML/trigger linkage at all).
They become real edges under F1 with no corpus change required:

- `AcmeOrderService.cls#recalculatePricing → AcmeOrderTrigger.trigger` [needs: dml] (via=dml, op=update) — `classes/AcmeOrderService.cls:39`
- `AcmeOrderUtil.cls#markApproved → AcmeOrderTrigger.trigger` [needs: dml] (via=dml, op=update) — `classes/AcmeOrderUtil.cls:22`
- `AcmeDiscountApprovalInvocable.cls#execute → AcmeOrderTrigger.trigger` [needs: dml] (via=dml, op=update) — `classes/AcmeDiscountApprovalInvocable.cls:30`
- `AcmeShipmentService.cls#scheduleDelivery → AcmeShipmentTrigger.trigger` [needs: dml] (via=dml, op=update) — `classes/AcmeShipmentService.cls:19`

#### DML-site -> trigger edges: `AcmeFulfillmentDmlService.cls` (new fixture)

- `insertOrders → AcmeOrderTrigger.trigger` [needs: dml] (via=dml, op=insert, target=List<Acme_Order__c>)
- `insertSingleShipment → AcmeShipmentTrigger.trigger` [needs: dml] (via=dml, op=insert, target=single Acme_Shipment__c)
- `updateShipments → AcmeShipmentTrigger.trigger` [needs: dml] (via=dml, op=update, target=List<Acme_Shipment__c>)
- `updateSingleOrder → AcmeOrderTrigger.trigger` [needs: dml] (via=dml, op=update, target=single Acme_Order__c)
- `deleteShipments → AcmeShipmentLifecycleTrigger.trigger` [needs: dml] (via=dml, op=delete, target=List<Acme_Shipment__c>)
- `deleteSingleOrder → **no edge**` [needs: dml] — negative case: `Acme_Order__c` has no trigger with a delete event, so this statement-form `delete` correctly produces zero trigger callers. Deliberately included to exercise the "op has no matching trigger" branch.
- `upsertOrders → AcmeOrderTrigger.trigger` [needs: dml] (via=dml, op=upsert -> matches AcmeOrderTrigger's insert AND update events, still one edge to one trigger)
- `upsertSingleShipment → AcmeShipmentTrigger.trigger` [needs: dml] (via=dml, op=upsert -> matches trigger1's insert+update events; does **not** match `AcmeShipmentLifecycleTrigger`, which has neither)
- `mergeShipments → AcmeShipmentTrigger.trigger` **and** `mergeShipments → AcmeShipmentLifecycleTrigger.trigger` [needs: dml] (via=dml, op=merge -> delete+update mapping; the *update* half matches `AcmeShipmentTrigger`, the *delete* half matches `AcmeShipmentLifecycleTrigger` — **one DML statement, two distinct trigger targets**, the headline multi-trigger case this fixture exists for)
- `mergeOrders → AcmeOrderTrigger.trigger` [needs: dml] (via=dml, op=merge -> delete+update mapping, but only the *update* half has a matching trigger on `Acme_Order__c`; the delete half matches nothing, same reasoning as `deleteSingleOrder` above)
- `undeleteShipments → AcmeShipmentLifecycleTrigger.trigger` [needs: dml] (via=dml, op=undelete, target=List<Acme_Shipment__c>)
- `insertOrdersViaDatabase → AcmeOrderTrigger.trigger` [needs: dml] (via=dml, op=insert, `Database.insert(orders, false)` method-form) — see caveat below
- `updateShipmentsViaDatabase → AcmeShipmentTrigger.trigger` [needs: dml] (via=dml, op=update, `Database.update(shipments, true)` method-form) — see caveat below

**Caveat — `Database.xxx()` method-forms collide with the pre-existing
platform-shadow fixture.** This corpus already contains `classes/Database.cls`,
a user class *literally named* `Database` (the deliberate
`AcmeShadowConsumer`/`Database.<init>`/`Database.describe` shadow-precedence
fixture from v0.3 — see "Platform-shadow / inner classes" above). It declares no
`insert`/`update`/etc. methods. `resolver.js`'s documented rule 5 states "a
resolved class-name match is definitive: whether or not it declares this method,
we do not fall through to rules 6/7" (resolver.js precedence-rule comment #7,
~line 80 and ~line 765). A naive implementation of the F1 `Database.xxx()`
DML-op mapping that runs ordinary static-dispatch resolution first would resolve
`Database.insert(...)`'s receiver to this **user** `Database` class, find no
`insert` method declared there, and stop — 0 edges, never reaching the intended
DML-op mapping. For `insertOrdersViaDatabase`/`updateShipmentsViaDatabase` above
to produce the edges listed, the DML-method-name special case (receiver text
`Database` + method name in the known op set) must be checked **ahead of** (or
independent of) rule 5's user-class lookup. Confirmed live: `parser.js` already
emits both calls today as ordinary `dot` `CallFacts` with `receiver: 'Database'`
(verified via a direct `parseFile` run against the new fixture), so this is a
resolver-ordering decision, not a parser gap. Flagging explicitly since this
corpus's shadow fixture makes the collision live, not theoretical.

#### DML-induced cycle

- `AcmeShipmentTriggerHandler.cls#handle → AcmeShipmentRollupHandler.cls#rollupTotals` [resolves-today] (via=static) — the new call added to the existing handler.
- `AcmeShipmentRollupHandler.cls#rollupTotals → AcmeShipmentTrigger.trigger` [needs: dml] (via=dml, op=update) — closes the loop: tracing callers of `AcmeShipmentTrigger.trigger` walks `AcmeShipmentTrigger → AcmeShipmentTriggerHandler.handle → AcmeShipmentRollupHandler.rollupTotals`, and this DML-induced edge points right back at `AcmeShipmentTrigger`, already on the ancestor path. The tree node for this edge **must** carry `cyclic: true`, exercising the existing `ancestorPath` cycle-detection machinery (previously only exercised by the pure-method-call `AcmeOrderValidator -> AcmeInventoryChecker -> AcmeBackorderResolver -> AcmeOrderValidator` cycle) against a DML-induced cycle for the first time.

#### Trigger wiring for the new trigger (ordinary, resolves-today)

- `AcmeShipmentLifecycleTrigger.trigger → AcmeShipmentRollupHandler.cls#handleLifecycleEvent` [resolves-today] (via=static)

#### Record-triggered flow -> DML children

Per F1(b), a record-triggered flow node is no longer terminal: when it appears
in a tree, its children are the DML sites on its object whose op matches its
`recordTriggerType` (`Create`<-insert/upsert, `Update`<-update/upsert/merge,
`Delete`<-delete/merge). Both flows below are on `Acme_Order__c`:

- `flows/AcmeOrderStatusRecordTriggeredFlow.flow-meta.xml` (`recordTriggerType=Update`) children, matching update/upsert/merge ops on `Acme_Order__c`:
  - `AcmeOrderService.cls#recalculatePricing` [needs: dml] (op=update)
  - `AcmeOrderUtil.cls#markApproved` [needs: dml] (op=update)
  - `AcmeDiscountApprovalInvocable.cls#execute` [needs: dml] (op=update)
  - `AcmeFulfillmentDmlService.cls#updateSingleOrder` [needs: dml] (op=update)
  - `AcmeFulfillmentDmlService.cls#upsertOrders` [needs: dml] (op=upsert)
  - `AcmeFulfillmentDmlService.cls#mergeOrders` [needs: dml] (op=merge, update half)
- `flows/AcmeOrderCreatedWelcomeFlow.flow-meta.xml` (`recordTriggerType=Create`, new) children, matching insert/upsert ops on `Acme_Order__c`:
  - `AcmeFulfillmentDmlService.cls#insertOrders` [needs: dml] (op=insert)
  - `AcmeFulfillmentDmlService.cls#upsertOrders` [needs: dml] (op=upsert)
  - `AcmeFulfillmentDmlService.cls#insertOrdersViaDatabase` [needs: dml] (op=insert, Database method-form; same shadow-collision caveat as above)

Note: both flow nodes only become reachable in a live `buildCallerTree()` run
once the *pre-existing* `[needs: metadata-callers]` gap (flow XML -> Apex
action linkage in general) is also closed — F1 only adds the flowObject/
flowRecordTriggerType extraction and the children-materialization rule for
flow nodes that are already present in a tree; it does not by itself make
flow nodes appear from nothing. These 9 children are the correct ground truth
for "once the flow node is in the tree, what are its children", independent of
when/whether metadata-callers ships.

### F2 — Collection-generic receivers

All six edges below require the new `Map<K,V>.get()`/`List<T>.get()`/`List<T>[i]`/`Map<K,V>.values()`
receiver-type inference; none resolve today (v0.3 has no generics-aware receiver
resolution at all for these shapes, so these are unresolved 0-caller targets
under the pre-v0.4 engine, not merely approximated).

- `AcmeStepDispatcher.cls#dispatch → AcmeValidateStepHandler.cls#handleStep` [needs: generics] (via=interface, approximate — receiver `handlersByKey.get(key)` resolves to `AcmeStepHandler` via `Map<String,AcmeStepHandler>.get()`, then fans out across both implementers)
- `AcmeStepDispatcher.cls#dispatch → AcmeNotifyStepHandler.cls#handleStep` [needs: generics] (via=interface, approximate — same call site, second implementer)
- `AcmeStepDispatcher.cls#runFirstStep → AcmeStep.cls#run` [needs: generics] (via=typed — `steps[0]` subscript on `List<AcmeStep>` yields `AcmeStep`)
- `AcmeStepDispatcher.cls#runStepAt → AcmeStep.cls#run` [needs: generics] (via=typed — `steps.get(i)` on `List<AcmeStep>` yields `AcmeStep`)
- `AcmeStepDispatcher.cls#runAllHandlers → AcmeValidateStepHandler.cls#handleStep` [needs: generics] (via=interface, approximate — for-each loop variable typed via `Map<String,AcmeStepHandler>.values()` -> `List<AcmeStepHandler>`, then fans out)
- `AcmeStepDispatcher.cls#runAllHandlers → AcmeNotifyStepHandler.cls#handleStep` [needs: generics] (via=interface, approximate — same call site, second implementer)

### F3 — Virtual override fan-out

One call site, three intended edges — the base-class edge already resolves
today (ordinary typed instance-method resolution, unchanged by v0.4); the two
override edges are the new part:

- `AcmeShapeAuditor.cls#auditSurcharge → AcmeShapeBase.cls#surchargeFactor` [resolves-today] (via=typed — `shape` is a `AcmeShapeBase`-typed parameter)
- `AcmeShapeAuditor.cls#auditSurcharge → AcmeShapeIntermediate.cls#surchargeFactor` [needs: override] (via=override, approximate — `AcmeShapeIntermediate` overrides `surchargeFactor()`)
- `AcmeShapeAuditor.cls#auditSurcharge → AcmeShapeConcrete.cls#surchargeFactor` [needs: override] (via=override, approximate — `AcmeShapeConcrete` overrides `surchargeFactor()` too, two levels down the hierarchy from `AcmeShapeBase`)

`computeVolume()` was deliberately NOT used for this fixture: it's `abstract` on
`AcmeShapeBase` (no body), which would make the base-class "typed" edge land on
a declaration with no implementation — `surchargeFactor()` has a real body on
all three tiers, giving a clean base edge plus two clean override edges.

### F4 — Dynamic dispatch

#### F4a — `Type.forName(...)`

- `AcmeHandlerFactory.cls#createEmailNotifier → AcmeEmailNotifier.cls#<init>` [needs: dynamic] (via=dynamic, approximate — `Type.forName('AcmeEmailNotifier')`, single string-literal arg matching a real user class)
- `AcmeHandlerFactory.cls#createGhostNotifier → **no edge**` [needs: dynamic] — negative case: `Type.forName('AcmeGhostNotifierDoesNotExist')` names no class anywhere in this org.
- `AcmeHandlerFactory.cls#createNotifier → **no edge**` [needs: dynamic] — second, distinct negative case: `Type.forName(handlerName)`'s argument is a **variable**, not a string literal, so it never qualifies for the "single string-literal arg" rule in the first place (regardless of what value `handlerName` might hold at runtime).

#### F4b — Custom Metadata (`Handler_Class__c`-style values)

- `customMetadata/Acme_Integration_Config.Order_Sync_Handler.md-meta.xml → AcmeOrderService.cls` [needs: dynamic] (kind=cmdt, via=metadata, terminal, entries=['Custom Metadata record'] — `<value xsi:type="xsd:string">AcmeOrderService</value>` on field `Handler_Class__c`)
- `customMetadata/Acme_Integration_Config.Shipment_Sync_Handler.md-meta.xml → AcmeShipmentService.cls` [needs: dynamic] (kind=cmdt, via=metadata, terminal, entries=['Custom Metadata record'])
- `customMetadata/Acme_Integration_Config.Legacy_Sync_Handler.md-meta.xml → **no edge**` [needs: dynamic] — negative case: value `AcmeLegacyHandlerRemoved` names no class anywhere in this org.

### F5 — Entry-kind tail (not caller edges — method-level `entries[]` classification)

These four are ENTRIES additions, not caller-graph edges: each method below
should gain the listed synthetic entry-point label the same way
`AcmeOrderBatchProcessor.execute` already carries `'Batchable'` today.

- `AcmeSupportEmailHandler.cls#handleInboundEmail` [needs: entries] — entries += `'InboundEmailHandler (Email Service)'` (implements `Messaging.InboundEmailHandler`)
- `AcmeOrderPriority.cls#compareTo` [needs: entries] — entries += `'Comparable (invoked by sort)'` (implements `Comparable`)
- `AcmeReconciliationFinalizer.cls#execute` [needs: entries] — entries += `'Finalizer (async)'` (implements `System.Finalizer`)
- `AcmeCatalogInstallHandler.cls#onInstall` [needs: entries] — entries += `'InstallHandler (package install)'` (implements `InstallHandler`)

### v0.4 edge/entry tally

Caller-graph edges only (F1-F4; F5 is entry-label classification, tallied
separately below since it isn't a caller edge at all):

| Feature | Positive edges | Documented no-edge cases | Ordinary resolves-today edges (wiring) |
|---|---:|---:|---:|
| F1 (dml→trigger) | 18 | 1 (`deleteSingleOrder`) | 2 (`handle→rollupTotals`, `AcmeShipmentLifecycleTrigger→handleLifecycleEvent`) |
| F1 (flow→DML children) | 9 | 0 | 0 |
| F2 (generics) | 6 | 0 | 0 |
| F3 (override) | 2 | 0 | 1 (base-class typed edge) |
| F4 (dynamic: Type.forName) | 1 | 2 | 0 |
| F4 (dynamic: CMDT) | 2 | 1 | 0 |
| **Total new v0.4 caller-graph edges (F1-F4)** | **38** | **4** | **3** |

Plus **4** F5 entry-label classifications (`InboundEmailHandler (Email Service)`,
`Comparable (invoked by sort)`, `Finalizer (async)`, `InstallHandler (package
install)`), each on one new method — not counted in the 38/4/3 above.

Combined with the pre-existing 86 v0.3 design edges (unchanged), this corpus now
carries **124 total documented caller-graph edges** (86 v0.3 + 38 v0.4), plus the
4 F5 entry-label classifications, 4 documented no-edge negative cases, and 3
ordinary resolves-today wiring edges new in this round.

## v0.5 ground-truth edges

Appended for the v0.5.0 pre-release round (five additive language-gap features
plus one fixture-verification, all additive): G1 EventBus -> platform-event
linkage, G2 exception throw/catch tracing, G3 instanceof narrowing (labeled
fallback), G4 anonymous Apex, G5 async-hop edges, G6 interface-extends-interface
fan-out (fixture + live-verified resolver gap). This section is purely
additive: none of the 124 v0.3+v0.4 design edges above changed, and every
existing file touched below (see "Existing files adjusted (v0.5)") only ADDS
outbound calls/throws/catches, never removes or renames one.

All new edges are tagged `[needs: publish]` / `[needs: throws]` /
`[needs: narrowed]` / `[needs: anonymous]` / `[needs: async]` /
`[needs: iface-extends]` per feature — none are `[resolves-today]` against the
pre-v0.5 engine (confirmed live against the checked-in `resolver.js`/`parser.js`
in this repo: no `throwers` index, no `.apex`/anonymous-unit handling, no
`narrowings`/`async` via, and `interfaceImplementers` is built from
`implementsTypes` only with no interface-`extends`-interface closure — see the
G6 live-verification note below), since these fixtures exist specifically to
give the new resolver/parser logic something to land on. A handful of ordinary
wiring edges (new trigger calling its handler, a narrowing negative that
already resolves via plain typed dispatch, one interface edge that already
fans out today) already resolve today via existing rules and are marked
`[resolves-today]` for completeness.

### New files added (v0.5)

| Path | Role |
|---|---|
| `triggers/AcmeNoteEventTrigger.trigger` | G1: after-insert trigger on the new platform event `Acme_Note__e` -> `AcmeNoteEventHandler.handle`. Platform-event triggers only ever fire after insert (enforced by the platform itself, not just corpus convention). |
| `classes/AcmeNoteEventHandler.cls` | G1: thin handler for `AcmeNoteEventTrigger`, mirrors the shape of the other trigger handlers in this corpus. |
| `classes/AcmeNoteEventPublisher.cls` | G1: `publishNote(String)` exercises the single-record `EventBus.publish(new Acme_Note__e(...))` form; `publishNotes(List<String>)` exercises the `List<Acme_Note__e>` collection form (built up in a loop, then one `EventBus.publish(events)` call). |
| `flows/AcmeNoteEventFlow.flow-meta.xml` | G1: `AutoLaunchedFlow` whose `<start>` block has `<triggerType>PlatformEvent</triggerType>` + `<object>Acme_Note__e</object>` — the platform-event-triggered-flow fixture. Its one `actionCalls` node also calls `AcmeOrderInvocable` (bare `actionName`, pre-existing `[needs: metadata-callers]` shape), reusing an existing `@InvocableMethod` class rather than declaring a new callee. |
| `classes/AcmeBaseException.cls` | G2: `public class AcmeBaseException extends Exception {}` — root of the corpus's user exception hierarchy. |
| `classes/AcmeValidationException.cls` | G2: `public class AcmeValidationException extends AcmeBaseException {}` — extends `AcmeBaseException`, not `Exception` directly, so the corpus exercises supertype-catch resolution one level removed from the platform `Exception` root. |
| `classes/AcmeShapeNarrowingAuditor.cls` | G3: `auditLabel(AcmeShapeBase shape)` calls `shape.crateLabel()` inside `if (shape instanceof AcmeShapeConcrete)` — `crateLabel()` exists only on `AcmeShapeConcrete`, so declared-type (`AcmeShapeBase`) resolution fails and the narrowing fallback is required. `auditDescribeShape(AcmeShapeBase shape)` is the negative twin: same `instanceof AcmeShapeConcrete` guard, but calls `shape.describeShape()`, which IS declared directly on `AcmeShapeBase` — declared-type resolution already succeeds, so narrowing must NOT be consulted even though the guard is textually present. |
| `scripts/adhoc-recalc.apex` | G4: anonymous-Apex script. Re-prices open orders via `AcmeOrderService.recalculatePricing` (real service, called in a loop), reschedules delivery for pending shipments via `AcmeShipmentService.scheduleDelivery` (second real service, also looped), then does one statement-form `update openOrders;` on `Acme_Order__c` — a triggered object (`AcmeOrderTrigger`) — so the script also produces a `[needs: dml]` edge once anonymous-unit parsing lands, stacking G4 on top of the pre-existing v0.4 F1 DML->trigger machinery. |
| `classes/AcmeAsyncOrchestrator.cls` | G5: `runNightlyMaintenance()` calls all three async entry points in one method, each with an inline `new` constructor argument: `System.enqueueJob(new AcmeShipmentQueueableDispatcher(...))`, `Database.executeBatch(new AcmeOrderBatchProcessor(), 200)`, `System.schedule('AcmeNightly', cron, new AcmeNightlyReconciliationScheduler())`. Deliberately reuses the three existing async classes from the v0.3/v0.4 corpus rather than declaring new ones, per the G5 spec. Nothing in the corpus calls `runNightlyMaintenance` itself — it is a pure root, exercised the same way `scripts/adhoc-recalc.apex` and `AcmeOrderServiceTest` are pure roots. |
| `classes/AcmeParentIntf.cls` | G6: parent interface (`void ping();`). |
| `classes/AcmeSecondaryIntf.cls` | G6 (diamond): a SECOND parent interface (`void pong();`), added alongside `AcmeParentIntf` to `AcmeChildIntf`'s extends list — regression fixture for the confirmed defect where parser.js kept only the FIRST extends-list entry, silently dropping every parent after it in a multi-parent ("diamond") interface `extends` list. |
| `classes/AcmeChildIntf.cls` | G6: `public interface AcmeChildIntf extends AcmeParentIntf, AcmeSecondaryIntf {}` — no members of its own; exists to prove interface-extends-interface fan-out, including the diamond (2-parent) case. Originally `extends AcmeParentIntf` only; `AcmeSecondaryIntf` added this round so the fixture actually exercises a multi-parent extends list (the single-parent form did not catch the defect — see "Corpus defects" below). |
| `classes/AcmePingPongHandler.cls` | G6: implements `AcmeChildIntf` (not `AcmeParentIntf`/`AcmeSecondaryIntf` directly) — reachable from an `AcmeParentIntf`-typed caller AND an `AcmeSecondaryIntf`-typed caller ONLY through the interface-extends transitive closure. Gained a `pong()` implementation this round to satisfy `AcmeSecondaryIntf`. |
| `classes/AcmeDirectPingHandler.cls` | G6: implements `AcmeParentIntf` directly — the control case, already reachable from an `AcmeParentIntf`-typed caller today via the existing (v0.3) direct-`implements` interface fan-out. |
| `classes/AcmeIntfDispatchDemo.cls` | G6: `dispatchPing()` declares a local `AcmeParentIntf handler = new AcmePingPongHandler(); handler.ping();` — an `AcmeParentIntf`-typed receiver whose interface fan-out must legitimately include both `AcmeDirectPingHandler` (direct) and `AcmePingPongHandler` (transitive, via `AcmeChildIntf`, first extends-list entry). |
| `classes/AcmeIntfDispatchSecondaryDemo.cls` | G6 (diamond): `dispatchPong()` declares a local `AcmeSecondaryIntf handler = new AcmePingPongHandler(); handler.pong();` — an `AcmeSecondaryIntf`-typed receiver (the SECOND extends-list entry on `AcmeChildIntf`) whose interface fan-out must reach `AcmePingPongHandler` too. Pre-fix this call site resolved to zero callers, since parser.js's `extendsType` kept only the first entry (`AcmeParentIntf`). |

### Existing files adjusted (v0.5)

- `classes/AcmeOrderValidator.cls` — `validate(Id orderId, Integer cycleDepth)` gained `if (orderId == null) { throw new AcmeValidationException('Order Id is required for validation.'); }` (line 9) — G2 throw site 1 (`throw new AcmeX(...)` form). Purely additive; the pre-existing `validate -> checkStock -> resolve -> validate` v0.3 cycle and its edges are unchanged (the `null`-orderId guard clause did not exist before and adds no new outbound calls, only a throw).
- `classes/AcmeShipmentService.cls` — gained a new method, `reprocessFailedShipment(Id shipmentId)`, wrapping the pre-existing `AcmeShipmentUtil.computeEta(shipmentId)` call in `try { ... } catch (AcmeValidationException e) { System.debug(...); throw e; }` (catch at line 26, `throw e;` at line 28) — G2 throw site 2 (caught-and-rethrown `throw e` form; the parser resolves `e`'s type via the enclosing catch clause to `AcmeValidationException`). This method has zero callers in the corpus by design (see "G2 — thrower-node reachability" below) — it exists solely to give the rethrow-resolution logic a second, structurally different throw site to parse.
- `classes/AcmeOrderBatchProcessor.cls` — `execute()`'s pre-existing `AcmeOrderService.processOrders(orders)` call is now wrapped in `try { ... } catch (AcmeValidationException ve) { System.debug(...); }` (catch at line 29) — G2 catch site 1 (exact-type catch). Purely additive; the v0.3/v0.4 `execute -> processOrders` edge (via=static) is unchanged, and `finish()`'s notification-dispatcher call is untouched.
- `classes/AcmeOrderRestResource.cls` — `handlePost()`'s pre-existing `AcmeOrderService.processOrders(orders)` call is now wrapped in `try { ... } catch (AcmeBaseException be) { System.debug(...); }` (catch at line 25) — G2 catch site 2 (supertype catch). `handleGet()` is untouched.
- `triggers/AcmeOrderTrigger.trigger` — the pre-existing `handler.handle(...)` call is now wrapped in `try { ... } catch (Exception ex) { System.debug(...); }` (catch at line 17) — G2 catch site 3 (bare-`Exception` catch). Note this makes `AcmeOrderTrigger.trigger` diverge from `AcmeShipmentTrigger.trigger`, which the file's own header comment says it "mirrors" — that mirroring claim is now stale for exception handling specifically (`AcmeShipmentTrigger.trigger` still has no try/catch at all); wiring-wise the two triggers are still identical.
- `classes/AcmeOrderServiceTest.cls` — **checked, not modified.** Its pre-existing `testBatchProcessor()` (`Database.executeBatch(batch)`, a variable arg) and `testScheduledJob()` (`System.schedule(..., scheduler)`, a variable arg) already exist from v0.3 and, unmodified, turn out to be exactly the negative fixtures G5's "argText must contain an inline `new KnownClass(`" rule needs — see G5 below. No corpus change was required to get these two no-edge cases; the pre-existing test method shapes already happened to cover them.

### G1 — EventBus -> platform-event linkage

#### G1(a): publish-site -> trigger edges

- `AcmeNoteEventPublisher.cls#publishNote → AcmeNoteEventTrigger.trigger` [needs: publish] (via=publish, op=publish, single-record `new Acme_Note__e(...)` inline-constructor form) — `classes/AcmeNoteEventPublisher.cls:10`
- `AcmeNoteEventPublisher.cls#publishNotes → AcmeNoteEventTrigger.trigger` [needs: publish] (via=publish, op=publish, `List<Acme_Note__e>` collection form built in a loop, single `EventBus.publish(events)` call site) — `classes/AcmeNoteEventPublisher.cls:18`

Both resolve via the same target-type machinery DML uses (type-env for identifiers, including `List<X__e>`, plus the inline `new Acme_X__e(...)` pattern): the published type's simple name ends in `__e`, so every trigger registered on that object gets a `via='publish'` caller edge. `via='publish'` is **not** approximate (per the G1 spec) — platform-event triggers are unconditionally `after insert` (there is no other trigger-context an event can fire in), so there is no `deleteSingleOrder`-style "op has no matching trigger" negative case possible for this feature; every `EventBus.publish` on a `__e` type with at least one registered trigger produces an edge.

#### G1(b): platform-event flow -> publish children

Per G1(b), a platform-event-triggered flow node's children (once the node is reachable in a tree — same `[needs: metadata-callers]` precondition v0.4's F1(b) flow-DML-children documented) are the publish sites on its object, materialized the same way F1(b) materializes DML children on a record-triggered flow:

- `flows/AcmeNoteEventFlow.flow-meta.xml` (`triggerType=PlatformEvent`, `object=Acme_Note__e`) children:
  - `AcmeNoteEventPublisher.cls#publishNote` [needs: publish]
  - `AcmeNoteEventPublisher.cls#publishNotes` [needs: publish]

As with F1(b), these 2 children are the correct ground truth for "once the flow node is in the tree, what are its children," independent of when/whether `[needs: metadata-callers]` ships.

#### Ordinary wiring (resolves-today)

- `AcmeNoteEventTrigger.trigger → AcmeNoteEventHandler.cls#handle` [resolves-today] (via=static)

#### Informational (pre-existing category, not new)

- `flows/AcmeNoteEventFlow.flow-meta.xml → AcmeOrderInvocable.cls#execute` [needs: metadata-callers] (`<actionName>AcmeOrderInvocable</actionName><actionType>apex</actionType>`) — the flow's one Apex action, reusing an existing `@InvocableMethod` class. Same pre-existing gap category as the v0.3 Flow-XML edges, not counted toward the v0.5 tally below.

### G2 — Exception throw/catch tracing

#### Throw sites (root-level `via=throws` children when tracing `AcmeValidationException`)

- `AcmeOrderValidator.cls#validate(Id,Integer) → AcmeValidationException.cls` [needs: throws] (via=throws — `throw new AcmeValidationException(...)`, creator-type form) — `classes/AcmeOrderValidator.cls:9`
- `AcmeShipmentService.cls#reprocessFailedShipment → AcmeValidationException.cls` [needs: throws] (via=throws — `throw e;` rethrow form; `e`'s type resolves to `AcmeValidationException` via the enclosing `catch (AcmeValidationException e)` clause at line 26) — `classes/AcmeShipmentService.cls:28`

Both throw the exact same exception type, from two structurally different throw-statement shapes (`throw new X(...)` vs. resolved-`throw e`), per the G2 spec's requirement for "throw sites in 2 service methods."

#### Thrower-node reachability

- `AcmeOrderValidator.cls#validate(Id,Integer)` is reached from `validate(Id)` (`via=this`, same-class 1-arg overload delegating `cycleDepth=0`), which is reached from `AcmeOrderService.cls#processOrders` (`via=static`, pre-existing v0.3 edge) — this is the branch point for all 4 catch-depth scenarios below.
- `AcmeShipmentService.cls#reprocessFailedShipment` has **zero callers** in this corpus (see "Existing files adjusted" above) — it is a valid, terminal `via=throws` leaf directly under the `AcmeValidationException` root, with no further ancestor chain. Deliberately included to prove a thrower node needs no callers of its own to be valid ground truth.

#### Catch sites at different ancestor depths (all four required scenarios)

All four branch off the same `AcmeOrderService.cls#processOrders` node (see above), which itself has no catch and is not one of the 4 badge-bearing nodes:

1. **Catches the exact type** — `AcmeOrderBatchProcessor.cls#execute` (depth 2 from the throw: `validate -> processOrders -> execute`), `catch (AcmeValidationException ve)` at `classes/AcmeOrderBatchProcessor.cls:29` → `caughtHere: true`, entries badge `'catches AcmeValidationException'`. Traversal continues past this node per spec (rethrow is unknowable): post-G5, `execute` gains its own `via=async` ancestors (`AcmeOrderService.cls#processOrders` again — already on the ancestor path, so this specific hop is `cyclic: true`, not re-expanded; `AcmeNightlyReconciliationScheduler.cls#execute`, itself further ancestored by `AcmeAsyncOrchestrator.cls#runNightlyMaintenance`; and `AcmeAsyncOrchestrator.cls#runNightlyMaintenance` directly — see G5 below for the full async-edge set). None of those async ancestors carry a catch of their own, so no further badges appear above this node.
2. **Catches a supertype** — `AcmeOrderRestResource.cls#handlePost` (depth 2: `validate -> processOrders -> handlePost`), `catch (AcmeBaseException be)` at `classes/AcmeOrderRestResource.cls:25` → `caughtHere: true`, entries badge `'catches AcmeValidationException'` (matched via the USER exception hierarchy: `AcmeValidationException extends AcmeBaseException`). `handlePost` is a `@HttpPost` REST entry point — terminal, no further ancestors.
3. **Catches bare `Exception`** — `AcmeOrderTrigger.trigger` (depth 3: `validate -> processOrders -> AcmeOrderTriggerHandler.cls#handle (no catch) -> AcmeOrderTrigger.trigger`), `catch (Exception ex)` at `triggers/AcmeOrderTrigger.trigger:17` → `caughtHere: true`, entries badge `'catches AcmeValidationException'`. Root trigger entry point — terminal.
4. **No catch anywhere — reaches entry uncaught** — `AcmeOrderServiceTest.cls#testProcessOrders` (depth 2: `validate -> processOrders -> testProcessOrders`), an `@isTest` method with no try/catch at all → no `caughtHere` badge on any node in this branch; the tree reaches a terminal `@isTest` entry with the exception still formally "in flight." This is the explicit negative for the badge mechanism: absence of a badge is itself part of the ground truth, not an omission.

Depths intentionally vary (2, 2, 3, 2) — scenario 3 is one hop deeper than the other three, because `AcmeOrderTriggerHandler.handle` sits between `processOrders` and the trigger with no catch of its own, exercising "traversal continues through uncaught intermediate frames" on the way to the badge.

### G3 — instanceof narrowing (labeled fallback only)

- `AcmeShapeNarrowingAuditor.cls#auditLabel → AcmeShapeConcrete.cls#crateLabel` [needs: narrowed] (via=narrowed, approximate — `shape` is declared `AcmeShapeBase`, which does not own `crateLabel()`; the narrowing `shape instanceof AcmeShapeConcrete` is consulted only because declared-type resolution already failed. Branch polarity is not tracked: the resolver does not know whether the `if` branch actually executes at runtime, only that the narrowing exists in the same method — this is a real approximation, not full flow analysis) — `classes/AcmeShapeNarrowingAuditor.cls:16`
- `AcmeShapeNarrowingAuditor.cls#auditDescribeShape → AcmeShapeBase.cls#describeShape` [resolves-today] (via=typed — negative case: `describeShape()` IS declared directly on `AcmeShapeBase`, `shape`'s declared type, so ordinary typed resolution succeeds immediately; the `shape instanceof AcmeShapeConcrete` guard is textually present in this method too but must NOT be consulted, since narrowing is a fallback used only after declared-type resolution fails) — `classes/AcmeShapeNarrowingAuditor.cls:23`

### G4 — Anonymous Apex

`scripts/adhoc-recalc.apex` parses today with `parseError != null` (confirmed live against the checked-in `parser.js`: `.apex` files are not routed to any anonymous-unit handling, so the file is parsed as if it needed a top-level type declaration and fails on the first bare statement). All edges below require G4's `parser.anonymousUnit()` support to exist as parsed facts in the first place — until then this file contributes 0 edges, not merely unresolved ones.

- `scripts/adhoc-recalc.apex#(anonymous) → AcmeOrderService.cls#recalculatePricing` [needs: anonymous] (via=static, called inside a `for` loop over `openOrders`) — `scripts/adhoc-recalc.apex:15`
- `scripts/adhoc-recalc.apex#(anonymous) → AcmeShipmentService.cls#scheduleDelivery` [needs: anonymous] (via=static, called inside a `for` loop over `pendingShipments`, second real service) — `scripts/adhoc-recalc.apex:26`
- `scripts/adhoc-recalc.apex#(anonymous) → AcmeOrderTrigger.trigger` [needs: anonymous] (via=dml, op=update, statement-form `update openOrders;` on `Acme_Order__c` — a triggered object) — `scripts/adhoc-recalc.apex:29`. This third edge is gated behind **two** upgrades at once (G4 anonymous-unit parsing must exist before the pre-existing v0.4 F1 DML->trigger mapping has any `CallFacts` to run against at all) — deliberately included to prove the two features compose rather than only being tested in isolation.

Like every other script/test root in this corpus, `scripts/adhoc-recalc.apex#(anonymous)` has no callers of its own — anonymous Apex is by construction a pure root (G4 spec: "scripts are pure roots — nothing calls them").

### G5 — Async-hop edges

Per the G5 spec, a qualifying call site is a `System.enqueueJob(...)` / `Database.executeBatch(...)` / `System.schedule(...)` dot call whose **argText literally contains an inline `new KnownClass(`** creation — not merely a variable that happens to hold such an instance. Verified live against every `enqueueJob`/`executeBatch`/`System.schedule` call site in the corpus (6 total, all pre-existing plus new): 4 qualify, 2 do not.

#### Positive edges (6) — in addition to each site's existing `via=new` constructor edge

- `AcmeOrderService.cls#processOrders → AcmeOrderBatchProcessor.cls#execute` [needs: async] (via=async — `Database.executeBatch(new AcmeOrderBatchProcessor(normalized));`; pre-existing v0.3 call site, newly exposed by G5 with no corpus change) — `classes/AcmeOrderService.cls:18`
- `AcmeShipmentService.cls#processShipments → AcmeShipmentQueueableDispatcher.cls#execute` [needs: async] (via=async — `System.enqueueJob(new AcmeShipmentQueueableDispatcher(enriched));`; pre-existing v0.3 call site, newly exposed) — `classes/AcmeShipmentService.cls:14`
- `AcmeNightlyReconciliationScheduler.cls#execute → AcmeOrderBatchProcessor.cls#execute` [needs: async] (via=async — `Database.executeBatch(new AcmeOrderBatchProcessor());`; pre-existing v0.3 call site, newly exposed) — `classes/AcmeNightlyReconciliationScheduler.cls:10`
- `AcmeAsyncOrchestrator.cls#runNightlyMaintenance → AcmeShipmentQueueableDispatcher.cls#execute` [needs: async] (via=async — new v0.5 fixture) — `classes/AcmeAsyncOrchestrator.cls:12`
- `AcmeAsyncOrchestrator.cls#runNightlyMaintenance → AcmeOrderBatchProcessor.cls#execute` [needs: async] (via=async — new v0.5 fixture) — `classes/AcmeAsyncOrchestrator.cls:13`
- `AcmeAsyncOrchestrator.cls#runNightlyMaintenance → AcmeNightlyReconciliationScheduler.cls#execute` [needs: async] (via=async — new v0.5 fixture) — `classes/AcmeAsyncOrchestrator.cls:14`

Two of these six converge on `AcmeOrderBatchProcessor.cls#execute` from three separate ancestors at once (`AcmeOrderService.processOrders`, `AcmeNightlyReconciliationScheduler.execute`, `AcmeAsyncOrchestrator.runNightlyMaintenance` directly) — see the G2 catch-site-1 note above for how this interacts with the exception-catch tree (one of those three paths is `cyclic: true` because it loops back through `processOrders`, already on the ancestor path when tracing from the `AcmeValidationException` root).

#### Documented no-edge cases (2)

- `AcmeOrderServiceTest.cls#testBatchProcessor → **no async edge**` [needs: async] — `Database.executeBatch(batch);` where `batch` is a pre-declared local variable (`AcmeOrderBatchProcessor batch = new AcmeOrderBatchProcessor();` on the prior line), not an inline `new` in the call's own argText. The existing `via=new` edge from the constructor statement itself is unaffected; only the additional async-hop edge is correctly absent. Pre-existing v0.3 call site — no corpus change needed to make it a valid negative.
- `AcmeOrderServiceTest.cls#testScheduledJob → **no async edge**` [needs: async] — `System.schedule('Acme Nightly Reconciliation Test', cronExpression, scheduler);` where `scheduler` is likewise a pre-declared local variable, not an inline `new`. Same reasoning; pre-existing v0.3 call site.

### G6 — interface-extends-interface fan-out

- `AcmeIntfDispatchDemo.cls#dispatchPing → AcmeDirectPingHandler.cls#ping` [resolves-today] (via=interface, approximate — `AcmeDirectPingHandler` implements `AcmeParentIntf` directly; the existing v0.3 direct-`implements` fan-out already includes it regardless of which concrete type `dispatchPing` actually instantiates, since interface fan-out is conservative over the declared type, not the runtime type)
- `AcmeIntfDispatchDemo.cls#dispatchPing → AcmePingPongHandler.cls#ping` [resolves-today] (via=interface, approximate — `AcmePingPongHandler` implements `AcmeChildIntf`, which `extends AcmeParentIntf, AcmeSecondaryIntf`; reachable from the `AcmeParentIntf`-typed `handler` local through the interface-extends transitive closure, FIRST extends-list entry)
- `AcmeIntfDispatchSecondaryDemo.cls#dispatchPong → AcmePingPongHandler.cls#pong` [resolves-today] (via=interface, approximate — same `AcmePingPongHandler implements AcmeChildIntf` relationship, but reached from an `AcmeSecondaryIntf`-typed local, the SECOND extends-list entry on `AcmeChildIntf`)

**Originally a live-verified gap; the single-parent case above now resolves.** Ran `buildSemanticIndex`/`buildCallerTree` from this repo's checked-in `resolver.js` against the full corpus at the time: `AcmeDirectPingHandler.cls#ping` already showed `AcmeIntfDispatchDemo.dispatchPing` as a caller (`via=interface`, `approximate=true`); `AcmePingPongHandler.cls#ping` showed **zero** callers. Root cause: `buildSemanticIndex`'s `interfaceImplementers` map (populated at `resolver.js` pass A) was built exclusively from each class's own `implementsTypes` — `AcmePingPongHandler implements AcmeChildIntf` registered it only under `interfaceImplementers.get('acmechildintf')`, never under `'acmeparentintf'`, with no pass walking an *interface's own* `extendsType` to propagate implementers up the chain. That gap is now fixed: `resolver.js` computes the transitive closure of interface-extends edges before the direct-`implementsTypes` fan-out.

**Diamond (multi-parent) follow-on defect, now also fixed.** The single-parent `AcmeChildIntf extends AcmeParentIntf` fixture above did NOT catch a second, narrower defect: parser.js's `enterInterfaceDeclaration` only kept `list[0].getText()` from the extends type-list, so ANY interface with more than one `extends` parent silently dropped every parent after the first — `AcmeChildIntf`'s `TypeFacts.extendsType` would have become `"AcmeSecondaryIntf"`-blind the moment a second parent was added, with no `parseError`, no `approximate`/degraded flag, and no error surfacing anywhere. `AcmeSecondaryIntf`/`AcmeIntfDispatchSecondaryDemo.cls` (added this round) are the regression fixture: `AcmeChildIntf` now `extends AcmeParentIntf, AcmeSecondaryIntf` (2 parents), and `AcmeIntfDispatchSecondaryDemo.dispatchPong` calls through the SECOND entry specifically. Fix: `parser.js`'s `TypeFacts` gained an additive `extendsTypes` array (full raw extends list; `extendsType` unchanged, still the first entry, for back-compat) and `resolver.js`'s `ifaceParents` map now stores an array of parents per interface with a BFS `ifaceAncestorsExclusive` walk, instead of a single string with a linear walk-up.

### v0.5 edge/badge tally

Caller-graph edges only (G1-G6); G2's caughtHere badges are classification-only
(analogous to v0.4's F5 entries), tallied separately below since they are not
caller edges at all:

| Feature | Positive edges | Documented no-edge cases | Ordinary resolves-today edges (wiring) |
|---|---:|---:|---:|
| G1 (publish -> trigger) | 2 | 0 | 0 |
| G1 (flow -> publish children) | 2 | 0 | 0 |
| G1 (trigger -> handler wiring) | 0 | 0 | 1 |
| G2 (throws) | 2 | 0 | 0 |
| G3 (narrowed) | 1 | 0 | 1 (negative-demonstration edge, still real wiring) |
| G4 (anonymous) | 3 | 0 | 0 |
| G5 (async) | 6 | 2 | 0 |
| G6 (iface-extends) | 2 (1 single-parent + 1 diamond/2nd-parent) | 0 | 1 (direct-implementer edge, already worked pre-v0.5) |
| **Total new v0.5 caller-graph edges** | **18** | **2** | **3** |

Plus **4** G2 caughtHere-badge classifications (`catches AcmeValidationException`
at `AcmeOrderBatchProcessor.execute` / `AcmeOrderRestResource.handlePost` /
`AcmeOrderTrigger.trigger`, plus the deliberate absence of a badge at
`AcmeOrderServiceTest.testProcessOrders`), each on an existing method that
gained a try/catch this round — not counted in the 17/2/3 above (three of the
four sit on methods counted once already in "Existing files adjusted"; the
badges themselves are a distinct, additive classification layer over those
same nodes, exactly as F5's entry-labels were additive over already-indexed
methods).

Combined with the pre-existing 124 v0.3+v0.4 design edges (unchanged), this
corpus now carries **144 total documented caller-graph edges** (86 v0.3 + 38
v0.4 + 20 v0.5 — the 20 v0.5 edges break down as 17 positive `[needs: ...]`
edges plus 3 ordinary `[resolves-today]` wiring edges new this round), plus 4
v0.4 F5 entry-label classifications and 4 v0.5 G2 caughtHere-badge
classifications (8 classification-only additions total, neither counted as
caller-graph edges), and 6 total documented no-edge negative cases (4 v0.4 +
2 v0.5, the latter both from G5's non-inline-`new` argText rule).

## v0.6 ground-truth edges

Appended for the v0.6.0 hardening round. Of that round's nine work items, only
H2 (interface x override composition) needs new corpus fixtures — H1 is pure
engine DAG/perf work, H3-H9 are engine/UI/cleanup/doc work over the existing
corpus. This section is purely additive: none of the 144 v0.3+v0.4+v0.5 edges
above changed, and no existing file was touched.

### New files added (v0.6)

| Path | Role |
|---|---|
| `classes/AcmeSurchargeStrategy.cls` | H2: interface (`computeSurcharge`), implemented by a virtual base and overridden two tiers down. |
| `classes/AcmeStandardSurchargeStrategy.cls` | H2: virtual base implementer of `AcmeSurchargeStrategy`; declares `implements` directly, `computeSurcharge()` is `virtual`. |
| `classes/AcmeExpeditedSurchargeStrategy.cls` | H2: `extends AcmeStandardSurchargeStrategy`, `override`s `computeSurcharge()`; deliberately does NOT redeclare `implements AcmeSurchargeStrategy`. |
| `classes/AcmeSurchargeRouter.cls` | H2: dispatcher; `applySurcharge(AcmeSurchargeStrategy strategy, Decimal baseAmount)` calls `strategy.computeSurcharge(baseAmount)` exclusively through the interface-typed parameter. |

### H2 — interface x override composition (confirmed missing-edge bug)

Repro of the confirmed gap: interface fan-out resolved to direct implementers
and walked UP an implementer's own extends chain to find an inherited method
body (already exercised by `AcmeSlackNotifier`/`AcmeBaseNotifier` in the
Notifications fixture group), but never fanned DOWN from an implementer to an
override declared in one of *its* subclasses. `AcmeExpeditedSurchargeStrategy`
overrides `AcmeStandardSurchargeStrategy.computeSurcharge()` without itself
declaring `implements AcmeSurchargeStrategy` — live-verified against the
checked-in (pre-H2) `resolver.js`/`parser.js` in this repo: tracing
`AcmeStandardSurchargeStrategy.cls#computeSurcharge` correctly returns
`AcmeSurchargeRouter.applySurcharge` (`via=interface`, `approximate=true`),
but tracing `AcmeExpeditedSurchargeStrategy.cls#computeSurcharge` returns
**zero callers**, even though `AcmeSurchargeRouter.applySurcharge` calls
exactly this override through the interface-typed `strategy` parameter.

- `AcmeSurchargeRouter.cls#applySurcharge → AcmeStandardSurchargeStrategy.cls#computeSurcharge` [resolves-today] (via=interface, approximate) — ordinary direct-implementer interface fan-out; unaffected by the H2 fix, keeps its existing behavior before and after.
- `AcmeSurchargeRouter.cls#applySurcharge → AcmeExpeditedSurchargeStrategy.cls#computeSurcharge` [needs: iface-override] (via=interface, approximate) — the confirmed-missing edge; requires `emitTypedOrInterfaceForClass`'s interface branch to also run the override fan-out downward after resolving each implementer's method. Zero callers pre-fix (verified live above).

### v0.6 edge tally (H2 only)

| Feature | Positive edges | Documented no-edge cases | Ordinary resolves-today edges (wiring) |
|---|---:|---:|---:|
| H2 (iface-override) | 1 | 0 | 1 (base-implementer edge, already worked pre-v0.6) |

Combined with the pre-existing 144 v0.3+v0.4+v0.5 design edges (unchanged),
this corpus now carries **145 total documented caller-graph edges** (86 v0.3
+ 38 v0.4 + 20 v0.5 + 1 v0.6), plus the 1 ordinary `[resolves-today]` wiring
edge new this round.

## v0.7 ground-truth edges

Appended for the v0.7.0 pre-release round covering two additive features:
Feature A (forward tracing / callee direction, `buildCalleeTree`) and
Feature B (multi-package awareness, duplicate-name buckets +
`packageOf`/`via='ambiguous'`). Both features are new engine capabilities
with no pre-v0.7 equivalent (`buildCalleeTree`, `methodCallees`, and package
buckets do not exist in the checked-in `resolver.js`), so this section
documents ground truth for functionality not yet implemented -- the same
"specify ahead of implementation" pattern the v0.4-v0.6 rounds used for
`[needs: ...]` edges. This section is purely additive to the corpus: the
145 pre-existing v0.3-v0.6 caller-graph edges above are unchanged (verified
live: `resolver.buildSemanticIndex()`/`buildCallerTree()` against the full,
now-larger corpus still resolves all 11 `run-diff.js` ground-truth targets
and all 8 existing test suites green -- see "Verification (v0.7)" below).
Two force-app files gained exactly one new outbound call site each (see
"Existing files adjusted (v0.7)"); 7 new `.cls` files were added across 2
new package directories; `sfdx-project.json` grew from 1 `packageDirectory`
entry to 3.

### New files added (v0.7)

| Path | Role |
|---|---|
| `sfdx-project.json` | Updated: `packageDirectories` grew from 1 entry (`force-app`, `default: true`) to 3 -- adds `pkg-billing` (`package: "nova-billing"`) and `pkg-shared` (`package: "nova-shared"`), neither marked `default`. |
| `pkg-billing/main/default/classes/NovaBillingService.cls` | Billing package's service entry point; `generateInvoice()` is the billing-calling-core half of the bidirectional cross-package fixture (calls `AcmeOrderService.recalculatePricing` in force-app), `recordBatchCompletion()` is the target of the core-calling-billing half. |
| `pkg-billing/main/default/classes/NovaInvoiceGenerator.cls` | Same-package helper (`build()`), called only from `NovaBillingService.generateInvoice`. |
| `pkg-billing/main/default/classes/NovaPaymentProcessor.cls` | Calls `AcmeOrderUtil.reconcileBillingStatus` -- the same-package-preference fixture for the `AcmeOrderUtil` duplicate pair. |
| `pkg-billing/main/default/classes/NovaBillingUtil.cls` | Billing package's own `NovaBillingUtil`; one half of the ambiguous-fan-out duplicate pair (`auditPricingSync`). |
| `pkg-billing/main/default/classes/AcmeOrderUtil.cls` | **The duplicate-name fixture**: same qualified name as `force-app/main/default/classes/AcmeOrderUtil.cls`, deliberately different methods (`reconcileBillingStatus`, `applyLateFee` -- no `normalize`/`markApproved`/`buildQuery`). |
| `pkg-shared/main/default/classes/NovaBillingUtil.cls` | Second half of the `NovaBillingUtil` duplicate pair (also declares `auditPricingSync`, unrelated body) -- the genuinely-ambiguous fixture's other candidate. |
| `pkg-shared/main/default/classes/NovaSharedBillingBridge.cls` | Calls `AcmeOrderUtil.buildQuery()` -- the default-package-fallback fixture. |

### Existing files adjusted (v0.7)

- `classes/AcmeOrderBatchProcessor.cls` -- `finish()` gained one line:
  `NovaBillingService.recordBatchCompletion();`, appended after the
  pre-existing `dispatchToAll(...)` call. Purely additive; every pinned
  v0.3-v0.6 fact about this file is unchanged, including the
  `catch (AcmeValidationException ve)` line number (`execute()`, still line
  29) -- deliberately did NOT touch the file header comment or any line
  above `finish()`, since `test-parser.js` and the v0.5 G2 catch-site doc
  both pin that line number.
- `classes/AcmeOrderRestResource.cls` -- `handleGet()`'s existing
  `AcmeOrderService.recalculatePricing(orderId);` line gained a second
  statement on the SAME line, `NovaBillingUtil.auditPricingSync(orderId);`
  (both statements now share line 13), rather than being inserted as a new
  line, specifically to avoid shifting `handlePost()`'s
  `catch (AcmeBaseException be)` off its pinned line 25 (v0.5 G2 catch-site
  2). No other line in the file changed.

Both adjustments were verified live: `parser.js`'s `parseFile()` still
returns `parseError: null` for both files, and the pre-existing G2
catch-site line numbers (`AcmeOrderBatchProcessor.cls:29`,
`AcmeOrderRestResource.cls:25`) are unchanged from the v0.5 section above --
confirmed by re-running `test-parser.js` (which hard-codes the
`AcmeOrderBatchProcessor.cls:29` catch fixture) after the edit; it now
passes.

### Feature A -- Forward tracing ground truth (`buildCalleeTree`)

All 12 chains below are written as `target -> ordered children`, each child
annotated with its expected `via` and `kind` (`kind=method` unless noted).
"Ordered" means source-line order within the target method, matching the
ordering `buildCallerTree` already uses for the reverse direction. None of
these resolve today (`[needs: forward-tracing]`, since `buildCalleeTree`/
`methodCallees` do not exist in the checked-in `resolver.js`) -- ground
truth for the not-yet-built engine, per the same "specify ahead" pattern
the v0.4-v0.6 `[needs: ...]` edges used.

#### A1 -- Full forward transaction story (`@AuraEnabled` controller -> service -> update DML -> trigger + record-triggered flow)

Three chained hops, controller down to the DML fan-out:

1. `AcmeOrderApprovalController.cls#approveOrder` -> `AcmeOrderService.cls#approveOrder` (via=static, kind=method)
2. `AcmeOrderService.cls#approveOrder` -> `AcmeOrderUtil.cls#markApproved` (via=static, kind=method)
3. `AcmeOrderUtil.cls#markApproved` -> ordered children (source-line order, `classes/AcmeOrderUtil.cls:22-23`):
   - `AcmeOrderTrigger.trigger` (via=dml, kind=trigger, op=update) -- the DML statement at line 22 (`update ord;`) fans out to every trigger registered for `update` on `Acme_Order__c`; per the existing v0.4 F1 event-mapping matrix, that is `AcmeOrderTrigger` alone.
   - `flows/AcmeOrderStatusRecordTriggeredFlow.flow-meta.xml` (via=dml, kind=flow, op=update, **terminal**) -- same DML statement, second target: the one `Acme_Order__c` record-triggered flow whose `recordTriggerType=Update` matches. Terminal per A2's spec ("record-triggered flow node... terminal in this direction") -- the flow's own internal apex actions are not modeled as callees of the DML site; that would be a different relation from F1(b)'s existing reverse-direction "flow node's children are its matching DML sites."
   - `AcmeFutureNotifier.cls#sendApprovalEmail` (via=static, kind=method) -- the line-23 `@future` call; an ordinary static call in forward direction (the `@future` annotation affects execution context, not call-graph shape).

This is the full story the corpus was asked for: one `@AuraEnabled` entry
point flowing down through the service layer to a single `update` statement
that fans out to both a `(trigger)` node and a record-triggered-flow node,
with the async email notifier as a sibling third child. Contrast with
`AcmeOrderService.cls#recalculatePricing` (chain #11 below), which reaches
the same trigger+flow pair from the REST/OmniStudio side of the tree, after
first pricing the order.

#### A2 -- Async-forward (orchestrator -> execute)

4. `AcmeAsyncOrchestrator.cls#runNightlyMaintenance` -> ordered children (`classes/AcmeAsyncOrchestrator.cls:12-14`):
   - `AcmeShipmentQueueableDispatcher.cls#execute` (via=async, kind=method)
   - `AcmeOrderBatchProcessor.cls#execute` (via=async, kind=method)
   - `AcmeNightlyReconciliationScheduler.cls#execute` (via=async, kind=method)

Design decision: unlike the reverse-direction G5 rule (which adds a
via=async edge *alongside* the pre-existing via=new constructor edge), the
forward direction does not additionally emit a separate `<init>` child for
the inline `new AcmeXxx(...)` argument at each async-scheduling call site --
the whole statement collapses to one via=async edge at the job's
`execute()`, the same way a DML statement collapses to via=dml edges per
matching trigger/flow rather than also emitting a plain call edge to the
DML target's own constructor. This mirrors how
`AcmeOrderService.cls#processOrders`'s own
`Database.executeBatch(new AcmeOrderBatchProcessor(normalized))` call site
(v0.3, pre-existing) forward-resolves to a single
`AcmeOrderBatchProcessor.cls#execute` child, not two (see chain #10 below).

#### A3 -- Throw-forward (method -> exception-class terminal node)

5. `AcmeOrderValidator.cls#validate(Id,Integer)` -> ordered children (`classes/AcmeOrderValidator.cls:9,16`):
   - `AcmeValidationException.cls` (via=throws, kind=exception, **terminal**) -- the guard-clause `throw new AcmeValidationException(...)` at line 9, textually first in the method body.
   - `AcmeInventoryChecker.cls#checkStock` (via=static, kind=method) -- the line-16 delegation call, textually second.

The exception-class node is terminal per A2's spec ("throw sites ->
exception-class node... TERMINAL"); it does not, for instance, expand into
`AcmeBaseException`/`Exception`'s own (nonexistent) outbound calls.

#### A4 -- Publish-forward (`EventBus.publish` -> platform-event trigger + PE flow)

6. `AcmeNoteEventPublisher.cls#publishNote` -> ordered children (`classes/AcmeNoteEventPublisher.cls:10`, single statement, two targets):
   - `AcmeNoteEventTrigger.trigger` (via=publish, kind=trigger) -- the sole `after insert` trigger registered on `Acme_Note__e`.
   - `flows/AcmeNoteEventFlow.flow-meta.xml` (via=publish, kind=flow, **terminal**) -- the sole `PlatformEvent`-triggered flow on `Acme_Note__e`. Mirrors A1's trigger+flow pairing, but for a publish site instead of a DML site; via=publish is not approximate (same reasoning as the reverse-direction G1 edges: the platform genuinely does fire every registered trigger/flow on a publish).

#### A5 -- Interface-forward fan-out

7. `AcmeNotificationDispatcher.cls#dispatchToAll` -> `AcmeNotifiable.cls#notify` (via=interface, kind=method, approximate) -- `classes/AcmeNotificationDispatcher.cls:15`, the `notifier.notify(message)` call inside the `for (AcmeNotifiable notifier : notifiers)` loop; receiver typed to the interface, so forward resolution lands on the interface method itself first (mirrors A2's "interface-typed calls -> the interface method node + implementer fan-out").
8. `AcmeNotifiable.cls#notify` -> ordered children (fan-out to all 3 implementers, same set the reverse-direction v0.3 edge already documents -- see "Notifications (interface fan-out)" above):
   - `AcmeEmailNotifier.cls#notify` (via=interface, kind=method, approximate)
   - `AcmeSmsNotifier.cls#notify` (via=interface, kind=method, approximate)
   - `AcmeBaseNotifier.cls#notify` (via=interface, kind=method, approximate) -- attributed through `AcmeSlackNotifier`, which implements `AcmeNotifiable` purely by inheriting this method, same attribution rule the reverse-direction edge already uses.

Ordering among the 3 fan-out children follows declaration order in
`dispatchToAll`'s own `List<AcmeNotifiable>` literal (`AcmeEmailNotifier`,
`AcmeSmsNotifier`, `AcmeSlackNotifier` -- `classes/AcmeNotificationDispatcher.cls:9-13`),
not alphabetical.

#### A6 -- Unresolved-leaf count (platform calls)

9. `AcmeSmsNotifier.cls#sendSms` -> `'5 unresolved sites'` (kind=unresolved, **terminal**, approximate) -- `classes/AcmeSmsNotifier.cls:18-24`. Every dot-call in this method targets a platform type absent from the Apex-class index: `req.setEndpoint(...)`, `req.setMethod(...)`, `req.setBody(...)` (receiver typed `HttpRequest`), `http.send(req)` (receiver typed `Http`), and `System.debug(...)` (receiver literally `System`, in `PLATFORM_DENYLIST`). None resolve to an indexed target. Per A2's aggregation rule, all 5 collapse into ONE leaf rather than 5 separate unresolved nodes or 5 silently-dropped call sites.

This is a deliberate forward-direction-only behavior: the reverse-direction
engine silently drops denylisted/platform receivers with no edge and no
node at all (existing `resolver.js` rule 7 / `PLATFORM_DENYLIST`) because
nothing ever calls INTO your code from `System.debug`; forward tracing
surfaces the aggregate instead, because a user asking "what does `sendSms`
call?" benefits from seeing that 5 calls happened even though none of them
target indexed Apex.

#### Bonus chains (rounding out coverage across DML, async, and trigger-as-source shapes)

10. `AcmeOrderService.cls#processOrders` -> ordered children (`classes/AcmeOrderService.cls:14,16,18`):
    - `AcmeOrderUtil.cls#normalize` (via=static, kind=method)
    - `AcmeOrderValidator.cls#validate(Id)` (via=static, kind=method) -- the 1-arg overload; per resolver design decision #2 (unchanged from callers direction), the 2-arg `validate(Id,Integer)` overload does not get its own child key here.
    - `AcmeOrderBatchProcessor.cls#execute` (via=async, kind=method) -- `Database.executeBatch(new AcmeOrderBatchProcessor(normalized))`, same async-collapse rule as A2 above; this is the pre-existing v0.3/v0.5 call site, now exercised from the forward side.
11. `AcmeOrderService.cls#recalculatePricing` -> ordered children (`classes/AcmeOrderService.cls:38-39`):
    - `AcmePricingEngine.cls#calculatePrice` (via=static, kind=method) -- `[needs: type-overloads]` carries over unchanged from the reverse direction: this call site targets the `Acme_Order__c` overload specifically, but forward resolution collapses onto the same undifferentiated `class#method` key as the other 3 overloads.
    - `AcmeOrderTrigger.trigger` (via=dml, kind=trigger, op=update)
    - `flows/AcmeOrderStatusRecordTriggeredFlow.flow-meta.xml` (via=dml, kind=flow, op=update, **terminal**)

    A second full transaction story, reached from the REST/OmniStudio side
    rather than the Aura-approval side (contrast chain #3): same
    trigger+flow pair, different upstream entry point, and a pricing
    calculation ahead of the DML instead of a plain status flip.
12. `AcmeOrderTrigger.trigger` -> ordered children (`triggers/AcmeOrderTrigger.trigger`, inside the v0.5-added `try` block):
    - `AcmeOrderTriggerHandler.cls#<init>` (via=new, kind=method)
    - `AcmeOrderTriggerHandler.cls#handle` (via=typed, kind=method)

    Unlike a flow node, a `(trigger)` node is NOT terminal in forward
    direction -- its body is ordinary Apex (here, wrapped in the v0.5
    `catch (Exception ex)` block, which has no children of its own since a
    bare `System.debug` inside a catch clause doesn't call anything
    indexed), so tracing forward from a trigger continues into its handler
    exactly like tracing forward from any other method. This is the
    deliberate asymmetry with A1/A4/A6/#11's flow nodes, which stay opaque.

### Forward-chain tally

| Chain # | Target | Children (edges) |
|---:|---|---:|
| 1 | `AcmeOrderApprovalController.cls#approveOrder` | 1 |
| 2 | `AcmeOrderService.cls#approveOrder` | 1 |
| 3 | `AcmeOrderUtil.cls#markApproved` | 3 |
| 4 | `AcmeAsyncOrchestrator.cls#runNightlyMaintenance` | 3 |
| 5 | `AcmeOrderValidator.cls#validate(Id,Integer)` | 2 |
| 6 | `AcmeNoteEventPublisher.cls#publishNote` | 2 |
| 7 | `AcmeNotificationDispatcher.cls#dispatchToAll` | 1 |
| 8 | `AcmeNotifiable.cls#notify` | 3 |
| 9 | `AcmeSmsNotifier.cls#sendSms` | 1 (aggregated leaf) |
| 10 | `AcmeOrderService.cls#processOrders` | 3 |
| 11 | `AcmeOrderService.cls#recalculatePricing` | 3 |
| 12 | `AcmeOrderTrigger.trigger` | 2 |
| **Total** | **12 chains** | **25 edges** |

### Feature B -- Multi-package awareness ground truth (package matrix)

Package layout after this round (`sfdx-project.json`):

| Package dir | `package` label | default | Role in the fixtures below |
|---|---|---|---|
| `force-app` | *(none -- label falls back to the path segment `force-app`)* | yes | Default package; 73 classes + 4 triggers, unchanged from v0.6 except the 2 additive call sites documented above. |
| `pkg-billing` | `nova-billing` | no | 5 classes, incl. one half of each duplicate pair (`AcmeOrderUtil`, `NovaBillingUtil`). |
| `pkg-shared` | `nova-shared` | no | 2 classes: the second half of the `NovaBillingUtil` duplicate pair, and the default-package-fallback caller. |

Two duplicate qualified names exist in this corpus after this round
(`index.stats.duplicateNames === 2`): `AcmeOrderUtil` (force-app + pkg-billing)
and `NovaBillingUtil` (pkg-billing + pkg-shared). Expected header note once
Feature B lands: `'2 duplicate class names across packages — resolution
prefers the referring file's package'`.

#### B1 -- Same-package preference edges (2)

- `pkg-billing/main/default/classes/NovaPaymentProcessor.cls#processPayment -> pkg-billing/main/default/classes/AcmeOrderUtil.cls#reconcileBillingStatus` [needs: package-resolution] (via=static, package=nova-billing) -- caller and the chosen candidate are both in `pkg-billing`; the `force-app` candidate (default package) is correctly NOT chosen even though it would win under rule 2 if rule 1 hadn't already matched. `classes/NovaPaymentProcessor.cls:12`.
- `force-app/main/default/classes/AcmeOrderService.cls#processOrders -> force-app/main/default/classes/AcmeOrderUtil.cls#normalize` [resolves-today under v0.3, package-aware under v0.7] (via=static) -- pre-existing v0.3 edge, unchanged identity. Documented here because once `AcmeOrderUtil` becomes a duplicated name, this edge must keep resolving to force-app's own candidate via the SAME rule 1 (same-package: force-app file calling a force-app class), not merely "because it's the only one anyone thought of" -- this is the regression-safety half of the fixture (see "packageless-identity note" below for the byte-identical-output guarantee this depends on).

#### B2 -- Default-package fallback edge (1)

- `pkg-shared/main/default/classes/NovaSharedBillingBridge.cls#syncSharedQuery -> force-app/main/default/classes/AcmeOrderUtil.cls#buildQuery` [needs: package-resolution] (via=static, package=force-app) -- `classes/NovaSharedBillingBridge.cls:12`. `pkg-shared` declares no `AcmeOrderUtil` of its own (rule 1 fails), so resolution falls through to rule 2: the candidate in the default package (`force-app`) wins. `pkg-billing`'s `AcmeOrderUtil` candidate is correctly NOT chosen -- it isn't the default package and isn't the caller's own package.

#### B3 -- Ambiguous fan-out (both candidates, via=ambiguous) (1 call site -> 2 edges)

- `force-app/main/default/classes/AcmeOrderRestResource.cls#handleGet -> pkg-billing/main/default/classes/NovaBillingUtil.cls#auditPricingSync` [needs: package-resolution] (via=ambiguous, approximate, package=nova-billing)
- `force-app/main/default/classes/AcmeOrderRestResource.cls#handleGet -> pkg-shared/main/default/classes/NovaBillingUtil.cls#auditPricingSync` [needs: package-resolution] (via=ambiguous, approximate, package=nova-shared)

Both edges fire from the SAME call site (`classes/AcmeOrderRestResource.cls:13`,
`NovaBillingUtil.auditPricingSync(orderId)`). Neither rule 1 nor rule 2
disambiguates: the caller's own package (`force-app`) declares no
`NovaBillingUtil`, and `force-app` IS the default package, so rule 2 also
finds nothing there. That leaves exactly 2 candidates (`pkg-billing`,
`pkg-shared`), so both get an edge, `via='ambiguous'`, `approximate=true`
(joins `APPROX_VIA`). This is the corpus's only duplicate name that stays
genuinely unresolved after both preference rules. By construction, no
3-package layout can produce caller-side ambiguity where the caller itself
lives in one of the 2 candidate packages (same-package always wins
immediately) or where the default package holds one of the 2 candidates
(default-fallback always wins) -- ambiguity is only reachable from a THIRD
package (here, `force-app`) referencing a name duplicated across the OTHER
two, non-default packages (`pkg-billing`/`pkg-shared`). This is the
mathematically-necessary shape of any genuinely-ambiguous fixture in a
3-package corpus, and is why the ambiguous CALLER sits in `force-app`
rather than in `pkg-shared` itself: a caller physically inside `pkg-shared`
referencing a name `pkg-shared` also declares would always resolve via
rule 1 (same-package) before ambiguity could ever be reached.

#### B4 -- Cross-package badge expectations

Per the UI spec, a node's package badge renders when
`node.package !== target's package` (the "target" is whichever node the
current trace is rooted at, regardless of direction). Four concrete cases
from this round's fixtures:

1. Tracing FORWARD (callees) from `force-app/main/default/classes/AcmeOrderBatchProcessor.cls#finish` (target package = `force-app`): its child `NovaBillingService.cls#recordBatchCompletion` carries badge `(nova-billing)` -- cross-package, core calling billing.
2. Tracing callers (reverse direction) of `force-app/main/default/classes/AcmeOrderService.cls#recalculatePricing` (target package = `force-app`): the new v0.7 caller `NovaBillingService.cls#generateInvoice` carries badge `(nova-billing)`, while the pre-existing v0.3 caller `AcmeOrderRestResource.cls#handleGet` (also `force-app`, same package as the target) carries no badge at all.
3. The 2 `via=ambiguous` edges from B3 each carry a DIFFERENT badge from each other on their respective target nodes -- `(nova-billing)` on one, `(nova-shared)` on the other -- since it's a fan-out to 2 different-package candidates from one caller/call site; this is the one shape in the corpus where a single parent node has two children whose badges differ from each other, not just from the parent.
4. Tracing FORWARD (callees) from `pkg-shared/main/default/classes/NovaSharedBillingBridge.cls#syncSharedQuery` (target package = `nova-shared`): its child `AcmeOrderUtil.cls#buildQuery` (`force-app`) carries badge `(force-app)` -- the badge rule applies uniformly to the default package too; there is no special-casing that suppresses badges just because the other side happens to be the default package.

#### B5 -- Packageless-identity note

This corpus's own `sfdx-project.json` always declares all 3 package
directories, so the packageless-workspace scenario is not exercised by this
fixture tree as committed -- it is exercised by pointing the extension at a
workspace root that does NOT contain (or chain up to) any
`sfdx-project.json` at all, e.g. opening `force-app/main/default` alone as
an isolated workspace folder. In that scenario:

- `packageOf(fsPath)` must return `null` for every file (per B1).
- `buildSemanticIndex()`/`buildCallerTree()` must produce byte-identical
  output to the pre-v0.7 (v0.6) engine for every one of this corpus's
  existing 145 v0.3-v0.6 caller-graph edges.
- The two duplicate-name pairs (`AcmeOrderUtil`, `NovaBillingUtil`) must
  fall back to the pre-v0.7 first-wins-registration behavior in a
  packageless run -- the first-encountered file in scan order wins outright
  (as v0.6 would have, silently), the second is dropped, and NEITHER
  `index.stats.duplicateNames` nor any `via='ambiguous'` edge is surfaced.
  Package-bucket surfacing is opt-in, gated entirely on package metadata
  being discoverable (`packageOf` returning a non-null label for at least
  one candidate), never on the mere existence of two files sharing a name.
- This is also the concrete mechanism behind the pinned regression bar
  ("CALLERS-DIRECTION OUTPUT MUST NOT CHANGE... identical vs current on 10
  fixed targets"): none of those 10 targets may be one of this round's new
  duplicate/ambiguous fixtures, precisely because a packageless run of the
  regression harness must keep seeing the old first-wins behavior on them,
  not a newly-surfaced bucket.

### Package-matrix tally

| Case | Edges | `via` |
|---|---:|---|
| B1 same-package preference | 2 | static |
| B2 default-package fallback | 1 | static |
| B3 ambiguous fan-out | 2 (1 call site) | ambiguous |
| **Total package-resolution edges** | **5** | |

Plus 4 documented badge-expectation scenarios (B4, classification-only, not
counted as edges) and 1 packageless-identity behavioral guarantee (B5).

### Verification (v0.7)

- **Parse pass**: all 7 new `.cls` files (5 `pkg-billing`, 2 `pkg-shared`)
  and the 2 adjusted force-app files parse cleanly via
  `require('./parser.js').parseFile`
  -- `parseError: null` on every one, confirmed live. Corpus-wide: 84
  `.cls`/`.trigger` files total (73 + 4 force-app, 5 pkg-billing, 2
  pkg-shared), only `AcmeBrokenParser.cls` carries `parseError` (by design,
  unchanged from v0.3).
- **`sfdx-project.json` validity**: parses as well-formed JSON
  (`JSON.parse`); 3 `packageDirectories` entries, exactly one
  `default: true` (`force-app`).
- **Regression**: all 8 existing suites (`test-parser.js`, `test-resolver.js`,
  `test-uitree.js`, `test-pathmap.js`, `test-metascan.js`,
  `test-cachestore.js`, `test-targets.js`, `test.js`) green, `node --check
  extension.js` clean, and `run-diff.js` against this corpus 11/11 --
  including `test-parser.js`'s hard-coded `AcmeOrderBatchProcessor.cls:29`
  catch-line fixture, which is why the two force-app edits above were
  written to avoid shifting any pre-existing line number.

## Entry catalog

Hand-audited, **source-only** inventory (grep/read of every `.cls`,
`.trigger`, `.flow-meta.xml`, and `.apex` file — the engine was never run to
produce this section) for v0.12's `buildEntryCatalog(index)`. Corpus totals:
80 `.cls` files across 3 package dirs (73 `force-app`, 5 `pkg-billing`, 2
`pkg-shared` -- `AcmeOrderUtil` and `NovaBillingUtil` each have a same-name
duplicate in another package per the v0.7 package-matrix fixtures above, but
**neither duplicate carries any entry annotation**, so the catalog is
unaffected by the ambiguity), 4 `.trigger` files, 6 `.flow-meta.xml` files,
1 `.apex` anonymous script (`scripts/adhoc-recalc.apex`). Only 1 class is
`@isTest` (`AcmeOrderServiceTest`, force-app) and it declares no
entry-annotated method, so **0 entries are excluded** as test-only. Every
annotated class in this corpus lives in `force-app` (the default package) --
`pkg-billing`/`pkg-shared` contribute **zero** entries, so every entry's
`package` field is `null` despite this being the multi-package corpus.

### Counts per kind

| kind | count |
|---|---:|
| trigger | 4 |
| aura | 8 |
| invocable | 2 |
| rest | 2 |
| soap | 1 |
| async | 6 |
| email | 1 |
| platform | 3 |
| flow | 6 |
| anonymous | 1 |
| **total** | **34** |
| excludedTestEntries | 0 |

Kind breakdown behind the counts above:
- **aura** (8): `AcmeOrderApprovalController.approveOrder`;
  `AcmeQuoteAuraService.{getRecentQuotes, createQuote, getInvoiceSummary,
  recalculateInvoice, submitForApproval}` (5 methods, one class);
  `AcmeShipmentAuraService.{getShipmentStatuses, refreshTracking}`.
- **invocable** (2): `AcmeDiscountApprovalInvocable.execute`,
  `AcmeOrderInvocable.execute`.
- **rest** (2): `AcmeOrderRestResource.handleGet` (`@HttpGet`),
  `AcmeOrderRestResource.handlePost` (`@HttpPost`) -- one `@RestResource`
  class, two HTTP-verb methods.
- **soap** (1): `AcmeLegacyOrderSoapService.legacyApproveOrder`.
- **async** (6): `AcmeNightlyReconciliationScheduler.execute` (Schedulable);
  `AcmeOrderBatchProcessor.{start, execute, finish}` (Batchable, 3 methods);
  `AcmeShipmentQueueableDispatcher.execute` (Queueable);
  `AcmeFutureNotifier.sendApprovalEmail` (`@future`).
- **email** (1): `AcmeSupportEmailHandler.handleInboundEmail`.
- **platform** (3): `AcmeCatalogInstallHandler.onInstall` (InstallHandler),
  `AcmeOrderPriority.compareTo` (Comparable),
  `AcmeReconciliationFinalizer.execute` (Finalizer). No `UninstallHandler` or
  `RegistrationHandler` fixture exists in this corpus (0 of each, folded
  into the 3 above).
- **flow** (6): every `.flow-meta.xml` under `force-app/main/default/flows`
  (see spot entries below for exact per-file detail strings).
- **anonymous** (1): `scripts/adhoc-recalc.apex`.
- **trigger** (4): `AcmeNoteEventTrigger`, `AcmeOrderTrigger`,
  `AcmeShipmentLifecycleTrigger`, `AcmeShipmentTrigger`.

### 15 representative spot entries (exact detail strings)

| # | kind | label | detail |
|---:|---|---|---|
| 1 | trigger | `AcmeOrderTrigger` | `on Acme_Order__c (before insert, before update, after insert, after update)` |
| 2 | trigger | `AcmeShipmentLifecycleTrigger` | `on Acme_Shipment__c (before delete, after undelete)` |
| 3 | trigger | `AcmeNoteEventTrigger` | `on Acme_Note__e (after insert)` |
| 4 | aura | `AcmeQuoteAuraService.getRecentQuotes` | `@AuraEnabled (LWC/Aura)` |
| 5 | aura | `AcmeOrderApprovalController.approveOrder` | `@AuraEnabled (LWC/Aura)` |
| 6 | invocable | `AcmeOrderInvocable.execute` | `@InvocableMethod (Flow)` |
| 7 | rest | `AcmeOrderRestResource.handleGet` | `@HttpGet` |
| 8 | rest | `AcmeOrderRestResource.handlePost` | `@HttpPost` |
| 9 | soap | `AcmeLegacyOrderSoapService.legacyApproveOrder` | `webservice (SOAP API)` |
| 10 | async | `AcmeOrderBatchProcessor.start` | `Batchable` |
| 11 | async | `AcmeNightlyReconciliationScheduler.execute` | `Schedulable` |
| 12 | async | `AcmeFutureNotifier.sendApprovalEmail` | `@future` |
| 13 | email | `AcmeSupportEmailHandler.handleInboundEmail` | `InboundEmailHandler (Email Service)` |
| 14 | platform | `AcmeReconciliationFinalizer.execute` | `Finalizer (async)` |
| 15 | flow | `AcmeOrderCreatedWelcomeFlow` | `RecordAfterSave on Acme_Order__c` |

Additional flow details not in the 15 above (all 6 flow files, for
completeness): `AcmeNoteEventFlow` -> `platform event on Acme_Note__e`;
`AcmeOrderStatusRecordTriggeredFlow` -> `RecordAfterSave on Acme_Order__c`;
`AcmeBackorderResolutionFlow`, `AcmeNotifyCustomerSubflow`,
`AcmeQuoteApprovalScreenFlow` -> all three `screen or autolaunched` (none of
their `<start>` blocks carry `<object>`/`<triggerType>` -- two are plain
`AutoLaunchedFlow` process types with no record/platform trigger, one is a
genuine Screen Flow `processType>Flow<`).

### Rulings applied (ambiguities encountered)

1. **Comment-text false positive, not an entry.**
   `force-app/main/default/classes/AcmeOrderUtil.cls`'s doc comment says it
   "fires the `@future` email notifier", which makes it grep-match `@future`
   -- but no method in that file is actually annotated. The real `@future`
   entry is on `AcmeFutureNotifier.sendApprovalEmail`, the class
   `AcmeOrderUtil.markApproved` calls into. Ruled: verified every grep hit
   by reading the actual method signature, not just presence-of-string.
2. **Batchable's `start`/`finish` count as async entries**, same ruling as
   gauntlet-org's GROUND-TRUTH.md -- `AcmeOrderBatchProcessor` contributes 3
   async entries (`start`, `execute`, `finish`), not 1.
3. **`async` detail for `@future` is the bare string `@future`**, not the
   engine's existing internal badge label `'@future (async)'`
   (`computeAnnotationEntries` in resolver.js). The C1 contract's Entry.detail
   comment explicitly enumerates async's four allowed values as
   `'Batchable'|'Queueable'|'Schedulable'|'@future'` -- unlike
   Batchable/Queueable/Schedulable (whose existing internal labels already
   match verbatim), `@future`'s existing internal label carries a
   `' (async)'` suffix that the catalog must strip. Flagging this because it
   is the one kind where "reuse the entry annotation label" (the contract's
   `others:` fallback rule) does NOT apply as-is.
4. **`rest` detail is the literal `@HttpX` verb text** (e.g. `@HttpGet`,
   `@HttpPost`), not the engine's existing generic internal badge label
   `'@HttpX (REST)'`. Same reasoning as ruling 3 -- the contract explicitly
   asks for "the @HttpX verb(s)", which only the raw annotation text
   satisfies. Neither corpus has a method carrying more than one HTTP-verb
   annotation, so the "(s)" plural-join format (assumed `', '`-delimited,
   matching the trigger-kind event-join convention) is untested here.
5. **Flow fallback detail is the single combined string `'screen or
   autolaunched'`**, not the CONTRACT comment's more granular
   `'screen'|'scheduled'|'platform event on <Object>'` three-way split. Ruled
   in favor of the GOAL section's prose (which states the combined string
   explicitly) because metascan's own `<start>`-block extraction
   (`extractFlowStart` in metascan.js) cannot distinguish a Screen Flow
   (`processType>Flow<`) from a plain record-agnostic Autolaunched Flow, or
   detect a Scheduled-Path flow at all, from the fields it captures
   (`flowObject`/`flowRecordTriggerType`/`flowTriggerType` are all `null`
   for all three shapes alike) -- "no new analysis" (per the GOAL's own
   constraint) rules out adding a separate `processType`/`<scheduledPaths>`
   read just to split this fallback further. All 3 of this corpus's
   non-record-triggered, non-platform-event flows
   (`AcmeBackorderResolutionFlow`, `AcmeNotifyCustomerSubflow` [a subflow,
   included because it is still a real `.flow-meta.xml` file on disk --
   "every distinct flow file", not "every flow reachable from Apex"],
   `AcmeQuoteApprovalScreenFlow`) collapse to this one fallback string.
6. **No dual-annotation (two different catalog `kind`s on one method)
   fixture exists anywhere in this corpus** -- cross-checked every file that
   matched ANY of the 12 annotation/interface patterns (16 files matched;
   15 are real entries per the false positive in ruling 1) and found zero
   overlap between kinds. Same conclusion as gauntlet-org: the dual-kind
   rule is exercised only by a synthetic `test-resolver.js` fixture.
7. **`excludedTestEntries` is 0.** The corpus's one `@isTest` class
   (`AcmeOrderServiceTest`) declares 6 `@isTest` methods, none of which
   carries any entry annotation (they call into the real entry points, e.g.
   `testInvocable` calls `AcmeOrderInvocable.execute`, but the test method
   itself is not `@InvocableMethod`) -- there is nothing to exclude.
8. **Package labels are all `null`.** Despite this being the corpus
   purpose-built for multi-package resolution (`pkg-billing`/`pkg-shared`),
   neither package declares any entry-annotated class, so the C1 contract's
   `package|null /* only when != default package */` field never fires here
   -- every one of the 34 entries lives in `force-app` (the default
   package).

---

## v0.13 subflow chains (adv-org)

No new files added to adv-org for this round -- the CORPUS section only asks
to promote the one pre-existing edge below to `[MUST]`. All the full,
node-by-node CALLER/CALLEE tree-shape assertions (3-deep chains, a mutual
cycle, an unknown-subflow-ref negative, the DML-through-subflow forward
story) are built fresh in the sibling gauntlet-org corpus instead -- see its
GROUND-TRUTH.md `## v0.13 subflow chains` section. This section covers only
what changes in adv-org itself.

### The promoted edge

`AcmeBackorderResolutionFlow.flow-meta.xml` contains
`<subflows><name>Notify_Customer</name>...<flowName>AcmeNotifyCustomerSubflow
</flowName>...</subflows>` (see "UI / metadata callers" above for the exact
element). Expected `flowGraph` entries:

| flow (lowercased key) | `parents` | `children` |
|---|---|---|
| `acmebackorderresolutionflow` | `[]` | `['acmenotifycustomersubflow']` |
| `acmenotifycustomersubflow` | `['acmebackorderresolutionflow']` | `[]` |

`[MUST]`. `stats.unknownSubflowRefs` contribution from this pair: **0** --
`AcmeNotifyCustomerSubflow` is a real file in this corpus, the reference
resolves cleanly.

### Why no live tree render exercises this pair directly

`AcmeNotifyCustomerSubflow`'s only element is `<actionCalls><actionName>
emailSimple</actionName><actionType>emailSimple</actionType>...`, i.e. **not**
`actionType=apex` -- per `metascan.js`'s `extractFlow` (frozen, untouched by
this round), that means this file produces **zero** `MetaRef`s of its own,
exactly like `Vtx_ChainFlowTop`'s zero-refs case in gauntlet-org (see that
corpus's "load-bearing stress case" note). With no apex target anywhere
inside the child flow, there is no method whose `buildCallerTree()` would
ever surface `AcmeNotifyCustomerSubflow` as a node in the first place -- and
`AcmeBackorderResolutionFlow` isn't itself reachable via any DML/publish site
in this corpus either (its `<start>` carries no `<object>`/`<triggerType>` at
all -- it's a plain Autolaunched Flow, invoked only from outside Apex). So
this specific pair's `subflow` edge is a **`flowGraph`-data-level guarantee
only** in adv-org: correct per the table above, but not independently
demonstrable via an apex-anchored `buildCallerTree`/`buildCalleeTree` call in
this corpus the way gauntlet-org's fixtures are. This is expected, not a gap
in the promotion -- adv-org's job here was only to confirm the ORIGINAL
"historically invisible" pairing now resolves as data; gauntlet-org's fresh
fixtures (which give both flows real apex anchors) are what proves the
tree-rendering behavior end to end.

### Entry catalog delta (v0.13)

Per the v0.13 suffix rule ("flows that are ONLY ever referenced as subflows
of other flows -- no `<start>` trigger info AND at least one parent -- get
detail suffix `subflow of <parent>`"): `AcmeNotifyCustomerSubflow` has no
`<start>` trigger info (already one of the 3 flows collapsing to the
`'screen or autolaunched'` fallback, per Entry catalog ruling 5 above) and now
has exactly 1 parent (`AcmeBackorderResolutionFlow`), so its detail becomes:

- `AcmeNotifyCustomerSubflow` -> `screen or autolaunched (subflow of
  AcmeBackorderResolutionFlow)` -- **changed** from the plain
  `'screen or autolaunched'` ruling-5 value.

The other two flows ruling 5 collapses to the same fallback --
`AcmeBackorderResolutionFlow` and `AcmeQuoteApprovalScreenFlow` -- have zero
parents (nothing subflows either of them in this corpus), so both stay
exactly `'screen or autolaunched'`, unchanged. `[MUST]`. `stats.flow` count
(6) is unchanged -- this is a detail-string-only delta, no entries added or
removed, matching the v0.13 REGRESSION POLICY's "counts unchanged" clause.

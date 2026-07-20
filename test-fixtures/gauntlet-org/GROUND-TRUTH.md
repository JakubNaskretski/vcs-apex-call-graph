# gauntlet-org — GROUND TRUTH

Engine-blind validation corpus for `vcs-apex-call-graph`'s static Apex call-graph
engine (`parser.js` + `resolver.js`). This document was written **without running
or reading the engine's implementation** beyond the documented, published API and
`README.md` behavior contract — it is a from-first-principles prediction of what a
correct engine should report, built purely from Apex semantics and the engine's own
published guarantees. Its job is to let an examiner run the real engine against
this corpus and classify every mismatch as either a **BUG** (documented-supported
behavior that didn't happen) or a **KNOWN-GAP** (an honestly-out-of-scope limit that
behaved exactly as the README says it should).

Purpose: reproduce, in a fully synthetic and fictional org, the specific pain a real
user reported on real enterprise orgs — "complex solutions with different names",
"Apex-only gaps" (metadata/managed-code the engine can't see into), and heavy
fan-in where one method has many, many callers.

Fictional only: `Vertex*` is the corpus's own domain (order-to-cash), `zenq` /
`kwx__` are **fictional, never-declared** managed-package namespaces used solely to
test how the engine behaves when code references packages that don't exist in the
workspace. No real company, person, or credential appears anywhere below.

## 0. How to read this document

- **`[MUST]`** — the engine's own `README.md` documents this as supported behavior
  today. A live run that disagrees is a **BUG**.
- **`[IDEAL]`** — this is the honest, correct static-analysis answer, but it falls
  into one of the engine's documented, by-design limits (chain depth, non-literal
  `Type.forName`/`Type.newInstance`, no property-accessor `CallFacts`, no
  namespaced/managed-code modeling). A live run that matches this is evidence the
  gap is real and understood; it is **not** a defect. Where a live run might
  instead produce a plausible-looking *wrong* edge (a false positive), that
  specific risk is called out explicitly so the examiner can tell **BUG** (false
  edge fabricated) from **KNOWN-GAP** (correctly absent/unresolved).
- **`[MUST — resolved 2026-07-16: live engine fires BOTH the external-object node and the local-trigger fan-out on the same managed-object DML site; asserted in dev/gauntlet/run.js B2]`** — the README does not say one way or the other; this
  document takes no position on expected behavior and asks the examiner to record
  what actually happens so it can be classified in a future round.
- **via kinds** used below (`typed`, `static`, `new`, `this`/`super`, `interface`
  `~`, `unique-name` `~`, `dml`, `async`, `ambiguous` `~`, `lexical`) are exactly
  the resolver's own documented kinds from `README.md` § "Reference: how edges are
  resolved". `~` marks an approximate/fan-out edge per the engine's own
  `APPROX_VIA` convention.
- **Grouping**: per the engine's tree-shaping contract, one **caller node** = one
  calling *method*; multiple call sites to the same target inside that one method
  render as multiple **site rows** under a single node (see README's `[Path Map]`
  and the "3 call sites in one grouped node" pattern) — not as 3 separate nodes.
  Two targets in this corpus are purpose-built to assert exactly this.
- All line numbers below are **build targets** for the corpus author (the
  builder agents), assuming the exact skeleton density shown (one statement per
  line, member signature and closing brace each on their own line, a single blank
  separator line between members, no leading file-header comment block). Builders
  must match this density so line numbers stay accurate; if a builder must deviate,
  re-run the "Corpus map" line references against the actual written file before
  treating a mismatch as a resolver defect.

## 1. Corpus map

SFDX layout, single default package directory `force-app`. All classes live in
`force-app/main/default/classes/*.cls` (+ `.cls-meta.xml` sidecar per class,
`apiVersion` 59.0, `status` Active), the one trigger in
`force-app/main/default/triggers/*.trigger` (+ `.trigger-meta.xml` sidecar). No
custom-object metadata is required anywhere in this corpus — every `__c` token
below (`Vertex_Order__c`, `Vertex_Shipment__c`, `Vertex_Item__c`,
`Vertex_Alert__c`, `kwx__Ledger__c`) is used purely as a field/SObject-type token
in Apex source; `parser.js` parses syntax only and never validates schema, so no
object/field XML is needed for this corpus to be meaningful. 63 source files
total (57 `.cls` + 1 `.trigger`, organized into 5 clusters below — corrected tally
in §5).

| Cluster | Files | Requirement |
|---|---:|---|
| A — Heavy fan-in (`reprice`) | 22 (21 `.cls` + 1 `.trigger`) | Must-cover #1 |
| B — Same-name everywhere (`process`) | 13 | Must-cover #2 |
| C — Naming traps | 5 | Must-cover #3 |
| D — Enterprise indirection | 8 | Must-cover #4 |
| E — Language corners | 15 | Must-cover #5 |
| **Total** | **63** | |

---

### Cluster A — Heavy fan-in: `VertexPricingService.reprice`

| Path | Role |
|---|---|
| `classes/VertexRepriceable.cls` | Interface: `void reprice(Vertex_Order__c)`. |
| `classes/VertexPricingService.cls` | **Primary target.** `reprice` (virtual instance method, 16+ callers) + `repriceOrder` (static entry wrapper). |
| `classes/VertexPremiumPricingService.cls` | `extends VertexPricingService`, `override`s `reprice` — override fan-out target. |
| `classes/VertexShippingCostService.cls` | **Precision trap.** Unrelated class, its own `reprice(Vertex_Shipment__c)` — must never pollute `VertexPricingService.reprice`'s tree. |
| `classes/VertexShippingController.cls` | Sole caller of the trap class above. |
| `classes/VertexOrderController.cls` | `@AuraEnabled` controller, 2 distinct callers (`recalculate`, `bulkRecalculate`). |
| `classes/VertexOrderService.cls` | `processOrder` (1 site), `reconcileOrder` (**multi-site #1**, 2 sites/1 node), `loadOrders` (selector caller), `run` (naming-trap positive leg). |
| `classes/VertexOrderTriggerHandler.cls` | Trigger-handler chain link: `handleAfterUpdate`, `handleAfterInsert`. |
| `triggers/VertexOrderTrigger.trigger` | Trigger entry point → both handler methods. |
| `classes/VertexRepriceBatch.cls` | `Database.Batchable`; `execute` calls target, `finish` chains `Database.executeBatch` to `VertexFollowupBatch` (async hop). |
| `classes/VertexFollowupBatch.cls` | Chained-to batch; terminal, no further calls of interest. |
| `classes/VertexBulkRepriceUtil.cls` | Static utility, **multi-site #2** (2 sites/1 node). |
| `classes/VertexRepriceableDispatcher.cls` | Interface-typed dispatch → fans out to base **and** override (`VertexPremiumPricingService`). |
| `classes/VertexPricingServiceTest.cls` | `@isTest` #1, direct unit-test caller. |
| `classes/VertexOrderServiceTest.cls` | `@isTest` #2: direct caller + indirect caller via `reconcileOrder`. |
| `classes/VertexOrderTriggerHandlerTest.cls` | `@isTest` #3: direct caller + indirect caller via the handler. |
| `classes/VertexOrderApprovalInvocable.cls` | `@InvocableMethod` entry point. |
| `classes/VertexOrderConversionService.cls` | Plain typed caller #15. |
| `classes/VertexQuoteToOrderConverter.cls` | Plain typed caller #16. |
| `classes/VertexOrderStaticFacade.cls` | Calls the **static** entry (`repriceOrder`), 2 hops from the target. |
| `classes/VertexNightlyAdjustmentJob.cls` | `Schedulable`; async hop into `VertexRepriceBatch.execute`, 3 hops from the target. |
| `classes/VertexOrderMigrationUtil.cls` | **Precision trap.** Ambiguous 2-candidate receiver (`reprice` declared on both `VertexPricingService` and `VertexShippingCostService`) — expected NON-edge. |

### Cluster B — Same name everywhere: `process(...)` on 12 classes

| Path | Role |
|---|---|
| `classes/VertexIngestProcessor.cls` … `classes/VertexFinalizeProcessor.cls` (12 files, listed in §2) | Each independently declares `public void process(Vertex_Item__c item)`. No shared interface — deliberate copy-paste-across-teams naming collision, zero type relationship. |
| `classes/VertexPipelineRunner.cls` | 2 resolvable typed callers + 1 unresolvable short-chain caller (must produce a NON-edge into all 12). |

### Cluster C — Naming traps

| Path | Role |
|---|---|
| `classes/VertexOrderServices.cls` | Near-duplicate name (plural) of `VertexOrderService`, unrelated `run` impl. |
| `classes/Vertex_Order_Service.cls` | Near-duplicate name (underscore variant), unrelated `run` impl. |
| `classes/VertexOrderRunnerUtil.cls` | Case-variant call site (`vertexorderservice.RUN(...)`) + 2 contrast calls to the near-duplicates. |
| `classes/Billing.cls` | Local class shadowing the *bare name* of a fictional managed class (`zenq.Billing`). |
| `classes/VertexLedgerBridge.cls` | Bundles all 3 nonexistent-managed-code probes: `kwx__LedgerService` (class), `kwx__Ledger__c` (DML), `zenq.Billing.charge` (namespaced call). |

### Cluster D — Enterprise indirection (fflib-style, fictional)

| Path | Role |
|---|---|
| `classes/VertexPricingServiceInterface.cls` | Service-layer interface (`priceItems`). |
| `classes/VertexPricingServiceImpl.cls` | Sole implementer. |
| `classes/VertexApplication.cls` | Factory: `Map<Type,Type> serviceBindings`, `newInstance(Type)`. |
| `classes/VertexApplicationConsumer.cls` | Calls the factory, casts to interface, dispatches. |
| `classes/VertexOrderSelector.cls` | Selector-layer pattern, called from `VertexOrderService.loadOrders`. |
| `classes/VertexTriggerHandlerInterface.cls` | Handler interface (`run`). |
| `classes/VertexGenericTriggerDispatcher.cls` | CMDT-like `Map<String,Type>` handler registry + dynamic dispatch. |
| `classes/VertexAlertTriggerHandler.cls` | Sole registered handler. |

### Cluster E — Language corners

| Path | Role |
|---|---|
| `classes/VertexOrderProcessor.cls` | `Outer.Mid.Inner` — 2-deep nested inner classes (`Batch.Row`). |
| `classes/VertexNestedConsumer.cls` | Cross-file consumer of the 2-deep inner type. |
| `classes/VertexInvoiceLine.cls` | Method + property sharing one name (`Amount`/`Amount()`) — see legality caveat in §3, Target 16. |
| `classes/VertexInvoiceLineConsumer.cls` | Exercises both the property (get/set) and the method call. |
| `classes/VertexDiscountCalculator.cls` | Static + instance overloads of `calculate`, different arity. |
| `classes/VertexDiscountConsumer.cls` | Calls both overloads. |
| `classes/VertexNestedIndexBuilder.cls` | Recursive generics: `Map<String, List<Map<Id, VertexIndexEntry>>>` — parse-robustness only. |
| `classes/VertexIndexEntry.cls` | Plain data class used only by the generics probe. |
| `classes/VertexStatusRouter.cls` | ~400-line `switch on` method, 18 named branches + 1 `when else`, each calling its own private handler. |
| `classes/VertexStatusRouterConsumer.cls` | Caller, 2 sites/1 node (bonus multi-site demo). |
| `classes/VertexReadable.cls` | Interface #1, declares `sync()`. |
| `classes/VertexWritable.cls` | Interface #2, declares the same `sync()` signature. |
| `classes/VertexSyncable.cls` | `extends VertexReadable, VertexWritable` — diamond re-declaration of `sync()`. |
| `classes/VertexDataBridge.cls` | `implements VertexSyncable` — one method body satisfies both parent contracts. |
| `classes/VertexSyncConsumer.cls` | Dispatches through `VertexSyncable` (direct) **and** `VertexReadable` (transitive-only) — see Target 19. |

---

## 2. File-by-file build spec (line-level call shapes)

Every call site below carries its expected resolution inline. Builders: write
exactly this shape (comments may be dropped/adapted, but the call expressions and
line positions must match).

### A1 `classes/VertexRepriceable.cls`
```
L1  public interface VertexRepriceable {
L2    void reprice(Vertex_Order__c order);
L3  }
```

### A2 `classes/VertexPricingService.cls`  — PRIMARY TARGET
```
L1  public class VertexPricingService implements VertexRepriceable {
L2
L3    public virtual void reprice(Vertex_Order__c order) {
L4      applyBaseRate(order);          // -> VertexPricingService.applyBaseRate [via=this] [MUST]
L5      applyDiscountTiers(order);     // -> VertexPricingService.applyDiscountTiers [via=this] [MUST]
L6    }
L7
L8    private void applyBaseRate(Vertex_Order__c order) {
L9      order.TotalAmount__c = order.TotalAmount__c;
L10   }
L11
L12   private void applyDiscountTiers(Vertex_Order__c order) {
L13     order.TotalAmount__c = order.TotalAmount__c;
L14   }
L15
L16   public static void repriceOrder(Vertex_Order__c order) {
L17     new VertexPricingService().reprice(order);   // -> VertexPricingService.reprice [via=new] [MUST]
L18   }
L19 }
```

### A3 `classes/VertexPremiumPricingService.cls`
```
L1  public class VertexPremiumPricingService extends VertexPricingService {
L2    public override void reprice(Vertex_Order__c order) {
L3      super.reprice(order);              // -> VertexPricingService.reprice [via=super] [MUST]
L4      applyPremiumSurcharge(order);      // -> VertexPremiumPricingService.applyPremiumSurcharge [via=this] [MUST]
L5    }
L6    private void applyPremiumSurcharge(Vertex_Order__c order) {
L7      order.TotalAmount__c = order.TotalAmount__c;
L8    }
L9  }
```

### A4 `classes/VertexShippingCostService.cls`  — PRECISION-TRAP TARGET (unrelated `reprice`)
```
L1  public class VertexShippingCostService {
L2    public void reprice(Vertex_Shipment__c shipment) {
L3      shipment.FreightCost__c = shipment.FreightCost__c;
L4    }
L5  }
```

### A5 `classes/VertexShippingController.cls`
```
L1  public with sharing class VertexShippingController {
L2    public void recalcShipping(Vertex_Shipment__c shipment) {
L3      VertexShippingCostService svc = new VertexShippingCostService();
L4      svc.reprice(shipment);   // -> VertexShippingCostService.reprice [via=typed] [MUST] — must NEVER appear under VertexPricingService.reprice
L5    }
L6  }
```

### A6 `classes/VertexOrderController.cls`
```
L1  public with sharing class VertexOrderController {
L2
L3    @AuraEnabled
L4    public static void recalculate(Id orderId) {
L5      Vertex_Order__c order = new Vertex_Order__c(Id = orderId);
L6      VertexPricingService svc = new VertexPricingService();
L7      svc.reprice(order);      // -> VertexPricingService.reprice [via=typed] [MUST]  (◉ root: @AuraEnabled entry)
L8    }
L9
L10   @AuraEnabled
L11   public static void bulkRecalculate(List<Id> orderIds) {
L12     VertexPricingService svc = new VertexPricingService();
L13     for (Id orderId : orderIds) {
L14       svc.reprice(new Vertex_Order__c(Id = orderId));  // -> VertexPricingService.reprice [via=typed] [MUST]  (◉ root: @AuraEnabled entry)
L15     }
L16   }
L17 }
```

### A7 `classes/VertexOrderService.cls`
```
L1  public class VertexOrderService {
L2
L3    public void processOrder(Vertex_Order__c order) {
L4      VertexPricingService svc = new VertexPricingService();
L5      svc.reprice(order);            // -> VertexPricingService.reprice [via=typed] [MUST]
L6    }
L7
L8    public void reconcileOrder(Vertex_Order__c order, Boolean applyDiscount) {
L9      VertexPricingService svc = new VertexPricingService();
L10     svc.reprice(order);            // site 1 -> VertexPricingService.reprice [via=typed] [MUST]
L11     if (applyDiscount) {
L12       order.DiscountApplied__c = true;
L13       svc.reprice(order);          // site 2 -> VertexPricingService.reprice [via=typed] [MUST]  — MULTI-SITE #1: 1 caller node, 2 site rows
L14     }
L15   }
L16
L17   public List<Vertex_Order__c> loadOrders(Set<Id> ids) {
L18     return VertexOrderSelector.selectById(ids);    // -> VertexOrderSelector.selectById [via=static] [MUST]
L19   }
L20
L21   public static void run(Vertex_Order__c order) {
L22     System.debug('VertexOrderService.run: ' + order);
L23   }
L24 }
```

### A8 `classes/VertexOrderTriggerHandler.cls`
```
L1  public class VertexOrderTriggerHandler {
L2
L3    public void handleAfterUpdate(List<Vertex_Order__c> orders) {
L4      VertexPricingService svc = new VertexPricingService();
L5      for (Vertex_Order__c order : orders) {
L6        svc.reprice(order);   // -> VertexPricingService.reprice [via=typed] [MUST]
L7      }
L8    }
L9
L10   public void handleAfterInsert(List<Vertex_Order__c> orders) {
L11     VertexPricingService svc = new VertexPricingService();
L12     for (Vertex_Order__c order : orders) {
L13       svc.reprice(order);   // -> VertexPricingService.reprice [via=typed] [MUST]
L14     }
L15   }
L16 }
```

### A9 `triggers/VertexOrderTrigger.trigger`
```
L1  trigger VertexOrderTrigger on Vertex_Order__c (after update, after insert) {
L2    VertexOrderTriggerHandler handler = new VertexOrderTriggerHandler();
L3    if (Trigger.isUpdate) {
L4      handler.handleAfterUpdate(Trigger.new);   // -> VertexOrderTriggerHandler.handleAfterUpdate [via=typed] [MUST]  (◉ root: trigger entry)
L5    }
L6    if (Trigger.isInsert) {
L7      handler.handleAfterInsert(Trigger.new);   // -> VertexOrderTriggerHandler.handleAfterInsert [via=typed] [MUST]  (◉ root: trigger entry)
L8    }
L9  }
```

### A10 `classes/VertexRepriceBatch.cls`  — CALLEE-TREE A TARGET
```
L1  global class VertexRepriceBatch implements Database.Batchable<SObject> {
L2
L3    global Database.QueryLocator start(Database.BatchableContext bc) {
L4      return Database.getQueryLocator([SELECT Id FROM Vertex_Order__c]);   // SOQL only, no Apex callee
L5    }
L6
L7    global void execute(Database.BatchableContext bc, List<Vertex_Order__c> scope) {
L8      VertexPricingService svc = new VertexPricingService();
L9      for (Vertex_Order__c order : scope) {
L10       svc.reprice(order);    // -> VertexPricingService.reprice [via=typed] [MUST]
L11     }
L12   }
L13
L14   global void finish(Database.BatchableContext bc) {
L15     Database.executeBatch(new VertexFollowupBatch());  // -> VertexFollowupBatch.execute [via=async] [MUST]
L16   }
L17 }
```

### A11 `classes/VertexFollowupBatch.cls`
```
L1  global class VertexFollowupBatch implements Database.Batchable<SObject> {
L2    global Database.QueryLocator start(Database.BatchableContext bc) {
L3      return Database.getQueryLocator([SELECT Id FROM Vertex_Order__c WHERE FollowupNeeded__c = true]);
L4    }
L5    global void execute(Database.BatchableContext bc, List<Vertex_Order__c> scope) {
L6      System.debug('follow-up batch processed ' + scope.size());
L7    }
L8    global void finish(Database.BatchableContext bc) {
L9    }
L10 }
```

### A12 `classes/VertexBulkRepriceUtil.cls`
```
L1  public class VertexBulkRepriceUtil {
L2    public static void repriceBatch(List<Vertex_Order__c> orders, Vertex_Order__c priorityOrder) {
L3      VertexPricingService svc = new VertexPricingService();
L4      for (Vertex_Order__c order : orders) {
L5        svc.reprice(order);            // site 1 -> VertexPricingService.reprice [via=typed] [MUST]
L6      }
L7      if (priorityOrder != null) {
L8        svc.reprice(priorityOrder);    // site 2 -> VertexPricingService.reprice [via=typed] [MUST]  — MULTI-SITE #2: 1 caller node, 2 site rows
L9      }
L10   }
L11 }
```

### A13 `classes/VertexRepriceableDispatcher.cls`
```
L1  public class VertexRepriceableDispatcher {
L2    public void dispatch(VertexRepriceable svc, Vertex_Order__c order) {
L3      svc.reprice(order);
L4      // -> VertexPricingService.reprice        [via=interface, ~] [MUST]
L5      // -> VertexPremiumPricingService.reprice  [via=interface, ~ override] [MUST]  — override fan-out
L6    }
L7  }
```

### A14 `classes/VertexPricingServiceTest.cls`
```
L1  @isTest
L2  public class VertexPricingServiceTest {
L3    @isTest
L4    static void testReprice() {
L5      Vertex_Order__c order = new Vertex_Order__c();
L6      VertexPricingService svc = new VertexPricingService();
L7      svc.reprice(order);   // -> VertexPricingService.reprice [via=typed] [MUST]  (test badge, ◉ root)
L8    }
L9  }
```

### A15 `classes/VertexOrderServiceTest.cls`
```
L1  @isTest
L2  public class VertexOrderServiceTest {
L3
L4    @isTest
L5    static void testDirectReprice() {
L6      Vertex_Order__c order = new Vertex_Order__c();
L7      VertexPricingService svc = new VertexPricingService();
L8      svc.reprice(order);    // -> VertexPricingService.reprice [via=typed] [MUST]  (test badge, ◉ root)
L9    }
L10
L11   @isTest
L12   static void testReconcileOrder() {
L13     VertexOrderService service = new VertexOrderService();
L14     service.reconcileOrder(new Vertex_Order__c(), true);  // -> VertexOrderService.reconcileOrder [via=typed] [MUST]  (test badge, ◉ root)
L15   }
L16 }
```

### A16 `classes/VertexOrderTriggerHandlerTest.cls`
```
L1  @isTest
L2  public class VertexOrderTriggerHandlerTest {
L3    @isTest
L4    static void testHandleAfterUpdateDirect() {
L5      Vertex_Order__c order = new Vertex_Order__c();
L6      VertexPricingService svc = new VertexPricingService();
L7      svc.reprice(order);    // -> VertexPricingService.reprice [via=typed] [MUST]  (test badge, ◉ root)
L8    }
L9
L10   @isTest
L11   static void testHandleAfterUpdateViaHandler() {
L12     VertexOrderTriggerHandler handler = new VertexOrderTriggerHandler();
L13     handler.handleAfterUpdate(new List<Vertex_Order__c>{ new Vertex_Order__c() });  // -> VertexOrderTriggerHandler.handleAfterUpdate [via=typed] [MUST]  (test badge, ◉ root)
L14   }
L15 }
```

### A17 `classes/VertexOrderApprovalInvocable.cls`
```
L1  public class VertexOrderApprovalInvocable {
L2    @InvocableMethod(label='Approve And Reprice Orders')
L3    public static void execute(List<Id> orderIds) {
L4      VertexPricingService svc = new VertexPricingService();
L5      for (Id orderId : orderIds) {
L6        svc.reprice(new Vertex_Order__c(Id = orderId));  // -> VertexPricingService.reprice [via=typed] [MUST]  (◉ root: @InvocableMethod entry)
L7      }
L8    }
L9  }
```

### A18 `classes/VertexOrderConversionService.cls`
```
L1  public class VertexOrderConversionService {
L2    public void convertAndReprice(Vertex_Order__c order) {
L3      VertexPricingService svc = new VertexPricingService();
L4      svc.reprice(order);   // -> VertexPricingService.reprice [via=typed] [MUST]
L5    }
L6  }
```

### A19 `classes/VertexQuoteToOrderConverter.cls`
```
L1  public class VertexQuoteToOrderConverter {
L2    public void finalizeOrder(Vertex_Order__c order) {
L3      VertexPricingService svc = new VertexPricingService();
L4      svc.reprice(order);   // -> VertexPricingService.reprice [via=typed] [MUST]
L5    }
L6  }
```

### A20 `classes/VertexOrderStaticFacade.cls`
```
L1  public class VertexOrderStaticFacade {
L2    public static void triggerReprice(Vertex_Order__c order) {
L3      VertexPricingService.repriceOrder(order);  // -> VertexPricingService.repriceOrder [via=static] [MUST]  — 2 hops from reprice itself
L4    }
L5  }
```

### A21 `classes/VertexNightlyAdjustmentJob.cls`
```
L1  global class VertexNightlyAdjustmentJob implements Schedulable {
L2    global void execute(SchedulableContext sc) {
L3      Database.executeBatch(new VertexRepriceBatch());  // -> VertexRepriceBatch.execute [via=async] [MUST]  (◉ root: Schedulable entry, 3 hops from reprice)
L4    }
L5  }
```

### A22 `classes/VertexOrderMigrationUtil.cls`  — PRECISION-TRAP TARGET (ambiguous receiver, 2 candidates)
```
L1  public class VertexOrderMigrationUtil {
L2    public void legacyRepriceDispatch(String serviceKey, Vertex_Order__c order) {
L3      locateService(serviceKey).reprice(order);
L4      // NON-EDGE: 2 classes declare `reprice` (VertexPricingService, VertexShippingCostService).
L5      // The receiver's type comes from a same-file method call whose return type (`Object`) the
L6      // resolver does not/cannot follow into either candidate, so typed resolution fails; the
L7      // unique-name fallback requires EXACTLY ONE declaring class and must refuse with 2 — no
L8      // edge to either class, call site counted unresolved. [IDEAL — confirms the unique-name
L9      // candidate-count guard at N=2; risk if violated: a false edge to whichever of the 2 the
L10     // engine happens to pick first would be a BUG, not a gap.]
L11   }
L12   private Object locateService(String key) {
L13     return null;
L14   }
L15 }
```

---

### B1–B12 `classes/Vertex{Ingest,Validation,Enrichment,Routing,Audit,Billing,Compliance,Archive,Notify,Sync,Cleanup,Finalize}Processor.cls`

All 12 files share the identical 5-line skeleton (only class name + status string
differ), and are the deliberate 12-way name collision on `process`:

```
L1  public class Vertex<Stage>Processor {
L2    public void process(Vertex_Item__c item) {
L3      item.Status__c = '<Stage>';
L4    }
L5  }
```

| Class | `<Stage>` |
|---|---|
| `VertexIngestProcessor` | `Ingested` |
| `VertexValidationProcessor` | `Validated` |
| `VertexEnrichmentProcessor` | `Enriched` |
| `VertexRoutingProcessor` | `Routed` |
| `VertexAuditProcessor` | `Audited` |
| `VertexBillingProcessor` | `Billed` |
| `VertexComplianceProcessor` | `ComplianceChecked` |
| `VertexArchiveProcessor` | `Archived` |
| `VertexNotifyProcessor` | `Notified` |
| `VertexSyncProcessor` | `Synced` |
| `VertexCleanupProcessor` | `CleanedUp` |
| `VertexFinalizeProcessor` | `Finalized` |

### B13 `classes/VertexPipelineRunner.cls`
```
L1  public class VertexPipelineRunner {
L2
L3    public void runIngest(Vertex_Item__c item) {
L4      VertexIngestProcessor p = new VertexIngestProcessor();
L5      p.process(item);    // -> VertexIngestProcessor.process [via=typed] [MUST]
L6    }
L7
L8    public void runValidation(Vertex_Item__c item) {
L9      new VertexValidationProcessor().process(item);  // -> VertexValidationProcessor.process [via=typed] [MUST]
L10   }
L11
L12   public void runDynamic(String stepKey, Vertex_Item__c item) {
L13     locateStep(stepKey).process(item);
L14     // NON-EDGE: 12 classes declare `process`. locateStep()'s return type (`Object`) is not
L15     // inferred across the chain, so typed resolution fails; unique-name fallback requires
L16     // EXACTLY ONE declaring class and must refuse with 12 candidates — zero edges into ANY
L17     // of the 12, call site counted unresolved. [IDEAL — same guard as A22, at N=12. This is
L18     // the corpus's primary demonstration of must-cover #2: "must NOT produce unique-name
L19     // edges when 12 candidates exist".]
L20   }
L21
L22   private Object locateStep(String key) {
L23     return null;
L24   }
L25 }
```

---

### C1 `classes/VertexOrderServices.cls`
```
L1  public class VertexOrderServices {
L2    public static void run(Vertex_Order__c order) {
L3      System.debug('VertexOrderServices.run (near-duplicate name, unrelated impl): ' + order);
L4    }
L5  }
```

### C2 `classes/Vertex_Order_Service.cls`
```
L1  public class Vertex_Order_Service {
L2    public static void run(Vertex_Order__c order) {
L3      System.debug('Vertex_Order_Service.run (underscore variant, unrelated impl): ' + order);
L4    }
L5  }
```

### C3 `classes/VertexOrderRunnerUtil.cls`
```
L1  public class VertexOrderRunnerUtil {
L2
L3    public void triggerCaseVariantRun(Vertex_Order__c order) {
L4      vertexorderservice.RUN(order);   // -> VertexOrderService.run [via=static, case-insensitive] [MUST] — lowercase class ref + uppercase method ref, same symbol (Apex identifiers are case-insensitive)
L5    }
L6
L7    public void triggerPluralRun(Vertex_Order__c order) {
L8      VertexOrderServices.run(order);  // -> VertexOrderServices.run [via=static] [MUST] — must NOT resolve to VertexOrderService
L9    }
L10
L11   public void triggerUnderscoreRun(Vertex_Order__c order) {
L12     Vertex_Order_Service.run(order); // -> Vertex_Order_Service.run [via=static] [MUST] — must NOT resolve to VertexOrderService or VertexOrderServices
L13   }
L14 }
```

### C4 `classes/Billing.cls`  — local class shadowing the bare name of fictional managed `zenq.Billing`
```
L1  public class Billing {
L2    public static void charge(Decimal amount) {
L3      System.debug('local Billing.charge: ' + amount);
L4    }
L5  }
```

### C5 `classes/VertexLedgerBridge.cls`  — bundles all 3 nonexistent-managed-code probes
```
L1  public class VertexLedgerBridge {
L2    public void postToLedger(Vertex_Order__c order) {
L3      Billing.charge(order.TotalAmount__c);
L4      // -> Billing.charge (local) [via=static] [MUST]
L5
L6      kwx__LedgerService.postEntry(order.Id, order.TotalAmount__c);
L7      // NON-EDGE: kwx__LedgerService is never declared anywhere in this corpus (fictional
L8      // managed class). Zero possible local edge. Should still be extracted as a well-formed
L9      // dot-call CallFacts entry and counted toward the workspace-wide unresolved tally — if it
L10     // is silently dropped instead (e.g. the `kwx__` token confuses the parser), that under-
L11     // counts and should be flagged. [IDEAL]
L12
L13     insert new kwx__Ledger__c(Order__c = order.Id, Amount__c = order.TotalAmount__c);
L14     // NON-EDGE (trigger fan-out): DML on fictional managed custom object kwx__Ledger__c; no
L15     // trigger on that object exists anywhere in this corpus, so the dml->trigger fan-out
L16     // correctly finds zero targets. This is CORRECT behavior, not a gap — no special
L17     // namespaced-object handling is needed for this line to behave. [MUST-equivalent]
L18
L19     zenq.Billing.charge(order.TotalAmount__c);
L20     // PRECISION-TRAP NON-EDGE: namespace-qualified reference to fictional managed
L21     // `zenq.Billing.charge`. Must NOT collapse onto the LOCAL `Billing.charge` (line 3) just
L22     // because the bare method/class name matches once the `zenq.` prefix is stripped.
L23     // [IDEAL — namespaced/managed references are not modeled, so honest expected output is
L24     // "no edge, counted unresolved". BUG-vs-GAP: if a live run shows an edge from this line to
L25     // the LOCAL Billing.charge, that is a BUG (false-positive namespace-prefix collapse onto
L26     // an unrelated local class). If it shows unresolved/absent, that is correct and consistent
L27     // with the documented "namespaced/managed references not yet modeled" limit.]
L28   }
L29 }
```

---

### D1 `classes/VertexPricingServiceInterface.cls`
```
L1  public interface VertexPricingServiceInterface {
L2    Decimal priceItems(List<Vertex_Item__c> items);
L3  }
```

### D2 `classes/VertexPricingServiceImpl.cls`
```
L1  public class VertexPricingServiceImpl implements VertexPricingServiceInterface {
L2    public Decimal priceItems(List<Vertex_Item__c> items) {
L3      return items.size() * 1.0;
L4    }
L5  }
```

### D3 `classes/VertexApplication.cls`  — fflib-style factory
```
L1  public class VertexApplication {
L2    public static Map<Type, Type> serviceBindings = new Map<Type, Type>{
L3      VertexPricingServiceInterface.class => VertexPricingServiceImpl.class
L4    };
L5
L6    public static Object newInstance(Type interfaceType) {
L7      Type implType = serviceBindings.get(interfaceType);
L8      return implType.newInstance();
L9      // NON-EDGE (constructor): implType is sourced from a Map<Type,Type> value lookup, not a
L10     // Type.forName('literal') call — this is a DIFFERENT and even-less-tractable shape than
L11     // the documented "Type.forName non-literal untraced" limit (there is no forName call here
L12     // at all to even partially recognize). Honest expected output: no constructor edge to
L13     // VertexPricingServiceImpl.<init>. [IDEAL]
L14   }
L15 }
```

### D4 `classes/VertexApplicationConsumer.cls`
```
L1  public class VertexApplicationConsumer {
L2    public Decimal priceViaFactory(List<Vertex_Item__c> items) {
L3      VertexPricingServiceInterface svc = (VertexPricingServiceInterface) VertexApplication.newInstance(VertexPricingServiceInterface.class);
L4      // -> VertexApplication.newInstance [via=static] [MUST]
L5      return svc.priceItems(items);
L6      // -> VertexPricingServiceImpl.priceItems [via=interface, ~] [MUST] — resolves via the
L7      // CAST's declared type on line 3, entirely independent of whether the engine understands
L8      // the Map<Type,Type> binding it can't see through. Worth stating explicitly: the engine
L9      // gets the right answer here for a simpler reason than "it understood the factory".
L10   }
L11 }
```

### D5 `classes/VertexOrderSelector.cls`
```
L1  public class VertexOrderSelector {
L2    public static List<Vertex_Order__c> selectById(Set<Id> ids) {
L3      return [SELECT Id, TotalAmount__c FROM Vertex_Order__c WHERE Id IN :ids];
L4    }
L5  }
```
(Callers: `VertexOrderService.loadOrders` — see A7:18.)

### D6 `classes/VertexTriggerHandlerInterface.cls`
```
L1  public interface VertexTriggerHandlerInterface {
L2    void run();
L3  }
```

### D7 `classes/VertexGenericTriggerDispatcher.cls`  — CMDT-like handler registry
```
L1  public class VertexGenericTriggerDispatcher {
L2    private static Map<String, Type> handlerMap = new Map<String, Type>{
L3      'Vertex_Alert__c' => VertexAlertTriggerHandler.class
L4    };
L5
L6    public void dispatch(String sobjectName) {
L7      Type handlerType = handlerMap.get(sobjectName);
L8      VertexTriggerHandlerInterface handler = (VertexTriggerHandlerInterface) handlerType.newInstance();
L9      // NON-EDGE (constructor): same Map<Type,Type>-sourced dynamic instantiation shape as
L10     // VertexApplication (D3) — no constructor edge to VertexAlertTriggerHandler.<init>. [IDEAL]
L11     handler.run();
L12     // -> VertexAlertTriggerHandler.run [via=interface, ~] [MUST] — resolves via the CAST's
L13     // declared type on line 8 only, same lesson as D4.
L14   }
L15 }
```

### D8 `classes/VertexAlertTriggerHandler.cls`
```
L1  public class VertexAlertTriggerHandler implements VertexTriggerHandlerInterface {
L2    public void run() {
L3      System.debug('alert handler run');
L4    }
L5  }
```

---

### E1 `classes/VertexOrderProcessor.cls`  — 2-deep nested inner classes
```
L1  public class VertexOrderProcessor {
L2
L3    public class Batch {
L4      public class Row {
L5        public String label;
L6        public void process() {
L7          VertexOrderProcessor.staticHelper();   // -> VertexOrderProcessor.staticHelper [via=static] [MUST] — inner-inner-to-outer static callback, 2 levels up
L8        }
L9      }
L10   }
L11
L12   public static void staticHelper() {
L13     System.debug('outer helper called from 2-deep inner');
L14   }
L15 }
```

### E2 `classes/VertexNestedConsumer.cls`
```
L1  public class VertexNestedConsumer {
L2    public void run() {
L3      VertexOrderProcessor.Batch.Row row = new VertexOrderProcessor.Batch.Row();
L4      // -> VertexOrderProcessor.Batch.Row.<init> [via=new] [MUST] — fully-qualified Outer.Mid.Inner, cross-file, 2 levels deep
L5      row.process();
L6      // -> VertexOrderProcessor.Batch.Row.process [via=typed] [MUST]
L7    }
L8  }
```

### E3 `classes/VertexInvoiceLine.cls`  — method + property share one name
```
L1  public class VertexInvoiceLine {
L2    public Decimal Amount { get; set; }
L3
L4    public Decimal Amount() {
L5      return this.Amount;
L6    }
L7  }
```
**Legality caveat (must be stated in any examiner report):** a property and a
method sharing one identifier (case-insensitively — Apex is case-insensitive) is
almost certainly **not legal, deployable Apex** (duplicate member name) — real
`sfdx-cli`/Salesforce compilation would very likely reject this class. It is
included anyway because `parser.js` is a pure ANTLR **grammar** parse with no
semantic duplicate-member check, so it is expected to accept this syntax cleanly
(`parseError == null`). This corpus file therefore is **not** meant to represent
deployable Apex — it stresses the parser's member-table construction on syntax the
grammar allows but the platform compiler would not. If parsing this file throws or
sets `parseError`, that is worth noting as a parser robustness finding, but is
explicitly **not** the same thing as a resolver "BUG" against a documented
guarantee.

### E4 `classes/VertexInvoiceLineConsumer.cls`
```
L1  public class VertexInvoiceLineConsumer {
L2    public void run() {
L3      VertexInvoiceLine line = new VertexInvoiceLine();
L4      line.Amount = 100;              // NON-EDGE (property write): parser.js emits no CallFacts for a bare property assignment. [IDEAL — known accessor gap, same as adv-org's AcmeQuote.(set Status)]
L5      Decimal total = line.Amount;    // NON-EDGE (property read): same reason. [IDEAL]
L6      Decimal totalViaMethod = line.Amount();
L7      // -> VertexInvoiceLine.Amount (the METHOD) [via=typed] [MUST] — the parens make this call
L8      // unambiguous; it must be counted as a real caller and kept distinct from lines 4–5.
L9    }
L10 }
```

### E5 `classes/VertexDiscountCalculator.cls`  — static + instance overloads
```
L1  public class VertexDiscountCalculator {
L2    public static Decimal calculate(Decimal base) {
L3      return base;
L4    }
L5    public Decimal calculate(Decimal base, Decimal rate) {
L6      return base * (1 - rate);
L7    }
L8  }
```

### E6 `classes/VertexDiscountConsumer.cls`
```
L1  public class VertexDiscountConsumer {
L2    public void run(Decimal base, Decimal rate) {
L3      Decimal a = VertexDiscountCalculator.calculate(base);
L4      // -> VertexDiscountCalculator.calculate(Decimal) [via=static, arity=1] [MUST]
L5      VertexDiscountCalculator calc = new VertexDiscountCalculator();
L6      Decimal b = calc.calculate(base, rate);
L7      // -> VertexDiscountCalculator.calculate(Decimal,Decimal) [via=typed, arity=2] [MUST]
L8    }
L9  }
```

### E7 `classes/VertexNestedIndexBuilder.cls`  — recursive generics, parse-robustness only
```
L1  public class VertexNestedIndexBuilder {
L2    public Map<String, List<Map<Id, VertexIndexEntry>>> buildIndex() {
L3      Map<String, List<Map<Id, VertexIndexEntry>>> nestedIndex = new Map<String, List<Map<Id, VertexIndexEntry>>>();
L4      nestedIndex.put('default', new List<Map<Id, VertexIndexEntry>>());
L5      return nestedIndex;
L6    }
L7  }
```
No outbound call edges of interest; the only assertion is `parseError == null`
for this file despite the 3-level-deep generic nesting. **[MUST]**

### E8 `classes/VertexIndexEntry.cls`
```
L1  public class VertexIndexEntry {
L2    public String key;
L3    public Decimal value;
L4  }
```

### E9 `classes/VertexStatusRouter.cls`  — ~400-line switch-heavy method
```
L1  public class VertexStatusRouter {
L2
L3    public void route(String statusCode) {
L4      switch on statusCode {
L5        when 'NEW'                { handleNew(); }                // -> VertexStatusRouter.handleNew [via=this] [MUST]
L6        when 'VALIDATED'          { handleValidated(); }          // -> handleValidated [via=this] [MUST]
L7        when 'ENRICHED'           { handleEnriched(); }           // -> handleEnriched [via=this] [MUST]
L8        when 'ROUTED'             { handleRouted(); }             // -> handleRouted [via=this] [MUST]
L9        when 'PRICED'             { handlePriced(); }             // -> handlePriced [via=this] [MUST]
L10       when 'APPROVED'           { handleApproved(); }           // -> handleApproved [via=this] [MUST]
L11       when 'REJECTED'           { handleRejected(); }           // -> handleRejected [via=this] [MUST]
L12       when 'ON_HOLD'            { handleOnHold(); }              // -> handleOnHold [via=this] [MUST]
L13       when 'BACKORDERED'        { handleBackordered(); }        // -> handleBackordered [via=this] [MUST]
L14       when 'PARTIALLY_SHIPPED'  { handlePartiallyShipped(); }   // -> handlePartiallyShipped [via=this] [MUST]
L15       when 'SHIPPED'            { handleShipped(); }            // -> handleShipped [via=this] [MUST]
L16       when 'INVOICED'           { handleInvoiced(); }           // -> handleInvoiced [via=this] [MUST]
L17       when 'PAID'               { handlePaid(); }                // -> handlePaid [via=this] [MUST]
L18       when 'DISPUTED'           { handleDisputed(); }           // -> handleDisputed [via=this] [MUST]
L19       when 'REFUNDED'           { handleRefunded(); }           // -> handleRefunded [via=this] [MUST]
L20       when 'CANCELLED'          { handleCancelled(); }          // -> handleCancelled [via=this] [MUST]
L21       when 'ARCHIVED'           { handleArchived(); }           // -> handleArchived [via=this] [MUST]
L22       when 'ESCALATED'          { handleEscalated(); }          // -> handleEscalated [via=this] [MUST]
L23       when else                 { handleUnknown(); }            // -> handleUnknown [via=this] [MUST]
L24     }
L25   }
L26
          // 19 private handler methods follow (handleNew ... handleEscalated, handleUnknown),
          // each ~3 lines (signature + one no-op/System.debug body line + closing brace); pad
          // with brief comments/blank lines between them so the file totals ~400 lines. None of
          // the 19 handlers make further outbound calls of interest — they are call-graph LEAVES.
L~400 }
```
All 19 branches must be independently extracted as distinct `CallFacts` — this is
primarily a robustness/completeness assertion (no silent truncation of a long
`switch on` body), not a resolution-difficulty assertion; every one of the 19
edges is a trivial `via=this` call. **[MUST]**

### E10 `classes/VertexStatusRouterConsumer.cls`
```
L1  public class VertexStatusRouterConsumer {
L2    public void run(String code1, String code2) {
L3      VertexStatusRouter router = new VertexStatusRouter();
L4      router.route(code1);   // site 1 -> VertexStatusRouter.route [via=typed] [MUST]
L5      router.route(code2);   // site 2 -> VertexStatusRouter.route [via=typed] [MUST] — bonus MULTI-SITE demo: 1 caller node, 2 site rows
L6    }
L7  }
```

### E11 `classes/VertexReadable.cls`
```
L1  public interface VertexReadable {
L2    void sync();
L3  }
```

### E12 `classes/VertexWritable.cls`
```
L1  public interface VertexWritable {
L2    void sync();
L3  }
```

### E13 `classes/VertexSyncable.cls`
```
L1  public interface VertexSyncable extends VertexReadable, VertexWritable {
L2  }
```

### E14 `classes/VertexDataBridge.cls`
```
L1  public class VertexDataBridge implements VertexSyncable {
L2    public void sync() {
L3      System.debug('syncing');
L4    }
L5  }
```

### E15 `classes/VertexSyncConsumer.cls`
```
L1  public class VertexSyncConsumer {
L2
L3    public void runViaSyncable() {
L4      VertexSyncable s = new VertexDataBridge();
L5      s.sync();    // -> VertexDataBridge.sync [via=interface, ~] [MUST] — direct: VertexDataBridge directly `implements VertexSyncable`
L6    }
L7
L8    public void runViaReadable() {
L9      VertexReadable r = new VertexDataBridge();
L10     r.sync();
L11     // -> VertexDataBridge.sync [via=interface, ~] [MUST — adjudicated 2026-07-17: see Target 19.]
L12     // VertexDataBridge never directly `implements VertexReadable` — it is reached only
L13     // transitively through `VertexSyncable extends VertexReadable, VertexWritable`. The
L14     // engine's G6 interface-extends transitive closure (resolver.js, v0.5) registers
L15     // implementers under every ancestor interface, so this edge is documented behavior.
L16   }
L17 }
```

---

## 3. Ground truth per target (caller trees; 3 also carry callee trees)

### Target 1 — `VertexPricingService.reprice` (caller tree) — THE heavy-fan-in target

Immediate callers (17 distinct caller **nodes**; grouping per §0):

| # | Caller node | File:Line(s) | via | grouping |
|---|---|---|---|---|
| 1 | `VertexPricingService.repriceOrder` | A2:17 | new | 1 site |
| 2 | `VertexOrderController.recalculate` | A6:7 | typed | 1 site, `@AuraEnabled` `◉` |
| 3 | `VertexOrderController.bulkRecalculate` | A6:14 | typed | 1 site, `@AuraEnabled` `◉` |
| 4 | `VertexOrderService.processOrder` | A7:5 | typed | 1 site |
| 5 | `VertexOrderService.reconcileOrder` | A7:10,13 | typed | **2 site rows, 1 node** |
| 6 | `VertexOrderTriggerHandler.handleAfterUpdate` | A8:6 | typed | 1 site |
| 7 | `VertexOrderTriggerHandler.handleAfterInsert` | A8:13 | typed | 1 site |
| 8 | `VertexRepriceBatch.execute` | A10:10 | typed | 1 site, `Batchable` |
| 9 | `VertexBulkRepriceUtil.repriceBatch` | A12:5,8 | typed | **2 site rows, 1 node** |
| 10 | `VertexRepriceableDispatcher.dispatch` | A13:3 | interface, ~ | 1 site (also fans to sibling target `VertexPremiumPricingService.reprice`) |
| 11 | `VertexPremiumPricingService.reprice` | (own file):3 | super | 1 site — the override's own `super.reprice(order)` self-reference back to the base method (corrected, see §5 authoring-defect note: previously omitted from this table) |
| 12 | `VertexPricingServiceTest.testReprice` | A14:7 | typed | 1 site, `test` `◉` |
| 13 | `VertexOrderServiceTest.testDirectReprice` | A15:8 | typed | 1 site, `test` `◉` |
| 14 | `VertexOrderTriggerHandlerTest.testHandleAfterUpdateDirect` | A16:7 | typed | 1 site, `test` `◉` |
| 15 | `VertexOrderApprovalInvocable.execute` | A17:6 | typed | 1 site, `@InvocableMethod` `◉` |
| 16 | `VertexOrderConversionService.convertAndReprice` | A18:4 | typed | 1 site |
| 17 | `VertexQuoteToOrderConverter.finalizeOrder` | A19:4 | typed | 1 site |

All 17 are `[MUST]`.

Ancestors (one level further up; illustrate tree depth, not new direct callers):
- `VertexOrderTrigger.trigger:4` → `VertexOrderTriggerHandler.handleAfterUpdate` (typed, `◉` trigger root) — grandparent of node 6.
- `VertexOrderTrigger.trigger:7` → `VertexOrderTriggerHandler.handleAfterInsert` (typed, `◉` trigger root) — grandparent of node 7.
- `VertexOrderTriggerHandlerTest.testHandleAfterUpdateViaHandler` (A16:13, typed, `test` `◉`) — grandparent of node 6.
- `VertexOrderServiceTest.testReconcileOrder` (A15:14, typed, `test` `◉`) — grandparent of node 5.
- `VertexOrderStaticFacade.triggerReprice` (A20:3, static, `◉`) — grandparent of node 1. `[MUST — adjudicated 2026-07-17: present on the depth-1 EXPANDED occurrence of node 1; the long-standing T1-anc-facade NOTE was a harness lookup artifact, see placement note below]`
- `VertexNightlyAdjustmentJob.execute` (A21:3, async, `Schedulable` `◉`) — great-grandparent of node 8 (chain: job → `VertexRepriceBatch.execute` → `reprice`). `[MUST — adjudicated 2026-07-17: present on the depth-1 EXPANDED occurrence of node 8; the long-standing T1-anc-nightlyjob NOTE was the same harness lookup artifact]`

All `[MUST]`.

**Ancestor placement note (adjudicated 2026-07-17, hard-asserted in
`dev/gauntlet/run.js` T1; isolated repro
`dev/gauntlet/repro-roundc-t1-anc-dagdedup.js`):** node 1
(`VertexPricingService.repriceOrder`) and node 8 (`VertexRepriceBatch.execute`)
each appear in this tree **twice** — once as the depth-1 direct caller
(EXPANDED, carrying the ancestor above), and once as an H1 DAG-memoization
`seenElsewhere` reference copy (children deliberately empty) under the
`VertexPremiumPricingService.reprice` (via=super) subtree, whose override
fan-out re-lists every base-method caller. Because `VertexPremium…` sorts
before both `VertexPricing…` and `VertexRepriceBatch…`, a naive DFS-pre-order
first-label-match lookup lands on the empty reference copy and falsely reports
the ancestors absent — that is exactly what the pre-adjudication NOTE checks
did. The depth-1 occurrence is always the expanded one (the walk is BFS
level-order, so depth-1 identities register in the dedup set before any deeper
copy is built). An examiner must locate the EXPANDED occurrence before
asserting on ancestors; ancestor absence from that node is a **BUG**.

**Expected non-edges (must NOT appear anywhere in this tree):**
- `VertexShippingController.recalcShipping` (A5:4) — calls a *different* class's `reprice`. Class-scoped target keys (`classLower`+`methodLower`) make this structurally impossible to conflate; a live run showing this edge would be a **BUG**. `[MUST]`
- `VertexOrderMigrationUtil.legacyRepriceDispatch` (A22:3) — ambiguous 2-candidate receiver; correctly unresolved. `[IDEAL]`

**Unresolved-count note:** the migration-util call site (A22:3) and the 12-way
collision call site in `VertexPipelineRunner.runDynamic` (B13:13) are the two
calls in this corpus purpose-built to swell the workspace-wide "N call sites
could not be resolved" count while producing zero false edges.

**Design-time stats estimate (not a verified live run):** `nodes` ≈ 24 (17 direct
+ 6 ancestor hops + 1 root), `unique` ≈ 17 target-adjacent methods, `direction` =
`callers`, `capped` = false. Treat this as a sanity ballpark, not ground truth to
assert against byte-for-byte.

### Target 2 — `VertexPricingService.repriceOrder`
Caller: `VertexOrderStaticFacade.triggerReprice` (A20:3, via=static) `[MUST]`. Shallow, 1-node tree — the corpus's clean "statics" caller-shape example, distinct from typed-instance dispatch into `reprice` itself.

### Target 3 — `VertexShippingCostService.reprice` (precision-trap target)
Caller: `VertexShippingController.recalcShipping` (A5:4, via=typed) `[MUST]`. Zero other callers — in particular, none of the 17 `VertexPricingService.reprice` callers from Target 1 may appear here. `[MUST]`

### Target 4 — `VertexIngestProcessor.process`
Caller: `VertexPipelineRunner.runIngest` (B13:5, via=typed) `[MUST]`. Non-edge: `VertexPipelineRunner.runDynamic` (B13:13) must not appear.

### Target 5 — `VertexValidationProcessor.process`
Caller: `VertexPipelineRunner.runValidation` (B13:9, via=typed) `[MUST]`. Same non-edge note as Target 4.

### Target 6 — `VertexFinalizeProcessor.process` (zero-caller demonstration)
**0 callers** — an honest empty-tree result (per README's "note above the tree" convention for a genuine zero-caller target), not a resolver error. `[MUST]` The same 0-caller expectation applies identically to the other 9 uncalled processors (`Enrichment`, `Routing`, `Audit`, `Billing`, `Compliance`, `Archive`, `Notify`, `Sync`, `Cleanup`) — none of them receive a spurious edge from the ambiguous `runDynamic` call site. This is the corpus's clearest proof that the 12-way name collision produces **zero false positives**, not just one.

### Target 7 — `VertexOrderService.run`
Caller: `VertexOrderRunnerUtil.triggerCaseVariantRun` (C3:4, via=static, case-insensitive) `[MUST]`. Non-edge: must not be conflated with Targets 8/9 below despite the near-identical class names.

### Target 8 — `VertexOrderServices.run`
Caller: `VertexOrderRunnerUtil.triggerPluralRun` (C3:8, via=static) `[MUST]`. Non-edge vs. Targets 7/9.

### Target 9 — `Vertex_Order_Service.run`
Caller: `VertexOrderRunnerUtil.triggerUnderscoreRun` (C3:12, via=static) `[MUST]`. Non-edge vs. Targets 7/8.

### Target 10 — `Billing.charge` (local class)
Caller: `VertexLedgerBridge.postToLedger` (C5:3, via=static) `[MUST]`. **Must NOT** also show C5:19 (`zenq.Billing.charge`) as a second call site on this same node — that line references a different, nonexistent symbol. `[IDEAL]`, BUG-vs-GAP callout: an edge from C5:19 landing here would be a **BUG** (false-positive namespace-prefix collapse); its absence (correctly unresolved) is the expected **KNOWN-GAP**-consistent behavior.

### Target 11 — `VertexLedgerBridge.postToLedger` (**callee tree B**)
| Callee | Line | Expected | Tag |
|---|---|---|---|
| `Billing.charge` | C5:3 | edge, via=static | `[MUST]` |
| `kwx__LedgerService.postEntry` | C5:6 | **no edge** (class never declared); should still be extracted and counted unresolved | `[IDEAL]` |
| `Vertex_Order__c` trigger fan-out via `insert kwx__Ledger__c(...)` | C5:13 | **no edge** — zero triggers registered on that object; correct, not an error | `[MUST]`-equivalent |
| `zenq.Billing.charge` | C5:19 | **no edge**, and specifically **not** an edge to local `Billing.charge` | `[IDEAL]` (BUG if it lands on local `Billing`) |

### Target 12 — `VertexPricingServiceImpl.priceItems`
Caller: `VertexApplicationConsumer.priceViaFactory` (D4:5, via=interface, ~) `[MUST]`. 2-hop ancestor: same method also directly calls `VertexApplication.newInstance` (D4:3, via=static) `[MUST]` on its way there.

### Target 13 — `VertexGenericTriggerDispatcher.dispatch` (**callee tree C**)
| Callee | Line | Expected | Tag |
|---|---|---|---|
| `handlerType.newInstance()` (dynamic ctor via `Map<Type,Type>`) | D7:8 | **no edge** to `VertexAlertTriggerHandler.<init>` | `[IDEAL]` |
| `handler.run()` | D7:11 | edge to `VertexAlertTriggerHandler.run`, via=interface, ~ | `[MUST]` |

### Target 14 — `VertexAlertTriggerHandler.run`
Caller: `VertexGenericTriggerDispatcher.dispatch` (D7:11, via=interface, ~) `[MUST]`.

### Target 15 — `VertexOrderProcessor.Batch.Row` (class-level + `.process`)
- `VertexOrderProcessor.Batch.Row.<init>` ← `VertexNestedConsumer.run` (E2:3, via=new) `[MUST]`
- `VertexOrderProcessor.Batch.Row.process` ← `VertexNestedConsumer.run` (E2:5, via=typed) `[MUST]`
- Inbound to the *outer* class: `VertexOrderProcessor.staticHelper` ← `VertexOrderProcessor.Batch.Row.process` (E1:7, via=static) `[MUST]` — the inner-inner-to-outer static callback, attributed to the file that declares `Row`.

### Target 16 — `VertexInvoiceLine.Amount` (the method)
Caller: `VertexInvoiceLineConsumer.run` (E4:6, via=typed) `[MUST]`. Non-edges: E4:4 (property write) and E4:5 (property read) produce zero `CallFacts` and must not be miscounted as calls to this method. `[IDEAL]` See legality caveat under E3 in §2 — this target's very existence in a live parse is itself informative (confirms the ANTLR-grammar-vs-platform-compiler gap).

### Target 17 — `VertexDiscountCalculator.calculate` (2 overloads)
- `calculate(Decimal)` ← `VertexDiscountConsumer.run` (E6:3, via=static, arity=1) `[MUST]`
- `calculate(Decimal, Decimal)` ← `VertexDiscountConsumer.run` (E6:6, via=typed, arity=2) `[MUST]`
Both callers originate from the same file/method but target *different* overloads — the two edges must stay split (README: "Overloads are arity-matched"). If they instead collapse onto one undifferentiated `class#method` target the way `AcmePricingEngine.calculatePrice` did in `adv-org` (a same-arity collision), that would be surprising here specifically *because* the arities differ (1 vs. 2) and arity-matching is documented to handle exactly this case — flag as a **BUG** if collapsed.

### Target 18 — `VertexRepriceBatch` (class-level, **callee tree A**)
| Method | Callee | Line | Expected | Tag |
|---|---|---|---|---|
| `start` | SOQL query only | A10:4 | no Apex callee | — |
| `execute` | `VertexPricingService.reprice` | A10:10 | edge, via=typed | `[MUST]` |
| `finish` | `VertexFollowupBatch.execute` | A10:15 | edge, via=async (`Database.executeBatch`) | `[MUST]` |

### Target 19 — `VertexDataBridge.sync` via transitive-only interface typing — **adjudicated 2026-07-17**
- `VertexSyncConsumer.runViaSyncable` (E15:5, via `VertexSyncable`, direct `implements`) → **confident** `[MUST]`.
- `VertexSyncConsumer.runViaReadable` (E15:10, via `VertexReadable`, reached only through `VertexSyncable extends VertexReadable, VertexWritable`) → `[MUST — adjudicated 2026-07-17: edge IS present (via=interface, ~) and that is the engine's own documented behavior — resolver.js's G6 "interface-extends-interface transitive closure" pass (shipped v0.5) additively registers every implementer under every ancestor interface across ALL parent branches, so the implementer index is built off the full interface lattice, not just direct implements declarations]`. Hard-asserted in `dev/gauntlet/run.js` T19 (absence, or a non-`interface`/non-`~` edge shape, is a **BUG**); isolated repro incl. the multi-parent leg and the up-only closure-direction control (a parent-only implementer must NOT be reachable from a child-interface-typed site): `dev/gauntlet/repro-roundc-t19-iface-extends.js`. *(Historical: originally `[IDEAL/UNCERTAIN]` because README documents fan-out to "every implementer" without saying how the implementer index is built; the uncertainty was in the ground-truth authoring, never in the engine.)*

### Target 20 — `VertexStatusRouter.route`
Caller: `VertexStatusRouterConsumer.run` (E10:4,5, via=typed) `[MUST]` — **2 site rows, 1 node** (bonus multi-site demo, distinct from Targets 1's two designated multi-site cases). Callee side (partial, illustrative of Target 20 as a callee-tree too, not one of the 3 designated ones): all 19 `switch` branches (E9:5–23) must independently appear as `via=this` callees into their respective `handleXxx`/`handleUnknown` methods — none silently dropped. `[MUST]`

---

## 4. Global non-edge appendix (precision traps, consolidated)

| # | Call site | Would-be false target | Correct outcome | Tag |
|---|---|---|---|---|
| 1 | `VertexShippingController.recalcShipping` (A5:4) | `VertexPricingService.reprice` | Edge only to `VertexShippingCostService.reprice`; never the unrelated same-named method | `[MUST]` |
| 2 | `VertexOrderMigrationUtil.legacyRepriceDispatch` (A22:3) | either `reprice` (2 candidates) | Unresolved, zero edges | `[IDEAL]` |
| 3 | `VertexPipelineRunner.runDynamic` (B13:13) | any of the 12 `process` classes | Unresolved, zero edges | `[IDEAL]` |
| 4 | `VertexOrderRunnerUtil.triggerPluralRun`/`triggerUnderscoreRun` (C3:8,12) | `VertexOrderService.run` | Edges only to their own exact class | `[MUST]` |
| 5 | `VertexLedgerBridge.postToLedger` line C5:6 | any local class | Unresolved (no `kwx__LedgerService` exists) | `[IDEAL]` |
| 6 | `VertexLedgerBridge.postToLedger` line C5:13 | any trigger | Zero trigger targets (none exist on `kwx__Ledger__c`) | `[MUST]`-equivalent |
| 7 | `VertexLedgerBridge.postToLedger` line C5:19 | local `Billing.charge` | Unresolved — must NOT collapse onto local `Billing` | `[IDEAL]` (BUG if it lands on local `Billing`) |
| 8 | `VertexInvoiceLineConsumer.run` lines E4:4–5 | `VertexInvoiceLine.Amount` (method) | Zero `CallFacts` at all (property access) | `[IDEAL]` |
| 9 | `VertexApplication.newInstance` (D3:8) / `VertexGenericTriggerDispatcher.dispatch` (D7:8) | any concrete `<init>` | No constructor edge (dynamic `Type` value from a Map, not a literal) | `[IDEAL]` |

---

## 5. Tally

| Cluster | Files | Direct MUST edges (approx.) | Direct IDEAL/non-edges (approx.) |
|---|---:|---:|---:|
| A (fan-in) | 22 | 25 (17 direct + 6 ancestor + `finish`/async + override fan-out leg) | 2 |
| B (12-way) | 13 | 2 | 1 |
| C (naming traps) | 5 | 4 | 3 |
| D (indirection) | 8 | 4 | 2 |
| E (language corners) | 15 | ~28 (incl. 19 switch branches) | 3 (2 property + 1 uncertain) |
| **Total** | **63** | **~62** | **~11** |

File count reconciles to **63** (57 `.cls` + 1 `.trigger` + — recount: A=21 `.cls`+1 `.trigger`, B=13 `.cls`, C=5 `.cls`, D=8 `.cls`, E=15 `.cls` → `.cls` total = 21+13+5+8+15 = 62, plus 1 `.trigger` = **63 files**). Each `.cls` gets a `.cls-meta.xml` sidecar (`apiVersion` 59.0, `status` Active) and the one `.trigger` gets a `.trigger-meta.xml` sidecar — sidecars are not itemized above (same convention as `adv-org`'s `MANIFEST.md`).

## 6. Builder / verification notes

- **Do not deploy this org.** Several files (`VertexInvoiceLine.cls`'s
  method/property collision; the `kwx__`/`zenq.` references in
  `VertexLedgerBridge.cls`) are deliberately non-deployable or reference
  nonexistent managed packages. This corpus exists purely for static analysis.
- **No object metadata needed.** Every `__c` token is a bare Apex syntax token;
  `parser.js` does not validate schema. Do not create `objects/*.object-meta.xml`.
- **Case must be preserved exactly as written** in §2 except where a line is
  explicitly marked as a deliberate case-variant (C3:4) — do not "fix" the
  lowercase `vertexorderservice.RUN(order)` call, that is the point of the test.
  Likewise do not "fix" `Vertex_Order_Service` (C2) to remove its underscores.
- **Verification workflow for the examiner** (out of scope for this document,
  which is engine-blind by design): parse every file with `parser.js`, confirm
  `parseError == null` everywhere except intentionally none here (unlike
  `adv-org`, this corpus has **no** deliberately-broken-syntax file — every parse
  failure found would be a genuine builder defect, not a design feature), build
  the semantic index, then run `buildCallerTree`/`buildCalleeTree` once per target
  in §3 and diff the real output against the `[MUST]` rows first (any mismatch is
  a **BUG**), then against the `[IDEAL]` rows (a mismatch here is *evidence*, not
  necessarily a defect — cross-check against README's documented limits before
  concluding anything).
- **Corpus defects:** none — this corpus has not yet been built or run against
  the engine. This section is a placeholder for the build/verification round to
  fill in, mirroring `adv-org/MANIFEST.md`'s "Corpus defects" section.

---

## v0.8 ground-truth: namespace modeling

Scope: the v0.8 CONTRACT AMENDMENTS (N1–N6) turn a reference into a managed
namespace from an honestly-absent non-edge into a first-class **external**
node (`kind: 'external'`). This section is engine-blind in the same spirit as
§§1–6 above: it is a from-first-principles prediction of correct v0.8 output,
written against the amendment text, not against a live run. It does two
things: (A) **promotes** every pre-existing namespace probe already sitting in
this corpus (built for v0.7.1, several of them never folded into §§1–6) from
`[IDEAL]`/non-edge to `[MUST]` external-node/edge expectations, and (B)
documents six **new** fixtures covering the amendment's remaining shapes
(own-namespace resolution, DML→trigger linkage on a namespaced object,
precedence traps, cross-namespace distinctness, and metadata-layer — Flow +
CMDT — namespaced refs).

Per §0's convention: `[MUST]` = the engine's own contract (here, the v0.8
CONTRACT AMENDMENTS text, standing in for README until README is updated)
documents this as required; a live run that disagrees is a **BUG**.
`[IDEAL]`/`[IDEAL/UNCERTAIN]` keep their §0 meanings — used below only where
the amendment text genuinely underdetermines the answer.

### v0.8-A. Promoted existing namespace probes (pre-existing files, no source changes)

These files already exist in the corpus (built for v0.7.1's "namespaced
references are honest" milestone, verified live via
`dev/gauntlet/run-namespace-probes.js` / `-v2-rehunt.js`, but never written up
in §§1–6). Their **source is unchanged** — only the *expected output*
changes, per REGRESSION POLICY category (a) ("references previously counted
unresolved/metaUnresolved that match N1 shapes become external edges/nodes").

#### A1. `classes/VertexLedgerBridge.cls` (C5) — Target 11 update

| Line | Reference | v0.7.1 (current, documented in §3/§4) | v0.8 (this section) | Tag |
|---|---|---|---|---|
| C5:3 `Billing.charge(...)` | local static call | edge → local `Billing.charge` | **unchanged** — edge → local `Billing.charge` | `[MUST]` |
| C5:6 `kwx__LedgerService.postEntry(...)` | 2-segment `Head.method()`, `Head`="kwx__LedgerService" (single identifier, no dot) | unresolved | **unchanged** — stays unresolved. Per N2, a 2-segment call NEVER creates an external node (ambiguous with an ordinary unresolved local reference); this is the corpus's original, pre-existing instance of the "2-segment `Foo.bar()` with unknown `Foo`" trap that v0.8-B2 (`TwoSegmentUnknownCaller.cls`) now also covers standalone | `[MUST]` (no-change) |
| C5:13 `insert new kwx__Ledger__c(...)` | DML target matches managed-object pattern `ns__Object__c` | zero trigger targets (unresolved-adjacent) | **promoted**: new EXTERNAL object node `kwx__Ledger__c` (kind `external`, ns=`kwx`), with `VertexLedgerBridge.postToLedger` as one of its local referencing sites. Trigger fan-out **stays zero** — no local trigger is declared on `kwx__Ledger__c` anywhere in this corpus (that pairing is deliberately reserved for the *different* object `kwx__Invoice__c` in v0.8-B2, so this row's own "zero trigger targets" invariant from §4 row 6 is preserved byte-for-byte) | `[MUST]` per N1(b) |
| C5:19 `zenq.Billing.charge(...)` | 3-segment call, `Head`="zenq" not a local var/class | unresolved, must NOT collapse onto local `Billing.charge` | **promoted**: new EXTERNAL node `zenq.Billing` (ns=`zenq`, class=`Billing`), method `charge`; caller = `VertexLedgerBridge.postToLedger` at this exact site. Must still NOT collapse onto the unrelated local `Billing.charge` (that invariant from §3 Target 10 / §4 row 7 does not change, it just now has a *positive* landing spot instead of nowhere) | `[MUST]` per N2 step 3 |

Net effect on Target 11's tree: the caller node for `VertexLedgerBridge.postToLedger` keeps its exact 1-site edge to local `Billing.charge` ([MUST], unchanged — see run.js's existing T10/T11 assertions), plus TWO new sibling **external** callee nodes appear in the callee tree (`kwx__Ledger__c` object, `zenq.Billing.charge` method) that did not exist in v0.7.1. `kwx__LedgerService.postEntry` (C5:6) remains the corpus's one deliberately-still-unresolved namespace-shaped reference, proving N2's 2-segment carve-out is real and not just "unimplemented."

#### A2. `classes/KappaGatewayCaller.cls` — NAMESPACE PROBES 1–4 (new writeup; local target = `classes/KappaGateway.cls`, `dispatch`)

| Line | Reference | v0.7.1 (verified live, undocumented) | v0.8 | Tag |
|---|---|---|---|---|
| L3 `zenq.KappaGateway.dispatch(cmd)` | 3-segment, `Head`="zenq" | unresolved (no false edge to local `KappaGateway`) | EXTERNAL node `zenq.KappaGateway`, method `dispatch`; caller = `KappaGatewayCaller.routeCommands` | `[MUST]` |
| L9 `ZENQ.kappagateway.DISPATCH(cmd)` | same call, case-varied | unresolved | Attaches to the **same** external node as L3 (Apex identifiers are case-insensitive; the external index key is case-folded exactly like every other lookup in this engine) — one external node, TWO site rows under it, not two nodes | `[MUST]` |
| L16 `kwx.KappaGateway.dispatch(cmd)` | 3-segment, `Head`="kwx" (different namespace, same class name) | unresolved | NEW, DISTINCT external node `kwx.KappaGateway` (same class simple name as `zenq.KappaGateway`, different namespace ⇒ different node) — this is the same shape as requirement 2d, now cross-checked against a second real caller | `[MUST]` per N1(a) |
| L21 `zenq.KappaGatewey.dispatch(cmd)` | 3-segment, `Mid`="KappaGatewey" (1-letter typo of "Gateway") | unresolved negative control (must not fuzzy-match local `KappaGateway`) | NEW, DISTINCT external node `zenq.KappaGatewey` (typo'd spelling and all — the engine has no knowledge it's a typo, it only knows `Mid` doesn't match anything local, so namespace precedence fires verbatim). Must stay a SEPARATE node from `zenq.KappaGateway` (L3/L9) — same namespace, different class text | `[MUST]` per N2 step 3 |

None of the four sites may ever attach to the local `KappaGateway.dispatch` caller tree — that invariant is unchanged from v0.7.1 and remains `[MUST]` (false-positive risk explicitly called out in the file's own comments).

#### A3. `classes/BoltRelayCaller.cls` — NAMESPACE PROBE 5 (new writeup; would-be false target = inner class `BoltContainer.Relay`)

| Line | Reference | v0.7.1 | v0.8 | Tag |
|---|---|---|---|---|
| L3 `zenq.Relay.fire()` | 3-segment, `Head`="zenq" not a local var/class | unresolved (must not land on `BoltContainer.Relay.fire`, the sole inner class workspace-wide named `Relay`) | EXTERNAL node `zenq.Relay`, method `fire`; caller = `BoltRelayCaller.trigger`. Still must NOT land on `BoltContainer.Relay.fire` — inner-class tail-matching is not part of the 3-segment precedence chain (N2 steps 1–2 require `Head` itself to resolve locally; `Relay` is `Mid`, not `Head`, so it is never consulted) | `[MUST]` per N2 step 3 |

#### A4. `classes/BeaconCaller.cls` — NAMESPACE PROBE 6 (new writeup; would-be false targets = 2 ambiguous inner classes `KappaContainerA.Beacon`/`KappaContainerB.Beacon`)

| Line | Reference | v0.7.1 | v0.8 | Tag |
|---|---|---|---|---|
| L3 `zenq.Beacon.signal()` | 3-segment, `Head`="zenq" not a local var/class | unresolved — ambiguous N=2 inner-class tail correctly declined for BOTH candidates | EXTERNAL node `zenq.Beacon`, method `signal`; caller = `BeaconCaller.ping`. The N=2 local ambiguity becomes irrelevant: N2 step 3 fires as soon as `Head`="zenq" fails to resolve as a local class (step 2), **before** any inner-class tail-matching would even be attempted — so this is no longer "declined due to ambiguity," it is a confident external edge | `[MUST]` per N2 step 3 |

This is the one promoted probe where the *reason* for the correct outcome genuinely changes (old: correctly-declined ambiguity; new: confident external resolution) even though "no false local edge" was already true both before and after — worth flagging for the examiner as a case where a naive diff might under-notice the delta.

#### A5. `force-app/main/default/lwc/kappaGatewayPanel/kappaGatewayPanel.js` — metascan/LWC layer (new writeup)

`import dispatch from '@salesforce/apex/zenq.KappaGateway.dispatch';` (L11).
metascan.js (v0.7.1, M1) already extracts this correctly as
`{ kind:'lwc', className:'KappaGateway', methodName:'dispatch', namespace:'zenq' }`
— the `namespace` field has existed since v0.7.1 and is not new. What changes
in v0.8 is purely on the resolver side (N1(c)):

| v0.7.1 (verified live via `run-namespace-probes.js` PROBE 6) | v0.8 | Tag |
|---|---|---|
| `attachMetaCallers` keyed purely on bare `classLower`, ignored `namespace`, produced a `metaUnresolved` count and (correctly) did NOT attach to local `KappaGateway.dispatch` | Routes to the SAME external node `zenq.KappaGateway` that `KappaGatewayCaller.cls` L3/L9 attach to (A2 above) — a real cross-surface consistency check: an Apex call site and an LWC import into the *same* namespaced class/method land on one shared external node, not two. Caller = the importing component, `KappaGatewayPanel` (kind `lwc`). Must still NOT attach to local `KappaGateway.dispatch` | `[MUST]` per N1(c) |

### v0.8-B. New fixtures

All new `.cls`/`.trigger` files below were parsed with
`require('./parser.js').parseFile`
— `parseError == null` for every one, confirmed for this write-up (see
`dev`-side verification note at the end of this section). Line numbers below
are exact (files as actually written, `cat -n` verified), not build targets.

`sfdx-project.json` at the corpus root gains `"namespace": "vtx"` (was `""`).
No pre-existing file in the corpus uses a `vtx`/`vtx__` token anywhere
(verified by grep across the full existing corpus before adding these
fixtures), so this is a pure addition with zero effect on any pre-existing
target's resolution.

#### B1 (requirement 2a) — own-namespace resolves LOCALLY, no external node

`classes/VtxOwnNamespaceProbe.cls`
```
L1  public class VtxOwnNamespaceProbe {
L2    public void callOwnNamespaceClass(Vertex_Order__c order) {
L3      vtx.VertexPricingService.repriceOrder(order);
L4    }
L5
L6    public void dmlOwnNamespaceObjectBareForm() {
L7      insert new Config__c(Name = 'bare-form');
L8    }
L9
L10   public void dmlOwnNamespaceObjectPrefixedForm() {
L11     insert new vtx__Config__c(Name = 'prefixed-form');
L12   }
L13 }
```

| Line | Reference | Expected (v0.8) | Tag |
|---|---|---|---|
| L3 | `vtx.VertexPricingService.repriceOrder(order)` — parses as a dotted call, `receiver`="vtx.VertexPricingService", `method`="repriceOrder" (verified via `parser.js`) | Per N3, the OWN namespace prefix (`vtx`, from `sfdx-project.json`) is stripped from the receiver BEFORE any resolution is attempted, leaving `VertexPricingService.repriceOrder(order)` — an ordinary local static call, resolved by the engine's pre-existing static-call rules exactly as `VertexOrderStaticFacade.triggerReprice` (cluster A) already does for the un-prefixed form. Edge → local `VertexPricingService.repriceOrder`, `via=static`. **No external node** — `vtx` is never treated as a namespace token because it IS the workspace's own declared namespace | `[MUST]` per N3 |
| L7 | `insert new Config__c(...)` | Local DML on `Config__c` (bare form, no namespace prefix at all) — resolves exactly like any other `__c` token in this corpus (no schema validation, pure syntax token). Zero local triggers exist on `Config__c` anywhere in the corpus, so DML→trigger fan-out is correctly zero. **No external node** | `[MUST]`-equivalent |
| L11 | `insert new vtx__Config__c(...)` | Per N3, the OWN namespace prefix is stripped from the DML target text before matching, leaving `Config__c` — the SAME local object as L7. Same outcome: local DML, zero trigger targets, **no external node**, and critically, this must resolve to the exact same object identity as L7 (both are "the local `Config__c`"), not two different objects | `[MUST]` per N3 |

Positive control for the whole file: this is the fixture proving own-namespace
stripping is NOT the same code path as "any dotted/prefixed reference is
unknown → external." A live run that creates an external node for `vtx`
anything, or that fails to resolve L3/L11 locally, is a **BUG**.

#### B2 (requirement 2b) — local trigger on a namespaced object links exactly like a local object

`classes/VtxKwxInvoiceService.cls`
```
L1  public class VtxKwxInvoiceService {
L2    public void postInvoice(Decimal amount) {
L3      insert new kwx__Invoice__c(Amount__c = amount);
L4    }
L5  }
```

`triggers/VtxKwxInvoiceTrigger.trigger`
```
L1  // GAUNTLET v0.8 (namespace modeling, requirement 2b): a LOCAL trigger
L2  // declared directly on a namespaced/managed-looking object token
L3  // (kwx__Invoice__c). parser.js parses trigger target names as plain text --
L4  // it never validates that the namespace is actually installed -- so this is
L5  // syntactically identical to a trigger on any local object. Ground truth:
L6  // DML on kwx__Invoice__c (VtxKwxInvoiceService.postInvoice) must fan out to
L7  // THIS trigger exactly like it would for any local custom object (event
L8  // matching unchanged, see GROUND-TRUTH.md v0.8 section, requirement 2b).
L9  trigger VtxKwxInvoiceTrigger on kwx__Invoice__c (before insert) {
L10   System.debug('vtx kwx invoice trigger fired');
L11 }
```

Deliberately uses a **different** object (`kwx__Invoice__c`) than
`VertexLedgerBridge.cls`'s existing `kwx__Ledger__c` (C5:13) — reusing
`kwx__Ledger__c` here would add a local trigger to an object the existing
corpus explicitly documents as having "zero trigger targets" (§4 row 6),
which would silently change Target 11's expected output beyond the
sanctioned REGRESSION POLICY category-(a) deltas. Same `kwx` namespace token,
distinct object, zero collision.

| Reference | Expected (v0.8) | Tag |
|---|---|---|
| `VtxKwxInvoiceService.postInvoice` L3 DML (`insert` on `kwx__Invoice__c`) | Per N1(b), `kwx__Invoice__c` matches the managed-object name pattern → gains an EXTERNAL object node `kwx__Invoice__c` (ns=`kwx`), with `VtxKwxInvoiceService.postInvoice` as a local referencing site. Per N4, the DML→trigger fan-out mechanism is untouched by the object "looking" namespaced — it matches by object-name text exactly like any local object, and `VtxKwxInvoiceTrigger` IS declared `on kwx__Invoice__c (before insert)`, so the `insert` DML fans out to it exactly as `VertexOrderTrigger`/`KappaOrderTrigger` do for their own objects | `[MUST]` (trigger fan-out) per N4 |
| — whether the external object node (above) and the local-trigger fan-out (above) BOTH attach simultaneously to this one DML site, vs. the trigger relationship somehow suppressing the external-node attachment | The CONTRACT text states both mechanisms unconditionally (N1(b) keys purely off the object-name pattern; N4 keys purely off a matching local trigger) with no stated precedence between them, so the literal reading is "both fire" — but this document takes no firm position on which the examiner should treat as canonical if a live run only does one | `[IDEAL/UNCERTAIN]` |

#### B3 (requirement 2c) — precedence traps

`classes/zenq.cls` — a GENUINE local top-level class named like the `zenq`
namespace token, with exactly one real member (inner class `Ledger`):
```
L10 public class zenq {
L11   public class Ledger {
L12     public static void post(Decimal amount) {
L13       System.debug('local zenq.Ledger.post: ' + amount);
L14     }
L15   }
L16 }
```
(lines 1–9 are a header comment; `cat -n` confirmed above)

`classes/ZenqLocalPrecedenceCaller.cls`:
```
L1  public class ZenqLocalPrecedenceCaller {
L2    public void callWithLocalMember(Decimal amount) {
L3      zenq.Ledger.post(amount);
L4-L7   // (comment)
L8    }
L9
L10   public void callWithoutLocalMember(String cmd) {
L11     zenq.Signal.emit(cmd);
L12-L18 // (comment)
L19   }
L20 }
```

| Line | Reference | Expected (v0.8) | Tag |
|---|---|---|---|
| `ZenqLocalPrecedenceCaller.cls` L3 `zenq.Ledger.post(amount)` | 3-segment, `Head`="zenq", `Mid`="Ledger" | Per N2 step 2: `Head` resolves to the GENUINE local top-level class `zenq` (`classes/zenq.cls`), and `Mid`="Ledger" resolves on it as a real inner class. Local-class-chain resolution wins outright — edge → local `zenq.Ledger.post`. **No external node.** This is the "local class named like a namespace token keeps winning when it actually resolves" guarantee from N2, pinned with a real corpus fixture (previously only exercised in isolation by `dev/gauntlet/fixtures-v071-rehunt-isolated/ZenqIsolated.cls`, which is NOT part of this corpus) | `[MUST]` per N2 step 2 |
| `ZenqLocalPrecedenceCaller.cls` L11 `zenq.Signal.emit(cmd)` | 3-segment, `Head`="zenq", `Mid`="Signal" | `Head` again resolves to the local class `zenq`, but `Mid`="Signal" does NOT resolve on it (no such inner class/static member declared). Step 2 fails cleanly and falls through to step 3: EXTERNAL node `zenq.Signal`, method `emit`; caller = `ZenqLocalPrecedenceCaller.callWithoutLocalMember`. Must NOT fabricate any local edge just because `Head` matched a real class — this is the "without [a member] → external must win, no false local edge" leg of the trap | `[MUST]` per N2 step 3 |

`classes/TwoSegmentUnknownCaller.cls`:
```
L1  public class TwoSegmentUnknownCaller {
L2    public void callUnknownTwoSegment() {
L3      UnknownPkg.doThing();
L4-L14  // (comment)
L15   }
L16 }
```

| Line | Reference | Expected (v0.8) | Tag |
|---|---|---|---|
| L3 `UnknownPkg.doThing()` | 2-segment `Head.method()`, `Head`="UnknownPkg" is not a local var, not a local class, no third segment | Per N2's explicit carve-out, a 2-segment call NEVER creates an external node — it is indistinguishable from an ordinary "class the corpus never declared" unresolved reference. Stays unresolved, counted in the unresolved tally, **not** in the external tally. Standalone confirmation of the exact shape already present (undocumented until v0.8-A1) at `VertexLedgerBridge.cls` C5:6 | `[MUST]` per N2 (2-segment carve-out) |

#### B4 (requirement 2d) — two namespaces, same class name, distinct external nodes

`classes/NamespaceDistinctGatewayCaller.cls`:
```
L1  public class NamespaceDistinctGatewayCaller {
L2    public void openBoth() {
L3      zenq.Gateway.open();
L4-L8   // (comment)
L9
L10     kwx.Gateway.open();
L11-L16 // (comment)
L17   }
L18 }
```

| Line | Reference | Expected (v0.8) | Tag |
|---|---|---|---|
| L3 `zenq.Gateway.open()` | 3-segment, `Head`="zenq" | EXTERNAL node `zenq.Gateway`, method `open`; caller = `NamespaceDistinctGatewayCaller.openBoth`. `Gateway` is not a local class anywhere in this corpus (only `KappaGateway` exists — a distinct simple name), so there is no local-collision risk clouding this leg | `[MUST]` per N2 step 3 |
| L10 `kwx.Gateway.open()` | 3-segment, `Head`="kwx" | A SECOND, DISTINCT external node `kwx.Gateway` — same class simple name (`Gateway`) and method (`open`) as L3, but a different namespace token, so it must NOT collapse/merge with `zenq.Gateway`. External-node identity is the `(namespace, class)` pair, not the class name alone | `[MUST]` per N1(a) |

Cross-check: `classes/KappaGatewayCaller.cls` (v0.8-A2 above) already
independently exercises this exact shape one level deeper (`zenq.KappaGateway`
vs. `kwx.KappaGateway`, same class name "KappaGateway", both namespaces) —
this fixture is the minimal, single-purpose version; both must agree that
same-class-name-different-namespace never merges.

#### B5 (requirement 2e) — namespaced Flow actionName + namespaced CMDT value

`flows/Vtx_Namespace_Probe_Flow.flow-meta.xml` — a record-triggered
(`RecordAfterSave` on `Vertex_Order__c`) Autolaunched Flow with two
`<actionCalls>` blocks, `<actionType>apex</actionType>`:

| `<actionName>` | Shape | metascan.js v0.7.1 output (verified live, current/"before" baseline) | Expected v0.8 attach | Tag |
|---|---|---|---|---|
| `zenq.KappaGateway.dispatch` | dotted `ns.Class.method` (3 dot-segments) | `{ className:'zenq', methodName:'KappaGateway.dispatch' }` — the SAME pre-fix bug shape `LWC` had before v0.7.1's M1 (namespace prefix folded into `className`, no `namespace` field on `flow` refs at all today) | Per N1(c), metascan's flow extraction gains the same kind of `namespace`-field fix M1 already gave `lwc` refs, then `attachMetaCallers` routes it to the SAME external node `zenq.KappaGateway` that v0.8-A2 (`KappaGatewayCaller.cls`) and v0.8-A5 (the LWC import) attach to — a THREE-surface (Apex + LWC + Flow) consistency check on one external node. Caller = the Flow itself (kind `flow`, label `Vtx_Namespace_Probe_Flow`) | `[MUST]` per N1(c) |
| `kwx__PostLedgerEntry` | bare `ns__Class` (no dot — single Invocable-style action name) | `{ className:'kwx__PostLedgerEntry', methodName:null }` — whole token verbatim, no splitting at all | Per N1(c)'s `'ns__Class'` shape, split on the managed-object-style `__` prefix into ns=`kwx`, class=`PostLedgerEntry` → external node `kwx.PostLedgerEntry`, method `null` (bare Invocable action, no method segment — same `methodName:null` shape a local `@InvocableMethod` bare actionName already produces). Caller = the Flow (`Vtx_Namespace_Probe_Flow`) | `[MUST]` per N1(c) |

`customMetadata/Kappa_Trigger_Config.Namespace_Handler.md-meta.xml` — one new
CMDT record on the pre-existing `Kappa_Trigger_Config` type (same shape as
the pre-existing `Kappa_Trigger_Config.Order_Handler` record, which stays a
LOCAL, non-namespaced control — unchanged), `Handler_Class_Name__c` field
value `kwx__PostLedgerEntry`:

| Reference | metascan.js v0.7.1 output (verified live) | Expected v0.8 attach | Tag |
|---|---|---|---|
| `<value xsi:type="xsd:string">kwx__PostLedgerEntry</value>` (field `Handler_Class_Name__c`) | `{ kind:'cmdt', className:'kwx__PostLedgerEntry', methodName:null, fieldName:'Handler_Class_Name__c' }` — verbatim, no splitting | Same `ns__Class` splitting as the Flow's bare form above → attaches to the SAME external node `kwx.PostLedgerEntry` as the Flow's `kwx__PostLedgerEntry` actionName — a second cross-surface (Flow + CMDT) consistency check on one external node. Caller = the CMDT record itself (kind `cmdt`, label `Kappa_Trigger_Config.Namespace_Handler`) | `[MUST]` per N1(c) |

The pre-existing `Kappa_Trigger_Config.Order_Handler` record (`Handler_Class_Name__c`
= `KappaOrderTriggerHandler`, a real LOCAL class) is unaffected — it has no
namespace-like shape and stays a local attach, unchanged from v0.7.1. Adding
`Namespace_Handler` as a second record does not alter its resolution.

### v0.8-C. Non-edge appendix additions (extends §4)

| # | Call site | Would-be false target | Correct outcome | Tag |
|---|---|---|---|---|
| 10 | `VertexLedgerBridge.postToLedger` line C5:6 (unchanged, restated) | any local class | Unresolved — 2-segment carve-out (N2), stays unresolved forever, not promoted | `[MUST]` |
| 11 | `KappaGatewayCaller.routeCommands` L21 (`zenq.KappaGatewey.dispatch`, typo) | local `KappaGateway.dispatch` | External node `zenq.KappaGatewey` (own, distinct node) — must NOT land on local `KappaGateway` NOR on the `zenq.KappaGateway` external node from L3/L9 | `[MUST]` |
| 12 | `NamespaceDistinctGatewayCaller.openBoth` L3/L10 | each other's external node | `zenq.Gateway` and `kwx.Gateway` are two separate external nodes; a query for one must never return sites from the other | `[MUST]` |
| 13 | `ZenqLocalPrecedenceCaller.callWithoutLocalMember` L11 | local class `zenq`'s `Ledger` inner class (or any other local symbol) | External node `zenq.Signal` only — no local edge fabricated merely because `Head`="zenq" is a real class elsewhere in the same expression family | `[MUST]` |
| 14 | `TwoSegmentUnknownCaller.callUnknownTwoSegment` L3 | any external node | Stays unresolved — 2-segment shape never promotes to external regardless of how "namespace-like" `Head` looks | `[MUST]` |
| 15 | `VtxOwnNamespaceProbe` L3/L7/L11 | any external node (`vtx.*` / `vtx__*`) | All three resolve LOCALLY; the own-namespace token must never itself appear as an external node's namespace anywhere in the index | `[MUST]` |

### v0.8-D. File count addendum (extends §5's 63-file tally)

10 new source files added for v0.8 (7 `.cls` + 1 `.trigger` + 1 `.flow-meta.xml`
+ 1 `.md-meta.xml`), plus the `sfdx-project.json` edit and one additional
pre-existing-but-now-documented cluster of files (§v0.8-A, 5 files, 0 new):
`classes/VtxOwnNamespaceProbe.cls`, `classes/VtxKwxInvoiceService.cls`,
`triggers/VtxKwxInvoiceTrigger.trigger`, `classes/zenq.cls`,
`classes/ZenqLocalPrecedenceCaller.cls`, `classes/TwoSegmentUnknownCaller.cls`,
`classes/NamespaceDistinctGatewayCaller.cls`,
`flows/Vtx_Namespace_Probe_Flow.flow-meta.xml`,
`customMetadata/Kappa_Trigger_Config.Namespace_Handler.md-meta.xml` (9 files;
each `.cls`/`.trigger` also gets its usual `-meta.xml` sidecar, sidecars not
itemized per §5's own convention). This section's §1-style cluster tally
covers only the corpus's original 63-file scope (clusters A–E) plus this new
v0.8 addition — it does not attempt to reconcile against the separately
generated, separately tracked `dev/gauntlet/gen-corpus-f.js` fixture set
("Corpus F") already present on disk under the same `force-app/` tree, which
belongs to a different, unrelated fan-in/scale probe and is out of scope for
both this document and this addendum.

### v0.8-E. Builder / verification notes addendum

- Every new `.cls`/`.trigger` file in v0.8-B was parsed via
  `require('./parser.js').parseFile`
  during authoring; `parseError` was `null` for all 8 (7 `.cls` + 1
  `.trigger`), and the parsed `receiver`/`method`/`dml.targetText`/
  `triggerInfo.object` fields were spot-checked against the exact literal
  text used in the tables above (e.g. `VtxOwnNamespaceProbe.cls` L3 parses
  with `receiver:"vtx.VertexPricingService", method:"repriceOrder"`;
  `VtxKwxInvoiceTrigger.trigger` parses with `triggerInfo.object:"kwx__Invoice__c"`,
  `events:["before insert"]`). This corpus still has **no** deliberately-broken-syntax
  file (same invariant as §6).
- `metascan.js` (v0.7.1, unmodified) was run against both new metadata files
  (`Vtx_Namespace_Probe_Flow.flow-meta.xml`,
  `Kappa_Trigger_Config.Namespace_Handler.md-meta.xml`) to capture the
  "before" baseline shown in v0.8-B5's tables — confirms both files are
  well-formed enough for the CURRENT scanner to extract refs from without
  throwing, and confirms the exact pre-fix shape (`className` swallowing the
  namespace prefix) the v0.8 metascan amendment needs to correct.
- **Regression-safety design constraint, stated explicitly for the next
  builder/examiner**: v0.8-B2 uses `kwx__Invoice__c`, NOT the pre-existing
  `kwx__Ledger__c`, specifically so that adding a local trigger does not
  retroactively change `VertexLedgerBridge.postToLedger`'s (Target 11) DML→trigger
  fan-out at C5:13 beyond the sanctioned category-(a) delta (new external
  node only, trigger fan-out stays zero). Do not "consolidate" B2 onto
  `kwx__Ledger__c` in a future round without re-deriving Target 11's expected
  output from scratch.
- **Corpus defects:** none found in the v0.8 additions — every new file
  parses cleanly and every existing-file promotion in v0.8-A was checked
  against the actual pre-existing source text (not re-derived from memory)
  before writing its expected v0.8 outcome.

## v0.10 ground-truth edges

Scope: two v0.10 Round-A gap closures. **(A1)** `resolveChainedReceiver`'s
fluent-chain walk cap rises from 4 segments to a module constant
`CHAIN_MAX = 12`, gated by a NEW per-chain visited guard on
`(typeLower, methodLower)` pairs so a return-type CYCLE degrades to no edge
instead of either looping forever or landing on a wrong/lucky class. **(A2)**
`metascan.js` gains Visualforce ACTION-binding extraction
(`action="{!methodName}"` on `apex:page`/`apex:commandButton`/
`apex:commandLink`/`apex:actionFunction`/`apex:actionSupport`/
`apex:actionPoller`), attached by the resolver to whichever of the page's
controller/extensions classes declares that method. This section is
engine-blind in the same spirit as §§1–6 and the v0.8 section above: a
from-first-principles prediction written against the CONTRACT text (this
document's own header block, reproduced verbatim from the v0.10 Round-A
task spec), not against a live run.

`[MUST]`/`[IDEAL]` keep their §0 meanings, standing in for the not-yet-updated
README the same way the v0.8 section already established.

All new `.cls` files below were parsed with
`require('./parser.js').parseFile`
during authoring — `parseError == null` for all 23 (verified for this
write-up; see v0.10-E). All new `.page`/`.component` files were run through
the CURRENT (pre-A2) `metascan.js`'s `parseMetaFile` to confirm they are
well-formed enough for the tolerant scanner and produce exactly the
class-level `controller=`/`extensions=` refs §1's own VF documentation
(metascan.js's own header comment) already promises — see v0.10-E for the
captured baseline output.

### v0.10-A. Fluent chain resolution: `CHAIN_MAX = 12` + per-chain cycle guard

New files, `force-app/main/default/classes/`:

| Path | Role |
|---|---|
| `VtxReportQueryStage0.cls` … `VtxReportQueryStage13.cls` (14 files) | Fictional report-query fluent builder ladder. `StageK.<hopK+1>()` returns `Stage(K+1)` for K=0..12; `Stage1`..`Stage13` each also declare a terminal `build()` (13 declarations workspace-wide — deliberately non-unique, so rule 7's unique-name fallback can never mask a dropped chain as a false edge). Hop verbs in order: `selectFields, whereRegion, whereChannel, wherePeriod, whereStatus, orderBy, groupBy, having, limitTo, offsetBy, joinRelated, withLocale, withTimezone`. |
| `VtxReportQueryResult.cls` | Plain data class returned by every `build()`; parse-robustness only. |
| `VtxReportChainCaller.cls` | 4 methods, each building a receiver chain of a different length (5, 8, 12, 13 segments) off a fresh `VtxReportQueryStage0`, ending in a traced `.build()` call. |
| `VtxChainCycleNodeA.cls`, `VtxChainCycleNodeB.cls` | Return-type CYCLE pair: `A.next()->B`, `B.next()->A`, forever. Both also declare `terminal()` (2 declarations — non-unique, same anti-fallback purpose as `build()` above). |
| `VtxChainCycleCaller.cls` | One method, a 6-`.next()`-deep chain off a fresh `VtxChainCycleNodeA`, ending in a traced `.terminal()` call. |

#### A1-i. General resolution table (applies to EVERY chained call site in the ladder)

`parser.js` emits one `CallFacts` entry **per link** in a fluent chain, not
just the outermost traced call — e.g. `q.a().b().c()` parses as three
separate `kind:'dot'` calls: `receiver:"q.a().b()", method:"c"`,
`receiver:"q.a()", method:"b"`, `receiver:"q", method:"a"` (verified live
against `VtxReportChainCaller.cls`, see v0.10-E). Every one of those calls
independently goes through `resolveChainedReceiver` (or, for a 0-segment/
plain-identifier receiver, the ordinary declared-type rule) keyed on its OWN
receiver's segment count `S`. Because hop K is, by construction, declared on
`StageK-1` and returns `StageK`, a call whose receiver has `S` segments
always resolves (when it resolves at all) to a method declared on `StageS`:

| `S` (receiver segments) | v0.9 (cap 4) | v0.10 (cap 12) | Delta |
|---:|---|---|---|
| 0 | resolves — plain declared-type call, never enters the chain walker at all | resolves (unchanged) | none |
| 1 | resolves → `Stage1` | resolves → `Stage1` | none |
| 2 | resolves → `Stage2` | resolves → `Stage2` | none |
| 3 | resolves → `Stage3` | resolves → `Stage3` | none |
| 4 | resolves → `Stage4` | resolves → `Stage4` | none |
| 5 | **drops** (no edge; `S>4`) | **resolves → `Stage5`**, `via='typed'` | **FLIPPED** |
| 6 | drops | resolves → `Stage6`, `via='typed'` | **FLIPPED** |
| 7 | drops | resolves → `Stage7`, `via='typed'` | **FLIPPED** |
| 8 | drops | resolves → `Stage8`, `via='typed'` | **FLIPPED** |
| 9 | drops | resolves → `Stage9`, `via='typed'` | **FLIPPED** |
| 10 | drops | resolves → `Stage10`, `via='typed'` | **FLIPPED** |
| 11 | drops | resolves → `Stage11`, `via='typed'` | **FLIPPED** |
| 12 | drops | **resolves → `Stage12`**, `via='typed'` (exactly at the new cap) | **FLIPPED** |
| 13 | drops (`S>4`) | drops (`S>12` — still exceeds `CHAIN_MAX`) | unchanged (no edge either way; the *reason* differs but the observable outcome does not) |

Each dropped call site (`S>12`, or `S=13` here) must fall all the way through
to **no edge at all** — not a guessed edge onto `Stage12` (the last
successfully-walked type) or any other class. Per the same reasoning
`dev/hostile-v030-check.js`'s original 5-segment fixture already established
for the 4-segment cap (`Chain5E`/`Chain5F`/`Chain5Consumer` — see v0.10-E),
the method name at the dropped site (`build`) must also not be globally
unique, or rule 7's unique-name fallback would fabricate a false edge; this
corpus guarantees that by declaring `build()` on 13 separate classes.

#### A1-ii. `VtxReportChainCaller.cls` — per-method call-site tags

All four methods below live on ONE physical source line each (`parseChainSegments`
requires each `.method()` segment to butt directly against the previous
segment's closing paren with zero characters — not even a newline — in
between; the file-level header comment calls this out explicitly).

| Method (line) | Call sites present (by `S`, low→high) | New v0.10 flips among them | Tag |
|---|---|---|---|
| `runFiveSegmentChain` (L13, chain on L15) | `S`=0,1,2,3,4,5 | Only `S=5` (the traced `.build()` call → `Stage5.build`) | `[MUST]` per A1-i |
| `runEightSegmentChain` (L24, chain on L26) | `S`=0..8 | `S`=5,6,7,8 (`orderBy`→`Stage5`, `groupBy`→`Stage6`, `having`→`Stage7`, traced `.build()`→`Stage8`) | `[MUST]` per A1-i |
| `runTwelveSegmentChain` (L32, chain on L34) | `S`=0..12 | `S`=5..12 (8 call sites: `orderBy`→`Stage5` … `withLocale`→`Stage11`, traced `.build()`→`Stage12`) | `[MUST]` per A1-i |
| `runThirteenSegmentChain` (L43, chain on L45) | `S`=0..13 | `S`=5..12 resolve exactly as `runTwelveSegmentChain`'s do (`orderBy`→`Stage5` … `withTimezone`→`Stage12`); **`S=13`, the traced outer `.build()` call, is the one call site in this whole fixture set that must still yield NO edge** | `[MUST]` per A1-i |

`runThirteenSegmentChain` is the pointed illustration of the cap's honesty
guarantee: the 13th hop itself (`.withTimezone()`, whose own receiver has
only 12 segments) resolves perfectly normally to `Stage12.withTimezone` —
it's specifically chaining ONE MORE call (`.build()`) on top of that
12-segment result, producing a 13-segment receiver, that fails. A resolver
that instead "walks 12 hops and calls the 13th on whatever it lands on"
would be a **BUG**: it would fabricate an edge from the traced `.build()`
call to `Stage12.build` (or, worse, to `Stage13.build` by miscounting) — this
corpus's H4-style invariant (§0, "never a guessed edge") applies identically
here to fluent-chain overflow as it already does to `Type.forName` and
namespace precedence elsewhere in this document.

#### A1-iii. `VtxChainCycleCaller.cls` — return-type cycle, 6 segments deep

| Call site (`S`, receiver text) | Walk trace | Expected | Tag |
|---:|---|---|---|
| `S=0` (`n`) | plain declared-type call, not a chain walk at all | resolves → `VtxChainCycleNodeA.next`, `via='typed'` | `[MUST]` (unrelated to the guard) |
| `S=1` (`n.next()`) | 1 hop: `(A,next)` unseen → visit, land on `B` | resolves → `VtxChainCycleNodeB.next`, `via='typed'` | `[MUST]` |
| `S=2` (`n.next().next()`) | 2 hops: `(A,next)` unseen → `B`; `(B,next)` unseen → `A` — 2 distinct pairs visited, no repeat yet | resolves → `VtxChainCycleNodeA.next`, `via='typed'` | `[MUST]` |
| `S=3` (`n.next().next().next()`) | 3rd hop needs `(A,next)` again — **already visited at hop 1** | guard fires → chain walk aborts → **no edge** | `[MUST]` per A1 cycle guard |
| `S=4` | same 3rd-hop repeat as `S=3` (the cycle has period 2, so ANY receiver with 3+ segments off this pair necessarily re-treads an already-visited `(type,method)` edge) | **no edge** | `[MUST]` |
| `S=5` | same | **no edge** | `[MUST]` |
| `S=6` (`n.next().next().next().next().next().next()`, traced `.terminal()` call) | same — the walk never gets past its 2nd genuinely-new hop | **no edge** — the headline "6-deep cycle degrades honestly" assertion | `[MUST]` per A1 cycle guard |

The exact internal hop index at which the guard fires (`S=3`'s 3rd hop, per
the pre-check-before-stepping model this table assumes) is a reasoned
prediction, not a pinned implementation detail; what IS pinned, and holds
for ANY `(typeLower, methodLower)`-keyed guard that terminates the walk on a
repeat, is the **outcome**: `S=0,1,2` resolve normally, `S≥3` all yield no
edge, because a 2-node alternating cycle mathematically cannot be walked 3
steps without re-using an edge already taken. `terminal()` is deliberately
declared on both `VtxChainCycleNodeA` and `VtxChainCycleNodeB` so rule 7's
unique-name fallback also declines for the `S=6` site — a resolver that
skips the guard but still produces no edge here only by coincidence (e.g.
because `terminal` happened to be globally unique) would not actually be
implementing A1 correctly, so this fixture is deliberately hardened against
that false negative.

### v0.10-B. Visualforce method-level action bindings

New files:

| Path | Role |
|---|---|
| `pages/VtxCatalogPage.page` | Custom `controller=` + one `extensions=`. Covers: `apex:page` root `action=`, `apex:commandButton` action declared on the EXTENSION (not the controller), `apex:commandButton` action declared on BOTH controller and extension (ambiguous — bonus case beyond the 4 mandatory shapes), `apex:actionFunction` action matching NO declaring class, `apex:actionSupport` action with a non-identifier (dotted) expression. |
| `pages/VtxOrderHistoryPage.page` | Custom `controller=` only, no traps — `apex:commandButton`, `apex:commandLink`, `apex:actionPoller`, all resolving normally to the one controller class. |
| `pages/VtxAccountSummaryPage.page` | `standardController="Account"` ONLY — no `controller=`/`extensions=` at all, so there is no class-level base for ANY binding on this page to attach to. |
| `components/VtxFilterPanel.component` | `apex:component controller=`, `apex:commandButton` + `apex:actionFunction`, both resolving normally. |
| `classes/VtxCatalogController.cls` | Declares `initCatalog()`, `resetAll()` (ambiguous leg). |
| `classes/VtxCatalogFilterExtension.cls` | Declares `refreshResults()` (extension-only leg), `resetAll()` (ambiguous leg), `legacyReset()` (reachable only via the skipped dotted expression — must never appear as a caller target). |
| `classes/VtxOrderHistoryController.cls` | Declares `exportHistory()`, `retryFailedSync()`, `refreshStatus()`. |
| `classes/VtxFilterPanelController.cls` | Declares `applyFilter()`, `clearFilters()`. |

Per the A2 CONTRACT: metascan extracts a method-level `MetaRef`
(`kind:'vf', className:null, methodName, line`) for every
`action="{!singleIdentifier}"` attribute on an apex-namespaced tag, alongside
the page's existing class-level controller/extensions refs; the RESOLVER
then attaches each method ref to whichever of the page's controller/
extensions classes DECLARES that method — and to the controller only
(class-level, no method fabricated) when none or several declare it.
`value="{!prop}"` bindings are explicitly OUT of scope this round (both
pages below include one, to confirm they are correctly ignored, not merely
absent by omission).

#### B1. `pages/VtxCatalogPage.page`

| Line | Binding | Expression shape | Expected `MetaRef` | Expected resolver attach | Tag |
|---|---|---|---|---|---|
| L1, `<apex:page ... action="{!initCatalog}">` | `apex:page` root action | single identifier | `{kind:'vf', className:null, methodName:'initCatalog', line:1}` | `initCatalog` is declared ONLY on `VtxCatalogController` (own controller) → method-level edge, caller = the page (`VtxCatalogPage`), callee = `VtxCatalogController.initCatalog` | `[MUST]` per A2 |
| L6, `<apex:commandButton ... action="{!refreshResults}">` | commandButton action | single identifier | `{..., methodName:'refreshResults', line:6}` | `refreshResults` is declared ONLY on `VtxCatalogFilterExtension` (the EXTENSION, not the controller) → method-level edge to `VtxCatalogFilterExtension.refreshResults` — this is the mandatory "declared on an extension, not the controller" shape | `[MUST]` per A2 |
| L7, `<apex:commandButton ... action="{!resetAll}">` | commandButton action | single identifier | `{..., methodName:'resetAll', line:7}` | `resetAll` is declared on BOTH `VtxCatalogController` AND `VtxCatalogFilterExtension` — "several declare it" → class-level ref to the controller ONLY (`VtxCatalogController`), no method fabricated on either class. Bonus case beyond the 4 mandatory shapes, still governed by the same A2 rule | `[MUST]` per A2 |
| L13, `<apex:actionFunction name="doSort" action="{!vanishedSortHandler}">` | actionFunction action | single identifier | `{..., methodName:'vanishedSortHandler', line:13}` | `vanishedSortHandler` is declared on NEITHER `VtxCatalogController` NOR `VtxCatalogFilterExtension` — "none declare it" → **no method-level edge is fabricated**; falls back to the SAME class-level ref to `VtxCatalogController` that the page's own `controller=` attribute already produces (§1's pre-existing class-level VF scan), i.e. this specific binding contributes no NEW edge at all. The mandatory "binding matching no class → no edge" shape, precisely stated: no *method* edge, and no *additional* edge beyond what already existed | `[MUST]` per A2 |
| L14, `<apex:actionSupport event="onchange" action="{!filterExt.legacyReset}">` | actionSupport action | **dotted**, NOT a single identifier | metascan must SKIP this attribute entirely — no `MetaRef` emitted for it at all (contrast with the other four rows, which each produce one) | No edge, by construction — `VtxCatalogFilterExtension.legacyReset` must never appear as a callee of this page anywhere in the index. Must NOT be confused with the L13 "no declaring class" case above: this one never even reaches the resolver, because metascan itself declines to extract it | `[MUST]` per A2 (`{!obj.method}` shape explicitly out of scope) |
| L10, `<apex:outputText value="{!statusLabel}">` | commandButton/outputText VALUE (not action) | single identifier, but `value=`, not `action=` | no `MetaRef` — `value=` bindings are explicitly out of scope this round | No edge; must not be mistaken for a dropped/failed extraction — it is correctly never attempted | `[MUST]`-equivalent (documented scope exclusion) |

#### B2. `pages/VtxOrderHistoryPage.page` — clean contrast page (no traps)

| Line | Binding | Expected resolver attach | Tag |
|---|---|---|---|
| L6, `apex:commandButton action="{!exportHistory}"` | method-level edge → `VtxOrderHistoryController.exportHistory` | `[MUST]` |
| L7, `apex:commandLink action="{!retryFailedSync}"` | method-level edge → `VtxOrderHistoryController.retryFailedSync` | `[MUST]` |
| L11, `apex:actionPoller action="{!refreshStatus}"` | method-level edge → `VtxOrderHistoryController.refreshStatus` | `[MUST]` |
| L9, `apex:outputText value="{!lastSyncedLabel}"` | no `MetaRef` — `value=`, out of scope (same as B1's L10) | `[MUST]`-equivalent |

All three action sites resolve to the SAME single controller class — no
extension, no ambiguity; this page exists purely to prove the ordinary case
is unaffected by A2's new disambiguation logic.

#### B3. `pages/VtxAccountSummaryPage.page` — `standardController` only, literal no-edge

| Line | Binding | Expected | Tag |
|---|---|---|---|
| L1, `<apex:page standardController="Account">` | No `controller=`/`extensions=` attribute anywhere on this page — the PRE-EXISTING class-level VF scan (unchanged by A2) already yields ZERO refs for this file (confirmed live against the current, pre-A2 `metascan.js`, see v0.10-E) | Since there is no controller/extensions class list at all for this page, NEITHER of the two action bindings below can attach to anything — this is the one case in this section where "no edge" is literal, not "no *additional* edge" | `[MUST]` |
| L6, `apex:commandButton action="{!edit}"` | `edit` is a Visualforce STANDARD-CONTROLLER built-in action, not an Apex identifier at all | No `MetaRef`/no edge — there is no controller class to attach a method ref to, method-level or class-level | `[MUST]` |
| L7, `apex:commandButton action="{!save}"` | same as `edit` | No edge | `[MUST]` |

This is the corpus's "one page with `standardController` only" requirement —
distinct from B1's L13 ("declared on none of a page's *real* controller/
extensions classes"): here there is no real controller/extensions class list
to begin with.

#### B4. `components/VtxFilterPanel.component`

| Line | Binding | Expected resolver attach | Tag |
|---|---|---|---|
| L5, `apex:commandButton action="{!applyFilter}"` | method-level edge → `VtxFilterPanelController.applyFilter` | `[MUST]` |
| L6, `apex:actionFunction name="clearAll" action="{!clearFilters}"` | method-level edge → `VtxFilterPanelController.clearFilters` | `[MUST]` |

Ordinary case, single controller, no extensions (`apex:component` does not
support an `extensions=` attribute at all) — confirms A2's action-binding
extraction applies identically to `.component` files, not just `.page`.

### v0.10-C. Non-edge appendix additions (extends §4)

| # | Call site | Would-be false target | Correct outcome | Tag |
|---|---|---|---|---|
| 16 | `VtxReportChainCaller.runThirteenSegmentChain` traced `.build()` call (`S=13`) | `VtxReportQueryStage12.build` (the last successfully-walked stage) or `VtxReportQueryStage13.build` (the "true" 13th landing spot) | No edge to either — exceeding `CHAIN_MAX` is a hard failure of the whole call site, not a truncate-and-guess | `[MUST]` per A1 |
| 17 | `VtxChainCycleCaller.runSixDeepCycle` traced `.terminal()` call (`S=6`), and the `S=3,4,5` intermediate `.next()` calls in the same expression | `VtxChainCycleNodeA.terminal`/`VtxChainCycleNodeB.terminal` (or either class's `next`) | No edge to any of them — the return-type cycle's `(type,method)` pair repeat aborts the walk well before `CHAIN_MAX` is even relevant | `[MUST]` per A1 |
| 18 | `pages/VtxCatalogPage.page` L12 `{!vanishedSortHandler}` | a fabricated method node on either `VtxCatalogController` or `VtxCatalogFilterExtension` | No method-level edge; only the pre-existing class-level ref to `VtxCatalogController` (from the page's own `controller=` attribute) remains — this binding itself contributes nothing new | `[MUST]` per A2 |
| 19 | `pages/VtxCatalogPage.page` L13 `{!filterExt.legacyReset}` | `VtxCatalogFilterExtension.legacyReset` | No `MetaRef` at all — dotted/non-identifier expressions are skipped at the metascan layer, before the resolver ever runs | `[MUST]` per A2 |
| 20 | `pages/VtxAccountSummaryPage.page` L6/L7 `{!edit}`/`{!save}` | any class (there is no controller/extensions class registered on this page at all) | No edge, literally — not even a class-level fallback, since there is no class to fall back to | `[MUST]` per A2 |
| 21 | `pages/VtxCatalogPage.page` L7 / `pages/VtxOrderHistoryPage.page` L7 `value="{!...}"` bindings | any class | No `MetaRef` — `value=` is explicitly out of scope this round, not a missed extraction | `[MUST]`-equivalent (documented scope exclusion) |

### v0.10-D. File count addendum (extends §5's 63-file tally and §v0.8-D's 10-file addendum)

31 new source files added for v0.10 (23 `.cls` + 4 `.page` + 1 `.component`,
plus 23 `.cls-meta.xml` + 3 `.page-meta.xml` + 1 `.component-meta.xml`
sidecars — 54 files on disk total, sidecars itemized here for once since
`.page-meta.xml`/`.component-meta.xml` are new source-type sidecars for this
corpus, unlike the already-established `.cls-meta.xml` convention):

- Chain ladder (A1): `classes/VtxReportQueryStage0.cls` … `VtxReportQueryStage13.cls`
  (14), `classes/VtxReportQueryResult.cls`, `classes/VtxReportChainCaller.cls`
  (16 `.cls` files).
- Chain cycle (A1): `classes/VtxChainCycleNodeA.cls`, `classes/VtxChainCycleNodeB.cls`,
  `classes/VtxChainCycleCaller.cls` (3 `.cls` files).
- Visualforce (A2): `pages/VtxCatalogPage.page`, `pages/VtxOrderHistoryPage.page`,
  `pages/VtxAccountSummaryPage.page`, `components/VtxFilterPanel.component`
  (4 markup files) + `classes/VtxCatalogController.cls`,
  `classes/VtxCatalogFilterExtension.cls`, `classes/VtxOrderHistoryController.cls`,
  `classes/VtxFilterPanelController.cls` (4 `.cls` files).

Total: 16 + 3 + 4 = 23 `.cls` files, + 4 markup files = 27 non-sidecar source
files; + 27 matching `-meta.xml` sidecars = 54 files on disk. No pre-existing
file in the corpus was modified — this is a pure addition, same convention
as v0.8-D. This addendum does not attempt to reconcile against `dev/gauntlet/
gen-corpus-f.js`'s separately-tracked "Corpus F" fixture set, per the same
out-of-scope note v0.8-D already recorded.

### v0.10-E. Builder / verification notes addendum

- Every new `.cls` file (23 total) was parsed via
  `require('./parser.js').parseFile`
  during authoring — `parseError` was `null` for all 23, and the parsed
  `receiver`/`method` fields for every chained call site in
  `VtxReportChainCaller.cls` and `VtxChainCycleCaller.cls` were spot-checked
  against the exact literal text used in A1-ii/A1-iii above (confirmed live:
  `parser.js` emits one `CallFacts` per link in the chain, e.g. the 5-segment
  method alone yields 6 separate `kind:'dot'` calls, not 1 — see A1-i). This
  corpus still has **no** deliberately-broken-syntax file (same invariant as
  §6/v0.8-E).
- All 4 new `.page`/`.component` files were run through the CURRENT
  (pre-A2, v0.9) `metascan.js`'s `parseMetaFile` to capture the "before"
  class-level baseline: `VtxCatalogPage.page` → 2 refs (`VtxCatalogController`,
  `VtxCatalogFilterExtension`); `VtxOrderHistoryPage.page` → 1 ref
  (`VtxOrderHistoryController`); `VtxAccountSummaryPage.page` → **0 refs**
  (confirms the `standardController`-only page has no class-level base
  today, before A2 even exists — B3's "literal no edge" prediction rests on
  this already being true, not on new A2 behavior); `VtxFilterPanel.component`
  → 1 ref (`VtxFilterPanelController`). Confirms all 4 files are well-formed
  enough for the tolerant scanner and matches metascan.js's own documented
  `<apex:page controller="Cls" extensions="Ext1,Ext2">` pattern exactly.
- **Stale-expectation flag (not corrected here — outside this document's
  write scope, which is `example-data/gauntlet-org` only):**
  `dev/gauntlet/` itself contains no fluent-chain-cap assertions today (searched;
  none found — the "5-segment nested namespace" check in
  `dev/gauntlet/run-namespace-probes-v2-rehunt.js` is an unrelated feature,
  namespace-TOKEN depth for `isUnknownNamespacedReceiver`, not
  `parseChainSegments`/`resolveChainedReceiver` fluent-method-chain depth —
  do not conflate the two). The actual pre-existing "5-segment chain must
  drop honestly" assertions live in `dev/hostile-v030-check.js` (`Chain5A`
  through `Chain5F` + `Chain5Consumer`, `dev/hostile-v030/`), specifically:
  *"5-segment chain: Chain5E (segment-4 boundary decoy) must NOT receive the
  edge"* and *"5-segment chain: exceeding the 4-segment cap yields NO edge at
  all (not a guess)"*. Under `CHAIN_MAX=12` both of `Chain5E.g`/`Chain5F.g`'s
  no-edge expectations flip: `Chain5F.g` (the 5th, REAL segment) must now
  RESOLVE (`head.b().c().d().e().f().g()` has a 5-segment receiver, `S=5≤12`),
  while `Chain5E.g` (the segment-4 decoy) must still correctly NOT receive
  the edge — same "walk fully, don't truncate-and-guess" invariant as
  A1-ii's `runThirteenSegmentChain` illustration above, just now on the
  "now resolves" side of the boundary instead of the "still drops" side.
  This file was not edited as part of this corpus phase (it lives in the
  plugin repo's `dev/` tree, outside `example-data/gauntlet-org`); flagging
  it here for the implementation/regression round that lands A1.
- **Corpus defects:** none — every new file parses cleanly (23/23 `.cls`) and
  every new VF file is well-formed for the current tolerant scanner (4/4);
  this corpus has not yet been run against a `CHAIN_MAX=12`/A2-capable build
  of the engine.

## v0.11 ground-truth edges

Scope: the v0.11 Round B CONTRACT's two dataflow-lite gap closures. **(B1)**
literal-flow `Type.forName` resolution — extends the pre-existing
single-inline-string-literal-only rule to three additional strictly-verifiable
shapes (single-assignment never-reassigned local, static-final-String
constant own/cross-class, ternary-of-two-literals), all landing as
`via='dynamic', approximate:true` exactly like the pre-existing inline-literal
case, through the SAME class-lookup rules (including namespace/external
handling). **(B2)** generic-DML narrowing — when a DML statement's target is
a local variable of generic SObject-collection type, intra-method
`add`/`addAll` evidence on that same variable (a `new Concrete__c(...)`
construction, or a simple identifier whose declared type is a concrete
SObject value/collection) narrows the DML to real objects, replacing the
honest "DML on unresolved SObject type" marker with per-type `~dml` edges
(also `approximate:true`); zero valid evidence leaves the marker exactly as
today. This section is engine-blind in the same spirit as §§1–6, the v0.8
section, and the v0.10 section above: a from-first-principles prediction
written against the v0.11 Round B CONTRACT text (this round's task spec,
reproduced/paraphrased here for the write-up), not against a live run — the
engine implementing B1/B2 has not landed in this repo as of this write-up
(`git status` clean, `parser.js`/`resolver.js` unmodified). `[MUST]`/`[IDEAL]`
keep their §0 meanings.

All new `.cls`/`.trigger` files below were parsed with
`require('./parser.js').parseFile`
during authoring — `parseError == null` for all 6 new `.cls` files (verified
live for this write-up, incl. a full dump of each new method's `locals`/
`calls`/`dml` facts and each new type's `fields`, cross-checked line-by-line
against the tables below). The new `.trigger` file is plain, untyped Apex
trigger syntax identical in shape to the corpus's 4 pre-existing triggers
(`KappaOrderTrigger.trigger` etc.) and was not separately parse-checked
(`parser.js` only handles `.cls`; triggers are consumed elsewhere in the
pipeline).

### v0.11-B1. Literal-flow dynamic dispatch (`Type.forName`)

New files, `force-app/main/default/classes/`:

| Path | Role |
|---|---|
| `VtxHandlerNames.cls` | Cross-class constant container. `ROUTER` (L12): static final String, single-literal initializer — the one QUALIFYING constant. `LEGACY_HANDLER_NAME` (L16): literal initializer but NOT `final` — must be absent from `TypeFacts.constants`. `COMPUTED_HANDLER_NAME` (L21): `final`, but initializer is a method call (`deriveComputedName()`), not a literal — must also be absent from `TypeFacts.constants`. |
| `VtxDynamicFactory.cls` | The factory under test — 8 methods, one per B1 sub-shape, detailed below. Also declares its OWN static final String constant, `ESCALATION_HANDLER` (L13), for the own-class bare-reference case. |
| `VtxRouterHandler.cls` | Trivial dynamic-dispatch target #1 — reached by (a)'s positive case and (c)'s ternary "else" branch. |
| `VtxLegacyHandler.cls` | Trivial dynamic-dispatch target #2 — reached ONLY by (c)'s ternary "then" branch; every other reference to this class name in this fixture set (the reassigned local in (a-neg), the non-final field in (b-neg v1)) is a deliberate negative that must NOT resolve here. |
| `VtxEscalationHandler.cls` | Trivial dynamic-dispatch target #3 — reached ONLY by the own-class constant case. |

Note: no class named `VtxComputedHandler` exists anywhere in this corpus,
even though `VtxHandlerNames.deriveComputedName()` returns that exact string
at runtime — deliberately, so a resolver bug that somehow chased the (b-neg
v2) reference anyway could never land on a real target and masquerade as
correct (same "no accidental true landing spot for a should-be-dropped site"
discipline the v0.10 chain-ladder fixtures already established for `build`/
`terminal`).

#### B1-i. `VtxDynamicFactory.cls` — per-method call-site table

| Method (decl line) | `Type.forName(...)` site (line) | Sub-shape | Literal(s) involved | Expected under B1 | Tag |
|---|---:|---|---|---|---|
| `createFromLiteralLocal` (L17) | L19 | (a) single-assignment literal local, never reassigned | `'VtxRouterHandler'` (declared L18) | `handlerName`'s `locals[]` entry carries `literal:'VtxRouterHandler'` (no other assignment to `handlerName` anywhere in this method) → resolves exactly as an inline literal would → ctor edge `VtxDynamicFactory.createFromLiteralLocal` → `VtxRouterHandler.<init>`, `via='dynamic'`, `approximate:true` | `[MUST]` per (a) |
| `createFromReassignedLocal` (L31) | L36 | (a-neg) same literal-initializer shape, but reassigned at L34 (`handlerName = 'VtxLegacyHandler';`, inside an `if`) | n/a | `handlerName`'s `literal` is CLEARED — the parser's no-reassignment proof is purely syntactic (any assignment expression to that name, anywhere in the method body, clears it), not reachability-sensitive, so the `if` guard is irrelevant. Arg is a bare non-literal identifier → same as today: `unresolvedSitesCount++`, **no edge** | `[MUST]` per (a-neg) |
| `createFromOwnConstant` (L45) | L46 | (b) own-class static final String constant, BARE reference | `'VtxEscalationHandler'` (via `ESCALATION_HANDLER`, declared L13) | `VtxDynamicFactory`'s own `TypeFacts.constants` contains `{name:'ESCALATION_HANDLER', literal:'VtxEscalationHandler'}` — bare-identifier arg matches a constant on the CALLING class itself → ctor edge → `VtxEscalationHandler.<init>`, `via='dynamic'`, `approximate:true` | `[MUST]` per (b) |
| `createFromCrossClassConstant` (L55) | L56 | (b) cross-class static final String constant, QUALIFIED reference (`VtxHandlerNames.ROUTER`) | `'VtxRouterHandler'` | `VtxHandlerNames.constants` contains `{name:'ROUTER', literal:'VtxRouterHandler'}` (VtxHandlerNames.cls L12) — dotted `ClassName.CONST` arg resolves against that class's `constants[]` → ctor edge → `VtxRouterHandler.<init>`, `via='dynamic'`, `approximate:true` | `[MUST]` per (b) |
| `createFromNonFinalCrossClassField` (L66) | L67 | (b-neg, variant 1) cross-class field, literal initializer, NOT `final` (`VtxHandlerNames.LEGACY_HANDLER_NAME`, L16) | n/a | Field has no `final` modifier → parser never records it in `TypeFacts.constants` at all → the dotted lookup finds nothing → **no edge** (same fallthrough as any other unresolvable dotted arg today) | `[MUST]` per (b-neg) |
| `createFromComputedCrossClassField` (L78) | L79 | (b-neg, variant 2) cross-class field, `final`, but initializer is a method call, not a literal (`VtxHandlerNames.COMPUTED_HANDLER_NAME`, L21) | n/a | Field IS `static final String` but its initializer (`deriveComputedName()`) is not a single string literal → parser never records it in `TypeFacts.constants` either → **no edge** | `[MUST]` per (b-neg) |
| `createFromTernary` (L87) | L88 | (c) ternary of two string literals | `'VtxLegacyHandler'` AND `'VtxRouterHandler'` | BOTH literal candidates resolve independently via the existing class-lookup rules → **TWO** ctor edges from this ONE call site: `VtxDynamicFactory.createFromTernary` → `VtxLegacyHandler.<init>` AND → `VtxRouterHandler.<init>`, both `via='dynamic'`, `approximate:true` | `[MUST]` per (c) |
| `createFromNamespacedLiteral` (L100) | L101 | (d) literal naming a namespaced external | `'zenq.Billing'` | No LOCAL class resolves (own namespace is `vtx` per `sfdx-project.json`, so `zenq` is foreign) → falls through to the SAME namespace/external class-lookup machinery the CONTRACT text calls out ("incl. namespace/external handling") → attaches to the EXTERNAL node keyed `zenq.billing` (label `zenq.Billing`) — the SAME node `VertexLedgerBridge.cls`'s direct `zenq.Billing.charge(...)` call (v0.8-A1, C5:19) already attaches to — gaining ONE NEW site under it, distinct from that pre-existing `charge`-method site, `via='dynamic'`, `approximate:true`. That an external edge fires at all is `[MUST]` per the CONTRACT's explicit "(d)" text; the exact method-label this new site carries on the external node (most plausibly `'<init>'`, by analogy with the local ctor-edge shape every other B1 positive case in this table uses) is NOT pinned by the CONTRACT text, so that one sub-detail is `[IDEAL]` | `[MUST]` (edge exists) / `[IDEAL]` (exact method label) |
| `createFromParam` (L112) | L113 | (e) param-fed | n/a | `handlerName` here is a METHOD PARAMETER, never a local — the parser's `locals[]`/`literal` contract applies only to local-variable declarations, never to params, so no `literal` is ever recorded for it → `unresolvedSitesCount++`, **no edge**. Same shape as the pre-existing `KappaGenericTriggerDispatcher.dispatch` fixture's `Type.forName(config.Handler_Class_Name__c)` (there, a queried record's field access; here, a bare param) — both unknowable statically | `[MUST]` per (e) |

Cross-check: `VtxDynamicFactory`'s live-parsed `locals`/`calls` facts for
every method above were dumped and confirmed to match this table exactly
during authoring (arg texts, declaration lines, and — for `createFromParam`
— the ABSENCE of `handlerName` from `locals[]` since it is a parameter, not
a local declaration).

#### B1-ii. Non-edge appendix additions (extends §4/v0.10-C)

| # | Call site | Would-be false target | Correct outcome | Tag |
|---|---|---|---|---|
| 22 | `VtxDynamicFactory.createFromReassignedLocal` (L36) | `VtxRouterHandler.<init>` (the local's ORIGINAL literal value before reassignment) | No edge — a reassignment anywhere in the method clears `literal` unconditionally, so the engine must not "remember" the local's first value either | `[MUST]` per (a-neg) |
| 23 | `VtxDynamicFactory.createFromNonFinalCrossClassField` (L67) | `VtxLegacyHandler.<init>` | No edge — the field's mutability alone (missing `final`) disqualifies it, independent of the fact that its literal value happens to name a real local class | `[MUST]` per (b-neg) |
| 24 | `VtxDynamicFactory.createFromComputedCrossClassField` (L79) | any class named `VtxComputedHandler` | No edge, and moot regardless — no such class exists anywhere in this corpus | `[MUST]` per (b-neg) |
| 25 | `VtxDynamicFactory.createFromParam` (L113) | any class (the arg is a free parameter, no fixed candidate) | No edge — this method has zero callers anywhere in this corpus (tested in isolation, deliberately never invoked with a literal at any call site), so there is also no indirect literal-flow path to chase here | `[MUST]` per (e) |

### v0.11-B2. Generic-DML narrowing

New file, `force-app/main/default/classes/VtxUnitOfWorkNarrowing.cls` — one
method per B2 sub-shape, `pending` always a LOCAL variable declared
`List<SObject>` (the same generic-collection shape the honest "DML on
unresolved SObject type" marker already exists for). New file,
`force-app/main/default/triggers/KappaShipmentTrigger.trigger` — registers
the corpus's FIRST DML/trigger linkage on `Kappa_Shipment__c` (`before
insert, after insert`); the object itself already existed as a plain
param-type token (`VertexKappaShipmentHub.cls`, `VertexKappaShipmentCaller.cls`)
with zero prior DML/trigger ground-truth documentation, so this addition
carries zero regression risk to any pre-existing target.

#### B2-i. `VtxUnitOfWorkNarrowing.cls` — per-method table

| Method (decl line) | DML site (line, op) | Intra-method evidence | Union of narrowed types | Expected trigger fan-out | Tag |
|---|---:|---|---|---|---|
| `commitBothTypes` (L14) | L18, `insert` | L16 `pending.add(new Kappa_Order__c(Name = 'ord-1'))`; L17 `pending.add(new Kappa_Shipment__c(Name = 'shp-1'))` — both argTexts match the `new Concrete__c(` pattern | `{Kappa_Order__c, Kappa_Shipment__c}` | `insert` → `['before insert','after insert']`. `Kappa_Order__c`: `KappaOrderTrigger` (`before insert, after insert, after update` — matches) + `KappaOrderUowTrigger` (`after insert` — matches) = 2 edges. `Kappa_Shipment__c`: `KappaShipmentTrigger` (`before insert, after insert` — matches) = 1 edge. **3 narrowed `~dml` edges total**, `via='dml'`, `approximate:true` each; the honest marker is REPLACED (gone) for this site | `[MUST]` per B2 |
| `commitTypedOrdersViaAddAll` (L25) | L29, `insert` | L28 `pending.addAll(typedOrders)`; `typedOrders` (L27) is a local whose DECLARED type is `List<Kappa_Order__c>` — a simple identifier resolvable via the type env to a concrete SObject-typed COLLECTION | `{Kappa_Order__c}` | `KappaOrderTrigger` + `KappaOrderUowTrigger` = **2 narrowed `~dml` edges**, marker REPLACED. Note: `typedOrders` itself is initialized from a method call (`buildTypedOrders()`) — irrelevant, since what matters for this evidence form is the local's DECLARED type at the `addAll` call site, not how it was populated | `[MUST]` per B2 |
| `commitWithNoInMethodEvidence` (L37) | L39, `update` | ZERO `add`/`addAll` calls on `pending` anywhere in this method (`pending` arrives pre-populated from `fetchPendingRecords()`) | `{}` (empty) | Marker STAYS exactly as today ("DML on unresolved SObject type"), **zero** narrowed edges. Deliberately uses `update`, not `insert`, to prove the marker's persistence is DML-verb-independent | `[MUST]` per B2 |
| `commitWithComplexExpressionEvidence` (L49) | L52, `insert` | L51 `pending.add(locateExistingOrder())` — argText `"locateExistingOrder()"` matches NEITHER the `new Concrete__c(` pattern NOR a bare identifier (it is a method-call expression); `locateExistingOrder`'s declared RETURN type (`Kappa_Order__c`) is cross-method evidence, explicitly OUT of scope this round | `{}` (empty — the one candidate piece of evidence does not qualify) | Marker STAYS, **zero** narrowed edges. The specific bug this guards against: inferring `Kappa_Order__c` from `locateExistingOrder()`'s return type would be a scope violation, not a correct narrowing | `[MUST]` per B2 ("MUST NOT narrow from that evidence alone") |

#### B2-ii. Promoted pre-existing file: `classes/KappaUnitOfWork.cls`, method `commitWork` (unchanged, regression check)

| Method | Evidence | Expected under B2 | Tag |
|---|---|---|---|
| `commitWork` | `records` (`List<SObject>`, from `newRecordsByType.get(tkey)`) has ZERO `add`/`addAll` calls anywhere inside `commitWork` itself — the actual `.add(record)` calls happen in the DIFFERENT method `registerNew`, which is out of scope by construction (same-METHOD evidence only) | Marker STAYS exactly as pre-B2 ("DML on unresolved SObject type"), **zero** narrowed edges — REGRESSION POLICY requires this pre-existing file's behavior to be byte-identical except for the two permitted delta categories, and this site qualifies for neither | `[MUST]` (no-change) — cross-checks the zero-evidence path against real pre-existing code, not just a purpose-built fixture |

`KappaUnitOfWork.insertDirect(Kappa_Order__c order)` (the file's existing
concretely-typed positive control) remains completely untouched by B2
either way — its DML target was never generically SObject-typed in the
first place, so the new narrowing logic never even activates for it.

#### B2-iii. Non-edge appendix additions (extends §4/v0.10-C)

| # | Call site | Would-be false target | Correct outcome | Tag |
|---|---|---|---|---|
| 26 | `VtxUnitOfWorkNarrowing.commitWithNoInMethodEvidence` (L39) | any narrowed object (there is no in-method evidence to narrow from at all) | Marker stays, no edges of any kind — not even a partial/best-guess narrowing | `[MUST]` per B2 |
| 27 | `VtxUnitOfWorkNarrowing.commitWithComplexExpressionEvidence` (L52) | `Kappa_Order__c` (inferred from `locateExistingOrder()`'s return type) | Marker stays, no edges — cross-method return-type inference is out of scope, and must not silently "work anyway" | `[MUST]` per B2 |
| 28 | `KappaUnitOfWork.commitWork` (pre-existing, unchanged) | `Kappa_Order__c`/`Kappa_Shipment__c`/any object (there is no in-method `add`/`addAll` evidence — the evidence lives in the sibling method `registerNew`) | Marker stays, no edges — cross-method evidence (a DIFFERENT method's calls) is out of scope, exactly like B2-iii row 27's cross-method exclusion | `[MUST]` per B2 |

### v0.11-C. File count addendum (extends §5, v0.8-D, v0.10-D)

7 new source files added for v0.11 Round B (6 `.cls` + 1 `.trigger`), plus 7
matching `-meta.xml` sidecars (6 `.cls-meta.xml` + 1 `.trigger-meta.xml`) —
**14 files on disk total**:

- B1 (literal-flow dynamic dispatch): `classes/VtxHandlerNames.cls`,
  `classes/VtxDynamicFactory.cls`, `classes/VtxRouterHandler.cls`,
  `classes/VtxLegacyHandler.cls`, `classes/VtxEscalationHandler.cls`
  (5 `.cls` files).
- B2 (generic-DML narrowing): `classes/VtxUnitOfWorkNarrowing.cls` (1 `.cls`
  file), `triggers/KappaShipmentTrigger.trigger` (1 trigger file).

No pre-existing file in the corpus was modified — this is a pure addition,
same convention as v0.8-D/v0.10-D. `sfdx-project.json` (namespace `vtx`) was
NOT modified — B1(d)'s namespace behavior relies entirely on the pre-existing
`vtx` own-namespace declaration, already exercised by the v0.8 corpus.

### v0.11-D. Expectation tally

21 documented ground-truth rows total:

- **B1** — 13 rows: 9 per-method rows in B1-i (`createFromLiteralLocal`,
  `createFromReassignedLocal`, `createFromOwnConstant`,
  `createFromCrossClassConstant`, `createFromNonFinalCrossClassField`,
  `createFromComputedCrossClassField`, `createFromTernary` — this one row
  asserts TWO edges, both candidates — `createFromNamespacedLiteral`,
  `createFromParam`) + 4 non-edge appendix rows in B1-ii. All `[MUST]`
  except `createFromNamespacedLiteral`, which carries a `[MUST]`
  (edge-existence) paired with one `[IDEAL]` sub-detail (the exact
  method-label the new external-node site carries).
- **B2** — 8 rows: 4 per-method rows in B2-i + 1 promoted-file row in
  B2-ii + 3 non-edge appendix rows in B2-iii. All `[MUST]`.

**21 total rows** (20 pure `[MUST]`, 1 `[MUST]` + 1 `[IDEAL]` combined) —
plus the underlying edge-count is higher still where a single row asserts
more than one edge (`createFromTernary`: 2 edges; `commitBothTypes`: 3
edges; `commitTypedOrdersViaAddAll`: 2 edges).

**Corpus defects:** none — all 6 new `.cls` files parse cleanly
(`parseError == null`, verified live for every file, incl. a full `locals`/
`calls`/`dml`/`fields` fact dump cross-checked against every table above).

## Entry catalog (v0.12)

Hand-audited, **source-only** inventory (grep/read of every `.cls`, `.trigger`,
and `.flow-meta.xml` file — the engine was never run to produce this section)
for v0.12's `buildEntryCatalog(index)`. Corpus has 235 `.cls` files (8 marked
`@isTest` at the class level: `VertexBoltDecoy10`, `VertexBoltMulti01`,
`VertexBoltSolo05`, `VertexBoltSolo06`, `VertexBoltWrapperTestA`,
`VertexOrderServiceTest`, `VertexOrderTriggerHandlerTest`,
`VertexPricingServiceTest` — none of the 8 declare any entry-annotated method,
so **0 entries are excluded** as test-only), 6 `.trigger` files, 1
`.flow-meta.xml`, 0 `.apex` anonymous scripts. Single package (`force-app`
only, no `pkg-*` dirs) — every entry's `package` field is `null`.

### Counts per kind

| kind | count |
|---|---:|
| trigger | 6 |
| aura | 5 |
| invocable | 2 |
| rest | 0 |
| soap | 0 |
| async | 9 |
| email | 0 |
| platform | 0 |
| flow | 1 |
| anonymous | 0 |
| **total** | **23** |
| excludedTestEntries | 0 |

### Full expected entry list

#### kind: trigger (6, sorted by label)

| label | detail |
|---|---|
| `KappaOrderTrigger` | `on Kappa_Order__c (before insert, after insert, after update)` |
| `KappaOrderUowTrigger` | `on Kappa_Order__c (after insert)` |
| `KappaShipmentTrigger` | `on Kappa_Shipment__c (before insert, after insert)` |
| `VertexBoltItemTrigger` | `on Kappa_Item__c (after insert, after update)` |
| `VertexOrderTrigger` | `on Vertex_Order__c (after update, after insert)` |
| `VtxKwxInvoiceTrigger` | `on kwx__Invoice__c (before insert)` |

Event lists are in **source declaration order** (`triggerCaseText`/parser.js
walks `triggerCase_list()` top to bottom), not alphabetized — note
`VertexOrderTrigger` declares `after update, after insert` in that literal
order in its trigger clause.

#### kind: aura (5, sorted by label)

| label | detail |
|---|---|
| `VertexBoltMulti05.runBeta` | `@AuraEnabled (LWC/Aura)` |
| `VertexBoltSolo01.runDispatch` | `@AuraEnabled (LWC/Aura)` |
| `VertexBoltSolo02.runDispatch` | `@AuraEnabled (LWC/Aura)` |
| `VertexOrderController.bulkRecalculate` | `@AuraEnabled (LWC/Aura)` |
| `VertexOrderController.recalculate` | `@AuraEnabled (LWC/Aura)` |

`VertexBoltMulti05` has 3 methods total (`runAlpha`, `runBeta`, `runGamma`) —
only `runBeta` carries `@AuraEnabled`; the other two are plain public methods
and must NOT appear in the catalog.

#### kind: invocable (2, sorted by label)

| label | detail |
|---|---|
| `VertexBoltSolo03.runDispatch` | `@InvocableMethod (Flow)` |
| `VertexOrderApprovalInvocable.execute` | `@InvocableMethod (Flow)` |

#### kind: async (9, sorted by label)

| label | detail |
|---|---|
| `VertexBoltNightlyRelayJob.execute` | `Schedulable` |
| `VertexBoltSolo04.execute` | `Schedulable` |
| `VertexFollowupBatch.execute` | `Batchable` |
| `VertexFollowupBatch.finish` | `Batchable` |
| `VertexFollowupBatch.start` | `Batchable` |
| `VertexNightlyAdjustmentJob.execute` | `Schedulable` |
| `VertexRepriceBatch.execute` | `Batchable` |
| `VertexRepriceBatch.finish` | `Batchable` |
| `VertexRepriceBatch.start` | `Batchable` |

Ruling: resolver.js's pass C (F5) attaches the `Batchable` label to **all
three** interface methods (`start`/`execute`/`finish`), not just `execute` —
see its own header comment ("Batchable's start()/finish() are entry points
exactly like execute() — the platform invokes the whole 3-method interface").
`VertexFollowupBatch` and `VertexRepriceBatch` therefore contribute 3 async
entries each, not 1. No class in this corpus implements `Queueable`, and no
method carries `@future` — both are 0 in gauntlet-org.

#### kind: flow (1)

| label | detail |
|---|---|
| `Vtx_Namespace_Probe_Flow` | `RecordAfterSave on Vertex_Order__c` |

The file's `<start>` block: `<object>Vertex_Order__c</object>`,
`<recordTriggerType>Update</recordTriggerType>`,
`<triggerType>RecordAfterSave</triggerType>` → record-triggered, so detail is
the direct `<triggerType> on <Object>` form (not the `'screen or
autolaunched'` fallback — see the adv-org MANIFEST addendum below for that
case, which gauntlet-org happens not to exercise since it has only 1 flow).

#### kind: rest / soap / email / platform / anonymous — all 0

Zero hits corpus-wide for `@HttpGet/@HttpPost/@HttpPut/@HttpDelete/@HttpPatch`,
`@RestResource`, `webservice`, `Messaging.InboundEmailHandler`,
`InstallHandler`, `UninstallHandler`, `Messaging.RegistrationHandler` (nor
bare `RegistrationHandler`), `implements Comparable`, `System.Finalizer`, and
there are no `.apex` files in this corpus at all.

### Rulings applied (ambiguities encountered)

1. **`@future`/comment false positives are not entries.** No method in this
   corpus is actually annotated `@future` (confirmed: 0 hits after excluding
   comment-text mentions) — flagged here only because the sibling adv-org
   corpus DOES have a comment-text false positive worth documenting once
   (see MANIFEST ruling #1); gauntlet-org has no such case itself.
2. **Batchable's `start`/`finish` count as async entries**, not just
   `execute` — see the async-kind note above; this doubles-then-triples the
   naive "1 entry per Batchable class" expectation to 3.
3. **Trigger event-list order is source order, not sorted** — see the
   trigger-kind note above (`VertexOrderTrigger`).
4. **No dual-annotation (two different catalog `kind`s on one method) fixture
   exists anywhere in this corpus** — every annotation-bearing method here
   maps to exactly one kind. The C1 contract's dual-annotation rule (one
   entry per matching kind) is exercised only by a synthetic
   `test-resolver.js` unit fixture, not by this ground-truth corpus.
5. **`excludedTestEntries` is 0**, not because there are no `@isTest`
   classes (there are 8), but because none of those 8 test classes declares
   any method carrying an entry annotation — there is nothing to exclude.
   A true test-exclusion fixture (an `@isTest` class with e.g. an
   `@AuraEnabled` method) does not exist in gauntlet-org.

---

## v0.13 subflow chains

Written **before** metascan.js/resolver.js/uitree.js/pathmap.js are touched for
this round — a from-first-principles prediction of what S1 (metascan flow
`<subflows>` extraction) + S2 (resolver `flowGraph`, both-direction subflow
children, entry-catalog suffix) must produce, for the examiner to diff against
a live run. `parser.js` is untouched by this round (frozen); nothing below
depends on any parser change.

### Corpus additions

7 new `.flow-meta.xml` files + 4 new `.cls` files (+ 4 `.cls-meta.xml`
sidecars), all under `force-app/main/default/{flows,classes}`. No object
metadata added (`Vertex_Widget__c` is a bare token in Apex source only, same
convention as every other `__c` name in this corpus — see §1).

| File | Role |
|---|---|
| `classes/VtxFlowWidgetDmlSource.cls` | `createWidget` — DML launcher (`insert Vertex_Widget__c`, op=insert, L18). `logWidgetCreated` — the parent flow's own direct apex action (L21), present only so that flow has ≥1 apex `actionCalls` block of its own (see note below). |
| `classes/VtxFlowWidgetNotifier.cls` | `notifyTeam` (L8) — the SUBFLOW's own apex action; the req-1/req-4 anchor. |
| `flows/Vtx_WidgetLifecycleFlow.flow-meta.xml` | **Parent.** Record-triggered (`Create` on `Vertex_Widget__c`). `<start>` → apex `Log_Widget_Created` → subflow `Notify_Widget_Team` (→ `Vtx_WidgetLifecycleNotifySubflow`, real file) → subflow `Call_Ghost_Followup` (→ `Vtx_Nonexistent_Ghost_Flow`, **no such file** — the unknown-subflow-ref negative). |
| `flows/Vtx_WidgetLifecycleNotifySubflow.flow-meta.xml` | **Child/subflow**, own apex action `Send_Widget_Notification` → `notifyTeam`. No `<object>`/trigger info of its own — reached only as a subflow. |
| `classes/VtxFlowChainRelay.cls` | `relayMid` (L9), `relayLeaf` (L13) — chain anchors. |
| `flows/Vtx_FlowChainTop.flow-meta.xml` | Depth-1 of the 3-deep chain. **Deliberately apex-less** — `<start>` → subflow `Call_Chain_Mid` only, zero `<actionCalls>` anywhere in the file. See "load-bearing stress case" below. |
| `flows/Vtx_FlowChainMid.flow-meta.xml` | Depth-2. `<start>` → apex `Relay_Mid_Action` (`relayMid`) → subflow `Call_Chain_Leaf` (→ Leaf). |
| `flows/Vtx_FlowChainLeaf.flow-meta.xml` | Depth-3, terminal. `<start>` → apex `Relay_Leaf_Action` (`relayLeaf`). |
| `classes/VtxFlowCycleHelper.cls` | `pingA` (L8), `pingB` (L12) — cycle anchors. |
| `flows/Vtx_FlowCycleA.flow-meta.xml` | `<start>` → apex `Ping_A_Action` (`pingA`) → subflow `Call_Cycle_B` → `Vtx_FlowCycleB`. |
| `flows/Vtx_FlowCycleB.flow-meta.xml` | `<start>` → apex `Ping_B_Action` (`pingB`) → subflow `Call_Cycle_A` → `Vtx_FlowCycleA` — **closes the mutual cycle** (A's `<subflows>` names B, B's names A). |

**Nested-element tolerance**: `Vtx_WidgetLifecycleFlow`'s `Notify_Widget_Team`
and `Vtx_FlowChainMid`'s `Call_Chain_Leaf` `<subflows>` blocks both carry a
`<connector>` AND an `<inputAssignments>` sibling around `<flowName>` (real
Salesforce element order: `name, label, locationX, locationY, connector,
flowName, inputAssignments` — same shape adv-org's pre-existing
`AcmeBackorderResolutionFlow → AcmeNotifyCustomerSubflow` reference already
uses, see that corpus's MANIFEST.md). `Vtx_FlowCycleA`/`B`'s `<subflows>`
blocks have no `inputAssignments` at all (bare `name/label/locationX/locationY
/flowName`) and `Vtx_FlowChainTop`'s has a trailing `<connector>` only absent
(it's the file's last/only element). Between the three shapes, every
"how much else is inside the `<subflows>` block" variant this corpus's other
`<subflows>` reference (adv-org) doesn't already cover is now exercised.
`[MUST]` — the regex/extraction must find `<flowName>` regardless of which of
these shapes surrounds it.

**Load-bearing stress case — `Vtx_FlowChainTop` has ZERO apex actionCalls.**
Verified live (read-only, pre-v0.13 `metascan.parseMetaFile`):
`Vtx_WidgetLifecycleFlow`/`Vtx_FlowChainMid`/`Vtx_FlowChainLeaf`/`Vtx_FlowCycleA`
/`Vtx_FlowCycleB` each already produce exactly 1 `MetaRef` today (their own
apex `actionCalls`), but **`Vtx_FlowChainTop` produces zero** — today's
`extractFlow` only ever pushes a ref per `<actionCalls><actionType>apex</...>`
match, so a flow with none gets no `MetaRef` at all, on any version. If S1's
`subflows` field is attached only onto per-ref objects (mirroring
`flowObject`/`flowRecordTriggerType`'s existing per-ref convention literally),
`Vtx_FlowChainTop`'s outgoing subflow-to-Mid reference has nowhere to attach
and is silently lost — `flowGraph` would be missing the `vtx_flowchaintop ->
vtx_flowchainmid` edge entirely, and the 3-deep-chain trace below would only
ever show 2 levels. Per the GOAL text ("every `<subflows>`...element in
`*.flow-meta.xml`" — not "every subflows element attached to an existing
ref") and the precedent that `index.flowFilePaths` already exists specifically
to give every known flow file entry-catalog identity independent of ref count
(see `collectFlowEntries`'s file-driven fallback loop, resolver.js ~L5725 —
this is exactly how `AcmeNotifyCustomerSubflow`, which also has zero apex
refs, gets an entry today), the expected/intended fix scans every known
`.flow-meta.xml` file for `<subflows>` blocks independent of whether that file
produced any apex ref — same file-driven pattern, not the per-ref pattern.
`[MUST]` this edge exists; **a live run showing it missing is a strong signal
S1 took the per-ref-only shortcut, not a "corpus fixture is invalid"
situation.**

### `flowGraph` — expected `Map<flowLower, {parents, children}>` entries

| flow (lowercased key) | `parents` | `children` |
|---|---|---|
| `vtx_widgetlifecycleflow` | `[]` | `['vtx_widgetlifecyclenotifysubflow']` (NOT `vtx_nonexistent_ghost_flow` — see stats below) |
| `vtx_widgetlifecyclenotifysubflow` | `['vtx_widgetlifecycleflow']` | `[]` |
| `vtx_flowchaintop` | `[]` | `['vtx_flowchainmid']` |
| `vtx_flowchainmid` | `['vtx_flowchaintop']` | `['vtx_flowchainleaf']` |
| `vtx_flowchainleaf` | `['vtx_flowchainmid']` | `[]` |
| `vtx_flowcyclea` | `['vtx_flowcycleb']` | `['vtx_flowcycleb']` |
| `vtx_flowcycleb` | `['vtx_flowcyclea']` | `['vtx_flowcyclea']` |
| `vtx_namespace_probe_flow` (pre-existing) | `[]` | `[]` (unchanged — no `<subflows>` element anywhere in that file) |

`vtx_flowcyclea`/`vtx_flowcycleb` each list the OTHER as both parent and
child, correctly, since A→subflow→B and B→subflow→A simultaneously. `[MUST]`
for every row.

### `stats.unknownSubflowRefs`

Exactly **1** for this round's additions: `Vtx_WidgetLifecycleFlow`'s
`Call_Ghost_Followup` element names `Vtx_Nonexistent_Ghost_Flow`, which
matches no flow file stem (case-insensitive) anywhere in gauntlet-org.
`[MUST]`:
- The reference is **counted**, exactly once.
- **No node is fabricated** — `flowGraph` has no `vtx_nonexistent_ghost_flow`
  key at all (not an empty-children stub, not anything), and no live trace
  ever shows a node with that label.
- `vtx_widgetlifecycleflow`'s `children` array in the table above has exactly
  1 entry (the real subflow), not 2 — the ghost reference contributes to the
  stat and nothing else.
- No other flow file in this round's additions or the pre-existing corpus
  contains an unresolvable `<flowName>`, so the workspace-wide count
  contributed by v0.13 is exactly 1 (whatever gauntlet-org's baseline was
  before this round — 0, since no `<subflows>` element existed anywhere in
  the corpus pre-v0.13 — the total after this round is also exactly 1).

### Caller-direction ground truth (`buildCallerTree`)

Convention reminder (per README's own documented tree shape): a node's
`children` = **that node's callers** — walking a caller-tree away from the
target, toward entry points. A flow node's children were, pre-v0.13, either
`[]` (plain/subflow-only flow) or its DML/publish fan-out (F1(b)/G1(b), for a
record/platform-triggered flow only) — never anything subflow-related. v0.13
adds: a flow node's children also include **its own PARENT flows**, via
`subflow`, `approximate:false` (a declared reference, not a fan-out guess) —
alongside (not replacing) any pre-existing DML/publish children, which stay
attached to whichever flow owns the `<start>` block that produced them.

#### Target: `VtxFlowWidgetNotifier.notifyTeam` (req-1: apex ← subflow ← parent flow ← launcher)

```
VtxFlowWidgetNotifier.notifyTeam
  Vtx_WidgetLifecycleNotifySubflow          [flow · metadata]           -- pre-existing (flow calls apex action)
    Vtx_WidgetLifecycleFlow                 [flow · subflow]           -- NEW v0.13 edge (parent invokes this subflow)
      VtxFlowWidgetDmlSource.createWidget   [dml · op=insert]          -- pre-existing F1(b)/A1 DML->flow-children mechanism, now reachable one hop deeper thanks to the subflow edge
```
`[MUST]`, node-by-node:
1. `Vtx_WidgetLifecycleNotifySubflow` — kind=flow, via=metadata, site line 26 (`<actionName>VtxFlowWidgetNotifier.notifyTeam</actionName>`). Pre-existing behavior, unaffected.
2. `Vtx_WidgetLifecycleFlow` — kind=flow, via=**subflow**, approximate=false. This is the edge this whole round exists to add.
3. `VtxFlowWidgetDmlSource.createWidget` — via=dml, op=insert, site line 18. Pre-existing F1(b) mechanism; the only thing new is that it's now nested one level deeper (under node 2) instead of unreachable, since node 2 itself was previously never a node in this particular tree at all.

#### Target: `VtxFlowChainRelay.relayLeaf` (req-2: 3-deep chain)

```
VtxFlowChainRelay.relayLeaf
  Vtx_FlowChainLeaf     [flow · metadata]
    Vtx_FlowChainMid    [flow · subflow]
      Vtx_FlowChainTop  [flow · subflow]   -- terminal: Top has no parent (nobody subflows Top)
```
`[MUST]`. Also: `VtxFlowChainRelay.relayMid`'s own caller-tree is 2-deep
(`Vtx_FlowChainMid [metadata] → Vtx_FlowChainTop [subflow]`, terminal) — a
useful cross-check that the chain isn't hardcoded to exactly 3 but genuinely
recurses per-node.

#### Target: `VtxFlowCycleHelper.pingA` (req-3: mutual cycle, must not hang)

```
VtxFlowCycleHelper.pingA
  Vtx_FlowCycleA           [flow · metadata]
    Vtx_FlowCycleB         [flow · subflow]
      Vtx_FlowCycleA       [flow · subflow · cyclic:true]   -- STOP here, no children
```
`[MUST]`:
- The 3rd-row `Vtx_FlowCycleA` occurrence carries `cyclic: true` (same
  `ancestorPath`/`'flow:'+lower` mechanism the GOAL text specifies, mirroring
  the pre-existing pure-Apex and DML-induced cycle fixtures elsewhere in this
  engine's test history — adv-org's `AcmeShipmentTrigger` DML-cycle is the
  closest precedent).
- It has **zero children** — recursion stops the instant the ancestor-path
  key repeats, it does not run one more hop first.
- Tracing `VtxFlowCycleHelper.pingB` produces the exact mirror image, starting
  with `Vtx_FlowCycleB`.
- Neither trace ever hangs, times out, or exceeds `maxNodes`/`maxDepth` for
  this reason alone — the cycle is 2 flow-nodes wide, trivially inside any
  reasonable depth cap.

### Callee-direction ground truth (`buildCalleeTree`) — req-4

#### Target: `VtxFlowWidgetDmlSource.createWidget` (DML → parent flow → subflow → subflow's apex action)

```
VtxFlowWidgetDmlSource.createWidget
  Vtx_WidgetLifecycleFlow                 [flow · via=dml]     -- pre-existing A1 fan-out; PRE-v0.13 this node was hardcoded children:[]/truncated:true (see makeCalleeFlowNode)
    Vtx_WidgetLifecycleNotifySubflow      [flow · via=subflow] -- NEW v0.13: makeCalleeFlowNode's children are no longer forced empty; this flow's own <subflows> list is now walked forward
      VtxFlowWidgetNotifier.notifyTeam    [ordinary apex node] -- the subflow's own apex action, forward-visible for the first time
```
`[MUST]` for rows 1–2 (the subflow edge itself, in the forward direction, is
this round's headline deliverable) and row 3 (per the GOAL text verbatim:
"each subflow expanding to its own apex actions/DML/subflows").

**`[SPEC-OPEN]` — does `Vtx_WidgetLifecycleFlow` (row 1, the flow reached via
`dml`, NOT itself a subflow) ALSO forward-expose its own direct apex action
(`Log_Widget_Created` → `VtxFlowWidgetDmlSource.logWidgetCreated`) as a
sibling of row 2?** The GOAL text says "a flow node's children now also
include its SUBFLOWS... each subflow expanding to its own apex
actions/DML/subflows" — literally, that sentence only promises apex-action
expansion for a node reached via being *a subflow*. Whether the SAME
flow-node-expansion function is applied uniformly to every flow node in a
callee tree (including the DML-root one) or whether the DML-root case keeps
its historical "apex actions still invisible forward, only subflows newly
visible" partial-dead-end is not decided by the GOAL text. Both are
plausible/self-consistent implementations. **Examiner: record which one the
live engine does — it is not a BUG either way**, but a future round should
either (a) update this ground truth to assert the uniform reading as `[MUST]`
once observed, or (b) document the asymmetry explicitly in README's Limits
section if it's intentional. `logWidgetCreated` exists in this corpus
specifically to make this observable either way (see "Corpus additions"
table).

### Entry catalog delta (v0.13)

7 new flow entries (gauntlet-org's `kind: flow` count goes from 1 to 8).
Detail strings, applying the pre-existing fallback/record-triggered rules
from the v0.12 section above, PLUS the new v0.13 suffix rule ("flows that are
ONLY ever referenced as subflows of other flows — no `<start>` trigger info
AND at least one parent — get detail suffix `subflow of <parent>`,
additive-only, counts unchanged"):

| label | detail (v0.13) | why |
|---|---|---|
| `Vtx_WidgetLifecycleFlow` | `RecordAfterSave on Vertex_Widget__c` | record-triggered — has its own `<start>` trigger info, so the subflow-suffix rule never applies regardless of parents (it also happens to have zero parents). |
| `Vtx_WidgetLifecycleNotifySubflow` | `screen or autolaunched (subflow of Vtx_WidgetLifecycleFlow)` | plain `<start>` (fallback shape) + exactly 1 parent → suffix applies. |
| `Vtx_FlowChainTop` | `screen or autolaunched` | plain `<start>` but ZERO parents (nobody subflows Top) → no suffix, unchanged fallback. |
| `Vtx_FlowChainMid` | `screen or autolaunched (subflow of Vtx_FlowChainTop)` | plain `<start>` + 1 parent (Top). |
| `Vtx_FlowChainLeaf` | `screen or autolaunched (subflow of Vtx_FlowChainMid)` | plain `<start>` + 1 parent (Mid). |
| `Vtx_FlowCycleA` | `screen or autolaunched (subflow of Vtx_FlowCycleB)` | plain `<start>` + 1 parent (B) — the cycle doesn't confuse the suffix; it only ever names ITS OWN direct parent(s), never walks the cycle. |
| `Vtx_FlowCycleB` | `screen or autolaunched (subflow of Vtx_FlowCycleA)` | mirror of A. |

`[MUST]` for the record-triggered/no-parent/one-parent rows above (5 of 7
distinct shapes: record-triggered-no-suffix, fallback-no-parent-no-suffix,
fallback-one-parent-suffixed — the cycle pair is 2 more instances of the last
shape, deliberately chosen to prove the suffix doesn't try to be cycle-aware).

**Not covered by this corpus** (documented gap, not a defect if unresolved):
no flow in either corpus has >1 parent (>1 different flow subflows it), so
the suffix's format for multiple parents (`subflow of X, Y`? `subflow of X
(+N more)`? first-seen only?) is unspecified by the GOAL text and untested
here.

`stats.flow` count in the entry catalog moves from 1 → 8; every other
`ENTRY_KIND_ORDER` kind (`trigger`/`aura`/`invocable`/`rest`/`soap`/`async`/
`email`/`platform`/`anonymous`) is untouched by this round's additions — all
4 new classes are plain, unannotated, non-`@isTest` classes with no
trigger/async/REST/etc. surface, so they contribute 0 entries of any other
kind. `excludedTestEntries` stays 0 (none of the 4 new classes is `@isTest`).

### Regression note

Every fixture in this section is additive under brand-new labels
(`Vtx_Widget*`, `Vtx_FlowChain*`, `Vtx_FlowCycle*`, `VtxFlow*`) that collide
with nothing pre-existing in gauntlet-org (checked: no prior `Widget`/
`VtxFlowChain*`/`VtxFlowCycle*` token anywhere in the corpus; the pre-existing,
unrelated `VtxChainCycleNodeA/B`/`VtxChainCycleCaller` fluent-chain
return-type-cycle fixture from v0.10-A uses the disjoint `VtxChainCycle*`
prefix and is untouched). No existing target's caller/callee tree, tally, or
entry is expected to change: `Vtx_Namespace_Probe_Flow` has no `<subflows>`
element and gains no edges; no pre-existing DML site targets
`Vertex_Widget__c`; no pre-existing class is named
`VtxFlowWidgetDmlSource`/`VtxFlowWidgetNotifier`/`VtxFlowChainRelay`/
`VtxFlowCycleHelper`.

## v0.13 hardening

Written **before** resolver.js/extension.js are touched for Round 2.5 (H1–H8) —
a from-first-principles prediction of the corpus-visible outcomes of the H1
unique-name magnet fix, the H2 approximate-rollup grouping, and the H3 scoped
caller-direction header. `parser.js` and `metascan.js` are untouched by this
round (frozen); every fact below was produced by the REAL, unmodified
`parser.js`/`metascan.js` (verified live — see "Corpus additions" note) and is
otherwise a prediction of what the H1–H3 resolver changes must do with those
facts. H4–H8 (cancellation, single-flight, watcher dirty-set, parallel cold
parse, diagnostics) are engine/extension-host behaviors with no corpus-visible
surface and are **not** covered by this ground-truth document.

### Corpus additions

21 new `.cls` files (+ 21 matching `.cls-meta.xml` sidecars) + 1 new LWC
bundle (`vertexBindPanel/` — `.js` + `.js-meta.xml` + `.html`), all under
`force-app/main/default/{classes,lwc}`. No object metadata added (every new
`__c`-free; this round introduces no new SObject tokens at all). **45 files on
disk total.** Every new `.cls` file was parsed live with the real
`parser.js` (`require('./parser.js').parseFile`)
and confirmed `parseError == null` for all 21; the new LWC's `.js` was parsed
live with the real `metascan.js` (`parseMetaFile`) and confirmed to extract
exactly one `MetaRef` (`{ kind:'lwc', className:'VertexBindTarget',
methodName:'bind', namespace:null }`), same convention as the pre-existing
`kappaGatewayPanel` fixture.

| File | Role |
|---|---|
| `classes/VertexBindInfo.cls` | Plain data class, the `bind` target's sole param type. |
| `classes/VertexOpInfo.cls` | Plain data class, the `bind` target's return type. |
| `classes/VertexBindTarget.cls` | **H1 magnet target.** `public static VertexOpInfo bind(VertexBindInfo info)` — the ONLY local declarer of `bind` workspace-wide, one declared overload, arity 1. |
| `classes/VertexBindTargetTest.cls` | `@isTest` — **confirmed caller #1**: `VertexBindTarget.bind(info)`, a typed static call (`info` declared `VertexBindInfo`), resolved via the ordinary `static` rule, NOT the unique-name fallback. |
| `lwc/vertexBindPanel/vertexBindPanel.js` | **confirmed caller #2**: `import bind from '@salesforce/apex/VertexBindTarget.bind';`, a 2-segment (unnamespaced) LWC Apex import. |
| `classes/VertexWorkflowEngine.cls` … `classes/VertexGatewayRouter.cls` (10 files, listed below) | Framework-style dispatcher/engine/registry classes, each with 4 methods, each calling `.bind(...)` on an unresolvable receiver — **40 sites total**, mixed arity (see matrix below). None of these 10 classes declares its own `bind` method or has any type relationship to `VertexBindTarget`. |
| `classes/VertexNoticeRelay.cls` | **H1 control target.** `public static void relayNotice(String message)` — the ONLY local declarer of `relayNotice`, one declared overload, arity 1. |
| `classes/VertexNoticeRelayCallerA.cls`, `classes/VertexNoticeRelayCallerB.cls` | Exactly 2 unresolvable-receiver call sites to `relayNotice(...)`, both arity 1 (matching the control target's one overload) — under `UNIQUE_NAME_MAX`, both MUST still attach via `unique-name`. |
| `classes/VertexEnterpriseOrderFulfillmentReconciliationOrchestratorService.cls` (65 chars), `classes/VertexCrossRegionInventoryAvailabilitySynchronizationCoordinator.cls` (64 chars), `classes/VertexThirdPartyLogisticsProviderIntegrationAdapterFactoryImpl.cls` (62 chars), `classes/VertexThirdPartyLogisticsProviderIntegrationAdapterImplementation.cls` (65 chars) | **H2/map long-names fixture.** A 4-class, 3-hop chain (`…OrchestratorService.reconcileFulfillmentDiscrepanciesAcrossAllDistributionCenters` → `…Coordinator.synchronizeInventoryAvailabilitySnapshotsForDistributionRegion` → `…FactoryImpl.createAdapterInstanceForCarrierAccountIntegrationConfiguration` [static] + `…Implementation.buildCarrierAccountIntegrationConfigurationForRegionalPartner` [instance, on the constructed adapter]) with every class name AND every method name ≥ 60 characters, realistic enterprise-style CamelCase. Purely a path-map / tree-label rendering probe — **no caller/callee-tree expectation is asserted for this fixture beyond "renders without truncation/overflow errors and every edge above resolves normally (typed/static/new, all confirmed, zero approximate)"**; the UI layer's own tests own any pixel/layout assertions. |

No pre-existing file was modified. Every new identifier
(`VertexBindTarget`/`VertexBindInfo`/`VertexOpInfo`/`VertexBindTargetTest`/
`VertexNoticeRelay`/`VertexNoticeRelayCallerA`/`VertexNoticeRelayCallerB`/
`VertexWorkflowEngine`/`VertexRuleEvaluator`/`VertexEventDispatcher`/
`VertexTaskRunner`/`VertexPluginHost`/`VertexActionBroker`/
`VertexHookManager`/`VertexMiddlewareChain`/`VertexAdapterRegistry`/
`VertexGatewayRouter`/the 4 long-name classes/`vertexBindPanel`) is checked
disjoint from every pre-existing token in the corpus (grepped: `bind`,
`relayNotice`, `noticerelay` all previously absent as method/class names;
`bind` previously appeared only as a substring of the pre-existing
`serviceBindings` field name in `VertexApplication.cls`, never as a called
method).

### H1 — unique-name magnet matrix (`VertexBindTarget.bind`)

**Confirmed callers (exactly 2, both `[MUST]`, neither approximate):**

| # | Caller | via | site |
|---|---|---|---|
| 1 | `VertexBindTargetTest.testBindReturnsOpInfo` | `static` | `VertexBindTarget.bind(info)`, arity 1 |
| 2 | `vertexBindPanel` (LWC) | `lwc` | `@salesforce/apex/VertexBindTarget.bind` |

**40 unresolvable-receiver `.bind(...)` sites across the 10 caller classes**
(4 methods × 10 classes; every site's receiver is either a bare `Object`-typed
local/field, a chained call off one, or a `Type.newInstance()`-produced
`Object` — none resolvable to any class):

| Class | Method | Receiver shape | Arity | Pre-H1 (today) | Post-H1 |
|---|---|---|---|---|---|
| each of the 10 (`VertexWorkflowEngine` … `VertexGatewayRouter`) | 1st method (`…StageOne`/`…FirstPass`/`…Created`/`…QueuedTask`/`…StageOne`/`…FirstAction`/`…BeforeHook`/`…FirstLink`/`…FirstAdapter`/`…FirstHop`) | bare `Object` local (`handler.bind(payload)`) | 1 | attaches via `unique-name` (today's bug: no arity gate, no cap) | **arity-matches** (candidate's one overload is arity 1) → counted toward the cap |
| same 10 | 2nd method (`…StageTwo`/`…SecondPass`/`…Updated`/`…ChainedTask`/`…StageTwo`/`…ChainedAction`/`…AfterHook`/`…ChainedLink`/`…ChainedAdapter`/`…ChainedHop`) | chained unknown (`handler.getDelegate().bind(payload)`) | 1 | attaches via `unique-name` | **arity-matches** → counted toward the cap |
| same 10 | 3rd method (`…StageThree`/`…DynamicRule`/`…DynamicEvent`/`…DynamicTask`/`…Dynamically`/`…DynamicAction`/`…DynamicHook`/`…DynamicLink`/`…DynamicAdapter`/`…DynamicHop`) | `Type`-typed var, non-literal `Type.forName` → `Object inst = dynType.newInstance(); inst.bind(payload);` | 1 | attaches via `unique-name` | **arity-matches** → counted toward the cap |
| same 10 | 4th method (`…StageFour`/`…WithContext`/`…WithEnvelope`/`…WithOptions`/`…WithManifest`/`…WithMeta`/`…WithPayload`/`…WithContext`/`…WithConfig`/`…WithMeta`) | bare `Object` local, 2-arg call (`handler.bind(payload, metadata)`) | 2 | attaches via `unique-name` (today's bug: arity is ignored entirely) | **arity gate FAILS** (candidate's only declared overload is arity 1) → never a unique-name candidate, stays unresolved for an ordinary unresolved-receiver reason, independent of the cap |

Tally: 30 arity-matching (1-arg) sites + 10 arity-mismatching (2-arg) sites =
**40 total**, verified live against the real (H1-unaware) `parser.js` call
facts (`argTexts.length`) — 30/10/0-other, exactly as designed.

`[MUST]` post-H1 outcome: the 30 arity-matching sites, taken together, exceed
`UNIQUE_NAME_MAX` (5) for the single target `VertexBindTarget.bind` — per the
GOAL text's attachment-cap rule, **NONE** of the 30 attach (not "the first 5"
or "a sample" — the cap is all-or-nothing per target). All 30 return to the
unresolved bucket with reason `name-too-common`. The 10 arity-mismatching
sites were never cap-eligible in the first place (reason stays whatever the
engine's ordinary unresolved-receiver reason is, e.g. `unknown-receiver` —
this corpus does not distinguish the two unresolved reasons any further than
"neither becomes an edge").

**`VertexBindTarget.bind` caller tree, post-H1 (`[MUST]`):**
- Exactly 2 children: the `static` test call and the `lwc` import. Zero
  `unique-name` children. Zero approximate children of any kind.
- A live run showing any of the 40 magnet sites attached as a caller
  (anywhere in the tree, at any depth) is a **BUG** — this is the flagship
  regression this whole fixture exists to catch.

### H1 — control target (`VertexNoticeRelay.relayNotice`)

**`VertexNoticeRelay.relayNotice` caller tree, post-H1 (`[MUST]`):**
- Exactly 2 children, both `via=unique-name, ~` (approximate):
  `VertexNoticeRelayCallerA.sendFirstNotice` (receiver: bare `Object` field
  `notifier`) and `VertexNoticeRelayCallerB.sendSecondNotice` (receiver:
  chained `resolveDelegate()`). Both sites are arity 1, matching the
  target's one declared overload.
- 2 ≤ `UNIQUE_NAME_MAX` (5): the cap does **not** suppress these. The
  fallback must still fire at small scale — a live run showing either site
  unresolved (or both suppressed as `name-too-common`) is a **BUG**: it
  would mean the cap fired on a count that shouldn't trigger it, i.e. an
  off-by-one or `>=` vs `>` defect in the cap comparison.

### H2 — approximate rollup, worked example (`VertexPricingService.reprice`, caller tree)

Reuses pre-existing **Target 1** (§3) rather than a new fixture — its shape
(16 confirmed callers + exactly 1 approximate caller) is already the cleanest
mixed case in the corpus, and the regression-policy proof
("flatten(rollup children) + confirmed == old child set") is checkable
directly against the pre-v0.13-hardening §3 table with zero new files.

Pre-H2 (today, per §3 Target 1 table): 17 flat children, in order #1–#17,
one of which (#10, `VertexRepriceableDispatcher.dispatch`, `via=interface, ~`)
is approximate.

Post-H2, with `apexCallGraph.showUnconfirmed` at its default (`'rollup'`)
(`[MUST]`):
- 16 children render exactly as today, in the same relative order, as plain
  (non-rollup) nodes — #1–#9 and #11–#17 from the §3 table, unchanged.
- The 1 approximate child (#10) is **not** a direct child of the target
  anymore. Instead the target gains one additional pseudo-child, `kind:
  'rollup'`, label `1 possible caller (unconfirmed)`, `collapsibleState:
  collapsed`, whose own one child is `VertexRepriceableDispatcher.dispatch`
  (same `via=interface, ~`, same file:line, same "also fans to sibling
  target `VertexPremiumPricingService.reprice`" annotation as today —
  rollup grouping changes WHERE the node renders, not what it carries).
- Total node count at this level is therefore 17 (16 plain + 1 rollup), not
  18 — the rollup node itself doesn't inflate the count of "real" callers,
  it just re-parents the approximate one(s).
- Regression proof: `flatten(rollup.children) ∪ {16 plain children}` is
  set-equal to the pre-H2 17-child set from §3 Target 1 — this must hold
  exactly (no edge gained, none lost, only regrouped).
- With `apexCallGraph.showUnconfirmed: 'hide'`: the rollup node itself is
  omitted entirely — 16 visible children, not 17.
- With `apexCallGraph.showUnconfirmed: 'expand'`: identical to the pre-H2
  (today's) flat 17-child shape — this is the explicit backward-compat
  escape hatch and must reproduce §3 Target 1 byte-for-byte.
- `VertexPremiumPricingService.reprice`'s own OWN caller-tree node (its
  override fan-out re-listing every base-method caller, per the §3
  "Ancestor placement note") is a structurally separate subtree and is
  expected to apply the identical rollup treatment independently wherever
  it, too, has approximate children — not asserted further here since §3
  doesn't table that subtree's own children explicitly.

The magnet target itself (`VertexBindTarget.bind`) is a degenerate rollup
case worth naming explicitly: since H1 suppresses all 40 would-be
`unique-name` children before H2 ever runs, H2 has **zero** approximate
children to group for this target — no rollup pseudo-node appears at all
(not even an empty one). A live run showing a `0 possible callers` rollup
node here would be a minor but real defect (empty rollups should never
render) — worth a spot-check even though the GOAL text doesn't call it out
explicitly.

### H3 — scoped caller-direction header (`VertexBindTarget.bind`)

`[MUST]`: the caller-direction trace header for `VertexBindTarget.bind`
gains the line

> 40 unresolved sites elsewhere mention bind( — potential unconfirmed callers

`K = 40` — arity-agnostic, so it counts BOTH the 30 cap-suppressed
(`name-too-common`) sites AND the 10 arity-gate-failed sites, all of which
are, post-H1, sites in the unresolved bookkeeping whose called name is
`bind`. This is exactly the corpus's central point: a magnet name doesn't
just fail to attach false edges anymore, its true unresolved scale (40) is
still surfaced to the user as an honest "here's how much unconfirmed noise
exists" signal, distinct from the (now-clean) 2-caller confirmed tree above
it.

The K info node, if present/expanded, lists exactly those 40 sites (10
classes × 4 methods, `Class.method:line` per row); collapsing/expanding it
is cosmetic and not asserted further here.

**Contrast — `VertexNoticeRelay.relayNotice` header (`[MUST]`):** gains NO
such header line. Both of its 2 unresolvable-receiver sites attached via
`unique-name` (H1 control, above), so post-H1 there are zero *unresolved*
sites named `relayNotice` anywhere in the workspace — `K = 0`, and per the
GOAL text's "only when > 0" rule the line is omitted entirely, not rendered
with `K = 0`.

### Non-edge appendix additions (extends §4)

- None of the 40 magnet `.bind(...)` sites (10 caller classes) may ever
  appear as a child of `VertexBindTarget.bind`'s caller tree, at any depth,
  under any `apexCallGraph.showUnconfirmed` setting (even `'expand'` shows
  them only if the engine's H1 cap actually suppressed them — since it
  does, `'expand'` here has nothing approximate left to show for this
  target; contrast with Target 1's `'expand'` case above, where the single
  approximate edge genuinely still exists and `'expand'` reveals it).
- The 10 magnet caller classes' OWN 4 methods each are never confused with
  each other's sites — every site is independently arity-tagged and the
  30/10 split is exact (verified live against `parser.js`, not asserted
  blind).
- `VertexBindTarget`/`VertexOpInfo`/`VertexBindInfo` share no name, prefix,
  or type relationship with any pre-existing Cluster A–E class — no
  pre-existing target's tree is expected to gain or lose any edge because
  of this round's additions.

### File count addendum (extends §5, v0.8-D, v0.10-D, v0.11-C)

**63 (baseline) + 10 (v0.8) + 4 (v0.10) + 7 (v0.11) = 84 files before this
round.** This round adds **45 files** (21 `.cls` + 21 `.cls-meta.xml` + 3 LWC
bundle files) → **129 files on disk total** in `force-app/` after v0.13
hardening. (The pre-existing "Entry catalog"/"v0.13 subflow chains" rounds
already covered separately in the sections above this one add their own
files on top of this same running total; this addendum only accounts for
the H1/H2 magnet-and-long-names fixtures introduced in THIS section, to
avoid double-counting against the subflow-chains addendum already present
earlier in the document.)

### Regression note

Every fixture in this section is additive under brand-new identifiers
(`VertexBindTarget`/`VertexBindInfo`/`VertexOpInfo`/`VertexBindTargetTest`/
`VertexNoticeRelay`/`VertexNoticeRelayCallerA/B`/`VertexWorkflowEngine`/
`VertexRuleEvaluator`/`VertexEventDispatcher`/`VertexTaskRunner`/
`VertexPluginHost`/`VertexActionBroker`/`VertexHookManager`/
`VertexMiddlewareChain`/`VertexAdapterRegistry`/`VertexGatewayRouter`/the 4
long-name classes/`vertexBindPanel`) that collide with nothing pre-existing
in gauntlet-org (checked exhaustively — see "Corpus additions" note above).
No existing target's caller/callee tree, tally, or entry is expected to
change **except** Target 1 (`VertexPricingService.reprice`)'s caller-tree
**rendering** (H2 rollup regrouping only — the underlying 17-edge set is
byte-for-byte unchanged, see the flatten-equality proof above) and the two
targets this section itself introduces. Every other target in §3/v0.8/v0.10/
v0.11/v0.12/v0.13-subflow-chains is expected to be completely unaffected by
H1's arity gate and attachment cap, because no pre-existing target in this
corpus was ever a magnet in the first place (the corpus's only other
unique-name fallback usage prior to this round, if any, would already have
been under the 5-site cap — none is documented as exceeding it in §3/§4).

---

## Impact Analysis (v0.14)

Hand-derived expected reports for the v0.14 signature-change lens. Every
identifier below belongs to this fictional corpus. The five targets cover the
four-overload classifier, interface/base/override contracts, a parent-Flow
chain, LWC + Visualforce metadata, an overload with zero exact callers, and an
unused private method.

### Corpus additions

- 11 Apex files (+11 ordinary `.cls-meta.xml` sidecars):
  `VertexImpactContract`, `VertexImpactBase`, `VertexImpactService`,
  `VertexImpactChild`, the exact/tie/fallback/interface/base callers,
  `VertexImpactAction`, and `VertexImpactController`.
- `VertexImpactService.change` has four one-argument overloads, declared in
  this order: `String`, `Integer`, `Boolean`, `Decimal`. `unusedPrivate()` is
  deliberately never called.
- `Vtx_ImpactChildFlow` invokes the sole `@InvocableMethod`
  `VertexImpactAction.run`; `Vtx_ImpactParentFlow` invokes that child as a
  subflow.
- `vertexImpactPanel` imports `VertexImpactController.refresh`; the
  `VtxImpactPage` Visualforce page binds the same method as its page action.

All 277 Apex files in the expanded corpus parse with `parseError == null`.
The additions use new `VertexImpact*` / `Vtx_Impact*` identifiers and do not
change any pre-v0.14 edge.

### Overload choice (`[MUST]`)

Asking for `VertexImpactService.change` without an `overloadSig` returns
`needsOverloadChoice: true` and these signatures, in declaration order:

1. `change(String)`
2. `change(Integer)`
3. `change(Boolean)`
4. `change(Decimal)`

### Target 1 — `VertexImpactService.change(String)` (`[MUST]`)

#### BREAKS (2)

| caller | source | via | overloadPick |
|---|---|---|---|
| `VertexImpactChild.change` | `VertexImpactChild.cls:3` | `super` | `exact` |
| `VertexImpactExactCaller.changeString` | `VertexImpactExactCaller.cls:4` | `typed` | `exact` |

#### MIGHT BREAK (4)

| caller | source | via | overloadPick | why uncertain |
|---|---|---|---|---|
| `VertexImpactBaseCaller.changeThroughBase` | `VertexImpactBaseCaller.cls:3` | `override` | `exact` | runtime override dispatch |
| `VertexImpactFallbackCaller.changeWithExtraContext` | `VertexImpactFallbackCaller.cls:4` | `typed` | `fallback` | no matching two-argument declaration |
| `VertexImpactInterfaceCaller.changeThroughContract` | `VertexImpactInterfaceCaller.cls:3` | `interface` | `exact` | runtime interface dispatch |
| `VertexImpactTieCaller.changeUnknown` | `VertexImpactTieCaller.cls:4` | `typed` | `arity-tie` | `null` scores all four one-argument overloads equally |

#### CONTRACT (3 surfaces)

- Interface: `VertexImpactContract.change(String)` at
  `VertexImpactContract.cls:2`; its one physical caller is
  `VertexImpactInterfaceCaller.changeThroughContract` (the declaration and
  implementation indexes must not duplicate this row).
- Nearest base: `VertexImpactBase.change(String)` at
  `VertexImpactBase.cls:2`; `callersOfBase` are
  `VertexImpactBaseCaller.changeThroughBase` and the fallback site
  `VertexImpactFallbackCaller.changeWithExtraContext`.
- Overridden by: `VertexImpactChild.change(String)` at
  `VertexImpactChild.cls:2`.

#### METADATA

Empty.

#### OTHER OVERLOADS (collapsed)

| overload | callerCount |
|---|---:|
| `change(Integer)` | 3 (one exact + the fallback + the tied `null` site) |
| `change(Boolean)` | 3 (one exact + the fallback + the tied `null` site) |
| `change(Decimal)` | 2 (the fallback + the tied `null` site) |

Stats: `{breaks:2, mightBreak:4, contractSurfaces:3,
metadataSurfaces:0, otherOverloads:3}`.

### Target 2 — `VertexImpactAction.run(List<String>)` (`[MUST]`)

- BREAKS: empty.
- MIGHT BREAK: empty.
- CONTRACT: empty.
- METADATA: one direct Flow row, `Vtx_ImpactChildFlow` at
  `Vtx_ImpactChildFlow.flow-meta.xml:19`, with one parent-flow child,
  `Vtx_ImpactParentFlow` (its `<flowName>` is line 19).
- OTHER OVERLOADS: empty.

Stats: `{breaks:0, mightBreak:0, contractSurfaces:0,
metadataSurfaces:1, otherOverloads:0}`.

### Target 3 — `VertexImpactController.refresh()` (`[MUST]`)

- BREAKS: empty.
- MIGHT BREAK: empty.
- CONTRACT: empty.
- METADATA, stable kind/label order:
  1. `lwc` — `vertexImpactPanel`, `vertexImpactPanel.js:1`.
  2. `vf` — `VtxImpactPage`, `VtxImpactPage.page:1`.
- OTHER OVERLOADS: empty.

Stats: `{breaks:0, mightBreak:0, contractSurfaces:0,
metadataSurfaces:2, otherOverloads:0}`.

### Negative 1 — `VertexImpactService.change(Decimal)` (`[MUST]`)

This overload has **zero exact callers**. BREAKS is empty. MIGHT BREAK contains
`VertexImpactFallbackCaller.changeWithExtraContext` at line 4 (`via:typed`,
`overloadPick:fallback`, `overloadSig:change(Decimal)`) and the ambiguous
`VertexImpactTieCaller.changeUnknown` `null` call (`overloadPick:arity-tie`).
CONTRACT and METADATA are empty. OTHER OVERLOADS is:

| overload | callerCount |
|---|---:|
| `change(String)` | 6 |
| `change(Integer)` | 3 |
| `change(Boolean)` | 3 |

Stats: `{breaks:0, mightBreak:2, contractSurfaces:0,
metadataSurfaces:0, otherOverloads:3}`. Both uncertain sites must remain
uncertain; neither may be promoted to BREAKS merely because this overload has
no exact callers.

### Negative 2 — `VertexImpactService.unusedPrivate()` (`[MUST]`)

The report exists and is empty-but-honest: BREAKS, MIGHT BREAK, CONTRACT,
METADATA, and OTHER OVERLOADS are all empty; every stat is zero. UI shaping
still returns all five fixed section rows rather than a missing/failed result.

### Entry catalog delta (v0.14)

The catalog moves from 30 to 34 entries:

- `aura`: 5 → 6, adding `VertexImpactController.refresh` with detail
  `@AuraEnabled (LWC/Aura)`.
- `invocable`: 2 → 3, adding `VertexImpactAction.run` with detail
  `@InvocableMethod (Flow)`.
- `flow`: 8 → 10, adding `Vtx_ImpactParentFlow` (`screen or autolaunched`)
  and `Vtx_ImpactChildFlow` (`screen or autolaunched (subflow of
  Vtx_ImpactParentFlow)`).
- Every other kind and `excludedTestEntries:0` remain unchanged.

Final counts: trigger 6, aura 6, invocable 3, rest 0, soap 0, async 9,
email 0, platform 0, flow 10, anonymous 0, total 34.

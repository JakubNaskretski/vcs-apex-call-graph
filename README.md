# Apex Call Graph

Trace **who calls an Apex class or method — with the actual arguments** — as a tree
expanded transitively up to the entry points that can start the execution path:
triggers, `@AuraEnabled` (LWC/Aura), `@InvocableMethod` (Flow),
`@RestResource`/`webservice` (APIs), and async (Batchable / Queueable / Schedulable /
`@future`).

## See it in action

The transcript below is pasted **verbatim** from `node dev/smoke.js` against the
example fixture corpus — real parser → resolver → tree-shaping output, not a
hand-illustrated mockup:

```
=== VertexRepriceBatch.execute ===
36 unresolved · 17 managed-package refs (kwx, zenq).
stats: nodes=2 unique=1 unresolved=36 capped=false
VertexRepriceBatch.execute  [Batchable]
  VertexNightlyAdjustmentJob.execute  [Schedulable · async · ◉ root]
      L3: Database.executeBatch(new VertexRepriceBatch());
      -> new VertexRepriceBatch()
```

Every call site shows its source line **and** (when present) the overload signature
and the arguments bound to your parameter names. `◉ root` marks a node with no known
caller of its own — an entry point or dead code. The header line above the tree is
honest about what couldn't be resolved workspace-wide (dynamic dispatch, platform
calls, chains deeper than 12 segments), instead of staying silent about it.

## Quickstart

1. Put your cursor on a method or class name (or open nothing, for a QuickPick over
   every class/method) and run **Apex Call Graph: Who Calls This?** (callers) or
   **Apex Call Graph: What Does This Call?** (callees).
2. Results land in the **Apex Call Graph** view (Explorer sidebar) — click any call
   site to jump straight to it. The view title's swap-arrow button re-runs the same
   target in the other direction.
3. Before changing a method signature, run **Apex Call Graph: Impact of Changing
   This Method** to inventory direct breaks, uncertain callers, contracts, metadata,
   and sibling overloads.
4. Put the cursor on the target you want and run **Apex Call Graph: Show Path Map**
   for an interactive graph instead of a tree. Re-running it on another target
   replaces the open map. The Call Graph view's map button refreshes its last trace.
5. Not sure where to start? Run **Apex Call Graph: Show Entry Points** for a browsable
   index of every trigger, `@AuraEnabled`/`@InvocableMethod`/REST/SOAP method, async job,
   Flow, and anonymous script in the workspace — see [Entry Points view](#entry-points-view).

## Impact of a signature change

Put the cursor on a method and run **Impact of Changing This Method**. If the name is
overloaded, a cursor on a declaration selects that exact signature; from a call site
or picker, choose the overload explicitly. The main tree becomes a five-section risk
report:

- **BREAKS** — confidently resolved direct Apex call sites for the selected overload.
- **MIGHT BREAK** — approximate dispatch, overload ties, or fallback matches that need
  review rather than being presented as definite failures.
- **CONTRACT** — matching interface declarations, the nearest base declaration,
  descendant overrides, and callers through those surfaces.
- **METADATA** — Flow, LWC, Aura, OmniScript, Visualforce and other supported metadata
  consumers. A Flow action expands to show parent Flows that invoke it as a subflow.
- **OTHER OVERLOADS** — sibling signatures and their caller counts, so the chosen
  overload stays distinct from methods that share its name.

Every row with a known location jumps to source. A genuinely unused private method
shows all five sections with zero counts instead of implying the scan failed. Impact
Analysis is tree-only: trace-direction, orientation, and Path Map controls are hidden
while the report is displayed because these sections are risk surfaces, not a single
execution path.

## Both directions

Every trace runs either direction: **Who Calls This?** walks callers upward to the
entry points that can reach your target; **What Does This Call?** walks forward
through everything your target sets off — DML statements fan out to every trigger
*and* record-triggered Flow they fire, `EventBus.publish` fans out to platform-event
triggers and Flows the same way, async scheduling (`enqueueJob`/`executeBatch`/
`schedule`) lands on the job's `execute` method, and a `throw` lands on a terminal
exception-class node. The transcript below is pasted **verbatim** from
`node dev/smoke.js`, tracing forward from a publisher method:

```
=== AcmeNoteEventPublisher.publishNote -- A4 publish-forward: EventBus.publish -> trigger + PE flow ===
What Does This Call?
75 call sites workspace-wide could not be resolved (dynamic/platform/deep-chain).
stats: nodes=5 unique=2 unresolved=75 capped=false direction=callees
AcmeNoteEventPublisher.publishNote
  AcmeNoteEventTrigger  [trigger on Acme_Note__e (after insert) · publish]
      L6: EventBus.publish(new Acme_Note__e(Message__c = message));
      -> new Acme_Note__e(Message__c = message)
    AcmeNoteEventHandler.handle  [static]
        L9: AcmeNoteEventHandler.handle(Trigger.new);
        -> events: Trigger.new
      ~1 unresolved site  [unresolved · ~ · … depth cap]
  AcmeNoteEventFlow  [Flow apex action · publish · … depth cap]
      L10: EventBus.publish(new Acme_Note__e(Message__c = message));
      -> new Acme_Note__e(Message__c = message)
```

The SAME `EventBus.publish(...)` statement fans out to both the trigger and the Flow.
Here `AcmeNoteEventFlow` is terminal going forward, but that's this particular Flow's
own shape (it calls no subflow of its own) — not a hard rule: a Flow node reached this
way (`via: dml`/`publish`) DOES forward-expand into any Flow it calls as a **subflow**
(see [Flow-to-flow (subflow) chains](#flow-to-flow-subflow-chains) below), it just
doesn't happen to have one here. A trigger node is never terminal either way: tracing
continues into its handler exactly like tracing forward from any other method. The
Path Map mirrors for this direction too — the target sits on the LEFT, callees flow
RIGHT.

## Reading the tree

- **Badges** (`[…]` after a node's label): the entries it declares (`@AuraEnabled`,
  `Batchable`, trigger header, …), `test`, the resolution kind (`typed`, `static`,
  `new`, `interface`, `dml`, `external`, …), and markers — `~` approximate, `↺` cycle,
  `…` depth cap reached, `+N` [more callers/callees waiting to be
  expanded](#start-shallow-expand-on-click) (click to load), `↪ seen elsewhere` (this
  subtree was already shown once above, in a diamond-shaped call graph — only its own
  call sites repeat, not its callers again), `◉ root` (no known caller — entry point
  or dead code), `🛡` an ancestor catches the exception being traced, `managed: ns` (a
  [managed-package reference](#managed-packages), package-icon glyph). Hover any node
  or badge for a one-line explanation.
- **Site rows** (indented under a node): the source line, plus a second line showing
  the overload signature and/or the arguments, when either is available.
- A **note** above the tree calls out an honest zero-caller result instead of
  rendering a silent empty tree, and (when non-zero) a workspace-wide count of call
  sites that couldn't be resolved — split into a plain unresolved count and a
  [managed-package](#managed-packages) ref count once any namespace references exist.

### Confirmed vs possible edges

Approximate edges (`~`) are grouped by default under a collapsed **“N possible
callers/callees (unconfirmed)”** row. Expand that row to inspect them, set
`apexCallGraph.showUnconfirmed` to `hide` to show confirmed edges only, or use
`expand` for the earlier flat presentation. Grouping changes presentation only —
the same underlying sites, source jumps, arguments, and resolution badges remain.

The unique-name fallback is deliberately conservative: an unknown receiver can
attach to the only class declaring a matching-arity method while the name occurs at
small scale, but a framework-common name attracting more than five such sites
attaches none of them. In a caller trace, unresolved sites that still mention the
target method are surfaced separately as **“K unresolved sites elsewhere mention
method( — potential unconfirmed callers”**. They remain inspectable evidence, not
fabricated call edges. Calls on known platform receiver types—such as `String`,
`SObject`, `Map`, `List`, and `Set`—are excluded from this candidate bucket because
they are platform behavior, not unresolved dispatch to a workspace Apex method.
Static `@AuraEnabled` and `@InvocableMethod` targets are excluded too: LWC and Flow
metadata identify their owning class, while valid Apex `Class.method()` and same-class
calls resolve through exact rules. This keeps common metadata-entry method names from
obscuring precise LWC imports or Flow actions with workspace-wide name-only matches.

## Start shallow, expand on click

Traces don't eagerly walk the whole tree up front anymore. By default, a new trace
shows **2 levels deep** — everything closer than that expands automatically, and a
node with real callers/callees beyond that shows a `+N` badge (tree view) or a
clickable `+N` pill (Path Map) instead of silently stopping. Click it — the native
tree item, or the pill — and just that node's own direct callers/callees load in
place, no re-scan, no losing your Path Map pan/zoom position. This keeps a first
look at a heavily-called method (or a busy hub class) fast and readable instead of
dumping hundreds of nodes at once; expand only the branches you actually care about.

The transcript below is pasted **verbatim** from `node dev/smoke.js`:

```
=== AcmeOrderTriggerHandler.handle -- STEP 1: initialDepth=2 (collapsed) ===
72 call sites workspace-wide could not be resolved (dynamic/platform/deep-chain).
stats: nodes=10 unique=9 unresolved=72 capped=false frontierNodes=2
AcmeOrderTriggerHandler.handle
  AcmeOrderTrigger  [trigger on Acme_Order__c (before insert, before update, after insert, after update) · typed]
      L9: handler.handle(
      -> newOrders: Trigger.new, oldMap: Trigger.oldMap, isBefore: Trigger.isBefore, isAfter: Trigger.isAfter, isInsert: Trigger.isInsert, isUpdate: Trigger.isUpdate
    AcmeDiscountApprovalInvocable.execute  [@InvocableMethod (Flow) · dml · ◉ root]
        L30: update ord;
        -> ord
    AcmeFulfillmentDmlService.insertOrders  [dml · ◉ root]
        L15: insert orders;
        -> orders
    AcmeFulfillmentDmlService.insertOrdersViaDatabase  [dml · ◉ root]
        L75: Database.insert(orders, false);
        -> orders, false
    AcmeFulfillmentDmlService.mergeOrders  [dml · ◉ root]
        L63: merge masterOrder duplicateOrder;
        -> masterOrder
    AcmeFulfillmentDmlService.updateSingleOrder  [dml · ◉ root]
        L29: update order;
        -> order
    AcmeFulfillmentDmlService.upsertOrders  [dml · ◉ root]
        L49: upsert orders;
        -> orders
    AcmeOrderService.recalculatePricing  [dml · +2]
        L39: update ord;
        -> ord
      +2 more callers…
    AcmeOrderUtil.markApproved  [dml · +2]
        L22: update ord;
        -> ord
      +2 more callers…

-- after clicking the first +2 --

=== AcmeOrderTriggerHandler.handle -- STEP 2: after expanding ONE frontier click ===
stats: nodes=12 unique=10 unresolved=72 capped=false frontierNodes=1
AcmeOrderTriggerHandler.handle
  AcmeOrderTrigger  [trigger on Acme_Order__c (before insert, before update, after insert, after update) · typed]
      L9: handler.handle(
      -> newOrders: Trigger.new, oldMap: Trigger.oldMap, isBefore: Trigger.isBefore, isAfter: Trigger.isAfter, isInsert: Trigger.isInsert, isUpdate: Trigger.isUpdate
    AcmeDiscountApprovalInvocable.execute  [@InvocableMethod (Flow) · dml · ◉ root]
        L30: update ord;
        -> ord
    AcmeFulfillmentDmlService.insertOrders  [dml · ◉ root]
        L15: insert orders;
        -> orders
    AcmeFulfillmentDmlService.insertOrdersViaDatabase  [dml · ◉ root]
        L75: Database.insert(orders, false);
        -> orders, false
    AcmeFulfillmentDmlService.mergeOrders  [dml · ◉ root]
        L63: merge masterOrder duplicateOrder;
        -> masterOrder
    AcmeFulfillmentDmlService.updateSingleOrder  [dml · ◉ root]
        L29: update order;
        -> order
    AcmeFulfillmentDmlService.upsertOrders  [dml · ◉ root]
        L49: upsert orders;
        -> orders
    AcmeOrderService.recalculatePricing  [dml]
        L39: update ord;
        -> ord
      AcmeDiscountApprovalInvocable.execute  [@InvocableMethod (Flow) · static · ↪ seen elsewhere]
          L31: AcmeOrderService.recalculatePricing(req.quoteId);
          -> orderId: req.quoteId
      AcmeOrderRestResource.handleGet  [@HttpX (REST) · static · ◉ root]
          L13: AcmeOrderService.recalculatePricing(orderId); NovaBillingUtil.auditPricingSync(orderId); // v0.7: ambiguous cross-package fixture
          -> orderId: orderId
    AcmeOrderUtil.markApproved  [dml · +2]
        L22: update ord;
        -> ord
      +2 more callers…
```

Clicking a `+N` only ever reveals *that* node's own direct callers/callees — nothing
deeper auto-expands, so a wide tree stays navigable one click at a time. Re-tracing
(a new target, or **Switch Trace Direction**) and toggling entry-first orientation
both reset expansion back to the shallow default; re-rooting a mix of fully-expanded
and still-collapsed branches would be ambiguous, so both start clean.

Tune it in **Settings → Extensions → Apex Call Graph**:

| Setting | Default | What it does |
|---|---|---|
| `apexCallGraph.initialDepth` | `2` | How many levels auto-expand before you have to click. Lower = faster first look on a big org; raise it for small ones where you usually want the whole picture at once. |
| `apexCallGraph.expandStep` | `1` | How many extra levels one click loads. |
| `apexCallGraph.maxDepth` | `8` | Hard ceiling on trace depth, however far you click. |
| `apexCallGraph.maxNodes` | `2000` | Fair cap on total nodes a single trace will materialize. |
| `apexCallGraph.excludeGlobs` | `[]` | Up to 64 extra workspace-relative glob patterns to exclude from full and incremental scanning. Supports `*`, `?`, segment `**`, braces, and character classes; a directory match excludes its descendants. Pattern length and combined brace/token work are bounded so hostile or accidental settings cannot stall a scan. Built-in excludes remain `node_modules`, `.sfdx`, `.sf`, `.git`, and `__tests__`. |
| `apexCallGraph.showUnconfirmed` | `rollup` | Group approximate edges under a collapsed rollup; choose `hide` for confirmed-only or `expand` for the old flat view. |

Setting `initialDepth` equal to `maxDepth` (with nothing ever clicked) reproduces the
old always-eager v0.8 behavior exactly, byte for byte — this is a pure UX default
change, not a new resolution rule.

## Beyond Apex: metadata callers

Callers that live outside Apex appear as terminal root nodes (badge `metadata`):
**Flows** (apex actions; bare action names are cross-referenced to the class's
`@InvocableMethod`), **LWC** (`@salesforce/apex` imports — jest mocks excluded),
**Aura** (markup `controller=` + `c.method` calls), **OmniScript / Integration
Procedure** Remote Actions (Vlocity DataPack JSON and `.os-meta.xml`), and
**Visualforce** (`controller`/`extensions`, plus `action="{!method}"` bindings on
`apex:page`/`commandButton`/`commandLink`/`actionFunction`/`actionSupport`/
`actionPoller` — attached to whichever of the page's controller/extensions classes
actually declares that method; see Limits below).

A class-level **Who Calls This?** trace rolls up the method-specific metadata above,
so two `@salesforce/apex/Class.method` imports in one LWC appear as one component node
with two source sites instead of disappearing unless each method is traced separately.
Enabled `<classAccesses>` entries from **Permission Sets** and **Profiles** also appear
on a class trace with the `access` badge. These rows describe authorization, not
runtime calls: they do not appear on method traces and are deliberately omitted from
the Execution Path Map.

The **Apex Trigger Actions Framework** is joined across its otherwise invisible
configuration chain. A class implementing `TriggerAction.BeforeInsert`,
`TriggerAction.AfterUpdate`, or another supported context is connected through its
`Trigger_Action__mdt` record and related `sObject_Trigger_Setting__mdt` record to the
matching object/event trigger. A trigger that calls `MetadataTriggerHandler.run()` is
confirmed; if there is exactly one matching trigger but it uses a custom dispatcher,
the trigger is retained as an approximate (`~`) edge. The metadata record is also
attached to the exact context method, so tracing either the class or `afterUpdate()`
shows the same configuration path. Actions disabled by `Bypass_Execution__c` on
either the action record or its object-level trigger setting remain inspectable as
metadata but are not presented as executable trigger paths.

Property accessors are real targets too — `quote.Status = x` is a caller of
`(set Status)` — and every call site carries a type-resolved `overloadSig` when the
target has overloads. Fluent chains (`a.b().c()`) resolve through return types up to
12 segments; casts and ternary receivers are handled.

## Path Map

**Apex Call Graph: Show Path Map** renders the trace as an interactive, depth-oriented
tree. Labeled hop lanes and orthogonal arrows make the hierarchy explicit: entry roots
flow left-to-right into your target, while forward traces mirror from the target into
its callees. Type chips distinguish Apex, Trigger, Flow, LWC, Aura, Invocable,
Visualforce, external, and other components; semantic connector colors separate direct
Apex calls, automation/metadata, DML/events, managed code, exceptions, and approximate
matches without relying on color alone. Hovering or focusing a node lists its call sites
with arguments in a dedicated **Path details** inspector beside the canvas, so source
details never cover the node or branch being inspected. When the map contains multiple
methods from that node's class, a compact **Same class in this map** frame groups those
methods in the sidebar; choosing one centers and focuses its existing card without
adding untraced methods or cluttering the graph. Clicking a node—or pressing
Enter/Space—jumps to source in a different editor group, reusing the other group when
available or opening one beside the map so navigation never replaces it. Fit and zoom
controls complement drag-to-pan and wheel zoom.
A [frontier node](#start-shallow-expand-on-click) shows a clearly labeled **Expand +N**
button, and **Expand visible (N)** grows every currently visible frontier branch by the
configured expansion step in one action. The per-node button remains available when you
only want to grow one branch. Both controls are separate from the node body, so an
expansion action grows the map in place while clicking the body still jumps to source —
and expanding preserves your current pan/zoom position instead of
re-fitting the view. Fully offline webview, no external resources.

Running **Show Path Map** again resolves the class or method currently under the
cursor and replaces the existing singleton panel, even when it points at a different
target. Use **Refresh Path Map** (the Call Graph view-title map button) when you want
to re-scan and redraw the last traced target instead.

## Entry Points view

**Apex Call Graph: Show Entry Points** scans the workspace and lists every way into
the org in a second Explorer view — a browsable index built from the same data the
call-graph engine already computes, not a new kind of analysis. Entries are grouped by
kind (**Triggers**, **Aura / LWC**, **Invocable Actions**, **REST Endpoints**, **SOAP
Web Services**, **Async** — Batchable/Queueable/Schedulable/`@future`, **Email
Handlers**, **Platform Hooks** — install/uninstall/SSO/`Comparable`/`Finalizer`,
**Flows**, **Anonymous Scripts**), with a count next to each group and a totals line
(`N entry points across M kinds`) at the top. Triggers and Flows start expanded — the
two kinds most useful for "how does this org get entered" at a glance — every other
group starts collapsed. `@isTest` classes are excluded from the catalog entirely (a
separate count in the header says how many). The same header also reports unresolved
call sites and managed-package references, so incomplete analysis is visible instead
of silently looking exhaustive.

Click any entry to jump to its source. Every entry also carries an inline **What Does
This Call?** action — the same forward-trace command the main view uses — so you can go
straight from "here's an entry point" to "here's everything it reaches" without
re-resolving a target by hand. (A Flow entry runs this only when the Flow's engine data
gives it a traceable Apex target; otherwise it's a no-op with an explanatory toast — a
Flow itself isn't an Apex class/method the tracer can target.) The view title's refresh
button re-runs the scan, reusing the same caches a normal trace does.

## The transaction story

Traces don't stop at method boundaries: a `update shipments;` statement (or
`Database.update(...)`) is a caller (`via: dml`) of every trigger on that object with
matching events — so tracing a trigger, or anything it reaches, continues up through
the code that fires it, across objects, all the way to the UI or API entry that
started the transaction. Record-triggered Flows participate too: a Flow node shows
the DML sites that launch it as children. Handlers doing DML on their own object are
flagged as cycles.

### Flow-to-flow (subflow) chains

A Flow calling another Flow (a **subflow**) is a first-class edge (`via: subflow`,
never approximate — it's a declared reference, not a fan-out guess), in both
directions:

- **Who Calls This?** on an apex action reached only through a subflow walks: the
  apex method → its subflow (`metadata`) → that subflow's own **parent** Flow(s)
  (`subflow`) → recursively up through however many further parents that parent has
  → whatever DML/`EventBus.publish` site launched the outermost parent, all the way
  to the entry point.
- **What Does This Call?** from that same DML/publish site walks the mirror image
  forward: the launcher → the parent Flow (`dml`/`publish`) → each Flow it calls as a
  subflow (`subflow`) → recursively into further subflows → each subflow's own apex
  actions, DML, and further subflows in turn.

Chains recurse to whatever depth the Flows themselves declare (a 2-hop, 3-hop, or
longer chain all resolve the same way — nothing here is hardcoded to a fixed depth),
and a mutual reference (Flow A calls B as a subflow, B calls A back) is guarded by the
same ancestor-path mechanism as any other cycle: the repeat occurrence is flagged
`↺ cycle` with zero further children, never a hang. A subflow name that matches no
Flow file in the workspace is tallied internally but never fabricates a node — see
[Limits](#limits-known-by-design) for the exact accounting.

Also resolved: dispatch maps (`handlerMap.get(key).handle()` through collection
generics), virtual override fan-out (`~ override`, including through a subclass that
overrides a method inherited from an interface's direct implementer, AND a bare/`this`
self-call made from within the declaring base class's own body — the trigger-handler
"framework calls its own overridable hook" idiom), `Type.forName('X')` literals
(`~ dynamic`), and Custom Metadata records that name handler classes (`cmdt` nodes).
Platform entries cover Email Services, install handlers, `Comparable`, `Finalizer`, and
the full async surface. LWC/Aura/Flow/OmniScript/Custom Metadata references that don't
unambiguously match exactly one local class are dropped rather than mis-attached, and
counted in a header line separate from the ordinary unresolved-call-site count.

## Exceptions, events, async

- **Trace an exception class**: every `throw` site appears (`via: throws`) with the
  caller chains above it; nodes whose method would catch it (exact, supertype, or bare
  `Exception`) carry a `catches <Exc>` shield badge — traversal continues, since
  rethrow can't be known statically.
- **`EventBus.publish(new X__e(...))`** is a `publish` caller of the event's trigger,
  and platform-event-triggered Flows show their publish sites as children.
- **Async hops**: `enqueueJob` / `executeBatch` / `schedule` edge to the job's
  `execute` method (`via: async`).
- **Anonymous Apex** (`.apex` scripts) are scanned as root callers; `instanceof`-
  narrowed calls are kept and labeled `~ narrowed`.

## Multi-package projects

When your workspace has an `sfdx-project.json` with more than one `packageDirectory`,
nodes from a different package than the one you're tracing carry a package badge
(`(nova-billing)`, `(force-app)`, …) so you can see at a glance when a call crosses a
package boundary. A class name declared in more than one package is no longer
silently dropped: the header shows `N duplicate class names across packages —
resolution prefers the referring file's package`, and each call site resolves in
order — (1) the referring file's own package, (2) the package marked `default: true`,
(3) if still ambiguous, an edge to **every** remaining candidate, marked `~ ambiguous`
(each carrying its own package badge, since they're different classes that happen to
share a name). QuickPick target labels get a package suffix too, but only for names
that are actually duplicated. A workspace with no `sfdx-project.json` anywhere behaves
exactly as before — no badges, no bucketing, first-registered class wins.

## Managed packages

A reference into a managed namespace — `ns.Class.method(...)`, `insert new
ns__Object__c(...)`, or an LWC/Flow/Custom-Metadata reference naming
`ns.Class.method`/`ns__Class` — shows up as its own **external** node
(`managed: ns` badge, package-icon glyph) instead of vanishing into an
"unresolved" count. What it can show:

- **Who calls into it.** Trace the external node itself (pick it from the same
  QuickPick you'd use for any other target — it's grouped and labeled
  `ns.Class (managed)`) and you get the full, ordinary caller tree: every local
  Apex call site, LWC import, Flow action, and Custom Metadata record that
  references it, from every surface at once. Two differently-spelled or
  differently-cased references to the same `(namespace, class)` pair land on
  the **same** node; a different namespace or a different class name — even a
  one-letter typo — is always a **distinct** node, never merged.
- **A local trigger on a namespaced-looking object still links normally.** If
  your workspace declares `trigger MyTrigger on ns__Object__c (...)`, DML on
  `ns__Object__c` fans out to it exactly like it would for any local custom
  object — the object *looking* namespaced doesn't change trigger matching.

What it can never show:

- **What the managed code itself does.** An external node is a dead end going
  forward — there's no source to read, so "what does this call?" stops there.
  That's not a bug to report; it's the boundary of static analysis without the
  package's Apex.
- A 2-segment call (`Foo.bar()`, no third segment) is **never** promoted to an
  external node, even when `Foo` looks like it could be a namespace — that
  shape is indistinguishable from an ordinary reference to a class this
  workspace simply never declared, and stays in the plain unresolved count
  instead (see the header's `N unresolved · M managed-package refs (ns, …)`
  line for that split).
- If your own workspace declares a namespace (`sfdx-project.json`'s
  `"namespace"` property), references prefixed with *your own* namespace
  resolve locally instead — they're not managed-package code at all, so they
  never appear as an external node.

## Limits (known, by design)

- Chains longer than 12 segments degrade to no edge (never a guessed one); a
  return-type cycle (`A.next()` → `B`, `B.next()` → `A`, …) is detected mid-walk
  (a per-chain guard on already-visited `(type, method)` pairs) and degrades to no
  edge the same way, rather than looping or landing on a lucky-but-wrong class.
- Visualforce `action="{!method}"` bindings are only extracted when the brace
  expression is a single bare identifier — `action="{!obj.method}"` (dotted) or any
  other compound expression (`{!a && b}`, `{!IF(x,y,z)}`) is skipped, not attempted.
  `value="{!prop}"` bindings are out of scope entirely (property/accessor
  territory, not an action) — never extracted, regardless of shape.
- `Type.forName(...)`/`Type.newInstance()` resolves through four strictly-verifiable
  literal-flow shapes, all `~ dynamic`: an inline string literal, a local variable
  declared with a single string-literal initializer and never reassigned anywhere else
  in the method, a `static final String` constant with a literal initializer
  (referenced bare in its own class or qualified as `ClassName.CONST` cross-class), and
  a ternary of two string literals (edges to **both** candidates). Everything else is
  not traced — no constructor edge, and never a guessed one: a method **parameter**
  (never a local declaration, regardless of what it might hold at runtime), a local
  that's reassigned *anywhere* in the method (the no-reassignment proof is purely
  syntactic, not reachability-sensitive — a reassignment inside a never-taken branch
  still disqualifies it), a non-`final` or non-literal-initializer field (never
  recorded as a constant in the first place), string concatenation, or any other
  computed/non-literal argument (including a `Type`-typed local/field, however it's
  named — the check is by declared type, not identifier text). Cross-method literal
  flow (a called method's return value, a field set by a different method) is out of
  scope.
- Generic-typed DML (a `List<SObject>`/`SObject`-typed **local** variable) narrows to
  real objects when the SAME method also calls `.add(...)`/`.addAll(...)` on that same
  local with evidence resolvable to a concrete type — a `new Concrete__c(...)`
  construction, or a simple identifier whose own declared type is a concrete
  SObject/SObject-collection. Each type found narrows to its own trigger/record-flow
  linkage, `~ dml` (approximate — the object identity is an inference, not a syntactic
  certainty); the union of every type discovered across all evidence calls fans out
  together. What still doesn't narrow: evidence in a **different** method (a param, a
  field, another method's return type — cross-method flow is out of scope), or an
  `.add(...)` argument that's itself a computed/method-call expression rather than a
  construction or a simple identifier. Zero in-method evidence leaves the honest `DML
  on unresolved SObject type` marker exactly as before, with no trigger/flow linkage
  attempted.
- A 2-segment call (`Foo.bar()`) into an unknown class is never distinguished from a
  2-segment call into an actual namespace — see [Managed packages](#managed-packages)
  above for the 3-segment shapes that *are* modeled, and why 2-segment calls
  deliberately aren't.
- DML→trigger edges (narrowed or not) assume the trigger fires — validation rules and
  exceptions can prevent it at runtime.
- **Flow-to-flow (subflow) chains** ([above](#flow-to-flow-subflow-chains)): a
  `<subflows>` reference naming a Flow file this workspace doesn't have is tallied
  internally (never shown as its own UI element yet — no live target to jump to) but
  never fabricates a node — same "count it, don't guess it" posture as every other
  unresolved-reference count in this tool. A Flow node reached via `dml`/`publish`
  (i.e. it's the launched Flow itself, not one of its subflows) forward-exposes its
  own subflows but, deliberately, not its own direct apex actions — only a Flow
  reached *as* a subflow forward-exposes its own apex actions. This is an intentional
  asymmetry, not an oversight: from that root Flow's perspective, "what it calls"
  already has an ordinary route into the same apex action (trace the action directly,
  or from the record-trigger/publish site through the trigger's own handler), so the
  one hop that's genuinely new information is the subflow edge itself.
- A single trace caps at 2000 nodes; a trace that hits the cap is marked and stops
  expanding fairly across branches rather than silently truncating one of them —
  the specific node whose own further expansion was cut carries the marker (never
  the wrong node, and never mislabeled a root/dead-end). Large fan-in graphs are
  deduplicated first (a subtree is only ever expanded once per trace, see
  `↪ seen elsewhere` above), so the cap is rarely the limiting factor in practice.
- Interface/DI-style dispatch (including a string-keyed service locator) fans out to
  every implementer uniformly, approximate — narrowing to whichever one is actually
  wired at runtime would require whole-program constant propagation, out of scope for
  static analysis.
- Static analysis shows *possible* paths; it cannot tell you which one ran. For that,
  capture a debug log of a real transaction.

## Offline & caching

Fully **offline**: no org connection, no language server, no telemetry. Powered by the
open-source ANTLR Apex grammar (`@apexdevtools/apex-parser`, pure JavaScript — no JVM,
no WASM). A ~20-file project cold-indexes in ~250 ms; unchanged files (matched by
modification time **and** size) are cached and never re-parsed. File watchers keep a
dirty set, so a later trace normally re-reads only changed/created files and removes
deleted ones; if watching is unavailable or uncertain, the extension falls back to a
safe full sweep. Large cold parses are split across worker threads, while smaller and
warm scans stay inline to avoid unnecessary startup overhead.

Indexing is cancellable from the progress notification. Cancelling terminates active
parse workers, preserves already-valid cached facts, discards the partial index, and
leaves the last good tree untouched. Repeated requests are single-flighted: an
identical request joins the scan already running, while a newer different target is
coalesced to the latest request.

Dirty file-backed editors are snapshotted at the start of every scan. Unsaved
Apex changes participate in parsing and resolution, and unsaved LWC, Aura, Flow,
OmniScript, Visualforce, Custom Metadata, Permission Set, and Profile changes
participate in metadata references. These overlays are ephemeral: they never replace
the disk-truth in-memory cache and are never written to global storage. Saving,
reverting, or closing the editor therefore makes the next trace fall back to the
corresponding disk file.

Only declaration-only Apex facts that contain no source lines, argument/receiver
expressions, DML targets, or literal values are persisted to VS Code's global
storage, in a versioned `facts-v<engine>-<hash>.json` file per workspace-folder set.
Files containing those fields (and every syntax-error file) remain memory-only and
are reparsed after restart rather than writing partial facts that could change graph
semantics. LWC, Aura, Flow, OmniScript, Visualforce, Custom Metadata, Permission Set,
and Profile source also stays memory-only. Legacy source-bearing cache files are
removed automatically, and safe facts caches expire after 30 days. Run **Apex Call
Graph: Clear Cache** at any time to remove both in-memory and persisted caches; the
next trace simply performs a cold scan.
For performance troubleshooting, open **Apex Call Graph: Scan Stats** or run **Copy
Diagnostics (counts only)**. The copied JSON contains counts, timings, worker usage,
resolution-reason totals, and the active display mode — never paths, source text,
symbols, or call arguments.

## Commands

| Command | Where |
|---|---|
| `Apex Call Graph: Who Calls This?` | Editor context menu (`.cls`/`.trigger`), command palette |
| `Apex Call Graph: What Does This Call?` | Editor context menu (`.cls`/`.trigger`), command palette |
| `Apex Call Graph: Impact of Changing This Method` | Editor context menu (`.cls`/`.trigger`), command palette |
| `Apex Call Graph: Switch Trace Direction` | View title button — re-runs the last target the other way |
| `Apex Call Graph: Show Path Map` | Editor context menu, command palette — resolves the current target |
| `Apex Call Graph: Refresh Path Map` | Call Graph view title button, command palette — re-scans the last target |
| `Apex Call Graph: Show Entry Points` | Entry Points view title button, view welcome link, command palette |
| `Apex Call Graph: Copy Diagnostics (counts only)` | Command palette |
| `Apex Call Graph: Clear Cache` | Command palette |

## Reference: how edges are resolved

A real parse of every `.cls`/`.trigger`, then static resolution:

- **typed** — instance calls through the declared type of a local / parameter / field,
  following the `extends` chain (grandparent methods resolve correctly).
- **static** — `SomeClass.method()`; **new** — constructors (incl. `this()`/`super()`
  chains); **this/super** — bare and qualified self-calls.
- **interface** — a call through an interface-typed variable fans out to every
  implementer AND every override of that method in an implementer's own subclasses,
  marked approximate (`~`).
- **unique-name** — unresolvable receiver, but exactly one class declares that method:
  edge kept, marked approximate.
- **dml** / **publish** / **async** / **throws** — DML statements, `EventBus.publish`,
  async scheduling, and `throw` sites each get their own resolution rule (see
  "The transaction story" and "Exceptions, events, async" above); none of these four
  are marked approximate — each reflects something the platform genuinely does, not a
  guess.
- **ambiguous** — a class name duplicated across sfdx packages that neither the
  referring file's own package nor the default package could resolve: every remaining
  candidate gets an edge, marked approximate (see "Multi-package projects" above).
- **external** — a 3-or-more-segment reference (`ns.Class.method(...)`) or a
  managed-object DML target (`ns__Object__c`) whose leading segment isn't a local
  variable, class, or your own declared namespace: edge to a dedicated external
  (managed-package) node, **not** marked approximate — namespace precedence is a
  confident rule, not a guess (see "Managed packages" above).
- **lexical** — files with syntax errors degrade to v1's name-mention scan.
- Overloads are arity-matched; inner classes work as `Outer.Inner`; platform types
  (`System.debug`, `Database.insert`, …) are excluded unless you shadow them with a
  real class; `.sfdx`/`.sf` platform-stub libraries are never indexed.

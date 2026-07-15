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
=== RawMaterialsPriceUpdateService.updateRawMaterialsPrice ===
121 call sites workspace-wide could not be resolved (dynamic/platform/deep-chain).
RawMaterialsPriceUpdateService.updateRawMaterialsPrice
  RawMaterialsPriceUpdateBatch.execute  [Batchable · static]
      L13: RawMaterialsPriceUpdateService.updateRawMaterialsPrice(new Map<Id, RawMaterial__c>(scope));
      -> rawMaterials: new Map<Id, RawMaterial__c>(scope)
    RawMaterialsPriceUpdateSchedulable.execute  [Schedulable · async]
        L7: Database.executeBatch(new RawMaterialsPriceUpdateBatch());
        -> new RawMaterialsPriceUpdateBatch()
      RawMaterialsPriceUpdateSchedulable.scheduleNightlyJob  [async · ◉ root]
          L21: System.schedule(JOB_NAME, CRON_EXP, new RawMaterialsPriceUpdateSchedulable());
          -> JOB_NAME, CRON_EXP, new RawMaterialsPriceUpdateSchedulable()
```

Every call site shows its source line **and** (when present) the overload signature
and the arguments bound to your parameter names. `◉ root` marks a node with no known
caller of its own — an entry point or dead code. The header line above the tree is
honest about what couldn't be resolved workspace-wide (dynamic dispatch, platform
calls, chains deeper than 4 segments), instead of staying silent about it.

## Quickstart

1. Put your cursor on a method or class name (or open nothing, for a QuickPick over
   every class/method) and run **Apex Call Graph: Who Calls This?** (callers) or
   **Apex Call Graph: What Does This Call?** (callees).
2. Results land in the **Apex Call Graph** view (Explorer sidebar) — click any call
   site to jump straight to it. The view title's swap-arrow button re-runs the same
   target in the other direction.
3. Run **Apex Call Graph: Show Path Map** for the same trace as an interactive graph
   instead of a tree.

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

The SAME `EventBus.publish(...)` statement fans out to both the trigger and the Flow
— a Flow node is always terminal going forward (its own internal actions aren't
modeled as call-graph children), while a trigger node is not: tracing continues into
its handler exactly like tracing forward from any other method. The Path Map mirrors
for this direction too — the target sits on the LEFT, callees flow RIGHT.

## Reading the tree

- **Badges** (`[…]` after a node's label): the entries it declares (`@AuraEnabled`,
  `Batchable`, trigger header, …), `test`, the resolution kind (`typed`, `static`,
  `new`, `interface`, `dml`, …), and markers — `~` approximate, `↺` cycle, `…` depth
  cap reached, `↪ seen elsewhere` (this subtree was already shown once above, in a
  diamond-shaped call graph — only its own call sites repeat, not its callers again),
  `◉ root` (no known caller — entry point or dead code), `🛡` an ancestor catches the
  exception being traced. Hover any node or badge for a one-line explanation.
- **Site rows** (indented under a node): the source line, plus a second line showing
  the overload signature and/or the arguments, when either is available.
- A **note** above the tree calls out an honest zero-caller result instead of
  rendering a silent empty tree, and (when non-zero) a workspace-wide count of call
  sites that couldn't be resolved.

## Beyond Apex: metadata callers

Callers that live outside Apex appear as terminal root nodes (badge `metadata`):
**Flows** (apex actions; bare action names are cross-referenced to the class's
`@InvocableMethod`), **LWC** (`@salesforce/apex` imports — jest mocks excluded),
**Aura** (markup `controller=` + `c.method` calls), **OmniScript / Integration
Procedure** Remote Actions (Vlocity DataPack JSON and `.os-meta.xml`), and
**Visualforce** (`controller`/`extensions`).

Property accessors are real targets too — `quote.Status = x` is a caller of
`(set Status)` — and every call site carries a type-resolved `overloadSig` when the
target has overloads. Fluent chains (`a.b().c()`) resolve through return types up to
4 segments; casts and ternary receivers are handled.

## Path Map

**Apex Call Graph: Show Path Map** renders the trace as an interactive graph: entry roots
flow left-to-right into your target, edges are labeled with their resolution kind,
hovering a node lists its call sites with arguments, clicking jumps to source.
Fully offline webview, no external resources.

## The transaction story

Traces don't stop at method boundaries: a `update shipments;` statement (or
`Database.update(...)`) is a caller (`via: dml`) of every trigger on that object with
matching events — so tracing a trigger, or anything it reaches, continues up through
the code that fires it, across objects, all the way to the UI or API entry that
started the transaction. Record-triggered Flows participate too: a Flow node shows
the DML sites that launch it as children. Handlers doing DML on their own object are
flagged as cycles.

Also resolved: dispatch maps (`handlerMap.get(key).handle()` through collection
generics), virtual override fan-out (`~ override`, including through a subclass that
overrides a method inherited from an interface's direct implementer), `Type.forName('X')`
literals (`~ dynamic`), and Custom Metadata records that name handler classes (`cmdt`
nodes). Platform entries cover Email Services, install handlers, `Comparable`,
`Finalizer`, and the full async surface.

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

## Limits (known, by design)

- Chains longer than 4 segments degrade to no edge (never a guessed one).
- `Type.forName` with a non-literal argument is not traced.
- DML→trigger edges assume the trigger fires (validation rules and exceptions can
  prevent it at runtime).
- A single trace caps at 2000 nodes; a trace that hits the cap is marked and stops
  expanding fairly across branches rather than silently truncating one of them. Large
  fan-in graphs are deduplicated first (a subtree is only ever expanded once per
  trace, see `↪ seen elsewhere` above), so the cap is rarely the limiting factor in
  practice.
- Static analysis shows *possible* paths; it cannot tell you which one ran. For that,
  capture a debug log of a real transaction.

## Offline & caching

Fully **offline**: no org connection, no language server, no telemetry. Powered by the
open-source ANTLR Apex grammar (`@apexdevtools/apex-parser`, pure JavaScript — no JVM,
no WASM). A ~20-file project cold-indexes in ~250 ms; unchanged files (matched by
modification time **and** size) are cached and never re-parsed. The cache itself —
derived parse facts, not your source (files with a syntax error are the one exception:
their raw text is echoed back for the lexical fallback scanner) — is written to VS
Code's global storage as `facts-<hash>.json`/`meta-<hash>.json`, one pair per
workspace-folder set; deleting them just forces a cold re-parse next run.

## Commands

| Command | Where |
|---|---|
| `Apex Call Graph: Who Calls This?` | Editor context menu (`.cls`/`.trigger`), command palette |
| `Apex Call Graph: What Does This Call?` | Editor context menu (`.cls`/`.trigger`), command palette |
| `Apex Call Graph: Switch Trace Direction` | View title button — re-runs the last target the other way |
| `Apex Call Graph: Show Path Map` | Editor context menu, view title button, command palette |

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
- **lexical** — files with syntax errors degrade to v1's name-mention scan.
- Overloads are arity-matched; inner classes work as `Outer.Inner`; platform types
  (`System.debug`, `Database.insert`, …) are excluded unless you shadow them with a
  real class; `.sfdx`/`.sf` platform-stub libraries are never indexed.

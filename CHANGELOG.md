# Changelog

## 0.18.0

Keep related methods easy to navigate without adding noise to the execution tree.

- When the Path Map contains multiple methods from the focused node's class, the
  Path details sidebar now groups them in a compact **Same class in this map**
  section.
- Selecting a related method centers and focuses its existing card without adding
  untraced methods or changing the graph.
- Increased spacing around node metadata and relationship labels keeps dense cards
  readable without covering caller details.

## 0.17.0

Trace framework-driven trigger actions and explore execution paths without losing
the map or the branch you are inspecting.

- Re-running **Show Path Map** from another class or method now resolves that
  current target and replaces the already-open map; the Call Graph view button
  remains an explicit refresh of the last trace.
- Opening a class or call site from the Path Map now targets a different editor
  group, creating one beside the map when necessary instead of replacing the map.
- Classes implementing Apex Trigger Actions Framework context interfaces now trace
  through `Trigger_Action__mdt` and `sObject_Trigger_Setting__mdt` to matching
  object/event triggers. Canonical `MetadataTriggerHandler.run()` dispatch is exact;
  a sole custom-dispatcher trigger is shown as approximate, and bypass flags on
  either the action or object-level setting suppress disabled execution paths.
- The Path Map now reads as a depth-oriented tree with labeled hop lanes,
  orthogonal directional connectors, and a visually distinct target lane.
- Component type chips and a restrained semantic palette distinguish Apex,
  triggers, Flow/automation, LWC/Aura/Visualforce, data/event transitions,
  managed code, tests, exceptions, and approximate matches without relying on
  color alone.
- Fit and zoom controls, keyboard-activatable nodes, visible focus states, and
  clearer edge-label placement make dense maps easier to inspect.
- Call-site details now live in a dedicated responsive inspector instead of a
  floating tooltip that can cover the referenced branch.
- Frontier nodes use explicit **Expand +N** buttons, while a bounded **Expand
  visible (N)** action grows every visible frontier branch in one resolver rebuild
  per configured expansion step.

## 0.16.0

See every meaningful way an Apex class enters the graph, without noisy guesses.

- Class-level caller traces now roll up method-specific LWC, Aura, Flow,
  OmniScript, and Visualforce references instead of showing only class-only metadata.
- Enabled Permission Set and Profile Apex class grants appear as source-linked
  `access` metadata, clearly separated from runtime call edges and omitted from the
  Execution Path Map.
- Calls on known platform receiver types no longer inflate unresolved-caller
  suggestions for unrelated user methods with common names such as `get` or `contains`.
- Static `@AuraEnabled` and `@InvocableMethod` methods no longer receive name-only
  callers or unresolved suggestions from unknown instance receivers; their exact LWC
  imports and Flow actions stay visible.

## 0.15.0

Safer, fresher traces while you edit.

- Unsaved Apex and supported metadata changes now participate in traces without
  being persisted.
- File changes reliably invalidate cached facts, including identical timestamp and
  size edge cases.
- Persisted caches exclude source fragments and literal values, with atomic clearing
  and automatic cleanup of older source-bearing cache formats.
- Full and incremental exclude-glob behavior now matches, with bounded processing
  and correct navigation across local, remote, and virtual workspaces.

## 0.14.0

Understand the blast radius before changing an Apex method signature.

- New **Impact of Changing This Method** command in the editor context menu and
  command palette. It reports five source-linked sections: confirmed direct callers
  that break, uncertain callers that might break, interface/inheritance contract
  surfaces, metadata consumers, and sibling overloads.
- Overloaded methods are handled explicitly: placing the cursor on a declaration
  selects that exact overload; other positions show a signature picker. Call sites
  record whether overload resolution was exact, an arity tie, or a fallback, so
  uncertain evidence is never promoted to a confirmed break.
- Contract analysis includes implemented interfaces, the nearest overridden base
  declaration, descendant overrides, and callers through those surfaces. Flow
  metadata includes parent subflow chains, alongside LWC, Aura, Visualforce and
  other supported metadata consumers.
- Honest empty reports retain all five sections with zero counts. Impact results use
  the tree only; the Path Map and trace controls are hidden because the result is a
  risk inventory, not an execution path.

## 0.13.0

Confidence and responsiveness hardening for large, framework-heavy workspaces.

- **Possible edges no longer bury confirmed callers**: approximate callers/callees
  are grouped under a collapsed rollup by default. A new
  `apexCallGraph.showUnconfirmed` setting offers `rollup`, confirmed-only `hide`, or
  backward-compatible flat `expand` modes in both the tree and Path Map.
- **Common-name false positives are capped**: the unique-name fallback now requires
  matching arity and attaches only when at most five unresolved-receiver sites point
  at the sole declarer. Larger “magnet” names attach no guessed edges; caller traces
  instead show a target-scoped, inspectable unresolved-mention count.
- **Responsive scanning**: indexing is cancellable end to end, duplicate requests
  share one in-flight scan, newer requests coalesce to the latest target, file
  watchers drive incremental dirty-set scans, and cold workspaces over 200 Apex files
  parse in a bounded worker pool with safe inline fallback.
- **Counts-only diagnostics**: the new command and Scan Stats output report phase
  timings, cache reuse, worker activity, resolution reasons, and magnet suppression
  without copying paths, source, symbols, or arguments.
- **Flow-to-flow chains**: subflows now connect in both directions, including nested
  chains and cycle guards, without fabricating missing Flow nodes.
- Long, whitespace-free Apex identifiers stay contained in Path Map nodes and retain
  their complete tooltip/source label.

## 0.12.1

- Fixed the Marketplace/sidebar icon rendering at a quarter of its canvas (the
  artwork now fills the tile properly).


## 0.12.0

The Entry Points view — every way into your org, in one list.

- New **"Apex Call Graph: Entry Points"** section in the Explorer sidebar: a
  browsable catalog of everything the platform (or a user) can invoke —
  triggers (with object + events), `@AuraEnabled`, `@InvocableMethod`,
  REST/SOAP endpoints, async jobs (Batchable `start`/`execute`/`finish`,
  Queueable, Schedulable, `@future`), Email Services, install/auth handlers,
  Flows (with their trigger type and object), and Anonymous Apex scripts.
- Each entry click-jumps to its declaration and offers an inline
  **"What Does This Call?"** action — start a forward trace straight from the
  entry point. Grouped with counts, package labels where relevant, test
  classes excluded.
- Built as a pure read over the existing index (about 1 ms) — no change to any
  trace output, verified byte-identical.


## 0.11.0

Dynamic dispatch through constants, and smarter generic DML.

- **`Type.forName` follows literals wherever they provably live**: a
  single-assignment local, a `static final String` constant (own class or
  `OtherClass.CONST`), or a ternary of two literals (both candidates edged) —
  all marked `~ dynamic`. Params, reassigned variables, concatenation and
  cross-method flow still honestly don't resolve. Namespaced literal values
  (`'ns.Class'`) land on the managed external node, never a same-named local
  class.
- **Generic-collection DML narrows itself**: a `List<SObject>` that gets
  `add(new Invoice__c(...))` / `addAll(typedList)` in the same method links its
  `insert`/`update` to those objects' triggers and record-triggered Flows
  (marked `~`), replacing the generic marker. No in-method evidence — the
  honest "DML on unresolved SObject type" marker stays.
- Docs and examples are now sourced exclusively from the purpose-built fictional
  corpora.


## 0.10.0

Deeper chains, Visualforce methods.

- **Fluent chains now resolve up to 12 segments** (previously 4) — long builder
  chains like `q.selectFields().whereRegion()....build()` land on the right
  method, with a cycle guard so a return-type loop degrades to no edge instead
  of a guess. Beyond 12, still an honest drop.
- **Visualforce action bindings are method-level**: `action="{!save}"` on
  `apex:page`, `commandButton`, `commandLink`, `actionFunction`, `actionSupport`
  and `actionPoller` now edges to the exact method — attached to whichever of
  the page's controller/extension classes actually declares it (inherited
  counts; ambiguous or unknown falls back to class level, never fabricated).
  Value bindings (`value="{!prop}"`) remain out of scope.
- Internal hardening: the engine now clamps its own depth/node limits
  (defense-in-depth for future direct-invocation surfaces).


## 0.9.0

Start shallow, expand on click — plus an icon and real settings.

- **Progressive depth**: traces now start 2 levels deep (configurable). Frontier
  nodes show a **"+N more callers"** pill; expanding a node in the tree lazily
  loads its next level, and clicking a pill on the Path Map grows the graph in
  place without resetting your pan/zoom. Expanding everything reproduces exactly
  the old full-depth result — verified by test.
- **Settings, finally**: `apexCallGraph.initialDepth` (default 2), `expandStep`,
  `maxDepth`, `maxNodes`, and `excludeGlobs` under Settings → Apex Call Graph.
  Set `initialDepth` to `maxDepth` for the old show-everything behavior.
- **Marketplace icon**: the listing (and your extensions sidebar) now carries the
  family design — callers converging into the traced symbol.

## 0.8.0

Managed packages become part of the graph.

- **External nodes**: references into managed namespaces (`zenq.Billing.charge()`,
  `kwx__Ledger__c` DML, namespaced LWC imports, Flow actions and Custom Metadata
  values) now appear as first-class `managed: <ns>` nodes instead of anonymous
  "unresolved" counts. Terminal going forward (package source isn't analyzable) —
  but fully **traceable as targets**: trace `zenq.Billing.charge` and see every
  local call site, LWC import, and Flow action in your org that touches it.
- **Own-org namespace**: if `sfdx-project.json` declares a namespace, references
  prefixed with it resolve to your local classes and objects — never fabricated
  as a foreign package.
- **Local triggers on managed objects** (`trigger X on ns__Object__c`) participate
  in DML linkage exactly like local objects.
- Honest headers split the counts: "N unresolved · M managed-package refs (ns, …)".
- Precedence is pinned by tests: a local class named like a namespace still wins
  when it genuinely resolves; two-segment ambiguous calls stay unresolved rather
  than guessing; platform types never become externals. Everything else verified
  byte-identical against the published 0.7.1 artifact.

## 0.7.1

Precision patch, driven by an independent hard-mode validation corpus
(enterprise naming, managed-package references, factory indirection, 60-way
fan-in). Ten confirmed findings fixed, each pinned as a regression test:

- **No more phantom edges from managed-package references**: `ns.Class.method()`
  and namespaced LWC imports no longer attach to unrelated local classes that
  happen to share the bare name — they are counted as unresolved instead of
  fabricating a confident edge.
- **Trigger-framework hooks stop reading as dead code**: template-method
  self-dispatch (`this.beforeInsert()` in a virtual base) now fans out to
  subclass overrides (`~ override`), so "Who calls this?" on your handler logic
  answers truthfully.
- **Unique-name fallback hardened**: `Type`-typed receivers and collection
  accessors (`map.get(...)`, `list.add(...)`) can no longer poison it.
- **Forward traces fixed**: call sites now jump to the actual calling line
  (not the target's declaration), implementers appear as direct children under
  interface dispatch, and generic-typed DML shows an honest "DML on unresolved
  SObject type" marker instead of silently dropping.
- **Cap honesty**: a node cut off by the node cap is marked truncated — never
  painted as a false "root".
- Existing behavior elsewhere is verified byte-identical against the published
  0.7.0 artifact (site-level edge diff on 12 fixed targets).

## 0.7.0

Both directions, and multi-package truth.

- **Forward tracing** — new command **"What Does This Call?"** (plus a direction
  toggle on the Callers view): trace what a method *sets off*, downstream. The
  transaction story works forward too — an `update orders;` statement flows into the
  object's triggers and record-triggered Flows; async scheduling flows into the job's
  `execute`; `throw` statements end at the exception class; and every method shows an
  honest aggregated "N unresolved sites" leaf instead of hiding what static analysis
  can't follow. The Path Map mirrors accordingly (target left, callees flowing right).
- **Tree orientation toggle** — prefer entry points at the top, flowing *down* into
  your target in execution order? Toggle **entry-first** orientation on the Callers
  view (the default stays the classic stack-trace style; your choice is remembered
  per workspace).
- **Multi-package awareness** — `sfdx-project.json` package directories are read;
  duplicate class names across packages are no longer silently dropped: resolution
  prefers the referring file's package, then the default package, and genuinely
  ambiguous references fan out to all candidates marked `~ ambiguous`. Nodes from a
  different package than your target carry a package badge, and the picker labels
  duplicated names with their package.
- Workspaces without `sfdx-project.json` behave exactly as before — verified
  bit-identical, as is the existing callers-direction output.

## 0.6.0

Hardening round, driven by two independent principal-level reviews.

- **Big-graph performance**: caller trees are now memoized DAGs — a subtree is
  expanded once per trace and later occurrences become `↪ seen elsewhere` reference
  nodes (own call sites kept, subtree not repeated), with a fair 2,000-node cap.
  A pathological fan-in case measured at 5.4 s / 3 GB before now runs in ~18 ms /
  under 1 MB. The path map shrinks accordingly.
- **Missing-caller fix**: calls through an interface now also reach *overrides in
  subclasses of implementers* (`BaseHandler implements IHandler` + `ConcreteHandler
  extends BaseHandler` — tracing the override previously showed nothing).
- **The marquee data is finally visible inline**: every call site row shows its
  arguments bound to parameter names and, for overloaded targets, the resolved
  overload signature — previously hover-only (and `overloadSig` was rendered nowhere).
- **Honest results**: zero-caller traces say so ("likely an entry point or unused
  code"); a header counts call sites workspace-wide that could not be resolved
  (dynamic/platform/deep-chain); `◉ root` marks nodes with no known caller.
- **Readable badges**: every via kind and marker (`~`, `↺`, `🛡`, `↪`, `◉`) has a
  hover explanation in the tree; the QuickPick no longer leaks `<init>`/`(init)`
  internals (constructors are labeled as such); an ambiguous cursor position asks
  instead of silently tracing the wrong symbol.
- **Freshness & cache**: the path map re-scans on open (never stale after edits);
  cache validity now checks file size as well as mtime.
- **First-run experience**: the Callers view is always present with a welcome panel
  ("Trace a Class or Method") before any results exist.
- **Docs truth**: the README hero is a verbatim engine transcript, and the disk
  cache's location and contents are documented.
- Internal: legacy v1 lexical engine removed (~170 dead lines), duplicated
  type-resolution walks consolidated, metadata scanner hardened against
  pathological inputs.

## 0.5.0

Renamed to **Apex Call Graph** (formerly "Apex Trace" — this is a static call graph,
not debug-log tooling). Final language-gap round:

- **Exception tracing**: trace an exception class and see every `throw` site
  (`via: throws`) plus the full caller chains above them — ancestors whose method
  would catch it (exact type, user-hierarchy supertype, or bare `Exception`) carry a
  `catches <Exc>` shield badge. Traversal continues past catchers (rethrow is
  unknowable); the badge is the information.
- **Platform events**: `EventBus.publish(new X__e(...))` is a `publish` caller of the
  event's trigger; platform-event-triggered Flows show their publish sites as children.
- **Async hops**: `System.enqueueJob(new X(...))`, `Database.executeBatch(new X(), n)`
  and `System.schedule(..., new X())` edge to `X.execute` (`via: async`) — async chains
  are method-precise, not just constructor references.
- **Anonymous Apex**: `.apex` script files are scanned as root callers.
- **`instanceof` narrowing**: when a declared type can't resolve a call but an
  `instanceof` check in the same method can, the edge is kept and labeled `~ narrowed`.
- **Interface inheritance**: dispatch through a parent interface fans out to
  implementers of all extending interfaces, including multi-parent diamonds.

## 0.4.0

The transaction story: traces now continue through DML.

- **DML → trigger linkage**: `insert`/`update`/`delete`/`undelete`/`upsert`/`merge`
  statements and their `Database.*` method forms become callers (`via: dml`) of every
  trigger on the target object with matching events (upsert maps to insert+update,
  merge to delete+update). Tracing a trigger — or anything under it — now continues
  up through the code that performs the DML. A handler doing DML on its own object is
  flagged as a cycle, not an infinite loop.
- **Record-triggered Flows join the story**: a Flow node whose `<start>` matches the
  DML's object and operation shows those DML sites as its children — Flow nodes are no
  longer always leaves.
- **Dispatch maps resolved**: `handlerMap.get(key).handle()` and `steps[0].run()`
  resolve through collection generics (`Map<K,V>` → V, `List<T>` → T, `.values()`).
- **Virtual override fan-out**: a call on a base type also lists subclass overrides
  as `~ override` candidates, symmetrical to interface dispatch.
- **Dynamic dispatch**: `Type.forName('X')` with a literal name edges to X's
  constructor (`~ dynamic`); Custom Metadata records naming handler classes appear as
  `cmdt` metadata callers.
- **More platform entry points**: Email Services (`InboundEmailHandler`),
  `InstallHandler`/`UninstallHandler`, `Auth.RegistrationHandler`, `Comparable`
  (invoked by sort), `System.Finalizer`, Batchable `start`/`finish`.
- **Disk-persisted parse cache**: unchanged files skip parsing across sessions —
  large orgs pay the cold parse once.

## 0.3.0

Metadata callers, deeper Apex resolution, and the visual Path Map.

- **Non-Apex callers traced as roots**: Flows (apex actions — bare *and* dotted
  `actionName`, bare names cross-referenced to the class's `@InvocableMethod`),
  LWC (`@salesforce/apex` imports, jest mocks excluded), Aura (markup `controller=`
  paired with `c.method` calls), OmniScript / Integration Procedure Remote Actions
  (Vlocity DataPack JSON and `.os-meta.xml`), and Visualforce `controller`/`extensions`.
  They appear as terminal `metadata` nodes in the tree and the map.
- **Path Map** (`Apex Call Graph: Show Path Map`): interactive execution-path graph —
  entry roots flow left-to-right into your target; hover a node for its call sites
  and arguments; click to jump to source. Fully offline webview.
- **Property accessors are real call targets**: `quote.Status = x` shows up as a
  caller of `(set Status)` (explicit and auto-implemented `{ get; set; }` styles),
  with `value:` argument rendering.
- **Type-aware overload resolution**: each call site now carries an `overloadSig`
  (e.g. `calculatePrice(String)`), picked by literal/declared/inheritance-aware
  argument typing.
- **Smarter receivers**: fluent chains resolved through return types (up to 4
  segments, degrading honestly past that), cast receivers `((Type) x).m()`,
  ternary receivers.
- Added a 117-file synthetic example workspace for reproducible correctness and
  performance checks; the complete workspace cold-indexes in ~80 ms.

## 0.2.0

Semantic engine — the tree is now method-level, with arguments.

- **Real Apex parser** (`@apexdevtools/apex-parser`, the open-source ANTLR grammar —
  pure JS, still fully offline) replaces lexical scanning as the primary engine.
- **Method-level callers**: trace `Cls.method`, not just the class. Cursor on a method
  name traces that method directly; QuickPick offers both classes and methods.
- **Arguments at every call site**: each site shows the actual arguments bound to the
  target's parameter names, e.g. `applyDiscount(oppId: opps[0].Id, pct: 0.15)`.
- **Typed resolution**: instance calls resolve through declared types of locals, params
  and fields (with inheritance); static calls, constructors (`new` → `<init>`),
  `this()`/`super()` chains, interface dispatch (fanned out to implementers, marked
  approximate `~`), overloads (arity-matched), inner classes (`Outer.Inner`).
- **Edge provenance badges**: every caller edge is labeled how it was resolved —
  typed / static / new / this / super / interface / unique-name / lexical.
- **Method-level entry points**: `@AuraEnabled`, `@InvocableMethod`, `@future`,
  `@HttpGet`…, `webservice`, and Batchable/Queueable/Schedulable `execute()` now badge
  the specific method, plus trigger headers as before.
- **Incremental cache**: unchanged files are not re-parsed between runs (mtime-based).
- The v1 lexical engine remains as automatic fallback for files with syntax errors
  (edges marked `lexical`).

## 0.1.0

Initial release.

- **Who Calls This?** — reverse caller tree for the class (or method) under the cursor,
  expanded transitively up to entry points: triggers (with object + events),
  `@AuraEnabled`, `@InvocableMethod`, `@RestResource`, `webservice`,
  Batchable / Queueable / Schedulable, `@future`.
- Call-site previews with click-to-jump; test classes marked and sorted last;
  cycle-safe; depth-capped at 8.
- Method filter: cursor on a method name narrows direct callers to files calling it
  and adds those lines as jump targets (lexical heuristic).
- Offline lexical engine: comment/string stripping, member-access exclusion,
  case-insensitive matching, `.sfdx`/`.sf` platform stubs excluded.

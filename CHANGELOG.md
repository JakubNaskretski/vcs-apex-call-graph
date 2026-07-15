# Changelog

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
- Ships with a 117-file advanced example org (`adv-org`) as its ground-truth corpus;
  entire corpus cold-indexes in ~80 ms.

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

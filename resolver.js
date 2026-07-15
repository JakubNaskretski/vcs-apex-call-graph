'use strict';
// Semantic (method-level) Apex call-graph engine — rework against the FROZEN
// contract (see task brief). Pure data-in/data-out: no vscode, no fs. Input
// is FileFacts[] as produced by parser.js (agent A); this file never depends
// on parser.js's implementation, only its documented output shape.
//
// ponytail: this replaces the earlier draft that was written against an
// ad-hoc, self-invented FileFacts shape (parser.js didn't exist yet at the
// time). That draft's resolution *logic* (type-env lookup, inheritance walk,
// interface fan-out, unique-name fallback, platform denylist, lexical
// fallback tokenizing) is salvaged almost verbatim below — only the data
// shapes and a handful of resolution-order details changed to match the
// frozen contract exactly.
//
// =========================================================================
// Frozen contract (reproduced here for reference; see task brief for the
// authoritative text) — this module trusts parser.js to produce:
//
// FileFacts = { path, kind:'class'|'trigger', name, parseError:string|null,
//               triggerInfo:{object,events}|null, types:[TypeFacts] }
// TypeFacts = { name, qualified, isInterface, isEnum, extendsType,
//               implementsTypes, annotations, fields, properties, methods }
// MethodFacts = { name, isCtor, isStatic, returnType, line, endLine,
//                 annotations, modifiers, params, locals, calls }
// CallFacts = { kind:'dot'|'bare'|'new', receiver, method, argTexts,
//               lineText, line, col }
//
// One deliberate extension beyond the literal FileFacts shape: the
// PARSE-ERROR FALLBACK rule requires the raw source text of a file whose
// parseError is set, and this module has no other way to obtain it (no fs
// access, pure data-in/data-out). We read `file.text` defensively — present
// when parser.js echoes its input back on a parse failure, silently skipped
// (no lexical edges for that file) if absent. This is the only place this
// module reads a field not listed in the frozen FileFacts shape.
//
// =========================================================================
// Interpretive decisions on ambiguous/must-fix points from the adversarial
// spec review (each grounded in "contract wins; simplest reading; note it"):
//
// 1. For-each / catch-clause locals: parser.js's concern (must add
//    enterEnhancedForControl / enterCatchClause as extra `locals` sources).
//    This module treats MethodFacts.locals generically — any local parser.js
//    hands us (regular declarations, for-each vars, caught exceptions)
//    participates in TYPE ENV lookup identically. No special-casing needed
//    here; test-resolver.js's fixtures include a for-each-shaped local to
//    confirm this falls out for free.
//
// 2. Constructor overload identity: kept as an INTENTIONAL merge, per the
//    review's option A — and this is actually consistent with the whole
//    Index shape, not just constructors: `methodCallers` is keyed
//    `lowerQualified#lowerMethod` with NO arity component for ANY method
//    (the `target` shape passed to buildCallerTree has no arity field
//    either), so every overload of every method — not only constructors —
//    already collapses onto one key. `ClassMeta.methods` for a class with
//    constructors gets exactly ONE synthetic entry named '<init>', built
//    from the FIRST declared constructor's params/line (arbitrary but
//    deterministic, first-in-source-order). Individual `new` call sites
//    still get accurate per-overload argsRendered at *render* time (see
//    shapeSites) by matching the call's arg count against ALL declared
//    ctor signatures in `ClassMeta.typeFacts` — that raw data is preserved
//    specifically so this remains possible despite the merge.
//
// 3. isTest cascade: MethodMeta.isTest = classIsTest OR method's own
//    @isTest/testMethod marker (must-fix #3, implemented literally).
//
// 4. Annotation text shape: parser.js is contracted to emit bare lowercased
//    names, but `annBare()` defensively strips a trailing `(...)` anyway —
//    cheap, harmless if parser.js already normalizes, load-bearing if not.
//
// 5. Property/field accessor scopes ('(get X)'/'(set X)') can only ever be
//    call SOURCES, never call TARGETS (no CallFacts kind addresses them).
//    Documented as a permanent limitation; suggestTargets() suppresses them
//    so users are never offered a target that can never show a caller.
//
// 6. Inner-class bare-name self-reference: resolveType() checks the calling
//    method's own enclosing-scope chain (innermost to outermost) BEFORE the
//    global once-only bare-simple-name table, so `Inner` resolves correctly
//    from inside `Outer` regardless of same-named `Inner` types elsewhere.
//
// 7. Denylist-vs-shadowing precedence: the platform denylist is checked ONLY
//    after both rule 5 (receiver-is-a-known-class) and rule 6 (typed local/
//    param/field) have failed to resolve to an indexed user class. A local
//    variable named e.g. `database` typed to a real user class always wins.
//
// 8. SOQL bind-expression calls: parser.js's concern (grammar walk). Not
//    reachable from this module's inputs; noted, not handled here.
//
// "should"-level items actually implemented because they're cheap and
// directly improve resolver correctness (not just noted):
//   - implementsTypes / extendsType normalization (namespace + generics +
//     case) via normalizeTypeName / lastSegmentLower — required for the
//     ENTRIES batchable/queueable/schedulable match to ever fire at all.
//   - Batchable/Queueable/Schedulable execute() is matched by name+arity
//     and walks the extends chain to find an inherited implementation,
//     attaching the entry to whichever class actually declares it.
//   - Cast-expression and `new Type(...).method()` chained receivers get a
//     lightweight text-pattern typed resolution ahead of the unique-name
//     fallback (best-effort: CallFacts only gives us receiver text, not an
//     AST node, so this is a regex heuristic, not a structural check).
//   - Duplicate qualified-class-name collision: first-parsed file (i.e.
//     first `FileFacts` in the input array, in order) wins the Map slot;
//     later same-name types are pushed to `duplicates` and otherwise
//     ignored for resolution (their calls are never walked).
//   - classCallers rollup scope: populated ONLY by rule 1 ('new') and the
//     lexical parse-error fallback — rules 2-7 never touch it. Rule 2
//     (this()/super() constructor chaining) is additionally routed into
//     classCallers here (beyond the rule's literal text) so that
//     buildCallerTree's class-level rollup — which deliberately excludes
//     the '<init>' bucket from its "methodCallers of ALL its methods" sweep
//     to avoid double-counting 'new' sites — doesn't silently lose
//     constructor-chaining callers at the class level. Documented as a
//     deliberate extension for consistency, not literal-rule-2 text.
//
// "should"/"note"-level items intentionally left as-is (documented, not
// implemented): rule 6's "simple identifier" test is a text regex (no AST
// node available here); ClassMeta.kind stays 'class'|'trigger'|'anonymous'
// per the (now G4-extended) shape (no 'interface'|'enum' value) even though
// TypeFacts carries isInterface/isEnum — interface-ness is read directly off
// `typeFacts.isInterface` where the resolution rules need it (rule 6's
// interface fan-out), so nothing is actually lost, just not surfaced on
// ClassMeta.kind itself. TypeFacts.extendsType stays a single string for
// backward compat (first extends-list entry, classes only ever have one
// anyway); G6 added TypeFacts.extendsTypes (full raw list) specifically so
// interface-extends-interface diamonds fan out to ALL parents, not just the
// first — see the G6 block below.
// =========================================================================

const apexindex = require('./apexindex');

const DEFAULT_MAX_DEPTH = 8;
// H1: hard total-node cap for one buildCallerTree call (opts.maxNodes
// overrides). See buildCallerTree's ctx/queue machinery for how this is
// enforced breadth-first-fairly rather than by fully draining one branch.
const DEFAULT_MAX_NODES = 2000;
// H4: exact TreeResult.note text for a trace that resolved to a real target
// but found zero callers (root.children.length === 0 after both the Apex
// tree AND any metadata/flow children are folded in).
const ZERO_CALLER_NOTE = 'No callers found — this is likely an entry point or unused code.';

// Verbatim from the frozen spec's PLATFORM DENYLIST clause.
const PLATFORM_DENYLIST = new Set([
  'system', 'database', 'test', 'schema', 'math', 'json', 'string', 'integer',
  'long', 'decimal', 'double', 'boolean', 'date', 'datetime', 'time', 'id',
  'blob', 'object', 'list', 'map', 'set', 'trigger', 'userinfo', 'limits',
  'type', 'enum', 'eventbus', 'messaging', 'http', 'httprequest',
  'httpresponse', 'restcontext', 'restrequest', 'restresponse', 'apexpages',
  'pagereference', 'url', 'crypto', 'encodingutil', 'site', 'network',
  'label', 'page', 'component', 'auth', 'cache', 'search', 'approval',
]);

const HTTP_ANNOTATIONS = new Set(['httpget', 'httppost', 'httpput', 'httpdelete', 'httppatch']);
// v0.4: 'override' (F3 virtual override fan-out) and 'dynamic' (F4a
// Type.forName) join the pre-existing approximate vias. 'dml' (F1) is
// deliberately NOT approximate -- the trigger genuinely does fire.
// v0.5: 'narrowed' (G3 instanceof-narrowing fallback) joins the approximate
// set -- branch polarity is never tracked (see tryNarrowedReceiver), so a
// narrowed-type edge is always a guess, never a certainty. The other three
// new v0.5 via values -- 'publish' (G1), 'throws' (G2), 'async' (G5) -- are
// all deliberately NOT approximate, per their own spec text: a platform
// event that got published genuinely does fire every trigger on its object;
// a throw statement genuinely does throw; an async enqueue genuinely does
// hand off to that job's execute().
const APPROX_VIA = new Set(['interface', 'unique-name', 'lexical', 'override', 'dynamic', 'narrowed']);

// F1: statement-form and Database.xxx() method-form DML ops this resolver
// understands, and the trigger event(s) each one activates. upsert maps to
// BOTH insert and update events (a single upsert DML statement can fire
// either depending on whether the record already exists); merge maps to
// BOTH delete and update events (the merged-away records fire delete-style
// events, the surviving record fires update-style events) -- per the v0.4
// spec, a single merge/upsert statement can therefore produce edges to
// MULTIPLE distinct triggers on the same object.
const DML_OPS = new Set(['insert', 'update', 'delete', 'undelete', 'upsert', 'merge']);

function opToTriggerEvents(op) {
  switch (op) {
    case 'insert':
      return ['before insert', 'after insert'];
    case 'update':
      return ['before update', 'after update'];
    case 'delete':
      return ['before delete', 'after delete'];
    case 'undelete':
      return ['after undelete'];
    case 'upsert':
      return ['before insert', 'after insert', 'before update', 'after update'];
    case 'merge':
      return ['before delete', 'after delete', 'before update', 'after update'];
    default:
      return [];
  }
}

// F1(b): a record-triggered flow's recordTriggerType -> which DML ops on its
// object become its children. CreateAndUpdate is the union of Create+Update.
function flowOpsForRecordTriggerType(rtRaw) {
  const t = lc(rtRaw);
  if (t === 'create') return ['insert', 'upsert'];
  if (t === 'update') return ['update', 'upsert', 'merge'];
  if (t === 'createandupdate') return ['insert', 'upsert', 'update', 'merge'];
  if (t === 'delete') return ['delete', 'merge'];
  return [];
}

// F1: 'List<Acme_Order__c>' / 'Acme_Order__c[]' / 'Acme_Order__c' -> the bare
// (lowercased) SObject API name, stripping a List<>/Set<> wrapper or a
// trailing array suffix first -- a DML statement's target can be either a
// single record or a collection, and the object identity is the same either
// way.
function dmlObjectHead(rawType) {
  if (!rawType) return null;
  let s = String(rawType).trim();
  const listMatch = s.match(/^(?:List|Set)\s*<\s*([^<>]+)\s*>$/i);
  if (listMatch) s = listMatch[1];
  s = s.replace(/\[\]\s*$/, '').trim();
  if (!s) return null;
  return lastSegmentLower(s);
}

// F2: splits a generic argument list on top-level commas only (depth-aware,
// so a nested 'Map<String,List<Foo>>' inner arg isn't split on its own
// internal comma). This corpus never nests that deep, but staying
// depth-aware is cheap and avoids a silent mis-split if it ever does.
function splitTopLevelCommas(s) {
  const out = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '<') depth++;
    else if (c === '>') depth--;
    else if (c === ',' && depth === 0) {
      out.push(s.slice(start, i));
      start = i + 1;
    }
  }
  out.push(s.slice(start));
  return out;
}

// F2: Map<K,V>.get()->V, Map<K,V>.values()->List<V> (kept chainable), and
// List<T>/Set<T>.get()->T. Returns null (not '') whenever rawTypeGeneric
// isn't a recognized generic-collection shape, or accessorNameLower isn't
// one this particular collection kind supports -- callers fall through to
// the ordinary declared-method-returnType chain walk in that case, exactly
// as before this feature existed.
function applyCollectionAccessor(rawTypeGeneric, accessorNameLower) {
  const s = String(rawTypeGeneric || '').trim();
  const m = s.match(/^([A-Za-z_][\w.]*)\s*<\s*([\s\S]+)\s*>$/);
  if (!m) return null;
  const headLower = lastSegmentLower(m[1]);
  const parts = splitTopLevelCommas(m[2]);
  if (headLower === 'map') {
    if (accessorNameLower === 'get' && parts.length >= 2) return parts[1].trim();
    if (accessorNameLower === 'values' && parts.length >= 2) return `List<${parts[1].trim()}>`;
    return null;
  }
  if (headLower === 'list' || headLower === 'set') {
    if (accessorNameLower === 'get' && parts.length >= 1) return parts[0].trim();
    return null;
  }
  return null;
}

// F2: 'name[idx]' -- a plain subscript receiver with no further chaining
// (e.g. 'steps[0]'). Deliberately does not compose with parseChainSegments'
// '.method()' shape -- this corpus/spec only asks for the bare form.
const SUBSCRIPT_RE = /^([A-Za-z_]\w*)\s*\[\s*[^[\]]*\s*]$/;

// --- small text helpers --------------------------------------------------

function lc(s) {
  return (s || '').toLowerCase();
}

// Defensive strip of a trailing `(...)` args list, in case an annotation
// ever arrives as raw source text instead of a bare name (see decision #4).
function annBare(raw) {
  const s = String(raw || '');
  const p = s.indexOf('(');
  return lc((p === -1 ? s : s.slice(0, p)).trim());
}

function stripGenerics(raw) {
  if (!raw) return '';
  const s = String(raw).trim();
  const lt = s.indexOf('<');
  return lt === -1 ? s : s.slice(0, lt).trim();
}

// Keeps dots (for qualified/inner-class lookups), strips generics, lowers.
function normalizeTypeName(raw) {
  return lc(stripGenerics(raw));
}

// Last dotted segment only — for interface bare-word matching
// (Database.Batchable<sObject> -> batchable) and platform-denylist head
// checks.
function lastSegmentLower(raw) {
  const s = stripGenerics(raw);
  const segs = s.split('.');
  return lc(segs[segs.length - 1]);
}

const SIMPLE_IDENT_RE = /^[A-Za-z_]\w*$/;

// 'should'-level bonus (see header decision list): cast-expression and
// chained-new receivers get typed resolution via lightweight text patterns.
// Tolerant of parser.js's getText()-without-whitespace concatenation
// warning from the cheat sheet (`\s*`, not a required space).
function castOrNewChainType(receiverRaw) {
  const s = String(receiverRaw || '').trim();
  // BUG FIX (finding #4): Apex/Java requires an EXTRA outer paren layer to
  // call a method on a cast expression's result -- `((Type) expr).method()`
  // -- so the sliced receiver text starts with `((`, not a single `(`. The
  // old regex `^\(\s*([A-Za-z_]...)\s*\)` required a letter immediately
  // after the first `(`, so it could only ever match the never-occurring
  // single-paren form and was dead code for real cast-call sites. `\(+`
  // consumes one or more leading opens (whichever depth the receiver was
  // sliced at) before the actual `(Type)` cast pair.
  const castMatch = s.match(/^\(+\s*([A-Za-z_][\w.]*)\s*\)/);
  if (castMatch) return castMatch[1];
  const newMatch = s.match(/^new\s*([A-Za-z_][\w.]*)/i);
  if (newMatch) return newMatch[1];
  return null;
}

// =========================================================================
// A3 receiver-upgrade text patterns (pure, no closure state needed)
// =========================================================================

// '(cond ? a : b)' -- both branches must be SIMPLE identifiers for the
// ternary bonus to apply (a call or literal on either side isn't handled).
// Greedy [\s\S]* lets the regex backtrack past any '?'/':' inside the cond
// expression itself and land on the actual trailing ternary operator.
const TERNARY_RE = /^\(\s*[\s\S]*\?\s*([A-Za-z_]\w*)\s*:\s*([A-Za-z_]\w*)\s*\)$/;

// 'a.b()' / 'a.b().c()' / 'Cls.b()' -- a bare head identifier followed by 1+
// `.method(args)` segments with no nested parens inside any single segment's
// arg list (best-effort text heuristic, same spirit as castOrNewChainType;
// a receiver that doesn't fit this shape simply fails to match, no throw).
function parseChainSegments(receiverRaw) {
  const s = String(receiverRaw || '').trim();
  const m = s.match(/^([A-Za-z_]\w*)((?:\.[A-Za-z_]\w*\([^()]*\))+)$/);
  if (!m) return null;
  const head = m[1];
  const rest = m[2];
  const segRe = /\.([A-Za-z_]\w*)\(([^()]*)\)/g;
  const segments = [];
  let sm;
  while ((sm = segRe.exec(rest))) segments.push(sm[1]);
  return { head, segments };
}

// A4 overload-picking: best-effort literal/identifier arg typing. Returns
// { head: lowercasedTypeHeadOrNull, wildcard: boolean }. `head` is the last
// dotted segment only (mirrors lastSegmentLower on the param side), and null
// means "couldn't infer anything" (assignable-unknown tier), not "no type".
function classifyArgLiteral(argText) {
  const s = String(argText == null ? '' : argText).trim();
  if (!s) return { head: null, wildcard: false };
  if (/^null$/i.test(s)) return { head: null, wildcard: true };
  if (/^".*"$/.test(s) || /^'.*'$/.test(s)) return { head: 'string', wildcard: false };
  if (/^-?\d+\.\d+$/.test(s)) return { head: 'decimal', wildcard: false };
  if (/^-?\d+$/.test(s)) return { head: 'integer', wildcard: false };
  if (/^(true|false)$/i.test(s)) return { head: 'boolean', wildcard: false };
  return null; // not a recognizable literal -- caller tries new/identifier next
}

// =========================================================================
// H7(b): consolidated extends-chain walker
// =========================================================================
// Every "walk classLower, then its extends chain, ancestor by ancestor"
// loop in this file used to be hand-rolled separately (findMethodOwners,
// findReceiverType, findDeclaredOrInherited, findDeclaredMethodRaw,
// classIsSameOrSubtypeOf, and resolvePropCall's property lookup inside
// buildSemanticIndex's closure; isExceptionTargetClass and
// isAncestorOfException outside it) -- six-plus copies of the same
// seen-guarded while-loop, differing only in what they did at each step and
// whether they stopped early. This single helper replaces all of them.
//
// Walks startLower's OWN class first, then climbs via each class's cached
// `extendsLower` field -- resolved once, during buildSemanticIndex's
// directSubclasses pass (see `subCm.extendsLower = resolveType(...) ||
// null`), so this never needs a live resolveType() re-resolution of its
// own. Cycle-guarded via a `seen` Set of classLower strings, same as every
// original loop. Calls visitFn(cm, classLower) at each step; the walk stops
// the moment visitFn returns anything other than undefined, and that value
// is returned. Returns undefined if the chain is exhausted (or a step's
// class isn't indexed) without visitFn ever returning non-undefined --
// callers that want a boolean/fallback coerce accordingly (see call sites).
//
// `indexLike` only needs a `.classes` Map keyed by lowerQualified ->
// ClassMeta -- the real `index` object satisfies this for the two
// query-time (post-build) callers; buildSemanticIndex's own callers pass a
// small `{ classes }` wrapper around its own in-progress `classes` Map
// (same Map reference throughout, so this sees every class pass A registers).
function walkExtendsChain(indexLike, startLower, visitFn) {
  let cur = startLower;
  const seen = new Set();
  while (cur && !seen.has(cur)) {
    seen.add(cur);
    const cm = indexLike.classes.get(cur);
    if (!cm) return undefined;
    const result = visitFn(cm, cur);
    if (result !== undefined) return result;
    cur = cm.extendsLower || null;
  }
  return undefined;
}

// =========================================================================
// buildSemanticIndex
// =========================================================================

function buildSemanticIndex(factsList) {
  const classes = new Map(); // lowerQualified -> ClassMeta
  const methodCallers = new Map(); // 'lowerQualified#lowerMethod' -> CallSite[]
  const classCallers = new Map(); // lowerQualified -> CallSite[]
  // H7(b): lightweight wrapper so walkExtendsChain can share its one
  // implementation between this closure (live-building `classes`) and the
  // post-build `index` object query-time callers use -- same Map reference
  // throughout, so this always sees the current state of `classes`.
  const classesLike = { classes };
  const parseFallbacks = [];
  const duplicates = [];
  // H4: counts call sites this pass positively identifies as DROPPED --
  // an engine limitation, not a deliberate exclusion (the platform denylist
  // doesn't count: that's an intentional "we know what this is and choose
  // not to trace it", not a gap). Three categories, incremented at their
  // own call sites below: (1) a 'dot' call whose receiver never resolved to
  // anything at all -- not a class, not a typed shadow, not a complex-
  // receiver bonus, not even the unique-name fallback (resolveDotOther);
  // (2) a chained receiver exceeding the documented 4-segment walk cap
  // (resolveChainedReceiver); (3) Type.forName(...) called with a
  // non-string-literal (variable) argument, whose runtime value can never
  // be known statically (handleTypeForName). Surfaced on the returned index
  // as `stats.unresolvedSites` and threaded through to every TreeResult
  // (H4's "N call sites workspace-wide could not be resolved" header).
  let unresolvedSitesCount = 0;

  // Cross-class lookup tables, built alongside `classes` in pass A.
  const simpleNameIndex = new Map(); // lc(simpleName) -> lowerQualified[]
  const methodNameIndex = new Map(); // lc(methodName) -> Set<lowerQualified> (non-ctor only)
  const interfaceImplementers = new Map(); // lc(interfaceSimpleName) -> lowerQualified[]

  // ---- pass A: register ClassMeta + MethodMeta for every parseable type --
  for (const file of factsList || []) {
    if (file.parseError) continue; // handled in the lexical fallback pass below
    const isTriggerFile = file.kind === 'trigger';
    const isAnonymousFile = file.kind === 'anonymous';
    for (const tf of file.types || []) {
      const qualifiedLower = lc(tf.qualified);
      if (classes.has(qualifiedLower)) {
        duplicates.push(tf.qualified);
        continue; // first-parsed file wins the slot (decision: duplicate collision policy)
      }

      const classIsTest = (tf.annotations || []).map(annBare).includes('istest');
      const methods = [];

      // Constructors: merged into one synthetic '<init>' MethodMeta (decision #2).
      const ctors = (tf.methods || []).filter((m) => m.isCtor);
      if (ctors.length) {
        const first = ctors[0];
        methods.push({
          name: '<init>',
          params: (first.params || []).map((p) => ({ name: p.name, type: p.type })),
          isStatic: false,
          line: first.line || 0,
          entries: [], // constructors are never entry points
          isTest: methodIsTest(first, classIsTest),
        });
      }

      // Regular methods (incl. synthetic '(init)'/'(get X)'/'(set X)' scopes
      // and, for a trigger pseudo-type, its single '(trigger)' method).
      for (const mf of tf.methods || []) {
        if (mf.isCtor) continue;
        const entries = computeAnnotationEntries(mf);
        if (Array.isArray(mf.entries) && mf.entries.length) entries.push(...mf.entries); // G4: parser-supplied labels (e.g. anonymous-script) merge in, not derived here
        if (isTriggerFile && mf.name === '(trigger)' && file.triggerInfo) {
          entries.push(`trigger on ${file.triggerInfo.object} (${(file.triggerInfo.events || []).join(', ')})`);
        }
        const mm = {
          name: mf.name,
          params: (mf.params || []).map((p) => ({ name: p.name, type: p.type })),
          isStatic: !!mf.isStatic,
          line: mf.line || 0,
          entries,
          isTest: methodIsTest(mf, classIsTest),
        };
        methods.push(mm);
        const nameLower = lc(mf.name);
        if (!methodNameIndex.has(nameLower)) methodNameIndex.set(nameLower, new Set());
        methodNameIndex.get(nameLower).add(qualifiedLower);
      }

      const cm = {
        name: tf.name,
        qualified: tf.qualified,
        path: file.path,
        kind: isTriggerFile ? 'trigger' : isAnonymousFile ? 'anonymous' : 'class', // G4: anonymous scripts get their own TNode kind
        // F1: needed to map a resolved DML target object back to the
        // trigger(s) registered on it (event-mapping matrix).
        triggerInfo: isTriggerFile ? (file.triggerInfo || null) : null,
        isTest: classIsTest,
        entries: [], // filled in pass C, after Batchable/Queueable/Schedulable attachment
        extendsType: tf.extendsType || null,
        implementsTypes: tf.implementsTypes || [],
        methods,
        typeFacts: tf,
      };
      classes.set(qualifiedLower, cm);

      const simpleLower = lc(tf.name);
      if (!simpleNameIndex.has(simpleLower)) simpleNameIndex.set(simpleLower, []);
      simpleNameIndex.get(simpleLower).push(qualifiedLower);

      for (const iface of tf.implementsTypes || []) {
        const ifaceSimple = lastSegmentLower(iface);
        if (!interfaceImplementers.has(ifaceSimple)) interfaceImplementers.set(ifaceSimple, []);
        interfaceImplementers.get(ifaceSimple).push(qualifiedLower);
      }
    }
  }

  // ---- resolveType: rawTypeName + the referencing scope's own qualified
  // name -> lowerQualified | null. Checked in this order: (1) the calling
  // scope's own enclosing-class chain, innermost to outermost — this is
  // what makes bare inner-class self-reference immune to unrelated
  // same-named inner classes elsewhere (decision #6); (2) exact
  // qualified/simple name as given; (3) globally-unique bare-simple-name
  // fallback.
  function resolveType(rawTypeName, currentQualifiedOriginalCase) {
    const norm = normalizeTypeName(rawTypeName);
    if (!norm) return null;
    if (currentQualifiedOriginalCase) {
      const curLower = lc(currentQualifiedOriginalCase);
      const parts = curLower.split('.');
      for (let i = parts.length; i >= 1; i--) {
        const scope = parts.slice(0, i).join('.');
        const candidate = `${scope}.${norm}`;
        if (classes.has(candidate)) return candidate;
      }
    }
    if (classes.has(norm)) return norm;
    const simple = lastSegmentLower(rawTypeName);
    const matches = simpleNameIndex.get(simple);
    if (matches && matches.length === 1) return matches[0];
    return null;
  }

  // F3: parent -> direct-subclass adjacency, built once now that every
  // class is registered and resolveType can resolve every extendsType
  // target. allDescendants() walks it transitively (DFS, cycle-guarded) so
  // override fan-out reaches every tier of a multi-level hierarchy, not
  // just direct children.
  const directSubclasses = new Map();
  for (const subCm of classes.values()) {
    if (!subCm.extendsType) {
      subCm.extendsLower = null; // v0.5/G2: needed by buildCallerTree's extends-chain walk
      continue;
    }
    const parentLower = resolveType(subCm.extendsType, subCm.qualified);
    // v0.5/G2: cache the resolved parent classLower directly on ClassMeta
    // (null when extendsType doesn't resolve to an indexed class -- e.g. a
    // class/interface extending the platform 'Exception' base, which is
    // never itself an indexed user type). buildCallerTree's
    // isExceptionTargetClass() walks this field to find whether a target
    // class's extends chain reaches bare 'Exception'.
    subCm.extendsLower = parentLower || null;
    if (!parentLower) continue;
    if (!directSubclasses.has(parentLower)) directSubclasses.set(parentLower, []);
    directSubclasses.get(parentLower).push(lc(subCm.qualified));
  }
  function allDescendants(ancestorLower) {
    const out = [];
    const seen = new Set([ancestorLower]);
    const stack = (directSubclasses.get(ancestorLower) || []).slice();
    while (stack.length) {
      const cur = stack.pop();
      if (seen.has(cur)) continue;
      seen.add(cur);
      out.push(cur);
      for (const child of directSubclasses.get(cur) || []) stack.push(child);
    }
    return out;
  }

  // =========================================================================
  // G6: interface-extends-interface transitive closure
  // =========================================================================
  // Pass A's interfaceImplementers population (above) registers each class
  // only under the interfaces it DIRECTLY implements (by that interface's
  // own bare simple name, matching how emitTypedOrInterfaceForClass looks
  // implementers up). An interface can itself `extends` MULTIPLE parents
  // (parser.js's TypeFacts.extendsTypes carries the FULL raw list for
  // interface types -- extendsType alone only keeps the first, which is
  // what caused every parent after the first in a diamond extends list to
  // silently vanish) -- an implementer of the CHILD interface therefore also
  // satisfies every interface the child transitively extends (through ANY
  // parent branch), and must be reachable from a variable typed to any of
  // those ancestor interfaces too. This block computes that closure now
  // that every type is registered and resolveType can resolve extends
  // chains, and additively propagates each implementer up the chain.
  const ifaceParents = new Map(); // ifaceQualifiedLower -> parentIfaceQualifiedLower[]
  for (const cmI of classes.values()) {
    if (!cmI.typeFacts.isInterface) continue;
    // Fall back to [extendsType] for older/degenerate TypeFacts that never
    // got an extendsTypes array (e.g. hand-built fixtures in tests).
    const rawParents =
      Array.isArray(cmI.typeFacts.extendsTypes) && cmI.typeFacts.extendsTypes.length
        ? cmI.typeFacts.extendsTypes
        : cmI.extendsType
          ? [cmI.extendsType]
          : [];
    if (!rawParents.length) continue;
    const parentLowers = [];
    for (const rawParent of rawParents) {
      const parentLower = resolveType(rawParent, cmI.qualified);
      if (!parentLower) continue;
      const parentCm = classes.get(parentLower);
      if (parentCm && parentCm.typeFacts.isInterface && !parentLowers.includes(parentLower)) {
        parentLowers.push(parentLower);
      }
    }
    if (parentLowers.length) ifaceParents.set(lc(cmI.qualified), parentLowers);
  }
  function ifaceAncestorsExclusive(ifaceQualifiedLower) {
    // BFS over ifaceParents from ifaceQualifiedLower UP through EVERY parent
    // branch, returning the union of every ancestor interface reachable
    // (NOT including ifaceQualifiedLower itself -- pass A already registered
    // direct implementers under their own directly-implemented interface's
    // simple name; this only needs to add the interfaces ABOVE that one).
    // Cycle-safe: `seen` guards against a (malformed/hostile) extends cycle.
    const out = [];
    const seen = new Set([ifaceQualifiedLower]);
    const queue = [...(ifaceParents.get(ifaceQualifiedLower) || [])];
    while (queue.length) {
      const cur = queue.shift();
      if (seen.has(cur)) continue;
      seen.add(cur);
      out.push(cur);
      const grandParents = ifaceParents.get(cur);
      if (grandParents) queue.push(...grandParents);
    }
    return out;
  }
  for (const cmI of classes.values()) {
    for (const iface of cmI.implementsTypes || []) {
      const ifaceLower = resolveType(iface, cmI.qualified);
      if (!ifaceLower) continue;
      for (const ancLower of ifaceAncestorsExclusive(ifaceLower)) {
        const ancCm = classes.get(ancLower);
        if (!ancCm) continue;
        const ancSimple = lc(ancCm.name);
        if (!interfaceImplementers.has(ancSimple)) interfaceImplementers.set(ancSimple, []);
        const list = interfaceImplementers.get(ancSimple);
        const implLower = lc(cmI.qualified);
        if (!list.includes(implLower)) list.push(implLower);
      }
    }
  }

  // F1: object (lowercased SObject API name) -> trigger ClassMeta[] declared
  // on it, built the same way -- every trigger's triggerInfo is already
  // attached to its ClassMeta by pass A above.
  const triggersByObject = new Map();
  for (const trigCm of classes.values()) {
    if (trigCm.kind !== 'trigger' || !trigCm.triggerInfo || !trigCm.triggerInfo.object) continue;
    const objLower = lc(trigCm.triggerInfo.object);
    if (!triggersByObject.has(objLower)) triggersByObject.set(objLower, []);
    triggersByObject.get(objLower).push(trigCm);
  }

  // F1(b): every valid DML site (object, op, caller) discovered during pass
  // B, keyed by object -- independent of whether it also matched a trigger,
  // since record-triggered-flow children need this even for objects with no
  // trigger at all on the matching op.
  const dmlSitesByObject = new Map();

  // G1(b): every valid EventBus.publish() site discovered during pass B,
  // keyed by the published __e object -- mirrors dmlSitesByObject exactly,
  // for the same reason (a platform-event-triggered flow node's children
  // must be reachable even independent of whether a trigger also matched).
  const publishSitesByObject = new Map();

  // G2: exception typeName/varName (lowercased, resolved-where-possible) ->
  // CallSite[] of every 'throw' statement that raises it. Populated during
  // pass B from MethodFacts.throwsSites.
  const throwers = new Map();

  // BUG FIX (finding #1): the old findMethodOwner() stopped climbing the
  // extends chain at the FIRST class declaring ANY same-named method,
  // regardless of arity -- so a subclass overload with a *different* arity
  // than the call site would steal the edge even when an ancestor's
  // overload is the one that actually matches (real Apex overload
  // resolution falls through to the inherited signature that fits). This
  // collects EVERY same-named method visible along the walk (own class
  // first, then ancestors when walkSuper) -- Apex doesn't hide inherited
  // overloads the way it hides overridden same-signature methods -- and
  // then narrows by call-site arity per the frozen spec's rule 6 text
  // ("overloads: prefer matching arity, else edge to ALL same-name
  // methods"). `callArity` undefined preserves the old arity-agnostic
  // behavior (first declared overload wins) for the one caller that
  // deliberately doesn't care (rule 7's unique-name fallback).
  // A4: infers a lowercased "type head" for one call-site argument text,
  // resolving simple identifiers through the SAME caller-side type env used
  // for receivers (findReceiverType is defined below but JS function
  // declarations hoist, so this forward reference is safe). `new X(...)`
  // args are typed by their class head directly (no need to resolve X to a
  // known class -- an unresolved/external X still gives a comparable head).
  function inferArgHead(argText, callerClassLower, methodFacts) {
    const literal = classifyArgLiteral(argText);
    if (literal) return literal;
    const cm0 = classes.get(callerClassLower);
    const cmQualified = cm0 ? cm0.qualified : null;
    const s = String(argText == null ? '' : argText).trim();
    const newM = s.match(/^new\s+([A-Za-z_][\w.]*)/i);
    if (newM) {
      // A4 subclass fix: also resolve the arg's concrete classLower (not
      // just its bare head string) so pickBestOverload can walk its extends
      // chain against each candidate param's type -- a head-string compare
      // alone can only ever recognize an EXACT type match, never IS-A.
      return { head: lastSegmentLower(newM[1]), wildcard: false, classLower: resolveType(newM[1], cmQualified) };
    }
    if (SIMPLE_IDENT_RE.test(s)) {
      const t = findReceiverType(callerClassLower, methodFacts, s);
      if (t) return { head: lastSegmentLower(t), wildcard: false, classLower: resolveType(t, cmQualified) };
    }
    return { head: null, wildcard: false, classLower: null }; // unresolvable expression -> assignable-unknown
  }

  // A4 subclass fix: walks descendantClassLower's OWN extends chain (starting
  // at the class itself, so passing the same class both ways is trivially
  // true) looking for ancestorClassLower. Used to recognize `new DogSub()`
  // as assignable to a `pick(AnimalBase a)` overload when DogSub extends
  // AnimalBase, rather than scoring it identically to a wholly-unrelated
  // type (e.g. VehicleBase).
  function classIsSameOrSubtypeOf(descendantClassLower, ancestorClassLower) {
    if (!descendantClassLower || !ancestorClassLower) return false;
    // H7(b): via walkExtendsChain -- stops (true) the moment the walk
    // reaches ancestorClassLower itself (own class counts, so X is always
    // "same-or-subtype-of" X).
    return !!walkExtendsChain(classesLike, descendantClassLower, (cm, cur) => (cur === ancestorClassLower ? true : undefined));
  }

  // A4: among same-arity overload candidates, score each by how well its
  // declared param types match the call site's inferred arg types (exact
  // type match > assignable-subtype (arg class extends the param's class,
  // directly or transitively) > assignable-unknown > wildcard/mismatch, per
  // param, summed across params -- weights are 3/2/1/0 so the ordering
  // matches the amendment's documented "exact > assignable-unknown >
  // wildcard" tiers with the subtype tier slotted in between exact and
  // unknown). On a score tie, the FIRST candidate in `all`'s original order
  // wins -- i.e. falls back to the pre-A4 "closest-declaring-class wins"
  // behavior, per the amendment's "on tie keep current arity behavior"
  // instruction.
  function pickBestOverload(candidates, call, callerClassLower, methodFacts) {
    if (!call || candidates.length < 2) return candidates[0];
    const argTexts = call.argTexts || [];
    const argInfos = argTexts.map((a) => inferArgHead(a, callerClassLower, methodFacts));
    let best = candidates[0];
    let bestScore = -Infinity;
    for (const cand of candidates) {
      const params = cand.method.params || [];
      const candCm = classes.get(cand.classLower);
      let score = 0;
      for (let i = 0; i < params.length; i++) {
        const info = argInfos[i];
        const paramHead = lastSegmentLower(params[i].type);
        if (!info || info.wildcard) score += 0;
        else if (info.head === null) score += 1; // assignable-unknown
        else if (info.head === paramHead) score += 3; // exact
        else if (
          info.classLower &&
          candCm &&
          classIsSameOrSubtypeOf(info.classLower, resolveType(params[i].type, candCm.qualified))
        ) {
          score += 2; // assignable-subtype (arg IS-A the declared param type)
        } else score += 0; // known but unrelated -- lowest tier alongside wildcard
      }
      if (score > bestScore) {
        bestScore = score;
        best = cand;
      }
    }
    return best;
  }

  function findMethodOwners(classLower, nameLower, walkSuper, callArity, call, callerClassLower, methodFacts) {
    const all = [];
    // H7(b): via walkExtendsChain -- own class always visited; `!walkSuper`
    // stops the walk after that first step by returning a (discarded)
    // truthy sentinel, matching the original loop's `if (!walkSuper) break;`
    // placed AFTER collecting the own-class matches.
    walkExtendsChain(classesLike, classLower, (cm, cur) => {
      for (const m of cm.methods) {
        if (lc(m.name) === nameLower) all.push({ classLower: cur, method: m });
      }
      return walkSuper ? undefined : true;
    });
    if (!all.length) return [];
    if (typeof callArity === 'number') {
      const exact = all.filter((o) => o.method.params.length === callArity);
      if (exact.length) {
        // A4: multiple same-arity overloads tie -- use arg-type scoring
        // instead of blindly taking the first-declared one.
        if (exact.length > 1) return [pickBestOverload(exact, call, callerClassLower, methodFacts)];
        return [exact[0]]; // closest-declaring-class wins among exact-arity matches
      }
      return all; // no arity match anywhere in the chain -> fan out to every overload (approximate)
    }
    return [all[0]];
  }

  // A4: 'name(TypeHead1, TypeHead2)' signature string for the CHOSEN
  // overload, only when the owning class actually declares more than one
  // method of this name (a true overload family) -- null otherwise so
  // non-overloaded call sites don't carry a meaningless single-signature tag.
  function computeOverloadSig(owner, nameLower) {
    const ocm = classes.get(owner.classLower);
    if (!ocm) return null;
    const siblings = ocm.methods.filter((m) => lc(m.name) === nameLower);
    if (siblings.length <= 1) return null;
    const paramTypes = (owner.method.params || []).map((p) => p.type || 'Object');
    return `${owner.method.name}(${paramTypes.join(', ')})`;
  }

  // Emits an edge for every owner returned by findMethodOwners(); returns
  // whether at least one edge was written (callers use this to decide
  // whether to fall through to rule 7 / the denylist). `methodFacts` is
  // optional and only used for A4's overload arg-type scoring.
  function emitOwners(callerClassLower, callerMethodLabel, classLower, nameLower, call, via, walkSuper, callArity, methodFacts) {
    const owners = findMethodOwners(classLower, nameLower, walkSuper, callArity, call, callerClassLower, methodFacts);
    for (const o of owners) {
      const overloadSig = computeOverloadSig(o, nameLower);
      writeMethodEdge(callerClassLower, callerMethodLabel, o.classLower, nameLower, call, via, o.method.name, overloadSig);
    }
    return owners.length > 0;
  }

  // Arity-preferring variant used only for Batchable/Queueable/Schedulable
  // execute() attachment ('should'-level, implemented — see header).
  function findDeclaredOrInherited(classLower, nameLower, preferredArity) {
    // H7(b): via walkExtendsChain -- stops at the first class (own, then
    // ancestors) declaring ANY method of this name.
    const found = walkExtendsChain(classesLike, classLower, (cm, cur) => {
      const candidates = cm.methods.filter((m) => lc(m.name) === nameLower);
      if (!candidates.length) return undefined;
      const exact = candidates.find((m) => m.params.length === preferredArity);
      return { classLower: cur, method: exact || candidates[0] };
    });
    return found === undefined ? null : found;
  }

  // TYPE ENV lookup: local shadows param shadows field (own then inherited
  // via extends chain), per the frozen TYPE ENV clause.
  function findReceiverType(classLower, methodFacts, receiverName) {
    const rl = lc(receiverName);
    if (methodFacts) {
      const local = (methodFacts.locals || []).slice().reverse().find((l) => lc(l.name) === rl);
      if (local) return local.type;
      const param = (methodFacts.params || []).find((p) => lc(p.name) === rl);
      if (param) return param.type;
    }
    // H7(b): via walkExtendsChain -- stops (and returns) at the first
    // class (own, then ancestors) declaring a matching field or property.
    const found = walkExtendsChain(classesLike, classLower, (cm) => {
      const tf = cm.typeFacts;
      const f = (tf.fields || []).find((f) => lc(f.name) === rl);
      if (f) return f.type;
      const p = (tf.properties || []).find((p) => lc(p.name) === rl);
      if (p) return p.type;
      return undefined;
    });
    return found === undefined ? null : found;
  }

  function makeCallSite(callerClassLower, callerMethodLabel, call, via, targetMethodName, overloadSig) {
    const ccm = classes.get(callerClassLower);
    return {
      callerClass: ccm.qualified,
      callerMethod: callerMethodLabel,
      callerKey: `${callerClassLower}#${lc(callerMethodLabel)}`,
      path: ccm.path,
      line: call.line,
      col: call.col,
      lineText: call.lineText,
      args: call.argTexts || [],
      via,
      targetMethod: targetMethodName || null,
      overloadSig: overloadSig || null, // A4: optional 'name(TypeHead, ...)' for a true overload family
    };
  }

  function writeMethodEdge(callerClassLower, callerMethodLabel, targetClassLower, nameLower, call, via, targetMethodName, overloadSig) {
    const key = `${targetClassLower}#${nameLower}`;
    if (!methodCallers.has(key)) methodCallers.set(key, []);
    methodCallers.get(key).push(makeCallSite(callerClassLower, callerMethodLabel, call, via, targetMethodName, overloadSig));
  }

  // Rule 1 ('new') and rule 2 (this()/super() ctor chaining) both target a
  // class's constructor. Both write to methodCallers[target#<init>]; rule 1
  // additionally rolls up to classCallers per its literal text, and rule 2
  // is ALSO routed to classCallers here as a deliberate extension (decision
  // in header: "classCallers rollup scope") so class-level tracing doesn't
  // silently drop constructor-chaining callers.
  function writeCtorEdge(callerClassLower, callerMethodLabel, targetClassLower, call, via) {
    const site = makeCallSite(callerClassLower, callerMethodLabel, call, via, '<init>');
    const key = `${targetClassLower}#<init>`;
    if (!methodCallers.has(key)) methodCallers.set(key, []);
    methodCallers.get(key).push(site);
    if (!classCallers.has(targetClassLower)) classCallers.set(targetClassLower, []);
    classCallers.get(targetClassLower).push(site);
  }

  // H4: returns whether an edge was written, so resolveDotOther's H4
  // unresolved-site bookkeeping (below) can tell "genuinely could not
  // resolve this receiver" apart from "resolved via the unique-name
  // fallback".
  function unresolvedFallback(callerClassLower, callerMethodLabel, call, nameLower) {
    const owners = methodNameIndex.get(nameLower);
    if (!owners || owners.size !== 1) return false; // not unique -> stays unresolved
    const [onlyClassLower] = owners;
    const owner = findMethodOwners(onlyClassLower, nameLower, false)[0];
    if (!owner) return false;
    const overloadSig = computeOverloadSig(owner, nameLower);
    writeMethodEdge(callerClassLower, callerMethodLabel, owner.classLower, nameLower, call, 'unique-name', owner.method.name, overloadSig);
    return true;
  }

  // Shared by rule 6's simple-identifier (type-env) path and its
  // cast-expression/chained-new bonus path: resolves `declaredTypeRaw` to
  // an indexed class and emits either a plain typed edge or an interface
  // fan-out. Returns whether it resolved to something known (callers use
  // this to decide whether to fall through further).
  function emitTypedOrInterface(callerClassLower, callerMethodLabel, cm, declaredTypeRaw, nameLower, call, callArity, methodFacts) {
    const typeLower = resolveType(declaredTypeRaw, cm.qualified);
    if (!typeLower) return false; // declared type known but unindexed (external/managed package)
    return emitTypedOrInterfaceForClass(callerClassLower, callerMethodLabel, typeLower, nameLower, call, callArity, methodFacts);
  }

  // Same as emitTypedOrInterface but takes an already-resolved classLower
  // directly -- used by emitTypedOrInterface itself, and (v0.4) by F2's
  // generic-collection/subscript receiver resolution, which arrives at a
  // classLower without ever having a single "declaredTypeRaw" string to
  // re-resolve (the type flowed through a Map<K,V>/List<T> accessor, not a
  // plain declared type).
  function emitTypedOrInterfaceForClass(callerClassLower, callerMethodLabel, typeLower, nameLower, call, callArity, methodFacts) {
    const typeCm = classes.get(typeLower);
    if (!typeCm) return false;
    if (typeCm.typeFacts.isInterface) {
      // Interface dispatch: edge to the interface's own method AND to
      // every implementer's same-name method, approximate (rule 6).
      let any = emitOwners(callerClassLower, callerMethodLabel, typeLower, nameLower, call, 'interface', false, callArity, methodFacts);
      const implementers = interfaceImplementers.get(lc(typeCm.name)) || [];
      // H2: classes independently registered as their OWN direct
      // implementer (redeclare `implements` on a subclass) are excluded
      // from the below fan-DOWN so they aren't double-edged -- they already
      // get their own direct emitOwners edge on their own iteration of this
      // loop.
      const implementerSet = new Set(implementers);
      for (const implLower of implementers) {
        // BUG FIX (finding #2): walkSuper=true (was false) -- an implementer
        // that satisfies the interface via an INHERITED (non-interface)
        // base-class method, without redeclaring it itself, is legal Apex.
        // Walking only the implementer's own directly-declared methods
        // silently dropped that caller entirely; walking its own extends
        // chain finds the ancestor that actually supplies the method (e.g.
        // ConcreteGreeter implements Greeter but inherits greet() from
        // BaseGreeter -- the edge belongs on BaseGreeter#greet).
        const implDirectHit = emitOwners(callerClassLower, callerMethodLabel, implLower, nameLower, call, 'interface', true, callArity, methodFacts);
        if (implDirectHit) any = true;
        // H2 (interface x override composition): interface dispatch used to
        // fan out to direct implementers and walk UP their extends chains,
        // but never fanned DOWN to overrides declared in a SUBCLASS of an
        // implementer -- repro: `interface I{void m();}` /
        // `virtual class Impl implements I { virtual void m(){} }` /
        // `class SubImpl extends Impl { override void m(){} }` /
        // `class Disp { void fan(I i){ i.m(); } }` traced SubImpl.m to ZERO
        // callers, since SubImpl never appears in `implementers` (it never
        // redeclares `implements I` itself) and nothing walked DOWN from
        // Impl to find it. The runtime receiver behind `i.m()` could
        // legitimately be a SubImpl instance -- exactly F3's plain-typed
        // override-fan-out reasoning, reused here via emitOverrideFanout,
        // gated on implDirectHit (mirrors F3/G3's "only fan out when the
        // base actually supplies something to override" gate) and labeled
        // via='interface' (the dispatch is still through the interface-typed
        // parameter, not a concrete class-typed variable) rather than
        // 'override'.
        if (implDirectHit && emitOverrideFanout(callerClassLower, callerMethodLabel, implLower, nameLower, call, callArity, methodFacts, 'interface', implementerSet)) {
          any = true;
        }
      }
      return any;
    }
    const primary = emitOwners(callerClassLower, callerMethodLabel, typeLower, nameLower, call, 'typed', true, callArity, methodFacts);
    // F3: virtual override fan-out -- the runtime receiver behind a 'typed'
    // (non-interface, non-static) dispatch could actually be any subclass
    // instance, so ALSO emit an approximate edge to every subclass that
    // itself redeclares (overrides) this method. A subclass that merely
    // INHERITS the method (doesn't redeclare it) is already fully covered
    // by the primary edge above -- findMethodOwners' own-class-only sweep
    // (walkSuper=false, inside emitOverrideFanout) naturally yields nothing
    // for it, so this is a silent no-op in the common non-override case.
    //
    // v0.5/G3 FIX: gated on `primary` being true -- "override" only makes
    // sense when the DECLARED type itself (or its own ancestor chain)
    // genuinely has a method of this name to override in the first place.
    // Without this gate, a descendant-only method (declared on NO ancestor
    // at all -- e.g. G3's crateLabel(), which exists solely on the concrete
    // leaf class) was being mislabeled 'override' by this fan-out even
    // though nothing is actually being overridden, which in turn pre-empted
    // the G3 narrowing fallback from ever being tried (rule 6's typed path
    // looked like it had "succeeded" via this false-positive override
    // edge). Every pre-v0.5 F3 fixture's declared type DOES declare the
    // method itself, so primary is already true there and this gate is a
    // no-op for them (regression-checked).
    if (primary) {
      emitOverrideFanout(callerClassLower, callerMethodLabel, typeLower, nameLower, call, callArity, methodFacts);
    }
    return primary;
  }

  // `via` defaults to 'override' (the plain-typed F3 fan-out's own label);
  // H2 passes 'interface' when reusing this for the interface-dispatch
  // fan-down. `skipSet` (H2 only) excludes descendants that get their own
  // direct edge elsewhere in the same resolution, avoiding a double-counted
  // site.
  function emitOverrideFanout(callerClassLower, callerMethodLabel, baseClassLower, nameLower, call, callArity, methodFacts, via, skipSet) {
    const viaLabel = via || 'override';
    let any = false;
    for (const descLower of allDescendants(baseClassLower)) {
      if (skipSet && skipSet.has(descLower)) continue;
      const owners = findMethodOwners(descLower, nameLower, false, callArity, call, callerClassLower, methodFacts);
      for (const o of owners) {
        const overloadSig = computeOverloadSig(o, nameLower);
        writeMethodEdge(callerClassLower, callerMethodLabel, o.classLower, nameLower, call, viaLabel, o.method.name, overloadSig);
        any = true;
      }
    }
    return any;
  }

  // A3(b): '(cond ? a : b)' where both branches are simple identifiers.
  // Returns { classLower, via } when at least one side resolves to a known
  // user class through the caller's type env, else null (falls through to
  // existing rules). Both sides resolving to the SAME class -> 'typed';
  // only one side resolving -> 'unique-name' (approximate, per A3 spec).
  function resolveTernaryReceiver(receiverRaw, callerClassLower, methodFacts, cmQualified) {
    const s = String(receiverRaw || '').trim();
    const m = s.match(TERNARY_RE);
    if (!m) return null;
    const aType = findReceiverType(callerClassLower, methodFacts, m[1]);
    const bType = findReceiverType(callerClassLower, methodFacts, m[2]);
    const aClass = aType ? resolveType(aType, cmQualified) : null;
    const bClass = bType ? resolveType(bType, cmQualified) : null;
    if (aClass && bClass && aClass === bClass) return { classLower: aClass, via: 'typed' };
    if (aClass || bClass) return { classLower: aClass || bClass, via: 'unique-name' };
    return null;
  }

  // A3(c): finds the class that actually declares `nameLower` (own class
  // first, then ancestors), mirroring findMethodOwners' walk but returning
  // the raw MethodFacts (for its `returnType`, which MethodMeta doesn't
  // carry) instead of the trimmed MethodMeta shape.
  function findDeclaredMethodRaw(classLower, nameLower) {
    // H7(b): via walkExtendsChain -- stops at the first class (own, then
    // ancestors) whose raw TypeFacts.methods declares this non-ctor name.
    const found = walkExtendsChain(classesLike, classLower, (tcm, cur) => {
      const m = (tcm.typeFacts.methods || []).find((mm) => !mm.isCtor && lc(mm.name) === nameLower);
      return m ? { classLower: cur, methodFacts: m } : undefined;
    });
    return found === undefined ? null : found;
  }

  // A3(c)/F2: 'a.b()' / 'a.b().c()' / 'Cls.b()' -- resolves the head
  // (identifier via type env, or a class name for a static chain start),
  // then walks up to 4 `.method()`/collection-accessor segments. Each
  // segment first tries F2's collection-accessor bonus (Map<K,V>.get()->V,
  // Map<K,V>.values()->List<V>, List<T>/Set<T>.get()->T) against the
  // CURRENT raw type text -- this is what lets a Map<K,V>/List<T>-typed hop
  // participate in the chain at all, since it has no indexed class of its
  // own to look up a declared method on. When the accessor bonus doesn't
  // apply, falls back to the pre-F2 behavior: walk through the declaring
  // method's returnType (following the extends chain to find it). Returns
  // the final owning classLower, or null the moment any segment fails to
  // resolve (declaring method not found, no returnType, or the resulting
  // type head isn't a known user class/collection shape).
  function resolveChainedReceiver(receiverRaw, callerClassLower, cm, methodFacts) {
    const parsed = parseChainSegments(receiverRaw);
    if (!parsed || !parsed.segments.length) return null;
    // A3(c) cap: 4 segments is the documented walk limit. A receiver with
    // MORE than 4 segments is not "truncate and use whatever the 4th lands
    // on" -- that would confidently attribute the outer call to a class the
    // chain never actually reaches (see Chain5E/Chain5F hostile fixture).
    // Exceeding the cap is itself a failure of this rule; fall through to
    // existing rules (cast/ternary already tried, then rule 7 unique-name,
    // which may also decline if the name isn't globally unique -- correctly
    // yielding NO edge rather than a wrong one).
    if (parsed.segments.length > 4) {
      // H4: one of the three named "dropped call site" categories -- counted
      // here (the single, precise source for this reason) regardless of
      // whether the caller was a dot-call (resolveDotOther, via
      // resolveComplexReceiver) or a prop-call (resolvePropCall) receiver;
      // resolveDotOther's own generic catch-all (below) is taught to skip
      // re-counting this same call site for the same reason.
      unresolvedSitesCount++;
      return null;
    }
    const isSimpleHead = SIMPLE_IDENT_RE.test(parsed.head);
    if (!isSimpleHead) return null;
    const declaredType = findReceiverType(callerClassLower, methodFacts, parsed.head);
    // F2: track the "current type" as raw TEXT, not an eagerly-resolved
    // classLower -- a Map<K,V>/List<T> head has no indexed class at all, so
    // resolving eagerly would fail the walk before it even starts.
    let curTypeRaw = declaredType || parsed.head;
    let curClassLower = null;
    let curQualified = cm.qualified;
    for (const segName of parsed.segments) {
      const segLower = lc(segName);
      const collResult = applyCollectionAccessor(curTypeRaw, segLower);
      if (collResult) {
        curTypeRaw = collResult;
        curClassLower = null; // still generic text (e.g. 'List<V>' from .values()) -- don't resolve yet
        continue;
      }
      if (!curClassLower) {
        curClassLower = resolveType(curTypeRaw, curQualified);
        if (!curClassLower) return null;
        curQualified = classes.get(curClassLower).qualified;
      }
      const found = findDeclaredMethodRaw(curClassLower, segLower);
      if (!found || !found.methodFacts.returnType) return null;
      curTypeRaw = stripGenerics(found.methodFacts.returnType);
      const nextClassLower = resolveType(curTypeRaw, classes.get(found.classLower).qualified);
      if (!nextClassLower) return null; // e.g. 'List<Foo>' -> 'List' -> not a user class -> stop
      curClassLower = nextClassLower;
      curQualified = classes.get(curClassLower).qualified;
    }
    if (!curClassLower) curClassLower = resolveType(curTypeRaw, curQualified);
    return curClassLower;
  }

  // F2: 'name[idx]' with no further chaining (e.g. 'steps[0]') -- resolves
  // the head's declared type as a List<T>/Set<T> and yields T via the same
  // collection-accessor bonus as the 'get' chain segment (subscript and
  // .get() are equivalent for this purpose).
  function resolveSubscriptReceiver(receiverRaw, callerClassLower, cm, methodFacts) {
    const s = String(receiverRaw || '').trim();
    const m = s.match(SUBSCRIPT_RE);
    if (!m) return null;
    const declaredType = findReceiverType(callerClassLower, methodFacts, m[1]);
    if (!declaredType) return null;
    const elemType = applyCollectionAccessor(declaredType, 'get');
    if (!elemType) return null;
    return resolveType(elemType, cm.qualified);
  }

  // A3: tries the cast/new-chain heuristic (unchanged from the pre-A3
  // 'should'-level bonus), then the ternary bonus, then (F2) the plain
  // subscript bonus, then the chained-call bonus, in that order -- all
  // "applied before the unique-name fallback" per the amendment. Returns
  // whether an edge was written.
  function resolveComplexReceiver(callerClassLower, callerMethodLabel, cm, methodFacts, call, nameLower, callArity) {
    const receiverRaw = call.receiver;

    const chainType = castOrNewChainType(receiverRaw);
    if (chainType && emitTypedOrInterface(callerClassLower, callerMethodLabel, cm, chainType, nameLower, call, callArity, methodFacts)) {
      return true;
    }

    const tern = resolveTernaryReceiver(receiverRaw, callerClassLower, methodFacts, cm.qualified);
    if (tern && emitOwners(callerClassLower, callerMethodLabel, tern.classLower, nameLower, call, tern.via, true, callArity, methodFacts)) {
      return true;
    }

    const subscriptClassLower = resolveSubscriptReceiver(receiverRaw, callerClassLower, cm, methodFacts);
    if (subscriptClassLower && emitTypedOrInterfaceForClass(callerClassLower, callerMethodLabel, subscriptClassLower, nameLower, call, callArity, methodFacts)) {
      return true;
    }

    const chainedClassLower = resolveChainedReceiver(receiverRaw, callerClassLower, cm, methodFacts);
    if (chainedClassLower && emitTypedOrInterfaceForClass(callerClassLower, callerMethodLabel, chainedClassLower, nameLower, call, callArity, methodFacts)) {
      return true;
    }

    return false;
  }

  // Rules 5-7: a 'dot' call whose receiver is neither 'this' nor 'super'.
  function resolveDotOther(callerClassLower, callerMethodLabel, methodFacts, call) {
    const nameLower = lc(call.method);
    const cm = classes.get(callerClassLower);
    const receiverRaw = call.receiver;
    const callArity = (call.argTexts || []).length;
    const isSimple = SIMPLE_IDENT_RE.test(String(receiverRaw || '').trim());

    // BUG FIX (finding #3): rule 6 (type-env / shadowing local-param-field)
    // is checked BEFORE rule 5 (class-name match) when the receiver is a
    // simple identifier that names an in-scope variable. Apex/Java identifier
    // scoping means a local/param/field always shadows a same-named class
    // for the rest of its scope -- the frozen spec lists rule 5 before rule
    // 6, but applying that literal ordering misattributes routine
    // camelCase-of-type-named locals (e.g. `OtherType FooTarget = ...;
    // FooTarget.bar();`) to the wrong class via the wrong dispatch kind.
    // Once we know the receiver names a variable, rule 5 must never apply
    // for this call site — even if the variable's declared type isn't one
    // we can resolve (external/managed package), we still must not fall
    // back to treating the identifier as the class it shadows.
    let shadowedByVariable = false;
    if (isSimple) {
      const declaredType = findReceiverType(callerClassLower, methodFacts, receiverRaw);
      if (declaredType) {
        shadowedByVariable = true;
        if (emitTypedOrInterface(callerClassLower, callerMethodLabel, cm, declaredType, nameLower, call, callArity, methodFacts)) return;
        // G3: declared-type resolution failed (the method isn't on that
        // class or its extends chain) -- try the instanceof-narrowing
        // fallback before giving up on this variable entirely. Only reached
        // when declared-type resolution already failed, per the G3 spec
        // ("never used when declared-type resolution succeeds").
        if (tryNarrowedReceiver(callerClassLower, callerMethodLabel, methodFacts, receiverRaw, nameLower, call, callArity)) return;
      }
    }

    // Rule 5: receiver text case-insensitively names a known user class
    // (or Outer.Inner) -> static dispatch. A resolved class-name match is
    // definitive: whether or not it declares this method, we do not fall
    // through to rules 6/7 (denylist gates rule 5's *failure* to match a
    // class at all, not a successful match with no such method — decision
    // #7). Skipped entirely when the receiver is a shadowing variable.
    if (!shadowedByVariable) {
      const classMatch = resolveType(receiverRaw, cm.qualified);
      if (classMatch) {
        emitOwners(callerClassLower, callerMethodLabel, classMatch, nameLower, call, 'static', true, callArity, methodFacts);
        return;
      }
    }

    // Rule 6 continued / A3: cast-expression, ternary, and chained-call
    // receiver bonuses (all "applied before the unique-name fallback").
    if (!isSimple) {
      if (resolveComplexReceiver(callerClassLower, callerMethodLabel, cm, methodFacts, call, nameLower, callArity)) {
        return; // MUST-FIX: a resolved rule-6 typed shadow is never denylisted (decision #7)
      }
    }

    // Denylist gate: only reached once rules 5 and 6 both failed to find a
    // known-class resolution (decision #7). A denylisted receiver is a
    // deliberate, known exclusion (System/Database/etc.) -- not counted as
    // an H4 "dropped" site.
    const headLower = lastSegmentLower(receiverRaw);
    if (PLATFORM_DENYLIST.has(headLower)) return;

    // Rule 7: unique-name fallback.
    const resolved = unresolvedFallback(callerClassLower, callerMethodLabel, call, nameLower);
    // H4: every prior rule (5, 6, and rule 7's own unique-name fallback)
    // has now failed -- this receiver never resolved to anything at all
    // ("unknown receiver"). Skip the count when resolveChainedReceiver
    // already counted this exact call site under its own more specific
    // "chain > 4 segments" category above (resolveComplexReceiver tried it
    // as one of its bonuses) -- one dropped call site, one count.
    if (!resolved) {
      const chainSeg = !isSimple ? parseChainSegments(receiverRaw) : null;
      const alreadyCountedChainCap = !!(chainSeg && chainSeg.segments.length > 4);
      if (!alreadyCountedChainCap) unresolvedSitesCount++;
    }
  }

  // A2: resolves a 'prop' CallFacts (property get/set access). Reuses the
  // same receiver-resolution order as dot-call rules 5/6 (typed shadow >
  // class-name match > A3 complex-receiver bonuses), but a resolved
  // receiver only ever emits an edge when the owning class (or its extends
  // chain) declares a PROPERTY of this name -- a plain FIELD match means
  // silently no edge (no unique-name fallback, no denylist check: not
  // specified by A2, so deliberately not invented here).
  function resolvePropCall(callerClassLower, callerMethodLabel, methodFacts, call) {
    const cm = classes.get(callerClassLower);
    if (!cm) return;
    const receiverRaw = call.receiver;
    const propName = call.method;
    const propLower = lc(propName);
    const accessor = call.accessor === 'set' ? 'set' : 'get';
    const receiverTrim = String(receiverRaw || '').trim();
    const isSimple = SIMPLE_IDENT_RE.test(receiverTrim);

    let targetClassLower = null;
    let via = null;

    if (lc(receiverTrim) === 'this') {
      targetClassLower = callerClassLower;
      via = 'typed';
    } else if (lc(receiverTrim) === 'super') {
      targetClassLower = cm.extendsType ? resolveType(cm.extendsType, cm.qualified) : null;
      via = targetClassLower ? 'typed' : null;
    } else if (isSimple) {
      const declaredType = findReceiverType(callerClassLower, methodFacts, receiverRaw);
      if (declaredType) {
        targetClassLower = resolveType(declaredType, cm.qualified);
        via = targetClassLower ? 'typed' : null;
      }
      if (!targetClassLower) {
        const classMatch = resolveType(receiverRaw, cm.qualified);
        if (classMatch) {
          targetClassLower = classMatch;
          via = 'static';
        }
      }
    } else {
      const chainType = castOrNewChainType(receiverRaw);
      if (chainType) {
        const t = resolveType(chainType, cm.qualified);
        if (t) {
          targetClassLower = t;
          via = 'typed';
        }
      }
      if (!targetClassLower) {
        const tern = resolveTernaryReceiver(receiverRaw, callerClassLower, methodFacts, cm.qualified);
        if (tern) {
          targetClassLower = tern.classLower;
          via = tern.via;
        }
      }
      if (!targetClassLower) {
        const chained = resolveChainedReceiver(receiverRaw, callerClassLower, cm, methodFacts);
        if (chained) {
          targetClassLower = chained;
          via = 'typed';
        }
      }
    }

    if (!targetClassLower) return;

    // H7(b): via walkExtendsChain -- looks for a declared PROPERTY of this
    // name (own class, then ancestors); a plain FIELD match stops the walk
    // with no edge (A2 spec), same as a property match stops it WITH one.
    walkExtendsChain(classesLike, targetClassLower, (tcm, cur) => {
      const prop = (tcm.typeFacts.properties || []).find((p) => lc(p.name) === propLower);
      if (prop) {
        const accessorName = `(${accessor} ${prop.name})`;
        const accessorLower = lc(accessorName);
        // Only emit when the synthetic accessor scope actually exists in
        // this class's ClassMeta (defensive -- should always be true when
        // parser.js declares the property in the first place).
        if (tcm.methods.some((m) => lc(m.name) === accessorLower)) {
          writeMethodEdge(callerClassLower, callerMethodLabel, cur, accessorLower, call, via, accessorName, null);
        }
        return true; // stop: handled (edge written)
      }
      const field = (tcm.typeFacts.fields || []).find((f) => lc(f.name) === propLower);
      if (field) return true; // stop: field-not-property, no edge (A2 spec)
      return undefined; // continue up the chain
    });
  }

  function resolveCall(callerClassLower, callerMethodLabel, methodFacts, call) {
    const cm = classes.get(callerClassLower);
    if (!cm) return;

    if (call.kind === 'new') {
      // Rule 1.
      const targetClassLower = resolveType(call.method, cm.qualified);
      if (!targetClassLower) return; // not a known user class -> no edge
      writeCtorEdge(callerClassLower, callerMethodLabel, targetClassLower, call, 'new');
      return;
    }

    if (call.kind === 'prop') {
      // A2.
      resolvePropCall(callerClassLower, callerMethodLabel, methodFacts, call);
      return;
    }

    if (call.kind === 'bare') {
      const nameLower = lc(call.method);
      if (nameLower === 'this') {
        // Rule 2 (this-chaining): own class's constructor.
        writeCtorEdge(callerClassLower, callerMethodLabel, callerClassLower, call, 'this');
        return;
      }
      if (nameLower === 'super') {
        // Rule 2 (super-chaining): parent class's constructor.
        const superLower = cm.extendsType ? resolveType(cm.extendsType, cm.qualified) : null;
        if (!superLower) return; // parent unindexed/external -> no edge, known limitation
        writeCtorEdge(callerClassLower, callerMethodLabel, superLower, call, 'super');
        return;
      }
      // Rule 3: own class, else walk extends chain (arity-aware — bug #1);
      // else rule 7.
      const callArity3 = (call.argTexts || []).length;
      if (emitOwners(callerClassLower, callerMethodLabel, callerClassLower, nameLower, call, 'this', true, callArity3, methodFacts)) return;
      unresolvedFallback(callerClassLower, callerMethodLabel, call, nameLower);
      return;
    }

    // call.kind === 'dot'
    const receiverLower = lc(call.receiver);
    if (receiverLower === 'this') {
      // Rule 4 (this): identical semantics to rule 3.
      const nameLower = lc(call.method);
      const callArity4t = (call.argTexts || []).length;
      if (emitOwners(callerClassLower, callerMethodLabel, callerClassLower, nameLower, call, 'this', true, callArity4t, methodFacts)) return;
      unresolvedFallback(callerClassLower, callerMethodLabel, call, nameLower);
      return;
    }
    if (receiverLower === 'super') {
      // Rule 4 (super): parent chain; parent unknown -> no edge (no
      // unique-name fallback for an explicitly-qualified super call).
      const superLower = cm.extendsType ? resolveType(cm.extendsType, cm.qualified) : null;
      if (!superLower) return;
      const nameLower = lc(call.method);
      const callArity4s = (call.argTexts || []).length;
      emitOwners(callerClassLower, callerMethodLabel, superLower, nameLower, call, 'super', true, callArity4s, methodFacts);
      return;
    }
    resolveDotOther(callerClassLower, callerMethodLabel, methodFacts, call);
  }

  // =========================================================================
  // F1: DML -> trigger / record-triggered-flow linkage
  // =========================================================================

  // Resolves a DML statement's/Database.xxx() call's target expression text
  // to the (lowercased) SObject API name it operates on. Tries, in order:
  // (1) a simple identifier -> TYPE ENV lookup (local/param/field, own then
  // inherited -- same lookup rule 6 uses for receivers); (2) an inline
  // 'new List<Type>(...)' / 'new Type(...)' expression -- best-effort text
  // extraction, same spirit as castOrNewChainType. Returns null (no edge,
  // not a guess) when neither shape yields a type.
  function resolveDmlTargetObject(targetText, callerClassLower, methodFacts) {
    const raw = String(targetText || '').trim();
    if (!raw) return null;
    let typeRaw = null;
    if (SIMPLE_IDENT_RE.test(raw)) {
      typeRaw = findReceiverType(callerClassLower, methodFacts, raw);
    }
    if (!typeRaw) {
      const listMatch = raw.match(/new\s+(?:List|Set)\s*<\s*([A-Za-z_][\w.]*)\s*>/i);
      if (listMatch) typeRaw = `List<${listMatch[1]}>`;
      else {
        const newMatch = raw.match(/new\s+([A-Za-z_][\w.]*)/i);
        if (newMatch) typeRaw = newMatch[1];
      }
    }
    if (!typeRaw) return null;
    return dmlObjectHead(typeRaw);
  }

  // F1(b): records every valid DML site regardless of trigger match, for
  // record-triggered-flow children lookups later (buildMetaChildren).
  function recordDmlSite(op, objectLower, callerClassLower, callerMethodLabel, callLike) {
    const ccm = classes.get(callerClassLower);
    if (!ccm) return;
    const entry = {
      op,
      callerClass: ccm.qualified,
      callerMethod: callerMethodLabel,
      path: ccm.path,
      line: callLike.line,
      col: callLike.col,
      lineText: callLike.lineText,
      args: callLike.argTexts || [],
    };
    if (!dmlSitesByObject.has(objectLower)) dmlSitesByObject.set(objectLower, []);
    dmlSitesByObject.get(objectLower).push(entry);
  }

  // F1(a): writes a via='dml' caller edge into methodCallers['<trigger>#(trigger)']
  // for every trigger on objectLower whose events intersect op's mapped
  // events -- a single upsert/merge statement can (and, per the v0.4 spec,
  // deliberately does in this corpus) match more than one trigger on the
  // same object.
  function emitDmlTriggerEdges(callerClassLower, callerMethodLabel, op, objectLower, callLike) {
    recordDmlSite(op, objectLower, callerClassLower, callerMethodLabel, callLike);
    const triggers = triggersByObject.get(objectLower) || [];
    if (!triggers.length) return;
    const opEvents = opToTriggerEvents(op);
    for (const t of triggers) {
      const tEvents = ((t.triggerInfo && t.triggerInfo.events) || []).map(lc);
      if (opEvents.some((e) => tEvents.includes(e))) {
        writeMethodEdge(callerClassLower, callerMethodLabel, lc(t.qualified), '(trigger)', callLike, 'dml', '(trigger)', null);
      }
    }
  }

  // F1: statement-form DML (parser.js's MethodFacts.dml -- one entry per
  // insert/update/delete/undelete/upsert/merge STATEMENT).
  function handleDmlStatement(callerClassLower, callerMethodLabel, mf, dmlFact) {
    const op = lc(dmlFact && dmlFact.op);
    if (!DML_OPS.has(op)) return;
    const objectLower = resolveDmlTargetObject(dmlFact.targetText, callerClassLower, mf);
    if (!objectLower) return;
    const callLike = { line: dmlFact.line, col: dmlFact.col, lineText: dmlFact.lineText, argTexts: [dmlFact.targetText] };
    emitDmlTriggerEdges(callerClassLower, callerMethodLabel, op, objectLower, callLike);
  }

  // F1: Database.insert()/.update()/etc. METHOD-form DML (incl.
  // allOrNone/partial-success overload variants -- they're still just
  // 'insert'/'update'/etc. by method name, so no separate handling needed).
  // Runs INDEPENDENTLY of ordinary call resolution (resolveCall /
  // resolveDotOther), on every 'dot' call regardless of what rule 5/6/7
  // already did with it. This corpus can contain a user class literally
  // named 'Database' (the v0.3 platform-shadow fixture) -- rule 5's "a
  // resolved class-name match is definitive, we do not fall through to
  // rules 6/7" means ordinary dispatch resolves this receiver to that user
  // class, finds no declared insert/update/etc. method, and stops (0
  // call-graph edges, which is fine -- Database.insert() was never supposed
  // to produce a call-graph edge in the first place). Gating DML-op
  // detection behind or after that resolution would mean it never fires at
  // all for this corpus; checking receiver text + method name directly,
  // ahead of/independent of rule 5, is what makes it work regardless.
  function handleDatabaseMethodDml(callerClassLower, callerMethodLabel, mf, call) {
    if (call.kind !== 'dot') return;
    if (lc(call.receiver) !== 'database') return;
    const op = lc(call.method);
    if (!DML_OPS.has(op)) return;
    const targetText = (call.argTexts && call.argTexts[0]) || '';
    const objectLower = resolveDmlTargetObject(targetText, callerClassLower, mf);
    if (!objectLower) return;
    emitDmlTriggerEdges(callerClassLower, callerMethodLabel, op, objectLower, call);
  }

  // F4a: Type.forName('LiteralClassName') -- single string-literal arg only;
  // a non-literal arg (a variable) never qualifies (its runtime value is
  // unknowable statically), by design, regardless of what it might hold.
  // Independent of ordinary dispatch for the same reason as the
  // Database.xxx() case above ('type' is platform-denylisted, so ordinary
  // dispatch already produces zero edges for this receiver on its own --
  // this is purely additive, never a conflicting resolution).
  function handleTypeForName(callerClassLower, callerMethodLabel, call) {
    if (call.kind !== 'dot') return;
    if (lc(call.receiver) !== 'type') return;
    if (lc(call.method) !== 'forname') return;
    const args = call.argTexts || [];
    if (args.length !== 1) return;
    const argText = String(args[0] == null ? '' : args[0]).trim();
    const litMatch = argText.match(/^"([^"]*)"$/) || argText.match(/^'([^']*)'$/);
    if (!litMatch) {
      // H4: the third named "dropped call site" category -- a variable
      // (non-literal) arg whose runtime value can never be known statically.
      unresolvedSitesCount++;
      return; // not a string literal -> negative case (variable arg)
    }
    const ccm = classes.get(callerClassLower);
    const targetLower = resolveType(litMatch[1], ccm ? ccm.qualified : null);
    if (!targetLower) return; // unknown class -> negative case
    writeCtorEdge(callerClassLower, callerMethodLabel, targetLower, call, 'dynamic');
  }

  // =========================================================================
  // G1: EventBus.publish -> platform-event trigger linkage
  // =========================================================================

  // G1(b): records every valid publish site regardless of trigger match
  // (mirrors recordDmlSite exactly), for platform-event-triggered-flow
  // children lookups later (buildMetaChildren).
  function recordPublishSite(objectLower, callerClassLower, callerMethodLabel, callLike) {
    const ccm = classes.get(callerClassLower);
    if (!ccm) return;
    const entry = {
      op: 'publish',
      callerClass: ccm.qualified,
      callerMethod: callerMethodLabel,
      path: ccm.path,
      line: callLike.line,
      col: callLike.col,
      lineText: callLike.lineText,
      args: callLike.argTexts || [],
    };
    if (!publishSitesByObject.has(objectLower)) publishSitesByObject.set(objectLower, []);
    publishSitesByObject.get(objectLower).push(entry);
  }

  // G1(a): EventBus.publish(...) is a special case handled INDEPENDENTLY of
  // ordinary dispatch (same pattern as handleDatabaseMethodDml /
  // handleTypeForName above) -- 'eventbus' sits in PLATFORM_DENYLIST, so
  // ordinary rule 5/6/7 dispatch already produces zero edges for this
  // receiver on its own; this function is purely additive, never a
  // conflicting resolution, and is by construction never blocked by the
  // denylist gate since it never goes through resolveDotOther at all.
  // Resolves the first arg's type via the SAME target-type machinery DML
  // uses (resolveDmlTargetObject -- type-env lookup for identifiers incl.
  // List<X__e>, or the inline 'new Acme_X__e(...)' pattern). If the
  // resolved type's simple name ends in '__e', every trigger registered on
  // that object gets a via='publish' caller edge -- per the G1 spec,
  // platform-event triggers are unconditionally 'after insert' (enforced by
  // the platform itself), so unlike F1's DML op/event matrix there is no
  // op-vs-declared-event intersection to check: every trigger on the object
  // qualifies, full stop.
  function handleEventBusPublish(callerClassLower, callerMethodLabel, mf, call) {
    if (call.kind !== 'dot') return;
    if (lc(call.receiver) !== 'eventbus') return;
    if (lc(call.method) !== 'publish') return;
    const args = call.argTexts || [];
    if (!args.length) return;
    const objectLower = resolveDmlTargetObject(args[0], callerClassLower, mf);
    if (!objectLower) return;
    if (!objectLower.endsWith('__e')) return; // only platform events qualify
    recordPublishSite(objectLower, callerClassLower, callerMethodLabel, call);
    const triggers = triggersByObject.get(objectLower) || [];
    for (const t of triggers) {
      writeMethodEdge(callerClassLower, callerMethodLabel, lc(t.qualified), '(trigger)', call, 'publish', '(trigger)', null);
    }
  }

  // =========================================================================
  // G2: exception throw/catch tracing -- throw-site indexing
  // =========================================================================

  // Builds a CallSite-shaped record for a throw statement (no args/overload
  // -- a throw isn't a method call, but buildCallerTree's buildOneChild
  // machinery is reused verbatim for thrower nodes, so the shape must match
  // makeCallSite's output closely enough to satisfy shapeSites()).
  function makeThrowSite(callerClassLower, callerMethodLabel, throwSiteFact, via) {
    const ccm = classes.get(callerClassLower);
    return {
      callerClass: ccm.qualified,
      callerMethod: callerMethodLabel,
      callerKey: `${callerClassLower}#${lc(callerMethodLabel)}`,
      path: ccm.path,
      line: throwSiteFact.line,
      col: throwSiteFact.col || 0,
      lineText: throwSiteFact.lineText,
      args: [],
      via,
      targetMethod: null,
      overloadSig: null,
    };
  }

  // 'throw e' rethrow form: parser.js emits {typeName: null, varName: 'e'}
  // and leaves resolving `e`'s type to this module. Tries, in this order:
  // the method's own catch clauses (the common rethrow shape -- `catch (X e)
  // { ...; throw e; }`), then its locals, then its params. Returns the raw
  // type name text, or null when nothing named varName is found anywhere in
  // scope (per spec: "unresolvable -> skip").
  function resolveThrowVarType(mf, varName) {
    const vl = lc(varName);
    const c = (mf.catches || []).find((cc) => lc(cc.varName) === vl);
    if (c) return c.typeName;
    const local = (mf.locals || []).slice().reverse().find((l) => lc(l.name) === vl);
    if (local) return local.type;
    const param = (mf.params || []).find((p) => lc(p.name) === vl);
    if (param) return param.type;
    return null;
  }

  // Indexes one MethodFacts.throwsSites entry into `throwers`, keyed by the
  // thrown type resolved to an indexed classLower where possible (falls
  // back to a bare normalized name so an unindexed/external exception type
  // still gets a stable, if unreachable via buildCallerTree, key rather
  // than silently colliding with something else).
  function handleThrowSite(callerClassLower, callerMethodLabel, mf, throwSiteFact, tf) {
    let typeNameRaw = throwSiteFact.typeName;
    if (!typeNameRaw && throwSiteFact.varName) {
      typeNameRaw = resolveThrowVarType(mf, throwSiteFact.varName);
    }
    if (!typeNameRaw) return; // unresolvable rethrow var -> skip, per G2 spec
    const resolvedLower = resolveType(typeNameRaw, tf.qualified);
    const excKey = resolvedLower || normalizeTypeName(typeNameRaw);
    if (!excKey) return;
    const site = makeThrowSite(callerClassLower, callerMethodLabel, throwSiteFact, 'throws');
    if (!throwers.has(excKey)) throwers.set(excKey, []);
    throwers.get(excKey).push(site);
  }

  // =========================================================================
  // G3: instanceof narrowing (labeled fallback only)
  // =========================================================================

  // Called ONLY after declared-type resolution has already been tried and
  // failed for a simple-identifier receiver (see resolveDotOther) -- never
  // when declared-type resolution succeeds, per the G3 spec. For every
  // 'x instanceof T' narrowing recorded against this receiver var in the
  // current method, tries T as the receiver's type and emits an edge on a
  // hit. Always approximate (via APPROX_VIA) -- branch polarity (whether the
  // `if` guarding the call site is actually the SAME `if` the narrowing
  // came from, or whether it even executes at runtime) is not tracked; this
  // is a real approximation, not full flow analysis, and is documented as
  // such rather than silently overclaiming precision.
  function tryNarrowedReceiver(callerClassLower, callerMethodLabel, methodFacts, receiverRaw, nameLower, call, callArity) {
    const varLower = lc(String(receiverRaw || '').trim());
    const narrowings = (methodFacts && methodFacts.narrowings) || [];
    const cm = classes.get(callerClassLower);
    let any = false;
    const seenTypes = new Set();
    for (const nw of narrowings) {
      if (lc(nw.varName) !== varLower) continue;
      const typeKey = normalizeTypeName(nw.typeName);
      if (!typeKey || seenTypes.has(typeKey)) continue; // dedupe repeated instanceof checks on the same type
      seenTypes.add(typeKey);
      const targetClassLower = resolveType(nw.typeName, cm.qualified);
      if (!targetClassLower) continue;
      const owners = findMethodOwners(targetClassLower, nameLower, true, callArity, call, callerClassLower, methodFacts);
      for (const o of owners) {
        const overloadSig = computeOverloadSig(o, nameLower);
        writeMethodEdge(callerClassLower, callerMethodLabel, o.classLower, nameLower, call, 'narrowed', o.method.name, overloadSig);
        any = true;
      }
    }
    return any;
  }

  // =========================================================================
  // G5: async-hop edges
  // =========================================================================

  // System.enqueueJob(...) / Database.executeBatch(...) / System.schedule(...)
  // are handled INDEPENDENTLY of ordinary dispatch (same pattern as
  // handleDatabaseMethodDml/handleTypeForName/handleEventBusPublish above):
  // this is purely additive to whatever edges rule 1 ('new', for the inline
  // constructor argument itself) already produced, never a conflicting
  // resolution. Per the G5 spec, a qualifying call site is one whose
  // argText LITERALLY contains an inline 'new KnownClass(' creation -- a
  // variable that happens to hold such an instance does not qualify (its
  // value is not statically knowable from the call site's own text, exactly
  // the same reasoning as F4a's Type.forName string-literal-only rule).
  const ASYNC_METHOD_KEY = 'execute';
  function handleAsyncHop(callerClassLower, callerMethodLabel, call) {
    if (call.kind !== 'dot') return;
    const receiverLower = lc(call.receiver);
    const methodLower = lc(call.method);
    const isQualifying =
      (receiverLower === 'system' && methodLower === 'enqueuejob') ||
      (receiverLower === 'database' && methodLower === 'executebatch') ||
      (receiverLower === 'system' && methodLower === 'schedule');
    if (!isQualifying) return;
    const args = call.argTexts || [];
    const cm = classes.get(callerClassLower);
    for (const argText of args) {
      const s = String(argText == null ? '' : argText).trim();
      const m = s.match(/^new\s+([A-Za-z_][\w.]*)\s*\(/i);
      if (!m) continue;
      const targetClassLower = resolveType(m[1], cm ? cm.qualified : null);
      if (!targetClassLower) continue;
      writeMethodEdge(callerClassLower, callerMethodLabel, targetClassLower, ASYNC_METHOD_KEY, call, 'async', 'execute', null);
      return; // only one inline `new` argument is expected per the G5 spec's examples
    }
  }

  // ---- pass B: walk every parseable method's calls -----------------------
  for (const file of factsList || []) {
    if (file.parseError) continue;
    for (const tf of file.types || []) {
      const qualifiedLower = lc(tf.qualified);
      const cm = classes.get(qualifiedLower);
      if (!cm || cm.path !== file.path) continue; // lost the duplicate-name race, ignored for resolution
      for (const mf of tf.methods || []) {
        const callerMethodLabel = mf.isCtor ? '<init>' : mf.name;
        for (const call of mf.calls || []) {
          resolveCall(qualifiedLower, callerMethodLabel, mf, call);
          // F1/F4a/G1/G5: independent of ordinary dispatch above (see each
          // function's own header comment for why).
          handleDatabaseMethodDml(qualifiedLower, callerMethodLabel, mf, call);
          handleTypeForName(qualifiedLower, callerMethodLabel, call);
          handleEventBusPublish(qualifiedLower, callerMethodLabel, mf, call);
          handleAsyncHop(qualifiedLower, callerMethodLabel, call);
        }
        // F1: statement-form DML.
        for (const dmlFact of mf.dml || []) {
          handleDmlStatement(qualifiedLower, callerMethodLabel, mf, dmlFact);
        }
        // G2: throw-statement sites.
        for (const throwSiteFact of mf.throwsSites || []) {
          handleThrowSite(qualifiedLower, callerMethodLabel, mf, throwSiteFact, tf);
        }
      }
    }
  }

  // ---- pass C: Batchable/Queueable/Schedulable execute() attachment, plus
  // F5's entry-kind tail (all interface-driven synthetic entries, same
  // shape: match by implementsTypes' last dotted segment, then walk the
  // extends chain for the declared-or-inherited method) ------------------
  const BQS_ARITY = { batchable: 2, queueable: 1, schedulable: 1 };
  const BQS_LABEL = { batchable: 'Batchable', queueable: 'Queueable', schedulable: 'Schedulable' };
  // F5: iface -> {method, arity, label}. `arity` is only a same-arity
  // PREFERENCE for findDeclaredOrInherited (it falls back to the first
  // same-named candidate when no exact-arity match exists), so a
  // slightly-off guess here never hides a real entry.
  const F5_ENTRY_RULES = [
    { iface: 'inboundemailhandler', method: 'handleinboundemail', arity: 1, label: 'InboundEmailHandler (Email Service)' },
    { iface: 'installhandler', method: 'oninstall', arity: 1, label: 'InstallHandler (package install)' },
    { iface: 'uninstallhandler', method: 'onuninstall', arity: 1, label: 'UninstallHandler (package uninstall)' },
    { iface: 'registrationhandler', method: 'createuser', arity: 2, label: 'RegistrationHandler (SSO)' },
    { iface: 'registrationhandler', method: 'updateuser', arity: 3, label: 'RegistrationHandler (SSO)' },
    { iface: 'comparable', method: 'compareto', arity: 1, label: 'Comparable (invoked by sort)' },
    { iface: 'finalizer', method: 'execute', arity: 1, label: 'Finalizer (async)' },
  ];
  for (const cm of classes.values()) {
    const ifaceHeads = (cm.implementsTypes || []).map(lastSegmentLower);
    for (const kind of Object.keys(BQS_ARITY)) {
      if (!ifaceHeads.includes(kind)) continue;
      const found = findDeclaredOrInherited(lc(cm.qualified), 'execute', BQS_ARITY[kind]);
      if (found && !found.method.entries.includes(BQS_LABEL[kind])) {
        found.method.entries.push(BQS_LABEL[kind]);
      }
      // F5: Batchable's start()/finish() are entry points exactly like
      // execute() -- the platform invokes the whole 3-method interface, not
      // just execute().
      if (kind === 'batchable') {
        for (const bqsMethod of ['start', 'finish']) {
          const bqsFound = findDeclaredOrInherited(lc(cm.qualified), bqsMethod, 1);
          if (bqsFound && !bqsFound.method.entries.includes('Batchable')) {
            bqsFound.method.entries.push('Batchable');
          }
        }
      }
    }
    for (const rule of F5_ENTRY_RULES) {
      if (!ifaceHeads.includes(rule.iface)) continue;
      const found = findDeclaredOrInherited(lc(cm.qualified), rule.method, rule.arity);
      if (found && !found.method.entries.includes(rule.label)) {
        found.method.entries.push(rule.label);
      }
    }
  }

  // ---- pass D: roll each class's own ClassMeta.entries up from its
  // methods' entries (simplest reading of "entries: [string]" on ClassMeta
  // — see header note; TNode's class-level entries badge reads this).
  for (const cm of classes.values()) {
    const seen = new Set();
    const list = [];
    for (const m of cm.methods) {
      for (const e of m.entries) {
        if (!seen.has(e)) {
          seen.add(e);
          list.push(e);
        }
      }
    }
    cm.entries = list;
  }

  // ---- pass E: PARSE-ERROR FALLBACK — lexical class-mention edges -------
  for (const file of factsList || []) {
    if (!file.parseError) continue;
    parseFallbacks.push(file.path);
    if (typeof file.text !== 'string') continue; // no source to scan (see header note)
    const callerLabel = file.name || file.path;
    const callerLabelLower = lc(callerLabel);
    const stripped = apexindex.strip(file.text);
    const lines = file.text.split('\n');
    const lineStarts = [0];
    for (let i = 0; i < stripped.length; i++) if (stripped[i] === '\n') lineStarts.push(i + 1);
    const ident = /[A-Za-z_][A-Za-z0-9_]*/g;
    const seenLine = new Set();
    let m;
    while ((m = ident.exec(stripped))) {
      const tok = lc(m[0]);
      if (tok === callerLabelLower) continue;
      if (m.index > 0 && stripped[m.index - 1] === '.') continue; // member access, not a type ref
      const matches = simpleNameIndex.get(tok);
      if (!matches || matches.length !== 1) continue; // only unambiguous simple-name mentions
      const targetClassLower = matches[0];
      let lo = 0, hi = lineStarts.length - 1;
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (lineStarts[mid] <= m.index) lo = mid;
        else hi = mid - 1;
      }
      const key = tok + ':' + lo;
      if (seenLine.has(key)) continue;
      seenLine.add(key);
      const site = {
        callerClass: callerLabel, // MUST-FIX: FileFacts.name as callerClass identity
        callerMethod: '(file)',
        callerKey: `${callerLabelLower}#(file)`,
        path: file.path,
        line: lo,
        col: m.index - lineStarts[lo],
        lineText: (lines[lo] || '').trim().slice(0, 160),
        args: [],
        via: 'lexical',
        targetMethod: null,
      };
      if (!classCallers.has(targetClassLower)) classCallers.set(targetClassLower, []);
      classCallers.get(targetClassLower).push(site);
    }
  }

  return {
    classes,
    methodCallers,
    classCallers,
    parseFallbacks,
    duplicates,
    dmlSitesByObject,
    publishSitesByObject,
    throwers,
    // H4: workspace-wide count of call sites this build positively
    // identified as dropped (see unresolvedSitesCount's own header comment
    // for the three counted categories). Every TreeResult carries this
    // through unchanged (see buildCallerTree's H4 stats passthrough) so the
    // UI can show one honest "N call sites workspace-wide could not be
    // resolved" header regardless of which target is being traced.
    stats: { unresolvedSites: unresolvedSitesCount },
  };
}

function computeAnnotationEntries(mf) {
  const entries = [];
  const anns = (mf.annotations || []).map(annBare);
  if (anns.includes('auraenabled')) entries.push('@AuraEnabled (LWC/Aura)');
  if (anns.includes('invocablemethod')) entries.push('@InvocableMethod (Flow)');
  if (anns.includes('future')) entries.push('@future (async)');
  if (anns.some((a) => HTTP_ANNOTATIONS.has(a))) entries.push('@HttpX (REST)');
  const mods = (mf.modifiers || []).map(lc);
  if (mods.includes('webservice')) entries.push('webservice (SOAP API)');
  return entries;
}

function methodIsTest(mf, classIsTest) {
  if (classIsTest) return true; // MUST-FIX #3: class-level isTest cascades
  const anns = (mf.annotations || []).map(annBare);
  if (anns.includes('istest')) return true;
  const mods = (mf.modifiers || []).map(lc);
  if (mods.includes('testmethod')) return true;
  return false;
}

// =========================================================================
// buildCallerTree
// =========================================================================

function methodLevelPairs(index, classLower, methodLower) {
  if (methodLower === '<init>') {
    return (index.classCallers.get(classLower) || []).map((site) => ({ site, targetMethodLower: '<init>' }));
  }
  return (index.methodCallers.get(`${classLower}#${methodLower}`) || []).map((site) => ({ site, targetMethodLower: methodLower }));
}

// Class-level rollup: classCallers[class] (covers 'new' + this/super
// ctor-chaining + lexical fallback) UNION methodCallers[class#name] for
// every OTHER (non-'<init>') declared method name. '<init>' is
// deliberately excluded from the method sweep here — classCallers already
// covers it in full — to avoid double-counting (decision list, header).
function classLevelPairs(index, classLower, cm) {
  const out = [];
  for (const site of index.classCallers.get(classLower) || []) out.push({ site, targetMethodLower: '<init>' });
  const seenNames = new Set();
  for (const m of cm.methods) {
    const nl = lc(m.name);
    if (nl === '<init>' || seenNames.has(nl)) continue;
    seenNames.add(nl);
    for (const site of index.methodCallers.get(`${classLower}#${nl}`) || []) out.push({ site, targetMethodLower: nl });
  }
  return out;
}

// SiteView.argsRendered: zip the call's raw arg texts against the target
// method's declared params when the arity matches exactly, else fall back
// to the raw joined arg texts (frozen SiteView contract). A4 extension:
// SiteView also passes overloadSig through. A2 extension: property
// accessor targets ('(get X)'/'(set X)') render specially -- 'value: <text>'
// for a setter's single implicit arg, '' for a getter (which never has
// args) -- since these synthetic scopes carry no declared MethodFacts.params
// to zip against in the first place.
function shapeSites(index, items, targetClassLower) {
  const tcm = index.classes.get(targetClassLower);
  return items.map(({ site, targetMethodLower }) => {
    const args = site.args || [];
    let argsRendered = args.length === 0 ? '' : args.join(', ');
    const nmLower = targetMethodLower || (site.targetMethod ? lc(site.targetMethod) : '');
    if (nmLower.charAt(0) === '(' && (nmLower.indexOf('(get ') === 0 || nmLower.indexOf('(set ') === 0)) {
      // A2: accessor scope -- no declared params to zip against.
      argsRendered = nmLower.indexOf('(set ') === 0 && args.length ? `value: ${args[0]}` : '';
    } else if (tcm) {
      let paramSets = [];
      if (targetMethodLower === '<init>') {
        paramSets = (tcm.typeFacts.methods || []).filter((m) => m.isCtor).map((m) => m.params || []);
      } else {
        const nm = site.targetMethod ? lc(site.targetMethod) : targetMethodLower;
        const candidates = tcm.methods.filter((m) => lc(m.name) === nm);
        // A4: when the call site pinned a specific overload (overloadSig)
        // and several same-name candidates exist, zip against THAT exact
        // overload's params instead of whichever one happens to come first
        // in declaration order (which may not be the resolved one when
        // multiple overloads share the call's arity).
        if (site.overloadSig && candidates.length > 1) {
          const match = candidates.find(
            (m) => `${m.name}(${(m.params || []).map((p) => p.type || 'Object').join(', ')})` === site.overloadSig
          );
          paramSets = match ? [match.params || []] : candidates.map((m) => m.params || []);
        } else {
          paramSets = candidates.map((m) => m.params || []);
        }
      }
      const exact = paramSets.find((p) => p.length === args.length);
      if (exact) {
        argsRendered = exact.map((p, i) => `${p.name}: ${args[i]}`).join(', ');
      }
    }
    return {
      path: site.path,
      line: site.line,
      col: site.col,
      lineText: site.lineText,
      argsRendered,
      via: site.via,
      overloadSig: site.overloadSig || null,
    };
  });
}

function sortTNodes(a, b) {
  if (a.isTest !== b.isTest) return a.isTest ? 1 : -1;
  return (a.label || '').localeCompare(b.label || '');
}

// =========================================================================
// G2: exception-target detection + catch-clause matching (buildCallerTree
// time -- these run against the returned `index`, not inside
// buildSemanticIndex's closure, since they're needed by buildCallerTree
// which is a separate top-level function; only the pure module-level text
// helpers (lc/lastSegmentLower/normalizeTypeName) and the `extendsLower`
// field cached onto each ClassMeta during buildSemanticIndex are needed).
// =========================================================================

// True when classLower's declared extends chain reaches the platform
// 'Exception' base type, OR (fallback) its simple name ends in 'Exception'
// and it has no resolved extends chain at all ("no other resolution").
function isExceptionTargetClass(index, cm) {
  // H7(b): via walkExtendsChain -- walks cm itself, then its ancestors.
  const foundExtendsException = walkExtendsChain(index, lc(cm.qualified), (curCm) =>
    curCm.extendsType && lastSegmentLower(curCm.extendsType) === 'exception' ? true : undefined
  );
  if (foundExtendsException) return true;
  if (!cm.extendsLower && /exception$/i.test(cm.name || '')) return true;
  return false;
}

// Lightweight classLower resolver for a catch clause's declared type,
// usable outside buildSemanticIndex's closure (no access to the real
// resolveType, which needs the calling scope's own qualified name for its
// inner-class-self-reference rule -- catch-clause exception types are
// essentially always top-level classes in practice, so exact-qualified and
// globally-unique-simple-name resolution alone is sufficient here).
function resolveClassLowerSimple(index, rawTypeName) {
  const norm = normalizeTypeName(rawTypeName);
  if (!norm) return null;
  if (index.classes.has(norm)) return norm;
  const simple = lastSegmentLower(rawTypeName);
  let match = null;
  let count = 0;
  for (const [key, c] of index.classes) {
    if (lc(c.name) === simple) {
      match = key;
      count++;
    }
  }
  return count === 1 ? match : null;
}

// True when ancestorLower appears anywhere in excLower's OWN extends chain
// (excLower itself included is handled by the caller's exact-match check
// first; this only needs the strictly-above-excLower ancestors).
function isAncestorOfException(index, ancestorLower, excLower) {
  // H7(b): via walkExtendsChain -- stops (true) the moment the walk from
  // excLower reaches ancestorLower.
  return !!walkExtendsChain(index, excLower, (cm, cur) => (cur === ancestorLower ? true : undefined));
}

// A catch clause matches the traced exception (tracingExceptionLower) when:
// its declared type is the bare platform 'Exception' (catches everything),
// OR resolves to the exact traced class, OR resolves to any ANCESTOR of the
// traced class within the USER exception hierarchy (a supertype catch).
function catchMatchesException(index, catchEntry, tracingExceptionLower) {
  if (!catchEntry || !catchEntry.typeName) return false;
  if (lastSegmentLower(catchEntry.typeName) === 'exception') return true;
  const catchLower = resolveClassLowerSimple(index, catchEntry.typeName);
  if (!catchLower) return false;
  if (catchLower === tracingExceptionLower) return true;
  return isAncestorOfException(index, catchLower, tracingExceptionLower);
}

function buildCallerTree(index, target, opts) {
  const maxDepth = (opts && opts.maxDepth) || DEFAULT_MAX_DEPTH;
  const maxNodes = (opts && opts.maxNodes) || DEFAULT_MAX_NODES;
  const classLower = lc(target && target.classLower);
  const cm = index.classes.get(classLower);

  if (!cm) {
    const rawLabel = target ? `${target.classLower || ''}${target.methodLower ? '.' + target.methodLower : ''}` : '';
    return {
      root: {
        label: rawLabel, kind: 'class', className: (target && target.classLower) || '', path: '', line: 0,
        methodLower: (target && target.methodLower) ? lc(target.methodLower) : null,
        entries: [], isTest: false, via: null, sites: [], children: [],
        cyclic: false, truncated: false, approximate: false,
      },
      targetLabel: rawLabel,
      note: 'target class not found in index',
      // H1/H4: stats still passed through even for a not-found target, so
      // callers can rely on TreeResult.stats always being present.
      stats: { nodes: 0, uniqueMethods: 0, capped: false, unresolvedSites: (index.stats && index.stats.unresolvedSites) || 0 },
    };
  }

  const isTrigger = cm.kind === 'trigger';
  const isAnonymous = cm.kind === 'anonymous';
  let methodLower = target && target.methodLower ? lc(target.methodLower) : null;
  if (isTrigger) methodLower = '(trigger)';

  let rootKind, rootLabel, rootLine, rootEntries, rootIsTest;
  if (isTrigger) {
    rootKind = 'trigger';
    rootLabel = cm.name;
    const mm = cm.methods.find((m) => lc(m.name) === '(trigger)');
    rootLine = mm ? mm.line : 0;
    rootEntries = mm ? mm.entries : [];
    rootIsTest = false;
  } else if (isAnonymous && methodLower === '(anonymous)') {
    // G4: anonymous-script pseudo-type's single method gets its own TNode
    // kind so uitree/pathmap's kind==='anonymous' branch (ICON_ANONYMOUS +
    // accent) actually fires against a real trace.
    rootKind = 'anonymous';
    const mm = cm.methods.find((m) => lc(m.name) === methodLower);
    rootLabel = cm.name;
    rootLine = mm ? mm.line : 0;
    rootEntries = mm ? mm.entries : [];
    rootIsTest = false;
  } else if (methodLower) {
    rootKind = 'method';
    const mm = cm.methods.find((m) => lc(m.name) === methodLower);
    const dispName = mm ? mm.name : methodLower;
    rootLabel = `${cm.name}.${dispName}`;
    rootLine = mm ? mm.line : 0;
    rootEntries = mm ? mm.entries : [];
    rootIsTest = mm ? mm.isTest : cm.isTest;
  } else {
    rootKind = 'class';
    rootLabel = cm.name;
    rootLine = 0;
    rootEntries = cm.entries;
    rootIsTest = cm.isTest;
  }

  const root = {
    label: rootLabel, kind: rootKind, className: cm.qualified, path: cm.path, line: rootLine,
    methodLower,
    entries: rootEntries, isTest: rootIsTest, via: null, sites: [], children: [],
    cyclic: false, truncated: false, approximate: false,
  };

  const ancestorPath = new Set(methodLower ? [`${classLower}#${methodLower}`] : []);
  const pairs = methodLower ? methodLevelPairs(index, classLower, methodLower) : classLevelPairs(index, classLower, cm);

  // G2: when the TARGET is itself an exception class (class-level target
  // only -- no methodLower), the level-1 children ALSO include every
  // 'throw' site that raises this exception, via='throws', alongside the
  // ordinary callers above. excCtx (the traced exception's own classLower +
  // display name) is threaded through the ENTIRE recursive walk below so
  // that every ancestor node, at any depth, can be checked for a matching
  // catch clause (caughtHere/badge) -- not just the level-1 throwers.
  let allPairs = pairs;
  let excCtx = null;
  if (!methodLower && isExceptionTargetClass(index, cm)) {
    excCtx = { lower: classLower, name: cm.name };
    const throwerSites = index.throwers.get(classLower) || [];
    const throwerPairs = throwerSites.map((site) => ({ site, targetMethodLower: lc(site.callerMethod) }));
    // v0.5/G2: throwerPairs go FIRST. A 'throw new AcmeX(...)' statement's
    // own 'new AcmeX(...)' expression is ALSO parsed as an ordinary rule-1
    // CallFacts (constructing the exception instance is a real, separate
    // fact from throwing it), so the SAME caller can legitimately show up
    // in both `pairs` (via='new', from classLevelPairs) and `throwerPairs`
    // (via='throws') for the exact same call site. buildOneChild displays
    // whichever via appears FIRST in the group's items (g.items[0]), so
    // ordering throwerPairs first makes the more informative 'throws' via
    // win for that shared caller, matching the G2 spec's documented
    // ground truth (a thrower is shown as via='throws', not via='new').
    allPairs = throwerPairs.concat(pairs);
  }

  // H1: shared build context for this ENTIRE buildCallerTree call --
  // nodeCount counts every TNode actually materialized (root + every
  // Apex/meta/flow-children node below); expandedKeys is the DAG
  // memoization table (a classLower#methodLower subtree is expanded AT MOST
  // ONCE per call, see buildOneChildNode); uniqueKeys is every distinct
  // classLower#methodLower identity that appeared as a node anywhere in the
  // tree, expanded or not (-> stats.uniqueMethods). `queue` drives a
  // breadth-first expansion (FIFO) across the WHOLE tree -- not per-branch
  // DFS recursion -- specifically so a maxNodes cap (when it fires) stops
  // fairly across all branches rather than fully draining whichever branch
  // happened to be visited first.
  const ctx = { maxDepth, maxNodes, nodeCount: 1, capped: false, expandedKeys: new Set(), uniqueKeys: new Set() };
  const queue = [];
  root.children = buildChildrenLevel(index, allPairs, 1, ancestorPath, classLower, excCtx, ctx, queue);
  while (queue.length) {
    const task = queue.shift(); // FIFO -> breadth-first across the whole tree
    task.node.children = buildChildrenLevel(index, task.pairs, task.depth, task.ancestorPath, task.targetClassLower, excCtx, ctx, queue);
  }

  // A6: fold in metadata callers (LWC/Aura/Flow/OmniScript/VF) attached via
  // attachMetaCallers(), as TERMINAL children alongside the Apex ones.
  const metaRefs = isTrigger ? [] : metaLevelPairs(index, classLower, methodLower);
  if (metaRefs.length && ctx.nodeCount < ctx.maxNodes) {
    const metaChildren = buildMetaChildren(index, metaRefs);
    ctx.nodeCount += countTNodes(metaChildren);
    root.children = root.children.concat(metaChildren).sort(sortTNodes);
  } else if (metaRefs.length) {
    ctx.capped = true;
  }

  return {
    root,
    targetLabel: rootLabel,
    // H4: a resolved target with genuinely zero callers (both Apex and
    // metadata/flow) gets an honest info note instead of silently rendering
    // an empty tree.
    note: root.children.length === 0 ? ZERO_CALLER_NOTE : null,
    stats: {
      nodes: ctx.nodeCount,
      uniqueMethods: ctx.uniqueKeys.size,
      capped: ctx.capped,
      unresolvedSites: (index.stats && index.stats.unresolvedSites) || 0,
    },
  };
}

// H1: counts every TNode in a (small, non-recursive-beyond-flow-children)
// subtree -- used only to fold metadata/flow-children node counts into
// ctx.nodeCount for stats.nodes honesty; these are never large enough to
// need their own maxNodes enforcement (buildMetaChildren/buildFlowChildren
// are bounded by the metadata scan / DML-site inventory, not by recursive
// caller-tree fan-out).
function countTNodes(nodes) {
  let n = 0;
  for (const node of nodes || []) {
    n += 1 + countTNodes(node.children);
  }
  return n;
}

// A6: 'method-target lookups consult metaMethodCallers[targetKey] plus
// (class-level refs of that class only for class targets)' -- a method-level
// target only ever sees refs pinned to that exact method; a class-level
// target (no method filter) only ever sees refs with no methodName (a class-
// level reference like an Aura `controller="..."` attribute or a Flow
// actionCalls block that names the class but not a method) -- method-
// specific refs already surface individually when tracing that method.
function metaLevelPairs(index, classLower, methodLower) {
  if (methodLower) {
    if (!index.metaMethodCallers) return [];
    return index.metaMethodCallers.get(`${classLower}#${methodLower}`) || [];
  }
  if (!index.metaCallers) return [];
  return (index.metaCallers.get(classLower) || []).filter((r) => !r.methodName);
}

function metaEntryLabel(kind) {
  switch (kind) {
    case 'lwc':
      return '@salesforce/apex import';
    case 'aura':
      return 'Aura controller';
    case 'flow':
      return 'Flow apex action';
    case 'omniscript':
      return 'OmniScript Remote Action';
    case 'vf':
      return 'VF controller';
    case 'cmdt':
      return 'Custom Metadata record';
    default:
      return 'metadata reference';
  }
}

// A6: groups MetaRefs into one TERMINAL(*) TNode per distinct (kind, label)
// metadata source -- e.g. one LWC bundle's import may legitimately produce
// several refs (wire + imperative) that should collapse onto a single
// caller node with multiple sites, mirroring how Apex callers group by
// caller identity in buildChildren/buildOneChild.
// (*) F1(b): a 'flow' ref carrying flowObject/flowRecordTriggerType is no
// longer terminal -- its children are the DML sites on that object whose op
// matches its recordTriggerType (see buildDmlChildrenForFlow). G1(b): when
// flowTriggerType is 'PlatformEvent' (NOT flowRecordTriggerType -- a
// platform-event flow's <start> never carries a <recordTriggerType>
// element, see metascan.js's extractFlowStart) the flow is platform-event-
// triggered instead of record-triggered, and its children are EventBus
// publish sites on that object instead of DML sites (see
// buildPublishChildrenForFlow).
function buildMetaChildren(index, metaRefs) {
  const groups = new Map();
  for (const ref of metaRefs || []) {
    if (!ref) continue;
    const key = `${ref.kind}::${ref.label}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(ref);
  }
  const out = [];
  for (const refs of groups.values()) {
    const first = refs[0];
    let children = [];
    // G1(b): a platform-event flow's <start> NEVER carries <recordTriggerType>
    // (metascan.js's extractFlowStart leaves it null by construction for the
    // PlatformEvent shape -- see its header doc) -- so this branch must key
    // off flowTriggerType, not flowRecordTriggerType, or it can never fire.
    // Checked BEFORE the flowRecordTriggerType branch since the two fields
    // are mutually exclusive per metascan.js's contract (exactly one is
    // ever non-null on a given ref).
    if (first.kind === 'flow' && first.flowObject && lc(first.flowTriggerType) === 'platformevent') {
      children = buildFlowChildren(index, lc(first.flowObject), 'publish', null);
    } else if (first.kind === 'flow' && first.flowObject && first.flowRecordTriggerType) {
      const matchOps = flowOpsForRecordTriggerType(first.flowRecordTriggerType);
      children = buildFlowChildren(index, lc(first.flowObject), 'dml', matchOps);
    }
    out.push({
      label: first.label,
      kind: first.kind,
      className: '',
      methodLower: null,
      path: first.path || '',
      line: first.line || 0,
      entries: [metaEntryLabel(first.kind)],
      isTest: false,
      via: 'metadata',
      sites: refs.map((r) => ({
        path: r.path || '',
        line: r.line || 0,
        col: 0,
        lineText: r.lineText || '',
        argsRendered: '',
        via: 'metadata',
        overloadSig: null,
      })),
      children,
      cyclic: false,
      truncated: false,
      approximate: false,
    });
  }
  return out;
}

// H7(b): buildDmlChildrenForFlow and buildPublishChildrenForFlow used to be
// two near-identical functions (same grouping, same TNode shape) differing
// only in which sitesByObject map they read and whether they filtered by
// op -- merged into one parameterized builder. Builds the TERMINAL children
// of a record-triggered (via='dml') or platform-event-triggered
// (via='publish') flow node: one grouped node per distinct (callerClass,
// callerMethod) site on objectLower. For 'dml', entries come from
// dmlSitesByObject filtered to matchOps (a record-triggered flow only fires
// for its own recordTriggerType's DML ops); for 'publish', entries come
// unconditionally from publishSitesByObject (EventBus.publish() has no op
// concept to filter on -- a platform-event flow fires on every publish to
// its object, per G1(b)).
function buildFlowChildren(index, objectLower, via, matchOps) {
  const sitesMap = via === 'publish' ? index.publishSitesByObject : index.dmlSitesByObject;
  const entries = (sitesMap && sitesMap.get(objectLower)) || [];
  const matched = via === 'publish' ? entries : entries.filter((e) => (matchOps || []).includes(e.op));
  const groups = new Map();
  for (const e of matched) {
    const key = `${lc(e.callerClass)}#${lc(e.callerMethod)}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(e);
  }
  const out = [];
  for (const items of groups.values()) {
    const first = items[0];
    const ccm = index.classes.get(lc(first.callerClass));
    const methodLowerFlow = lc(first.callerMethod);
    const mm = ccm ? ccm.methods.find((m) => lc(m.name) === methodLowerFlow) : null;
    const isTriggerCaller = !!(ccm && ccm.kind === 'trigger');
    const label = ccm ? (isTriggerCaller ? ccm.name : `${ccm.name}.${mm ? mm.name : first.callerMethod}`) : first.callerClass;
    out.push({
      label,
      kind: isTriggerCaller ? 'trigger' : 'method',
      className: ccm ? ccm.qualified : first.callerClass,
      methodLower: isTriggerCaller ? '(trigger)' : methodLowerFlow,
      path: first.path,
      line: mm ? mm.line : 0,
      entries: mm ? mm.entries : [],
      isTest: mm ? mm.isTest : !!(ccm && ccm.isTest),
      via,
      sites: items.map((e) => ({
        path: e.path,
        line: e.line,
        col: e.col,
        lineText: e.lineText,
        argsRendered: (e.args || []).join(', '),
        via,
        overloadSig: null,
      })),
      children: [],
      cyclic: false,
      truncated: false,
      approximate: false,
    });
  }
  out.sort(sortTNodes);
  return out;
}

// A6: attaches metascan.js's MetaRef[] output onto an existing index,
// mutating it with metaCallers (by class) and metaMethodCallers (by
// 'classLower#methodLower'). Pure and order-independent: safe to call
// multiple times / with refs from multiple scans (later calls append,
// they don't replace).
function attachMetaCallers(index, metaRefs) {
  if (!index) return index;
  const metaCallers = index.metaCallers instanceof Map ? index.metaCallers : new Map();
  const metaMethodCallers = index.metaMethodCallers instanceof Map ? index.metaMethodCallers : new Map();
  for (const ref of metaRefs || []) {
    if (!ref || !ref.className) continue;
    const classLower = lc(ref.className);
    if (!metaCallers.has(classLower)) metaCallers.set(classLower, []);
    metaCallers.get(classLower).push(ref);
    if (ref.methodName) {
      const key = `${classLower}#${lc(ref.methodName)}`;
      if (!metaMethodCallers.has(key)) metaMethodCallers.set(key, []);
      metaMethodCallers.get(key).push(ref);
    } else if (ref.kind === 'flow') {
      // Cross-reference: a Flow actionCalls block with a BARE actionName
      // (class only, e.g. <actionName>AcmeDiscountApprovalInvocable</actionName>)
      // implicitly targets that class's @InvocableMethod entry point --
      // Flow XML never spells out the method name for this shape. If the
      // referenced class declares EXACTLY one @InvocableMethod method,
      // combine the annotation (already surfaced by parser.js/resolver.js's
      // entries[]) with the bare class reference to land the ref at the
      // method level too, in addition to the existing class-level
      // registration above (untouched, so class-level tracing keeps
      // working exactly as before). Ambiguous (0 or >1 candidates) classes
      // are left at class-level only -- no guessing.
      const invocableMethodName = findSoleInvocableMethod(index, classLower);
      if (invocableMethodName) {
        const key = `${classLower}#${lc(invocableMethodName)}`;
        if (!metaMethodCallers.has(key)) metaMethodCallers.set(key, []);
        metaMethodCallers.get(key).push(ref);
      }
    }
  }
  index.metaCallers = metaCallers;
  index.metaMethodCallers = metaMethodCallers;
  return index;
}

// Returns the method name of the sole @InvocableMethod-annotated method on
// classLower, or null if the class isn't in the index or declares zero/more
// than one such method (ambiguous -- no edge is safer than a guess).
function findSoleInvocableMethod(index, classLower) {
  const cm = index.classes && index.classes.get(classLower);
  if (!cm || !Array.isArray(cm.methods)) return null;
  const matches = cm.methods.filter((m) => (m.entries || []).includes('@InvocableMethod (Flow)'));
  if (matches.length !== 1) return null;
  return matches[0].name;
}

// excCtx (v0.5/G2, optional): { lower, name } of the exception class this
// WHOLE tree is being traced for, or null/undefined for an ordinary trace.
// Threaded through every recursive level (not just level-1) so any ancestor
// node, at any depth, can be checked for a matching catch clause.
// H1: groups `pairs` into one TNode-shell per distinct caller identity (same
// grouping as before), but does NOT recurse into any node's own children
// directly -- instead it hands each node needing further expansion to
// `queue` (as a task) and returns immediately, so buildCallerTree's single
// top-level while-loop can drain that queue breadth-first across the WHOLE
// tree. Also enforces the maxNodes cap: once ctx.nodeCount reaches
// ctx.maxNodes, stops creating any further nodes THIS call (and every other
// still-queued task, since they all share the same ctx) and marks
// ctx.capped = true -- the top-level TreeResult.stats.capped flag is what
// makes this visible; nothing is silently dropped without it.
function buildChildrenLevel(index, pairs, depth, ancestorPath, targetClassLower, excCtx, ctx, queue) {
  const groups = new Map();
  for (const item of pairs) {
    const site = item.site;
    let key, gClassLower, gMethodLabel, isLexical;
    if (site.via === 'lexical') {
      gClassLower = lc(site.callerClass);
      gMethodLabel = '(file)';
      isLexical = true;
      key = `LEX#${gClassLower}`;
    } else {
      gClassLower = lc(site.callerClass);
      gMethodLabel = site.callerMethod;
      isLexical = false;
      key = `${gClassLower}#${lc(gMethodLabel)}`;
    }
    if (!groups.has(key)) groups.set(key, { gClassLower, gMethodLabel, isLexical, items: [] });
    groups.get(key).items.push(item);
  }
  const out = [];
  for (const g of groups.values()) {
    if (ctx.nodeCount >= ctx.maxNodes) {
      ctx.capped = true;
      break;
    }
    const built = buildOneChildNode(index, g, depth, ancestorPath, targetClassLower, excCtx, ctx);
    ctx.nodeCount++;
    out.push(built.node);
    if (built.expandTask) queue.push(built.expandTask);
  }
  out.sort(sortTNodes);
  return out;
}

// H1: builds ONE child TNode (no recursion) and decides its terminal status,
// in priority order: (1) lexical / defensive-missing-class -- always
// terminal, unrelated to the DAG-memoization keying below; (2) cyclic --
// this exact classLower#methodLower is already on the CURRENT root-to-node
// ancestor path (unchanged pre-H1 semantics, and still wins over (3) per
// the H1 spec: "cyclic flag still wins over seenElsewhere on ancestor-path
// hits"); (3) seenElsewhere (NEW) -- this identity's subtree was ALREADY
// expanded once elsewhere in this tree (ctx.expandedKeys), so its own
// children are shown as [] here rather than re-walking (and re-materializing
// nodes for) a subtree this call has already built in full; (4) truncated --
// depth cap, unchanged pre-H1 semantics, checked AFTER seenElsewhere so a
// deduped node never gets mislabeled "stopped due to depth" when it's
// actually "already shown in full elsewhere"; (5) normal -- marks this
// identity expanded (so any LATER occurrence hits case 3) and returns an
// expandTask for the caller to enqueue.
function buildOneChildNode(index, g, depth, ancestorPath, targetClassLower, excCtx, ctx) {
  const approximate = g.items.length > 0 && g.items.every((it) => APPROX_VIA.has(it.site.via));

  if (g.isLexical) {
    const first = g.items[0].site;
    return {
      node: {
        label: first.callerClass, kind: 'class', className: first.callerClass, path: first.path, line: 0,
        methodLower: null,
        entries: [], isTest: false, via: 'lexical',
        sites: shapeSites(index, g.items, targetClassLower),
        children: [], cyclic: false, truncated: false, approximate: true, seenElsewhere: false,
      },
      expandTask: null,
    };
  }

  const ccm = index.classes.get(g.gClassLower);
  const methodLower2 = lc(g.gMethodLabel);
  const cycleKey = `${g.gClassLower}#${methodLower2}`;

  if (!ccm) {
    // Defensive: a non-lexical CallSite should always reference an indexed
    // class, but never crash the tree if that invariant is ever violated.
    return {
      node: {
        label: g.gMethodLabel, kind: 'method', className: g.gClassLower, path: '', line: 0,
        methodLower: methodLower2,
        entries: [], isTest: false, via: g.items[0].site.via,
        sites: shapeSites(index, g.items, targetClassLower),
        children: [], cyclic: false, truncated: false, approximate, seenElsewhere: false,
      },
      expandTask: null,
    };
  }

  const isTriggerCaller = ccm.kind === 'trigger';
  const mm = ccm.methods.find((m) => lc(m.name) === methodLower2);
  const label = isTriggerCaller ? ccm.name : `${ccm.name}.${mm ? mm.name : g.gMethodLabel}`;

  const node = {
    label, kind: isTriggerCaller ? 'trigger' : 'method', className: ccm.qualified, path: ccm.path,
    methodLower: isTriggerCaller ? '(trigger)' : methodLower2,
    line: mm ? mm.line : 0, entries: mm ? mm.entries : [], isTest: mm ? mm.isTest : ccm.isTest,
    via: g.items[0].site.via, sites: shapeSites(index, g.items, targetClassLower),
    children: [], cyclic: false, truncated: false, approximate, seenElsewhere: false,
  };

  // G2: while tracing an exception's caller tree, every ANCESTOR node whose
  // OWN method declares a catch clause matching that exception (exact user
  // type, any ancestor of it in the USER exception hierarchy, or bare
  // 'Exception') gets an additive caughtHere:true flag plus an entries
  // badge -- purely additive over node.entries (uses .concat, never .push,
  // so the underlying MethodMeta.entries array shared across every trace is
  // never mutated). Checked here (before the cyclic/seenElsewhere/truncated
  // status checks below) so a node still gets its badge even when the walk
  // doesn't recurse further past it.
  //
  // Excludes the level-1 THROWER node itself (node.via === 'throws'): a
  // thrower's own enclosing catch clause (the "catch (X e) { ...; throw
  // e; }" rethrow shape) matches syntactically, but it isn't an ancestor
  // intercepting propagation from the traced throw site -- it's the throw
  // site's own frame, already surfaced via via='throws'. Confirmed against
  // MANIFEST.md's v0.5 G2 tally (AcmeShipmentService.reprocessFailedShipment
  // is documented as a thrower leaf with zero callers, and is explicitly
  // NOT one of the 4 counted caughtHere-badge classifications, unlike the 3
  // ordinary ancestor catchers + 1 documented-absence negative that are).
  if (excCtx && !isTriggerCaller && node.via !== 'throws') {
    const rawMethod = (ccm.typeFacts.methods || []).find((m) => !m.isCtor && lc(m.name) === methodLower2);
    if (rawMethod && (rawMethod.catches || []).some((c) => catchMatchesException(index, c, excCtx.lower))) {
      node.caughtHere = true;
      node.entries = node.entries.concat([`catches ${excCtx.name}`]);
    }
  } else if (excCtx && isTriggerCaller && node.via !== 'throws') {
    // A trigger's own '(trigger)' pseudo-method can carry a catch clause
    // too (see G2 scenario 3 -- AcmeOrderTrigger.trigger's bare `catch
    // (Exception ex)`). Its raw MethodFacts lives under the '(trigger)'
    // name, same as everywhere else triggers are modeled in this file.
    const rawTrigMethod = (ccm.typeFacts.methods || []).find((m) => !m.isCtor && lc(m.name) === '(trigger)');
    if (rawTrigMethod && (rawTrigMethod.catches || []).some((c) => catchMatchesException(index, c, excCtx.lower))) {
      node.caughtHere = true;
      node.entries = node.entries.concat([`catches ${excCtx.name}`]);
    }
  }

  ctx.uniqueKeys.add(cycleKey);

  if (ancestorPath.has(cycleKey)) {
    node.cyclic = true;
    return { node, expandTask: null };
  }
  // H1 (DAG memoization): this identity's subtree was already expanded once
  // elsewhere in this same buildCallerTree call -- show it as a reference
  // node (label/sites unchanged, children forced empty) instead of
  // re-walking (and re-materializing) the same subtree again.
  if (ctx.expandedKeys.has(cycleKey)) {
    node.seenElsewhere = true;
    return { node, expandTask: null };
  }
  if (depth >= ctx.maxDepth) {
    node.truncated = true;
    return { node, expandTask: null };
  }
  ctx.expandedKeys.add(cycleKey);
  const nextPath = new Set(ancestorPath);
  nextPath.add(cycleKey);
  const nextPairs = methodLevelPairs(index, g.gClassLower, methodLower2);
  return {
    node,
    expandTask: { node, pairs: nextPairs, depth: depth + 1, ancestorPath: nextPath, targetClassLower: g.gClassLower },
  };
}

// =========================================================================
// suggestTargets
// =========================================================================

function suggestTargets(index) {
  const out = [];
  for (const cm of index.classes.values()) {
    out.push({ label: cm.name, classLower: lc(cm.qualified), methodLower: null });
    const seen = new Set();
    for (const m of cm.methods) {
      const nl = lc(m.name);
      if (seen.has(nl)) continue;
      seen.add(nl);
      // MUST-FIX #5: accessor scopes are call-graph sources only, never
      // valid trace targets — suppressed here so users never pick a target
      // guaranteed to show zero callers.
      if (nl.startsWith('(get ') || nl.startsWith('(set ')) continue;
      const label = cm.kind === 'trigger' ? cm.name : `${cm.name}.${m.name}`;
      out.push({ label, classLower: lc(cm.qualified), methodLower: nl });
    }
  }
  out.sort((a, b) => a.label.localeCompare(b.label));
  return out;
}

module.exports = {
  buildSemanticIndex,
  buildCallerTree,
  suggestTargets,
  attachMetaCallers,
};

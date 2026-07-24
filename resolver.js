'use strict';
// Semantic method-level Apex call-graph engine. Pure data-in/data-out: no
// vscode, no fs. Input is FileFacts[] as produced by parser.js; this file never depends
// on parser.js's implementation, only its documented output shape.
//
// =========================================================================
// Parser data shape consumed by this module:
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
// module reads a field outside the ordinary FileFacts shape.
//
// =========================================================================
// Resolution notes:
//
// - All parser-provided locals participate in type lookup uniformly.
// - Method identities omit arity, so overloads share an index key. Site
//   rendering still selects the best matching signature from raw TypeFacts.
// - isTest cascades from class or method markers.
// - Accessor scopes can be call sources but are not selectable call targets.
// - Enclosing inner-class scope wins before global bare-name lookup.
// - User-defined types and typed variables take precedence over the platform
//   denylist, preserving valid shadowing.
// - Type normalization covers namespace, generic, and case differences.
// - Duplicate qualified names preserve all candidates for package-aware
//   resolution; first-seen order remains deterministic.
// - Class-level constructor rollups include `new`, `this()`, and `super()`
//   callers without double-counting method-level constructor buckets.
// =========================================================================

const apexindex = require('./apexindex');

const DEFAULT_MAX_DEPTH = 8;
// Hard total-node cap for one buildCallerTree call (opts.maxNodes
// overrides). See buildCallerTree's ctx/queue machinery for how this is
// enforced breadth-first-fairly rather than by fully draining one branch.
const DEFAULT_MAX_NODES = 2000;
// Exact TreeResult.note text for a trace that resolved to a real target
// but found zero callers (root.children.length === 0 after both the Apex
// tree AND any metadata/flow children are folded in).
const ZERO_CALLER_NOTE = 'No callers found — this is likely an entry point or unused code.';

// Fluent-chain receiver walk cap. Longer or cyclic chains fall through to
// normal unresolved/unique-name handling.
const CHAIN_MAX = 12;

// Shared clamp for buildCallerTree/buildExternalCallerTree/
// buildCalleeTree's opts.maxDepth/opts.maxNodes (and, via
// normalizeProgressiveOpts, opts.initialDepth) -- hardens the walker against
// direct-invocation surfaces that might feed it unclamped values. `value`
// is coerced via Number(): a non-finite result (NaN --
// covers both an actual NaN and any non-numeric input like a string that
// doesn't parse, undefined, null -- Infinity, -Infinity) falls back to
// `fallback` (the DEFAULT_MAX_DEPTH/DEFAULT_MAX_NODES constant, or
// -- for initialDepth -- the caller's own already-clamped maxDepth). A
// finite value is truncated to an integer, then clamped into [min, max]
// inclusive -- an in-range value (e.g. maxDepth:3, maxNodes:10) passes
// through completely untouched.
function clampInt(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  const truncated = Math.trunc(n);
  if (truncated < min) return min;
  if (truncated > max) return max;
  return truncated;
}
// The [1, X] upper bounds clampInt enforces for maxDepth/maxNodes
// specifically (initialDepth's upper bound is the CALLER's own already-
// clamped maxDepth, not one of these two -- see normalizeProgressiveOpts).
const MAX_DEPTH_CLAMP = 64;
const MAX_NODES_CLAMP = 100000;

// Shared progressive-depth option normalization for
// buildCallerTree/buildExternalCallerTree/buildCalleeTree. initialDepth
// defaults to maxDepth, preserving the legacy fully expanded tree.
// expandedKeys is caller-supplied as an iterable of methodKeyLower strings
// ('classlower#methodlower', the SAME format buildOneChildNode's own
// cycleKey already uses) -- normalized into a fresh Set (lowercased
// defensively) so buildOneChildNode can do an O(1) `.has(cycleKey)` check
// per node without re-deriving anything from opts on every call.
// `maxDepth` here is already the caller's own clamped value (see
// buildCallerTree/buildExternalCallerTree/buildCalleeTree, each of which
// clamps its local `maxDepth` via clampInt before calling this), so
// clamping initialDepth into [1, maxDepth] here automatically inherits that
// bound -- no separate MAX_DEPTH_CLAMP reference needed in this function.
function normalizeProgressiveOpts(opts, maxDepth) {
  const rawInitialDepth = (opts && opts.initialDepth != null) ? opts.initialDepth : maxDepth;
  const initialDepth = clampInt(rawInitialDepth, 1, maxDepth, maxDepth);
  const userExpandedKeys = new Set();
  if (opts && opts.expandedKeys) {
    for (const k of opts.expandedKeys) userExpandedKeys.add(lc(k));
  }
  return { initialDepth, userExpandedKeys };
}

// Shared opts-normalization for apexCallGraph.showUnconfirmed:
// 'rollup' (default) | 'hide' | 'expand'. Any other/missing value normalizes
// to 'rollup', matching the
// setting's own documented default -- so a caller that never touches opts at
// all gets the default, not a silent opt-out;
// see buildChildrenLevel's own header note for how each mode actually
// changes the built children array.
function normalizeShowUnconfirmed(opts) {
  const v = opts && opts.showUnconfirmed;
  return v === 'hide' || v === 'expand' ? v : 'rollup';
}

// Shared by buildCallerTree/buildExternalCallerTree/buildCalleeTree's
// own BFS expansion loops (a SEPARATE call from buildSemanticIndex's own
// internal opts.shouldCancel guard -- these three functions receive the
// trace-time `opts`, not the index-build-time one, and are called well after
// the index already exists).
function shouldCancelOpt(opts) {
  return !!(opts && typeof opts.shouldCancel === 'function' && opts.shouldCancel());
}

// Platform classes that must not be mistaken for workspace types.
const PLATFORM_DENYLIST = new Set([
  'system', 'database', 'test', 'schema', 'math', 'json', 'string', 'integer',
  'long', 'decimal', 'double', 'boolean', 'date', 'datetime', 'time', 'id',
  'blob', 'object', 'list', 'map', 'set', 'trigger', 'userinfo', 'limits',
  'type', 'enum', 'eventbus', 'messaging', 'http', 'httprequest',
  'httpresponse', 'restcontext', 'restrequest', 'restresponse', 'apexpages',
  'pagereference', 'url', 'crypto', 'encodingutil', 'site', 'network',
  'label', 'page', 'component', 'auth', 'cache', 'search', 'approval',
]);

// v0.7.1/R3: common Map/List/Set builtin accessor method names. Gates rule
// 7's unique-name fallback (resolveDotOther) — by the time that fallback is
// even reached, EVERY prior resolution rule has already failed to identify
// the receiver's class (it is, by construction, "collection-typed or
// unresolved"), so a call to one of
// these extremely common, generic-sounding names must never be allowed to
// collide with an unrelated, incidentally-unique real method of the same
// name anywhere else in the workspace (`newRecordsByType.get(tkey)` falsely
// resolving to `KappaServiceLocator.get`).
const COLLECTION_ACCESSOR_NAMES = new Set([
  'get', 'put', 'add', 'addall', 'remove', 'removeall', 'retainall',
  'contains', 'containskey', 'containsall', 'containsvalue',
  'values', 'keyset', 'entryset', 'size', 'isempty', 'clear', 'clone',
  'deepclone', 'sort', 'iterator', 'set', 'putall', 'getall',
]);

// Declared receiver types that belong to the Apex runtime rather than a
// workspace class. Once ordinary typed resolution has failed, calls on one
// of these types are known platform behavior: they must not inflate global
// unresolved counts or become name-only candidate callers of an unrelated
// user method. The extra schema/runtime result types cover common instance
// APIs whose names (`get`, `contains`, `size`, ...) otherwise dominate large
// orgs. A genuine local class still wins first through emitTypedOrInterface.
const PLATFORM_RECEIVER_TYPES = new Set([
  // Keep Object out: it is also the conventional declared type for values
  // whose runtime receiver is genuinely unknown. Suppressing it would hide
  // real unresolved/dynamic sites instead of only known platform behavior.
  ...[...PLATFORM_DENYLIST].filter((name) => name !== 'object'),
  'sobject', 'sobjecttype', 'aggregateresult', 'describefieldresult',
  'describesobjectresult', 'savepoint', 'exception', 'pattern', 'matcher',
]);

function isKnownPlatformReceiverType(rawType) {
  return PLATFORM_RECEIVER_TYPES.has(lastSegmentLower(rawType));
}

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
// v0.7/B3: 'ambiguous' (B2 duplicate-name fan-out, neither the same-package
// nor default-package preference rule could disambiguate) joins the
// approximate set -- by construction it's ALWAYS a multi-candidate fan-out
// from one call site, exactly the same "genuinely can't tell which one"
// reasoning as 'interface'/'narrowed'.
const APPROX_VIA = new Set(['interface', 'unique-name', 'lexical', 'override', 'dynamic', 'narrowed', 'ambiguous']);

// v0.13/H1: ATTACHMENT CAP for rule 7's unique-name fallback. A bare/dotted
// call whose receiver could not be resolved to anything at all falls back to
// "the workspace's sole declarer of this method name" (unresolvedFallback,
// below) -- fine for a genuinely rare/project-specific name, but a magnet in
// a big org: a framework-common name (e.g. `bind`) called on thousands of
// unresolvable receivers attaches EVERY one of them as a false caller of the
// one local class that happens to declare it. If a single target method
// would receive MORE than this many unique-name attachments across the whole
// workspace, none of them are trustworthy signal any more (that volume is
// itself proof the name is framework-common, not semantically unique) -- see
// finalizeUniqueNameCap's own header note for how the cap is actually
// enforced (a post-pass-B reconciliation, since the true total count isn't
// known until every file has been walked).
const UNIQUE_NAME_MAX = 5;

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
  const orig = dmlObjectHeadOriginal(rawType);
  return orig ? lc(orig) : null;
}

// v0.8/N1(b)/N3: same wrapper-stripping as dmlObjectHead, but preserves the
// object token's ORIGINAL case (dmlObjectHead's own lastSegmentLower() call
// discards it). Needed so a managed-object external's `label`/`className`
// (e.g. 'kwx__Ledger__c') renders with the exact source-text casing instead
// of resolver.js's internal all-lowercase comparison keys -- see
// resolveDmlTargetObject's own header note for how this feeds the N1(b)/N3
// pipeline. `dmlObjectHead` above is now a thin lc() wrapper around this so
// every pre-v0.8 caller's behavior (a lowercased objectLower string) is
// completely unchanged.
function dmlObjectHeadOriginal(rawType) {
  if (!rawType) return null;
  let s = String(rawType).trim();
  const listMatch = s.match(/^(?:List|Set)\s*<\s*([^<>]+)\s*>$/i);
  if (listMatch) s = listMatch[1];
  s = s.replace(/\[\]\s*$/, '').trim();
  if (!s) return null;
  return lastSegmentOriginal(s);
}

// v0.8/N1: 'ns__Rest' -> { ns, rest } (original case, unsplit further) on the
// FIRST '__' occurrence only, or null when the token has no '__' at all (or
// starts with one, or the ns-candidate segment isn't itself identifier-
// shaped). Deliberately does not care whether `rest` looks like anything in
// particular -- callers decide what shape of `rest` they're looking for
// (an object ending in '__c' for a DML target per N1(b), a bare class name
// NOT ending in '__c' for a metascan Flow/CMDT actionName/value per N1(c) --
// see detectMetaRefNamespace's own header note on why that distinction
// matters for not misreading an ordinary '..._Whatever__c' custom-object
// token, e.g. this corpus's pre-existing 'Kappa_Order__c' CMDT value, as a
// namespaced CLASS reference).
function splitNamespacePrefix(token) {
  const s = String(token == null ? '' : token);
  const idx = s.indexOf('__');
  if (idx <= 0) return null;
  const ns = s.slice(0, idx);
  const rest = s.slice(idx + 2);
  if (!rest || !SIMPLE_IDENT_RE.test(ns)) return null;
  return { ns, rest };
}

// v0.8/N5: index.stats.externalRefs/externalNamespaces are ALWAYS derived
// fresh from the live `externals` Map's current contents (never a separately
// tracked running counter) -- both buildSemanticIndex (Apex/DML sources) and
// attachMetaCallers (metascan sources, possibly called several times over
// the same index, per its own pre-existing "safe to call multiple times"
// contract) mutate the SAME Map object in place, so recomputing here at
// whichever point stats get read/refreshed can never drift out of sync with
// what `externals`/suggestTargets/buildCallerTree's external-root branch
// actually see. externalNamespaces is deduped by lowercase and sorted
// case-insensitively for a deterministic header/list order.
function computeExternalStats(externalsMap) {
  let externalRefs = 0;
  const seenNs = new Set();
  const namespaces = [];
  for (const ext of externalsMap ? externalsMap.values() : []) {
    externalRefs += ext.refCount || 0;
    const key = lc(ext.ns);
    if (!seenNs.has(key)) {
      seenNs.add(key);
      namespaces.push(ext.ns);
    }
  }
  namespaces.sort((a, b) => lc(a).localeCompare(lc(b)));
  return { externalRefs, externalNamespaces: namespaces };
}

// Counts-only edge histogram for diagnostics. This is
// deliberately derived from the finished index rather than maintained by
// dozens of resolution branches, so cap reconciliation and metadata
// attachment cannot leave the count drifting from the graph that will
// actually be queried. Metadata refs are object-deduped because the same
// ref can live in both the class- and method-level lookup maps.
function refreshIndexDiagnostics(index) {
  if (!index) return index;
  const histogram = {};
  const add = (via, count) => {
    if (!via) return;
    const n = typeof count === 'number' ? count : 1;
    histogram[via] = (histogram[via] || 0) + n;
  };
  const countSiteMap = (map) => {
    if (!(map instanceof Map)) return;
    for (const sites of map.values()) {
      for (const site of sites || []) add(site && site.via);
    }
  };

  countSiteMap(index.methodCallers);
  countSiteMap(index.externalCallers);

  if (index.throwers instanceof Map) {
    for (const sites of index.throwers.values()) add('throws', (sites || []).length);
  }

  const seenMetaRefs = new Set();
  const countMetaMap = (map) => {
    if (!(map instanceof Map)) return;
    for (const refs of map.values()) {
      for (const ref of refs || []) {
        if (ref && typeof ref === 'object') {
          if (seenMetaRefs.has(ref)) continue;
          seenMetaRefs.add(ref);
        }
        add('metadata');
      }
    }
  };
  countMetaMap(index.metaCallers);
  countMetaMap(index.metaMethodCallers);
  countMetaMap(index.externalMetaRefs);

  if (index.flowGraph instanceof Map) {
    let subflowEdges = 0;
    for (const graphNode of index.flowGraph.values()) {
      subflowEdges += Array.isArray(graphNode && graphNode.children) ? graphNode.children.length : 0;
    }
    if (subflowEdges) add('subflow', subflowEdges);
  }

  index.stats = index.stats || {};
  index.stats.viaHistogram = histogram;
  return index;
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

// v0.11/B1: paren-depth-aware replacement for the old
// TERNARY_LITERAL_RE. The regex's permissive `[\s\S]+?` condition-prefix
// plus optional trailing `\)?` let it match a ternary NESTED INSIDE an
// unrelated wrapping call expression -- e.g. Type.forName's single arg
// `someWrapper(x ? 'FooHandler' : 'BarHandler')` matched in full (the
// regex simply treats "someWrapper(x " as an arbitrarily long condition
// prefix and the call's own closing ')' as the ternary's "optional
// wrapping paren"), fabricating two false dynamic ctor edges even though
// Type.forName's REAL argument is `someWrapper(...)` -- an arbitrary,
// unknown-at-parse-time call result that must stay unresolved per the B1
// contract ("anything else ... stays unresolved-counted exactly as
// today"). This scanner only accepts a GENUINE top-level ternary: after
// stripping zero or more full-string-spanning wrapping paren pairs (a
// leading '(' whose matching ')' is the very last character -- Apex never
// requires these for a plain call argument, but a fixture/author may still
// include them), it locates the first '?' that sits at paren-depth 0
// relative to what's left. In the false-positive shape above, the '?'
// only ever appears at depth 1 (still inside someWrapper's own,
// non-wrapping '(' ), so no depth-0 '?' is ever found and the match
// correctly fails. Quote contents are skipped while scanning so a literal
// containing '(' / ')' / '?' / ':' can never perturb the depth count.
// Returns [lit1, lit2] (both branches decoded as this file's other quoted-
// literal matches are) or null when the text isn't a bare-literal ternary.
function matchTernaryStringLiterals(text) {
  function skipQuoted(s, i) {
    const q = s[i];
    let j = i + 1;
    while (j < s.length) {
      if (s[j] === '\\') { j += 2; continue; }
      if (s[j] === q) return j;
      j++;
    }
    return s.length - 1;
  }
  function stripFullWrap(s) {
    let cur = s;
    for (;;) {
      if (cur.length < 2 || cur[0] !== '(' || cur[cur.length - 1] !== ')') return cur;
      let depth = 0;
      let full = false;
      for (let i = 0; i < cur.length; i++) {
        const ch = cur[i];
        if (ch === '"' || ch === "'") { i = skipQuoted(cur, i); continue; }
        if (ch === '(') depth++;
        else if (ch === ')') {
          depth--;
          if (depth === 0) { full = i === cur.length - 1; break; }
        }
      }
      if (!full) return cur;
      cur = cur.slice(1, -1).trim();
    }
  }
  function findTopLevel(s, ch) {
    let depth = 0;
    for (let i = 0; i < s.length; i++) {
      const c = s[i];
      if (c === '"' || c === "'") { i = skipQuoted(s, i); continue; }
      if (c === '(') depth++;
      else if (c === ')') { depth--; if (depth < 0) return -1; }
      else if (c === ch && depth === 0) return i;
    }
    return -1;
  }
  function matchQuoted(s) {
    const t = s.trim();
    const m = t.match(/^"([^"]*)"$/) || t.match(/^'([^']*)'$/);
    return m ? m[1] : null;
  }
  const inner = stripFullWrap(String(text == null ? '' : text).trim());
  const qIdx = findTopLevel(inner, '?');
  if (qIdx <= 0) return null; // no top-level '?' (or an empty condition) -- not a ternary at all
  const after = inner.slice(qIdx + 1);
  const cIdx = findTopLevel(after, ':');
  if (cIdx === -1) return null;
  const lit1 = matchQuoted(after.slice(0, cIdx));
  const lit2 = matchQuoted(after.slice(cIdx + 1));
  if (lit1 == null || lit2 == null) return null;
  return [lit1, lit2];
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

const STATIC_METADATA_BOUND_ANNOTATIONS = new Set(['auraenabled', 'invocablemethod']);

function isStaticMetadataBoundMethod(methodFacts) {
  if (!methodFacts || !methodFacts.isStatic) return false;
  // Accept both parser MethodFacts (annotations) and the compact MethodMeta
  // shape stored on the semantic index (entries). These two annotations are
  // invoked through exact metadata identities: LWC Class.method imports or
  // Flow actions resolved to the class's sole invocable method.
  return (methodFacts.annotations || []).some((a) => STATIC_METADATA_BOUND_ANNOTATIONS.has(annBare(a))) ||
    (methodFacts.entries || []).some((e) =>
      String(e).startsWith('@AuraEnabled') || String(e).startsWith('@InvocableMethod')
    );
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

// v0.8/N1(b)/N3: same as lastSegmentLower, case-preserving. See
// dmlObjectHeadOriginal's own header note for why this exists.
function lastSegmentOriginal(raw) {
  const s = stripGenerics(raw);
  const segs = s.split('.');
  return segs[segs.length - 1];
}

const SIMPLE_IDENT_RE = /^[A-Za-z_]\w*$/;

// v0.7.1/R1: a PLAIN dotted identifier chain -- two or more bare
// identifiers joined by dots, no parens/brackets/generics anywhere (e.g.
// `zenq.Billing`, `Outer.Inner`, `someVar.field`). Deliberately narrower
// than "receiver text contains a dot": cast expressions, chained method
// calls, and subscripts all carry their own explicit shape and are resolved
// by their own dedicated rules (resolveComplexReceiver/resolveChainedReceiver),
// never by this guard.
const PLAIN_DOTTED_CHAIN_RE = /^[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)+$/;

// Secondary bonus: cast-expression and
// chained-new receivers get typed resolution via lightweight text patterns.
// Tolerant of parser.js's getText()-without-whitespace concatenation
// warning from the cheat sheet (`\s*`, not a required space).
function castOrNewChainType(receiverRaw) {
  const s = String(receiverRaw || '').trim();
  // Apex/Java requires an extra outer parenthesis layer to
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

// =========================================================================
// v0.7 A1/A2/B2: forward tracing + multi-package awareness
// =========================================================================
// buildSemanticIndex(factsList, opts) -- opts is NEW and entirely optional;
// omitting it (or passing {}) reproduces v0.6 behavior byte-for-byte (see
// the B5 "packageless-identity" guarantee threaded through every duplicate-
// resolution branch below). Recognized opts fields (both additive, both
// consumed ONLY by the B2 duplicate-bucket resolution path below -- nothing
// else in this file reads them):
//   - opts.packageOf(fsPath) -> label|null -- maps a FileFacts.path to its
//     owning sfdx package's display label, or null when the path isn't
//     covered by any known package directory. Supplied by extension.js's
//     sfdx-project.json scan (out of this file's scope); resolver.js never
//     parses sfdx-project.json itself and has no fs access.
//   - opts.defaultPackage: string|null -- the label of the ONE package
//     directory flagged `default: true` in sfdx-project.json, or null when
//     unknown/absent. B2's resolution order needs this explicitly (rule 2,
//     "candidate in the default package") -- packageOf() alone cannot
//     distinguish "the default package" from "a package that happens to use
//     its bare path segment as its label", so this is a SEPARATE opts field
//     by design, not inferred from packageOf's return shape.
// Both are ignored entirely unless opts.packageOf is an actual function --
// that single check gates ALL of B2's new behavior (bucket surfacing,
// stats.duplicateNames, via='ambiguous' edges): this
// mirrors ("package-bucket surfacing is opt-in, gated entirely on package
// metadata being discoverable, never on the mere existence of two files
// sharing a name").
function buildSemanticIndex(factsList, opts) {
  const packageOf = opts && typeof opts.packageOf === 'function' ? opts.packageOf : null;
  const defaultPackage = opts && opts.defaultPackage != null ? opts.defaultPackage : null;
  // v0.8/N3: opts.ownNamespace -- the workspace's OWN declared managed-
  // package namespace (sfdx-project.json's 'namespace' property; reading
  // that file is extension.js's concern, out of this module's scope, same
  // division of labor as opts.packageOf above). Absent/empty -> no
  // stripping anywhere (byte-identical to pre-v0.8 behavior), per N3's own
  // text. Normalized once, lowercased, for every comparison below.
  const ownNamespaceLower = opts && opts.ownNamespace ? lc(opts.ownNamespace) : null;

  const classes = new Map(); // lowerQualified -> ClassMeta (or a B2 synthetic dup-slot key -- see classBuckets)
  const methodCallers = new Map(); // 'lowerQualified#lowerMethod' -> CallSite[]
  const classCallers = new Map(); // lowerQualified -> CallSite[]
  // A1: forward-direction counterpart of methodCallers/classCallers --
  // 'lowerQualified#lowerMethodLabel' (the CALLING method's own identity,
  // same callerKey format makeCallSite already uses) -> ForwardEdge[].
  // Populated INLINE during the SAME pass-B resolution walk that populates
  // methodCallers (see recordForwardEdge, called from writeMethodEdge/
  // writeCtorEdge/handleThrowSite below) -- no second pass over factsList.
  const methodCallees = new Map();
  // A1/A6: per-callerKey count of call sites (from MethodFacts.calls only --
  // see the pass-B loop below) that produced ZERO forward edges anywhere --
  // the raw material for buildCalleeTree's single aggregated "N unresolved
  // sites" leaf per method (A2's unresolved-call spec).
  // v0.7.1/R6: a denylisted-receiver call site (System/Database/etc., incl.
  // the R2 declared-Type-typed variant) is EXCLUDED from this count, exactly
  // like the backward-direction unresolvedSitesCount already excludes it
  // (see resolveDotOther's own denylist-gate comment: "a deliberate, known
  // exclusion ... not counted as an H4 'dropped' site") -- see
  // lastReceiverDenylisted below, which the pass-B loop checks before
  // incrementing this map.
  const unresolvedForwardCounts = new Map();
  // v0.7.1/R8: per-callerKey count of DML statements/Database.xxx() calls
  // whose target reduced to the literal generic `SObject` placeholder (a
  // `List<SObject>`/`SObject` declared type that was never narrowed to a
  // concrete object) -- surfaced as an honest "DML on unresolved SObject
  // type" leaf instead of silently vanishing. Deliberately separate from
  // unresolvedForwardCounts: this is a
  // DML-target-narrowing gap, not an ordinary unresolved method call.
  const unresolvedDmlForwardCounts = new Map();
  // v0.7.1/R6: set true by resolveDotOther (and its R2 declared-Type variant)
  // for the SINGLE call currently being processed by the pass-B loop below,
  // whenever that call site's receiver was excluded via the platform
  // denylist. Reset to false before every resolveCall(...) dispatch in that
  // loop -- resolveCall/resolveDotOther never recurse into themselves for a
  // different call, so a plain closure-scoped flag (not a per-call Map) is
  // sufficient and avoids threading an extra out-param through every
  // resolution rule.
  let lastReceiverDenylisted = false;
  // B2: qualifiedLower -> [{ classLower, package, cm }] -- EVERY type
  // sharing that qualified name, across every file, package-tagged
  // (package is null when packageOf is inactive or the file isn't covered
  // by any known package directory). The FIRST entry pushed for a given
  // qualifiedLower is always the one also registered in `classes` under the
  // plain qualifiedLower key (identical to pre-v0.7 first-wins semantics);
  // every SUBSEQUENT same-name type gets its own synthetic disambiguated
  // key (see registerClassMeta below) registered ADDITIONALLY into
  // `classes` so every existing classLower-keyed lookup in this file
  // (resolveType's classes.has() checks, emitOwners/writeMethodEdge's
  // classes.get(), the extends-chain/interface-closure passes that iterate
  // classes.values(), etc.) keeps working completely unmodified against
  // EITHER kind of key, with zero special-casing anywhere except the one
  // new B2 resolution branch in resolveDotOther's rule 5 (below).
  const classBuckets = new Map();
  // classLower -> earliest {path, line} at which a `new
  // ClassName(...)` construction of that class was encountered anywhere in
  // pass B's sequential call-site walk. Populated by resolveCall's rule 1
  // ('new') below. Used ONLY by calleeInterfaceFanoutPairs (forward
  // interface fan-out ordering) to recover a deterministic, source-grounded
  // order for an interface's implementers when tracing the interface
  // method directly -- "the order these implementer types are typically
  // constructed together" (e.g. a dispatcher's own `List<Iface>{ new A(),
  // new B(), new C() }` literal) is a far more meaningful ordering than raw
  // file-scan order, and MANIFEST v0.7 chain #8 pins exactly this ordering.
  // An implementer with no known construction site anywhere falls back to
  // its original interfaceImplementers position (see the sort in
  // calleeInterfaceFanoutPairs).
  const firstConstructedAt = new Map();
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
  // (2) a chained receiver exceeding the documented CHAIN_MAX-segment walk
  // cap (v0.10/A1: 12, was 4 pre-v0.10), OR hitting a same-chain
  // (type,method) cycle before that (resolveChainedReceiver); (3)
  // Type.forName(...) called with a
  // non-string-literal (variable) argument, whose runtime value can never
  // be known statically (handleTypeForName). Surfaced on the returned index
  // as `stats.unresolvedSites` and threaded through to every TreeResult
  // (H4's "N call sites workspace-wide could not be resolved" header).
  let unresolvedSitesCount = 0;
  // v0.13/H3: reason breakdown for stats.unresolvedByReason (feeds the H8
  // Scan Stats channel/diagnostics command -- both out of this file's own
  // scope, but the counts themselves are only ever knowable HERE, at the
  // exact call site that decided a site stays unresolved). Every key is
  // pre-seeded at 0 so a consumer never has to guard a missing key.
  // 'parse-fallback' is set once, after pass E, directly from
  // parseFallbacks.length (a FILE-granularity figure, not a call-site one --
  // see its own assignment below) rather than incremented per-site like the
  // other four.
  const unresolvedByReason = {
    'unknown-receiver': 0,
    'deep-chain': 0,
    'non-literal-dynamic': 0,
    'parse-fallback': 0,
    'name-too-common': 0,
  };
  // v0.13/H3: nameLower -> Array<{reason, callerClass, callerKey, path,
  // line, col, lineText}> -- every unresolved call site this build can
  // attribute to a concrete called-method NAME (bookkept alongside
  // unresolvedSitesCount at the exact same call sites -- see
  // recordUnresolvedSite below). Powers the caller-direction trace header's
  // "K unresolved sites elsewhere mention <method>(" figure: K is simply
  // this map's entry for the traced method's own lowercased name, length
  // (arity-agnostic by construction -- a call site lands here regardless of
  // its own argTexts count). NOT every unresolvedSitesCount-contributing
  // category is represented here (resolveChainedReceiver's two deep-chain
  // sites don't have a called-method name in scope at their point of
  // failure -- see their own call sites, unchanged) -- deep-chain mentions
  // are therefore undercounted here by design, not a bug; deep-chain's own
  // tally lives in unresolvedByReason instead.
  const unresolvedSitesByName = new Map();
  // v0.13/H1: targetKey ('classLower#nameLower') -> running count of
  // unique-name attachments written so far for that target, incremented
  // once per successful unresolvedFallback() call (see its own header
  // note). The TRUE total for a target is only known once pass B has
  // walked every file, so finalizeUniqueNameCap (run once, right after
  // pass B) is what actually decides whether a target's attachments
  // survive or get stripped back to unresolved.
  const uniqueNameAttachCounts = new Map();
  let magnetSuppressedAttachments = 0;

  // v0.13/H3: shared by every unresolvedSitesCount-incrementing call site
  // that has NO concrete call-site/name to attribute (today: only
  // resolveChainedReceiver's two deep-chain outcomes) -- bumps the total
  // and the reason tally, nothing else.
  function bumpUnresolvedReason(reason) {
    unresolvedSitesCount++;
    unresolvedByReason[reason] = (unresolvedByReason[reason] || 0) + 1;
  }
  // v0.13/H3: shared by every unresolvedSitesCount-incrementing call site
  // that DOES have a concrete (callerClassLower, callerMethodLabel, call,
  // nameLower) tuple in scope -- bumps the total + reason tally (like
  // bumpUnresolvedReason) AND records the site under its called name in
  // unresolvedSitesByName, for the H3 scoped-header mention count.
  function recordUnresolvedSite(reason, nameLower, callerClassLower, callerMethodLabel, call) {
    unresolvedSitesCount++;
    unresolvedByReason[reason] = (unresolvedByReason[reason] || 0) + 1;
    if (!nameLower) return;
    const ccm = classes.get(callerClassLower);
    const entry = {
      reason,
      callerClass: ccm ? ccm.qualified : callerClassLower,
      callerKey: `${callerClassLower}#${lc(callerMethodLabel)}`,
      path: ccm ? ccm.path : '',
      line: call.line,
      col: call.col,
      lineText: call.lineText,
    };
    if (!unresolvedSitesByName.has(nameLower)) unresolvedSitesByName.set(nameLower, []);
    unresolvedSitesByName.get(nameLower).push(entry);
  }
  // v0.13/H4: opts.shouldCancel() -- an optional zero-arg predicate the host
  // (extension.js) can pass so a scan over a huge workspace can be aborted
  // cleanly instead of running to completion once the user has already
  // moved on. Checked at the TOP of every outer pass loop below (pass
  // A/B/C/D/E, all of which iterate every file or every class) -- never
  // mid-file, since MethodFacts/CallFacts processing for one file/class is
  // already fast and atomic; there is nothing finer-grained worth guarding.
  // `cancelled` latches true the first time the check fires and is checked
  // (not re-checked against shouldCancel()) by every LATER pass's own guard,
  // so one cancellation signal skips every remaining pass, not just the one
  // that first observed it.
  const shouldCancel = opts && typeof opts.shouldCancel === 'function' ? opts.shouldCancel : null;
  let cancelled = false;
  // Whether opts.packageOf resolved a real
  // (non-null) package label for at least one file, as opposed to merely
  // being a function that was PASSED (and might return null for every
  // path, exactly what extension.js's discoverPackageMap() produces for a
  // workspace with zero discoverable sfdx-project.json files -- see
  // extension.js's scanAndBuildIndex(), which always passes `{ packageOf }`
  // and never omits the key). Set true the first time pass A's pkgLabel
  // computation (below) yields non-null. This -- NOT merely `packageOf`
  // being a function -- is the real B2 gate: every "gated entirely on
  // opts.packageOf" check below (resolveDuplicateBucket's call site,
  // stats.duplicateNames counting) must use THIS flag, matching this file's
  // own header comment ("gated entirely on package metadata being
  // discoverable ... never on the mere existence of two files sharing a
  // name") and the B5 packageless-identity guarantee ("No sfdx-project.json
  // anywhere -> packageOf returns null for everything and ALL behavior must
  // be byte-identical to today").
  let packageMetadataDiscovered = false;

  // Cross-class lookup tables, built alongside `classes` in pass A.
  const simpleNameIndex = new Map(); // lc(simpleName) -> lowerQualified[]
  const methodNameIndex = new Map(); // lc(methodName) -> Set<lowerQualified> (non-ctor only)
  const interfaceImplementers = new Map(); // lc(interfaceSimpleName) -> lowerQualified[]

  // B2: builds one ClassMeta (identical shape/logic to the pre-v0.7 inline
  // block this replaces) for ONE type -- factored out so pass A can call it
  // for EVERY same-name type (not just the first-registered "winner"),
  // which duplicate-bucket resolution and pass B's own-body call-walking
  // both need a real ClassMeta for. Side-table registration (simpleNameIndex/
  // methodNameIndex/interfaceImplementers) is NOT done here -- callers do
  // that themselves, ONLY for the primary (first) registration of a given
  // qualifiedLower, so every pre-v0.7 lookup path stays first-wins-only and
  // therefore byte-identical whether or not opts.packageOf is active.
  function buildClassMeta(tf, file, isTriggerFile, isAnonymousFile, pkgLabel) {
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
    }

    return {
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
      // B2: package label for this type's OWN file, or null when
      // opts.packageOf is inactive or doesn't cover this path. Purely
      // informational except for the one new duplicate-bucket resolution
      // branch below -- every pre-v0.7 code path ignores this field.
      package: pkgLabel,
      methods,
      typeFacts: tf,
    };
  }

  // ---- pass A: register ClassMeta + MethodMeta for every parseable type --
  for (const file of factsList || []) {
    // v0.13/H4: checked once per file (this loop's own natural grain --
    // per-file work below is already atomic/fast, nothing finer-grained is
    // worth guarding) -- see `cancelled`'s own header note for why every
    // LATER pass also bails via this same flag once it's latched true.
    if (shouldCancel && shouldCancel()) { cancelled = true; break; }
    if (file.parseError) continue; // handled in the lexical fallback pass below
    const isTriggerFile = file.kind === 'trigger';
    const isAnonymousFile = file.kind === 'anonymous';
    const pkgLabel = packageOf ? packageOf(file.path) || null : null;
    if (pkgLabel != null) packageMetadataDiscovered = true;
    for (const tf of file.types || []) {
      const qualifiedLower = lc(tf.qualified);
      const isDuplicateSlot = classes.has(qualifiedLower);
      const cm = buildClassMeta(tf, file, isTriggerFile, isAnonymousFile, pkgLabel);

      // B2: registration key. The FIRST type registered under a given
      // qualifiedLower always keeps that plain key (identical to pre-v0.7
      // first-wins semantics -- resolveType's classes.has(norm) exact-match
      // check, and every other classLower-keyed lookup in this file, keeps
      // resolving to exactly this ClassMeta exactly as before). Every
      // SUBSEQUENT same-name type gets an additional, synthetic key so it
      // still has a real, queryable identity of its own (pass B walks its
      // calls under this key; buildCallerTree/buildCalleeTree can target it
      // directly via index.classBuckets) -- but that key is never returned
      // by resolveType's plain-name lookups, so ordinary (non-duplicate-
      // aware) resolution never accidentally lands on it.
      let key = qualifiedLower;
      if (isDuplicateSlot) {
        duplicates.push(tf.qualified);
        const bucketLenSoFar = (classBuckets.get(qualifiedLower) || []).length;
        key = `${qualifiedLower}~dup${bucketLenSoFar}~${lc(pkgLabel || file.path)}`;
      }
      cm.classLower = key; // B2: this ClassMeta's OWN registration key -- see directSubclasses/ifaceParents below, which must self-reference by THIS (not always lc(cm.qualified), which only matches for non-duplicate primaries) so a duplicate-slot type's extends/interface identity is never misattributed to a same-named sibling.
      classes.set(key, cm);

      if (!classBuckets.has(qualifiedLower)) classBuckets.set(qualifiedLower, []);
      classBuckets.get(qualifiedLower).push({ classLower: key, package: pkgLabel, cm });

      if (isDuplicateSlot) continue; // side tables below stay first-wins-only (see buildClassMeta's header note)

      for (const mf of tf.methods || []) {
        if (mf.isCtor) continue;
        const nameLower = lc(mf.name);
        if (!methodNameIndex.has(nameLower)) methodNameIndex.set(nameLower, new Set());
        methodNameIndex.get(nameLower).add(qualifiedLower);
      }

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

  // v0.7.1/R1 re-hunt: same first two tiers as resolveType (calling scope's
  // own enclosing-class chain, then an exact dotted-qualified match) but
  // DELIBERATELY OMITS resolveType's third tier -- the globally-unique
  // bare-simple-name fallback. That fallback is exactly the mechanism the
  // namespace false-edge bug exploits (a dotted chain whose TAIL happens to
  // collide with an unrelated class's simple name, regardless of whether
  // the chain's own HEAD/middle segments actually lead there). A caller
  // that needs to know whether a dotted chain resolves as a REAL qualified
  // path -- not merely "some class somewhere shares its bare tail name" --
  // must use this instead of resolveType. Used exclusively by
  // isUnknownNamespacedReceiver below.
  function resolveTypeStrict(rawTypeName, currentQualifiedOriginalCase) {
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
    return null;
  }

  // =========================================================================
  // B2: duplicate-name bucket resolution
  // =========================================================================
  // Only ever consulted from resolveDotOther's rule 5 (below) -- the ONE
  // resolution path for a literal
  // `ClassName.method()` static reference, the exact shape a qualified-name
  // collision is about). `primaryQualifiedLower` is whatever resolveType()
  // already returned (unchanged, first-wins) for the receiver text; this
  // function ONLY runs a bucket lookup keyed on that same qualifiedLower --
  // it never changes WHICH name resolveType found, only WHICH of that
  // name's same-named candidates should get the edge. Returns
  // { winners: classLower[], via: 'static'|'ambiguous' } -- 'winners' is
  // always non-empty when called with a resolveType() hit. Resolution order
  // is:
  //   1. a candidate in the SAME package as the referring file
  //   2. else a candidate in the DEFAULT package
  //   3. else EVERY remaining candidate, via='ambiguous' (approximate)
  function resolveDuplicateBucket(primaryQualifiedLower, callerPackage) {
    const bucket = classBuckets.get(primaryQualifiedLower);
    if (!bucket || bucket.length <= 1) return { winners: [primaryQualifiedLower], via: 'static' };
    if (callerPackage != null) {
      const samePkg = bucket.filter((b) => b.package === callerPackage);
      if (samePkg.length === 1) return { winners: [samePkg[0].classLower], via: 'static' };
    }
    if (defaultPackage != null) {
      const defPkg = bucket.filter((b) => b.package === defaultPackage);
      if (defPkg.length === 1) return { winners: [defPkg[0].classLower], via: 'static' };
    }
    return { winners: bucket.map((b) => b.classLower), via: 'ambiguous' };
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
    // B2 fix: self-reference by subCm's OWN registration key (subCm.classLower),
    // not lc(subCm.qualified) -- identical for every non-duplicate class (the
    // pre-v0.7/only case that existed before B2), but a duplicate-slot type's
    // qualified name is shared with a same-named sibling, so lc(qualified)
    // alone could misattribute a duplicate's subclass edge onto the wrong
    // classLower entry.
    directSubclasses.get(parentLower).push(subCm.classLower || lc(subCm.qualified));
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
    if (parentLowers.length) ifaceParents.set(cmI.classLower || lc(cmI.qualified), parentLowers);
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
        const implLower = cmI.classLower || lc(cmI.qualified);
        if (!list.includes(implLower)) list.push(implLower);
      }
    }
  }

  // v0.8/N3: strips a leading OWN-namespace 'ns__' prefix from an
  // original-case object/token (e.g. trigger target object text, DML target
  // text) before it becomes this engine's canonical (lowercased) object
  // identity -- so `vtx__Config__c` and bare `Config__c` collapse onto the
  // exact same local object identity, per N3's own text. No-op (returns the
  // input unchanged) when opts.ownNamespace is absent/empty, or the token
  // doesn't have the 'ns__' shape at all, or its ns segment isn't the OWN
  // namespace (a genuinely managed 'ns__Object__c' token is left fully
  // intact here -- N1(b)'s external-object detection, downstream in
  // resolveDmlTargetObject, needs the UNSTRIPPED form to build its label).
  function stripOwnNamespaceFromObject(originalCaseToken) {
    if (!ownNamespaceLower) return originalCaseToken;
    const split = splitNamespacePrefix(originalCaseToken);
    if (split && lc(split.ns) === ownNamespaceLower) return split.rest;
    return originalCaseToken;
  }

  // F1: object (lowercased SObject API name) -> trigger ClassMeta[] declared
  // on it, built the same way -- every trigger's triggerInfo is already
  // attached to its ClassMeta by pass A above.
  const triggersByObject = new Map();
  for (const trigCm of classes.values()) {
    if (trigCm.kind !== 'trigger' || !trigCm.triggerInfo || !trigCm.triggerInfo.object) continue;
    // v0.8/N3: a trigger declared directly `on vtx__Foo__c` registers under
    // the SAME stripped key ('foo__c') a DML on bare `Foo__c` resolves to --
    // symmetric with resolveDmlTargetObject's own N3 stripping below, so
    // event-matching stays keyed on one canonical local object identity
    // regardless of which (prefixed or bare) spelling either side used.
    const objLower = lc(stripOwnNamespaceFromObject(trigCm.triggerInfo.object));
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

  // =========================================================================
  // v0.8/N1/N2/N4: externals -- Map<'nslower.classlower', ExternalMeta>
  // ExternalMeta = { ns, className, label, methods: Set<methodLower>, refCount }
  // Built from THREE sources, all funneling through getOrCreateExternal
  // below: (a) N2 step 3 -- a 3-segment Apex call expression (Head.Mid.
  // method(...)) whose Head never resolves locally (tryAttachExternalTwoSegmentReceiver,
  // called from resolveDotOther); (b) N1(b) -- a DML/publish target whose
  // object text matches the managed-object shape 'ns__Object__c'
  // (attachExternalDmlSite, called from resolveDmlTargetObject's 3 call
  // sites); (c) N1(c) -- a metascan MetaRef carrying (or shown, via this
  // module's own fold-detection, to imply) a namespace (attachMetaCallers,
  // a separate top-level function -- see its own header note for why it
  // reads/writes `externals`/`externalCallers` off the INDEX object rather
  // than this closure). Key format is ALWAYS dot-joined + lowercased
  // regardless of source ('zenq.billing', 'kwx.ledger__c') -- only the
  // human-readable `label` differs by convention: dot-style ('zenq.Billing')
  // for a namespaced Apex/metadata CLASS reference, underscore-style
  // ('kwx__Ledger__c') for a namespaced DML/publish OBJECT reference --
  // see getOrCreateExternal's own `style` parameter.
  // =========================================================================
  const externals = new Map();
  // externalCallers: same key as `externals` -> CallSite[] of every LOCAL
  // Apex/DML site that references it -- N4's "in the callers direction an
  // external IS a valid trace target ... its callers are all local
  // referencing sites" (buildExternalCallerTree, below, walks these exactly
  // like methodCallers/classCallers feed an ordinary caller tree's level 1).
  const externalCallers = new Map();
  // externalForwardsByCallerKey: 'lowerQualified#lowerMethodLabel' (the
  // SAME callerKey format methodCallees/dmlByCallerKey use) -> [{ key, ext,
  // path, line, col, lineText, args }] -- the forward-direction (callees)
  // counterpart of externalCallers, consumed by appendCalleeExtrasForMethod
  // below to append one TERMINAL kind:'external' leaf per distinct external
  // referenced FROM that specific caller method (N4: "external nodes are
  // TERMINAL in the callee direction"). Deliberately a separate, simpler
  // per-callerKey list rather than routed through methodCallees/ForwardEdge
  // -- an external target is never a real `classLower#methodLower` key, and
  // appendCalleeExtras's existing "extra terminal leaves per node" pattern
  // (already used for DML/publish flow-fanout and the unresolved-call
  // aggregate) is the natural, low-risk fit, requiring no changes to the
  // ordinary forward-edge walk (calleeItemFromEdge/buildOneChildNode).
  const externalForwardsByCallerKey = new Map();

  // v0.8/N1/N4: creates (first-observation-wins label/case) or looks up the
  // ExternalMeta for (nsRaw, classNameRaw), returning its Map key. `style`
  // picks the label CONVENTION only, at first-creation time -- 'dot' for
  // 'ns.Class' (a namespaced Apex/metadata CLASS/method reference), 'underscore'
  // for 'ns__Object' (a namespaced DML/publish OBJECT reference) -- see this
  // block's own header note above.
  function getOrCreateExternal(nsRaw, classNameRaw, style) {
    const key = `${lc(nsRaw)}.${lc(classNameRaw)}`;
    if (!externals.has(key)) {
      const label = style === 'underscore' ? `${nsRaw}__${classNameRaw}` : `${nsRaw}.${classNameRaw}`;
      externals.set(key, { ns: nsRaw, className: classNameRaw, label, methods: new Set(), refCount: 0 });
    }
    return key;
  }

  // v0.8/N1(a)/N2: records ONE Apex call-expression site against the
  // external (ns, className) pair -- via='external', NOT approximate (per
  // N2's own text: "a genuine namespace match is exact, not a guess"), fed
  // to BOTH externalCallers (reverse/caller-direction trace) and
  // externalForwardsByCallerKey (forward/callee-direction terminal leaf).
  // v0.11/B1(d): `via` defaults to 'external' (every pre-existing caller
  // omits it, so this is byte-identical for every genuine ns.Class(...)
  // Apex call site) -- the ONE other caller, B1's literal-flow namespaced-
  // external case (tryAttachExternalLiteral, below), passes 'dynamic'
  // instead: the reference is real (the class genuinely lives in that
  // managed package), but WHICH literal reaches this call site is an
  // inference over the same three strictly-verifiable dataflow shapes B1's
  // local-class branch already uses, not a syntactic certainty -- so it
  // keeps the 'dynamic'/approximate:true vocabulary the rest of B1 uses,
  // rather than N2's "genuine namespace match is exact, not a guess"
  // via='external' reasoning (that reasoning is about the SYNTACTIC shape
  // of a call expression, which literal-flow never has).
  function attachExternalApexSite(nsRaw, classNameRaw, methodLower, callerClassLower, callerMethodLabel, call, via) {
    const viaFinal = via || 'external';
    const key = getOrCreateExternal(nsRaw, classNameRaw, 'dot');
    const ext = externals.get(key);
    if (methodLower) ext.methods.add(methodLower);
    ext.refCount++;
    const site = makeCallSite(callerClassLower, callerMethodLabel, call, viaFinal, methodLower, null);
    if (!externalCallers.has(key)) externalCallers.set(key, []);
    externalCallers.get(key).push(site);
    const ccm = classes.get(callerClassLower);
    const callerKey = `${callerClassLower}#${lc(callerMethodLabel)}`;
    if (!externalForwardsByCallerKey.has(callerKey)) externalForwardsByCallerKey.set(callerKey, []);
    externalForwardsByCallerKey.get(callerKey).push({
      key, ext, via: viaFinal, path: ccm ? ccm.path : '', line: call.line, col: call.col, lineText: call.lineText, args: call.argTexts || [],
    });
  }

  // v0.8/N2 step 2 (extended): true when `midRaw` resolves as EITHER a
  // nested/inner class OR a static field/property MEMBER of the GENUINE
  // local top-level class named `headRaw` -- N2's own text lists "inner
  // class, static member chain" as two forms of "Mid resolves on it", both
  // of which must keep step 2's existing-rules outcome (never external),
  // even when the pre-existing chained-receiver machinery doesn't itself go
  // on to produce a resolved edge for the full chain. A genuinely LOCAL
  // (if, today, still unresolved) reference must never be RECLASSIFIED as
  // managed-package code merely because Head also happens to be
  // identifier-shaped, including fflib-style factory chains such as
  // `Application.Service.newInstance(...)` (a
  // static FIELD access chain, which must remain unresolved rather than be
  // incorrectly promoted to external).
  function headClassHasMember(headRaw, midRaw) {
    const headLower = lc(headRaw);
    if (!classes.has(headLower)) return false;
    const midLower = lc(midRaw);
    if (classes.has(`${headLower}.${midLower}`)) return true; // inner/nested class
    const found = walkExtendsChain(classesLike, headLower, (cm) => {
      const tf = cm.typeFacts;
      if ((tf.fields || []).some((f) => lc(f.name) === midLower)) return true;
      if ((tf.properties || []).some((p) => lc(p.name) === midLower)) return true;
      return undefined;
    });
    return found === true;
  }

  // v0.8/N2 step 3: only when receiverRaw is EXACTLY a 2-segment 'Head.Mid'
  // dotted chain (the "3-segment call expression" N2 describes, receiver +
  // method) does an unresolved namespace-shaped receiver become an external
  // -- a longer chain, or a bare 1-segment receiver (N2's own "2-segment
  // call NEVER creates an external" carve-out -- that shape never even
  // reaches this function; see resolveDotOther's isSimple branch), is left
  // exactly as before (an honest unresolved site). `head` must itself be a
  // plausible namespace token (a plain identifier, not a PLATFORM_DENYLIST
  // name), and Mid must NOT resolve as any kind of member (class or static
  // field/property) of a genuine local Head class (headClassHasMember,
  // above) -- called ONLY once isUnknownNamespacedReceiver has already
  // confirmed this receiver never resolves locally via its own (class-only)
  // strict-match check (rule-1/rule-2 of N2's precedence, both already
  // handled upstream of this call).
  function tryAttachExternalTwoSegmentReceiver(receiverRaw, methodLower, call, callerClassLower, callerMethodLabel) {
    const raw = String(receiverRaw || '').trim();
    const dotIdx = raw.indexOf('.');
    if (dotIdx <= 0) return false;
    const rest = raw.slice(dotIdx + 1);
    if (rest.indexOf('.') !== -1) return false; // 3+ dots in the receiver -- out of N2's scoped shape, leave as unresolved
    const head = raw.slice(0, dotIdx);
    if (!SIMPLE_IDENT_RE.test(head) || !SIMPLE_IDENT_RE.test(rest)) return false;
    if (PLATFORM_DENYLIST.has(lc(head))) return false;
    if (headClassHasMember(head, rest)) return false;
    attachExternalApexSite(head, rest, methodLower, callerClassLower, callerMethodLabel, call);
    return true;
  }

  // v0.8/N1(b): records ONE DML/publish site against a managed-object
  // external (ns, className) pair -- see resolveDmlTargetObject's own N1(b)
  // note for how `nsRaw`/`classNameRaw` get derived. No forward-direction
  // (`externalForwardsByCallerKey`) DML-specific method concept to zip args
  // against, so `methods` is deliberately never populated here (stays the
  // empty Set N1's own shape allows: "Set<methodLower observed>").
  function attachExternalDmlSite(nsRaw, classNameRaw, callerClassLower, callerMethodLabel, callLike) {
    const key = getOrCreateExternal(nsRaw, classNameRaw, 'underscore');
    const ext = externals.get(key);
    ext.refCount++;
    const ccm = classes.get(callerClassLower);
    if (!ccm) return;
    const site = {
      callerClass: ccm.qualified,
      callerMethod: callerMethodLabel,
      callerKey: `${callerClassLower}#${lc(callerMethodLabel)}`,
      path: ccm.path,
      line: callLike.line,
      col: callLike.col,
      lineText: callLike.lineText,
      args: callLike.argTexts || [],
      via: 'external',
      targetMethod: null,
      overloadSig: null,
      overloadPick: 'exact',
    };
    if (!externalCallers.has(key)) externalCallers.set(key, []);
    externalCallers.get(key).push(site);
    const callerKey = `${callerClassLower}#${lc(callerMethodLabel)}`;
    if (!externalForwardsByCallerKey.has(callerKey)) externalForwardsByCallerKey.set(callerKey, []);
    externalForwardsByCallerKey.get(callerKey).push({
      key, ext, via: 'external', path: ccm.path, line: callLike.line, col: callLike.col, lineText: callLike.lineText, args: callLike.argTexts || [],
    });
  }

  // Continue climbing the inheritance chain when the nearest class does not
  // extends chain at the FIRST class declaring ANY same-named method,
  // regardless of arity -- so a subclass overload with a *different* arity
  // than the call site would steal the edge even when an ancestor's
  // overload is the one that actually matches (real Apex overload
  // resolution falls through to the inherited signature that fits). This
  // collects EVERY same-named method visible along the walk (own class
  // first, then ancestors when walkSuper) -- Apex doesn't hide inherited
  // overloads the way it hides overridden same-signature methods -- and
  // then narrows by call-site arity
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
  // uses "exact > assignable-unknown >
  // wildcard" tiers with the subtype tier slotted in between exact and
  // unknown). On a score tie, the FIRST candidate in `all`'s original order
  // wins -- i.e. falls back to the pre-A4 "closest-declaring-class wins"
  // behavior; on a tie it keeps the current arity behavior
  // instruction.
  function pickBestOverload(candidates, call, callerClassLower, methodFacts) {
    if (!call || candidates.length < 2) return Object.assign({}, candidates[0], { overloadPick: 'exact' });
    const argTexts = call.argTexts || [];
    const argInfos = argTexts.map((a) => inferArgHead(a, callerClassLower, methodFacts));
    let best = candidates[0];
    let bestScore = -Infinity;
    let bestSignatures = new Set();
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
        bestSignatures = new Set([impactMethodSignature(cand.method)]);
      } else if (score === bestScore) {
        bestSignatures.add(impactMethodSignature(cand.method));
      }
    }
    const tiedOverloadSigs = Array.from(bestSignatures);
    return Object.assign({}, best, {
      overloadPick: tiedOverloadSigs.length > 1 ? 'arity-tie' : 'exact',
      // The ordinary graph still keeps ONE deterministic chosen edge, but
      // Impact Analysis must know every equally-best signature this physical
      // call might bind to. Optional and tie-only so exact CallSite shapes
      // remain untouched.
      tiedOverloadSigs: tiedOverloadSigs.length > 1 ? tiedOverloadSigs : undefined,
    });
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
        return [Object.assign({}, exact[0], { overloadPick: 'exact' })]; // closest-declaring-class wins among exact-arity matches
      }
      return all.map((o) => Object.assign({}, o, { overloadPick: 'fallback' })); // no arity match anywhere in the chain -> fan out to every overload (approximate)
    }
    return [Object.assign({}, all[0], { overloadPick: 'fallback' })];
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
  //
  // A1 `forwardOpt` (default true, per writeMethodEdge's own default):
  // pass false from a FAN-OUT context (multiple approximate owners standing
  // in for ONE call site's uncertain runtime target -- H2's interface-
  // implementer loop in emitTypedOrInterfaceForClass) so that fan-out
  // doesn't ALSO explode the calling method's own forward-edge list into
  // one entry per possible implementer. The reverse direction is
  // unaffected either way (methodCallers always gets every owner's edge,
  // forwardOpt only gates the ADDITIONAL methodCallees write) -- see A2's
  // intended behavior: a call through an interface-typed receiver
  // forward-resolves to the INTERFACE method's own node as its one and only
  // forward child; the concrete implementers only appear one hop further,
  // as that interface method's OWN forward children (a node-level special
  // case in buildCalleeTree, not a per-call-site fan-out -- see
  // calleeInterfaceFanoutPairs below).
  function emitOwners(callerClassLower, callerMethodLabel, classLower, nameLower, call, via, walkSuper, callArity, methodFacts, forwardOpt) {
    const owners = findMethodOwners(classLower, nameLower, walkSuper, callArity, call, callerClassLower, methodFacts);
    for (const o of owners) {
      const overloadSig = computeOverloadSig(o, nameLower);
      writeMethodEdge(callerClassLower, callerMethodLabel, o.classLower, nameLower, call, via, o.method.name, overloadSig, forwardOpt, undefined, o.overloadPick, o.tiedOverloadSigs);
    }
    return owners.length > 0;
  }

  // v0.7.1/R4: identical to emitOwners, but ALSO fans out (approximate,
  // via='override') to every subclass override of each resolved owner --
  // mirrors F3's typed-dispatch override fan-out (emitTypedOrInterfaceForClass),
  // gated the same way (only once the primary self-dispatch resolution
  // actually found a declaring class to fan out FROM, one call per distinct
  // owner classLower). Used ONLY by resolveCall's two bare/`this`-qualified
  // self-dispatch rules (rule 3 and rule 4's `this` branch) -- a base
  // class's own self-call to its own virtual/abstract hook method (the
  // fflib/trigger-handler template-method idiom: `run() { beforeInsert();
  // ... }`, overridden by a concrete subclass) previously never reached the
  // subclass override at all, because F3's override fan-out was only wired
  // into rule 6's TYPED dispatch path -- a real, reachable override method
  // was reported as having "no callers found". Deliberately scoped to
  // exactly these two self-dispatch call shapes
  // (not a general emitOwners change) so this never fires for an ordinary
  // typed/static/interface call, which already gets its own override
  // fan-out via a different path.
  function emitOwnersWithSelfOverrideFanout(callerClassLower, callerMethodLabel, classLower, nameLower, call, via, walkSuper, callArity, methodFacts) {
    const owners = findMethodOwners(classLower, nameLower, walkSuper, callArity, call, callerClassLower, methodFacts);
    const fannedOutFrom = new Set();
    for (const o of owners) {
      const overloadSig = computeOverloadSig(o, nameLower);
      writeMethodEdge(callerClassLower, callerMethodLabel, o.classLower, nameLower, call, via, o.method.name, overloadSig, undefined, undefined, o.overloadPick, o.tiedOverloadSigs);
      if (!fannedOutFrom.has(o.classLower)) {
        fannedOutFrom.add(o.classLower);
        emitOverrideFanout(callerClassLower, callerMethodLabel, o.classLower, nameLower, call, callArity, methodFacts, 'override');
      }
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

  // v0.11/B1+B2: shared "does this exact name have a LOCAL declaration in
  // this method" lookup -- last-match-wins (a re-declaration in a later
  // block shadows an earlier same-named local), same convention
  // findReceiverType already uses for its own inline locals scan. Used by
  // both B1 (single-assignment literal locals) and B2 (generic-DML target
  // must be a LOCAL, never a param/field) -- neither may fall through to a
  // param or field the way ordinary TYPE ENV lookups do, so this is
  // deliberately narrower than findReceiverType.
  function findLocalFact(methodFacts, name) {
    const rl = lc(name);
    return (methodFacts && methodFacts.locals || []).slice().reverse().find((l) => lc(l.name) === rl) || null;
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

  function makeCallSite(callerClassLower, callerMethodLabel, call, via, targetMethodName, overloadSig, approximateOverride, overloadPick, tiedOverloadSigs) {
    const ccm = classes.get(callerClassLower);
    const site = {
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
      // v0.14 Impact Analysis: exposes HOW overload resolution selected
      // this edge. Exact includes the sole matching-arity overload or a
      // unique best type-score; arity-tie is the existing first-candidate
      // tie-break; fallback is the existing no-matching-arity fan-out.
      overloadPick: overloadPick === 'arity-tie' || overloadPick === 'fallback' ? overloadPick : 'exact',
      // v0.11/B2: per-EDGE approximate override, independent of `via` --
      // ONLY ever true for a narrowed-generic-DML edge (still via='dml', so
      // the honest "the trigger genuinely fires" via vocabulary stays
      // intact, but the underlying object identity is itself an inference,
      // not a certainty, so the badge must say so). Every pre-existing
      // caller omits this argument -- `approximate` is therefore false on
      // existing sites remain unchanged (shapeSites/shapeCalleeSites never
      // copy it into the
      // rendered SiteView, so its mere presence here is invisible to every
      // existing consumer of that output shape).
      approximate: !!approximateOverride,
    };
    if (overloadPick === 'arity-tie' && Array.isArray(tiedOverloadSigs) && tiedOverloadSigs.length > 1) {
      site.tiedOverloadSigs = tiedOverloadSigs.slice();
    }
    return site;
  }

  // A1: 'name(TypeHead, ...)'-overload-aware param-name zip, the SAME
  // param-vs-arg zipping logic shapeSites() uses at buildCallerTree render
  // time (see its own comment for the full rationale) -- reimplemented here
  // in miniature because forward edges compute argsRendered eagerly, at
  // RECORD time inside this closure (ForwardEdge is a stored, not a
  // derived-at-render-time shape), against the
  // LOCAL `classes` Map (identical Map reference `index.classes` will be
  // once this build returns). Falls back to a plain joined-args string
  // whenever the target isn't a known method (dml/publish/async/unresolved
  // targets, or a target whose arity doesn't exactly match).
  function renderArgsForTarget(targetClassLower, targetMethodLower, overloadSig, args) {
    const joined = (args || []).length === 0 ? '' : args.join(', ');
    const tcm = classes.get(targetClassLower);
    if (!tcm || !targetMethodLower) return joined;
    let paramSets;
    if (targetMethodLower === '<init>') {
      paramSets = (tcm.typeFacts.methods || []).filter((m) => m.isCtor).map((m) => m.params || []);
    } else {
      const candidates = tcm.methods.filter((m) => lc(m.name) === targetMethodLower);
      if (overloadSig && candidates.length > 1) {
        const match = candidates.find((m) => `${m.name}(${(m.params || []).map((p) => p.type || 'Object').join(', ')})` === overloadSig);
        paramSets = match ? [match.params || []] : candidates.map((m) => m.params || []);
      } else {
        paramSets = candidates.map((m) => m.params || []);
      }
    }
    const exact = paramSets.find((p) => p.length === (args || []).length);
    if (!exact) return joined;
    return exact.map((p, i) => `${p.name}: ${args[i]}`).join(', ');
  }

  // A1: pushes one ForwardEdge onto methodCallees[callerKey]. `targetKey` is
  // either 'classLower#methodLower' (an ordinary method/trigger node) or a
  // BARE 'classLower' (a class-level node -- used ONLY for G2/A3's
  // exception-class terminal target, which has no method identity of its
  // own) or null (a resolved-but-not-method target, e.g. a trigger fired by
  // DML -- not used by this function directly; see the DML/publish
  // tree-time handling in buildCalleeTree instead). `targetLabel` is the
  // display text buildCalleeTree falls back to when targetKey doesn't
  // resolve to a live node at tree-build time (defensive only -- every
  // caller here passes a targetKey that resolves at record time).
  function recordForwardEdge(callerClassLower, callerMethodLabel, edge) {
    const callerKey = `${callerClassLower}#${lc(callerMethodLabel)}`;
    if (!methodCallees.has(callerKey)) methodCallees.set(callerKey, []);
    methodCallees.get(callerKey).push(edge);
  }

  // A1: via -> ForwardEdge.kind inference. 'dml'/'publish'/'async' vias are
  // written exclusively by emitDmlTriggerEdges/handleEventBusPublish/
  // handleAsyncHop (all of which route through writeMethodEdge, see below),
  // so this single switch is the one place kind ever needs deciding for a
  // methodCallers-shaped edge; 'throws' edges are recorded separately, by
  // handleThrowSite directly (they never go through writeMethodEdge at all
  // -- see its own header note).
  function forwardKindForVia(via) {
    if (via === 'dml') return 'dml';
    if (via === 'publish') return 'publish';
    if (via === 'async') return 'async';
    return 'call';
  }

  function writeMethodEdge(callerClassLower, callerMethodLabel, targetClassLower, nameLower, call, via, targetMethodName, overloadSig, forward, approximateOverride, overloadPick, tiedOverloadSigs) {
    const key = `${targetClassLower}#${nameLower}`;
    if (!methodCallers.has(key)) methodCallers.set(key, []);
    methodCallers.get(key).push(makeCallSite(callerClassLower, callerMethodLabel, call, via, targetMethodName, overloadSig, approximateOverride, overloadPick, tiedOverloadSigs));
    // A1: forward defaults to true -- every ordinary resolution rule (1-7,
    // incl. DML-trigger/publish-trigger/async edges, which all fund through
    // this same function) records itself as a forward edge too, UNLESS the
    // caller explicitly opts out (fan-out contexts -- see emitOwners' own
    // header note).
    if (forward !== false) {
      const args = call.argTexts || [];
      recordForwardEdge(callerClassLower, callerMethodLabel, {
        targetKey: key,
        kind: forwardKindForVia(via),
        via,
        approximate: !!approximateOverride, // v0.11/B2: see makeCallSite's own note -- mirrored here for the callee-direction ForwardEdge shape
        line: call.line,
        col: call.col,
        lineText: call.lineText,
        args,
        argsRendered: renderArgsForTarget(targetClassLower, nameLower, overloadSig, args),
        overloadSig: overloadSig || null,
        overloadPick: overloadPick === 'arity-tie' || overloadPick === 'fallback' ? overloadPick : 'exact',
        targetLabel: targetMethodName || nameLower,
      });
    }
  }

  // Rule 1 ('new') and rule 2 (this()/super() ctor chaining) both target a
  // class's constructor. Both write to methodCallers[target#<init>]; rule 1
  // additionally rolls up to classCallers per its literal text, and rule 2
  // is ALSO routed to classCallers here as a deliberate extension (decision
  // in header: "classCallers rollup scope") so class-level tracing doesn't
  // silently drop constructor-chaining callers.
  function writeCtorEdge(callerClassLower, callerMethodLabel, targetClassLower, call, via, forward) {
    const site = makeCallSite(callerClassLower, callerMethodLabel, call, via, '<init>', null, false, 'exact');
    const key = `${targetClassLower}#<init>`;
    if (!methodCallers.has(key)) methodCallers.set(key, []);
    methodCallers.get(key).push(site);
    if (!classCallers.has(targetClassLower)) classCallers.set(targetClassLower, []);
    classCallers.get(targetClassLower).push(site);
    // A1/A3/G5: forward defaults to true (a ctor edge is normally a single,
    // definite target -- never a fan-out) -- rule 1's 'new' branch passes
    // false when this exact 'new' expression's line is ALSO a throw site or
    // a qualifying async-hop call (see isNewSuppressedFromForward).
    if (forward !== false) {
      const args = call.argTexts || [];
      recordForwardEdge(callerClassLower, callerMethodLabel, {
        targetKey: key,
        kind: 'call',
        via,
        line: call.line,
        col: call.col,
        lineText: call.lineText,
        args,
        argsRendered: renderArgsForTarget(targetClassLower, '<init>', null, args),
        overloadSig: null,
        overloadPick: 'exact',
        targetLabel: '<init>',
      });
    }
  }

  // A1/A2/A3/G5: see writeCtorEdge's call site (resolveCall's 'new' branch)
  // for the full rationale -- reverse direction gets this SAME collapse for
  // free (buildChildrenLevel groups by CALLER identity, so the 'new' edge
  // and the throw/async edge for the same call site land on the SAME
  // node); forward direction groups by TARGET identity instead (a
  // structurally different key: '<init>' vs the exception class / the
  // job's 'execute()'), so it needs this explicit line-based correlation
  // to reach the same "one source line, one forward child" outcome.
  function isNewSuppressedFromForward(mf, callLine) {
    if (!mf) return false;
    if ((mf.throwsSites || []).some((t) => t.line === callLine)) return true;
    for (const c of mf.calls || []) {
      if (c.kind !== 'dot' || c.line !== callLine) continue;
      const receiverLower = lc(c.receiver);
      const methodLower = lc(c.method);
      if (
        (receiverLower === 'system' && methodLower === 'enqueuejob') ||
        (receiverLower === 'database' && methodLower === 'executebatch') ||
        (receiverLower === 'system' && methodLower === 'schedule')
      ) {
        return true;
      }
    }
    return false;
  }

  // H4: returns whether an edge was written, so resolveDotOther's H4
  // unresolved-site bookkeeping (below) can tell "genuinely could not
  // resolve this receiver" apart from "resolved via the unique-name
  // fallback".
  //
  // v0.13/H1(a) ARITY GATE: unlike every OTHER dispatch rule's use of
  // findMethodOwners (which, on an arity mismatch, deliberately FANS OUT to
  // every overload as an approximate multi-candidate guess -- appropriate
  // for a typed/interface/self-dispatch call, where the receiver's real
  // class IS known, just not which overload), rule 7 has no such anchor: the
  // receiver itself never resolved to anything. An arity mismatch here is
  // not "which overload" ambiguity, it's proof this call site is calling
  // something else entirely that merely happens to share the bare name --
  // so a mismatch DECLINES outright (stays unresolved) rather than fanning
  // out. `methodFacts` is threaded through only for pickBestOverload's
  // arg-type scoring, used solely to break a tie between two SAME-arity
  // overloads on the sole declaring class (rare, but possible).
  function unresolvedFallback(callerClassLower, callerMethodLabel, call, nameLower, methodFacts) {
    const owners = methodNameIndex.get(nameLower);
    if (!owners || owners.size !== 1) return false; // not unique -> stays unresolved
    const [onlyClassLower] = owners;
    const ownCm = classes.get(onlyClassLower);
    if (!ownCm) return false;
    // LWC-facing @AuraEnabled and Flow-facing @InvocableMethod methods are
    // static and referenced through exact metadata identities. Attaching
    // `unknownService.load()` to the sole static `AccessController.load()`
    // just because the bare name is unique is therefore a false edge; on a
    // common name it also creates enormous later magnets. Keep the older
    // name-only fallback semantics for other methods, whose compatibility
    // contract predates this rule.
    const candidates = ownCm.methods.filter((m) =>
      lc(m.name) === nameLower && !isStaticMetadataBoundMethod(m)
    );
    if (!candidates.length) return false;
    const callArity = (call.argTexts || []).length;
    const exact = candidates.filter((m) => m.params.length === callArity);
    if (!exact.length) return false; // H1(a): arity mismatch -> decline, no fabricated attachment
    const owner = exact.length > 1
      ? pickBestOverload(exact.map((m) => ({ classLower: onlyClassLower, method: m })), call, callerClassLower, methodFacts)
      : { classLower: onlyClassLower, method: exact[0], overloadPick: 'exact' };
    const overloadSig = computeOverloadSig(owner, nameLower);
    writeMethodEdge(callerClassLower, callerMethodLabel, owner.classLower, nameLower, call, 'unique-name', owner.method.name, overloadSig, undefined, undefined, owner.overloadPick, owner.tiedOverloadSigs);
    // v0.13/H1(b) ATTACHMENT CAP bookkeeping: this attachment is written
    // OPTIMISTICALLY (same as pre-H1 behavior) -- whether it actually
    // survives is decided once, after pass B finishes walking every file,
    // by finalizeUniqueNameCap (see its own header note for why the
    // decision can't be made any earlier than that).
    const targetKey = `${owner.classLower}#${nameLower}`;
    uniqueNameAttachCounts.set(targetKey, (uniqueNameAttachCounts.get(targetKey) || 0) + 1);
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
        // walkSuper=true: an implementer
        // that satisfies the interface via an INHERITED (non-interface)
        // base-class method, without redeclaring it itself, is legal Apex.
        // Walking only the implementer's own directly-declared methods
        // silently dropped that caller entirely; walking its own extends
        // chain finds the ancestor that actually supplies the method (e.g.
        // ConcreteGreeter implements Greeter but inherits greet() from
        // BaseGreeter -- the edge belongs on BaseGreeter#greet).
        // A1 forwardOpt=false: this is the H2 implementer FAN-OUT, not the
        // primary interface edge (that's the `any = emitOwners(...)` call
        // above, at the interface's own typeLower, which stays forward
        // TRUE) -- see emitOwners' own header note for why forward tracing
        // deliberately collapses interface dispatch onto the interface
        // method's single node rather than exploding into N implementer
        // children right at the call site.
        const implDirectHit = emitOwners(callerClassLower, callerMethodLabel, implLower, nameLower, call, 'interface', true, callArity, methodFacts, false);
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
        // A1 forwardOpt=false: this whole function is ALWAYS an additive
        // "might also be this subclass instance" fan-out over an already-
        // recorded primary edge (F3's plain-typed override fan-out, or H2's
        // interface x override composition above) -- never itself the
        // primary resolution of a call site, so it never contributes its
        // own forward edges (mirrors the interface-implementer fan-out's
        // own forwardOpt=false, same reasoning: forward tracing shows the
        // single most-direct target, not every possible-override variant).
        writeMethodEdge(callerClassLower, callerMethodLabel, o.classLower, nameLower, call, viaLabel, o.method.name, overloadSig, false, undefined, o.overloadPick, o.tiedOverloadSigs);
        any = true;
      }
    }
    return any;
  }

  // A3(b): '(cond ? a : b)' where both branches are simple identifiers.
  // Returns { classLower, via } when at least one side resolves to a known
  // user class through the caller's type env, else null (falls through to
  // existing rules). Both sides resolving to the SAME class -> 'typed';
  // only one side resolving -> 'unique-name' (approximate).
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
  // then walks up to CHAIN_MAX (v0.10/A1: 12, was a hardcoded 4 pre-v0.10)
  // `.method()`/collection-accessor segments. Each segment first tries F2's
  // collection-accessor bonus (Map<K,V>.get()->V, Map<K,V>.values()->
  // List<V>, List<T>/Set<T>.get()->T) against the CURRENT raw type text --
  // this is what lets a Map<K,V>/List<T>-typed hop participate in the chain
  // at all, since it has no indexed class of its own to look up a declared
  // method on. When the accessor bonus doesn't apply, falls back to the
  // pre-F2 behavior: walk through the declaring method's returnType
  // (following the extends chain to find it). Returns the final owning
  // classLower, or null the moment any segment fails to resolve (declaring
  // method not found, no returnType, the resulting type head isn't a known
  // user class/collection shape, or -- v0.10/A1 -- the walk revisits a
  // (type,method) pair it has already visited earlier in THIS chain).
  function resolveChainedReceiver(receiverRaw, callerClassLower, cm, methodFacts) {
    const parsed = parseChainSegments(receiverRaw);
    if (!parsed || !parsed.segments.length) return null;
    // A3(c)/v0.10(A1) cap: CHAIN_MAX segments is the documented walk limit
    // (12 as of v0.10, was 4 pre-v0.10 -- see CHAIN_MAX's own header note
    // for the BEHAVIOR CHANGE this widening is). A receiver with MORE than
    // CHAIN_MAX segments is not "truncate and use whatever the CHAIN_MAXth
    // lands on" -- that would confidently attribute the outer call to a
    // class the chain never actually reaches (see Chain5E/Chain5F hostile
    // fixture, now a 13-segment-cap-equivalent fixture family per the v0.10
    // corpus). Exceeding the cap is itself a failure of this rule; fall
    // through to existing rules (cast/ternary already tried, then rule 7
    // unique-name, which may also decline if the name isn't globally
    // unique -- correctly yielding NO edge rather than a wrong one).
    if (parsed.segments.length > CHAIN_MAX) {
      // H4: one of the three named "dropped call site" categories -- counted
      // here (the single, precise source for this reason) regardless of
      // whether the caller was a dot-call (resolveDotOther, via
      // resolveComplexReceiver) or a prop-call (resolvePropCall) receiver;
      // resolveDotOther's own generic catch-all (below) is taught to skip
      // re-counting this same call site for the same reason.
      bumpUnresolvedReason('deep-chain'); // v0.13/H3
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
    // v0.10/A1: per-CALL (fresh every invocation of this function -- i.e.
    // per receiver text, not shared across chains) guard against a
    // return-type CYCLE (A.next()->B, B.next()->A, ...): without this, a
    // chain that happens to stay within CHAIN_MAX segments but oscillates
    // between the same two (or more) types via the same-named method would
    // "resolve" via ordinary deterministic function application -- correct
    // in isolation, but exactly the kind of "confidently walked a loop"
    // shape the CHAIN_MAX cap already refuses to trust past its own bound.
    // Keyed on (curClassLower, segLower) -- i.e. "about to invoke THIS
    // method on THIS already-resolved type" -- checked only in the
    // findDeclaredMethodRaw branch below (a collection-accessor hop has no
    // declaring class to key on, and applyCollectionAccessor's own domain
    // -- Map/List/Set -- cannot cycle back to a user type by construction).
    const visited = new Set();
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
      const visitKey = `${curClassLower}#${segLower}`;
      if (visited.has(visitKey)) {
        // v0.10/A1: cycle hit -- degrades to no edge, the SAME "dropped
        // call site" treatment (and the SAME H4 counter) as exceeding
        // CHAIN_MAX.
        bumpUnresolvedReason('deep-chain'); // v0.13/H3
        return null;
      }
      visited.add(visitKey);
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
  // applied before the unique-name fallback. Returns
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

  // v0.7.1/R1: true when receiverRaw is a PLAIN dotted identifier chain
  // that is NOT genuinely in scope -- see PLAIN_DOTTED_CHAIN_RE's own
  // header note for exactly which receiver shapes this applies to.
  // "Known"/in-scope means: the head is 'this'/'super', OR the head is a
  // local variable/param/field in scope at this call site (covers a
  // genuine `obj.field...` chain that merely doesn't happen to match any of
  // resolveComplexReceiver's specific bonus shapes), OR -- v0.7.1 re-hunt
  // fix -- the FULL dotted chain resolves to a real qualified local class
  // via resolveTypeStrict (the calling scope's own enclosing-class chain,
  // or an exact dotted-qualified match; deliberately NOT the bare-tail
  // fallback). Merely having a head segment that happens to match SOME
  // local class's name (top-level or inner, anywhere in the workspace) is
  // NOT sufficient on its own: a genuine local class named `zenq` whose
  // only inner class is `Foo` must not cause `zenq.KappaGateway` (or
  // `zenq.deep.nested.KappaGateway`) to be treated as in-scope just because
  // `zenq` itself is real -- the REMAINDER of the chain must also resolve
  // within that class's own hierarchy. Everything else is an out-of-scope
  // namespaced/managed reference (`zenq.Billing`, `kwx.KappaGateway`) that
  // must never be allowed to alias onto a local class merely because its
  // bare tail happens to collide.
  function isUnknownNamespacedReceiver(receiverRaw, callerClassLower, methodFacts) {
    const raw = String(receiverRaw || '').trim();
    if (!PLAIN_DOTTED_CHAIN_RE.test(raw)) return false;
    const head = raw.slice(0, raw.indexOf('.'));
    const headLower = lc(head);
    if (headLower === 'this' || headLower === 'super') return false;
    if (findReceiverType(callerClassLower, methodFacts, head)) return false;
    const cm = classes.get(callerClassLower);
    const strictMatch = resolveTypeStrict(raw, cm ? cm.qualified : null);
    if (strictMatch) return false;
    return true;
  }

  // v0.8/N3: strips a leading OWN-namespace segment off a dotted Apex
  // receiver chain BEFORE any resolution rule (incl. isUnknownNamespacedReceiver
  // above) ever sees it -- "stripped ... before any resolution is attempted",
  // per N3's own text. `vtx.VertexPricingService.repriceOrder(...)` becomes
  // an ordinary un-prefixed `VertexPricingService.repriceOrder(...)` local
  // static call; a receiver whose head segment is NOT the own namespace (or
  // there is no own namespace configured at all) is returned unchanged.
  // Deliberately only strips ONE leading segment (the ns itself, not
  // whatever follows) -- N3 only documents the namespace TOKEN being
  // stripped, not any deeper chain-shape assumption.
  function stripOwnNamespacePrefix(receiverRaw) {
    if (!ownNamespaceLower) return receiverRaw;
    const trimmed = String(receiverRaw == null ? '' : receiverRaw).trim();
    if (!PLAIN_DOTTED_CHAIN_RE.test(trimmed)) return receiverRaw;
    const dotIdx = trimmed.indexOf('.');
    const head = trimmed.slice(0, dotIdx);
    if (lc(head) !== ownNamespaceLower) return receiverRaw;
    return trimmed.slice(dotIdx + 1);
  }

  // Rules 5-7: a 'dot' call whose receiver is neither 'this' nor 'super'.
  function resolveDotOther(callerClassLower, callerMethodLabel, methodFacts, rawCall) {
    // v0.8/N3: own-namespace stripping happens first, against a CLONE (the
    // original CallFacts object is shared/reused elsewhere -- e.g. pass B's
    // own forward-edge bookkeeping reads call.line/col/lineText/argTexts
    // untouched -- so only `.receiver` is ever overridden, never mutated in
    // place). Every downstream read in this function (incl. the
    // resolveComplexReceiver call below, which reads call.receiver directly
    // rather than the local `receiverRaw`) must see the SAME stripped value,
    // hence threading the clone through as `call` rather than only
    // shadowing a local variable.
    const strippedReceiver = stripOwnNamespacePrefix(rawCall.receiver);
    const strippedOwnNs = strippedReceiver !== rawCall.receiver;
    const call = strippedOwnNs ? Object.assign({}, rawCall, { receiver: strippedReceiver }) : rawCall;
    const nameLower = lc(call.method);
    const cm = classes.get(callerClassLower);
    const receiverRaw = call.receiver;
    const callArity = (call.argTexts || []).length;
    const isSimple = SIMPLE_IDENT_RE.test(String(receiverRaw || '').trim());

    // Rule 6 (type-env / shadowing local-param-field)
    // is checked BEFORE rule 5 (class-name match) when the receiver is a
    // simple identifier that names an in-scope variable. Apex/Java identifier
    // scoping means a local/param/field always shadows a same-named class
    // for the rest of its scope -- resolution checks this before rule
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
        // when declared-type resolution already failed
        // ("never used when declared-type resolution succeeds").
        if (tryNarrowedReceiver(callerClassLower, callerMethodLabel, methodFacts, receiverRaw, nameLower, call, callArity)) return;
        // A declared platform type is as definitive as a platform-named
        // static receiver. The call may be irrelevant to this graph, but it
        // is not unresolved Apex dispatch and must never become a name-only
        // candidate caller of a user method with the same common name.
        if (isKnownPlatformReceiverType(declaredType)) {
          lastReceiverDenylisted = true;
          return;
        }
      }
    }

    // v0.7.1/R1: a DOTTED receiver whose head segment does not refer to a
    // known local class/inner-class (simpleNameIndex), a known local
    // variable/param/field (findReceiverType), or -- trivially -- a
    // namespace-free single-token receiver, must never fall through to
    // rule 5's bare-last-segment class match (nor rules 6/7). Without this
    // guard, resolveType()'s "no exact dotted match -> retry on the bare
    // last segment alone" fallback (and, failing that, rule 7's unique-name
    // fallback) can fabricate a confident edge to an unrelated LOCAL class
    // from a reference into a namespace/managed package that was never
    // installed in this workspace (`zenq.Billing.charge()` colliding onto
    // local `Billing.charge`, `kwx.KappaGateway.dispatch()` colliding onto
    // local `KappaGateway.dispatch`).
    // Scoped to a PLAIN dotted identifier chain (no parens/brackets) so
    // cast-expression/ternary/chained-call receivers (handled below by the
    // rule-6-continued bonuses, which already require their own explicit
    // shape match) are unaffected. Genuinely ambiguous local tails (2+
    // candidates sharing the bare simple name) already produce no edge via
    // the pre-existing N===1 gate inside resolveType/unresolvedFallback --
    // this guard doesn't change that outcome, it just reaches "no edge" by
    // a more honest path (never attempting the collision at all).
    if (!shadowedByVariable && isUnknownNamespacedReceiver(receiverRaw, callerClassLower, methodFacts)) {
      // v0.8/N2 step 3: exactly the "3-segment call expression Head.Mid.
      // method(...)" shape (receiver has ONE dot -- Head.Mid) with a
      // plausible, non-denylisted namespace-token Head promotes to an
      // EXTERNAL edge instead of an anonymous unresolved count. A longer
      // chain, or a Head that IS platform-denylisted, falls through to the
      // exact pre-v0.8 "honest unresolved site" outcome unchanged.
      if (tryAttachExternalTwoSegmentReceiver(receiverRaw, nameLower, call, callerClassLower, callerMethodLabel)) return;
      recordUnresolvedSite('unknown-receiver', nameLower, callerClassLower, callerMethodLabel, call); // v0.13/H3
      return;
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
        // B2: classMatch is resolveType's ordinary first-wins pick -- when
        // opts.packageOf never actually resolved a real package label for
        // any file (packageMetadataDiscovered, not merely
        // "packageOf is a function" -- a live packageOf that returns null
        // for every path, exactly what extension.js passes for a workspace
        // with no discoverable sfdx-project.json, must NOT enable this
        // branch), or this name simply isn't duplicated,
        // resolveDuplicateBucket is a same-value passthrough (winners:
        // [classMatch], via:'static'), so this branch is byte-identical to
        // pre-v0.7 behavior in both those cases (the B5 packageless-
        // identity guarantee). Only a genuinely duplicated name with
        // package metadata available changes anything here.
        const bucketResult = packageMetadataDiscovered
          ? resolveDuplicateBucket(classMatch, cm.package != null ? cm.package : null)
          : { winners: [classMatch], via: 'static' };
        for (const winnerClassLower of bucketResult.winners) {
          emitOwners(callerClassLower, callerMethodLabel, winnerClassLower, nameLower, call, bucketResult.via, true, callArity, methodFacts);
        }
        return;
      }
    }

    // Rule 6 continued / A3: cast-expression, ternary, and chained-call
    // receiver bonuses (all "applied before the unique-name fallback").
    if (!isSimple) {
      if (resolveComplexReceiver(callerClassLower, callerMethodLabel, cm, methodFacts, call, nameLower, callArity)) {
        return; // A resolved rule-6 typed shadow is never denylisted.
      }
    }

    // Denylist gate: only reached once rules 5 and 6 both failed to find a
    // known-class resolution (decision #7). A denylisted receiver is a
    // deliberate, known exclusion (System/Database/etc.) -- not counted as
    // an H4 "dropped" site.
    const headLower = lastSegmentLower(receiverRaw);
    if (PLATFORM_DENYLIST.has(headLower)) {
      lastReceiverDenylisted = true; // v0.7.1/R6: forward-count parity, see the flag's own header note
      return;
    }

    // v0.7.1/R3: a call whose method name is a common Map/List/Set builtin
    // accessor (get/put/add/...) is NEVER routed through rule 7's
    // unique-name fallback. By the time this line runs, rules 5/6 have
    // already exhausted every way to resolve the receiver to a genuine user
    // class -- the receiver is, by construction, either collection-typed
    // (a Map<K,V>/List<T>/Set<T> declared type that resolveType() can't
    // index) or simply of unknown type. Firing rule 7 anyway lets an
    // extremely common, generic-sounding accessor name collide with an
    // unrelated, incidentally-unique real method of the same name elsewhere
    // in the workspace (`newRecordsByType.get(tkey)` -> `KappaServiceLocator.get`,
    // including a spurious self-referential cyclic edge when the fallback's
    // own sole candidate is the call's own enclosing method).
    // v0.8/N3 fix (defect #1, ghost-remainder rule-7 fabrication):
    // stripOwnNamespacePrefix can turn a dotted, namespace-shaped receiver
    // ('ownx.GhostClass') into a BARE simple identifier ('GhostClass')
    // BEFORE this function ever ran isUnknownNamespacedReceiver above --
    // and that guard only ever gates dotted chains (PLAIN_DOTTED_CHAIN_RE),
    // so a stripped-down bare remainder sails straight past it. Rule 5
    // (just above) already tried and failed to match the bare remainder to
    // a real local class, and it isn't a shadowing variable either (the
    // `!shadowedByVariable` block above already excluded that) -- so this
    // is exactly a stale/typo'd/nonexistent own-namespace reference, the
    // same class of receiver isUnknownNamespacedReceiver exists to
    // quarantine for still-dotted remainders. Without this gate, N3 would
    // silently downgrade such a reference from "safely quarantined" to
    // "exposed to rule 7", fabricating a confident but false local edge to
    // any unrelated class that happens to declare a globally-unique method
    // of the same name.
    // Deliberately only suppresses rule 7's OWN fallback attempt here --
    // the denylist gate above (e.g. a stripped 'ownx.System' remainder)
    // still runs first and is unaffected, exactly like the pre-existing
    // COLLECTION_ACCESSOR_NAMES suppression this mirrors.
    // Rule 7: unique-name fallback.
    const resolved = COLLECTION_ACCESSOR_NAMES.has(nameLower) || (strippedOwnNs && isSimple)
      ? false
      : unresolvedFallback(callerClassLower, callerMethodLabel, call, nameLower, methodFacts);
    // H4: every prior rule (5, 6, and rule 7's own unique-name fallback)
    // has now failed -- this receiver never resolved to anything at all
    // ("unknown receiver"). Skip the count when resolveChainedReceiver
    // already counted this exact call site under its own more specific
    // "chain > 4 segments" category above (resolveComplexReceiver tried it
    // as one of its bonuses) -- one dropped call site, one count.
    if (!resolved) {
      const chainSeg = !isSimple ? parseChainSegments(receiverRaw) : null;
      const alreadyCountedChainCap = !!(chainSeg && chainSeg.segments.length > 4);
      // v0.13/H3: reason='unknown-receiver' -- this is the catch-all "rule
      // 7 also declined" outcome (either the name wasn't globally unique, or
      // -- new in H1 -- it WAS unique but failed the arity gate). Both are
      // "this call's real target is unknown" from the tracer's point of
      // view, so both share the same reason bucket.
      if (!alreadyCountedChainCap) recordUnresolvedSite('unknown-receiver', nameLower, callerClassLower, callerMethodLabel, call);
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
    // with no edge, same as a property match stops it WITH one.
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
      if (field) return true; // stop: field-not-property, no edge
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
      // First-seen construction site for this class, keyed by
      // its resolved classLower -- see firstConstructedAt's own header note.
      if (!firstConstructedAt.has(targetClassLower)) {
        firstConstructedAt.set(targetClassLower, { path: cm.path, line: call.line || 0 });
      }
      // A1/A2/A3: suppress the FORWARD half only (reverse methodCallers/
      // classCallers edges are written unconditionally, below, unchanged)
      // when this exact 'new' expression is the operand of either a throw
      // statement (G2's 'throw new AcmeX(...)' dual-fact shape) or a
      // qualifying async-hop call (G5's 'System.enqueueJob(new AcmeX(...))'
      // shape) on the SAME line -- see isNewSuppressedFromForward's own
      // header note for why forward direction needs this explicit check
      // where reverse direction gets the equivalent collapse for free.
      const forward = !isNewSuppressedFromForward(methodFacts, call.line);
      writeCtorEdge(callerClassLower, callerMethodLabel, targetClassLower, call, 'new', forward);
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
      // else rule 7. v0.7.1/R4: emitOwnersWithSelfOverrideFanout (not plain
      // emitOwners) -- a bare self-call is exactly the template-method
      // self-dispatch shape (`run() { beforeInsert(); }`), so it must ALSO
      // fan out to subclass overrides, same as rule 6's typed dispatch
      // already does.
      const callArity3 = (call.argTexts || []).length;
      if (emitOwnersWithSelfOverrideFanout(callerClassLower, callerMethodLabel, callerClassLower, nameLower, call, 'this', true, callArity3, methodFacts)) return;
      unresolvedFallback(callerClassLower, callerMethodLabel, call, nameLower, methodFacts);
      return;
    }

    // call.kind === 'dot'
    const receiverLower = lc(call.receiver);
    if (receiverLower === 'this') {
      // Rule 4 (this): identical semantics to rule 3 (incl. v0.7.1/R4's
      // self-override fan-out -- see emitOwnersWithSelfOverrideFanout's own
      // header note).
      const nameLower = lc(call.method);
      const callArity4t = (call.argTexts || []).length;
      if (emitOwnersWithSelfOverrideFanout(callerClassLower, callerMethodLabel, callerClassLower, nameLower, call, 'this', true, callArity4t, methodFacts)) return;
      unresolvedFallback(callerClassLower, callerMethodLabel, call, nameLower, methodFacts);
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
  // v0.8/N1(b)/N3: return shape widened from a plain lowercased string to
  // { lower, original, external } -- `lower` is EXACTLY what every pre-v0.8
  // caller already used (unchanged meaning: the canonical, lowercased object
  // identity used for trigger-matching/dmlSitesByObject/etc.), `original`
  // is its case-preserved form (only consumed by this function's own N1(b)
  // branch below today), and `external` is `{ ns, className }` when (and
  // only when) this object's text matches the FULL managed-object shape
  // 'ns__Object__c' per N1(b) and ns is NOT the workspace's own namespace --
  // null otherwise. N3's own-namespace stripping happens INLINE here (not as
  // a separate post-processing step) so `lower`/`original` themselves become
  // the STRIPPED identity for an own-namespace token -- the ONE canonical
  // object key every downstream consumer (trigger matching, dmlSitesByObject,
  // flow DML fan-out) sees, so `vtx__Config__c` and bare `Config__c` are
  // provably the same object, not merely two objects that happen to agree.
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
    let original = dmlObjectHeadOriginal(typeRaw);
    if (!original) return null;
    let external = null;
    const split = splitNamespacePrefix(original);
    if (split) {
      if (ownNamespaceLower && lc(split.ns) === ownNamespaceLower) {
        original = split.rest; // N3: own-namespace object token strips to its local identity
      } else if (/__c$/i.test(split.rest)) {
        // N1(b): the FULL 'ns__Object__c' managed-object shape (an ordinary
        // local custom object like 'Vertex_Order__c' has only ONE '__',
        // between its name and the trailing 'c' -- splitNamespacePrefix's
        // `rest` for that shape is just 'c', which never itself ends in
        // '__c', so this branch is unreachable for a plain local object;
        // see splitNamespacePrefix's own header note). The FULL, unstripped
        // token stays the trigger-matching identity (N4: event matching is
        // untouched by an object "looking" namespaced) -- only `external`
        // gains a value, nothing about `original`/`lower` changes here.
        external = { ns: split.ns, className: split.rest };
      }
    }
    return { lower: lc(original), original, external };
  }

  // F1(b): records every valid DML site regardless of trigger match, for
  // record-triggered-flow children lookups later (buildMetaChildren).
  function recordDmlSite(op, objectLower, callerClassLower, callerMethodLabel, callLike, approximateOverride) {
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
      // v0.11/B2: see makeCallSite's own note -- true ONLY for a narrowed-
      // generic-DML site; every pre-existing caller omits the argument, so
      // this is false (not merely falsy-by-absence) on every site that
      // predates B2, and buildFlowChildren's own per-entry check below
      // treats false/undefined identically anyway.
      approximate: !!approximateOverride,
    };
    if (!dmlSitesByObject.has(objectLower)) dmlSitesByObject.set(objectLower, []);
    dmlSitesByObject.get(objectLower).push(entry);
  }

  // F1(a): writes a via='dml' caller edge into methodCallers['<trigger>#(trigger)']
  // for every trigger on objectLower whose events intersect op's mapped
  // events -- a single upsert/merge statement can match more than one
  // trigger on the
  // same object.
  function emitDmlTriggerEdges(callerClassLower, callerMethodLabel, op, objectLower, callLike, approximateOverride) {
    recordDmlSite(op, objectLower, callerClassLower, callerMethodLabel, callLike, approximateOverride);
    const triggers = triggersByObject.get(objectLower) || [];
    if (!triggers.length) return;
    const opEvents = opToTriggerEvents(op);
    for (const t of triggers) {
      const tEvents = ((t.triggerInfo && t.triggerInfo.events) || []).map(lc);
      if (opEvents.some((e) => tEvents.includes(e))) {
        writeMethodEdge(callerClassLower, callerMethodLabel, lc(t.qualified), '(trigger)', callLike, 'dml', '(trigger)', null, undefined, approximateOverride);
      }
    }
  }

  // v0.7.1/R8: `objectLower` reduced to the literal generic `SObject`
  // placeholder (dmlObjectHead's own "strip List<>/Set<>/[] wrapper, keep
  // the last dotted segment" logic applied to a declared type of
  // `List<SObject>`/`SObject`/`SObject[]`, never narrowed to a concrete
  // custom/standard object -- e.g. a fflib-style unit-of-work whose
  // registered records are erased into `Map<Schema.SObjectType,
  // List<SObject>>` before commitWork() DMLs them). A real object's bare
  // API name can never legitimately BE the literal token "SObject" (custom
  // objects always carry a `__c`/namespace suffix, standard objects have
  // their own real names), so this check is unambiguous. Recorded so
  // buildCalleeTree can surface an honest "DML on unresolved SObject type"
  // leaf instead of silently dropping the DML site (no trigger linkage is
  // attempted -- there is no real object identity to link against).
  function recordUnresolvedDmlSite(callerClassLower, callerMethodLabel) {
    const callerKey = `${callerClassLower}#${lc(callerMethodLabel)}`;
    unresolvedDmlForwardCounts.set(callerKey, (unresolvedDmlForwardCounts.get(callerKey) || 0) + 1);
  }

  // v0.11/B2: generic-DML narrowing. Only ever consulted once the DML
  // target has already reduced to the literal `SObject` placeholder above.
  // The target must be a LOCAL variable (never
  // a param/field -- findLocalFact, not findReceiverType, so a same-named
  // param/field can never masquerade as narrowing evidence); intra-method
  // `add`/`addAll` DOT calls on that SAME variable name are the only
  // evidence source (cross-method evidence -- params, fields, a callee's
  // return type -- is not used as evidence); each qualifying
  // call's single argText is resolved through the SAME
  // resolveDmlTargetObject machinery the DML target itself uses (a `new
  // Concrete__c(...)` construction, or a bare identifier whose type-env
  // declared type is itself concrete) -- an argText that resolves to
  // NOTHING, or that itself only reduces to the generic `SObject`
  // placeholder (e.g. addAll-ing another generically-typed collection), is
  // silently skipped, exactly like an ordinary unresolved DML target would
  // be. The UNION of every distinct concrete type found across ALL
  // qualifying evidence calls fans out to trigger + record-flow linkage
  // per type (emitDmlTriggerEdges, reused verbatim -- flow fan-out comes
  // along for free since that function already calls recordDmlSite), each
  // edge via='dml'/approximate:true (the narrowed badge -- see
  // makeCallSite's own note). Returns whether ANY narrowing evidence was
  // found -- false means the caller must fall back to the honest marker,
  // exactly as before B2 existed.
  //
  // Evidence must be a positional guarantee, not merely "some
  // add()/addAll() call on this variable name exists ANYWHERE in the
  // method" -- an add() call textually AFTER the DML statement already ran
  // cannot possibly describe what was actually in the collection AT insert
  // time (e.g. `insert pending; pending.add(new Kappa_Order__c(...));` --
  // the add() happens to a list that has already been submitted; the real
  // runtime insert() call site sees an EMPTY collection). `dmlLine` is the
  // DML statement's/Database.xxx() call's own source line; only evidence
  // calls with `c.line < dmlLine` (strictly BEFORE, matching Apex's
  // top-to-bottom statement execution order within a straight-line method
  // body) ever count -- a call on the same line never qualifies either
  // (Apex has no legitimate same-line-before/after distinction worth
  // trusting here, and a DML statement's own line never itself contains an
  // add()/addAll() call in practice).
  function tryNarrowGenericDml(callerClassLower, callerMethodLabel, mf, op, targetText, callLike, dmlLine) {
    const raw = String(targetText || '').trim();
    if (!SIMPLE_IDENT_RE.test(raw)) return false; // only a bare local-variable target ever qualifies
    if (!findLocalFact(mf, raw)) return false; // must be a LOCAL declaration, never a param/field
    const targetLower = lc(raw);
    const evidence = new Map(); // objectLower -> resolveDmlTargetObject() result
    for (const c of mf.calls || []) {
      if (c.kind !== 'dot') continue;
      if (lc(c.receiver) !== targetLower) continue;
      const ml = lc(c.method);
      if (ml !== 'add' && ml !== 'addall') continue;
      if (!(c.line < dmlLine)) continue; // Evidence written at/after the DML line never counts.
      const argTexts = c.argTexts || [];
      if (!argTexts.length) continue;
      const resolvedArg = resolveDmlTargetObject(argTexts[0], callerClassLower, mf);
      if (!resolvedArg || resolvedArg.lower === 'sobject') continue; // no evidence, or itself still generic -- doesn't count
      if (!evidence.has(resolvedArg.lower)) evidence.set(resolvedArg.lower, resolvedArg);
    }
    if (!evidence.size) return false; // zero valid evidence -- caller keeps the honest marker
    for (const resolvedType of evidence.values()) {
      emitDmlTriggerEdges(callerClassLower, callerMethodLabel, op, resolvedType.lower, callLike, true);
      if (resolvedType.external) attachExternalDmlSite(resolvedType.external.ns, resolvedType.external.className, callerClassLower, callerMethodLabel, callLike);
    }
    return true;
  }

  // F1: statement-form DML (parser.js's MethodFacts.dml -- one entry per
  // insert/update/delete/undelete/upsert/merge STATEMENT).
  function handleDmlStatement(callerClassLower, callerMethodLabel, mf, dmlFact) {
    const op = lc(dmlFact && dmlFact.op);
    if (!DML_OPS.has(op)) return;
    const resolved = resolveDmlTargetObject(dmlFact.targetText, callerClassLower, mf);
    if (!resolved) return;
    if (resolved.lower === 'sobject') { // v0.7.1/R8
      const callLike = { line: dmlFact.line, col: dmlFact.col, lineText: dmlFact.lineText, argTexts: [dmlFact.targetText] };
      if (!tryNarrowGenericDml(callerClassLower, callerMethodLabel, mf, op, dmlFact.targetText, callLike, dmlFact.line)) {
        recordUnresolvedDmlSite(callerClassLower, callerMethodLabel); // v0.11/B2: zero-evidence path -- marker stays exactly as today
      }
      return;
    }
    const callLike = { line: dmlFact.line, col: dmlFact.col, lineText: dmlFact.lineText, argTexts: [dmlFact.targetText] };
    emitDmlTriggerEdges(callerClassLower, callerMethodLabel, op, resolved.lower, callLike);
    // v0.8/N1(b): additive -- an object matching the managed-object shape
    // ALSO gains an external node, regardless of whether it matched a
    // trigger above (N4: the two mechanisms are independent, see
    // resolveDmlTargetObject's own N1(b) note).
    if (resolved.external) attachExternalDmlSite(resolved.external.ns, resolved.external.className, callerClassLower, callerMethodLabel, callLike);
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
    const resolved = resolveDmlTargetObject(targetText, callerClassLower, mf);
    if (!resolved) return;
    if (resolved.lower === 'sobject') { // v0.7.1/R8, same reasoning as handleDmlStatement
      if (!tryNarrowGenericDml(callerClassLower, callerMethodLabel, mf, op, targetText, call, call.line)) {
        recordUnresolvedDmlSite(callerClassLower, callerMethodLabel); // v0.11/B2: zero-evidence path -- marker stays exactly as today
      }
      return;
    }
    emitDmlTriggerEdges(callerClassLower, callerMethodLabel, op, resolved.lower, call);
    if (resolved.external) attachExternalDmlSite(resolved.external.ns, resolved.external.className, callerClassLower, callerMethodLabel, call);
  }

  // v0.11/B1(b): mirrors resolveDotOther rule 5's own
  // duplicate-bucket handling (resolveDuplicateBucket / classBuckets --
  // same-package, else default-package, else EVERY remaining candidate
  // via='ambiguous') instead of the plain resolveType() this branch used to
  // call directly. Plain resolveType() returns classBuckets' arbitrary
  // first-wins hit for a duplicated class name -- for `ClassName.CONST`
  // that meant an ambiguous class name silently picked ONE package's
  // constant (parse-order-dependent, non-deterministic across runs) instead
  // of failing safely or fanning out like ordinary `ClassName.method()`
  // dispatch does for the exact same ambiguous class. Returns
  // { literal: string, forcedVia: 'ambiguous'|null }[] -- forcedVia is only
  // set to 'ambiguous' when the bucket lookup itself came back 'ambiguous'
  // (an unambiguous bucket, or no package metadata at all, leaves forcedVia
  // null so handleTypeForName's default via='dynamic' applies, byte-
  // identical to pre-fix behavior in that case). An 'ambiguous' bucket
  // returns one entry per WINNING candidate class that actually declares
  // the constant (never a single shared literal string reused across
  // candidates -- each winner's OWN constant value is looked up
  // independently, so two ambiguous classes with DIFFERING literal values
  // for the same constant name each contribute their own, distinct
  // candidate). Deliberately returns LITERAL VALUES only, same as every
  // other branch of resolveTypeForNameLiteralCandidates -- which winner
  // class supplied the constant is settled right here; which target class
  // that literal VALUE itself names (e.g. 'FromA' -> class FromA) is a
  // wholly separate question handleTypeForName's own resolveType/
  // resolveTypeStrict lookup still answers per candidate, unchanged.
  function resolveQualifiedConstantCandidates(classRaw, constNameLower, callerClassLower) {
    const ccm0 = classes.get(callerClassLower);
    const classMatch = resolveType(classRaw, ccm0 ? ccm0.qualified : null);
    if (!classMatch) return [];
    const bucketResult = packageMetadataDiscovered
      ? resolveDuplicateBucket(classMatch, ccm0 && ccm0.package != null ? ccm0.package : null)
      : { winners: [classMatch], via: 'static' };
    if (bucketResult.via === 'ambiguous') {
      const out = [];
      for (const winnerClassLower of bucketResult.winners) {
        const lit = resolveConstantLiteral(winnerClassLower, constNameLower);
        if (lit != null) out.push({ literal: lit, forcedVia: 'ambiguous' });
      }
      return out; // may be empty -- none of the ambiguous candidates declare this constant
    }
    const lit = resolveConstantLiteral(bucketResult.winners[0], constNameLower);
    return lit != null ? [{ literal: lit, forcedVia: null }] : [];
  }

  // v0.11/B1: paren-depth-aware ternary matcher (matchTernaryStringLiterals,
  // defined at module scope near splitTopLevelCommas) replaces a plain regex
  // whose permissive `[\s\S]+?` condition-prefix + optional trailing `)`
  // could match a ternary NESTED INSIDE an unrelated wrapping call
  // expression -- see that function's own header note for the full repro
  // and reasoning.

  // v0.11/B1(b): looks up `constNameLower` in classLower's OWN
  // TypeFacts.constants (the parser's additive contract -- one entry per
  // static final String field with a single-literal initializer; a
  // non-final field, or one whose initializer isn't a single literal,
  // simply never appears here at all -- see the parser field documentation).
  // Returns
  // the literal string value, or null when no qualifying constant of that
  // name exists on this exact class (never walks the extends chain --
  // B1's own spec text is "own class or qualified cross-class", never
  // "inherited").
  function resolveConstantLiteral(classLower, constNameLower) {
    const cm = classes.get(classLower);
    if (!cm || !cm.typeFacts) return null;
    const found = (cm.typeFacts.constants || []).find((c) => lc(c.name) === constNameLower);
    return found && found.literal != null ? found.literal : null;
  }

  // v0.11/B1: given a Type.forName(...) call's single argText, returns the
  // array of candidates it resolves to under the three additive B1 forms,
  // or [] when it qualifies under NONE of them (still covers the
  // pre-existing F4a inline-literal case as its first branch). Each
  // candidate is `{ literal, forcedVia }` -- literal is the STRING VALUE,
  // run through the SAME resolveType/external-fallback machinery an inline
  // literal already used to find its OWN target class (which class a
  // literal VALUE names is never shortcut here, even for the B1(b)
  // ambiguous-constant case below -- only WHICH class's constant field
  // supplied that literal was ambiguous, not what the literal itself
  // means); forcedVia overrides the edge's default via='dynamic' when
  // non-null (only the B1(b) ambiguous-duplicate-class fan-out sets it, to
  // 'ambiguous' -- see resolveQualifiedConstantCandidates' own header note).
  //   (direct)  a plain quoted string -- unchanged pre-B1 behavior.
  //   (c)       a ternary of two quoted string literals -> BOTH values.
  //   (b)       a dotted 'ClassName.CONST' reference -> that class's own
  //             TypeFacts.constants (own class only, no extends-chain
  //             walk), ambiguity-aware via resolveQualifiedConstantCandidates.
  //   (a) + (b) a bare identifier -> checked as a LOCAL first (via
  //             findLocalFact -- present with a `literal` only when the
  //             parser proved a single-literal initializer AND no other
  //             assignment anywhere in the method; a local of that name
  //             with no `literal` is a positively-confirmed negative,
  //             e.g. (a-neg)'s reassigned case, and must NOT fall through
  //             to a same-named constant -- a local always SHADOWS a
  //             class constant in real Apex scoping), else as the CALLING
  //             class's own bare constant. A method PARAMETER never
  //             appears in MethodFacts.locals at all (the parser's
  //             locals[]/literal contract is local-declarations-only), so
  //             (e)'s param-fed case falls all the way through to [].
  function resolveTypeForNameLiteralCandidates(argText, callerClassLower, mf) {
    const plain = (literal) => ({ literal, forcedVia: null });
    const trimmed = String(argText == null ? '' : argText).trim();
    const direct = trimmed.match(/^"([^"]*)"$/) || trimmed.match(/^'([^']*)'$/);
    if (direct) return [plain(direct[1])];
    const tern = matchTernaryStringLiterals(trimmed);
    if (tern) return [plain(tern[0]), plain(tern[1])];
    const dotIdx = trimmed.indexOf('.');
    if (dotIdx > 0 && trimmed.indexOf('.', dotIdx + 1) === -1) {
      const classRaw = trimmed.slice(0, dotIdx);
      const constName = trimmed.slice(dotIdx + 1);
      if (SIMPLE_IDENT_RE.test(classRaw) && SIMPLE_IDENT_RE.test(constName)) {
        // qualified-but-unresolved / no-such-constant (b-neg) -> [] negative,
        // never falls through further.
        return resolveQualifiedConstantCandidates(classRaw, lc(constName), callerClassLower);
      }
    }
    if (SIMPLE_IDENT_RE.test(trimmed)) {
      const local = findLocalFact(mf, trimmed);
      if (local) return local.literal != null ? [plain(local.literal)] : []; // a local always shadows a same-named constant -- reassigned/non-literal local is a hard negative
      const lit = resolveConstantLiteral(callerClassLower, lc(trimmed));
      if (lit != null) return [plain(lit)];
    }
    return [];
  }

  // v0.11/B1(d): mirrors tryAttachExternalTwoSegmentReceiver's own N2-step-3
  // shape checks (genuine 2-segment 'ns.Class' token, ns not denylisted/
  // own-namespace, Mid doesn't resolve as a real local member) but for a
  // literal VALUE reached through dataflow rather than a call expression's
  // own receiver text -- and, per B1's own "via='dynamic'" text, attaches
  // via 'dynamic' (an inference over WHICH literal reaches this site), not
  // 'external' (N2's "the call expression's own syntax is exact"). An
  // own-namespace-prefixed literal is deliberately left unresolved rather
  // than stripped-and-retried locally (N3 parity for THIS shape isn't
  // treated as local here; genuinely foreign namespaces are never promoted to an
  // external either way, so no false managed-package node is ever
  // fabricated for the workspace's own code.
  function tryAttachExternalLiteral(litValue, callerClassLower, callerMethodLabel, call) {
    const raw = String(litValue == null ? '' : litValue).trim();
    const dotIdx = raw.indexOf('.');
    if (dotIdx <= 0) return false;
    const rest = raw.slice(dotIdx + 1);
    if (rest.indexOf('.') !== -1) return false; // only a genuine 2-segment 'ns.Class' literal shape qualifies
    const head = raw.slice(0, dotIdx);
    if (!SIMPLE_IDENT_RE.test(head) || !SIMPLE_IDENT_RE.test(rest)) return false;
    if (PLATFORM_DENYLIST.has(lc(head))) return false;
    if (ownNamespaceLower && lc(head) === ownNamespaceLower) return false;
    if (headClassHasMember(head, rest)) return false;
    attachExternalApexSite(head, rest, '<init>', callerClassLower, callerMethodLabel, call, 'dynamic');
    return true;
  }

  // F4a/v0.11-B1: Type.forName(...) -- resolves through FOUR strictly-
  // verifiable dataflow shapes (the pre-existing inline string literal,
  // plus B1's three additive forms above), all landing via='dynamic',
  // approximate:true, through the SAME class-lookup rules an inline
  // literal already used (incl. B1(d)'s namespace/external fallback).
  // Anything else (params, reassigned locals, non-final/non-literal
  // constants, concatenation, an arbitrary expression) stays unresolved-
  // counted exactly as before B1 existed. Independent of ordinary dispatch
  // for the same reason as the Database.xxx() case above ('type' is
  // platform-denylisted, so ordinary dispatch already produces zero edges
  // for this receiver on its own -- this is purely additive, never a
  // conflicting resolution).
  function handleTypeForName(callerClassLower, callerMethodLabel, mf, call) {
    if (call.kind !== 'dot') return;
    if (lc(call.receiver) !== 'type') return;
    if (lc(call.method) !== 'forname') return;
    const args = call.argTexts || [];
    if (args.length !== 1) return;
    const argText = String(args[0] == null ? '' : args[0]).trim();
    const candidates = resolveTypeForNameLiteralCandidates(argText, callerClassLower, mf);
    if (!candidates.length) {
      // H4: the third named "dropped call site" category -- an arg text
      // that never qualifies under any of the four literal-flow shapes
      // (variable, reassigned local, non-final/computed constant, param).
      recordUnresolvedSite('non-literal-dynamic', lc(call.method), callerClassLower, callerMethodLabel, call); // v0.13/H3
      return;
    }
    const ccm = classes.get(callerClassLower);
    for (const candidate of candidates) {
      const litValue = candidate.literal;
      // v0.11/B1(b): candidate.forcedVia ('ambiguous', set only by
      // resolveQualifiedConstantCandidates' ambiguous-bucket branch)
      // overrides the default 'dynamic' via below -- but the litValue
      // STILL goes through the exact same resolveType/resolveTypeStrict/
      // tryAttachExternalLiteral lookup as any other candidate. Which
      // Handler.NAME constant supplied this literal was the ambiguous
      // step (already resolved above); what class the literal VALUE itself
      // names is a completely separate question this lookup keeps
      // answering unchanged -- forcing the edge straight at the winning
      // Handler-bucket class itself here would be a different bug (the
      // literal's VALUE, e.g. 'FromA', names an unrelated class, not
      // 'Handler').
      // v0.11/B1(d): resolveType()'s tier-3 bare-LAST-SEGMENT-uniqueness
      // fallback is EXACTLY the mechanism N2/R1 already disabled for
      // ordinary receiver-text resolution (see resolveTypeStrict's own
      // header note and isUnknownNamespacedReceiver's use of it): a
      // literal VALUE like 'zenq.Billing' must not be allowed to alias
      // onto an unrelated local class merely because ITS bare tail
      // ('Billing') happens to collide with a local `Billing` class, so
      // plain resolveType() here silently produced a false ctor edge to
      // the WRONG class instead of falling through to the external node
      // the B1(d) CONTRACT text explicitly requires. A literal with no dot
      // (every (a)/(b)/(c) candidate) is unaffected -- resolveType's
      // bare-tail fallback is exactly the desired, pre-B1-unchanged
      // behavior for a plain class-name literal; only a DOTTED literal
      // (only ever reachable via (d)) needs the stricter, no-bare-tail
      // lookup before falling through to tryAttachExternalLiteral below.
      const targetLower = litValue.indexOf('.') === -1
        ? resolveType(litValue, ccm ? ccm.qualified : null)
        : resolveTypeStrict(litValue, ccm ? ccm.qualified : null);
      if (targetLower) {
        writeCtorEdge(callerClassLower, callerMethodLabel, targetLower, call, candidate.forcedVia || 'dynamic');
        continue;
      }
      // (d): unresolved locally -- try the namespace/external fallback
      // before giving up on this candidate (a literal matching NEITHER a
      // local class NOR a qualifying external is a genuine "no target"
      // outcome for that one candidate, same as the pre-existing single-
      // literal negative case -- no unresolvedSitesCount bump here,
      // mirroring that case's own "unknown class -> negative case" rule).
      tryAttachExternalLiteral(litValue, callerClassLower, callerMethodLabel, call);
    }
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
  // that object gets a via='publish' caller edge;
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
    const resolved = resolveDmlTargetObject(args[0], callerClassLower, mf);
    if (!resolved) return;
    const objectLower = resolved.lower;
    if (!objectLower.endsWith('__e')) return; // only platform events qualify
    recordPublishSite(objectLower, callerClassLower, callerMethodLabel, call);
    const triggers = triggersByObject.get(objectLower) || [];
    for (const t of triggers) {
      writeMethodEdge(callerClassLower, callerMethodLabel, lc(t.qualified), '(trigger)', call, 'publish', '(trigger)', null);
    }
    // v0.8/N1(b): "DML/publish targets" both funnel through
    // resolveDmlTargetObject's own N1(b) detection -- in practice this stays
    // inert for a genuine platform event (its object always ends '__e', and
    // N1(b)'s managed-object shape requires the token to end '__c'), but the
    // check is included here for the same reason it's unconditional in the
    // two DML call sites above: no special-casing needed either way.
    if (resolved.external) attachExternalDmlSite(resolved.external.ns, resolved.external.className, callerClassLower, callerMethodLabel, call);
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
      overloadPick: 'exact',
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
    if (!typeNameRaw) return; // unresolvable rethrow var -> skip
    const resolvedLower = resolveType(typeNameRaw, tf.qualified);
    const excKey = resolvedLower || normalizeTypeName(typeNameRaw);
    if (!excKey) return;
    const site = makeThrowSite(callerClassLower, callerMethodLabel, throwSiteFact, 'throws');
    if (!throwers.has(excKey)) throwers.set(excKey, []);
    throwers.get(excKey).push(site);
    // A3: forward-direction counterpart -- a throw site's own method gets a
    // terminal forward child pointing at the exception CLASS (never a
    // method -- targetKey is the bare classLower, no '#methodLower', which
    // is how buildCalleeTree tells a class-level (kind='exception') forward
    // target apart from an ordinary method target). Only recorded when the
    // thrown type resolves to an INDEXED user class (resolvedLower) -- an
    // unresolvable rethrow var already bailed out above, and
    // a resolved-but-external/platform exception type (bare normalized name
    // fallback, excKey with no matching ClassMeta) has no real node to show
    // as a forward target, so it's silently omitted here exactly the way an
    // unindexed 'new' constructor target already is (rule 1's own header
    // note: "not a known user class -> no edge").
    if (resolvedLower) {
      recordForwardEdge(callerClassLower, callerMethodLabel, {
        targetKey: resolvedLower,
        kind: 'throw',
        via: 'throws',
        line: throwSiteFact.line,
        col: throwSiteFact.col || 0,
        lineText: throwSiteFact.lineText,
        args: [],
        argsRendered: '',
        overloadSig: null,
        targetLabel: (classes.get(resolvedLower) || {}).name || typeNameRaw,
      });
    }
  }

  // =========================================================================
  // G3: instanceof narrowing (labeled fallback only)
  // =========================================================================

  // Called ONLY after declared-type resolution has already been tried and
  // failed for a simple-identifier receiver (see resolveDotOther) -- never
  // when declared-type resolution succeeds. For every
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
        writeMethodEdge(callerClassLower, callerMethodLabel, o.classLower, nameLower, call, 'narrowed', o.method.name, overloadSig, undefined, undefined, o.overloadPick, o.tiedOverloadSigs);
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
  // resolution. A qualifying call site is one whose
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
      return; // only one inline `new` argument is supported
    }
  }

  // ---- pass B: walk every parseable method's calls -----------------------
  for (const file of factsList || []) {
    // v0.13/H4: `cancelled` may already be true (latched during pass A) --
    // this stops pass B from ever starting in that case. Also re-checked
    // live here (pass B is the expensive one) so a cancellation signaled
    // partway through pass A but not yet observed there (shouldCancel()
    // wasn't re-polled between files) still gets caught at the top of the
    // next pass's own iteration.
    if (cancelled || (shouldCancel && shouldCancel())) { cancelled = true; break; }
    if (file.parseError) continue;
    for (const tf of file.types || []) {
      const qualifiedLower = lc(tf.qualified);
      // B2: resolve THIS exact (file, type) pair's own registration key via
      // classBuckets, instead of unconditionally re-deriving qualifiedLower
      // and skipping every type that "lost the race" (the pre-v0.7
      // behavior). Every type pass A registered -- primary AND duplicate
      // slots alike -- now gets its OWN calls walked under its OWN key, so
      // a duplicate class's outbound calls are no longer silently dropped
      // (they simply weren't reachable at all before B2 gave duplicates a
      // real identity). Matched by file path, mirroring the exact
      // disambiguation the old `cm.path !== file.path` check used.
      const bucket = classBuckets.get(qualifiedLower) || [];
      const entry = bucket.find((b) => b.cm.path === file.path);
      if (!entry) continue; // defensive: should always be found (pass A registers every type)
      const ownClassLower = entry.classLower;
      const cm = entry.cm;
      for (const mf of tf.methods || []) {
        const callerMethodLabel = mf.isCtor ? '<init>' : mf.name;
        // This method's callerKey is constant across all
        // three call/dml/throwsSites loops below -- hoisted so the
        // post-loop source-line sort (see methodStartLen below) can find
        // exactly the slice of methodCallees this ONE method contributed,
        // regardless of which of the three loops wrote it.
        const callerKeyStr = `${ownClassLower}#${lc(callerMethodLabel)}`;
        const methodStartLen = (methodCallees.get(callerKeyStr) || []).length;
        for (const call of mf.calls || []) {
          const beforeLen = (methodCallees.get(callerKeyStr) || []).length;
          lastReceiverDenylisted = false; // v0.7.1/R6: reset before every dispatch, see the flag's own header note
          resolveCall(ownClassLower, callerMethodLabel, mf, call);
          // F1/F4a/G1/G5: independent of ordinary dispatch above (see each
          // function's own header comment for why).
          handleDatabaseMethodDml(ownClassLower, callerMethodLabel, mf, call);
          handleTypeForName(ownClassLower, callerMethodLabel, mf, call);
          handleEventBusPublish(ownClassLower, callerMethodLabel, mf, call);
          handleAsyncHop(ownClassLower, callerMethodLabel, call);
          // A1/A6: this call site produced literally zero forward edges
          // (of ANY kind -- call/dml/publish/async) from ANY of the five
          // handlers above -- feeds buildCalleeTree's single aggregated
          // "N unresolved sites" leaf per method. Only ORDINARY 'dot'/'bare'
          // method-call attempts participate:
          //   - 'prop' (A2 property get/set access, e.g. an SObject field
          //     read/write like `ord.Acme_Status__c = 'Approved'`) is a
          //     completely different relationship from "calling something"
          //     -- resolvePropCall's own contract is silent-no-edge on a
          //     plain FIELD match (not a dropped/unresolved call at all),
          //     and even a genuinely unresolved receiver here was never a
          //     method-invocation attempt in the first place. Confirmed
          //     Three property accesses (one set, two nested gets inside a
          //     sendApprovalEmail call's own args) would otherwise inflate
          //     its forward children with a bogus "3 unresolved sites" leaf
          //     that a method-level call graph must not have.
          //   - 'new' is excluded for the SAME reason isNewSuppressedFromForward
          //     exists one level up: an unresolved 'new' target (e.g.
          //     `new Acme_Note__e(...)` -- a platform-event SObject, never
          //     an indexed Apex class) is a constructor-style fact, not an
          //     ordinary method-call attempt either. A publish path has
          //     exactly two children (trigger + flow), no
          //     unresolved leaf, despite the un-indexable inline
          //     `new Acme_Note__e(...)` argument sitting right there.
          const afterLen = (methodCallees.get(callerKeyStr) || []).length;
          // v0.7.1/R6: denylisted-receiver calls (System/Database/etc., incl.
          // the R2 declared-Type-typed variant) are EXCLUDED here, exactly
          // like the backward-direction unresolvedSitesCount already
          // excludes them -- see lastReceiverDenylisted's own header note.
          if (afterLen === beforeLen && (call.kind === 'dot' || call.kind === 'bare') && !lastReceiverDenylisted) {
            unresolvedForwardCounts.set(callerKeyStr, (unresolvedForwardCounts.get(callerKeyStr) || 0) + 1);
          }
        }
        // F1: statement-form DML.
        for (const dmlFact of mf.dml || []) {
          handleDmlStatement(ownClassLower, callerMethodLabel, mf, dmlFact);
        }
        // G2: throw-statement sites.
        for (const throwSiteFact of mf.throwsSites || []) {
          handleThrowSite(ownClassLower, callerMethodLabel, mf, throwSiteFact, tf);
        }
        // mf.calls[], mf.dml[], and mf.throwsSites[]
        // are processed as three SEPARATE loops above (call-graph edges,
        // DML/trigger fan-out, and exception fan-out are each their own
        // MethodFacts array with no shared iteration order), so the forward
        // edges just appended to methodCallees for THIS method are grouped
        // by which loop wrote them, not by true source-line position --
        // e.g. a method whose only DML statement sits before its only
        // ordinary call (source order) would otherwise show the call first.
        // Restore true source-line order (documented "ordered children
        // (source-line order)" contract, MANIFEST v0.7 chains #3 and #5)
        // by sorting just the slice this method contributed -- a stable
        // sort, so call sites that share an exact line (rare, but not
        // impossible for a one-line multi-call statement) keep their
        // original relative (loop) order.
        const methodEdges = methodCallees.get(callerKeyStr);
        if (methodEdges && methodEdges.length > methodStartLen) {
          const tail = methodEdges.slice(methodStartLen);
          tail.sort((a, b) => (a.line || 0) - (b.line || 0) || (a.col || 0) - (b.col || 0));
          methodEdges.splice(methodStartLen, tail.length, ...tail);
        }
      }
    }
  }

  // v0.13/H1(b) ATTACHMENT CAP finalization -- runs once, immediately after
  // pass B has walked every file, so uniqueNameAttachCounts now holds the
  // TRUE final count of unique-name attachments each target method
  // attracted (unresolvedFallback wrote every one of them OPTIMISTICALLY,
  // during pass B, exactly like pre-H1 behavior -- the cap could not have
  // been enforced any earlier, since the total for a target isn't knowable
  // until the LAST file that might still reference it has been seen). Any
  // target whose count exceeds UNIQUE_NAME_MAX gets EVERY one of its
  // unique-name attachments stripped back out here -- both the reverse-
  // direction CallSite (methodCallers) and the forward-direction ForwardEdge
  // (methodCallees) -- and returned to the unresolved bookkeeping, tagged
  // 'name-too-common'. Skipped entirely (loop body never runs) when
  // cancelled -- a cancelled build's methodCallers/methodCallees are already
  // partial and about to be discarded by the caller, so there is nothing
  // honest to finalize.
  if (!cancelled) {
    for (const [targetKey, count] of uniqueNameAttachCounts) {
      if (count <= UNIQUE_NAME_MAX) continue;
      const sites = methodCallers.get(targetKey) || [];
      const kept = [];
      const strippedCallerKeys = [];
      for (const site of sites) {
        if (site.via === 'unique-name') strippedCallerKeys.push(site.callerKey);
        else kept.push(site);
      }
      methodCallers.set(targetKey, kept);
      const hashIdx = targetKey.lastIndexOf('#');
      const nameLowerForTarget = targetKey.slice(hashIdx + 1);
      for (const callerKey of strippedCallerKeys) {
        const edges = methodCallees.get(callerKey) || [];
        const idx = edges.findIndex((e) => e.targetKey === targetKey && e.via === 'unique-name');
        if (idx !== -1) edges.splice(idx, 1);
        unresolvedForwardCounts.set(callerKey, (unresolvedForwardCounts.get(callerKey) || 0) + 1);
      }
      unresolvedSitesCount += strippedCallerKeys.length;
      unresolvedByReason['name-too-common'] += strippedCallerKeys.length;
      magnetSuppressedAttachments += strippedCallerKeys.length;
      if (!unresolvedSitesByName.has(nameLowerForTarget)) unresolvedSitesByName.set(nameLowerForTarget, []);
      const bucket = unresolvedSitesByName.get(nameLowerForTarget);
      // Re-derive each stripped site's own {callerClass, callerKey, path,
      // line, col, lineText} from the sites array we just filtered OUT of
      // `kept` above -- reusing the exact CallSite objects unresolvedFallback
      // already built (via makeCallSite) rather than reconstructing them.
      for (const site of sites) {
        if (site.via !== 'unique-name') continue;
        bucket.push({
          reason: 'name-too-common',
          callerClass: site.callerClass,
          callerKey: site.callerKey,
          path: site.path,
          line: site.line,
          col: site.col,
          lineText: site.lineText,
        });
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
    if (cancelled) break; // v0.13/H4
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
    if (cancelled) break; // v0.13/H4
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
    if (cancelled || (shouldCancel && shouldCancel())) { cancelled = true; break; } // v0.13/H4
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
        callerClass: callerLabel, // FileFacts.name is the callerClass identity.
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

  // B2: index.stats.duplicateNames -- count of DISTINCT qualified names with
  // more than one registered candidate, but ONLY surfaced when package
  // metadata was actually discovered (packageMetadataDiscovered,
  // not merely "opts.packageOf is a function" -- per B5's packageless-
  // identity guarantee: "NEITHER index.stats.duplicateNames nor any
  // via='ambiguous' edge is surfaced" when package metadata isn't
  // discoverable, and a live packageOf returning null for every path counts
  // as "not discoverable"). `duplicates` (the flat qualified-name list)
  // stays populated unconditionally either way -- it already existed
  // pre-v0.7 and its own meaning ("first-parsed file wins, this is who
  // lost") is unaffected by whether packages are known.
  let duplicateNamesCount = 0;
  if (packageMetadataDiscovered) {
    for (const bucket of classBuckets.values()) {
      if (bucket.length > 1) duplicateNamesCount++;
    }
  }

  // v0.13/H3: 'parse-fallback' is a FILE-granularity figure (one per file
  // that fell back to pass E's lexical scan), set once here directly from
  // parseFallbacks.length -- NOT incremented per-call-site like the other
  // four reasons (a parse-broken file has no CallFacts at all to walk), and
  // deliberately NOT folded into unresolvedSitesCount (that counter's
  // established meaning -- "call sites this build positively identified as
  // dropped" -- predates this diagnostics breakdown and stays call-site-only
  // for every existing consumer; engine facts
  // identical" bar).
  unresolvedByReason['parse-fallback'] = parseFallbacks.length;

  const result = {
    classes,
    methodCallers,
    classCallers,
    // A1: forward-direction adjacency, keyed exactly like methodCallers'
    // callerKey format (see makeCallSite) -- 'lowerQualified#lowerMethod' ->
    // ForwardEdge[]. Consumed by buildCalleeTree (below).
    methodCallees,
    // A1/A6: callerKey -> count of MethodFacts.calls entries that produced
    // zero forward edges -- buildCalleeTree folds this into one aggregated
    // "N unresolved sites" leaf per method.
    unresolvedForwardCounts,
    // v0.7.1/R8: callerKey -> count of DML statements/Database.xxx() calls
    // whose target reduced to the generic `SObject` placeholder --
    // buildCalleeTree folds this into a SEPARATE "DML on unresolved SObject
    // type" leaf per method (see recordUnresolvedDmlSite's own header note).
    unresolvedDmlForwardCounts,
    parseFallbacks,
    duplicates,
    // B2: qualifiedLower -> [{classLower, package, cm}] -- every type
    // sharing that qualified name (bucket length 1 for every non-duplicated
    // name). Exposed so callers (tests, and eventually targets.js/UI code
    // outside this file's ownership) can enumerate a duplicated name's
    // individual package-tagged candidates and build a `target` object
    // addressing ONE of them directly (its `classLower` is a real key into
    // `classes`).
    classBuckets,
    // A5: exposed so buildCalleeTree's interface-fan-out special case
    // (calleeInterfaceFanoutPairs, a top-level function outside this
    // closure) can look up an interface's implementers by simple name --
    // previously purely a buildSemanticIndex-internal lookup table, never
    // needed post-build until forward tracing.
    interfaceImplementers,
    // Exposed so calleeInterfaceFanoutPairs can order an
    // interface's implementer fan-out by construction-site order instead of
    // raw file-scan order -- see firstConstructedAt's own header note above.
    firstConstructedAt,
    dmlSitesByObject,
    publishSitesByObject,
    throwers,
    // v0.8/N1/N4: externals/externalCallers/externalForwardsByCallerKey --
    // see this closure's own "v0.8/N1/N2/N4: externals" header block above
    // for the full contract. Exposed so buildCallerTree's external-root
    // branch, buildCalleeTree's appendCalleeExtrasForMethod call, and
    // suggestTargets (below, all top-level functions outside this closure)
    // can reach them, and so attachMetaCallers (a SEPARATE top-level
    // function, called after this closure has already returned) can mutate
    // the SAME Map objects in place when it attaches N1(c) metascan-sourced
    // externals.
    externals,
    externalCallers,
    externalForwardsByCallerKey,
    // v0.8/N1(c): attachMetaCallers reads this to decide whether a metascan
    // ref's detected namespace token is the workspace's OWN namespace
    // (resolves locally, per N3) or a genuinely external one. null/absent
    // when opts.ownNamespace was absent/empty.
    ownNamespace: ownNamespaceLower,
    // H4: workspace-wide count of call sites this build positively
    // identified as dropped (see unresolvedSitesCount's own header comment
    // for the three counted categories). Every TreeResult carries this
    // through unchanged (see buildCallerTree's H4 stats passthrough) so the
    // UI can show one honest "N call sites workspace-wide could not be
    // resolved" header regardless of which target is being traced.
    // v0.8/N5: externalRefs/externalNamespaces gained here, computed fresh
    // from `externals`' current contents (see computeExternalStats's own
    // header note on why this is derived rather than a tracked counter) --
    // attachMetaCallers recomputes/overwrites both after it mutates
    // `externals` further, so this initial value is only ever "final" for a
    // build with no metascan refs attached afterward.
    stats: {
      unresolvedSites: unresolvedSitesCount,
      // v0.13/H3/H8: reason breakdown for the same unresolvedSites total --
      // see unresolvedByReason's own header note for exactly which category
      // each key covers and why 'parse-fallback' is file- not site-granular.
      unresolvedByReason,
      magnetSuppressedAttachments,
      duplicateNames: duplicateNamesCount,
      ...computeExternalStats(externals),
    },
    // v0.13/H3: nameLower -> unresolved-site records (see its own header
    // note above) -- exposed at the index root (not just under `stats`,
    // which is a plain counts/labels bag every TreeResult passes through
    // unchanged) so buildCallerTree's scoped caller-direction header can
    // look up ONE target method's own mentions directly.
    unresolvedSitesByName,
    // v0.13/H4: true only when opts.shouldCancel() fired during THIS build
    // -- classes/methodCallers/etc. above may be partial when this is true.
    // The host (extension.js) is expected to discard a cancelled index
    // rather than pass it to buildCallerTree/buildCalleeTree; every field on
    // this object still has a well-formed (if partial) shape either way, so
    // nothing downstream crashes even if that discipline is ever skipped.
    cancelled,
    // Exposed so post-build query-time code (suggestTargets,
    // below) can apply the SAME real B2 gate this closure used internally
    // -- true only once opts.packageOf actually resolved a non-null label
    // for at least one file, never merely because opts.packageOf was
    // passed as a function (see packageMetadataDiscovered's own header
    // note above).
    packageMetadataDiscovered,
    // v0.12/C1: exposed (previously an internal-only closure var, see the
    // opts.defaultPackage header note above) so a post-build query-time
    // function -- buildEntryCatalog, a top-level function outside this
    // closure -- can apply the exact same "only when != default package"
    // rule the Entry Point Catalog contract calls for, without needing its
    // own opts parameter (buildEntryCatalog(index) takes only the built
    // index, matching every other post-build query function in this file).
    // Purely additive; existing code paths do not depend on this field.
    defaultPackage,
  };
  refreshIndexDiagnostics(result);
  return result;
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
  if (classIsTest) return true; // Class-level isTest cascades.
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
// covers it in full, avoiding double-counting.
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

// =========================================================================
// A2: callee ("forward") direction pairs -- the SAME { site, targetMethodLower }
// shape methodLevelPairs/classLevelPairs produce for callers, so the shared
// walker (buildChildrenLevel/buildOneChildNode below) never has to know
// which direction it's in beyond a couple of explicit `direction` checks.
// Each ForwardEdge is ADAPTED into a CallSite-compatible `site` whose
// callerClass/callerMethod fields deliberately name the EDGE'S TARGET (the
// node this child represents), not a caller -- the shared walker only ever
// reads those fields generically to decide "what identity does this child
// represent", so re-purposing them this way lets grouping/cycle-detection/
// dedup/label-building work completely unmodified for either direction.
// =========================================================================

function calleeItemFromEdge(index, edge) {
  // A3: a class-level (no '#methodLower') target -- currently only the
  // throw-forward exception-class node. Flagged via `kindOverride` so
  // buildOneChildNode can short-circuit straight to a terminal 'exception'
  // TNode without trying (and failing) the ordinary ccm.methods lookup.
  if (edge.targetKey && edge.targetKey.indexOf('#') === -1) {
    const tcm = index.classes.get(edge.targetKey);
    return {
      kindOverride: 'exception',
      site: {
        callerClass: tcm ? tcm.qualified : edge.targetLabel || edge.targetKey,
        callerMethod: null,
        callerKey: `${edge.targetKey}#(exception)`,
        path: tcm ? tcm.path : '',
        line: 0,
        col: edge.col || 0,
        lineText: edge.lineText,
        args: edge.args || [],
        argsRendered: edge.argsRendered || '',
        via: edge.via,
        overloadSig: null,
      },
      targetMethodLower: null,
    };
  }
  let gClassLower = null;
  let gMethodLower = null;
  let resolvedCm = null;
  let resolvedMm = null;
  if (edge.targetKey) {
    const hashIdx = edge.targetKey.indexOf('#');
    gClassLower = edge.targetKey.slice(0, hashIdx);
    gMethodLower = edge.targetKey.slice(hashIdx + 1);
    resolvedCm = index.classes.get(gClassLower);
    resolvedMm = resolvedCm ? resolvedCm.methods.find((m) => lc(m.name) === gMethodLower) : null;
  }
  const isTriggerTarget = !!(resolvedCm && resolvedCm.kind === 'trigger');
  const displayMethodLabel = isTriggerTarget ? '(trigger)' : resolvedMm ? resolvedMm.name : gMethodLower || edge.targetLabel || '';
  return {
    site: {
      callerClass: resolvedCm ? resolvedCm.qualified : edge.targetLabel || '(unresolved)',
      callerMethod: displayMethodLabel,
      callerKey: edge.targetKey || `(unresolved)#${edge.line}~${edge.col}`,
      path: resolvedCm ? resolvedCm.path : '',
      // v0.7.1/U1: the rendered call-site line must be the EDGE's own
      // call-site line (the calling statement), not the resolved target
      // method's own declaration line -- using resolvedMm.line here made
      // every resolved callee-direction site row's line wrong (and collapsed
      // genuinely distinct call sites at different lines onto one identical,
      // incorrect line), breaking "click any call site to jump straight to
      // it" for every resolved forward edge.
      line: edge.line || 0,
      col: edge.col || 0,
      lineText: edge.lineText,
      args: edge.args || [],
      argsRendered: edge.argsRendered || '',
      via: edge.via,
      // v0.11/B2: carries the ForwardEdge's own approximate override
      // through to the callee-direction "site" shape buildOneChildNode
      // reads (see writeMethodEdge's own note) -- every pre-existing
      // ForwardEdge sets this false, so this is a no-op everywhere else.
      approximate: !!edge.approximate,
      overloadSig: edge.overloadSig || null,
    },
    targetMethodLower: gMethodLower,
  };
}

// A5: when classLower#methodLower identifies an INTERFACE method,
// forward-tracing it does NOT read methodCallees (an interface method has
// no body, so it never records any of its own outbound calls) -- instead it
// fans out to every implementer's same-name method, via='interface',
// mirroring the reverse direction's emitTypedOrInterfaceForClass fan-out
// (incl. H2's "satisfies the interface via an INHERITED method" walk-up).
// Returns null (not an interface, or no implementers) so the caller falls
// back to the ordinary calleeMethodLevelPairs lookup.
function calleeInterfaceFanoutPairs(index, classLower, methodLower) {
  const cm = index.classes.get(classLower);
  if (!cm || !cm.typeFacts || !cm.typeFacts.isInterface) return null;
  const implementers = (index.interfaceImplementers && index.interfaceImplementers.get(lc(cm.name))) || [];
  if (!implementers.length) return null;
  const out = [];
  implementers.forEach((implLower, scanIndex) => {
    let cur = implLower;
    const seen = new Set();
    let ownerCm = null;
    let ownerMm = null;
    while (cur && !seen.has(cur)) {
      seen.add(cur);
      const ccm = index.classes.get(cur);
      if (!ccm) break;
      const mm = ccm.methods.find((m) => lc(m.name) === methodLower);
      if (mm) {
        ownerCm = ccm;
        ownerMm = mm;
        break;
      }
      cur = ccm.extendsLower || null;
    }
    if (!ownerCm || !ownerMm) return;
    const ownerKey = ownerCm.classLower || lc(ownerCm.qualified);
    out.push({
      _implLower: implLower, // Sort key input only; stripped below.
      _scanIndex: scanIndex, // stable fallback when no construction site is known
      site: {
        callerClass: ownerCm.qualified,
        callerMethod: ownerMm.name,
        callerKey: `${ownerKey}#${methodLower}`,
        path: ownerCm.path,
        line: ownerMm.line,
        col: 0,
        lineText: '',
        args: [],
        argsRendered: '',
        via: 'interface',
        overloadSig: null,
      },
      targetMethodLower: methodLower,
    });
  });
  if (!out.length) return null;
  // Order the fan-out by each implementer's earliest known
  // `new ImplClass(...)` construction site in the codebase (file+line),
  // NOT by raw interfaceImplementers scan order -- see firstConstructedAt's
  // header note. An implementer with no known construction site anywhere
  // sorts after every implementer that does have one, keeping its original
  // relative scan order among its similarly-unconstructed peers.
  out.sort((a, b) => {
    const ca = index.firstConstructedAt && index.firstConstructedAt.get(a._implLower);
    const cb = index.firstConstructedAt && index.firstConstructedAt.get(b._implLower);
    if (ca && cb) {
      if (ca.path !== cb.path) return ca.path < cb.path ? -1 : 1;
      if (ca.line !== cb.line) return ca.line - cb.line;
      return a._scanIndex - b._scanIndex;
    }
    if (ca && !cb) return -1;
    if (!ca && cb) return 1;
    return a._scanIndex - b._scanIndex;
  });
  return out.map(({ _implLower, _scanIndex, ...rest }) => rest);
}

function calleeMethodLevelPairs(index, classLower, methodLower) {
  const ifacePairs = calleeInterfaceFanoutPairs(index, classLower, methodLower);
  if (ifacePairs) return ifacePairs.map((it) => Object.assign({}, it, { _edgeItem: true }));
  const edges = (index.methodCallees && index.methodCallees.get(`${classLower}#${methodLower}`)) || [];
  const out = [];
  for (const edge of edges) {
    // v0.7.1/R7: a forward call resolved through an interface-typed
    // receiver records its edge against the INTERFACE method's own
    // targetKey (see emitOwners' own header note on why forward tracing
    // collapses interface dispatch onto a single node at the call site).
    // Expanding that single node one hop further used to bury the actually
    // resolved implementer(s) two levels down, under a synthetic
    // non-call-site wrapper; they must show up as DIRECT children of the
    // calling method instead.
    // Detected here (rather than changed at record time) so every existing
    // ForwardEdge/methodCallees consumer is unaffected; only the CALLEE
    // TREE'S rendering of this one edge shape changes. The interface
    // method's own node is kept as one additional sibling (not a parent) --
    // "may appear ... not as a wrapper level" -- so both "dispatched
    // through this interface" and "here's who it actually reaches" survive.
    if (edge.via === 'interface' && edge.targetKey && edge.targetKey.indexOf('#') !== -1) {
      const hashIdx = edge.targetKey.indexOf('#');
      const ifaceClassLower = edge.targetKey.slice(0, hashIdx);
      const ifaceMethodLower = edge.targetKey.slice(hashIdx + 1);
      const ifaceCm = index.classes.get(ifaceClassLower);
      if (ifaceCm && ifaceCm.typeFacts && ifaceCm.typeFacts.isInterface) {
        const implPairs = calleeInterfaceFanoutPairs(index, ifaceClassLower, ifaceMethodLower);
        if (implPairs && implPairs.length) {
          out.push(Object.assign({}, calleeItemFromEdge(index, edge), { _edgeItem: true }));
          for (const ip of implPairs) out.push(Object.assign({}, ip, { _edgeItem: true }));
          continue;
        }
      }
    }
    out.push(Object.assign({}, calleeItemFromEdge(index, edge), { _edgeItem: true }));
  }
  return out;
}

// A2: class-level forward target (no specific method) -- union of every
// declared method's own OWN outbound edges (mirrors classLevelPairs'
// reverse-direction rollup shape), '<init>' included via a direct
// methodCallees lookup (ctor bodies can make calls too, e.g. this()/super()
// chaining aside -- an ordinary constructor body's OWN statements).
function calleeClassLevelPairs(index, classLower, cm) {
  const out = [];
  const seenNames = new Set();
  for (const m of cm.methods) {
    const nl = lc(m.name);
    if (seenNames.has(nl)) continue;
    seenNames.add(nl);
    out.push(...calleeMethodLevelPairs(index, classLower, nl));
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

// A2: callee-direction SiteView construction. Unlike shapeSites (which
// re-derives argsRendered against the METHOD BEING TRACED's own declared
// params -- correct for callers, where the traced method is the one
// RECEIVING the shown args), a callee child's argsRendered was already
// computed at RECORD time (writeMethodEdge/writeCtorEdge's
// renderArgsForTarget call, zipped against THAT CHILD's own declared
// params -- the correct target for a forward call site's args) and carries
// straight through from the adapted ForwardEdge (see calleeItemFromEdge).
function shapeCalleeSites(items) {
  return items.map(({ site }) => ({
    path: site.path,
    line: site.line,
    col: site.col,
    lineText: site.lineText,
    argsRendered: site.argsRendered || '',
    via: site.via,
    overloadSig: site.overloadSig || null,
  }));
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

// v0.10/A2: true when classLower's OWN class, or any ancestor reached via
// its extends chain, declares a non-ctor method named methodNameLower --
// the "declared, own OR inherited" test the VF method-ref attach gate
// (attachVfActionRef, below) needs. This is findDeclaredMethodRaw's
// own-then-ancestors walk (that helper lives inside buildSemanticIndex's
// closure, keyed off the live `classes` Map under construction) re-derived
// as a standalone, index.classes-keyed equivalent -- attachMetaCallers runs
// on an ALREADY-BUILT index, outside that closure, same "usable outside
// buildSemanticIndex's closure" reasoning resolveClassLowerSimple's own
// header note gives. An unindexed/unresolvable classLower (e.g. a VF
// controller/extensions class that doesn't exist in this workspace)
// answers false, never throws -- the attach gate treats that exactly like
// "doesn't declare it".
function classDeclaresMethod(index, classLower, methodNameLower) {
  if (!classLower || !index.classes.has(classLower)) return false;
  return !!walkExtendsChain(index, classLower, (cm) => {
    const methods = (cm.typeFacts && cm.typeFacts.methods) || [];
    return methods.some((mm) => !mm.isCtor && lc(mm.name) === methodNameLower) ? true : undefined;
  });
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
  finalizeFlowSubflowRefs(index); // v0.13/S2 -- see its own header note
  const maxDepth = clampInt(opts && opts.maxDepth, 1, MAX_DEPTH_CLAMP, DEFAULT_MAX_DEPTH); // v0.10/A3
  const maxNodes = clampInt(opts && opts.maxNodes, 1, MAX_NODES_CLAMP, DEFAULT_MAX_NODES); // v0.10/A3
  const { initialDepth, userExpandedKeys } = normalizeProgressiveOpts(opts, maxDepth); // P1
  const classLower = lc(target && target.classLower);
  const cm = index.classes.get(classLower);

  if (!cm) {
    // v0.8/N4: an EXTERNAL node IS a valid trace target in the callers
    // direction ("its callers are all local referencing sites — full normal
    // caller tree above them") -- checked only once the ordinary
    // index.classes lookup has already failed, so this can never shadow a
    // real local class (external keys are only ever created for a receiver/
    // DML-object/metascan-ref shape that has ALREADY failed local
    // resolution -- see tryAttachExternalTwoSegmentReceiver's own header
    // note -- so no key collision is structurally possible).
    const ext = index.externals instanceof Map ? index.externals.get(classLower) : null;
    if (ext) return buildExternalCallerTree(index, classLower, ext, opts);

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
      // A2: direction is now present on EVERY TreeResult (both directions,
      // incl. this not-found shell) -- purely additive, a brand-new field
      // no pre-v0.7 caller could have been reading.
      direction: 'callers',
      // H1/H4: stats still passed through even for a not-found target, so
      // callers can rely on TreeResult.stats always being present.
      stats: {
        nodes: 0, uniqueMethods: 0, capped: false,
        unresolvedSites: (index.stats && index.stats.unresolvedSites) || 0,
        metaUnresolved: (index.stats && index.stats.metaUnresolved) || 0,
        externalRefs: (index.stats && index.stats.externalRefs) || 0,
        externalNamespaces: (index.stats && index.stats.externalNamespaces) || [],
        frontierNodes: 0, // P1: additive -- a not-found shell has no nodes at all.
      },
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
  // B3 (reconciliation): uitree.shapeResult derives targetPackage from
  // treeResult.root.package REGARDLESS of direction ("the traced target IS
  // treeResult.root ... in both directions", per uitree.js's own header
  // note on shapeResult) -- buildCalleeTree already stamps this (see its
  // own root construction below), so buildCallerTree must too, or every
  // caller in the SAME package as the traced target would incorrectly grow
  // a badge (targetPackage staying undefined never matches any node's real
  // package, per packageBadge()'s `node.package === targetPackage` check).
  // This prevents same-package callers from growing redundant badges.
  if (cm.package != null) root.package = cm.package;

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
    // win for that shared caller: a thrower is shown as via='throws', not
    // via='new'.
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
  const ctx = {
    maxDepth, maxNodes, nodeCount: 1, capped: false, expandedKeys: new Set(), uniqueKeys: new Set(), direction: 'callers',
    initialDepth, userExpandedKeys, frontierNodes: 0, // P1
    showUnconfirmed: normalizeShowUnconfirmed(opts), // v0.13/H2
  };
  const queue = [];
  root.children = buildChildrenLevel(index, allPairs, 1, ancestorPath, classLower, excCtx, ctx, queue, root);
  while (queue.length) {
    // v0.13/H4: guards this outer BFS-expansion loop the same way the index
    // build's own outer passes are guarded -- an already-huge tree can still
    // have plenty of unexpanded frontier left when the user cancels.
    if (shouldCancelOpt(opts)) { ctx.capped = true; break; }
    const task = queue.shift(); // FIFO -> breadth-first across the whole tree
    task.node.children = buildChildrenLevel(index, task.pairs, task.depth, task.ancestorPath, task.targetClassLower, excCtx, ctx, queue, task.node);
  }

  // A6: fold in metadata callers (LWC/Aura/Flow/OmniScript/VF) attached via
  // attachMetaCallers(), as TERMINAL children alongside the Apex ones.
  const metaRefs = isTrigger ? [] : metaLevelPairs(index, classLower, methodLower);
  if (metaRefs.length && ctx.nodeCount < ctx.maxNodes) {
    const metaChildren = buildMetaChildren(index, metaRefs, ctx);
    ctx.nodeCount += countTNodes(metaChildren);
    root.children = root.children.concat(metaChildren).sort(sortTNodes);
  } else if (metaRefs.length) {
    ctx.capped = true;
    root.truncated = true; // v0.7.1/R5: root is the specific node whose (metadata) children were cut
  }

  // v0.13/H3: scoped caller-direction header info -- "K unresolved sites
  // elsewhere mention <method>(" -- root-level ONLY (mirrors metaRefs
  // above), and ONLY for a real METHOD target (never a class/trigger/
  // anonymous root, which has no single method name to match unresolved
  // call-site NAMES against). K is index.unresolvedSitesByName's entry for
  // this exact method name, length -- arity-agnostic by construction (see
  // that map's own header note in buildSemanticIndex). Rendered as ONE
  // additional, collapsed info node alongside the ordinary callers (not
  // folded into them, and never itself subject to H2's approximate-rollup
  // grouping, which only ever applies inside buildChildrenLevel) -- its own
  // children are the individual mention sites, so a user can inspect each
  // one without this file needing to know anything about how the host
  // actually renders a "collapsed" TreeItem. Static @AuraEnabled and
  // @InvocableMethod methods deliberately skip this name-only evidence:
  // LWC/Flow metadata identifies the owning class, while valid Apex
  // Class.method()/same-class bare calls were already resolved exactly. An
  // unrelated unknown instance receiver must not obscure those exact callers
  // with a workspace-wide common-name bucket.
  const targetMethodFacts = methodLower
    ? cm.methods.filter((m) => lc(m.name) === methodLower)
    : [];
  const canHaveNameOnlyCandidate = !targetMethodFacts.length || targetMethodFacts.some((m) => !isStaticMetadataBoundMethod(m));
  if (methodLower && canHaveNameOnlyCandidate && !isTrigger && !(isAnonymous && methodLower === '(anonymous)') && ctx.nodeCount < ctx.maxNodes) {
    const mentions = (index.unresolvedSitesByName && index.unresolvedSitesByName.get(methodLower)) || [];
    if (mentions.length) {
      const targetMm = cm.methods.find((m) => lc(m.name) === methodLower);
      const displayName = targetMm ? targetMm.name : methodLower;
      // The info node participates in the same hard maxNodes budget as the
      // rest of the trace. A framework-common name can have tens of
      // thousands of unresolved mentions; materializing all of them here
      // would defeat the cap this guard is meant to protect.
      const childBudget = Math.max(0, ctx.maxNodes - ctx.nodeCount - 1);
      const visibleMentions = mentions.slice(0, childBudget);
      const mentionChildren = visibleMentions.map((s) => ({
        label: s.callerClass, kind: 'class', className: s.callerClass, path: s.path, line: s.line,
        methodLower: null, entries: [], isTest: false, via: s.reason || 'unresolved',
        sites: [{ path: s.path, line: s.line, col: s.col, lineText: s.lineText, argsRendered: '' }],
        children: [], cyclic: false, truncated: true, approximate: true, seenElsewhere: false,
      }));
      const mentionsCapped = visibleMentions.length < mentions.length;
      const mentionsNode = {
        label: `${mentions.length} unresolved site${mentions.length === 1 ? '' : 's'} elsewhere mention ${displayName}( — potential unconfirmed callers`,
        kind: 'unresolved-mentions', className: '', path: '', line: 0, methodLower: null,
        entries: [], isTest: false, via: 'unresolved', sites: [],
        children: mentionChildren,
        cyclic: false, truncated: mentionsCapped, approximate: true, seenElsewhere: false,
        collapsibleState: 'collapsed', // consumed by extension.js/uitree.js, out of this file's own scope
      };
      ctx.nodeCount += 1 + mentionChildren.length;
      if (mentionsCapped) {
        ctx.capped = true;
        root.truncated = true;
      }
      root.children = root.children.concat([mentionsNode]);
    }
  }

  return {
    root,
    targetLabel: rootLabel,
    // H4: a resolved target with genuinely zero callers (both Apex and
    // metadata/flow) gets an honest info note instead of silently rendering
    // an empty tree.
    note: root.children.length === 0 ? ZERO_CALLER_NOTE : null,
    direction: 'callers', // A2: additive, see the not-found branch's own note above.
    stats: {
      nodes: ctx.nodeCount,
      uniqueMethods: ctx.uniqueKeys.size,
      capped: ctx.capped,
      unresolvedSites: (index.stats && index.stats.unresolvedSites) || 0,
      metaUnresolved: (index.stats && index.stats.metaUnresolved) || 0,
      externalRefs: (index.stats && index.stats.externalRefs) || 0,
      externalNamespaces: (index.stats && index.stats.externalNamespaces) || [],
      frontierNodes: ctx.frontierNodes, // P1: count of nodes rendered expandable:true (depth-frontier boundary, distinct from capped).
    },
  };
}

// v0.8/N4: caller-direction trace ROOTED AT an external node. Reuses the
// exact SAME level-1/recursive machinery an ordinary class/method root uses
// (buildChildrenLevel walking externalCallers' site list at level 1, then
// methodLevelPairs -- via each site's own callerKey -- for every level
// above that) so "full normal caller tree above them" falls out for free,
// with zero duplicated tree-walking logic. `key` is the external's own Map
// key ('nslower.classlower'); `ext` is its ExternalMeta.
function buildExternalCallerTree(index, key, ext, opts) {
  // v0.10/A3: only ever reached THROUGH buildCallerTree (not itself
  // exported), but clamps independently here too -- it re-derives
  // maxDepth/maxNodes from the SAME raw `opts` buildCallerTree received,
  // not from buildCallerTree's already-clamped local vars, so this is not
  // redundant.
  const maxDepth = clampInt(opts && opts.maxDepth, 1, MAX_DEPTH_CLAMP, DEFAULT_MAX_DEPTH);
  const maxNodes = clampInt(opts && opts.maxNodes, 1, MAX_NODES_CLAMP, DEFAULT_MAX_NODES);
  const { initialDepth, userExpandedKeys } = normalizeProgressiveOpts(opts, maxDepth); // P1
  const root = {
    label: ext.label, kind: 'external', className: ext.label, path: '', line: 0,
    methodLower: null,
    ns: ext.ns, // v0.8/N4: read directly by uitree.js's externalNamespace()/managedBadge()
    entries: [], isTest: false, via: null, sites: [], children: [],
    cyclic: false, truncated: false, approximate: false,
  };

  const apexSites = (index.externalCallers instanceof Map ? index.externalCallers.get(key) : null) || [];
  const pairs = apexSites.map((site) => ({ site, targetMethodLower: null }));

  const ctx = {
    maxDepth, maxNodes, nodeCount: 1, capped: false, expandedKeys: new Set(), uniqueKeys: new Set(), direction: 'callers',
    initialDepth, userExpandedKeys, frontierNodes: 0, // P1
    showUnconfirmed: normalizeShowUnconfirmed(opts), // v0.13/H2
  };
  const queue = [];
  root.children = buildChildrenLevel(index, pairs, 1, new Set(), key, null, ctx, queue, root);
  while (queue.length) {
    if (shouldCancelOpt(opts)) { ctx.capped = true; break; } // v0.13/H4
    const task = queue.shift();
    task.node.children = buildChildrenLevel(index, task.pairs, task.depth, task.ancestorPath, task.targetClassLower, null, ctx, queue, task.node);
  }

  // N1(c): metascan-sourced callers (LWC import/Flow actionName/CMDT value
  // referencing this SAME external) render exactly like buildCallerTree's
  // own root-level metaRefs fold-in -- TERMINAL children alongside the Apex
  // ones (an LWC/Flow/CMDT reference has no callers of its own to walk).
  const metaRefs = (index.externalMetaRefs instanceof Map ? index.externalMetaRefs.get(key) : null) || [];
  if (metaRefs.length && ctx.nodeCount < ctx.maxNodes) {
    const metaChildren = buildMetaChildren(index, metaRefs, ctx);
    ctx.nodeCount += countTNodes(metaChildren);
    root.children = root.children.concat(metaChildren).sort(sortTNodes);
  } else if (metaRefs.length) {
    ctx.capped = true;
    root.truncated = true;
  }

  return {
    root,
    targetLabel: ext.label,
    note: root.children.length === 0 ? ZERO_CALLER_NOTE : null,
    direction: 'callers',
    stats: {
      nodes: ctx.nodeCount,
      uniqueMethods: ctx.uniqueKeys.size,
      capped: ctx.capped,
      unresolvedSites: (index.stats && index.stats.unresolvedSites) || 0,
      metaUnresolved: (index.stats && index.stats.metaUnresolved) || 0,
      externalRefs: (index.stats && index.stats.externalRefs) || 0,
      externalNamespaces: (index.stats && index.stats.externalNamespaces) || [],
      frontierNodes: ctx.frontierNodes, // P1
    },
  };
}

// =========================================================================
// A2: buildCalleeTree -- "what does this method call?"
// =========================================================================
// Shares buildChildrenLevel/buildOneChildNode (the v0.6 DAG-memoization +
// fair maxNodes-cap walker) with buildCallerTree verbatim, parameterized by
// ctx.direction === 'callees' -- see those two functions' own header notes
// for exactly which branches differ. The pieces with NO callers-direction
// equivalent at all (DML/publish -> flow fan-out, the unresolved-call
// aggregate leaf) are bolted on afterward, once per node, the same way
// buildCallerTree already bolts on buildMetaChildren's metadata callers
// (new code, since there is nothing to fork there either -- forward tracing
// invented these relationships).
function buildCalleeTree(index, target, opts) {
  finalizeFlowSubflowRefs(index); // v0.13/S2 -- see its own header note
  const maxDepth = clampInt(opts && opts.maxDepth, 1, MAX_DEPTH_CLAMP, DEFAULT_MAX_DEPTH); // v0.10/A3
  const maxNodes = clampInt(opts && opts.maxNodes, 1, MAX_NODES_CLAMP, DEFAULT_MAX_NODES); // v0.10/A3
  const { initialDepth, userExpandedKeys } = normalizeProgressiveOpts(opts, maxDepth); // P1
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
      direction: 'callees',
      // v0.8/N4: an external node is TERMINAL in the callees direction --
      // "no source to recurse into" -- so this not-found shell (external
      // keys are never in index.classes) is exactly the right, unmodified
      // outcome for tracing "what does this external call"; no special
      // branch needed here the way buildCallerTree's not-found path needed
      // one for the OPPOSITE (callers) direction.
      stats: {
        nodes: 0, uniqueMethods: 0, capped: false,
        unresolvedSites: (index.stats && index.stats.unresolvedSites) || 0,
        metaUnresolved: (index.stats && index.stats.metaUnresolved) || 0,
        externalRefs: (index.stats && index.stats.externalRefs) || 0,
        frontierNodes: 0, // P1: additive -- a not-found shell has no nodes at all.
        externalNamespaces: (index.stats && index.stats.externalNamespaces) || [],
      },
    };
  }

  const isTrigger = cm.kind === 'trigger';
  const isAnonymous = cm.kind === 'anonymous';
  let methodLower = target && target.methodLower ? lc(target.methodLower) : null;
  if (isTrigger) methodLower = '(trigger)';

  // Root display shape is direction-agnostic -- identical logic to
  // buildCallerTree's own root construction (deliberately duplicated
  // rather than factored into a shared helper: the two functions' root
  // blocks are heavily compatibility-sensitive, and a shared-helper refactor
  // would add risk for no benefit. This
  // block has no direction-specific branches to share in the first place).
  let rootKind, rootLabel, rootLine, rootEntries, rootIsTest;
  if (isTrigger) {
    rootKind = 'trigger';
    rootLabel = cm.name;
    const mm = cm.methods.find((m) => lc(m.name) === '(trigger)');
    rootLine = mm ? mm.line : 0;
    rootEntries = mm ? mm.entries : [];
    rootIsTest = false;
  } else if (isAnonymous && methodLower === '(anonymous)') {
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
  if (cm.package != null) root.package = cm.package; // B3

  const ancestorPath = new Set(methodLower ? [`${classLower}#${methodLower}`] : []);
  // A2/G4: a trigger body's own top-level local-variable declarations (e.g.
  // `AcmeOrderTriggerHandler handler = new AcmeOrderTriggerHandler();`) are
  // parsed under a SEPARATE synthetic '(init)' scope, distinct from
  // '(trigger)' (the rest of the body) -- a pre-existing parser.js/
  // resolver.js convention. Forcing
  // methodLower to '(trigger)' alone (as buildCallerTree also does for
  // reverse-direction trigger targets) would silently miss the '(init)'-
  // bucketed `new AcmeOrderTriggerHandler()` edge. Forward tracing "the
  // trigger" is meant to show EVERYTHING the trigger file does, so a
  // trigger target unions BOTH scopes' own outbound edges, '(init)' first
  // (it always textually precedes the try/body per how triggers are
  // written) to preserve overall source-order.
  const pairs = isTrigger
    ? calleeMethodLevelPairs(index, classLower, '(init)').concat(calleeMethodLevelPairs(index, classLower, '(trigger)'))
    : methodLower
      ? calleeMethodLevelPairs(index, classLower, methodLower)
      : calleeClassLevelPairs(index, classLower, cm);

  // H1 (shared): same ctx shape buildCallerTree uses, direction:'callees'
  // is what buildChildrenLevel/buildOneChildNode key their few
  // direction-specific branches off. dmlByCallerKey/publishByCallerKey are
  // pre-indexed ONCE per buildCalleeTree call (not re-scanned per node) so
  // the DML/publish -> flow fan-out below stays O(1) per node instead of
  // O(objects) per node.
  const ctx = {
    maxDepth, maxNodes, nodeCount: 1, capped: false, expandedKeys: new Set(), uniqueKeys: new Set(),
    direction: 'callees',
    dmlByCallerKey: indexSitesByCallerKey(index.dmlSitesByObject),
    publishByCallerKey: indexSitesByCallerKey(index.publishSitesByObject),
    initialDepth, userExpandedKeys, frontierNodes: 0, // P1
    showUnconfirmed: normalizeShowUnconfirmed(opts), // v0.13/H2
  };
  const queue = [];
  root.children = buildChildrenLevel(index, pairs, 1, ancestorPath, classLower, null, ctx, queue, root);
  if (isTrigger) {
    appendCalleeExtras(index, root, classLower, '(init)', ctx);
    appendCalleeExtras(index, root, classLower, '(trigger)', ctx);
  } else {
    appendCalleeExtras(index, root, classLower, methodLower, ctx);
  }
  while (queue.length) {
    if (shouldCancelOpt(opts)) { ctx.capped = true; break; } // v0.13/H4
    const task = queue.shift(); // FIFO -> breadth-first across the whole tree, same as buildCallerTree
    task.node.children = buildChildrenLevel(index, task.pairs, task.depth, task.ancestorPath, task.targetClassLower, null, ctx, queue, task.node);
    // A1: DML/publish flow-fanout + the unresolved-call aggregate leaf are
    // computed PER NODE (unlike buildCallerTree's metaRefs folding, which
    // is root-only by pre-existing design -- see buildCallerTree's own
    // metaRefs comment) using THIS node's own identity, since forward
    // tracing keeps walking arbitrarily deep and every method along the
    // way can have its own DML/publish/unresolved-call facts.
    appendCalleeExtras(index, task.node, task.targetClassLower, task.node.methodLower, ctx);
  }

  return {
    root,
    targetLabel: rootLabel,
    note: root.children.length === 0 ? 'This method makes no traceable outbound calls.' : null,
    direction: 'callees',
    stats: {
      nodes: ctx.nodeCount,
      uniqueMethods: ctx.uniqueKeys.size,
      capped: ctx.capped,
      unresolvedSites: (index.stats && index.stats.unresolvedSites) || 0,
      metaUnresolved: (index.stats && index.stats.metaUnresolved) || 0,
      externalRefs: (index.stats && index.stats.externalRefs) || 0,
      externalNamespaces: (index.stats && index.stats.externalNamespaces) || [],
      frontierNodes: ctx.frontierNodes, // P1
    },
  };
}

// A1: objectLower -> [{callerClass, callerMethod, ...}] map (dmlSitesByObject/
// publishSitesByObject) re-indexed by callerKey ('classLower#methodLower')
// for O(1) per-node lookup in appendCalleeExtrasForMethod, instead of
// re-scanning every object's site list for every node in the tree.
function indexSitesByCallerKey(sitesByObject) {
  const out = new Map();
  if (!sitesByObject) return out;
  for (const [objectLower, entries] of sitesByObject) {
    for (const e of entries) {
      const key = `${lc(e.callerClass)}#${lc(e.callerMethod)}`;
      if (!out.has(key)) out.set(key, []);
      out.get(key).push({ objectLower, entry: e });
    }
  }
  return out;
}

// A1/A4: builds ONE TNode for a flow reached via a DML or EventBus.publish
// site -- mirrors buildFlowChildren's reverse-direction node shape
// (kind:'flow') but for the OPPOSITE relationship (this IS the flow being
// reached, not a caller list under it).
//
// v0.13/S2: pre-v0.13 this node was UNCONDITIONALLY truncated:true/
// children:[] -- "terminal in this direction" (A2). It is no longer
// hardcoded that way: when index/ctx are supplied and the flow has its own
// SUBFLOW children (index.flowGraph),
// those are walked forward here too (buildFlowCalleeChildren,
// includeApexTargets:false -- this root deliberately
// does NOT also expose its own direct apex actions, unlike a proper
// subflow-reached node one level down). A flow with zero subflow children
// (the pre-v0.13 norm for every existing fixture) is completely unaffected:
// `children` stays `[]` and `truncated` stays `true`, byte-identical to
// before. `index`/`ctx` are optional (3rd/4th args) purely so this
// function's pre-v0.13 unit-tested shape (2-arg call) still works.
function makeCalleeFlowNode(flow, via, siteEntry, index, ctx) {
  const node = {
    label: flow.label,
    kind: 'flow',
    className: '',
    methodLower: null,
    path: flow.path,
    line: flow.line,
    entries: [metaEntryLabel('flow')],
    isTest: false,
    via,
    sites: [{
      path: siteEntry.path,
      line: siteEntry.line,
      col: siteEntry.col,
      lineText: siteEntry.lineText,
      argsRendered: (siteEntry.args || []).join(', '),
      via,
      overloadSig: null,
    }],
    children: [],
    cyclic: false,
    truncated: true, // A2: pre-v0.13 default, preserved when there's nothing new to walk (see header note)
    // v0.11/B2: true only when the underlying DML site itself was a
    // narrowed-generic-DML edge (siteEntry.approximate -- see
    // recordDmlSite's own note); a 'publish' siteEntry (from
    // publishSitesByObject) never carries this field, so stays false,
    // byte-identical to the pre-B2 hardcoded value.
    approximate: siteEntry.approximate === true,
    seenElsewhere: false,
  };
  if (index && ctx) {
    const flowLower = lc(flow.label);
    const g = index.flowGraph instanceof Map ? index.flowGraph.get(flowLower) : null;
    if (g && g.children && g.children.length) {
      const cycleKey = `flow:${flowLower}`;
      if (ctx.expandedKeys.has(cycleKey)) {
        // Same flow reached via a second DML/publish site elsewhere in this
        // same forward trace -- DAG memoization applies exactly like an
        // ordinary method node's second occurrence. `truncated` is
        // explicitly flipped to false here (overriding this node's own
        // pre-v0.13 default a few lines up) to match the general
        // seenElsewhere convention every other node kind in this engine
        // uses (buildOneChildNode/buildOneFlowNode never combine
        // seenElsewhere with truncated:true -- 'truncated' means
        // specifically "a depth/node-count cap was hit", which is not what
        // happened here; leaving the pre-v0.13 default would misleadingly
        // co-imply "cap reached" on a node that was actually just deduped).
        node.seenElsewhere = true;
        node.truncated = false;
      } else {
        ctx.expandedKeys.add(cycleKey);
        ctx.uniqueKeys.add(cycleKey);
        const budget = { used: 0, limit: Math.max(0, ctx.maxNodes - ctx.nodeCount) };
        node.truncated = false;
        node.children = buildFlowCalleeChildren(index, flowLower, new Set([cycleKey]), ctx, node, budget, false);
      }
    }
  }
  return node;
}

// class-level target (methodLower null) -- union of extras across every
// declared method, mirroring calleeClassLevelPairs' own rollup shape.
function appendCalleeExtras(index, node, classLower, methodLower, ctx) {
  if (!methodLower) {
    const cm = index.classes.get(classLower);
    if (!cm) return;
    const seen = new Set();
    for (const m of cm.methods) {
      const nl = lc(m.name);
      if (seen.has(nl)) continue;
      seen.add(nl);
      appendCalleeExtrasForMethod(index, node, classLower, nl, ctx);
    }
    return;
  }
  appendCalleeExtrasForMethod(index, node, classLower, methodLower, ctx);
}

function appendCalleeExtrasForMethod(index, node, classLower, methodLower, ctx) {
  const callerKey = `${classLower}#${methodLower}`;
  const extras = [];

  // A1: DML -> record-triggered flow fan-out (the '(trigger)' half of the
  // same DML site already arrived as an ordinary methodCallees edge,
  // through the shared walker above -- writeMethodEdge/emitDmlTriggerEdges
  // records it with via='dml' pointing straight at the trigger's own
  // classLower#(trigger) key. This only adds the FLOW half, which needs
  // flow metadata that's only ever available via attachMetaCallers).
  const myDmlSites = ctx.dmlByCallerKey.get(callerKey) || [];
  for (const { objectLower, entry } of myDmlSites) {
    const flowRefs = (index.flowRefsByObject && index.flowRefsByObject.get(objectLower)) || [];
    for (const flow of flowRefs) {
      if (!flow.flowRecordTriggerType) continue; // platform-event flow -- handled by the publish branch below
      const matchOps = flowOpsForRecordTriggerType(flow.flowRecordTriggerType);
      if (!matchOps.includes(entry.op)) continue;
      extras.push(makeCalleeFlowNode(flow, 'dml', entry, index, ctx));
    }
  }

  // A4: EventBus.publish -> platform-event-triggered flow fan-out. Mirrors
  // the DML branch, but unconditional on op (a publish has none) and gated
  // on flowTriggerType==='PlatformEvent' instead of flowRecordTriggerType
  // (see metascan.js's own G1(b) note: the two fields are mutually
  // exclusive on a given flow ref).
  const myPublishSites = ctx.publishByCallerKey.get(callerKey) || [];
  for (const { objectLower, entry } of myPublishSites) {
    const flowRefs = (index.flowRefsByObject && index.flowRefsByObject.get(objectLower)) || [];
    for (const flow of flowRefs) {
      if (lc(flow.flowTriggerType) !== 'platformevent') continue;
      extras.push(makeCalleeFlowNode(flow, 'publish', entry, index, ctx));
    }
  }

  // v0.8/N4: external nodes are TERMINAL in the callees direction -- one
  // leaf per DISTINCT external referenced from THIS specific caller method
  // (grouped by external key, mirroring how the callers direction groups
  // multiple sites onto one external node -- see externalForwardsByCallerKey's
  // own header note in buildSemanticIndex for why this is a simple per-
  // callerKey extras list rather than routed through methodCallees/
  // calleeItemFromEdge).
  const myExternalSites = (index.externalForwardsByCallerKey && index.externalForwardsByCallerKey.get(callerKey)) || [];
  if (myExternalSites.length) {
    const extGroups = new Map();
    for (const es of myExternalSites) {
      if (!extGroups.has(es.key)) extGroups.set(es.key, []);
      extGroups.get(es.key).push(es);
    }
    for (const group of extGroups.values()) {
      const first = group[0];
      // v0.11/B1(d): a genuine syntactic ns.Class(...) call keeps via=
      // 'external'/approximate:false (N2: "a genuine namespace match is
      // exact, not a guess"); B1's literal-flow namespaced-external case
      // is the one other source of an externalForwardsByCallerKey entry,
      // and carries via='dynamic' instead (see attachExternalApexSite's
      // own note) -- APPROX_VIA-derived here exactly like every other
      // via-driven approximate computation in this file, so 'dynamic'
      // correctly reads as approximate:true.
      const nodeVia = first.via || 'external';
      extras.push({
        label: first.ext.label,
        kind: 'external',
        className: first.ext.label,
        methodLower: null,
        path: '',
        line: 0,
        ns: first.ext.ns,
        entries: [],
        isTest: false,
        via: nodeVia,
        sites: group.map((g) => ({
          path: g.path || '',
          line: g.line || 0,
          col: g.col || 0,
          lineText: g.lineText || '',
          argsRendered: (g.args || []).join(', '),
          via: g.via || 'external',
          overloadSig: null,
        })),
        children: [],
        cyclic: false,
        truncated: true, // permanently terminal -- no source to recurse into (N4), same convention buildOneChildNode's 'exception' branch uses
        approximate: APPROX_VIA.has(nodeVia),
        seenElsewhere: false,
      });
    }
  }

  // A6: unresolved-call aggregation -- exactly ONE leaf per method,
  // regardless of how many individual call sites contributed to the count.
  const unresolvedCount = (index.unresolvedForwardCounts && index.unresolvedForwardCounts.get(callerKey)) || 0;
  if (unresolvedCount > 0) {
    extras.push({
      label: `${unresolvedCount} unresolved site${unresolvedCount === 1 ? '' : 's'}`,
      kind: 'unresolved',
      className: '',
      methodLower: null,
      path: '',
      line: 0,
      entries: [],
      isTest: false,
      via: 'unresolved',
      sites: [],
      children: [],
      cyclic: false,
      truncated: true,
      approximate: true,
      seenElsewhere: false,
    });
  }

  // v0.7.1/R8: generic-typed DML aggregation -- one honest leaf per method
  // for every DML statement/Database.xxx() call whose target reduced to the
  // literal `SObject` placeholder instead of a concrete object (see
  // recordUnresolvedDmlSite's own header note). Deliberately a SEPARATE
  // leaf from the "N unresolved sites" one above -- this is a DML-target-
  // narrowing gap (no trigger linkage even attempted), not an ordinary
  // unresolved method call.
  const unresolvedDmlCount = (index.unresolvedDmlForwardCounts && index.unresolvedDmlForwardCounts.get(callerKey)) || 0;
  if (unresolvedDmlCount > 0) {
    extras.push({
      label: unresolvedDmlCount === 1 ? 'DML on unresolved SObject type' : `${unresolvedDmlCount} DML sites on unresolved SObject type`,
      kind: 'unresolved',
      className: '',
      methodLower: null,
      path: '',
      line: 0,
      entries: [],
      isTest: false,
      via: 'dml-unresolved',
      sites: [],
      children: [],
      cyclic: false,
      truncated: true,
      approximate: true,
      seenElsewhere: false,
    });
  }

  for (const extra of extras) {
    if (ctx.nodeCount >= ctx.maxNodes) {
      ctx.capped = true;
      node.truncated = true; // v0.7.1/R5: same node-specific truncation honesty as buildChildrenLevel's cap
      break;
    }
    // v0.13/S2: every pre-v0.13 extra shape is a genuine leaf (extra.children
    // is always []), so countTNodes(extra.children) was always 0 and this is
    // byte-identical to the old `ctx.nodeCount++` for every one of them. A
    // flow extra can now carry a real subflow-chain subtree underneath it
    // (see makeCalleeFlowNode) whose nodes were never otherwise folded into
    // ctx.nodeCount -- this reconciles it once, exactly like the root-level
    // metaRefs fold-in's own `ctx.nodeCount += countTNodes(metaChildren)`.
    ctx.nodeCount += 1 + countTNodes(extra.children);
    node.children.push(extra);
  }
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

// A6: method targets consult only metaMethodCallers[targetKey], keeping
// overload/method precision. Class targets use the complete per-class bucket:
// both class-only refs and method-specific refs are rolled up into the class
// lens, just as the Apex side unions callers of every declared method.
function metaLevelPairs(index, classLower, methodLower) {
  if (methodLower) {
    if (!index.metaMethodCallers) return [];
    return index.metaMethodCallers.get(`${classLower}#${methodLower}`) || [];
  }
  if (!index.metaCallers) return [];
  // A class-level Apex rollup already unions every declared method's Apex
  // callers. Do the same for non-Apex surfaces: include method-specific LWC,
  // Aura, Flow, OmniScript, and VF refs as well as class-only refs. Method
  // traces remain exact through metaMethodCallers above.
  return index.metaCallers.get(classLower) || [];
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
    case 'permissionset':
      return 'Permission Set Apex access';
    case 'profile':
      return 'Profile Apex access';
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
// v0.13/S2: `ctx` (optional, 3rd arg) is the SAME shared build context
// buildCallerTree/buildExternalCallerTree already thread through the rest of
// their walk -- needed here so a flow node's NEW subflow-PARENT children
// (buildFlowParentChildren) share the exact same cycle-guard/DAG-
// memoization/maxNodes-cap bookkeeping every other node in the tree uses.
// Omitted (every pre-v0.13 caller/test), this function's behavior is
// byte-identical to before: no ctx means no subflow expansion is attempted,
// so a plain flowObject-less flow keeps its pre-v0.13 empty `children`.
function buildMetaChildren(index, metaRefs, ctx) {
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
    } else if (first.kind === 'cmdt' && first.triggerAction) {
      const seenTriggers = new Set();
      for (const link of first.triggerAction.links || []) {
        if (!link || seenTriggers.has(link.triggerClassLower)) continue;
        const triggerCm = index.classes.get(link.triggerClassLower);
        if (!triggerCm) continue;
        seenTriggers.add(link.triggerClassLower);
        const triggerMethod = (triggerCm.methods || []).find((method) => lc(method.name) === '(trigger)');
        const site = link.site || {
          path: triggerCm.path || '',
          line: triggerMethod ? triggerMethod.line : 0,
          col: 0,
          lineText: '',
        };
        children.push({
          label: triggerCm.name,
          kind: 'trigger',
          className: triggerCm.qualified,
          methodLower: '(trigger)',
          path: triggerCm.path || '',
          line: triggerMethod ? triggerMethod.line : 0,
          entries: triggerMethod ? triggerMethod.entries : [],
          isTest: false,
          via: 'metadata',
          sites: [{
            path: site.path || triggerCm.path || '',
            line: site.line || 0,
            col: site.col || 0,
            lineText: site.lineText || '',
            argsRendered: '',
            via: 'metadata',
            overloadSig: null,
          }],
          children: [],
          cyclic: false,
          truncated: false,
          approximate: !!link.approximate,
          seenElsewhere: false,
        });
      }
      children.sort(sortTNodes);
    }
    const isAccessMetadata = first.kind === 'permissionset' || first.kind === 'profile';
    const edgeVia = isAccessMetadata ? 'access' : 'metadata';
    const node = {
      label: first.label,
      kind: first.kind,
      className: '',
      methodLower: null,
      path: first.path || '',
      line: first.line || 0,
      entries: first.kind === 'cmdt' && first.triggerAction
        ? [
          metaEntryLabel(first.kind),
          ...first.triggerAction.contexts.map((context) => `Trigger action: ${context.event}`),
        ]
        : [metaEntryLabel(first.kind)],
      isTest: false,
      via: edgeVia,
      sites: refs.map((r) => ({
        path: r.path || '',
        line: r.line || 0,
        col: 0,
        lineText: r.lineText || '',
        argsRendered: '',
        via: edgeVia,
        overloadSig: null,
      })),
      children,
      cyclic: false,
      truncated: false,
      approximate: false,
      seenElsewhere: false,
    };
    // v0.13/S2: this flow's own PARENT flows (the flows that invoke it as a
    // subflow), via='subflow' -- alongside (not replacing) the DML/publish
    // children just computed above. Requires `ctx` (see this function's own
    // header note); a flow with zero parents (index.flowGraph has no entry,
    // or an empty parents[]) is completely unaffected -- `node.children`
    // stays exactly what it already was, byte-identical to pre-v0.13.
    if (first.kind === 'flow' && ctx) {
      const flowLower = lc(first.label);
      const cycleKey = `flow:${flowLower}`;
      ctx.uniqueKeys.add(cycleKey);
      if (ctx.expandedKeys.has(cycleKey)) {
        // Structurally shouldn't happen for a root-level metaRefs fold-in
        // (metaRefs are already grouped by distinct (kind,label) above, and
        // nothing else registers a 'flow:' key before this point in a fresh
        // buildCallerTree/buildExternalCallerTree call) -- guarded
        // defensively anyway, same seenElsewhere convention every other
        // flow-chain node uses.
        node.seenElsewhere = true;
      } else {
        ctx.expandedKeys.add(cycleKey);
        const ancestorPath = new Set([cycleKey]);
        const budget = { used: 0, limit: Math.max(0, ctx.maxNodes - ctx.nodeCount) };
        const subflowChildren = buildFlowParentChildren(index, flowLower, ancestorPath, ctx, node, budget);
        node.children = node.children.concat(subflowChildren);
      }
    }
    out.push(node);
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
      // v0.11/B2: true only when EVERY DML site grouped onto this ONE
      // (caller, object, op) node is itself a narrowed-generic-DML site
      // (entry.approximate -- see recordDmlSite's own note); a 'publish'
      // entry (from publishSitesByObject) never carries this field, so
      // every publish-flow node stays false, byte-identical to before.
      approximate: items.every((e) => e.approximate === true),
    });
  }
  out.sort(sortTNodes);
  return out;
}

// =========================================================================
// v0.13/S2: flow-to-subflow chain recursion (both directions)
// =========================================================================
// Cycle-guard/DAG-memoization/maxNodes-cap semantics mirror buildOneChildNode/
// buildChildrenLevel, keyed by 'flow:'+flowLower (a namespace disjoint from the
// 'classLower#methodLower' keys ordinary Apex nodes use, so the two schemes
// share one ancestorPath Set / ctx.expandedKeys Map safely without collision
// risk). Unlike ordinary Apex nodes, flow-chain recursion is NOT bounded by
// ctx.maxDepth. DAG memoization, seenElsewhere, and maxNodes cap the walk;
// a flow chain's own bound is cycle-guard + the shared node-count cap below.
//
// `budget` ({used, limit}) is a per-fold-in-call soft cap used ONLY to stop
// runaway construction early (checked against the REMAINING ctx.maxNodes
// headroom at the moment this fold-in started) -- it never writes
// ctx.nodeCount directly. The caller (buildMetaChildren's flow branch /
// makeCalleeFlowNode) reconciles ctx.nodeCount ONCE, via countTNodes over the
// finished subtree, exactly like the pre-existing metaRefs fold-in already
// does for its own (non-flow-chain) children -- this avoids double-counting
// the same nodes once via `budget` and again via that post-hoc countTNodes
// call.
function buildOneFlowNode(index, flowLower, ancestorPath, ctx, direction, budget) {
  const info = (index.flowInfo instanceof Map ? index.flowInfo.get(flowLower) : null) || { label: flowLower, path: '', line: 0 };
  const cycleKey = `flow:${flowLower}`;
  const node = {
    label: info.label, kind: 'flow', className: '', methodLower: null,
    path: info.path || '', line: info.line || 0,
    entries: [metaEntryLabel('flow')], isTest: false,
    // A subflow edge is a declared reference, not a fan-out guess.
    via: 'subflow', sites: [], children: [],
    cyclic: false, truncated: false, approximate: false, seenElsewhere: false,
  };
  ctx.uniqueKeys.add(cycleKey);
  if (ancestorPath.has(cycleKey)) {
    node.cyclic = true;
    return node;
  }
  if (ctx.expandedKeys.has(cycleKey)) {
    node.seenElsewhere = true;
    return node;
  }
  ctx.expandedKeys.add(cycleKey);
  // v0.13/S2 CAP FIX: this node's own budget unit is consumed HERE, BEFORE
  // recursing into its own children -- not by the caller (buildFlowParentChildren/
  // buildFlowCalleeChildren) after this call returns. A depth-first recursive
  // call only returns once its ENTIRE subtree is built, so incrementing
  // `budget.used` only on return would never let a long NON-branching chain
  // (one parent/child per level) observe its own accumulated depth
  // mid-descent -- only
  // BRANCHING (multiple parents/children at the same level) would ever see
  // an updated count. Incrementing here means every level of a pure linear
  // chain re-checks the SAME shared `budget` object one level further along,
  // so a long chain is bounded by maxNodes exactly like a wide fan-out is.
  budget.used++;
  const nextPath = new Set(ancestorPath);
  nextPath.add(cycleKey);
  if (direction === 'caller') {
    // "alongside (not replacing) any pre-existing DML/publish children,
    // which stay attached to whichever flow owns the <start> block that
    // produced them" -- identical gating to buildMetaChildren's own
    // flowObject/flowTriggerType branch above, just re-run per ancestor
    // flow instead of only at the metaRef root.
    let dmlChildren = [];
    if (info.flowObject && lc(info.flowTriggerType) === 'platformevent') {
      dmlChildren = buildFlowChildren(index, lc(info.flowObject), 'publish', null);
    } else if (info.flowObject && info.flowRecordTriggerType) {
      dmlChildren = buildFlowChildren(index, lc(info.flowObject), 'dml', flowOpsForRecordTriggerType(info.flowRecordTriggerType));
    }
    budget.used += countTNodes(dmlChildren);
    const subflowChildren = buildFlowParentChildren(index, flowLower, nextPath, ctx, node, budget);
    node.children = dmlChildren.concat(subflowChildren);
  } else {
    // Callee direction: a proper subflow node (reached via a 'subflow'
    // edge, unlike the DML/publish-reached root) exposes its own Apex actions
    // in addition to its own further subflows.
    node.children = buildFlowCalleeChildren(index, flowLower, nextPath, ctx, node, budget, true);
  }
  return node;
}

// Caller direction: builds one TNode per PARENT flow of flowLower (the
// flows that invoke it as a subflow), via='subflow'. Mirrors
// buildChildrenLevel's own maxNodes-cap-with-ownerNode-truncation pattern,
// scoped to `budget` instead of ctx.nodeCount directly (see the header note
// above this section for why).
function buildFlowParentChildren(index, flowLower, ancestorPath, ctx, ownerNode, budget) {
  const g = index.flowGraph instanceof Map ? index.flowGraph.get(flowLower) : null;
  const parents = g ? g.parents : [];
  const out = [];
  for (const parentLower of parents) {
    if (budget.used >= budget.limit) {
      ctx.capped = true;
      if (ownerNode) ownerNode.truncated = true;
      break;
    }
    // buildOneFlowNode consumes its OWN budget unit internally (see its own
    // header note) -- no `budget.used++` needed here.
    out.push(buildOneFlowNode(index, parentLower, ancestorPath, ctx, 'caller', budget));
  }
  out.sort(sortTNodes);
  return out;
}

// Terminal TNode for one of a Flow's outgoing Apex-action targets.
// via='metadata' is the same declared reference buildMetaChildren renders in
// reverse; 'subflow' remains reserved for Flow-to-Flow edges.
function buildFlowApexTargetNode(index, target) {
  const ccm = index.classes.get(target.classLower);
  const mm = ccm && target.methodLower ? ccm.methods.find((m) => lc(m.name) === target.methodLower) : null;
  const label = ccm
    ? (target.methodLower ? `${ccm.name}.${mm ? mm.name : target.methodLower}` : ccm.name)
    : target.classLower;
  return {
    label,
    kind: target.methodLower ? 'method' : 'class',
    className: ccm ? ccm.qualified : target.classLower,
    methodLower: target.methodLower || null,
    path: ccm ? ccm.path : '',
    line: mm ? mm.line : 0,
    entries: mm ? mm.entries : (ccm ? ccm.entries : []),
    isTest: mm ? mm.isTest : !!(ccm && ccm.isTest),
    via: 'metadata',
    sites: [],
    children: [],
    // Terminal by design, same convention buildMetaChildren's own flow node
    // and the DML/publish flow-fanout nodes already use for a metadata-
    // declared (not syntactic-call) edge: forward tracing stops at the Apex
    // action. What that method itself calls is a
    // separate ordinary trace, not part of this flow-chain walk.
    cyclic: false, truncated: true, approximate: false, seenElsewhere: false,
  };
}

// Callee direction: builds a flow node's forward children -- its own
// apex-action targets (only when `includeApexTargets`; the DML/publish root does not get
// this) plus its own SUBFLOW children (always, via buildOneFlowNode
// recursion), in that order.
function buildFlowCalleeChildren(index, flowLower, ancestorPath, ctx, ownerNode, budget, includeApexTargets) {
  const out = [];
  if (includeApexTargets) {
    const targets = (index.flowApexTargets instanceof Map ? index.flowApexTargets.get(flowLower) : null) || [];
    for (const t of targets) {
      if (budget.used >= budget.limit) {
        ctx.capped = true;
        if (ownerNode) ownerNode.truncated = true;
        return out;
      }
      out.push(buildFlowApexTargetNode(index, t));
      budget.used++;
    }
  }
  const g = index.flowGraph instanceof Map ? index.flowGraph.get(flowLower) : null;
  const childFlows = g ? g.children : [];
  for (const childLower of childFlows) {
    if (budget.used >= budget.limit) {
      ctx.capped = true;
      if (ownerNode) ownerNode.truncated = true;
      return out;
    }
    // buildOneFlowNode consumes its OWN budget unit internally (see its own
    // header note) -- no `budget.used++` needed here.
    out.push(buildOneFlowNode(index, childLower, ancestorPath, ctx, 'callee', budget));
  }
  return out;
}

// v0.8/N1(c): given a metascan MetaRef and the (lowercased) own-namespace
// token, detects whether this ref names a namespace -- normally via the
// EXPLICIT `namespace` field metascan.js now populates for ALL ref kinds
// (LWC, Flow, CMDT, os-meta; metascan superseded the
// older LWC-only split), with the shape-inference branches below kept as a
// defensive fallback for refs from any older/partial extraction -- and,
// if so, whether that namespace IS the workspace's own (isOwn:true, per N3:
// resolves locally, stripped) or a genuinely foreign managed package
// (isOwn:false: external, per N1(c)). Returns null when the ref carries no
// namespace signal at all -- callers' pre-v0.8 default local-attach path is
// then completely unchanged, byte-for-byte.
function detectMetaRefNamespace(ref, ownNamespaceLower) {
  if (ref.namespace) {
    const isOwn = !!ownNamespaceLower && lc(ref.namespace) === ownNamespaceLower;
    return { ns: ref.namespace, className: ref.className, methodName: ref.methodName || null, isOwn };
  }
  // Pattern A ("dotted fold-in"): a 3-dot-segment actionName (e.g. a Flow's
  // 'zenq.KappaGateway.dispatch') that metascan.js's naive last-two-segments
  // split folds into { className:'zenq', methodName:'KappaGateway.dispatch' }
  // -- the methodName's OWN embedded dot is the tell that this className is
  // really a namespace prefix, not the actual class.
  if (ref.methodName && ref.methodName.indexOf('.') !== -1 && SIMPLE_IDENT_RE.test(ref.className || '')) {
    const dotIdx = ref.methodName.indexOf('.');
    const candClass = ref.methodName.slice(0, dotIdx);
    const candMethod = ref.methodName.slice(dotIdx + 1);
    if (SIMPLE_IDENT_RE.test(candClass) && candMethod) {
      const isOwn = !!ownNamespaceLower && lc(ref.className) === ownNamespaceLower;
      return { ns: ref.className, className: candClass, methodName: candMethod, isOwn };
    }
  }
  // Pattern B ("double-underscore fold-in"): a bare 'ns__ClassName' actionName/
  // CMDT value (no dot at all -- an Invocable-style bare class reference).
  // Excludes anything ending in '__c' -- the ordinary custom-OBJECT-API-name
  // shape (e.g. this corpus's pre-existing 'Kappa_Order__c' CMDT value,
  // which is NOT a class reference at all and must keep its exact pre-v0.8
  // fate: an inert local attach under a classLower nothing ever traces).
  if (!ref.methodName && ref.className && !/__c$/i.test(ref.className)) {
    const split = splitNamespacePrefix(ref.className);
    if (split) {
      const isOwn = !!ownNamespaceLower && lc(split.ns) === ownNamespaceLower;
      return { ns: split.ns, className: split.rest, methodName: null, isOwn };
    }
  }
  return null;
}

// Resolver support for Visualforce method bindings.
// metascan.js extracts the corresponding references (see its header comment
// block above extractVf/extractVfActionBinding) emits a SECOND 'vf' MetaRef
// shape, one per `action="{!singleIdentifier}"` binding, alongside the
// pre-existing class-level controller=/extensions= refs it has always
// produced:
//
//   { kind:'vf', label, className:null, methodName:<single identifier>,
//     line, lineText, controllerClass:string|null, extensionClasses:string[] }
//
// className is null -- metascan has no class index and cannot decide (nor
// tries to) which of the page's controller/extensions classes actually
// declares this method; that decision is made HERE. controllerClass/
// extensionClasses are the SAME controller=/extensions= facts restamped
// directly onto this ref (not requiring a cross-reference against other
// refs sharing the same `label`, which would be fragile -- two distinct
// pages can share a file stem, and ordering across a metaRefs array built
// from multiple scans/files is not a contract this file can rely on).
// controllerClass is null for a standardController-only page (no
// controller=/extensions= at all); extensionClasses is [] when extensions=
// is absent/empty (or the tag is `apex:component`, which has no
// extensions= attribute at all).
function attachVfActionRef(index, ref, metaCallers, metaMethodCallers) {
  const methodLower = lc(ref.methodName);
  const rawCandidates = [];
  if (ref.controllerClass) rawCandidates.push(ref.controllerClass);
  for (const ext of ref.extensionClasses || []) rawCandidates.push(ext);

  // Dedup case-insensitively (controller/extensions attributes are bare
  // class names, no namespace-qualification to worry about here -- same
  // "just lc() it" convention the pre-existing class-level 'vf' attach
  // already uses, see the classLower derivation a few lines below this
  // function's own call site).
  const seenLower = new Set();
  const candidates = [];
  for (const raw of rawCandidates) {
    const classLower = lc(raw);
    if (seenLower.has(classLower)) continue;
    seenLower.add(classLower);
    candidates.push(classLower);
  }
  // No controller AND no extensions declared at all (e.g. a
  // standardController-only page) -- there is nothing to attach to at any
  // level. This is a literal "no edge possible" case: the ref is dropped,
  // page's own (nonexistent) class-level 'vf' refs already have today.
  if (!candidates.length) return;

  const declaring = candidates.filter((classLower) => classDeclaresMethod(index, classLower, methodLower));

  if (declaring.length === 1) {
    // Exactly one of the page's controller/extensions classes declares this
    // method (own or inherited) -- attach a METHOD-level ref to THAT class.
    // May be an extension, not the controller (the "extension not
    // controller. Whichever class actually declares it wins, with no
    // controller-first tie-break needed since
    // there IS no tie here. Mirrors the generic local-attach pattern exactly:
    // register it in the complete per-class bucket and in the exact
    // metaMethodCallers[class#method] bucket.
    const classLower = declaring[0];
    if (!metaCallers.has(classLower)) metaCallers.set(classLower, []);
    metaCallers.get(classLower).push(ref);
    const key = `${classLower}#${methodLower}`;
    if (!metaMethodCallers.has(key)) metaMethodCallers.set(key, []);
    metaMethodCallers.get(key).push(ref);
    return;
  }

  // Zero matches ("matches no class", v0.10-B1 L13) or more than one match
  // ("ambiguous, declared on both", v0.10-B1 L7) -- no principled way to
  // pick a single method-level target, so:
  // class-level ref to the CONTROLLER only (never an extension -- there's
  // no basis to prefer one extension over another either), with NO method
  // fabricated. Register a stripped copy (methodName:null), preserving the
  // distinction from an exact method binding even though class-level traces
  // now roll up exact method refs too. Per v0.10-B1's own framing this
  // "contributes no NEW edge" when
  // the page already has an ordinary controller= class-level ref (both
  // collapse onto the same metaCallers[controllerLower] list, rendered as
  // one grouped TNode by buildMetaChildren's own (kind,label) grouping).
  if (!ref.controllerClass) return; // no controller to fall back to
  const controllerLower = lc(ref.controllerClass);
  const classLevelRef = Object.assign({}, ref, { className: ref.controllerClass, methodName: null });
  if (!metaCallers.has(controllerLower)) metaCallers.set(controllerLower, []);
  metaCallers.get(controllerLower).push(classLevelRef);
}

// Trigger Actions Framework (TAF) metadata join. The framework deliberately
// hides the executable relationship behind two Custom Metadata records:
// Trigger_Action__mdt names an Apex class and points to a context-specific
// sObject_Trigger_Setting__mdt record; that setting supplies the object whose
// trigger calls MetadataTriggerHandler.run(). Detect the relationship by its
// field schema AND the class's TriggerAction.<Context> interface, rather than
// treating every identifier-shaped CMDT value as a trigger configuration.
const TRIGGER_ACTION_CONTEXTS = [
  { fieldSuffix: 'before_insert__c', event: 'before insert', iface: 'beforeinsert', method: 'beforeInsert' },
  { fieldSuffix: 'after_insert__c', event: 'after insert', iface: 'afterinsert', method: 'afterInsert' },
  { fieldSuffix: 'before_update__c', event: 'before update', iface: 'beforeupdate', method: 'beforeUpdate' },
  { fieldSuffix: 'after_update__c', event: 'after update', iface: 'afterupdate', method: 'afterUpdate' },
  { fieldSuffix: 'before_delete__c', event: 'before delete', iface: 'beforedelete', method: 'beforeDelete' },
  { fieldSuffix: 'after_delete__c', event: 'after delete', iface: 'afterdelete', method: 'afterDelete' },
  { fieldSuffix: 'after_undelete__c', event: 'after undelete', iface: 'afterundelete', method: 'afterUndelete' },
];

function cmdtFieldEndsWith(ref, suffix) {
  return !!(ref && ref.kind === 'cmdt' && lc(ref.fieldName || '').endsWith(lc(suffix)));
}

function cmdtRefValue(ref) {
  if (!ref) return '';
  return ref.namespace ? `${ref.namespace}__${ref.className || ''}` : String(ref.className || '');
}

function cmdtRecordName(label) {
  const value = String(label || '');
  const dot = value.indexOf('.');
  return dot === -1 ? value : value.slice(dot + 1);
}

function canonicalTriggerObject(index, rawObject) {
  let value = String(rawObject || '').trim();
  const ownNamespace = lc(index && index.ownNamespace);
  if (ownNamespace) {
    const split = splitNamespacePrefix(value);
    if (split && lc(split.ns) === ownNamespace) value = split.rest;
  }
  return lc(value);
}

function classImplementsTriggerActionContext(cm, context) {
  if (!cm || !context) return false;
  return (cm.implementsTypes || []).some((raw) => {
    const segments = normalizeTypeName(raw).split('.');
    return segments.length >= 2 &&
      segments[segments.length - 2] === 'triggeraction' &&
      segments[segments.length - 1] === context.iface;
  });
}

// Returns the trigger-source call that proves the canonical dispatcher is
// present, or null. Raw parser facts remain available on ClassMeta.typeFacts
// even when MetadataTriggerHandler comes from an installed package and
// therefore cannot resolve as an ordinary local Apex edge.
function metadataTriggerDispatcherSite(triggerCm) {
  const methods = (triggerCm && triggerCm.typeFacts && triggerCm.typeFacts.methods) || [];
  for (const method of methods) {
    const calls = method.calls || [];
    const constructed = calls.some((call) =>
      call && call.kind === 'new' && lastSegmentLower(call.method) === 'metadatatriggerhandler'
    );
    const handlerLocals = new Set(
      (method.locals || [])
        .filter((local) => lastSegmentLower(local.type) === 'metadatatriggerhandler')
        .map((local) => lc(local.name))
    );
    const run = calls.find((call) => {
      if (!call || lc(call.method) !== 'run') return false;
      const receiver = lc(call.receiver || '');
      return receiver.includes('metadatatriggerhandler') || handlerLocals.has(receiver) || constructed;
    });
    if (run) return run;
  }
  return null;
}

function annotateTriggerActionMetadata(index, metaRefs) {
  const cmdtRefs = (metaRefs || []).filter((ref) => ref && ref.kind === 'cmdt');
  if (!cmdtRefs.length || !(index.classes instanceof Map)) return;

  const groups = new Map();
  for (const ref of cmdtRefs) {
    const key = lc(ref.label);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(ref);
  }

  // Setting record lookup accepts both the complete Type.Record label and
  // the relationship value's ordinary Record-only form.
  const settings = new Map();
  for (const refs of groups.values()) {
    const objectRef = refs.find((ref) => cmdtFieldEndsWith(ref, 'object_api_name__c'));
    if (!objectRef) continue;
    const namespaceRef = refs.find((ref) => cmdtFieldEndsWith(ref, 'object_namespace__c'));
    const bareObject = cmdtRefValue(objectRef);
    const namespace = namespaceRef ? cmdtRefValue(namespaceRef) : '';
    const objectApiName = namespace && !lc(bareObject).startsWith(`${lc(namespace)}__`)
      ? `${namespace}__${bareObject}`
      : bareObject;
    const bypassed = refs.some((ref) =>
      cmdtFieldEndsWith(ref, 'bypass_execution__c') && lc(cmdtRefValue(ref)) === 'true'
    );
    const setting = { objectApiName, refs, bypassed };
    settings.set(lc(refs[0].label), setting);
    settings.set(lc(cmdtRecordName(refs[0].label)), setting);
  }

  for (const refs of groups.values()) {
    const classRef = refs.find((ref) => cmdtFieldEndsWith(ref, 'apex_class_name__c'));
    if (!classRef) continue;
    const bypassed = refs.some((ref) =>
      cmdtFieldEndsWith(ref, 'bypass_execution__c') && lc(cmdtRefValue(ref)) === 'true'
    );
    if (bypassed) continue;

    const classLower = lc(classRef.className);
    const cm = index.classes.get(classLower);
    if (!cm) continue;
    const contexts = [];
    const links = [];
    for (const context of TRIGGER_ACTION_CONTEXTS) {
      const relationRef = refs.find((ref) => cmdtFieldEndsWith(ref, context.fieldSuffix));
      if (!relationRef || !classImplementsTriggerActionContext(cm, context)) continue;
      const settingValue = cmdtRefValue(relationRef);
      const setting = settings.get(lc(settingValue)) || settings.get(lc(cmdtRecordName(settingValue)));
      if (!setting || !setting.objectApiName || setting.bypassed) continue;
      const objectLower = canonicalTriggerObject(index, setting.objectApiName);
      const candidates = [];
      for (const triggerCm of index.classes.values()) {
        if (!triggerCm || triggerCm.kind !== 'trigger' || !triggerCm.triggerInfo) continue;
        if (canonicalTriggerObject(index, triggerCm.triggerInfo.object) !== objectLower) continue;
        if (!(triggerCm.triggerInfo.events || []).map(lc).includes(context.event)) continue;
        candidates.push({ triggerCm, dispatcherSite: metadataTriggerDispatcherSite(triggerCm) });
      }
      const proven = candidates.filter((candidate) => candidate.dispatcherSite);
      // A canonical dispatcher call is exact. Without one, only a single
      // object/event trigger is safe enough to surface, and is marked ~.
      const chosen = proven.length ? proven : candidates.length === 1 ? candidates : [];
      const contextInfo = {
        event: context.event,
        method: context.method,
        objectApiName: setting.objectApiName,
      };
      contexts.push(contextInfo);
      for (const candidate of chosen) {
        const site = candidate.dispatcherSite;
        links.push({
          triggerClassLower: candidate.triggerCm.classLower || lc(candidate.triggerCm.qualified),
          event: context.event,
          method: context.method,
          objectApiName: setting.objectApiName,
          approximate: !site,
          site: site ? {
            path: candidate.triggerCm.path || '',
            line: site.line || 0,
            col: site.col || 0,
            lineText: site.lineText || '',
          } : null,
        });
      }
    }
    if (contexts.length) classRef.triggerAction = { contexts, links };
  }
}

function sameMetaRefSource(a, b) {
  return !!(
    a && b && a.kind === b.kind && a.label === b.label &&
    (a.path || '') === (b.path || '') && (a.line || 0) === (b.line || 0) &&
    (a.fieldName || '') === (b.fieldName || '')
  );
}

function attachAnnotatedTriggerActionMethods(index, cmdtRefs, metaCallers, metaMethodCallers) {
  for (const ref of cmdtRefs || []) {
    if (!ref || !ref.triggerAction) continue;
    if (ref.namespace && (!index.ownNamespace || lc(ref.namespace) !== lc(index.ownNamespace))) continue;
    const classLower = lc(ref.className);
    if (!index.classes.has(classLower)) continue;
    const classRefs = metaCallers.get(classLower) || [];
    const attachedRef = classRefs.find((candidate) => sameMetaRefSource(candidate, ref)) || ref;
    // An own-namespace attach may have stored a stripped copy before the
    // setting record arrived in a later attachMetaCallers call.
    attachedRef.triggerAction = ref.triggerAction;
    const methodNames = new Set(ref.triggerAction.contexts.map((context) => lc(context.method)));
    for (const methodName of methodNames) {
      const key = `${classLower}#${methodName}`;
      if (!metaMethodCallers.has(key)) metaMethodCallers.set(key, []);
      const bucket = metaMethodCallers.get(key);
      if (!bucket.some((candidate) => sameMetaRefSource(candidate, attachedRef))) bucket.push(attachedRef);
    }
  }
}

// A6: attaches metascan.js's MetaRef[] output onto an existing index,
// mutating it with metaCallers (by class) and metaMethodCallers (by
// 'classLower#methodLower'). Pure and order-independent: safe to call
// multiple times / with refs from multiple scans (later calls append,
// they don't replace).
function attachMetaCallers(index, metaRefs) {
  if (!index) return index;
  const triggerActionCmdtRefs = index._triggerActionCmdtRefs instanceof Array
    ? index._triggerActionCmdtRefs
    : [];
  triggerActionCmdtRefs.push(...(metaRefs || []).filter((ref) => ref && ref.kind === 'cmdt'));
  index._triggerActionCmdtRefs = triggerActionCmdtRefs;
  annotateTriggerActionMetadata(index, triggerActionCmdtRefs);
  const metaCallers = index.metaCallers instanceof Map ? index.metaCallers : new Map();
  const metaMethodCallers = index.metaMethodCallers instanceof Map ? index.metaMethodCallers : new Map();
  // v0.8/N1/N4: same Map objects buildSemanticIndex's closure builds (see
  // its own "v0.8/N1/N2/N4: externals" header block) -- lazily created here
  // too (defensive fallback, mirroring metaCallers/metaMethodCallers just
  // above) for an index this function is ever handed that wasn't produced
  // by buildSemanticIndex.
  const externals = index.externals instanceof Map ? index.externals : new Map();
  const externalMetaRefs = index.externalMetaRefs instanceof Map ? index.externalMetaRefs : new Map();
  const ownNamespaceLower = index.ownNamespace || null;
  // v0.7.1/M2 -> v0.8/N1(c)/N5: a ref carrying (or shown, via
  // detectMetaRefNamespace's own fold-detection, to imply) a namespace no
  // longer becomes an uncounted "metaUnresolved" drop -- it either resolves
  // LOCALLY (own namespace, N3) or attaches to an EXTERNAL node (N1(c)).
  // metaUnresolvedCount therefore stays permanently 0 for every namespace-
  // shaped ref today; the counter/stats field itself is kept for API
  // stability (uitree.js/pathmap.js already read index.stats.metaUnresolved)
  // and in case a genuinely ambiguous/unattachable shape is added later.
  let metaUnresolvedCount = 0;
  for (const ref of metaRefs || []) {
    if (!ref) continue;
    // v0.10/A2: VF method-level action ref -- className is deliberately
    // null (see attachVfActionRef's own header note just above it), so this
    // MUST be dispatched before the ordinary `!ref.className` skip below,
    // which would otherwise drop it silently.
    // Namespace detection does not run for this branch; managed-package VF
    // controllers are not resolved by this path.
    if (ref.kind === 'vf' && ref.className == null && ref.methodName) {
      attachVfActionRef(index, ref, metaCallers, metaMethodCallers);
      continue;
    }
    if (!ref.className) continue;
    const detected = detectMetaRefNamespace(ref, ownNamespaceLower);
    if (detected && !detected.isOwn) {
      // v0.8/N1(c): external attach -- routes to the SAME external node an
      // Apex dotted-receiver (N2) or a same-(ns,class) ref from a DIFFERENT
      // metadata surface would (A5/B5's cross-surface consistency
      // requirement: one external node, multiple referencing sites, never
      // duplicated per surface). TERMINAL under the caller in this
      // direction -- an LWC/Flow/CMDT/etc reference has no callers of its
      // OWN to walk further; buildExternalCallerTree renders it via
      // buildMetaChildren exactly like any other metadata-caller node.
      const key = `${lc(detected.ns)}.${lc(detected.className)}`;
      let ext = externals.get(key);
      if (!ext) {
        ext = { ns: detected.ns, className: detected.className, label: `${detected.ns}.${detected.className}`, methods: new Set(), refCount: 0 };
        externals.set(key, ext);
      }
      if (detected.methodName) ext.methods.add(lc(detected.methodName));
      ext.refCount++;
      const attachedRef = (ref.className === detected.className && ref.methodName === detected.methodName)
        ? ref
        : Object.assign({}, ref, { className: detected.className, methodName: detected.methodName });
      if (!externalMetaRefs.has(key)) externalMetaRefs.set(key, []);
      externalMetaRefs.get(key).push(attachedRef);
      continue;
    }
    // v0.8/N3: an own-namespace ref is rewritten to its STRIPPED identity
    // before falling into the exact pre-v0.8 local-attach logic below (a
    // ref with no detected namespace signal at all -- `detected === null`
    // -- passes `ref` straight through, unchanged).
    const effectiveRef = detected && detected.isOwn
      ? Object.assign({}, ref, { className: detected.className, methodName: detected.methodName })
      : ref;
    const classLower = lc(effectiveRef.className);
    if (!metaCallers.has(classLower)) metaCallers.set(classLower, []);
    metaCallers.get(classLower).push(effectiveRef);
    if (effectiveRef.methodName) {
      const key = `${classLower}#${lc(effectiveRef.methodName)}`;
      if (!metaMethodCallers.has(key)) metaMethodCallers.set(key, []);
      metaMethodCallers.get(key).push(effectiveRef);
    } else if (effectiveRef.triggerAction) {
      // TAF metadata identifies the interface context, so attach the same
      // record to the exact afterUpdate/beforeInsert/etc. method as well as
      // the class-level bucket. This makes Who Calls This? work from either
      // the class declaration or the implementation method.
      const methodNames = new Set(effectiveRef.triggerAction.contexts.map((context) => lc(context.method)));
      for (const methodName of methodNames) {
        const key = `${classLower}#${methodName}`;
        if (!metaMethodCallers.has(key)) metaMethodCallers.set(key, []);
        metaMethodCallers.get(key).push(effectiveRef);
      }
    } else if (effectiveRef.kind === 'flow') {
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
        metaMethodCallers.get(key).push(effectiveRef);
      }
    }
  }
  // Reconcile annotations over the accumulated CMDT set after the ordinary
  // attach loop. This preserves attachMetaCallers' documented multi-call,
  // order-independent contract when action and setting records arrive in
  // separate batches.
  attachAnnotatedTriggerActionMethods(index, triggerActionCmdtRefs, metaCallers, metaMethodCallers);
  index.metaCallers = metaCallers;
  index.metaMethodCallers = metaMethodCallers;
  index.externals = externals;
  index.externalMetaRefs = externalMetaRefs;

  // A1/A4: forward DML/publish -> flow linkage. A record-triggered (or
  // platform-event-triggered) flow's own metaRef carries flowObject/
  // flowRecordTriggerType/flowTriggerType regardless of WHICH apex action it
  // calls (className/methodName above address a completely different
  // relationship: "this flow invokes that apex method"). Forward tracing
  // needs the OPPOSITE lookup from buildFlowChildren's reverse-direction one
  // (object -> DML sites): given a DML/publish site's own resolved object,
  // which flow(s) are triggered by it -- independent of whatever apex
  // method(s) that flow happens to call elsewhere. This can only be built
  // here (not inside buildSemanticIndex) because flow metadata never flows
  // through that function at all -- it arrives exclusively via this
  // attachMetaCallers call, same as metaCallers/metaMethodCallers above.
  // Deduped by (kind, label, flowObject) since one flow's <actionCalls>
  // block can produce several metaRefs sharing the same flow identity.
  const flowRefsByObject = index.flowRefsByObject instanceof Map ? index.flowRefsByObject : new Map();
  const seenFlowKeys = index._seenFlowKeys instanceof Set ? index._seenFlowKeys : new Set();
  for (const ref of metaRefs || []) {
    if (!ref || ref.kind !== 'flow' || !ref.flowObject) continue;
    const objectLower = lc(ref.flowObject);
    const dedupeKey = `${objectLower}::${lc(ref.label)}`;
    if (seenFlowKeys.has(dedupeKey)) continue;
    seenFlowKeys.add(dedupeKey);
    if (!flowRefsByObject.has(objectLower)) flowRefsByObject.set(objectLower, []);
    flowRefsByObject.get(objectLower).push({
      label: ref.label,
      path: ref.path || '',
      line: ref.line || 0,
      flowRecordTriggerType: ref.flowRecordTriggerType || null,
      flowTriggerType: ref.flowTriggerType || null,
    });
  }
  index.flowRefsByObject = flowRefsByObject;
  index._seenFlowKeys = seenFlowKeys;

  // v0.13/S2: flow-to-subflow chains -----------------------------------
  // index.flowInfo: Map<flowLower, {label, path, line, flowObject,
  //   flowTriggerType, flowRecordTriggerType}> -- one entry per distinct
  //   flow label metascan has ever seen (accumulated across
  //   attachMetaCallers calls, same "later calls append" contract as
  //   metaCallers/metaMethodCallers above). Built from EVERY flow-kind ref
  //   regardless of whether it carries className/methodName -- this is the
  //   file-driven registration a flow with zero apex actionCalls (e.g. a
  //   subflow-only flow, or a flow whose ONLY <subflows> element is what
  //   makes it interesting) needs in order to be "known" at all; mirrors
  //   collectFlowEntries' own index.flowFilePaths file-driven fallback
  //   (resolver.js's pre-existing v0.12 precedent) rather than the
  //   per-actionCalls-ref-only convention flowObject/flowTriggerType used
  //   A per-ref-only convention would silently lose an Apex-less flow's own
  //   outgoing subflow reference. The
  //   lowest-line ref's fields win when several refs share a label (same
  //   "best" convention collectFlowEntries already uses).
  // index.flowGraph: Map<flowLower, {parents: string[], children: string[]}>
  //   -- built ONLY between two flows metascan actually saw (registered in
  //   flowInfo, from THIS call or an earlier one) -- a <subflows> reference
  //   naming an unknown flow is counted (stats.unknownSubflowRefs) but NEVER
  //   creates a flowGraph entry or a fabricated node for that name. Resolved
  //   in a second pass (pendingSubflowRefs below) since a subflow's own ref
  //   may appear later in this SAME metaRefs array than its parent's.
  // index.flowApexTargets: Map<flowLower, [{classLower, methodLower|null}]>
  //   -- the REVERSE of metaCallers/metaMethodCallers, indexed by flow
  //   instead of by class: "what apex does THIS flow call" -- forward/callee
  //   subflow expansion has no other way to ask that question. Own-namespace
  //   (or namespace-less) targets only, mirroring metaCallers' local-only
  //   registration just above; external targets are handled separately.
  const flowInfo = index.flowInfo instanceof Map ? index.flowInfo : new Map();
  const flowGraph = index.flowGraph instanceof Map ? index.flowGraph : new Map();
  const flowApexTargets = index.flowApexTargets instanceof Map ? index.flowApexTargets : new Map();
  const pendingSubflowRefsThisCall = [];

  function getOrCreateFlowGraphNode(flowLower) {
    let g = flowGraph.get(flowLower);
    if (!g) {
      g = { parents: [], children: [] };
      flowGraph.set(flowLower, g);
    }
    return g;
  }

  for (const ref of metaRefs || []) {
    if (!ref || ref.kind !== 'flow' || typeof ref.label !== 'string' || !ref.label) continue;
    const flowLower = lc(ref.label);
    const existing = flowInfo.get(flowLower);
    if (!existing || (ref.line || 0) < (existing.line || 0)) {
      flowInfo.set(flowLower, {
        label: ref.label,
        path: ref.path || (existing && existing.path) || '',
        line: ref.line || 0,
        flowObject: ref.flowObject || (existing && existing.flowObject) || null,
        flowTriggerType: ref.flowTriggerType || (existing && existing.flowTriggerType) || null,
        flowRecordTriggerType: ref.flowRecordTriggerType || (existing && existing.flowRecordTriggerType) || null,
      });
    }

    // This flow's own outgoing apex-action target(s) -- the reverse lookup
    // flowApexTargets exists for. Own-namespace/no-namespace only (see
    // header note above).
    if (ref.className) {
      const detected2 = detectMetaRefNamespace(ref, ownNamespaceLower);
      if (!detected2 || detected2.isOwn) {
        const targetClassLower = lc(detected2 && detected2.isOwn ? detected2.className : ref.className);
        const list = flowApexTargets.get(flowLower) || [];
        if (!flowApexTargets.has(flowLower)) flowApexTargets.set(flowLower, list);
        const pushIfNew = (methodLower) => {
          if (!list.some((t) => t.classLower === targetClassLower && t.methodLower === methodLower)) {
            list.push({ classLower: targetClassLower, methodLower });
          }
        };
        if (ref.methodName) {
          pushIfNew(lc(detected2 && detected2.isOwn ? detected2.methodName : ref.methodName));
        } else {
          // Mirrors the class-level-plus-sole-invocable-method dual
          // registration metaCallers/metaMethodCallers already do above.
          pushIfNew(null);
          const soleInvocable = findSoleInvocableMethod(index, targetClassLower);
          if (soleInvocable) pushIfNew(lc(soleInvocable));
        }
      }
    }

    // <subflows> references this flow file declared -- resolved in a
    // second pass below (once every ref in THIS call has registered its
    // own label into flowInfo).
    const subflows = Array.isArray(ref.subflows) ? ref.subflows : [];
    for (const rawName of subflows) {
      if (typeof rawName !== 'string' || !rawName) continue;
      pendingSubflowRefsThisCall.push({ parentLower: flowLower, childLower: lc(rawName) });
    }
  }

  // v0.13/S2 ORDERING NOTE: extension.js's real pipeline sets
  // index.flowFilePaths AFTER calling attachMetaCallers (see that field's
  // own v0.12 header note -- it exists specifically so a flow with ZERO
  // metascan refs of ANY kind still gets entry-catalog identity). A subflow
  // reference naming such a flow (a pure orchestration leaf: no apex
  // actionCalls of its OWN and no <subflows> of its OWN either, so even S1's
  // bare-ref exception never fires for it -- e.g. adv-org's
  // AcmeNotifyCustomerSubflow, whose only action is a non-apex emailSimple)
  // is therefore UNRESOLVABLE from flowInfo alone at this exact moment, even
  // though it names a perfectly real flow file. Rather than mis-count it as
  // unknown, an unresolved pending ref is deferred (index._pendingSubflowRefs,
  // accumulated across calls) and finalized lazily -- see
  // finalizeFlowSubflowRefs()'s own header note just below -- by
  // buildCallerTree/buildCalleeTree/buildEntryCatalog, all three of which
  // only ever run after the full scan-and-attach sequence (incl. the
  // flowFilePaths assignment) has completed. A ref that resolves immediately
  // (the common case -- the referenced flow already has its own MetaRef) is wired into flowGraph
  // right here, with zero deferral.
  const pendingSubflowRefs = Array.isArray(index._pendingSubflowRefs) ? index._pendingSubflowRefs : [];
  for (const { parentLower, childLower } of pendingSubflowRefsThisCall) {
    if (flowInfo.has(childLower)) {
      const parentNode = getOrCreateFlowGraphNode(parentLower);
      const childNode = getOrCreateFlowGraphNode(childLower);
      if (!parentNode.children.includes(childLower)) parentNode.children.push(childLower);
      if (!childNode.parents.includes(parentLower)) childNode.parents.push(parentLower);
    } else {
      pendingSubflowRefs.push({ parentLower, childLower });
    }
  }

  index.flowInfo = flowInfo;
  index.flowGraph = flowGraph;
  index.flowApexTargets = flowApexTargets;
  index._pendingSubflowRefs = pendingSubflowRefs;

  // v0.7.1/M2: accumulate across repeat calls (this function is documented
  // as safe to call multiple times / with refs from multiple scans, "later
  // calls append, they don't replace") -- same additive posture as
  // metaCallers/metaMethodCallers above, not a per-call overwrite.
  index.stats = index.stats || {};
  index.stats.metaUnresolved = (index.stats.metaUnresolved || 0) + metaUnresolvedCount;
  // v0.13/S2: stats.unknownSubflowRefs itself is finalized lazily (see
  // finalizeFlowSubflowRefs) -- initialized to 0 here only if this is the
  // very first attachMetaCallers call this index has ever seen, otherwise
  // left exactly as-is (never reset to 0 on a later call, matching every
  // other stats field's additive-across-calls convention).
  index.stats.unknownSubflowRefs = index.stats.unknownSubflowRefs || 0;
  // v0.8/N5: externalRefs/externalNamespaces are RECOMPUTED (not
  // accumulated) from `externals`' current, now-possibly-larger contents --
  // see computeExternalStats's own header note on why a derived value here
  // can never drift, regardless of how many times this function is called
  // or in what order relative to buildSemanticIndex's own initial stats.
  Object.assign(index.stats, computeExternalStats(externals));

  refreshIndexDiagnostics(index);
  return index;
}

// v0.13/S2: decisively resolves whatever is still sitting in
// index._pendingSubflowRefs (see attachMetaCallers' own "ORDERING NOTE" just
// above for exactly why a ref can be left pending) into either a REAL
// flowGraph edge or a final stats.unknownSubflowRefs increment -- never
// both, never neither, and never counted twice (each pending entry is
// removed from the list the moment it's decided). Idempotent/cheap to call
// on every entry into buildCallerTree/buildCalleeTree/buildEntryCatalog:
// once index._pendingSubflowRefs is empty, every subsequent call is an
// instant no-op.
//
// Folds index.flowFilePaths (if present at THIS moment -- by real-pipeline
// convention it always is, by the time any of the three callers above first
// run) into index.flowInfo as synthetic bare entries for any flow FILE that
// produced zero metascan refs of ANY kind (mirrors collectFlowEntries' own
// identical fallback, one level earlier, so flowGraph resolution sees the
// exact same "known flow" universe the entry catalog does).
function finalizeFlowSubflowRefs(index) {
  if (!index) return;
  const pending = Array.isArray(index._pendingSubflowRefs) ? index._pendingSubflowRefs : [];
  if (!pending.length) return;

  const flowInfo = index.flowInfo instanceof Map ? index.flowInfo : (index.flowInfo = new Map());
  const flowGraph = index.flowGraph instanceof Map ? index.flowGraph : (index.flowGraph = new Map());

  const flowFilePaths = Array.isArray(index.flowFilePaths) ? index.flowFilePaths : [];
  for (const p of flowFilePaths) {
    if (typeof p !== 'string' || !p) continue;
    const label = flowStemOf(p);
    if (!label) continue;
    const flowLower = lc(label);
    if (!flowInfo.has(flowLower)) {
      flowInfo.set(flowLower, { label, path: p, line: 0, flowObject: null, flowTriggerType: null, flowRecordTriggerType: null });
    }
  }

  function getOrCreateFlowGraphNode(flowLower) {
    let g = flowGraph.get(flowLower);
    if (!g) {
      g = { parents: [], children: [] };
      flowGraph.set(flowLower, g);
    }
    return g;
  }

  let unknownDelta = 0;
  for (const { parentLower, childLower } of pending) {
    // "matched to other flows by stem, case-insensitive" -- a subflow name
    // matching NO known flow (flowInfo, now folded with flowFilePaths above)
    // is counted, never fabricated as a node.
    if (!flowInfo.has(childLower)) {
      unknownDelta++;
      continue;
    }
    const parentNode = getOrCreateFlowGraphNode(parentLower);
    const childNode = getOrCreateFlowGraphNode(childLower);
    if (!parentNode.children.includes(childLower)) parentNode.children.push(childLower);
    if (!childNode.parents.includes(parentLower)) childNode.parents.push(parentLower);
  }

  index._pendingSubflowRefs = [];
  index.stats = index.stats || {};
  index.stats.unknownSubflowRefs = (index.stats.unknownSubflowRefs || 0) + unknownDelta;
  refreshIndexDiagnostics(index);
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
// A2: `ctx.direction` ('callers'|'callees', default 'callers' when unset --
// see buildCallerTree, which never sets it, vs buildCalleeTree, which
// always does) is the ONE thing that makes this walker direction-agnostic
// rather than forked: grouping/DAG-memoization/cap-enforcement below are
// 100% shared code, unaware of direction beyond the couple of explicit
// branches called out inline.
// v0.7.1/R5: `ownerNode` is the TNode whose children THIS call is building
// (the tree root for the two top-level invocations, `task.node` for every
// subsequent queue-driven expansion) -- see the maxNodes-cap `break` below
// for why it's needed.
// P1 (v0.9 progressive depth): the exact grouping/keying logic
// buildChildrenLevel has always used to collapse a pairs[] list into one
// TNode per distinct caller/callee identity -- pulled out unchanged (byte-
// identical behavior) so buildOneChildNode's frontier branch can PEEK at
// "how many distinct groups would the next level contain" (-> pendingCount)
// without materializing any TNodes or touching ctx.nodeCount/expandedKeys.
function groupPairsByKey(pairs) {
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
      // B2 fix: derive gClassLower/key from site.callerKey (the EXACT
      // internal registration key every site shape already carries --
      // makeCallSite, calleeItemFromEdge, and the pass-E lexical-fallback
      // site all set it) instead of re-deriving it by lowercasing the
      // DISPLAY qualified name (site.callerClass). Identical to the
      // pre-v0.7 behavior for every non-duplicate class (lc(qualified)
      // always equals the registration key there), but a B2 duplicate-slot
      // identity's registration key is a SYNTHETIC string distinct from
      // its shared display name -- re-deriving from the display name would
      // collide two genuinely different classes/packages sharing one
      // qualified name into a single grouped node (breaking B3's ambiguous
      // fan-out, which needs them to stay two separate forward/reverse
      // children).
      const hashIdx = site.callerKey ? site.callerKey.indexOf('#') : -1;
      gClassLower = hashIdx >= 0 ? site.callerKey.slice(0, hashIdx) : lc(site.callerClass);
      gMethodLabel = site.callerMethod;
      isLexical = false;
      key = site.callerKey || `${gClassLower}#${lc(gMethodLabel)}`;
    }
    if (!groups.has(key)) groups.set(key, { gClassLower, gMethodLabel, isLexical, kindOverride: item.kindOverride || null, items: [] });
    groups.get(key).items.push(item);
  }
  return groups;
}

// v0.13/H2: groups every APPROXIMATE child a level built (node.approximate
// === true -- the SAME flag buildOneChildNode already computes from
// APPROX_VIA/site.approximate for every via, incl. 'lexical') under ONE
// collapsed 'rollup' pseudo-node, controlled by ctx.showUnconfirmed:
//   - 'expand' (old, pre-H2 behavior): `nodes` returned completely
//     unchanged -- this is the literal flatten(rollup children)+confirmed
//     == the legacy child-set baseline
//     proof is checked against.
//   - 'hide': approximate nodes are dropped entirely (not even a count).
//   - 'rollup' (default): confirmed nodes pass through untouched; every
//     approximate node becomes a CHILD of one new pseudo-node instead of a
//     sibling -- same object references, so any expandTask already queued
//     for one of them (see buildOneChildNode) still resolves correctly
//     against `task.node`, wherever that node ends up nested.
// Direction-agnostic: called identically for callers and callees (the
// pseudo-node's own label is the only direction-specific bit).
function applyShowUnconfirmed(nodes, ctx) {
  const mode = ctx.showUnconfirmed || 'rollup';
  if (mode === 'expand') return nodes;
  const confirmed = [];
  const approx = [];
  for (const n of nodes) (n.approximate ? approx : confirmed).push(n);
  if (!approx.length) return nodes; // nothing to group/hide -- no-op either way
  if (mode === 'hide') return confirmed;
  const count = approx.length;
  const noun = ctx.direction === 'callees'
    ? (count === 1 ? 'callee' : 'callees')
    : (count === 1 ? 'caller' : 'callers');
  const rollupNode = {
    label: `${count} possible ${noun} (unconfirmed)`,
    kind: 'rollup', className: '', path: '', line: 0, methodLower: null,
    entries: [], isTest: false, via: null, sites: [],
    children: approx,
    cyclic: false, truncated: false, approximate: true, seenElsewhere: false,
    collapsibleState: 'collapsed', // consumed by extension.js/uitree.js, out of this file's own scope
  };
  ctx.nodeCount++; // the pseudo-node itself is one more materialized TNode
  return confirmed.concat([rollupNode]);
}

function buildChildrenLevel(index, pairs, depth, ancestorPath, targetClassLower, excCtx, ctx, queue, ownerNode) {
  const groups = groupPairsByKey(pairs);
  let out = [];
  for (const g of groups.values()) {
    if (ctx.nodeCount >= ctx.maxNodes) {
      ctx.capped = true;
      // v0.7.1/R5: stamp truncated=true on the SPECIFIC node whose
      // expansion the cap cut off (mirrors the pre-existing depth-cap
      // pattern a few lines down in buildOneChildNode, which already
      // correctly marks the specific node it stops at). Without this, a
      // node with real further callers/callees renders identically to a
      // genuine zero-children leaf, and downstream root/leaf badge logic
      // (uitree.js/pathmap.js's isRootNode()) mislabels it a terminal
      // dead-end -- the single strongest possible false signal a
      // call-graph tool can give.
      if (ownerNode) ownerNode.truncated = true;
      break;
    }
    const built = buildOneChildNode(index, g, depth, ancestorPath, targetClassLower, excCtx, ctx);
    ctx.nodeCount++;
    out.push(built.node);
    if (built.expandTask) queue.push(built.expandTask);
  }
  // v0.13/H2: partition/group approximate siblings per ctx.showUnconfirmed
  // BEFORE the direction-specific ordering below, so the rollup pseudo-node
  // (when one is created) participates in callers' alphabetical sort like
  // any other node, and never disturbs callees' source-line order among the
  // CONFIRMED nodes that keep their original relative positions.
  out = applyShowUnconfirmed(out, ctx);
  // A2: callers-direction output is UNCHANGED (alphabetical, tests-last,
  // exactly the pre-v0.7 sortTNodes call). Callees direction instead
  // preserves SOURCE-LINE order -- forward tracing is telling "what happens
  // first, second, third" in program order, not listing an arbitrary set of
  // callers, and `groups` (a Map) already preserves `pairs`' own insertion
  // order (== methodCallees' push order == call-site encounter order during
  // pass B) for free, so simply skipping the sort here is enough.
  if (ctx.direction !== 'callees') out.sort(sortTNodes);
  return out;
}

// H1: builds ONE child TNode (no recursion) and decides its terminal status,
// in priority order: (1) lexical / defensive-missing-class -- always
// terminal, unrelated to the DAG-memoization keying below; (2) cyclic --
// this exact classLower#methodLower is already on the CURRENT root-to-node
// ancestor path (unchanged pre-H1 semantics, and still wins over (3) per
// cycle detection still wins over seenElsewhere on ancestor-path hits;
// (3) seenElsewhere -- this identity's subtree was already
// expanded once elsewhere in this tree (ctx.expandedKeys), so its own
// children are shown as [] here rather than re-walking (and re-materializing
// nodes for) a subtree this call has already built in full; (4) truncated --
// depth cap, unchanged pre-H1 semantics, checked AFTER seenElsewhere so a
// deduped node never gets mislabeled "stopped due to depth" when it's
// actually "already shown in full elsewhere"; (5) normal -- marks this
// identity expanded (so any LATER occurrence hits case 3) and returns an
// expandTask for the caller to enqueue.
function buildOneChildNode(index, g, depth, ancestorPath, targetClassLower, excCtx, ctx) {
  const direction = ctx.direction === 'callees' ? 'callees' : 'callers';
  // v0.11/B2: a site's own `approximate` override (true ONLY for a
  // narrowed-generic-DML edge -- see makeCallSite's own note) joins the
  // pre-existing APPROX_VIA-membership check, OR'd per site -- this is the
  // ONE place a via='dml' edge can ever be approximate, without adding a
  // new via value or disturbing every other via's pre-existing byte-
  // identical APPROX_VIA-only behavior (ordinary sites carry
  // approximate:false/undefined, so `|| it.site.approximate ===
  // true` is a no-op for them).
  const approximate = g.items.length > 0 && g.items.every((it) => APPROX_VIA.has(it.site.via) || it.site.approximate === true);

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

  // A3: class-level (no method) forward target -- currently only the
  // throw-forward exception-class node (calleeItemFromEdge flags it via
  // kindOverride). Always terminal: it does not expand into the exception
  // class's own
  // (nonexistent, for a plain exception subclass) outbound calls.
  // The top-level APPROX_VIA set deliberately excludes 'throws': it
  // is deliberately NOT a member -- a throw site genuinely does raise that
  // exact exception type, the same "platform genuinely does this" reasoning
  // already applied to via='dml'/'publish'/'async' elsewhere in this file.
  // approximate is therefore computed from APPROX_VIA like every other node
  // (currently always false, since 'throws' is the only via this branch
  // ever sees), not hardcoded true -- terminality is carried by `truncated`
  // alone, exactly like the sibling flow/unresolved terminal nodes above.
  if (g.kindOverride === 'exception') {
    const first = g.items[0].site;
    return {
      node: {
        label: first.callerClass, kind: 'exception', className: first.callerClass, path: first.path, line: 0,
        methodLower: null,
        entries: [], isTest: false, via: first.via,
        sites: direction === 'callees' ? shapeCalleeSites(g.items) : shapeSites(index, g.items, targetClassLower),
        children: [], cyclic: false, truncated: true, approximate: APPROX_VIA.has(first.via), seenElsewhere: false,
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
        sites: direction === 'callees' ? shapeCalleeSites(g.items) : shapeSites(index, g.items, targetClassLower),
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
    via: g.items[0].site.via,
    // A2: callee-direction sites carry a PRE-COMPUTED argsRendered (zipped
    // at RECORD time against THIS node's own declared params -- the
    // correct target for a forward call site's args, unlike shapeSites'
    // callers-direction zip against the method BEING TRACED). See
    // shapeCalleeSites' own header note.
    sites: direction === 'callees' ? shapeCalleeSites(g.items) : shapeSites(index, g.items, targetClassLower),
    children: [], cyclic: false, truncated: false, approximate, seenElsewhere: false,
  };
  // B3: package badge -- only meaningful (and only ever populated) when
  // opts.packageOf was active for this build; a plain string label or
  // undefined otherwise (uitree/pathmap, out of this file's scope, decide
  // when to actually render it -- e.g. only when it differs from the
  // trace's own root package).
  if (ccm.package != null) node.package = ccm.package;

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
  // site's own frame, already surfaced via via='throws'.
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

  // P1 (v0.9 progressive depth): a node beyond the shallow initialDepth
  // frontier does NOT auto-expand unless its OWN identity (cycleKey) was
  // explicitly requested via opts.expandedKeys (one entry per prior click --
  // see buildCallerTree/buildCalleeTree's opts-normalization comment for how
  // ctx.userExpandedKeys is built). Frozen rule, verbatim: a node expands if
  // (depth < initialDepth) OR (cycleKey in userExpandedKeys) -- nothing
  // more. Children of an expanded-by-key node are subject to the exact same
  // two-part test again one level down (their own depth vs initialDepth,
  // their own cycleKey vs userExpandedKeys), so a single click only ever
  // reveals the clicked node's OWN direct children -- expandStep>1 is a
  // CALLER-side concern (add step-1 more rounds of newly-exposed frontier
  // keys and rebuild), the engine itself always stays single-level per call.
  // This check runs strictly AFTER the maxDepth hard cap above, so a node
  // beyond BOTH thresholds is always `truncated`, never `expandable` -- see
  // this file's own P1 header note: "truncated (cap) stays distinct from
  // expandable (depth frontier)". With the back-compat default
  // (initialDepth === maxDepth), `depth < ctx.initialDepth` is always true
  // whenever we reach this line (we already know depth < ctx.maxDepth from
  // the check above), so this branch can never fire -- output is
  // byte-identical to pre-v0.9 for every existing caller that doesn't pass
  // initialDepth/expandedKeys.
  const withinInitialDepth = depth < ctx.initialDepth;
  const explicitlyExpanded = ctx.userExpandedKeys.has(cycleKey);
  if (!withinInitialDepth && !explicitlyExpanded) {
    // H1 fix: a frontier stub is still "the shown occurrence" of this
    // identity for the rest of THIS build, exactly like a real expansion is
    // (see the ctx.expandedKeys.add(cycleKey) a few lines below, on the
    // real-expansion path). Registering it here too means any OTHER
    // occurrence of the same cycleKey reached later in the same traversal
    // (e.g. the other branch of a diamond fan-in) hits the seenElsewhere
    // check above instead of independently peeking pendingCount and
    // rendering its own duplicate expandable:true stub. Without this, two
    // occurrences of a shared identity beyond the frontier both bypass
    // seenElsewhere (neither is registered yet when the other is checked)
    // and render as two un-deduped nodes -- breaking the expand-to-
    // convergence deep-equal-to-eager-v0.8-tree guarantee for any diamond-
    // shaped call graph. Must run regardless of pendingCount (even a
    // pendingCount===0 leaf still counts as "shown" here).
    ctx.expandedKeys.add(cycleKey);
    const peekPairs = direction === 'callees'
      ? calleeMethodLevelPairs(index, g.gClassLower, methodLower2)
      : methodLevelPairs(index, g.gClassLower, methodLower2);
    const pendingCount = groupPairsByKey(peekPairs).size;
    // Only stamp expandable/pendingCount when there is genuinely something
    // pending -- a node with literally zero further callers/callees behind
    // the frontier is an honest leaf, not a frontier boundary, and must
    // render exactly like one (no dangling "+0 more" affordance).
    if (pendingCount > 0) {
      node.expandable = true;
      node.pendingCount = pendingCount;
      ctx.frontierNodes++;
    }
    return { node, expandTask: null };
  }

  ctx.expandedKeys.add(cycleKey);
  const nextPath = new Set(ancestorPath);
  nextPath.add(cycleKey);
  const nextPairs = direction === 'callees'
    ? calleeMethodLevelPairs(index, g.gClassLower, methodLower2)
    : methodLevelPairs(index, g.gClassLower, methodLower2);
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
  // Only stamp a `package` field when B2's gate is active
  // (package metadata was actually discovered somewhere -- see
  // packageMetadataDiscovered's own header note in buildSemanticIndex).
  // Matches targets.js's own contract: an item with NO `package` property
  // at all is what keeps a packageless workspace's refineTargets() output
  // byte-identical to pre-v0.7 (see targets.js's B3 addendum).
  const stampPackage = !!index.packageMetadataDiscovered;
  for (const cm of index.classes.values()) {
    // Use this ClassMeta's registration key (cm.classLower
    // -- the real key it lives under in index.classes, which for a B2
    // duplicate-slot candidate is a synthetic '~dupN~pkg' key, NOT the
    // plain lc(cm.qualified) every same-named candidate shares) instead of
    // re-deriving classLower from the qualified name. Before this fix every
    // duplicate-name candidate's suggestTargets() item carried the SAME
    // classLower (whichever one `index.classes.get(lc(qualified))` happens
    // to resolve to -- always the first-registered/primary candidate), so
    // buildCallerTree/buildCalleeTree could never actually reach any
    // candidate but the primary one via the public suggestTargets() ->
    // resolveTarget() flow real QuickPick usage goes through.
    const classLower = cm.classLower || lc(cm.qualified);
    const classItem = { label: cm.name, classLower, methodLower: null };
    if (stampPackage) classItem.package = cm.package != null ? cm.package : null;
    out.push(classItem);
    const seen = new Set();
    for (const m of cm.methods) {
      const nl = lc(m.name);
      if (seen.has(nl)) continue;
      seen.add(nl);
      // Accessor scopes are call-graph sources only, never
      // valid trace targets — suppressed here so users never pick a target
      // guaranteed to show zero callers.
      if (nl.startsWith('(get ') || nl.startsWith('(set ')) continue;
      const label = cm.kind === 'trigger' ? cm.name : `${cm.name}.${m.name}`;
      const methodItem = { label, classLower, methodLower: nl };
      if (stampPackage) methodItem.package = cm.package != null ? cm.package : null;
      out.push(methodItem);
    }
  }
  // v0.8/N4: externals ARE valid trace targets in the callers direction --
  // every ExternalMeta in the index (by construction, only ever created
  // once at least one local site references it -- see getOrCreateExternal's
  // own callers, all of which increment refCount in the same breath) gets
  // ONE class-level-shaped item, `kind:'external'`, bare `label` (targets.js's
  // refineTargets() appends
  // the ' (managed)' suffix -- see its own N4/N6 header note; resolver.js
  // hands it the raw '<ns>.<Class>' label unmodified, matching the same
  // "each layer owns its own transform" division targets.js's constructor-
  // relabel/B3 package-suffix passes already use). No `package` field --
  // externals have no local file/sfdx-package identity.
  for (const [key, ext] of index.externals instanceof Map ? index.externals : []) {
    out.push({ label: ext.label, classLower: key, methodLower: null, kind: 'external' });
  }
  out.sort((a, b) => a.label.localeCompare(b.label));
  return out;
}

// =========================================================================
// v0.12/C1: buildEntryCatalog(index) -- "a browsable index of every way into
// the org," built PURELY by re-reading structures this file already
// computes (MethodMeta.entries/ClassMeta.entries, triggerInfo,
// metaCallers/externalMetaRefs, the '.apex' anonymous pseudo-type). No new
// Apex/Flow analysis is performed here -- see the per-branch notes below for
// exactly which existing field each Entry's data comes from.
//
// Group = { kind, label, entries:[Entry] }, one Group per kind, ALWAYS in
// this fixed display order (even when a kind has zero entries -- a stable,
// fully-enumerated key set is easier for a UI/test to consume than one whose
// shape varies with workspace contents):
const ENTRY_KIND_ORDER = ['trigger', 'aura', 'invocable', 'rest', 'soap', 'async', 'email', 'platform', 'flow', 'anonymous'];

// v0.12/C2 note: matches uitree.js's own ENTRY_CATALOG_KIND_FALLBACK_LABEL
// verbatim (that table only ever renders when a Group arrives with a falsy
// label at all -- see its own header comment -- but since this file always
// supplies one, keeping the two wordings identical avoids two subtly
// different "what does this kind mean" labels existing in the product).
const ENTRY_KIND_GROUP_LABEL = {
  trigger: 'Triggers',
  aura: 'Aura / LWC (@AuraEnabled)',
  invocable: 'Invocable Actions',
  rest: 'REST Endpoints',
  soap: 'SOAP Web Services',
  async: 'Async (Batch / Queueable / Schedulable / @future)',
  email: 'Email Handlers',
  platform: 'Platform Hooks',
  flow: 'Flows',
  anonymous: 'Anonymous Scripts',
};

// computeAnnotationEntries()/F5_ENTRY_RULES/BQS_LABEL above are this file's
// ONLY producers of a method-level entries[] string (besides the trigger and
// G4 anonymous-script labels, both handled by their own dedicated branches
// below, and besides isTest exclusion, applied uniformly). This is the
// verbatim-label -> catalog-kind map for every one of them.
const ENTRY_LABEL_TO_KIND = {
  '@AuraEnabled (LWC/Aura)': 'aura',
  '@InvocableMethod (Flow)': 'invocable',
  '@HttpX (REST)': 'rest',
  '@future (async)': 'async',
  'webservice (SOAP API)': 'soap',
  'Batchable': 'async',
  'Queueable': 'async',
  'Schedulable': 'async',
  'InboundEmailHandler (Email Service)': 'email',
  'InstallHandler (package install)': 'platform',
  'UninstallHandler (package uninstall)': 'platform',
  'RegistrationHandler (SSO)': 'platform',
  'Comparable (invoked by sort)': 'platform',
  'Finalizer (async)': 'platform',
};

// REST detail is "the @HttpX verb(s)" -- the literal annotation
// text (e.g. '@HttpGet'), NOT the generic '@HttpX (REST)' badge label
// computeAnnotationEntries() already produced (that label is what routes the
// method to kind:'rest' in the first place; the verb itself has to be
// recovered separately from the method's own raw annotations -- see
// restDetailFor below). parser.js hands annotations back bare/lowercased/
// no-'@' (its own frozen contract, see its header note), so this is the
// canonical-case display form for each of resolver.js's own HTTP_ANNOTATIONS
// set, defined once here rather than re-deriving it per call.
const HTTP_VERB_DISPLAY = {
  httpget: '@HttpGet',
  httppost: '@HttpPost',
  httpput: '@HttpPut',
  httpdelete: '@HttpDelete',
  httppatch: '@HttpPatch',
};

// cm.methods (ClassMeta) only ever retained the DERIVED entries[] labels,
// not the method's raw annotations -- but cm.typeFacts (the original
// TypeFacts this ClassMeta was built from, kept around for exactly this
// kind of "need the raw fact back" case, see buildClassMeta's own
// `typeFacts: tf` field) still has them. Matched by (name, line) rather than
// array position/name-only, since overloads share a name and ctors were
// already merged out of cm.methods entirely.
function restDetailFor(cm, mm) {
  const rawMethods = (cm && cm.typeFacts && cm.typeFacts.methods) || [];
  const rawMf = rawMethods.find((m) => !m.isCtor && m.name === mm.name && (m.line || 0) === (mm.line || 0));
  const anns = rawMf ? (rawMf.annotations || []).map(annBare) : [];
  const verbs = [];
  for (const a of anns) {
    if (HTTP_ANNOTATIONS.has(a) && HTTP_VERB_DISPLAY[a] && !verbs.includes(HTTP_VERB_DISPLAY[a])) verbs.push(HTTP_VERB_DISPLAY[a]);
  }
  // Defensive fallback only -- computeAnnotationEntries() already guarantees
  // at least one HTTP_ANNOTATIONS match before '@HttpX (REST)' is ever
  // pushed, so `verbs` is never actually empty for a real catalog entry.
  return verbs.length ? verbs.join(', ') : '@HttpX';
}

// metascan.js emits a MetaRef for a Flow file that has at
// least one apex <actionCalls> block -- a Screen/Autolaunched Flow with zero
// such blocks (e.g. UI-only, or every action non-Apex) produces NOTHING at
// all, so it is otherwise invisible to this index. The catalog still lists
// every distinct Flow file seen by metascan. Since resolver.js has no fs
// access, this is read from an optional, purely
// additive new index field -- index.flowFilePaths: string[] -- the raw
// '.flow-meta.xml' paths seen during the metadata scan, regardless of
// content. extension.js sets
// `index.flowFilePaths = <every .flow-meta.xml path from its own meta scan>`
// before calling buildEntryCatalog, mirroring how it already sets
// opts.packageOf/opts.defaultPackage for buildSemanticIndex. Absent (today's
// real production index), this just yields zero extra flow entries beyond
// what metaCallers/externalMetaRefs already carry -- never throws, never
// double-counts (see collectFlowEntries's own dedupe-by-label note).
//
// This mirrors metascan.js's stemOf() -- strip directory, strip
// the compound '.flow-meta.xml' extension -- reproduced here (not imported;
// metascan.js exports no such helper) because it is pure filename text
// manipulation, not Apex/Flow semantic analysis.
function flowStemOf(rawPath) {
  const s = String(rawPath || '');
  const slash = Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\'));
  const base = slash === -1 ? s : s.slice(slash + 1);
  if (/\.flow-meta\.xml$/i.test(base)) return base.replace(/\.flow-meta\.xml$/i, '');
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(0, dot) : base;
}

// Gathers every distinct Flow (by label/API name) this index knows about --
// from metaCallers (locally-attached refs) AND externalMetaRefs (a Flow
// whose apex action targets a managed-package class still IS a real local
// Flow file, just one whose action happens to resolve external -- see
// v0.8/N1(c)) -- plus, additively, index.flowFilePaths (see flowStemOf's
// header note). One Entry per distinct label; when several actionCalls
// refs share a label (a flow with multiple apex actions), the lowest-line
// ref is used for path/line (arbitrary but deterministic -- every ref
// sharing a label was stamped from the SAME file's SAME <start> block, so
// flowObject/flowTriggerType never differ across them). Detail: the
// fallback ('screen or autolaunched') whenever no
// start-trigger info was extracted (covers real Screen Flows, record-
// agnostic Autolaunched Flows, AND Scheduled-Path Flows alike -- metascan's
// own <start> extraction cannot tell these apart, and this catalog performs
// no new analysis to do so either), otherwise '<flowTriggerType> on
// <flowObject>' (covers both record-triggered and platform-event-triggered
// shapes, which both carry that same field pair).
// v0.13/S2: additive detail-suffix for a flow that is ONLY ever referenced
// as a subflow of other flows -- "no <start> trigger info (hasStartInfo
// false -- the pre-existing 'screen or autolaunched' fallback branch) AND at
// least one parent. Returns '' (no suffix) otherwise,
// so `detail + subflowSuffixFor(...)` is always safe to concatenate.
// Multiple parents use ", "-joined canonical labels (flowInfo's display casing,
// falling back to the raw lowercased key if a parent was somehow never
// registered into flowInfo) is a deterministic, readable choice for that
// unexercised case.
function subflowSuffixFor(index, label, hasStartInfo) {
  if (hasStartInfo) return '';
  const g = index && index.flowGraph instanceof Map ? index.flowGraph.get(lc(label)) : null;
  const parents = g && Array.isArray(g.parents) ? g.parents : [];
  if (!parents.length) return '';
  const flowInfo = index && index.flowInfo instanceof Map ? index.flowInfo : new Map();
  const parentLabels = parents.map((p) => {
    const info = flowInfo.get(p);
    return info && info.label ? info.label : p;
  });
  return ` (subflow of ${parentLabels.join(', ')})`;
}

function collectFlowEntries(index, addEntry) {
  const refs = [];
  const metaCallers = index && index.metaCallers instanceof Map ? index.metaCallers : new Map();
  for (const list of metaCallers.values()) {
    for (const r of list || []) if (r && r.kind === 'flow') refs.push(r);
  }
  const externalMetaRefs = index && index.externalMetaRefs instanceof Map ? index.externalMetaRefs : new Map();
  for (const list of externalMetaRefs.values()) {
    for (const r of list || []) if (r && r.kind === 'flow') refs.push(r);
  }

  const byLabel = new Map();
  for (const r of refs) {
    if (!r || typeof r.label !== 'string' || !r.label) continue;
    if (!byLabel.has(r.label)) byLabel.set(r.label, []);
    byLabel.get(r.label).push(r);
  }

  const seenLabels = new Set();
  for (const [label, list] of byLabel) {
    let best = list[0];
    for (const r of list) {
      if ((r.line || 0) < (best.line || 0)) best = r;
    }
    // Entry.detail
    // enumerates the platform-event flow shape as the LITERAL, human-
    // readable 'platform event on <Object>' string (lowercase, spaced) --
    // NOT the generic '<triggerType> on <Object>' pattern, which would
    // otherwise render the raw metascan.js constant verbatim as
    // 'PlatformEvent on <Object>' (see PLATFORM_EVENT_TRIGGER_TYPE in
    // metascan.js / the lc(...)==='platformevent' check buildMetaChildren
    // already uses to detect this same shape). Other record-triggered shapes
    // use the raw triggerType text unchanged.
    const baseDetail = !best.flowObject
      ? 'screen or autolaunched'
      : lc(best.flowTriggerType) === 'platformevent'
        ? `platform event on ${best.flowObject}`
        : best.flowTriggerType
          ? `${best.flowTriggerType} on ${best.flowObject}`
          : 'screen or autolaunched';
    // v0.13/S2: additive suffix only -- see subflowSuffixFor's own header
    // note. `!best.flowObject` is the exact same "no <start> trigger info"
    // condition baseDetail's own fallback branch above just used.
    const detail = baseDetail + subflowSuffixFor(index, label, !!best.flowObject);
    addEntry('flow', `flow:${label}`, {
      label,
      className: null,
      methodLower: null,
      path: best.path || '',
      line: best.line || 0,
      detail,
      package: null, // metadata-sourced nodes carry no package identity anywhere else in this engine either (see buildMetaChildren)
    });
    seenLabels.add(label);
  }

  const flowFilePaths = Array.isArray(index && index.flowFilePaths) ? index.flowFilePaths : [];
  for (const p of flowFilePaths) {
    if (typeof p !== 'string' || !p) continue;
    const label = flowStemOf(p);
    if (!label || seenLabels.has(label)) continue;
    seenLabels.add(label);
    // v0.13/S2: this loop's flows never carry <start> info at all (no ref
    // survived to tell us -- see this loop's own header note on WHY a flow
    // lands here), so hasStartInfo is unconditionally false -- the same
    // additive suffix rule applies.
    addEntry('flow', `flow:${label}`, {
      label,
      className: null,
      methodLower: null,
      path: p,
      line: 0,
      detail: 'screen or autolaunched' + subflowSuffixFor(index, label, false),
      package: null,
    });
  }

  // v0.13/S2: index.flowInfo (built by attachMetaCallers, see its own header
  // note) is a THIRD, independent fallback -- it registers a flow's label
  // from ANY flow-kind ref it ever saw, including the bare/synthetic
  // (className:null) ref metascan.js emits for a flow that
  // has >=1 <subflows> element but ZERO apex actionCalls of its own (a
  // subflow-only orchestration node. That shape never reaches
  // metaCallers/externalMetaRefs at all
  // (attachMetaCallers' own local-attach loop skips any ref with no
  // className), so without this fallback such a flow would be invisible
  // here unless the CALLER separately populated index.flowFilePaths (the
  // pre-existing v0.12 mechanism, which solves the identical problem but
  // depends on extension.js remembering to set it before calling this
  // function). flowInfo also carries real flowObject/flowTriggerType/
  // flowRecordTriggerType for this shape (S1 stamps those onto the
  // synthetic ref too), so the SAME rich detail computation the byLabel
  // loop above uses applies here, not just the bare fallback string.
  const flowInfoMap = index && index.flowInfo instanceof Map ? index.flowInfo : new Map();
  for (const [, info] of flowInfoMap) {
    if (!info || typeof info.label !== 'string' || !info.label || seenLabels.has(info.label)) continue;
    seenLabels.add(info.label);
    const baseDetail = !info.flowObject
      ? 'screen or autolaunched'
      : lc(info.flowTriggerType) === 'platformevent'
        ? `platform event on ${info.flowObject}`
        : info.flowTriggerType
          ? `${info.flowTriggerType} on ${info.flowObject}`
          : 'screen or autolaunched';
    addEntry('flow', `flow:${info.label}`, {
      label: info.label,
      className: null,
      methodLower: null,
      path: info.path || '',
      line: info.line || 0,
      detail: baseDetail + subflowSuffixFor(index, info.label, !!info.flowObject),
      package: null,
    });
  }
}

function buildEntryCatalog(index) {
  finalizeFlowSubflowRefs(index); // v0.13/S2 -- see its own header note
  const groupsByKind = new Map(ENTRY_KIND_ORDER.map((k) => [k, new Map()])); // kind -> dedupeKey -> Entry
  const packageLabelsSeen = new Set();
  let excludedTestEntries = 0;
  const defaultPackage = index && index.defaultPackage != null ? index.defaultPackage : null;

  // Package is included only when it differs from the default. cm.package
  // is already null whenever opts.packageOf was inactive/didn't cover the
  // file (see buildClassMeta's own header note) -- this only additionally
  // nulls out the ONE package that's actually the workspace default, so a
  // method living in the default package never shows a redundant badge.
  function packageFor(pkgLabel) {
    if (pkgLabel == null) return null;
    if (defaultPackage != null && pkgLabel === defaultPackage) return null;
    return pkgLabel;
  }

  function addEntry(kind, dedupeKey, entry) {
    const m = groupsByKind.get(kind);
    if (!m || m.has(dedupeKey)) return; // Dedupe within kind; first registration wins.
    m.set(dedupeKey, entry);
    if (entry.package != null) packageLabelsSeen.add(entry.package);
  }

  // A method whose entries[] carries a real catalog-kind label but whose
  // owning class/method is isTest is excluded, counted once
  // per (label that would have mapped to a kind) -- not once per method --
  // so a dual-annotation isTest method still counts as 2, matching how a
  // non-excluded dual-annotation method produces 2 real Entries.
  function processMethodEntries(cm, mm) {
    if (!mm || !Array.isArray(mm.entries) || !mm.entries.length) return;
    const nameLower = lc(mm.name);
    // Constructors are never entry points (already entries:[] by
    // construction -- see buildClassMeta); accessor scopes are call-graph
    // sources only, matching the suppression suggestTargets() already
    // applies -- defensive here too, since entries[] should never actually
    // be populated for either shape.
    if (nameLower === '<init>' || nameLower === '(init)' || nameLower.startsWith('(get ') || nameLower.startsWith('(set ')) return;
    for (const label of mm.entries) {
      const kind = ENTRY_LABEL_TO_KIND[label];
      if (!kind) continue; // not an entry-annotation label this catalog recognizes (defensive; every real label is mapped above)
      if (mm.isTest) {
        excludedTestEntries++;
        continue;
      }
      let detail;
      if (label === '@future (async)') detail = '@future'; // Public label omits the internal suffix.
      else if (label === '@HttpX (REST)') detail = restDetailFor(cm, mm);
      else detail = label; // Batchable/Queueable/Schedulable and every 'others' kind: the entry annotation label verbatim, per contract
      addEntry(kind, `${cm.qualified}#${nameLower}`, {
        label: `${cm.name}.${mm.name}`,
        className: cm.qualified,
        methodLower: nameLower,
        path: cm.path,
        line: mm.line || 0,
        detail,
        package: packageFor(cm.package != null ? cm.package : null),
      });
    }
  }

  const classes = index && index.classes instanceof Map ? index.classes : new Map();
  for (const cm of classes.values()) {
    if (!cm) continue;
    if (cm.kind === 'trigger') {
      const mm = (cm.methods || []).find((m) => m.name === '(trigger)');
      // Only a '(trigger)' method that ALREADY carries the trigger entry
      // label (buildClassMeta only pushes it when file.triggerInfo was
      // present -- see its own header note) counts; this is the existing
      // structure's own gate, re-read rather than re-derived.
      if (!mm || !mm.entries || !mm.entries.some((e) => typeof e === 'string' && e.indexOf('trigger on ') === 0)) continue;
      if (mm.isTest) {
        excludedTestEntries++;
        continue;
      }
      const ti = cm.triggerInfo || {};
      const events = Array.isArray(ti.events) ? ti.events : [];
      addEntry('trigger', `${cm.qualified}#(trigger)`, {
        label: cm.name,
        className: cm.qualified,
        methodLower: '(trigger)',
        path: cm.path,
        line: mm.line || 0,
        detail: `on ${ti.object || ''} (${events.join(', ')})`,
        package: packageFor(cm.package != null ? cm.package : null),
      });
      continue;
    }
    if (cm.kind === 'anonymous') {
      const mm = (cm.methods || []).find((m) => m.name === '(anonymous)');
      if (!mm || !mm.entries || !mm.entries.includes('Anonymous Apex script')) continue;
      if (mm.isTest) {
        excludedTestEntries++;
        continue;
      }
      addEntry('anonymous', `${cm.qualified}#(anonymous)`, {
        label: cm.name,
        className: cm.qualified,
        methodLower: '(anonymous)',
        path: cm.path,
        line: mm.line || 0,
        detail: 'Anonymous Apex script',
        package: packageFor(cm.package != null ? cm.package : null),
      });
      continue;
    }
    for (const mm of cm.methods || []) processMethodEntries(cm, mm);
  }

  collectFlowEntries(index, addEntry);

  const groups = ENTRY_KIND_ORDER.map((kind) => {
    const entries = Array.from(groupsByKind.get(kind).values());
    entries.sort((a, b) => a.label.localeCompare(b.label)); // Stable sort by label.
    return { kind, label: ENTRY_KIND_GROUP_LABEL[kind], entries };
  });

  const byKind = {};
  let total = 0;
  for (const g of groups) {
    byKind[g.kind] = g.entries.length;
    total += g.entries.length;
  }
  const packages = Array.from(packageLabelsSeen).sort((a, b) => a.localeCompare(b));
  const indexStats = index && index.stats ? index.stats : {};

  return {
    groups,
    stats: {
      total,
      byKind,
      packages,
      excludedTestEntries,
      unresolvedSites: Number(indexStats.unresolvedSites) || 0,
      managedRefs: Number(indexStats.externalRefs) || 0,
    },
  };
}

// =========================================================================
// v0.14: signature-change Impact Analysis
// =========================================================================

function impactMethodSignature(method) {
  if (!method) return null;
  return `${method.name}(${(method.params || []).map((p) => p.type || 'Object').join(', ')})`;
}

function impactSameSignature(a, b) {
  if (!a || !b || lc(a.name) !== lc(b.name)) return false;
  const ap = a.params || [];
  const bp = b.params || [];
  if (ap.length !== bp.length) return false;
  for (let i = 0; i < ap.length; i++) {
    if (normalizeTypeName(ap[i].type) !== normalizeTypeName(bp[i].type)) return false;
  }
  return true;
}

function impactResolveType(index, rawType, currentCm) {
  if (!index || !(index.classes instanceof Map)) return null;
  const normalized = normalizeTypeName(rawType);
  if (!normalized) return null;
  if (currentCm && currentCm.qualified) {
    const parts = lc(currentCm.qualified).split('.');
    for (let i = parts.length; i >= 1; i--) {
      const candidate = `${parts.slice(0, i).join('.')}.${normalized}`;
      if (index.classes.has(candidate)) return candidate;
    }
  }
  if (index.classes.has(normalized)) return normalized;
  const simple = lastSegmentLower(rawType);
  const matches = [];
  for (const [key, cm] of index.classes) {
    if (cm && lc(cm.name) === simple) matches.push(key);
  }
  return matches.length === 1 ? matches[0] : null;
}

function impactSiteKey(site) {
  return [site.callerKey, site.path, site.line, site.col, site.via, site.overloadSig, site.overloadPick].join('|');
}

function impactSortSites(sites) {
  const seen = new Set();
  const out = [];
  for (const site of sites || []) {
    if (!site) continue;
    const key = impactSiteKey(site);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(site);
  }
  out.sort((a, b) =>
    String(a.callerClass || '').localeCompare(String(b.callerClass || ''))
    || String(a.callerMethod || '').localeCompare(String(b.callerMethod || ''))
    || String(a.path || '').localeCompare(String(b.path || ''))
    || (Number(a.line) || 0) - (Number(b.line) || 0)
    || (Number(a.col) || 0) - (Number(b.col) || 0)
  );
  return out;
}

// Contract surfaces can observe the same physical call twice: once against
// the interface/base declaration and once against the concrete override.
// Those copies may carry different overloadSig values even though they point
// to the same source expression, so dedupe them by physical caller location
// before presenting the contract's own caller list.
function impactSortPhysicalSites(sites) {
  const seen = new Set();
  const out = [];
  for (const site of sites || []) {
    if (!site) continue;
    const key = [site.callerKey, site.path, site.line, site.col, site.via].join('|');
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(site);
  }
  return impactSortSites(out);
}

function impactFilterSitesForSignature(sites, family, selectedSignature) {
  if (!selectedSignature || family.length <= 1) return impactSortSites(sites);
  return impactSortSites(
    (sites || []).filter(
      (site) =>
        site &&
        (site.overloadSig === selectedSignature ||
          (site.overloadPick === 'arity-tie' &&
            Array.isArray(site.tiedOverloadSigs) &&
            site.tiedOverloadSigs.includes(selectedSignature)))
    )
  );
}

function impactMethodRef(cm, classLower, method) {
  if (!cm || !method) return null;
  return {
    label: `${cm.qualified}.${impactMethodSignature(method)}`,
    classLower,
    methodLower: lc(method.name),
    overloadSig: impactMethodSignature(method),
    path: cm.path,
    line: method.line || 0,
  };
}

function impactParentFlows(index, flowLabel) {
  finalizeFlowSubflowRefs(index);
  if (!(index.flowGraph instanceof Map) || !flowLabel) return [];
  const out = [];
  const seen = new Set([lc(flowLabel)]);
  const queue = [...(((index.flowGraph.get(lc(flowLabel)) || {}).parents) || [])];
  while (queue.length) {
    const flowLower = queue.shift();
    if (seen.has(flowLower)) continue;
    seen.add(flowLower);
    const info = index.flowInfo instanceof Map ? index.flowInfo.get(flowLower) : null;
    out.push({
      label: info ? info.label : flowLower,
      path: info ? info.path : '',
      line: info ? info.line : 0,
    });
    const graph = index.flowGraph.get(flowLower);
    if (graph && Array.isArray(graph.parents)) queue.push(...graph.parents);
  }
  return out;
}

function impactMetadataSites(index, classLower, methodLower) {
  const refs = index.metaMethodCallers instanceof Map
    ? index.metaMethodCallers.get(`${classLower}#${methodLower}`) || []
    : [];
  const seen = new Set();
  const out = [];
  for (const ref of refs) {
    if (!ref) continue;
    const key = [ref.kind, ref.label, ref.path, ref.line].join('|');
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      kind: ref.kind || 'metadata',
      label: ref.label || ref.path || 'metadata reference',
      path: ref.path || '',
      line: ref.line || 0,
      className: ref.className || null,
      methodName: ref.methodName || null,
      parentFlows: ref.kind === 'flow' ? impactParentFlows(index, ref.label) : [],
    });
  }
  out.sort((a, b) => a.kind.localeCompare(b.kind) || a.label.localeCompare(b.label) || a.path.localeCompare(b.path) || a.line - b.line);
  return out;
}

// Builds a section-ready report for ONE method overload. `overloadSig` is
// optional only for non-overloaded methods; callers facing an overload
// family should choose one of the canonical signatures returned in
// `availableOverloads` before presenting the report.
function buildImpactReport(index, target) {
  target = target || {};
  const classLower = lc(target.classLower);
  const methodLower = lc(target.methodLower);
  const cm = index && index.classes instanceof Map ? index.classes.get(classLower) : null;
  if (!cm || !methodLower) return null;
  const family = (cm.methods || []).filter((m) => lc(m.name) === methodLower);
  if (!family.length) return null;
  const requestedSignature = target.overloadSig || null;
  const selectedMethod = requestedSignature
    ? family.find((m) => impactMethodSignature(m) === requestedSignature)
    : family.length === 1 ? family[0] : null;
  const availableOverloads = family.map((m) => ({
    overloadSig: impactMethodSignature(m),
    params: (m.params || []).map((p) => ({ name: p.name, type: p.type })),
    path: cm.path,
    line: m.line || 0,
  }));
  if (!selectedMethod) {
    return {
      target: {
        label: `${cm.qualified}.${family[0].name}`,
        classLower,
        methodLower,
        overloadSig: null,
        params: [],
        path: cm.path,
        line: family[0].line || 0,
      },
      availableOverloads,
      needsOverloadChoice: family.length > 1,
      breaks: [],
      mightBreak: [],
      contract: { interfaces: [], overrides: { base: null, overriddenBy: [], callersOfBase: [] } },
      metadata: [],
      otherOverloads: [],
      stats: { breaks: 0, mightBreak: 0, contractSurfaces: 0, metadataSurfaces: 0, otherOverloads: family.length },
    };
  }

  const selectedSignature = impactMethodSignature(selectedMethod);
  const directSites = impactFilterSitesForSignature(
    index.methodCallers instanceof Map ? index.methodCallers.get(`${classLower}#${methodLower}`) || [] : [],
    family,
    selectedSignature
  );
  const breaks = [];
  const mightBreak = [];
  for (const site of directSites) {
    const approximate = APPROX_VIA.has(site.via) || site.approximate === true;
    if (!approximate && site.overloadPick === 'exact') breaks.push(site);
    else mightBreak.push(site);
  }

  // Interfaces implemented by this class or any ancestor, including parent
  // interfaces. Each surface includes callers of the interface declaration,
  // which are distinct from callers already attached to this implementation.
  const interfaceEntries = [];
  const seenInterfaces = new Set();
  const interfaceQueue = [];
  let curForInterfaces = cm;
  while (curForInterfaces) {
    for (const raw of curForInterfaces.implementsTypes || []) {
      const resolved = impactResolveType(index, raw, curForInterfaces);
      if (resolved) interfaceQueue.push(resolved);
    }
    curForInterfaces = curForInterfaces.extendsLower ? index.classes.get(curForInterfaces.extendsLower) : null;
  }
  while (interfaceQueue.length) {
    const ifaceLower = interfaceQueue.shift();
    if (seenInterfaces.has(ifaceLower)) continue;
    seenInterfaces.add(ifaceLower);
    const ifaceCm = index.classes.get(ifaceLower);
    if (!ifaceCm) continue;
    const ifaceMethods = (ifaceCm.methods || []).filter((m) => impactSameSignature(m, selectedMethod));
    for (const ifaceMethod of ifaceMethods) {
      const ifaceFamily = (ifaceCm.methods || []).filter((m) => lc(m.name) === methodLower);
      const ifaceSig = impactMethodSignature(ifaceMethod);
      const declarationCallers = impactFilterSitesForSignature(
        index.methodCallers instanceof Map ? index.methodCallers.get(`${ifaceLower}#${methodLower}`) || [] : [],
        ifaceFamily,
        ifaceSig
      );
      // Interface dispatch is stored against each concrete implementer in
      // the reverse index. Fold those sites back into the contract surface
      // so an interface declaration never misleadingly shows zero callers.
      const callers = impactSortPhysicalSites(
        directSites.filter((site) => site.via === 'interface').concat(declarationCallers)
      );
      interfaceEntries.push({
        iface: ifaceCm.qualified,
        method: ifaceMethod.name,
        overloadSig: ifaceSig,
        path: ifaceCm.path,
        line: ifaceMethod.line || 0,
        callers,
      });
    }
    const rawParents = Array.isArray(ifaceCm.typeFacts && ifaceCm.typeFacts.extendsTypes)
      ? ifaceCm.typeFacts.extendsTypes
      : ifaceCm.extendsType ? [ifaceCm.extendsType] : [];
    for (const raw of rawParents) {
      const resolved = impactResolveType(index, raw, ifaceCm);
      if (resolved) interfaceQueue.push(resolved);
    }
  }
  interfaceEntries.sort((a, b) => a.iface.localeCompare(b.iface) || a.overloadSig.localeCompare(b.overloadSig));

  // Nearest overridden base declaration plus every descendant declaration
  // that overrides this exact signature.
  let base = null;
  let baseLower = cm.extendsLower || null;
  while (baseLower && !base) {
    const baseCm = index.classes.get(baseLower);
    if (!baseCm) break;
    const baseMethod = (baseCm.methods || []).find((m) => impactSameSignature(m, selectedMethod));
    if (baseMethod) base = impactMethodRef(baseCm, baseLower, baseMethod);
    baseLower = baseCm.extendsLower || null;
  }
  const callersOfBase = base
    ? impactFilterSitesForSignature(
        index.methodCallers instanceof Map ? index.methodCallers.get(`${base.classLower}#${methodLower}`) || [] : [],
        (index.classes.get(base.classLower).methods || []).filter((m) => lc(m.name) === methodLower),
        base.overloadSig
      )
    : [];
  const overriddenBy = [];
  for (const [candidateLower, candidateCm] of index.classes) {
    if (!candidateCm || candidateLower === classLower) continue;
    let ancestor = candidateCm.extendsLower || null;
    let descendsFromTarget = false;
    const seenAncestors = new Set();
    while (ancestor && !seenAncestors.has(ancestor)) {
      seenAncestors.add(ancestor);
      if (ancestor === classLower) {
        descendsFromTarget = true;
        break;
      }
      const ancestorCm = index.classes.get(ancestor);
      ancestor = ancestorCm ? ancestorCm.extendsLower || null : null;
    }
    if (!descendsFromTarget) continue;
    const method = (candidateCm.methods || []).find((m) => impactSameSignature(m, selectedMethod));
    if (method) overriddenBy.push(impactMethodRef(candidateCm, candidateLower, method));
  }
  overriddenBy.sort((a, b) => a.label.localeCompare(b.label));

  const metadata = impactMetadataSites(index, classLower, methodLower);
  const otherOverloads = family
    .filter((m) => m !== selectedMethod)
    .map((m) => {
      const overloadSig = impactMethodSignature(m);
      return {
        overloadSig,
        callerCount: impactFilterSitesForSignature(
          index.methodCallers instanceof Map ? index.methodCallers.get(`${classLower}#${methodLower}`) || [] : [],
          family,
          overloadSig
        ).length,
        path: cm.path,
        line: m.line || 0,
      };
    });

  const contractSurfaces = interfaceEntries.length + (base ? 1 : 0) + overriddenBy.length;
  return {
    target: {
      label: `${cm.qualified}.${selectedSignature}`,
      classLower,
      methodLower,
      overloadSig: selectedSignature,
      params: (selectedMethod.params || []).map((p) => ({ name: p.name, type: p.type })),
      path: cm.path,
      line: selectedMethod.line || 0,
    },
    availableOverloads,
    needsOverloadChoice: false,
    breaks: impactSortSites(breaks),
    mightBreak: impactSortSites(mightBreak),
    contract: {
      interfaces: interfaceEntries,
      overrides: { base, overriddenBy, callersOfBase },
    },
    metadata,
    otherOverloads,
    stats: {
      breaks: breaks.length,
      mightBreak: mightBreak.length,
      contractSurfaces,
      metadataSurfaces: metadata.length,
      otherOverloads: otherOverloads.length,
    },
  };
}

module.exports = {
  buildSemanticIndex,
  buildCallerTree,
  buildCalleeTree,
  suggestTargets,
  attachMetaCallers,
  // v0.12/C1: Entry Point Catalog -- see buildEntryCatalog's own header
  // comment for the full contract.
  buildEntryCatalog,
  buildImpactReport,
  impactMethodSignature,
  // v0.10/A3: exported for direct unit-level pinning of the clamp math
  // itself (test-resolver.js) -- every OTHER export above is exercised only
  // behaviorally; clampInt is a pure, easily-isolated function, and the
  // clamp boundaries (NaN/-5/1e9/Infinity/'x' inputs) are exactly the kind
  // of thing best pinned directly rather than inferred from tree shape.
  clampInt,
};

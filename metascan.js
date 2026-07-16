'use strict';
// Metadata-caller scanner — amendment A5. Pure data-in/data-out: no vscode,
// no fs, no dependency on parser.js or resolver.js. Extracts "someone calls
// an Apex class/method from non-Apex metadata" facts from LWC, Aura, Flow,
// OmniScript, and Visualforce source text, so resolver.js (amendment A6,
// out of scope here) can attach them to the call-graph as terminal callers.
//
// Contract (frozen for this file):
//
//   parseMetaFile({path, text}) -> [MetaRef]
//   MetaRef = { kind:'lwc'|'aura'|'flow'|'omniscript'|'vf'|'cmdt', label,
//               className, methodName:string|null, line, lineText }
//
//   scanBundle(files) -> [MetaRef]      // files: [{path, text}]
//
// v0.4 (F1b/F4b) additions to the MetaRef shape, both purely additive (every
// pre-existing field/kind keeps its exact v0.3 meaning):
//
//   - kind:'flow' refs gain two extra fields, always present (null when not
//     applicable): { flowObject: string|null, flowRecordTriggerType:
//     string|null }. Extracted once per file from the Flow's <start> block
//     and stamped onto EVERY apex-actionCalls ref parseMetaFile() emits for
//     that file (a flow has exactly one <start> block, so this is a
//     file-level fact, not a per-actionCalls-block one). Only populated when
//     <start><triggerType> is one of the three record-triggered values
//     (RecordBeforeSave/RecordAfterSave/RecordBeforeDelete) -- Screen Flows
//     and plain Autolaunched Flows with no record trigger leave both null.
//     This is resolver.js's (out of scope here) hook for treating a
//     record-triggered flow node as non-terminal; metascan only extracts the
//     raw fact, it does not decide what a resolver does with it.
//   - kind:'cmdt' (new): one ref per <values> block in a
//     customMetadata/*.md-meta.xml record whose <value>...</value> text
//     LOOKS like an Apex identifier (metascan does not check whether it
//     names a real class -- that is resolver.js's job). Shape: { kind:
//     'cmdt', label, className: <the value text>, methodName: null, line,
//     lineText, fieldName: <the sibling <field> text, or null> }.
//
// v0.5 (G1) addition to the MetaRef 'flow' shape, purely additive (the two
// v0.4 fields above keep their exact meaning -- flowRecordTriggerType stays
// null for a platform-event flow, since a real <start> block for one never
// carries a <recordTriggerType> element at all):
//
//   - kind:'flow' refs gain a third always-present field:
//     { flowTriggerType: string|null } -- the raw <start><triggerType> text
//     verbatim, but ONLY when it is one of the four triggerTypes metascan
//     recognizes (the pre-existing three record-triggered values, or the new
//     'PlatformEvent'); any other/absent <triggerType> (Screen Flows,
//     record-agnostic Autolaunched Flows, or an unrecognized future value)
//     leaves it null, same as the other two fields. For a platform-event
//     flow specifically, flowObject is ALSO now populated (the event
//     object's API name, e.g. 'Acme_Note__e', from the same <start><object>
//     element record-triggered flows use) while flowRecordTriggerType stays
//     null -- flowTriggerType==='PlatformEvent' is what tells a downstream
//     consumer (resolver.js, out of scope here) this is the platform-event
//     shape rather than a record-triggered flow with a missing
//     <recordTriggerType> (both leave flowRecordTriggerType null, but only
//     one sets flowTriggerType to 'PlatformEvent'). Per the G1(b) spec, a
//     platform-event-triggered flow node's children are the EventBus.publish
//     sites on that object -- the same shape v0.4's record-triggered
//     flowObject/flowRecordTriggerType pair uses for DML children, just a
//     different child-materialization rule on the resolver side.
//
// v0.7.1 (M1, gauntlet-round namespace fix) addition to the MetaRef 'lwc'
// shape, purely additive (className/methodName keep their exact pre-existing
// meaning -- still the bare last-two dot-segments of the specifier):
//
//   - kind:'lwc' refs gain an always-present field: { namespace: string|null }
//     -- the dot-segment(s) BEFORE the trailing Class.method pair of a
//     `@salesforce/apex/...` specifier, verbatim (not case-normalized).
//     `@salesforce/apex/zenq.KappaGateway.dispatch` (3 segments) now yields
//     { className:'KappaGateway', methodName:'dispatch', namespace:'zenq' }
//     instead of silently discarding 'zenq' as v0.6 and earlier did. A bare
//     2-segment specifier (`Class.method`, no namespace prefix) leaves
//     namespace: null, exactly matching its pre-v0.7.1 output otherwise.
//     4+-segment specifiers (e.g. `ns.Outer.Inner.method`) fold every leading
//     segment before the trailing pair into one dot-joined namespace string
//     (`'ns.Outer'`) -- best-effort, never throws, same tolerant posture as
//     the rest of this file.
//     metascan.js does NOT decide what a namespaced ref means for attach
//     purposes -- this file has no knowledge of the local workspace's class
//     index (see the header contract above: no dependency on parser.js or
//     resolver.js) and never attaches anything itself. It only preserves the
//     namespace signal faithfully so a downstream consumer -- resolver.js's
//     attachMetaCallers(), out of scope here -- can gate on it per the M2
//     fix: a non-null namespace means this ref names a method that belongs
//     to a namespace the LOCAL (unmanaged, no-namespace) workspace does not
//     own, so it must never be re-pointed at a local class purely because
//     the bare tail segments happen to match (VALIDATION-REPORT.md Tier-1
//     #1: `@salesforce/apex/zenq.KappaGateway.dispatch` previously collapsed
//     onto local `KappaGateway.dispatch`, `via=metadata`, zero gating).
//
// Design notes:
//
// - `label` is always the file's stem (its Salesforce API name) — see
//   stemOf() below for the compound-extension list (.flow-meta.xml,
//   .os-meta.xml, etc.) that a naive "strip the last dot" would mangle.
// - `line`/`lineText` are BEST-EFFORT: the line of the matched element
//   (import specifier, controller= attribute, actionName, remoteMethod key,
//   ...), 1-based, with lineText trimmed the same way parser.js trims
//   CallFacts.lineText.
// - Every extractor is regex/text based (no XML/JS parser dependency, no
//   new npm deps per the task brief) and is deliberately tolerant: a file
//   that doesn't match the expected shape yields zero refs, never throws.
// - Aura is the one source that needs CROSS-FILE context: a bundle's
//   Controller/Helper .js only ever says `component.get('c.methodName')` —
//   the class it belongs to is declared on a SIBLING .cmp/.app's
//   `controller="..."` attribute, not in the .js file itself. Design
//   decision (per the task brief's "pick one, document it"): parseMetaFile()
//   run on a single .cmp/.app still yields the CLASS-LEVEL ref (that needs
//   no pairing), but a single .js file passed to parseMetaFile() alone
//   yields NOTHING for Aura (no bundle context available). Callers that want
//   full Aura coverage (class-level AND method-level) must call
//   scanBundle(files) with the bundle's files (markup + controller/helper
//   JS) together — it re-derives the class-level ref itself, so a caller
//   never needs to combine parseMetaFile() and scanBundle() output for the
//   same Aura files (that would double-count the class-level ref).
// - LWC `__tests__` exclusion: Jest spec files import the same
//   `@salesforce/apex/Cls.method` specifier as the component under test (to
//   `jest.mock()` it) but represent zero real Apex call edges — excluded by
//   path, matching the corpus's acmeQuoteWizard.test.js fixture.

// --- small path/text helpers ---------------------------------------------

// Compound extensions that a plain "strip the last dot" would butcher (e.g.
// 'Foo.flow-meta.xml'.replace(/\.[^.]+$/, '') would leave 'Foo.flow-meta').
const COMPOUND_EXT = /\.(flow-meta\.xml|os-meta\.xml|cmp-meta\.xml|app-meta\.xml|js-meta\.xml|page-meta\.xml|component-meta\.xml|cls-meta\.xml|trigger-meta\.xml|md-meta\.xml)$/i;

function baseNameOf(p) {
  const s = String(p || '');
  const idx = Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\'));
  return idx === -1 ? s : s.slice(idx + 1);
}

function dirOf(p) {
  const s = String(p || '');
  const idx = Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\'));
  return idx === -1 ? '' : s.slice(0, idx);
}

// file stem = the API name Salesforce would use to reference this metadata
// component (strip the extension, tolerant of compound `-meta.xml` suffixes).
function stemOf(p) {
  const base = baseNameOf(p);
  if (COMPOUND_EXT.test(base)) return base.replace(COMPOUND_EXT, '');
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(0, dot) : base;
}

function buildLineIndex(text) {
  const starts = [0];
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 10 /* \n */) starts.push(i + 1);
  }
  return starts;
}

function lineForIndex(lineStarts, idx) {
  // binary search for the last line-start <= idx
  let lo = 0;
  let hi = lineStarts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (lineStarts[mid] <= idx) lo = mid;
    else hi = mid - 1;
  }
  return lo + 1;
}

function lineTextForIndex(text, lineStarts, idx) {
  const line = lineForIndex(lineStarts, idx);
  const start = lineStarts[line - 1];
  let end = text.indexOf('\n', start);
  if (end === -1) end = text.length;
  return text.slice(start, end).trim();
}

function isExcludedPath(p) {
  return /__tests__/i.test(String(p || ''));
}

function makeRef(kind, label, className, methodName, text, lineStarts, idx) {
  return {
    kind,
    label,
    className,
    methodName: methodName == null ? null : methodName,
    line: lineForIndex(lineStarts, idx),
    lineText: lineTextForIndex(text, lineStarts, idx),
  };
}

// --- LWC -------------------------------------------------------------------
// import x from '@salesforce/apex/Cls.method';  -- multi-line tolerant
// (the `\s` between `from` and the quote already matches newlines), and
// namespace-dotted specifiers (`@salesforce/apex/ns.Cls.method`) tolerated:
// className/methodName are always the LAST TWO dot-separated segments, and
// (v0.7.1, M1) any leading segment(s) before that pair are now retained
// verbatim on the ref's `namespace` field instead of being discarded -- see
// the v0.7.1 (M1) header note above for the full contract.
// `import { refreshApex } from '@salesforce/apex';` (no trailing /Cls.method)
// deliberately does not match — there's no method to attribute it to.
const LWC_IMPORT_RE = /from\s+['"]@salesforce\/apex\/([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)+)['"]/g;

function extractLwc(path, text, lineStarts, out) {
  const label = stemOf(path);
  LWC_IMPORT_RE.lastIndex = 0;
  let m;
  while ((m = LWC_IMPORT_RE.exec(text))) {
    const segs = m[1].split('.');
    const methodName = segs[segs.length - 1];
    const className = segs[segs.length - 2];
    // v0.7.1 (M1): segments before the Class.method pair are the namespace
    // prefix -- null for a bare 2-segment specifier, dot-joined verbatim
    // (case preserved) for 3+ segments. Never discarded.
    const namespace = segs.length > 2 ? segs.slice(0, segs.length - 2).join('.') : null;
    const ref = makeRef('lwc', label, className, methodName, text, lineStarts, m.index);
    ref.namespace = namespace;
    out.push(ref);
  }
}

// --- Aura --------------------------------------------------------------
const AURA_ROOT_RE = /<aura:(?:component|application)\b[\s\S]*?>/;
const CONTROLLER_ATTR_RE = /\bcontroller\s*=\s*["']([\w.]+)["']/;
const AURA_GET_RE = /component\s*\.\s*get\(\s*['"]c\.([A-Za-z_]\w*)['"]\s*\)/g;

// Class-level only: `<aura:component controller="Cls" ...>` on a single
// .cmp/.app file. No bundle context needed or used.
function extractAuraClassLevel(path, text, lineStarts, out) {
  const rootMatch = AURA_ROOT_RE.exec(text);
  if (!rootMatch) return;
  const tag = rootMatch[0];
  const ctrlMatch = CONTROLLER_ATTR_RE.exec(tag);
  if (!ctrlMatch) return;
  const idx = rootMatch.index + ctrlMatch.index;
  const label = stemOf(path);
  out.push(makeRef('aura', label, ctrlMatch[1], null, text, lineStarts, idx));
}

// --- Flow ------------------------------------------------------------------
// <actionCalls> blocks with <actionType>apex</actionType>; actionName is
// either bare (class only, e.g. an @InvocableMethod class name) or dotted
// (Class.method, e.g. a plain Apex action). Non-apex actionTypes (emailSimple,
// etc.) and <subflows> blocks are out of scope for this amendment (Flow XML
// never names a subflow's Apex, if any — that's a flow-to-flow edge, not an
// Apex one) and are simply not matched.
const ACTION_CALLS_RE = /<actionCalls>([\s\S]*?)<\/actionCalls>/g;
const ACTION_TYPE_APEX_RE = /<actionType>\s*apex\s*<\/actionType>/i;
const ACTION_NAME_RE = /<actionName>([^<]+)<\/actionName>/;
const ACTION_CALLS_OPEN_TAG = '<actionCalls>';

// F1(b): <start> block extraction -- a Flow has exactly one <start> block,
// so this is computed once per file (see extractFlow below) rather than per
// actionCalls match. Only record-triggered Flows (<triggerType> one of the
// three RecordBefore*/RecordAfterSave values) carry a meaningful
// object/recordTriggerType pair; Screen Flows and record-agnostic
// Autolaunched Flows leave <object>/<recordTriggerType> absent from <start>
// entirely, so this correctly yields {null, null} for those.
const FLOW_START_RE = /<start>([\s\S]*?)<\/start>/;
const FLOW_START_OBJECT_RE = /<object>([^<]+)<\/object>/;
const FLOW_START_TRIGGER_TYPE_RE = /<triggerType>([^<]+)<\/triggerType>/;
const FLOW_START_RECORD_TRIGGER_TYPE_RE = /<recordTriggerType>([^<]+)<\/recordTriggerType>/;
const RECORD_TRIGGERED_TYPES = new Set(['RecordBeforeSave', 'RecordAfterSave', 'RecordBeforeDelete']);
// G1(b): the fourth recognized <start><triggerType> value -- a platform-event
// flow's <start> block carries <object> (the published event's API name) but
// never <recordTriggerType> (that element only ever appears on the three
// RecordBefore*/RecordAfterSave shapes above).
const PLATFORM_EVENT_TRIGGER_TYPE = 'PlatformEvent';

function extractFlowStart(text) {
  const startMatch = FLOW_START_RE.exec(text);
  if (!startMatch) return { flowObject: null, flowRecordTriggerType: null, flowTriggerType: null };
  const block = startMatch[1];
  const triggerTypeMatch = FLOW_START_TRIGGER_TYPE_RE.exec(block);
  const triggerType = triggerTypeMatch ? triggerTypeMatch[1].trim() : null;

  if (triggerType === PLATFORM_EVENT_TRIGGER_TYPE) {
    const objectMatch = FLOW_START_OBJECT_RE.exec(block);
    return {
      flowObject: objectMatch ? objectMatch[1].trim() : null,
      flowRecordTriggerType: null,
      flowTriggerType: PLATFORM_EVENT_TRIGGER_TYPE,
    };
  }

  if (!triggerType || !RECORD_TRIGGERED_TYPES.has(triggerType)) {
    return { flowObject: null, flowRecordTriggerType: null, flowTriggerType: null };
  }
  const objectMatch = FLOW_START_OBJECT_RE.exec(block);
  const recordTriggerTypeMatch = FLOW_START_RECORD_TRIGGER_TYPE_RE.exec(block);
  return {
    flowObject: objectMatch ? objectMatch[1].trim() : null,
    flowRecordTriggerType: recordTriggerTypeMatch ? recordTriggerTypeMatch[1].trim() : null,
    flowTriggerType: triggerType,
  };
}

function extractFlow(path, text, lineStarts, out) {
  const label = stemOf(path);
  const start = extractFlowStart(text);
  ACTION_CALLS_RE.lastIndex = 0;
  let bm;
  while ((bm = ACTION_CALLS_RE.exec(text))) {
    const block = bm[1];
    if (!ACTION_TYPE_APEX_RE.test(block)) continue;
    const nameMatch = ACTION_NAME_RE.exec(block);
    if (!nameMatch) continue;
    const dotted = nameMatch[1].trim();
    const segs = dotted.split('.');
    const className = segs[0];
    const methodName = segs.length > 1 ? segs.slice(1).join('.') : null;
    const blockStart = bm.index + ACTION_CALLS_OPEN_TAG.length;
    const idx = blockStart + nameMatch.index;
    const ref = makeRef('flow', label, className, methodName, text, lineStarts, idx);
    ref.flowObject = start.flowObject;
    ref.flowRecordTriggerType = start.flowRecordTriggerType;
    ref.flowTriggerType = start.flowTriggerType;
    out.push(ref);
  }
}

// --- OmniScript --------------------------------------------------------
// *.os-meta.xml: pair each <remoteClass> with the next <remoteMethod> found
// after it in source order (matches the corpus's one-block-per-remote-action
// layout; best-effort for arbitrarily interleaved XML).
const REMOTE_CLASS_XML_RE = /<remoteClass>([^<]+)<\/remoteClass>/g;
// H7(c): global (was non-global) so extractOmniscriptXml can drive it with
// `.lastIndex` directly against the FULL text instead of calling
// `text.slice(afterIdx)` per <remoteClass> match. The old slice-per-match
// loop was O(N*len) -- every match allocated a fresh copy of the remainder
// of the file just to search it once -- which dominates on a large OmniScript
// XML file with many remote actions. Index-based scanning (seek
// `.lastIndex` forward, exec against the same unsliced `text`) finds the
// exact same first-match-after-afterIdx result with zero extra allocation.
const REMOTE_METHOD_XML_RE = /<remoteMethod>([^<]+)<\/remoteMethod>/g;

function extractOmniscriptXml(path, text, lineStarts, out) {
  const label = stemOf(path);
  REMOTE_CLASS_XML_RE.lastIndex = 0;
  let cm;
  while ((cm = REMOTE_CLASS_XML_RE.exec(text))) {
    const className = cm[1].trim();
    const afterIdx = cm.index + cm[0].length;
    REMOTE_METHOD_XML_RE.lastIndex = afterIdx;
    const mm = REMOTE_METHOD_XML_RE.exec(text);
    if (!mm) continue;
    const methodName = mm[1].trim();
    const idx = mm.index;
    out.push(makeRef('omniscript', label, className, methodName, text, lineStarts, idx));
  }
}

// *.json OmniScript/Integration-Procedure DataPacks: recursively walk the
// PARSED structure for objects that directly declare sibling string
// properties `remoteClass`/`remoteMethod`. Deliberately NOT a text regex
// over the raw file: DataPacks also carry a `..._PropertySet__c` field whose
// VALUE is a JSON-encoded STRING containing an escaped, compacted copy of
// the same remoteClass/remoteMethod pair (`"...\"remoteClass\":\"X\"..."`)
// — walking the parsed object tree visits the real (unescaped, pretty)
// `PropertySetJSON` object exactly once and never descends into that escaped
// string duplicate (a string has no properties to recurse into), so no
// double-counting.
//
// H7(c): depth-capped at MAX_JSON_DEPTH (64) -- an adversarial or corrupt
// DataPack JSON file with pathological nesting (or, less maliciously, a
// deeply self-referential-looking but still tree-shaped payload) could
// otherwise recurse until the call stack blows -- this function's contract
// (parseMetaFile()/extractOmniscriptJson() never throw) would be violated by
// an uncaught RangeError. 64 is comfortably deeper than any real Vlocity/
// OmniStudio DataPack shape in the corpus (nesting bottoms out a handful of
// levels in) while still bounding worst-case stack usage. Nodes beyond the
// cap are simply not descended into -- same "best-effort, never throw"
// posture as the rest of this file, not a hard error.
const MAX_JSON_DEPTH = 64;

function walkJsonForRemotePairs(node, pairs, depth) {
  depth = depth || 0;
  if (depth > MAX_JSON_DEPTH) return;
  if (node === null || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    for (const item of node) walkJsonForRemotePairs(item, pairs, depth + 1);
    return;
  }
  if (typeof node.remoteClass === 'string' && typeof node.remoteMethod === 'string') {
    pairs.push({ remoteClass: node.remoteClass, remoteMethod: node.remoteMethod });
  }
  for (const key of Object.keys(node)) {
    walkJsonForRemotePairs(node[key], pairs, depth + 1);
  }
}

function extractOmniscriptJson(path, text, lineStarts, out) {
  let root;
  try {
    root = JSON.parse(text);
  } catch (e) {
    return; // not valid JSON (or not a DataPack) -- yield nothing, never throw
  }
  const pairs = [];
  walkJsonForRemotePairs(root, pairs);
  if (pairs.length === 0) return;
  const label = stemOf(path);
  // Locate each pair's real (unescaped) `"remoteClass"`/`"remoteMethod"` key
  // in raw text, advancing a cursor so repeated method names still get
  // distinct, monotonically-increasing line numbers matching parse order.
  // The escaped duplicate inside `..._PropertySet__c` is backslash-escaped
  // in raw text (`\"remoteClass\"`), so it never matches the literal
  // (unescaped) needle below.
  let cursor = 0;
  for (const pair of pairs) {
    let classIdx = text.indexOf('"remoteClass"', cursor);
    if (classIdx === -1) classIdx = cursor;
    let methodIdx = text.indexOf('"remoteMethod"', classIdx);
    let idx;
    if (methodIdx !== -1) {
      idx = methodIdx;
      cursor = methodIdx + '"remoteMethod"'.length;
    } else {
      idx = classIdx;
      cursor = classIdx + '"remoteClass"'.length;
    }
    out.push(makeRef('omniscript', label, pair.remoteClass, pair.remoteMethod, text, lineStarts, idx));
  }
}

// --- Custom Metadata (F4b) ------------------------------------------------
// customMetadata/<Type>.<RecordName>.md-meta.xml: one ref per <values> block
// whose <value>...</value> text looks like a bare Apex identifier (a class
// name). Deliberately does NOT check whether that identifier names a real
// class in the workspace -- that requires the semantic index and is
// resolver.js's job (out of scope here); a value like a picklist label,
// number, or Id string simply fails the identifier shape test and is
// skipped, never mis-extracted as a false positive class reference.
const CMDT_VALUES_RE = /<values>([\s\S]*?)<\/values>/g;
const CMDT_FIELD_RE = /<field>([^<]+)<\/field>/;
const CMDT_VALUE_RE = /<value\b[^>]*>([^<]*)<\/value>/;
const CMDT_VALUES_OPEN_TAG = '<values>';
const APEX_IDENTIFIER_RE = /^[A-Za-z_]\w*$/;

function extractCmdt(path, text, lineStarts, out) {
  const label = stemOf(path);
  CMDT_VALUES_RE.lastIndex = 0;
  let bm;
  while ((bm = CMDT_VALUES_RE.exec(text))) {
    const block = bm[1];
    const valueMatch = CMDT_VALUE_RE.exec(block);
    if (!valueMatch) continue;
    const rawValue = valueMatch[1].trim();
    if (!APEX_IDENTIFIER_RE.test(rawValue)) continue; // not identifier-shaped -- skip
    const fieldMatch = CMDT_FIELD_RE.exec(block);
    const fieldName = fieldMatch ? fieldMatch[1].trim() : null;
    const blockStart = bm.index + CMDT_VALUES_OPEN_TAG.length;
    const idx = blockStart + valueMatch.index;
    const ref = makeRef('cmdt', label, rawValue, null, text, lineStarts, idx);
    ref.fieldName = fieldName;
    out.push(ref);
  }
}

// --- Visualforce ---------------------------------------------------------
// <apex:page controller="Cls" extensions="Ext1,Ext2" ...> (or apex:component).
// No fixtures exist in adv-org for this source type; still implemented per
// the documented pattern, exercised only by inline fixtures below.
const VF_ROOT_RE = /<apex:(?:page|component)\b[\s\S]*?>/;
const VF_EXTENSIONS_ATTR_RE = /\bextensions\s*=\s*["']([^"']+)["']/;

function extractVf(path, text, lineStarts, out) {
  const rootMatch = VF_ROOT_RE.exec(text);
  if (!rootMatch) return;
  const tag = rootMatch[0];
  const label = stemOf(path);

  const ctrlMatch = CONTROLLER_ATTR_RE.exec(tag);
  if (ctrlMatch) {
    const idx = rootMatch.index + ctrlMatch.index;
    out.push(makeRef('vf', label, ctrlMatch[1], null, text, lineStarts, idx));
  }

  const extMatch = VF_EXTENSIONS_ATTR_RE.exec(tag);
  if (extMatch) {
    const idx = rootMatch.index + extMatch.index;
    const classes = extMatch[1]
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    for (const cls of classes) {
      out.push(makeRef('vf', label, cls, null, text, lineStarts, idx));
    }
  }
}

// --- dispatch ----------------------------------------------------------

/**
 * parseMetaFile({path, text}) -> [MetaRef]
 *
 * Single-file entry point. Routes on file extension:
 *   .js                -> LWC `@salesforce/apex` imports (skipped for
 *                          __tests__ paths; also yields nothing for an
 *                          Aura controller/helper .js -- see scanBundle()).
 *   .cmp / .app         -> Aura class-level `controller="..."` attribute.
 *   .flow-meta.xml      -> Flow apex actionCalls (+ F1b <start> object/
 *                          recordTriggerType stamped onto every ref).
 *   .os-meta.xml        -> OmniScript XML remoteClass/remoteMethod.
 *   .json               -> OmniScript/IP DataPack remoteClass/remoteMethod.
 *   .page / .component  -> Visualforce controller=/extensions=.
 *   .md-meta.xml        -> F4b Custom Metadata identifier-shaped <value>s.
 * Anything else (including malformed input) yields an empty array; this
 * function never throws.
 */
function parseMetaFile(file) {
  const out = [];
  if (!file || typeof file.text !== 'string' || typeof file.path !== 'string' || !file.path) {
    return out;
  }
  const path = file.path;
  const text = file.text;
  if (isExcludedPath(path)) return out;

  const lineStarts = buildLineIndex(text);

  try {
    if (/\.js$/i.test(path)) {
      extractLwc(path, text, lineStarts, out);
    } else if (/\.(cmp|app)$/i.test(path)) {
      extractAuraClassLevel(path, text, lineStarts, out);
    } else if (/\.flow-meta\.xml$/i.test(path)) {
      extractFlow(path, text, lineStarts, out);
    } else if (/\.os-meta\.xml$/i.test(path)) {
      extractOmniscriptXml(path, text, lineStarts, out);
    } else if (/\.md-meta\.xml$/i.test(path)) {
      extractCmdt(path, text, lineStarts, out);
    } else if (/\.json$/i.test(path)) {
      extractOmniscriptJson(path, text, lineStarts, out);
    } else if (/\.(page|component)$/i.test(path)) {
      extractVf(path, text, lineStarts, out);
    }
  } catch (e) {
    // defensive: parseMetaFile must never throw, mirroring parser.js's
    // parseFile() contract -- fall through to whatever was gathered so far.
  }

  return out;
}

/**
 * scanBundle(files) -> [MetaRef]
 *
 * files: [{path, text}] -- any collection of Aura-bundle files (markup +
 * controller/helper JS), from one or many bundles; non-Aura files are
 * ignored (use parseMetaFile() for LWC/Flow/OmniScript/VF). Groups files by
 * directory, then per group: finds the .cmp/.app root's `controller="..."`
 * attribute (the class-level ref, re-derived here -- do not ALSO call
 * parseMetaFile() on the same .cmp/.app or the class-level ref double-counts)
 * and pairs every `component.get('c.methodName')` found in that group's
 * .js files with that class, producing the method-level refs. A group with
 * no markup (no resolvable controller class) yields nothing for its .js
 * files -- there is no class to attribute them to.
 */
function scanBundle(files) {
  const out = [];
  if (!Array.isArray(files)) return out;

  const groups = new Map(); // dir -> { markup:{path,text}|null, jsFiles:[{path,text}] }
  for (const f of files) {
    if (!f || typeof f.path !== 'string' || typeof f.text !== 'string') continue;
    if (isExcludedPath(f.path)) continue;
    // "aura/" as a path segment anywhere -- (^|separator) before, separator
    // after -- so this matches both absolute corpus paths
    // (.../force-app/main/default/aura/Bundle/Bundle.cmp) and bundle-relative
    // fixture paths (aura/Bundle/Bundle.cmp) with no leading separator.
    if (!/(^|[\\/])aura[\\/]/i.test(f.path)) continue;

    const dir = dirOf(f.path);
    let g = groups.get(dir);
    if (!g) {
      g = { markup: null, jsFiles: [] };
      groups.set(dir, g);
    }
    if (/\.(cmp|app)$/i.test(f.path)) {
      g.markup = f;
    } else if (/\.js$/i.test(f.path)) {
      g.jsFiles.push(f);
    }
  }

  for (const g of groups.values()) {
    if (!g.markup) continue;

    const classRefs = [];
    extractAuraClassLevel(g.markup.path, g.markup.text, buildLineIndex(g.markup.text), classRefs);
    for (const ref of classRefs) out.push(ref);
    if (classRefs.length === 0) continue; // no controller declared -> nothing to attribute method-level refs to

    const controllerClass = classRefs[0].className;
    const label = classRefs[0].label;

    for (const jsFile of g.jsFiles) {
      const lineStarts = buildLineIndex(jsFile.text);
      AURA_GET_RE.lastIndex = 0;
      let m;
      while ((m = AURA_GET_RE.exec(jsFile.text))) {
        out.push(makeRef('aura', label, controllerClass, m[1], jsFile.text, lineStarts, m.index));
      }
    }
  }

  return out;
}

module.exports = { parseMetaFile, scanBundle };

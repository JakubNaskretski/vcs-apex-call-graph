'use strict';
// kinds.js -- the single kind registry. Pure data + pure string helpers.
// No requires (not even other repo modules): metascan.js's header contract
// forbids vscode/fs/parser.js/resolver.js, and this file must stay
// requireable from EVERY consumer, metascan included. Everything exported
// is deep-frozen -- consumers read, never write.
//
// Two keyspaces live here:
//   - NODE kinds: MetaRef.kind / metadata TNode.kind values ('flow', 'lwc',
//     ...), disjoint from the Apex TNode kinds
//     ('class'|'method'|'trigger'|'anonymous'|'exception'|'external'|
//     'unresolved'|'rollup'|'constructor').
//   - CATALOG groups: Entry Points top-level buckets ('trigger', 'aura',
//     'invocable', ...). Overlaps node kinds by NAME ('flow', 'aura'), but
//     is a separate keyspace.
//
// Milestone flags: `traceable` and `store` flip on in the work package that
// ships the behavior (m2-roots: flow traceable; m3-lwc-core: lwc traceable;
// m2-store consumes store). Globs/compound extensions likewise land in the
// package that adds the extractor -- the commented values are BINDING
// (plans/CONTRACTS.local.md) and must be used verbatim when flipped on.

const NODE_KINDS = [
  {
    key: 'flow',
    labelSingular: 'Flow', labelPlural: 'Flows',
    entryLabel: 'Flow apex action',
    treeIcon: 'symbol-event',
    mapVisual: { cssKey: 'flow', chipLabel: 'Flow', tone: 'automation' },
    mapAccent: 'metadata',
    catalogGroup: 'flow',
    traceable: false,                  // m2-roots flips true
    store: true,
    viaKinds: [
      { via: 'subflow',   glossary: 'flow-to-subflow reference declared in Flow XML' },
      { via: 'interview', glossary: 'Apex new Flow.Interview.X(...) / createInterview(...) launch of this flow' },
      { via: 'screen',    glossary: 'flow screen field embedding a custom LWC/Aura component' },
    ],
    globs: ['**/flows/**/*.flow-meta.xml'],
    compoundExts: ['flow-meta.xml'],
    overlayExts: ['xml'],
  },
  {
    key: 'lwc',
    labelSingular: 'LWC component', labelPlural: 'LWC components',
    entryLabel: '@salesforce/apex import',
    treeIcon: 'symbol-interface',
    mapVisual: { cssKey: 'lwc', chipLabel: 'LWC', tone: 'interface' },
    mapAccent: 'metadata',
    catalogGroup: 'lwc',               // group row itself ships m3-lwc-core
    traceable: false,                  // m3-lwc-core flips true
    store: true,
    viaKinds: [
      { via: 'composition', glossary: 'component embeds/imports another component (template tag or c/x import)' },
    ],
    globs: ['**/lwc/**/*.js'],         // m3-lwc-core adds '**/lwc/**/*.html', '**/lwc/**/*.js-meta.xml'
    compoundExts: ['js-meta.xml'],
    overlayExts: ['js'],               // m3-lwc-core adds 'html', 'xml'
  },
  {
    key: 'aura',
    labelSingular: 'Aura component', labelPlural: 'Aura components',
    entryLabel: 'Aura controller',
    treeIcon: 'browser',
    mapVisual: { cssKey: 'aura', chipLabel: 'Aura', tone: 'interface' },
    mapAccent: 'metadata',
    catalogGroup: null,
    traceable: false,
    store: true,                       // node ids needed as composition/surface targets (m4)
    viaKinds: [],                      // 'composition' contributed by the lwc entry; sets are unioned
    globs: ['**/aura/**/*.cmp', '**/aura/**/*.app', '**/aura/**/*.js'],
    compoundExts: ['cmp-meta.xml', 'app-meta.xml'],
    overlayExts: ['cmp', 'app', 'js'],
  },
  {
    key: 'omniscript',
    labelSingular: 'OmniScript', labelPlural: 'OmniScripts',
    entryLabel: 'OmniScript Remote Action',
    treeIcon: 'json',
    mapVisual: { cssKey: 'omniscript', chipLabel: 'OmniScript', tone: 'automation' },
    mapAccent: 'metadata',
    catalogGroup: null, traceable: false, store: false,
    viaKinds: [],
    globs: ['**/omniscripts/**/*.os-meta.xml', '**/omniscripts/**/*.json'],
    compoundExts: ['os-meta.xml'],
    overlayExts: ['xml', 'json'],
  },
  {
    key: 'vf',
    labelSingular: 'Visualforce page', labelPlural: 'Visualforce pages',
    entryLabel: 'VF controller',
    treeIcon: 'file-code',
    mapVisual: { cssKey: 'visualforce', chipLabel: 'Visualforce', tone: 'interface' },
    mapAccent: 'metadata',
    catalogGroup: null, traceable: false, store: false,
    viaKinds: [],
    globs: ['**/pages/**/*.page', '**/components/**/*.component'],
    compoundExts: ['page-meta.xml', 'component-meta.xml'],
    overlayExts: ['page', 'component'],
  },
  {
    key: 'cmdt',
    labelSingular: 'Custom Metadata record', labelPlural: 'Custom Metadata records',
    entryLabel: 'Custom Metadata record',
    treeIcon: 'gear',
    mapVisual: { cssKey: 'custom-metadata', chipLabel: 'Custom metadata', tone: 'data' },
    mapAccent: 'metadata',
    catalogGroup: null, traceable: false, store: false,
    viaKinds: [],
    globs: ['**/customMetadata/**/*.md-meta.xml'],
    compoundExts: ['md-meta.xml'],
    overlayExts: ['xml'],
  },
  {
    key: 'permissionset',
    labelSingular: 'Permission Set', labelPlural: 'Permission Sets',
    entryLabel: 'Permission Set Apex access',
    treeIcon: 'shield',
    mapVisual: { cssKey: 'permission-set', chipLabel: 'Permission set', tone: 'data' },
    mapAccent: 'metadata',
    catalogGroup: null, traceable: false, store: false,
    viaKinds: [{ via: 'access', glossary: 'Permission Set or Profile grants access to this Apex class; not a runtime caller' }],
    globs: ['**/permissionsets/**/*.permissionset-meta.xml'],
    compoundExts: ['permissionset-meta.xml'],
    overlayExts: ['xml'],
  },
  {
    key: 'profile',
    labelSingular: 'Profile', labelPlural: 'Profiles',
    entryLabel: 'Profile Apex access',
    treeIcon: 'account',
    mapVisual: { cssKey: 'profile', chipLabel: 'Profile', tone: 'data' },
    mapAccent: 'metadata',
    catalogGroup: null, traceable: false, store: false,
    viaKinds: [],                      // 'access' contributed by the permissionset entry
    globs: ['**/profiles/**/*.profile-meta.xml'],
    compoundExts: ['profile-meta.xml'],
    overlayExts: ['xml'],
  },
  // ---- kinds landing in m3/m4: registered from m1 (labels/icons/visuals/
  //      vias are live so one registry read covers them the day they render)
  //      with store:false and empty globs/compoundExts/overlayExts; their
  //      own packages flip store and fill the BINDING glob values recorded
  //      in plans/CONTRACTS.local.md.
  {
    key: 'messagechannel',             // m3-lwc-edges flips store:true; globs stay [] (synthesized from refs, like externals -- final)
    labelSingular: 'Message channel', labelPlural: 'Message channels',
    entryLabel: 'Lightning Message Channel',
    treeIcon: 'broadcast',
    mapVisual: { cssKey: 'message-channel', chipLabel: 'Message channel', tone: 'interface' },
    mapAccent: 'metadata',
    catalogGroup: null, traceable: false, store: false,
    viaKinds: [{ via: 'subscribe', glossary: 'component subscribes to this Lightning message channel' }],
    globs: [], compoundExts: [], overlayExts: [],
  },
  {
    key: 'flexipage',                  // m4-surfacing flips store:true, globs ['**/flexipages/**/*.flexipage-meta.xml'], compoundExts ['flexipage-meta.xml'], overlayExts ['xml']
    labelSingular: 'Lightning page', labelPlural: 'Lightning pages',
    entryLabel: 'Lightning page',
    treeIcon: 'layout',
    mapVisual: { cssKey: 'flexipage', chipLabel: 'Lightning page', tone: 'interface' },
    mapAccent: 'metadata',
    catalogGroup: null, traceable: false, store: false,
    viaKinds: [{ via: 'surface', glossary: 'a FlexiPage/QuickAction/CustomTab places this component or flow in front of users' }],
    globs: [], compoundExts: [], overlayExts: [],
  },
  {
    key: 'quickaction',                // m4-surfacing flips store:true, globs ['**/quickActions/**/*.quickAction-meta.xml'], compoundExts ['quickAction-meta.xml'], overlayExts ['xml']
    labelSingular: 'Quick Action', labelPlural: 'Quick Actions',
    entryLabel: 'Quick Action',
    treeIcon: 'run',
    mapVisual: { cssKey: 'quick-action', chipLabel: 'Quick action', tone: 'interface' },
    mapAccent: 'metadata',
    catalogGroup: null, traceable: false, store: false,
    viaKinds: [],                      // reuses 'surface'
    globs: [], compoundExts: [], overlayExts: [],
  },
  {
    key: 'tab',                        // m4-surfacing flips store:true, globs ['**/tabs/**/*.tab-meta.xml'], compoundExts ['tab-meta.xml'], overlayExts ['xml']
    labelSingular: 'Custom Tab', labelPlural: 'Custom Tabs',
    entryLabel: 'Custom Tab',
    treeIcon: 'window',
    mapVisual: { cssKey: 'custom-tab', chipLabel: 'Custom tab', tone: 'interface' },
    mapAccent: 'metadata',
    catalogGroup: null, traceable: false, store: false,
    viaKinds: [],                      // reuses 'surface'
    globs: [], compoundExts: [], overlayExts: [],
  },
  {
    key: 'emailalert',                 // m4-flows flips store:true; globs stay [] in v1 ('**/workflows/**/*.workflow-meta.xml' reserved for a later phase)
    labelSingular: 'Email alert', labelPlural: 'Email alerts',
    entryLabel: 'Email alert action',
    treeIcon: 'mail-read',
    mapVisual: { cssKey: 'email-alert', chipLabel: 'Email alert', tone: 'automation' },
    mapAccent: 'metadata',
    catalogGroup: null, traceable: false, store: false,
    viaKinds: [],                      // reuses 'metadata'
    globs: [], compoundExts: [], overlayExts: [],
  },
];

// Entry Points catalog groups (order = display order; single source for
// resolver.js's ENTRY_KIND_ORDER/ENTRY_KIND_GROUP_LABEL and uitree.js's
// ENTRY_CATALOG_* tables). `iconFromKind` names a registry node kind OR one
// of the two Apex tree kinds 'trigger'/'anonymous' (uitree's
// ICON_TRIGGER='zap' / ICON_ANONYMOUS='terminal') -- the deliberate
// same-kind cross-view icon reuse uitree.js's catalog-table comment pins.
// The two icons marked CHANGED are the v0.20 collision fixes (one codicon =
// one identity): the Invocable Actions GROUP moves off 'gear' (the cmdt
// NODE keeps it); the Platform Hooks GROUP moves off 'shield' (the
// permissionset NODE keeps it).
// m3-lwc-core inserts, between 'flow' and 'anonymous' (BINDING):
//   { key: 'lwc', label: 'Lightning Web Components', iconFromKind: 'lwc',
//     glossary: 'Lightning Web Component — exposure targets from its js-meta.xml show where it can surface.',
//     expanded: false }
const CATALOG_GROUPS = [
  { key: 'trigger',   label: 'Triggers',                  iconFromKind: 'trigger',
    glossary: 'Apex trigger — fires on DML against a specific object.', expanded: true },
  { key: 'aura',      label: 'Aura / LWC (@AuraEnabled)', icon: 'radio-tower',
    glossary: '@AuraEnabled method — callable from Aura components and Lightning Web Components.', expanded: false },
  { key: 'invocable', label: 'Invocable Actions',         icon: 'symbol-method',  // CHANGED from 'gear'
    glossary: '@InvocableMethod method — callable as a Flow or Process Builder action.', expanded: false },
  { key: 'rest',      label: 'REST Endpoints',            icon: 'globe',
    glossary: '@HttpGet/@HttpPost/@HttpPut/@HttpPatch/@HttpDelete method on an @RestResource class — callable via the REST API.', expanded: false },
  { key: 'soap',      label: 'SOAP Web Services',         icon: 'server-process',
    glossary: 'webservice method — callable via the SOAP API.', expanded: false },
  { key: 'async',     label: 'Async (Batch / Queueable / Schedulable / @future)', icon: 'watch',
    glossary: 'Batchable/Queueable/Schedulable execute method or @future method — runs asynchronously, not from a direct call site.', expanded: false },
  { key: 'email',     label: 'Email Handlers',            icon: 'mail',
    glossary: 'Apex email service class (implements Messaging.InboundEmailHandler) — invoked when mail arrives at its service address.', expanded: false },
  { key: 'platform',  label: 'Platform Hooks',            icon: 'rocket',         // CHANGED from 'shield'
    glossary: 'platform-invoked hook (Install/Uninstall/RegistrationHandler/Comparable/Finalizer) — called by the platform itself, not application code.', expanded: false },
  { key: 'flow',      label: 'Flows',                     iconFromKind: 'flow',
    glossary: 'Flow — screen, record-triggered, scheduled, autolaunched, or platform-event flow found in this workspace.', expanded: true },
  { key: 'anonymous', label: 'Anonymous Scripts',         iconFromKind: 'anonymous',
    glossary: 'anonymous Apex script (.apex) — an ad hoc entry point, e.g. a one-off data-fix script.', expanded: false },
];

// Bare-name ambiguity resolution order (Contract K2, consumed from
// m2-schema): lwc roster first, then aura, else honest-unresolved.
const BARE_COMPONENT_RESOLUTION_ORDER = ['lwc', 'aura'];

// K2 targetKind vocabulary: 'apex' (the implicit default), the
// deliberately-ambiguous 'component', plus every store:true node kind.
const TARGET_KINDS = ['apex', 'component']
  .concat(NODE_KINDS.filter((k) => k.store).map((k) => k.key));

// Sidecar compound extensions that belong to no node kind but that
// metascan.stemOf must keep stripping.
const SIDECAR_COMPOUND_EXTS = ['cls-meta.xml', 'trigger-meta.xml'];

// ---- pure helpers (no state) ----
const NODE_KIND_BY_KEY = new Map(NODE_KINDS.map((k) => [k.key, k]));
function nodeKind(key) { return NODE_KIND_BY_KEY.get(key) || null; }
function nodeIdFor(kind, name) { return kind + ':' + String(name).toLowerCase(); }
function parseNodeId(id) {
  const s = String(id || '');
  const i = s.indexOf(':');
  if (i <= 0 || i === s.length - 1) return null;
  return { kind: s.slice(0, i), nameLower: s.slice(i + 1) };
}
function allGlobs() {
  const out = [];
  for (const k of NODE_KINDS) for (const g of k.globs) if (!out.includes(g)) out.push(g);
  return out;
}
function allViaKinds() {
  const out = [];
  for (const k of NODE_KINDS) for (const v of k.viaKinds) if (!out.includes(v.via)) out.push(v.via);
  return out;
}
function viaGlossary() {
  const out = {};
  for (const k of NODE_KINDS) for (const v of k.viaKinds) if (!(v.via in out)) out[v.via] = v.glossary;
  return out;
}
function allCompoundExts() {
  const out = [];
  for (const k of NODE_KINDS) for (const e of k.compoundExts) if (!out.includes(e)) out.push(e);
  for (const e of SIDECAR_COMPOUND_EXTS) if (!out.includes(e)) out.push(e);
  return out;
}
function traceableKinds() { return new Set(NODE_KINDS.filter((k) => k.traceable).map((k) => k.key)); }
function catalogGroupOrder() { return CATALOG_GROUPS.map((g) => g.key); }

function deepFreeze(v) {
  if (v && typeof v === 'object' && !Object.isFrozen(v)) {
    Object.freeze(v);
    for (const k of Object.keys(v)) deepFreeze(v[k]);
  }
  return v;
}
deepFreeze(NODE_KINDS);
deepFreeze(CATALOG_GROUPS);
deepFreeze(BARE_COMPONENT_RESOLUTION_ORDER);
deepFreeze(TARGET_KINDS);
deepFreeze(SIDECAR_COMPOUND_EXTS);

module.exports = { NODE_KINDS, CATALOG_GROUPS, BARE_COMPONENT_RESOLUTION_ORDER,
  TARGET_KINDS, SIDECAR_COMPOUND_EXTS, nodeKind, nodeIdFor, parseNodeId,
  allGlobs, allViaKinds, viaGlossary, allCompoundExts, traceableKinds,
  catalogGroupOrder };

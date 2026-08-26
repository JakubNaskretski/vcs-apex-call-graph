'use strict';

const assert = require('assert');
const kinds = require('./kinds');
const uitree = require('./uitree');
const pathmap = require('./pathmap');
const resolver = require('./resolver');
const scanflow = require('./scanflow');
const metascan = require('./metascan');
const editoroverlay = require('./editoroverlay');

// ---------------------------------------------------------------------------
// 1. Registry well-formedness.
// ---------------------------------------------------------------------------
{
  const seenKeys = new Set();
  for (const k of kinds.NODE_KINDS) {
    assert.ok(!seenKeys.has(k.key), `duplicate NODE_KINDS key: ${k.key}`);
    seenKeys.add(k.key);
    for (const field of ['labelSingular', 'labelPlural', 'entryLabel', 'treeIcon', 'mapAccent']) {
      assert.ok(k[field], `NODE_KINDS[${k.key}].${field} must be non-empty`);
    }
    for (const field of ['cssKey', 'chipLabel', 'tone']) {
      assert.ok(k.mapVisual && k.mapVisual[field], `NODE_KINDS[${k.key}].mapVisual.${field} must be non-empty`);
    }
    if (k.catalogGroup != null) {
      const inCatalog = kinds.CATALOG_GROUPS.some((g) => g.key === k.catalogGroup);
      const isLwcForwardRef = k.key === 'lwc' && k.catalogGroup === 'lwc';
      assert.ok(
        inCatalog || isLwcForwardRef,
        `NODE_KINDS[${k.key}].catalogGroup ('${k.catalogGroup}') must name a real CATALOG_GROUPS key, or be the one named lwc-forward-reference exemption`
      );
    }
  }
  // The lwc node's catalogGroup is a deliberate forward reference (its own
  // CATALOG_GROUPS row ships in m3-lwc-core); assert it is the ONLY one.
  assert.strictEqual(kinds.nodeKind('lwc').catalogGroup, 'lwc');
  const forwardRefs = kinds.NODE_KINDS.filter(
    (k) => k.catalogGroup != null && !kinds.CATALOG_GROUPS.some((g) => g.key === k.catalogGroup)
  );
  assert.deepStrictEqual(forwardRefs.map((k) => k.key), ['lwc'], 'lwc must be the only forward-referencing catalogGroup at m1');

  const order = kinds.catalogGroupOrder();
  assert.strictEqual(new Set(order).size, order.length, 'catalogGroupOrder() must have no duplicates');

  for (const g of kinds.CATALOG_GROUPS) {
    if (g.iconFromKind) {
      const ok = g.iconFromKind === 'trigger' || g.iconFromKind === 'anonymous' || kinds.nodeKind(g.iconFromKind) != null;
      assert.ok(ok, `CATALOG_GROUPS[${g.key}].iconFromKind ('${g.iconFromKind}') must be 'trigger', 'anonymous', or a real node kind`);
      assert.ok(!g.icon, `CATALOG_GROUPS[${g.key}] has both iconFromKind and a conflicting literal icon`);
    }
  }

  assert.ok(Object.isFrozen(kinds.NODE_KINDS));
  assert.ok(Object.isFrozen(kinds.NODE_KINDS[0]));
  assert.ok(Object.isFrozen(kinds.NODE_KINDS[0].mapVisual));
  assert.ok(Object.isFrozen(kinds.CATALOG_GROUPS));
  assert.ok(Object.isFrozen(kinds.TARGET_KINDS));
}

// ---------------------------------------------------------------------------
// 2. Tree icons.
// ---------------------------------------------------------------------------
{
  for (const k of kinds.NODE_KINDS) {
    const bareTNode = {
      label: 'Vtx_X', kind: k.key, className: '', methodLower: null,
      path: '', line: 0, entries: [k.entryLabel], isTest: false, via: null,
      sites: [], children: [], cyclic: false, truncated: false,
      approximate: false, seenElsewhere: false,
    };
    assert.strictEqual(
      uitree.iconForNode(bareTNode), k.treeIcon,
      `uitree.iconForNode must return the registry treeIcon for kind '${k.key}'`
    );
  }
}

// ---------------------------------------------------------------------------
// 3. Catalog projection.
// ---------------------------------------------------------------------------
{
  function expectedGroupIcon(g) {
    if (g.iconFromKind === 'trigger') return 'zap';
    if (g.iconFromKind === 'anonymous') return 'terminal';
    if (g.iconFromKind) {
      const nk = kinds.nodeKind(g.iconFromKind);
      if (nk) return nk.treeIcon;
    }
    return g.icon;
  }
  for (const g of kinds.CATALOG_GROUPS) {
    const shaped = uitree.shapeEntryCatalogGroup({ kind: g.key, label: '', entries: [] });
    assert.strictEqual(shaped.label, g.label, `catalog group '${g.key}' label must match the registry`);
    assert.strictEqual(shaped.tooltip, g.glossary, `catalog group '${g.key}' tooltip must match the registry glossary`);
    assert.strictEqual(shaped.iconId, expectedGroupIcon(g), `catalog group '${g.key}' iconId must match the registry-resolved icon`);
  }
  const catalog = resolver.buildEntryCatalog(resolver.buildSemanticIndex([]));
  assert.deepStrictEqual(catalog.groups.map((x) => x.kind), kinds.catalogGroupOrder());
  for (const x of catalog.groups) {
    const g = kinds.CATALOG_GROUPS.find((cg) => cg.key === x.kind);
    assert.ok(g, `buildEntryCatalog produced an unknown group kind '${x.kind}'`);
    assert.strictEqual(x.label, g.label);
  }
}

// ---------------------------------------------------------------------------
// 4. Map.
// ---------------------------------------------------------------------------
{
  for (const k of kinds.NODE_KINDS) {
    assert.strictEqual(
      pathmap.accentKind({ kind: k.key, entries: [k.entryLabel] }), k.mapAccent,
      `pathmap.accentKind must return the registry mapAccent for kind '${k.key}'`
    );
    assert.deepStrictEqual(
      pathmap.nodeVisual({ kind: k.key }),
      { key: k.mapVisual.cssKey, label: k.mapVisual.chipLabel, tone: k.mapVisual.tone },
      `pathmap.nodeVisual must match the registry mapVisual for kind '${k.key}'`
    );
  }
}

// ---------------------------------------------------------------------------
// 5. Via vocabulary.
// ---------------------------------------------------------------------------
{
  for (const via of kinds.allViaKinds()) {
    assert.ok(scanflow.KNOWN_VIA_KINDS.has(via), `scanflow.KNOWN_VIA_KINDS must contain registry via '${via}'`);
  }
  assert.ok(scanflow.KNOWN_VIA_KINDS.has('access'), "scanflow.KNOWN_VIA_KINDS must contain 'access' (the proof case)");
  for (const via of resolver.EMITTABLE_VIA) {
    assert.ok(scanflow.KNOWN_VIA_KINDS.has(via), `scanflow.KNOWN_VIA_KINDS must contain every resolver.EMITTABLE_VIA member ('${via}')`);
  }
  const glossary = kinds.viaGlossary();
  for (const k of kinds.NODE_KINDS) {
    for (const v of k.viaKinds) {
      assert.ok(v.glossary, `NODE_KINDS[${k.key}].viaKinds via '${v.via}' must carry a non-empty glossary`);
      assert.strictEqual(glossary[v.via], v.glossary);
    }
  }
}

// ---------------------------------------------------------------------------
// 6. Globs.
// ---------------------------------------------------------------------------
{
  const recomputed = [];
  for (const k of kinds.NODE_KINDS) for (const g of k.globs) if (!recomputed.includes(g)) recomputed.push(g);
  assert.deepStrictEqual(kinds.allGlobs(), recomputed);

  for (const glob of kinds.allGlobs()) {
    const sample = glob.replace(/\*\*/g, 'x').replace(/\*/g, 'VtxSample');
    assert.strictEqual(
      editoroverlay.sourceKind(sample), 'metadata',
      `a sample path for glob '${glob}' (${sample}) must be classified 'metadata' by editoroverlay.sourceKind`
    );
  }
}

// ---------------------------------------------------------------------------
// 7. Compound extensions.
// ---------------------------------------------------------------------------
{
  for (const ext of kinds.allCompoundExts()) {
    assert.strictEqual(metascan.stemOf('Vtx_Sample.' + ext), 'Vtx_Sample', `metascan.stemOf must strip compound extension '${ext}'`);
  }
  assert.ok(kinds.allCompoundExts().includes('cls-meta.xml'));
  assert.ok(kinds.allCompoundExts().includes('trigger-meta.xml'));
  assert.deepStrictEqual(
    kinds.allCompoundExts().slice().sort(),
    ['app-meta.xml', 'cls-meta.xml', 'cmp-meta.xml', 'component-meta.xml',
      'flow-meta.xml', 'js-meta.xml', 'md-meta.xml', 'os-meta.xml',
      'page-meta.xml', 'permissionset-meta.xml', 'profile-meta.xml',
      'trigger-meta.xml']
  );
}

// ---------------------------------------------------------------------------
// 8. Icon uniqueness.
// ---------------------------------------------------------------------------
{
  const byIcon = new Map();
  function claim(icon, identity) {
    if (!byIcon.has(icon)) byIcon.set(icon, new Set());
    byIcon.get(icon).add(identity);
  }
  for (const k of kinds.NODE_KINDS) claim(k.treeIcon, k.key);
  for (const g of kinds.CATALOG_GROUPS) {
    let icon;
    let identity;
    if (g.iconFromKind === 'trigger') { icon = 'zap'; identity = 'trigger'; }
    else if (g.iconFromKind === 'anonymous') { icon = 'terminal'; identity = 'anonymous'; }
    else if (g.iconFromKind) { icon = kinds.nodeKind(g.iconFromKind).treeIcon; identity = g.iconFromKind; }
    else { icon = g.icon; identity = 'group:' + g.key; }
    claim(icon, identity);
  }
  claim('zap', 'trigger');
  claim('terminal', 'anonymous');
  for (const [icon, identities] of byIcon) {
    assert.strictEqual(identities.size, 1, `codicon '${icon}' maps to more than one identity: ${[...identities].join(', ')}`);
  }
}

// ---------------------------------------------------------------------------
// 9. Target kinds.
// ---------------------------------------------------------------------------
{
  assert.strictEqual(kinds.TARGET_KINDS[0], 'apex');
  assert.strictEqual(kinds.TARGET_KINDS[1], 'component');
  const storeTail = kinds.NODE_KINDS.filter((k) => k.store).map((k) => k.key);
  assert.deepStrictEqual(kinds.TARGET_KINDS.slice(2), storeTail);
  assert.deepStrictEqual(storeTail, ['flow', 'lwc', 'aura']);

  const nodeKeys = new Set(kinds.NODE_KINDS.map((k) => k.key));
  for (const tk of kinds.traceableKinds()) assert.ok(nodeKeys.has(tk));
  for (const k of kinds.NODE_KINDS) {
    if (k.traceable) assert.ok(k.store, `traceable kind '${k.key}' must also carry store:true`);
  }
}

// ---------------------------------------------------------------------------
// 10. metaEntryLabel.
// ---------------------------------------------------------------------------
{
  for (const k of kinds.NODE_KINDS) {
    assert.strictEqual(resolver.metaEntryLabel(k.key), k.entryLabel);
  }
  assert.strictEqual(resolver.metaEntryLabel('vtx_unknown_kind'), 'metadata reference');

  assert.strictEqual(kinds.nodeKind('vtx_bogus'), null);
  assert.strictEqual(kinds.parseNodeId('nocolon'), null);
  assert.strictEqual(kinds.parseNodeId(':x'), null);
  assert.deepStrictEqual(kinds.parseNodeId('flow:acme_order_screen'), { kind: 'flow', nameLower: 'acme_order_screen' });
  assert.strictEqual(kinds.nodeIdFor('flow', 'Acme_Order_Screen'), 'flow:acme_order_screen');
}

console.log('apex-call-graph kind-parity self-check: all assertions passed');

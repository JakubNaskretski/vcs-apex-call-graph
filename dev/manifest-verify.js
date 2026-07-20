'use strict';
// Adversarial MANIFEST-accounting verifier (v0.3.0 gap-closure check).
//
// Runs the FULL engine (parser.js + resolver.js + metascan.js, wired
// exactly the way extension.js wires them for a real workspace scan) over
// test-fixtures/adv-org, then mechanically checks
// EVERY ground-truth edge listed in that corpus's MANIFEST.md:
//   - the edge's source is PRESENT as a caller node of the target
//   - the caller node's `kind` matches what that source's file type must
//     produce (method/trigger for .cls/.trigger; lwc/aura/flow/omniscript
//     for metadata sources)
//   - the caller node/site's `via` is correct (exact for resolves-today
//     edges; upgraded off `unique-name`/absent for the four amendment gap
//     classes now that v0.3.0 claims to close them)
//   - AcmePricingEngine.calculatePrice overloadSig is correct at every one
//     of its 22 call sites (A4)
//   - the 2 accessor edges resolve to the correct '(get X)'/'(set X)' keys
//     (A1/A2)
//   - every metadata caller node is TERMINAL (children.length === 0) and
//     carries via='metadata'
//
// Also separately re-verifies that the pre-v0.3.0 resolves-today edge set
// (61 base + the 3 previously-carved-out AcmeNotificationDispatcher
// .dispatchToAll edges that got folded into that 61 — see MANIFEST.md's
// "Corpus defects" section) has NOT regressed: same target reachable, same
// documented `via`.
//
// Read-only: never touches test-fixtures/adv-org or any engine file. Every
// file this script writes (none) or reads outside dev/ is read-only access
// to the frozen fixture corpus and the engine under test.
//
// Usage: node dev/manifest-verify.js

const fs = require('fs');
const path = require('path');
const parser = require('../parser');
const resolver = require('../resolver');
const metascan = require('../metascan');

const ADV_ROOT = 'test-fixtures/adv-org';
const FORCE_APP = path.join(ADV_ROOT, 'force-app', 'main', 'default');
const MANIFEST_PATH = path.join(ADV_ROOT, 'MANIFEST.md');

// =========================================================================
// 1. Workspace scan — mirrors extension.js's scanWorkspaceUris /
//    scanMetaWorkspaceUris / computeMetaRefs exactly (same globs, same
//    exclusions, same Aura bundle-pairing strategy), just over plain fs
//    instead of vscode.workspace.findFiles, so this exercises the REAL
//    integration wiring rather than a hand-rolled shortcut.
// =========================================================================

const APEX_SKIP_DIRS = new Set(['node_modules', '.sfdx', '.sf', '.git']);
const META_SKIP_DIRS = new Set(['node_modules', '.sfdx', '.sf', '.git', '__tests__']);

function walk(dir, skipDirs, matchExt, out) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (e) {
    return;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (skipDirs.has(e.name)) continue;
      walk(full, skipDirs, matchExt, out);
    } else if (matchExt(e.name)) {
      out.push(full);
    }
  }
}

function isApexFile(name) {
  return /\.(cls|trigger)$/i.test(name);
}

// Same union as extension.js's META_GLOBS: lwc/**/*.js, aura/**/*.{cmp,app,js},
// flows/**/*.flow-meta.xml, omniscripts/**/*.{os-meta.xml,json}, plus VF
// pages/components (no adv-org fixtures for VF, still globbed for parity).
function isMetaFile(fullPath) {
  const rel = fullPath.slice(FORCE_APP.length + 1).replace(/\\/g, '/');
  if (/^lwc\//.test(rel) && /\.js$/i.test(rel)) return true;
  if (/^aura\//.test(rel) && /\.(cmp|app|js)$/i.test(rel)) return true;
  if (/^flows\//.test(rel) && /\.flow-meta\.xml$/i.test(rel)) return true;
  if (/^omniscripts\//.test(rel) && /(\.os-meta\.xml|\.json)$/i.test(rel)) return true;
  if (/^pages\//.test(rel) && /\.page$/i.test(rel)) return true;
  if (/^components\//.test(rel) && /\.component$/i.test(rel)) return true;
  return false;
}

function groupAuraFilesByDir(files) {
  const groups = new Map();
  for (const f of files) {
    const dir = path.dirname(f.path);
    let g = groups.get(dir);
    if (!g) {
      g = { markup: null, jsFiles: [] };
      groups.set(dir, g);
    }
    if (/\.(cmp|app)$/i.test(f.path)) g.markup = f;
    else if (/\.js$/i.test(f.path)) g.jsFiles.push(f);
  }
  return groups;
}

// Reproduces extension.js's computeMetaRefs() verbatim in behavior (see
// extension.js lines ~303-333): non-Aura sources tagged with their own
// path; Aura class-level ref tagged with the markup path; Aura method-level
// refs obtained per-(markup, single js file) pair via scanBundle so each
// resulting ref can be tagged with the exact js file it came from.
function computeMetaRefs(files) {
  const refs = [];
  const auraFiles = files.filter((f) => /(^|[\\/])aura[\\/]/i.test(f.path));
  const otherFiles = files.filter((f) => !/(^|[\\/])aura[\\/]/i.test(f.path));

  for (const f of otherFiles) {
    for (const ref of metascan.parseMetaFile(f)) {
      ref.path = f.path;
      refs.push(ref);
    }
  }

  const groups = groupAuraFilesByDir(auraFiles);
  for (const g of groups.values()) {
    if (!g.markup) continue;
    for (const ref of metascan.parseMetaFile(g.markup)) {
      ref.path = g.markup.path;
      refs.push(ref);
    }
    for (const jsFile of g.jsFiles) {
      for (const ref of metascan.scanBundle([g.markup, jsFile])) {
        if (ref.methodName == null) continue;
        ref.path = jsFile.path;
        refs.push(ref);
      }
    }
  }
  return refs;
}

// =========================================================================
// 2. MANIFEST.md ground-truth edge parser
// =========================================================================

function parseManifestEdges(manifestText) {
  const start = manifestText.indexOf('## Ground-truth edge list');
  const end = manifestText.indexOf('## Corpus defects');
  if (start === -1 || end === -1) throw new Error('MANIFEST.md structure changed: could not find edge-list section markers');
  const section = manifestText.slice(start, end);
  const lines = section.split('\n');

  const edges = [];
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line.startsWith('- `')) continue;
    // Grab the backtick-quoted arrow expression.
    const backtickMatch = line.match(/^-\s*`([^`]+)`/);
    if (!backtickMatch) continue;
    const inner = backtickMatch[1];
    if (!inner.includes('→')) continue; // no arrow -> not an edge line (e.g. the "no outbound callsInto" bullet)
    const [srcRaw, tgtRaw] = inner.split('→').map((s) => s.trim());

    const tagMatch = line.match(/\[([^\]]+)\]/);
    const tag = tagMatch ? tagMatch[1].trim() : null;
    const viaMatch = line.match(/\(via=([a-zA-Z-]+)\)/);
    const viaHint = viaMatch ? viaMatch[1] : null;

    edges.push({ raw: line, srcRaw, tgtRaw, tag, viaHint });
  }
  return edges;
}

function parseTallyTable(manifestText) {
  // Pull the `| resolves-today | 61 | ... |` row's count out of the tally
  // table mechanically, so the "did the 61 regress" check is driven by the
  // document's own numbers, not a hardcoded literal.
  const m = manifestText.match(/\|\s*`resolves-today`\s*\|\s*(\d+)\s*\|/);
  if (!m) throw new Error('MANIFEST.md tally table changed shape: could not find resolves-today row');
  return parseInt(m[1], 10);
}

// =========================================================================
// 3. Edge classification: figure out what to query the engine for, and
//    what kind of caller node we expect back.
// =========================================================================

const META_KIND_BY_DIR = {
  lwc: 'lwc',
  aura: 'aura',
  flows: 'flow',
  omniscripts: 'omniscript',
};

function classifySource(srcRaw) {
  // srcRaw examples:
  //   "AcmeQuote.cls"
  //   "AcmeOrderTrigger.trigger"
  //   "lwc/acmeOrderDashboard/acmeOrderDashboard.js"
  //   "aura/AcmeOrderApprovalPanel/AcmeOrderApprovalPanel.cmp"
  //   "aura/AcmeOrderApprovalPanel/AcmeOrderApprovalPanelController.js"
  //   "flows/AcmeQuoteApprovalScreenFlow.flow-meta.xml"
  //   "omniscripts/AcmeQuoteOmniScript/AcmeQuoteOmniScript_DataPack.json"
  //   "omniscripts/AcmeShipmentOmniScript.os-meta.xml"
  if (/\.cls$/i.test(srcRaw)) return { type: 'apex', apexKind: 'class', fileSuffix: srcRaw };
  if (/\.trigger$/i.test(srcRaw)) return { type: 'apex', apexKind: 'trigger', fileSuffix: srcRaw };
  const topDir = srcRaw.split('/')[0];
  const metaKind = META_KIND_BY_DIR[topDir];
  if (metaKind) return { type: 'meta', metaKind, fileSuffix: srcRaw };
  return { type: 'unknown', fileSuffix: srcRaw };
}

// tgtRaw examples: "AcmeQuote.validateStatusTransition", "AcmeInvoice.<init>",
// "AcmeQuote.(set Status)", "AcmeOrderApprovalController" (class-only, Aura
// controller= attribute edge), "AcmeNotifyCustomerSubflow (subflow)" (flow-
// to-flow, NOT an Apex target at all -- must be skipped).
function classifyTarget(tgtRaw) {
  if (/\(subflow\)\s*$/.test(tgtRaw)) return { type: 'non-apex-subflow' };
  // "Cls.method" or "Cls.(set X)"/"Cls.(get X)" or "Cls.<init>" or bare
  // "Cls" -- Cls itself may be dotted for an inner class (e.g.
  // "AcmeOuterContainer.InnerWorker.<init>"), so these match greedily on
  // the class-path prefix and only require the FINAL dotted segment to be
  // the accessor/init/method token.
  const accessorMatch = tgtRaw.match(/^(.+)\.(\(get [^)]+\)|\(set [^)]+\))$/);
  if (accessorMatch) return { type: 'apex-method', cls: accessorMatch[1], method: accessorMatch[2] };
  const initMatch = tgtRaw.match(/^(.+)\.<init>$/);
  if (initMatch) return { type: 'apex-method', cls: initMatch[1], method: '<init>' };
  const methodMatch = tgtRaw.match(/^(.+)\.([A-Za-z0-9_]+)$/);
  if (methodMatch) return { type: 'apex-method', cls: methodMatch[1], method: methodMatch[2] };
  const classOnly = tgtRaw.match(/^([A-Za-z0-9_.]+)$/);
  if (classOnly) return { type: 'apex-class', cls: classOnly[1] };
  return { type: 'unparseable' };
}

// =========================================================================
// 4. Tree walking helpers
// =========================================================================

function collectAllChildren(node) {
  // Direct children only (depth 1) -- every MANIFEST edge is a direct
  // source->target edge, not a transitive one.
  return node.children || [];
}

function pathEndsWith(nodePath, suffix) {
  if (!nodePath) return false;
  const normNode = nodePath.replace(/\\/g, '/');
  const normSuffix = suffix.replace(/\\/g, '/');
  return normNode === normSuffix || normNode.endsWith('/' + normSuffix);
}

const EXPECTED_APEX_KIND = { class: 'method', trigger: 'trigger' };
// Aura markup (.cmp) class-level refs and Aura JS method-level refs both
// carry MetaRef.kind === 'aura' (single kind value, no markup/js split --
// see metascan.js A5 contract comment).
const EXPECTED_META_KIND = { lwc: 'lwc', aura: 'aura', flow: 'flow', omniscript: 'omniscript' };

// =========================================================================
// 5. Main
// =========================================================================

function main() {
  const findings = [];
  function fail(edge, summary, extra) {
    findings.push({ edge: edge.raw, summary, extra: extra || null });
  }

  console.log('=== MANIFEST-accounting verifier (adv-org, v0.3.0) ===\n');

  // --- scan + index --------------------------------------------------
  const apexPaths = [];
  walk(FORCE_APP, APEX_SKIP_DIRS, isApexFile, apexPaths);
  const metaPaths = [];
  // meta file classification needs the full path (not just name) to tell
  // which top-level dir (lwc/aura/flows/omniscripts/...) a file lives
  // under, so this uses a dedicated walker rather than reusing walk()'s
  // name-only matchExt signature.
  (function walkMeta(dir) {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (e) {
      return;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (META_SKIP_DIRS.has(e.name)) continue;
        walkMeta(full);
      } else if (isMetaFile(full)) {
        metaPaths.push(full);
      }
    }
  })(FORCE_APP);

  const t0 = Date.now();
  const factsList = apexPaths.map((p) => parser.parseFile({ path: p, text: fs.readFileSync(p, 'utf8') }));
  const index = resolver.buildSemanticIndex(factsList);
  const t1 = Date.now();
  const metaFiles = metaPaths.map((p) => ({ path: p, text: fs.readFileSync(p, 'utf8') }));
  const metaRefs = computeMetaRefs(metaFiles);
  resolver.attachMetaCallers(index, metaRefs);
  const t2 = Date.now();

  const parseErrCount = factsList.filter((f) => f.parseError).length;
  console.log(`Apex files: ${apexPaths.length} (parse+index ${t1 - t0}ms, perf bar <3000ms)`);
  console.log(`Meta files: ${metaPaths.length}, meta refs extracted: ${metaRefs.length} (metascan ${t2 - t1}ms, perf bar <300ms)`);
  console.log(`Parse errors: ${parseErrCount} (expect exactly 1: AcmeBrokenParser.cls)`);
  if (parseErrCount !== 1) {
    fail({ raw: '(corpus invariant)' }, `Expected exactly 1 parseError (AcmeBrokenParser.cls), got ${parseErrCount}`);
  } else {
    const brokenOk = factsList.some((f) => f.parseError && /AcmeBrokenParser\.cls$/.test(f.path));
    if (!brokenOk) fail({ raw: '(corpus invariant)' }, 'The single parseError is not on AcmeBrokenParser.cls as MANIFEST requires');
  }
  if ((t1 - t0) >= 3000) fail({ raw: '(perf bar)' }, `Apex parse+index took ${t1 - t0}ms, perf bar is <3000ms`);
  if ((t2 - t1) >= 300) fail({ raw: '(perf bar)' }, `Metascan took ${t2 - t1}ms, perf bar is <300ms`);

  // --- MANIFEST parse --------------------------------------------------
  const manifestText = fs.readFileSync(MANIFEST_PATH, 'utf8');
  const edges = parseManifestEdges(manifestText);
  const declaredResolvesTodayCount = parseTallyTable(manifestText);
  console.log(`\nParsed ${edges.length} ground-truth edge lines from MANIFEST.md.`);

  const resolvesTodayEdges = edges.filter((e) => e.tag === 'resolves-today');
  console.log(`Tagged [resolves-today]: ${resolvesTodayEdges.length} (MANIFEST tally table claims ${declaredResolvesTodayCount})`);
  if (resolvesTodayEdges.length !== declaredResolvesTodayCount) {
    fail(
      { raw: '(tally cross-check)' },
      `MANIFEST tally table says ${declaredResolvesTodayCount} resolves-today edges but the edge list itself contains ${resolvesTodayEdges.length} lines tagged [resolves-today]`
    );
  }

  // The 3 edges that used to be a carved-out "corpus defect" (dispatchAll
  // typo) and are now folded into resolves-today -- explicitly named so a
  // regression here is caught even if buried in the general sweep below.
  const DISPATCH_TO_ALL_EDGES = [
    'AcmeOrderBatchProcessor.cls',
    'AcmeQuoteAuraService.cls',
    'AcmeOrderServiceTest.cls',
  ];
  const dispatchEdges = resolvesTodayEdges.filter((e) => e.tgtRaw === 'AcmeNotificationDispatcher.dispatchToAll');
  console.log(`dispatchToAll edges found in MANIFEST: ${dispatchEdges.length} (expect 3)`);
  if (dispatchEdges.length !== 3) {
    fail({ raw: '(dispatchToAll regression check)' }, `Expected 3 AcmeNotificationDispatcher.dispatchToAll resolves-today edges, found ${dispatchEdges.length}`);
  }
  for (const wantSrc of DISPATCH_TO_ALL_EDGES) {
    if (!dispatchEdges.some((e) => e.srcRaw === wantSrc)) {
      fail({ raw: '(dispatchToAll regression check)' }, `Missing expected dispatchToAll edge from ${wantSrc}`);
    }
  }

  // --- overloadSig ground truth for calculatePrice (A4) ------------------
  // file (relative to classes/), 1-based line -> expected overload param head
  const OVERLOAD_EXPECTATIONS = [
    ['AcmeQuoteBuilder.cls', 20, 'calculatePrice(String)'],
    ['AcmeQuoteBuilder.cls', 21, 'calculatePrice(Integer)'],
    ['AcmeQuoteBuilder.cls', 33, 'calculatePrice(AcmeQuote)'],
    ['AcmePricingEngine.cls', 47, 'calculatePrice(Integer)'],
    ['AcmeOrderService.cls', 38, 'calculatePrice(Acme_Order__c)'],
  ];
  // AcmeGeneratedCatalog.cls: 9 lookupPriceNNNN methods, each with a
  // String-literal call (unitPrice) then an Integer-literal call
  // (tierMultiplier) two lines apart, at these anchor lines (first of pair).
  const GENERATED_CATALOG_PAIR_LINES = [55, 155, 276, 376, 476, 583, 683, 804, 925];
  for (const line of GENERATED_CATALOG_PAIR_LINES) {
    OVERLOAD_EXPECTATIONS.push(['AcmeGeneratedCatalog.cls', line, 'calculatePrice(String)']);
    OVERLOAD_EXPECTATIONS.push(['AcmeGeneratedCatalog.cls', line + 1, 'calculatePrice(Integer)']);
  }

  const priceTree = resolver.buildCallerTree(index, { classLower: 'acmepricingengine', methodLower: 'calculateprice' }, { maxDepth: 8 });
  const overloadSigByFileLine = new Map(); // "file:line" -> overloadSig actually seen
  // IMPORTANT: only DEPTH-1 children's sites are actual calculatePrice call
  // sites. Each depth-1 child's OWN .children are ITS callers (the tree
  // recurses transitively up the call graph) -- recursing into those would
  // collect call sites for whatever unrelated method calls the depth-1
  // caller, not calculatePrice call sites at all.
  for (const child of priceTree.root.children || []) {
    for (const s of child.sites || []) {
      const norm = s.path.replace(/\\/g, '/');
      const base = norm.slice(norm.lastIndexOf('/') + 1);
      overloadSigByFileLine.set(`${base}:${s.line}`, s.overloadSig);
    }
  }

  console.log(`\n--- A4 overloadSig check (${OVERLOAD_EXPECTATIONS.length} call sites) ---`);
  let overloadFailCount = 0;
  for (const [file, line, expectedSig] of OVERLOAD_EXPECTATIONS) {
    const key = `${file}:${line}`;
    const actual = overloadSigByFileLine.get(key);
    if (actual !== expectedSig) {
      overloadFailCount++;
      fail(
        { raw: `overloadSig @ ${key}` },
        `Expected overloadSig '${expectedSig}' at ${key}, got '${actual === undefined ? '<site not found>' : actual}'`
      );
    }
  }
  console.log(overloadFailCount === 0 ? 'All overloadSig expectations matched.' : `${overloadFailCount} overloadSig mismatch(es).`);

  // --- per-edge sweep ------------------------------------------------
  console.log(`\n--- per-edge sweep (${edges.length} edges) ---`);
  let apexEdgeChecked = 0;
  let metaEdgeChecked = 0;
  let skipped = 0;
  let passCount = 0;

  for (const edge of edges) {
    const srcInfo = classifySource(edge.srcRaw);
    const tgtInfo = classifyTarget(edge.tgtRaw);

    if (tgtInfo.type === 'non-apex-subflow') {
      skipped++; // flow-to-flow edge, categorically not resolvable by an Apex-call-graph engine; MANIFEST agrees.
      continue;
    }
    if (tgtInfo.type === 'unparseable' || srcInfo.type === 'unknown') {
      fail(edge, `Could not classify edge for mechanical checking (src='${edge.srcRaw}', tgt='${edge.tgtRaw}')`);
      continue;
    }

    const classLower = tgtInfo.cls.toLowerCase();
    const methodLower = tgtInfo.type === 'apex-method' ? tgtInfo.method.toLowerCase() : null;
    const tree = resolver.buildCallerTree(index, { classLower, methodLower }, { maxDepth: 8 });
    if (tree.note) {
      fail(edge, `Target class '${tgtInfo.cls}' not found in index (note: ${tree.note})`);
      continue;
    }

    const children = collectAllChildren(tree.root);
    const matches = children.filter((c) => pathEndsWith(c.path, srcInfo.fileSuffix));

    if (srcInfo.type === 'apex') {
      apexEdgeChecked++;
      if (matches.length === 0) {
        fail(edge, `No caller node found with path ending '${srcInfo.fileSuffix}' among ${children.length} children of ${classLower}${methodLower ? '#' + methodLower : ''}`, {
          childrenPaths: children.map((c) => `${c.kind}:${c.path}:${c.via}`),
        });
        continue;
      }
      const expectedKind = EXPECTED_APEX_KIND[srcInfo.apexKind];
      const kindOk = matches.every((m) => m.kind === expectedKind);
      if (!kindOk) {
        fail(edge, `Caller node kind mismatch: expected '${expectedKind}', got [${matches.map((m) => m.kind).join(', ')}]`);
        continue;
      }
      if (edge.viaHint) {
        const viaOk = matches.some((m) => m.via === edge.viaHint || (m.sites || []).some((s) => s.via === edge.viaHint));
        if (!viaOk) {
          fail(edge, `via mismatch: MANIFEST says via=${edge.viaHint}, engine reports [${matches.map((m) => m.via).join(', ')}]`);
          continue;
        }
      }
      passCount++;
    } else if (srcInfo.type === 'meta') {
      metaEdgeChecked++;
      if (matches.length === 0) {
        fail(edge, `No metadata caller node found with path ending '${srcInfo.fileSuffix}' among ${children.length} children of ${classLower}${methodLower ? '#' + methodLower : ''}`, {
          childrenPaths: children.map((c) => `${c.kind}:${c.path}:${c.via}`),
        });
        continue;
      }
      const expectedKind = EXPECTED_META_KIND[srcInfo.metaKind];
      let ok = true;
      for (const m of matches) {
        if (m.kind !== expectedKind) {
          fail(edge, `Meta caller node kind mismatch: expected '${expectedKind}', got '${m.kind}'`);
          ok = false;
        }
        if (m.via !== 'metadata') {
          fail(edge, `Meta caller node via mismatch: expected 'metadata', got '${m.via}'`);
          ok = false;
        }
        if ((m.children || []).length !== 0) {
          fail(edge, `Meta caller node is not terminal: has ${m.children.length} children (meta roots must be terminal)`);
          ok = false;
        }
      }
      if (ok) passCount++;
    }
  }

  console.log(`Apex-sourced edges checked: ${apexEdgeChecked}`);
  console.log(`Metadata-sourced edges checked: ${metaEdgeChecked}`);
  console.log(`Skipped (non-Apex-target, e.g. flow-to-flow subflow edge): ${skipped}`);
  console.log(`Passed: ${passCount} / ${apexEdgeChecked + metaEdgeChecked}`);

  // --- special-case gap-closure spot checks (the 4 amendment classes) ----
  console.log('\n--- gap-closure spot checks (needs:* categories) ---');

  // needs:accessors -- AcmeQuote.(set Status) / (get TotalAmount) must have
  // callers now, keyed at the exact accessor scope.
  for (const [methodKey, callerFile] of [
    ['(set status)', 'AcmePropertyConsumer.cls'],
    ['(get totalamount)', 'AcmePropertyConsumer.cls'],
  ]) {
    const t = resolver.buildCallerTree(index, { classLower: 'acmequote', methodLower: methodKey }, { maxDepth: 8 });
    const kids = collectAllChildren(t.root);
    const has = kids.some((c) => pathEndsWith(c.path, callerFile));
    console.log(`AcmeQuote.${methodKey}: ${kids.length} caller(s), from ${callerFile}: ${has}`);
    if (!has) {
      fail({ raw: `accessor spot-check: AcmeQuote.${methodKey}` }, `Expected a caller from ${callerFile} at accessor key '${methodKey}', found none among [${kids.map((k) => k.path).join(', ')}]`);
    }
  }

  // needs:chained -- AcmeQuoteAuraService.cls -> AcmeQuoteBuilder.build must
  // now resolve via='typed' (2-segment fluent chain), not the old
  // 'unique-name' approximate fallback.
  {
    const t = resolver.buildCallerTree(index, { classLower: 'acmequotebuilder', methodLower: 'build' }, { maxDepth: 8 });
    const kids = collectAllChildren(t.root);
    const auraCaller = kids.find((c) => pathEndsWith(c.path, 'AcmeQuoteAuraService.cls'));
    console.log(`AcmeQuoteBuilder.build <- AcmeQuoteAuraService.cls: via=${auraCaller ? auraCaller.via : '<missing>'}, approximate=${auraCaller ? auraCaller.approximate : 'n/a'}`);
    if (!auraCaller) {
      fail({ raw: 'chained spot-check: AcmeQuoteAuraService -> AcmeQuoteBuilder.build' }, 'Caller node missing entirely');
    } else if (auraCaller.via !== 'typed' || auraCaller.approximate) {
      fail(
        { raw: 'chained spot-check: AcmeQuoteAuraService -> AcmeQuoteBuilder.build' },
        `Expected via='typed', approximate=false (A3c chained-receiver resolution) after v0.3.0; got via='${auraCaller.via}', approximate=${auraCaller.approximate}`
      );
    }
  }

  // needs:chained (folded ternary caveat) -- AcmeInvoiceCastDemo's 4
  // receiver shapes (cast/safe-nav/ternary/for-each) must ALL resolve
  // via='typed' now, including the ternary one, since both ternary operands
  // are the same user class (AcmeInvoice).
  {
    const t = resolver.buildCallerTree(index, { classLower: 'acmeinvoice', methodLower: 'total' }, { maxDepth: 8 });
    const kids = collectAllChildren(t.root).filter((c) => pathEndsWith(c.path, 'AcmeInvoiceCastDemo.cls'));
    console.log(`AcmeInvoice.total <- AcmeInvoiceCastDemo.cls: ${kids.length} caller node(s), via=[${kids.map((k) => k.via).join(', ')}]`);
    if (kids.length === 0) {
      fail({ raw: 'chained spot-check: AcmeInvoiceCastDemo -> AcmeInvoice.total' }, 'No caller nodes found at all');
    } else {
      const badVia = kids.filter((k) => k.via !== 'typed' || k.approximate);
      if (badVia.length) {
        fail(
          { raw: 'chained spot-check: AcmeInvoiceCastDemo -> AcmeInvoice.total (ternary receiver)' },
          `Expected all 4 receiver-shape caller nodes via='typed' (cast/safe-nav/ternary/for-each all resolve to AcmeInvoice) after v0.3.0; found non-typed/approximate node(s): ${badVia.map((k) => `${k.methodLower}:via=${k.via},approx=${k.approximate}`).join('; ')}`
        );
      }
    }
  }

  // needs:type-overloads -- AcmePricingEngine.calculatePrice must resolve
  // at class#method granularity still (unchanged contract per A4 note:
  // "methodCallers keying stays name-level (unchanged)") but EVERY site
  // must now carry a non-null overloadSig. Cross-check against the
  // overloadSig sweep above.
  {
    let missingSig = 0;
    for (const [k, v] of overloadSigByFileLine.entries()) {
      if (!v) missingSig++;
    }
    console.log(`calculatePrice sites with a null/missing overloadSig: ${missingSig} / ${overloadSigByFileLine.size}`);
    if (missingSig > 0) {
      fail({ raw: 'type-overloads spot-check: AcmePricingEngine.calculatePrice' }, `${missingSig} call site(s) have no overloadSig at all`);
    }
  }

  // --- final report ----------------------------------------------------
  console.log('\n=== RESULT ===');
  if (findings.length === 0) {
    console.log('PASS: every mechanically-checkable MANIFEST edge accounted for correctly. No regressions detected.');
  } else {
    console.log(`FAIL: ${findings.length} discrepancy(ies) found.\n`);
    findings.forEach((f, i) => {
      console.log(`${i + 1}. ${f.summary}`);
      console.log(`   edge: ${f.edge}`);
      if (f.extra) console.log(`   extra: ${JSON.stringify(f.extra)}`);
      console.log('');
    });
  }

  process.exitCode = findings.length === 0 ? 0 : 1;
}

main();

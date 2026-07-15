#!/usr/bin/env node
'use strict';
// Adversarial-verifier repro for the metascan.js hostile-input bars called
// out in the goal spec:
//   - hostile OmniScript XML with 500 <remoteClass> elements completes < 1s
//   - a 100-deep JSON DataPack doesn't throw (walkJsonForRemotePairs' 64-cap)
//
// Files under dev/ only.

const path = require('path');
const metascan = require(path.join(__dirname, '..', 'metascan.js'));

let failures = 0;
function assert(cond, msg) {
  if (!cond) { failures++; console.error('FAIL: ' + msg); } else { console.log('PASS: ' + msg); }
}

// ---------------------------------------------------------------------------
// (d1) hostile OmniScript XML: 500 <remoteClass>/<remoteMethod> pairs,
// completes well under 1s (goal spec bar).
// ---------------------------------------------------------------------------
{
  const parts = [];
  for (let i = 0; i < 500; i++) {
    parts.push(`  <element><remoteClass>AcmeClass${i}</remoteClass><remoteMethod>method${i}</remoteMethod></element>`);
  }
  const xml = `<?xml version="1.0"?>\n<OmniScript>\n${parts.join('\n')}\n</OmniScript>\n`;

  const t0 = Date.now();
  const refs = metascan.parseMetaFile({ path: 'HostileScript.os-meta.xml', text: xml });
  const elapsed = Date.now() - t0;

  console.log(`hostile OmniScript XML (500 remoteClass): ${elapsed}ms, ${refs.length} refs extracted`);
  assert(elapsed < 1000, `500-remoteClass OmniScript XML parses in < 1000ms (actual ${elapsed}ms)`);
  assert(refs.length === 500, `all 500 remoteClass/remoteMethod pairs extracted (actual ${refs.length})`);
  // sanity: correct pairing, not just count
  assert(refs[0].className === 'AcmeClass0' && refs[0].methodName === 'method0', 'first pair correctly paired (AcmeClass0/method0)');
  assert(refs[499].className === 'AcmeClass499' && refs[499].methodName === 'method499', 'last pair correctly paired (AcmeClass499/method499)');
}

// ---------------------------------------------------------------------------
// (d1b) adversarial worst-case for the OLD O(N*len) slice-per-match bug:
// many EARLY remoteClass matches with NO following remoteMethod at all (so
// the old code would slice increasingly large remainders of text on every
// failed lookahead). Still must stay well under budget.
// ---------------------------------------------------------------------------
{
  const parts = [];
  for (let i = 0; i < 2000; i++) {
    parts.push(`<remoteClass>Dangling${i}</remoteClass>`);
  }
  // one real pair at the very end, after 2000 non-paired remoteClass tags --
  // worst case for any implementation that re-slices from each match.
  parts.push(`<remoteClass>RealClass</remoteClass><remoteMethod>realMethod</remoteMethod>`);
  const xml = parts.join('\n');
  const t0 = Date.now();
  const refs = metascan.parseMetaFile({ path: 'Dangling.os-meta.xml', text: xml });
  const elapsed = Date.now() - t0;
  console.log(`hostile OmniScript XML (2000 dangling remoteClass + 1 real pair): ${elapsed}ms, ${refs.length} refs`);
  assert(elapsed < 1000, `2000-dangling-remoteClass worst case parses in < 1000ms (actual ${elapsed}ms)`);
  // NOTE: the documented pairing rule is "next <remoteMethod> found after
  // this <remoteClass> IN SOURCE ORDER" (best-effort, not a strict 1:1
  // block pairing) -- with only ONE <remoteMethod> anywhere in this
  // adversarial document, EVERY preceding dangling <remoteClass> legitimately
  // pairs with that same trailing <remoteMethod> (2000 danglers + 1 real =
  // 2001). This is documented, intended best-effort behavior, not a bug --
  // the assertion here is on PERFORMANCE (no O(N*len) blowup), not on count.
  assert(refs.length === 2001, `expected best-effort pairing count for this adversarial shape (every remoteClass before the sole remoteMethod pairs with it): got ${refs.length}`);
}

// ---------------------------------------------------------------------------
// (d2) 100-deep JSON DataPack must not throw (exceeds the 64 depth cap by a
// wide margin) -- parseMetaFile's never-throw contract must hold, and no
// RangeError (stack overflow) may propagate.
// ---------------------------------------------------------------------------
{
  // Build a 100-level-deep nested object with remoteClass/remoteMethod pairs
  // sprinkled at depth 10, 50, 90 (inside the cap) and 99 (beyond the cap) to
  // also confirm the cap actually stops descent rather than merely not
  // crashing (an over-generous "catch and swallow" would hide a real bug).
  const DEPTH = 100;
  let root = { remoteClass: 'DeepClass99', remoteMethod: 'deepMethod99' }; // innermost, depth 99
  for (let d = DEPTH - 1; d >= 0; d--) {
    const node = { child: root };
    if (d === 90) { node.remoteClass = 'DeepClass90'; node.remoteMethod = 'deepMethod90'; }
    if (d === 50) { node.remoteClass = 'DeepClass50'; node.remoteMethod = 'deepMethod50'; }
    if (d === 10) { node.remoteClass = 'DeepClass10'; node.remoteMethod = 'deepMethod10'; }
    root = node;
  }
  const text = JSON.stringify(root);

  let threw = null;
  let refs = [];
  const t0 = Date.now();
  try {
    refs = metascan.parseMetaFile({ path: 'Deep.json', text });
  } catch (e) {
    threw = e;
  }
  const elapsed = Date.now() - t0;
  console.log(`100-deep JSON DataPack: ${elapsed}ms, ${refs.length} refs, threw=${threw ? threw.message : 'no'}`);

  assert(threw === null, '100-deep JSON DataPack does not throw (parseMetaFile never-throw contract holds)');
  const names = refs.map((r) => r.className);
  assert(names.includes('DeepClass10'), 'depth-10 pair (well inside the 64 cap) is found');
  assert(names.includes('DeepClass50'), 'depth-50 pair (inside the 64 cap) is found');
  // depth 90/99 exceed MAX_JSON_DEPTH=64 -- the cap must actually stop
  // descent, not just avoid a crash by luck.
  assert(!names.includes('DeepClass90'), 'depth-90 pair (beyond the 64 cap) is correctly NOT descended into');
  assert(!names.includes('DeepClass99'), 'depth-99 pair (beyond the 64 cap) is correctly NOT descended into');
}

// ---------------------------------------------------------------------------
// (d3) genuinely pathological depth (10,000) must also not throw/hang --
// stronger than the spec's 100-deep bar, confirms the cap is a hard stop
// independent of how deep the adversarial input actually goes.
// ---------------------------------------------------------------------------
{
  let root = { remoteClass: 'X', remoteMethod: 'y' };
  for (let d = 0; d < 10000; d++) root = { child: root };
  const text = JSON.stringify(root);
  let threw = null;
  const t0 = Date.now();
  try {
    metascan.parseMetaFile({ path: 'VeryDeep.json', text });
  } catch (e) {
    threw = e;
  }
  const elapsed = Date.now() - t0;
  console.log(`10000-deep JSON DataPack: ${elapsed}ms, threw=${threw ? threw.message : 'no'}`);
  assert(threw === null, '10000-deep JSON DataPack does not throw');
  assert(elapsed < 2000, '10000-deep JSON DataPack completes quickly (cap bounds the walk, not just avoids a crash)');
}

console.log('\n=== H7(c)/metascan hostile-input verify summary ===');
console.log(failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);

'use strict';
// Adversarial-verifier fuzz probe, F1-specific (DML->trigger/flow linkage).
// Not part of the shipped test suite (dev/-only, per verification brief).
// Exercises three edge classes named in the round's fuzz instructions:
//   (a) DML on unknown/nonexistent-looking SObjects (no matching trigger,
//       no known type at all, weird generic/array shapes).
//   (b) Triggers with unusual/edge-case event lists (single event, all six
//       events, duplicated events, only-before, only-after, delete+undelete
//       mix on a non-trigger-having object downstream).
//   (c) Record-triggered-looking Flow XML missing its <start> block
//       entirely, or with a malformed/incomplete <start> block.
// Every case must complete without parser.parseFile / resolver.js /
// metascan.parseMetaFile ever throwing -- degrade to "no edge" instead.
//
// Usage: node dev/fuzz-f1-dml-trigger-flow.js

const parser = require('../parser');
const resolver = require('../resolver');
const metascan = require('../metascan');

let ran = 0;
let failures = 0;

function tryCase(label, fn) {
  ran++;
  try {
    const result = fn();
    console.log(`OK   ${label} -> ${JSON.stringify(result)}`);
  } catch (e) {
    failures++;
    console.log(`FAIL ${label} -> THREW: ${e && e.stack ? e.stack.split('\n').slice(0, 3).join(' | ') : e}`);
  }
}

function buildIndexAndTrace(sources, target) {
  const factsList = sources.map((s) => parser.parseFile(s));
  const anyParseError = factsList.some((f) => f.parseError);
  const index = resolver.buildSemanticIndex(factsList);
  let tree = null;
  if (target) tree = resolver.buildCallerTree(index, target, { maxDepth: 6 });
  return { anyParseError, index, tree };
}

console.log('=== (a) DML on unknown / weird-shaped SObjects ===');

tryCase('DML on totally invented object, no trigger anywhere', () => {
  const { index, tree } = buildIndexAndTrace(
    [
      {
        path: 'FuzzDmlA.cls',
        text:
          'public class FuzzDmlA {\n' +
          '    public void go() {\n' +
          '        Zzyzx_Nonexistent__c z = new Zzyzx_Nonexistent__c();\n' +
          '        insert z;\n' +
          '    }\n' +
          '}\n',
      },
    ],
    { classLower: 'fuzzdmla', methodLower: 'go' }
  );
  return { classes: index.classes.size, treeChildren: tree ? tree.root.children.length : null };
});

tryCase('DML on a bare/undeclared identifier (no resolvable type at all)', () => {
  const { index } = buildIndexAndTrace([
    {
      path: 'FuzzDmlB.cls',
      text:
        'public class FuzzDmlB {\n' +
        '    public void go() {\n' +
        '        insert somethingNeverDeclaredAnywhere;\n' +
        '    }\n' +
        '}\n',
    },
  ]);
  return { classes: index.classes.size, dmlSitesByObjectSize: index.dmlSitesByObject ? index.dmlSitesByObject.size : null };
});

tryCase('DML on nested generic (List<Map<Id,Weird__c>> style malformed head)', () => {
  const { index } = buildIndexAndTrace([
    {
      path: 'FuzzDmlC.cls',
      text:
        'public class FuzzDmlC {\n' +
        '    public void go() {\n' +
        '        List<Weird__c> stuff = new List<Weird__c>();\n' +
        '        upsert stuff;\n' +
        '    }\n' +
        '}\n',
    },
  ]);
  return { classes: index.classes.size };
});

tryCase('merge on an object with only ONE argument text (grammar edge)', () => {
  const { index } = buildIndexAndTrace([
    {
      path: 'FuzzDmlD.cls',
      text:
        'public class FuzzDmlD {\n' +
        '    public void go(Account a, Account b) {\n' +
        '        merge a b;\n' +
        '    }\n' +
        '}\n',
    },
  ]);
  return { classes: index.classes.size };
});

tryCase('Database.insert on unknown object via chained builder receiver', () => {
  const { index } = buildIndexAndTrace([
    {
      path: 'FuzzDmlE.cls',
      text:
        'public class FuzzDmlE {\n' +
        '    public void go() {\n' +
        '        Database.insert(buildRecords(), false);\n' +
        '    }\n' +
        '    private List<Ghost_Object__c> buildRecords() { return new List<Ghost_Object__c>(); }\n' +
        '}\n',
    },
  ]);
  return { classes: index.classes.size };
});

tryCase('DML statement with empty/whitespace-only target text (malformed-parse simulation)', () => {
  // Directly probes resolver internals\' defensive handling by feeding a
  // MethodFacts-shaped dml[] entry with a blank targetText -- this can\'t
  // happen from parser.js today (DmlStatementContext always has an
  // expression), but resolver.js must not assume that invariant blindly.
  const facts = {
    path: 'FuzzDmlF.cls',
    kind: 'class',
    name: 'FuzzDmlF',
    parseError: null,
    triggerInfo: null,
    types: [
      {
        name: 'FuzzDmlF',
        qualified: 'FuzzDmlF',
        isInterface: false,
        isEnum: false,
        extendsType: null,
        implementsTypes: [],
        annotations: [],
        fields: [],
        properties: [],
        methods: [
          {
            name: 'go',
            isCtor: false,
            isStatic: false,
            returnType: 'void',
            line: 1,
            endLine: 3,
            annotations: [],
            modifiers: [],
            params: [],
            locals: [],
            calls: [],
            dml: [{ op: 'insert', targetText: '   ', line: 2, col: 0, lineText: 'insert ;' }],
          },
        ],
      },
    ],
  };
  const index = resolver.buildSemanticIndex([facts]);
  return { classes: index.classes.size };
});

tryCase('DML op value outside the known set (hostile hand-built MethodFacts)', () => {
  const facts = {
    path: 'FuzzDmlG.cls',
    kind: 'class',
    name: 'FuzzDmlG',
    parseError: null,
    triggerInfo: null,
    types: [
      {
        name: 'FuzzDmlG',
        qualified: 'FuzzDmlG',
        isInterface: false,
        isEnum: false,
        extendsType: null,
        implementsTypes: [],
        annotations: [],
        fields: [],
        properties: [],
        methods: [
          {
            name: 'go',
            isCtor: false,
            isStatic: false,
            returnType: 'void',
            line: 1,
            endLine: 3,
            annotations: [],
            modifiers: [],
            params: [{ name: 'a', type: 'Account' }],
            locals: [],
            calls: [],
            dml: [{ op: 'frobnicate', targetText: 'a', line: 2, col: 0, lineText: 'frobnicate a;' }],
          },
        ],
      },
    ],
  };
  const index = resolver.buildSemanticIndex([facts]);
  return { classes: index.classes.size };
});

console.log('\n=== (b) Triggers with weird / edge-case event lists ===');

const weirdTriggerSources = [
  ['single event, before insert only', 'trigger FuzzTrigA on Weird_Object__c (before insert) {\n}\n'],
  ['all six events', 'trigger FuzzTrigB on Weird_Object__c (before insert, after insert, before update, after update, before delete, after delete) {\n}\n'],
  ['duplicated events', 'trigger FuzzTrigC on Weird_Object__c (before insert, before insert, before insert) {\n}\n'],
  ['undelete only', 'trigger FuzzTrigD on Weird_Object__c (after undelete) {\n}\n'],
  ['trigger on standard object with full event list', 'trigger FuzzTrigE on Account (before insert, after insert, before update, after update, before delete, after delete, after undelete) {\n}\n'],
  ['trigger with NO events at all (empty parens)', 'trigger FuzzTrigF on Weird_Object__c () {\n}\n'],
  ['trigger with malformed/unknown event keyword', 'trigger FuzzTrigG on Weird_Object__c (before frobnicate) {\n}\n'],
  ['trigger with trailing comma in event list', 'trigger FuzzTrigH on Weird_Object__c (before insert, after insert,) {\n}\n'],
  ['trigger body referencing Trigger.new with weird events', 'trigger FuzzTrigI on Weird_Object__c (before insert, after delete) {\n  List<Weird_Object__c> ws = Trigger.new;\n}\n'],
];

for (const [label, text] of weirdTriggerSources) {
  tryCase(`trigger fuzz: ${label}`, () => {
    const facts = parser.parseFile({ path: label.replace(/\W+/g, '_') + '.trigger', text });
    const index = resolver.buildSemanticIndex([facts]);
    // also drive a DML statement from a separate class targeting the same
    // object, to exercise emitDmlTriggerEdges against whatever triggerInfo
    // (however degenerate) this trigger produced.
    const dmlFacts = parser.parseFile({
      path: 'FuzzTriggerDmlCaller.cls',
      text:
        'public class FuzzTriggerDmlCaller {\n' +
        '    public void go(List<Weird_Object__c> ws) {\n' +
        '        update ws;\n' +
        '    }\n' +
        '}\n',
    });
    const combined = resolver.buildSemanticIndex([facts, dmlFacts]);
    return {
      parseError: !!facts.parseError,
      triggerInfo: facts.triggerInfo,
      classesInFirstIndex: index.classes.size,
      classesInCombinedIndex: combined.classes.size,
    };
  });
}

console.log('\n=== (c) Record-triggered Flow XML missing/malformed <start> ===');

const flowFuzzCases = [
  ['no <start> block at all', '<Flow xmlns="http://soap.sforce.com/2006/04/metadata"><actionCalls><actionName>FuzzInvocable</actionName><actionType>apex</actionType></actionCalls></Flow>'],
  ['<start> present but empty', '<Flow><start></start><actionCalls><actionName>FuzzInvocable</actionName><actionType>apex</actionType></actionCalls></Flow>'],
  ['<start> with triggerType but no object', '<Flow><start><triggerType>RecordBeforeSave</triggerType></start><actionCalls><actionName>FuzzInvocable</actionName><actionType>apex</actionType></actionCalls></Flow>'],
  ['<start> with object but no triggerType', '<Flow><start><object>Weird_Object__c</object></start><actionCalls><actionName>FuzzInvocable</actionName><actionType>apex</actionType></actionCalls></Flow>'],
  ['<start> unclosed tag', '<Flow><start><object>Weird_Object__c<triggerType>RecordAfterSave</start><actionCalls><actionName>FuzzInvocable</actionName><actionType>apex</actionType></actionCalls></Flow>'],
  ['<start> with unknown/garbage triggerType value', '<Flow><start><object>Weird_Object__c</object><triggerType>SomeMadeUpType</triggerType></start><actionCalls><actionName>FuzzInvocable</actionName><actionType>apex</actionType></actionCalls></Flow>'],
  ['two <start> blocks (malformed XML, first wins per regex)', '<Flow><start><object>First__c</object><triggerType>RecordBeforeSave</triggerType></start><start><object>Second__c</object><triggerType>RecordAfterSave</triggerType></start><actionCalls><actionName>FuzzInvocable</actionName><actionType>apex</actionType></actionCalls></Flow>'],
  ['empty file entirely', ''],
  ['not XML at all', 'this is not a flow definition {{{'],
];

for (const [label, text] of flowFuzzCases) {
  tryCase(`flow fuzz: ${label}`, () => {
    const refs = metascan.parseMetaFile({ path: 'FuzzFlow_' + label.replace(/\W+/g, '_') + '.flow-meta.xml', text });
    // feed straight into resolver's record-triggered-flow child-building via
    // attachMetaCallers + a class that DML's onto the (possibly-null)
    // flowObject, to make sure the null-object/null-recordTriggerType path
    // through resolver.js's flow-children logic never throws either.
    const invocableFacts = parser.parseFile({
      path: 'FuzzInvocable.cls',
      text: 'public class FuzzInvocable {\n    public static void execute() {\n    }\n}\n',
    });
    const index = resolver.buildSemanticIndex([invocableFacts]);
    resolver.attachMetaCallers(index, refs);
    const tree = resolver.buildCallerTree(index, { classLower: 'fuzzinvocable', methodLower: null }, { maxDepth: 6 });
    return {
      refCount: refs.length,
      refs: refs.map((r) => ({ kind: r.kind, flowObject: r.flowObject, flowRecordTriggerType: r.flowRecordTriggerType })),
      treeChildren: tree ? tree.root.children.length : null,
    };
  });
}

console.log(`\n=== SUMMARY: ${ran} cases run, ${failures} threw unexpectedly ===`);
if (failures > 0) {
  console.log('RESULT: FAIL');
  process.exit(1);
} else {
  console.log('RESULT: PASS (nothing threw)');
}

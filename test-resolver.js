'use strict';
// Standalone self-check for resolver.js: node test-resolver.js
//
// Builds FileFacts/TypeFacts/MethodFacts/CallFacts fixtures BY HAND, matching
// the frozen parser.js contract exactly — this file does NOT depend on
// parser.js existing. Exercises every numbered resolution rule plus the
// must-cover behaviors from the task brief (see the section markers below).

const assert = require('assert');
const { buildSemanticIndex, buildCallerTree, buildCalleeTree, suggestTargets, attachMetaCallers, buildEntryCatalog, buildImpactReport, impactMethodSignature, clampInt } = require('./resolver');

// ---- fixture builders (mirror the frozen contract's field names exactly) --

function ty(name, qualified, opts = {}) {
  return {
    name,
    qualified: qualified || name,
    isInterface: !!opts.isInterface,
    isEnum: !!opts.isEnum,
    extendsType: opts.extendsType || null,
    // G6: full raw extends list (interfaces may extend multiple parents);
    // falls back to [extendsType] when a caller only sets the singular
    // field, matching parser.js's own extendsType/extendsTypes pairing.
    extendsTypes: opts.extendsTypes || (opts.extendsType ? [opts.extendsType] : []),
    implementsTypes: opts.implementsTypes || [],
    annotations: opts.annotations || [],
    fields: opts.fields || [],
    properties: opts.properties || [],
    methods: opts.methods || [],
    // v0.11/B1 PARSER CONTRACT (additive): one entry per static final
    // String field with a single-literal initializer -- {name, literal}.
    // A non-final field, or one whose initializer isn't a single literal,
    // is never represented here at all (both are fixture-authoring
    // decisions in THIS file, mirroring "the parser never records it").
    constants: opts.constants || [],
  };
}

function mth(name, opts = {}) {
  return {
    name,
    isCtor: !!opts.isCtor,
    isStatic: !!opts.isStatic,
    returnType: opts.returnType || null,
    line: opts.line || 1,
    endLine: opts.endLine || opts.line || 1,
    annotations: opts.annotations || [],
    modifiers: opts.modifiers || [],
    params: opts.params || [],
    locals: opts.locals || [],
    calls: opts.calls || [],
    dml: opts.dml || [], // v0.4/F1: MethodFacts.dml, stubbed per the frozen spec shape
    throwsSites: opts.throwsSites || [], // v0.5/G2: [{typeName|null, line, col, lineText, varName?}]
    catches: opts.catches || [], // v0.5/G2: [{typeName, varName, line}]
    narrowings: opts.narrowings || [], // v0.5/G3: [{varName, typeName, line}]
    entries: opts.entries || [], // v0.5/G4: parser-supplied labels (e.g. anonymous-script) that resolver.js must MERGE with, not overwrite
  };
}

function cl(kind, method, opts = {}) {
  return {
    kind,
    receiver: opts.receiver != null ? opts.receiver : null,
    method,
    argTexts: opts.argTexts || [],
    lineText: opts.lineText || `${method}(...)`,
    line: opts.line || 1,
    col: opts.col || 0,
    accessor: opts.accessor, // only meaningful for kind:'prop' (A2) -- 'get'|'set'
  };
}

function file(path, kind, types, opts = {}) {
  return {
    path,
    kind,
    name: opts.name || path.split('/').pop().replace(/\.(cls|trigger)$/i, ''),
    parseError: opts.parseError || null,
    triggerInfo: opts.triggerInfo || null,
    types: types || [],
    text: opts.text, // only meaningful/read when parseError is set
  };
}

const P = (name) => `/ws/classes/${name}.cls`;
const PT = (name) => `/ws/triggers/${name}.trigger`;
const mkFile = (t) => file(P(t.name), 'class', [t]);

function labelsOf(nodes) {
  return nodes.map((n) => n.label);
}
// v0.13/H2: rollup-aware. Direct siblings are checked FIRST (byte-identical
// to the pre-H2 behavior for every confirmed node, which never moves); only
// once no direct match exists does this recurse into each sibling's own
// children -- which is exactly where an approximate node now lives when
// ctx.showUnconfirmed defaults to 'rollup' (nested one level under a single
// synthetic pseudo-node, see resolver.js's applyShowUnconfirmed). This one
// helper change is what lets every PRE-EXISTING findChild(...) assertion in
// this file keep passing unmodified under the new default, without each of
// them needing to opt back into 'expand' individually -- see this round's
// dedicated H2 rollup-shape tests (below) for assertions against the
// pseudo-node's OWN shape (label/kind/collapsibleState/children), which
// this helper deliberately does not substitute for.
function findChild(nodes, label) {
  const direct = nodes.find((n) => n.label === label);
  if (direct) return direct;
  for (const n of nodes) {
    if (n.children && n.children.length) {
      const found = findChild(n.children, label);
      if (found) return found;
    }
  }
  return undefined;
}

// =========================================================================
// Fixture workspace
// =========================================================================

// --- inheritance + args->param mapping + overload arity pick ------------
const OppServiceBase = ty('OppServiceBase', 'OppServiceBase', {
  methods: [mth('baseHelper', { line: 2 })],
});

const OppServiceCtor0 = mth('OppService', { isCtor: true, line: 3, params: [] });
const OppServiceCtor1 = mth('OppService', { isCtor: true, line: 4, params: [{ name: 'oppId', type: 'Id' }] });
const applyDiscount = mth('applyDiscount', { line: 5, params: [{ name: 'id', type: 'Id' }] });
const logArity1 = mth('log', { line: 6, params: [{ name: 'msg', type: 'String' }] });
const logArity2 = mth('log', { line: 7, params: [{ name: 'msg', type: 'String' }, { name: 'verbose', type: 'Boolean' }] });
const useBase = mth('useBase', {
  line: 8,
  calls: [cl('bare', 'baseHelper', { line: 8, lineText: 'baseHelper();' })],
});
const getNameAccessor = mth('(get Name)', { line: 20 }); // synthetic accessor scope

const OppService = ty('OppService', 'OppService', {
  extendsType: 'OppServiceBase',
  methods: [OppServiceCtor0, OppServiceCtor1, applyDiscount, logArity1, logArity2, useBase, getNameAccessor],
});

const LogCaller = ty('LogCaller', 'LogCaller', {
  methods: [
    mth('debugLog1', {
      line: 1,
      locals: [{ name: 'svc', type: 'OppService', line: 1 }],
      calls: [cl('dot', 'log', { receiver: 'svc', argTexts: ['"hi"'], line: 2, lineText: 'svc.log("hi");' })],
    }),
    mth('debugLog2', {
      line: 3,
      locals: [{ name: 'svc', type: 'OppService', line: 3 }],
      calls: [cl('dot', 'log', { receiver: 'svc', argTexts: ['"hi"', 'true'], line: 4, lineText: 'svc.log("hi", true);' })],
    }),
  ],
});

// InheritCaller: typed FIELD (not local) dispatches through the inherited
// baseHelper() -> exercises the field-lookup branch of TYPE ENV plus the
// extends-chain walk in rule 6's non-interface typed dispatch.
const InheritCaller = ty('InheritCaller', 'InheritCaller', {
  fields: [{ name: 'svc', type: 'OppService', isStatic: false }],
  methods: [
    mth('run', {
      line: 1,
      calls: [cl('dot', 'baseHelper', { receiver: 'svc', line: 1, lineText: 'svc.baseHelper();' })],
    }),
  ],
});

// OppTriggerHandler: typed LOCAL, args->param-name mapping, and (as a bonus)
// the chained-new receiver ('should'-level cast/new-chain resolution).
const OppTriggerHandler = ty('OppTriggerHandler', 'OppTriggerHandler', {
  methods: [
    mth('afterUpdate', {
      line: 2,
      locals: [{ name: 'svc', type: 'OppService', line: 3 }],
      calls: [
        cl('new', 'OppService', { line: 3, lineText: 'OppService svc = new OppService();' }),
        cl('dot', 'applyDiscount', { receiver: 'svc', argTexts: ['oppId'], line: 4, lineText: 'svc.applyDiscount(oppId);' }),
      ],
    }),
  ],
});

// OppTrigger: entry root, plus a chained-new dot call
// (`new OppTriggerHandler().afterUpdate()` -> one 'new' CallFacts + one 'dot'
// CallFacts whose receiver is the whole `new OppTriggerHandler()` text).
const OppTriggerType = ty('OppTrigger', 'OppTrigger', {
  methods: [
    mth('(trigger)', {
      line: 1,
      calls: [
        cl('new', 'OppTriggerHandler', { line: 2, lineText: 'new OppTriggerHandler().afterUpdate();' }),
        cl('dot', 'afterUpdate', { receiver: 'new OppTriggerHandler()', line: 2, lineText: 'new OppTriggerHandler().afterUpdate();' }),
      ],
    }),
  ],
});
const OppTriggerFile = file(PT('OppTrigger'), 'trigger', [OppTriggerType], {
  triggerInfo: { object: 'Opportunity', events: ['after update', 'after insert'] },
});

// --- tests-sorted-last (non-test wins over alphabetical order) ----------
const ZController = ty('ZController', 'ZController', {
  methods: [
    mth('init', {
      line: 1,
      calls: [cl('new', 'OppService', { argTexts: ['acc.Id'], line: 1, lineText: 'OppService svc = new OppService(acc.Id);' })],
    }),
  ],
});
const OppServiceTest = ty('OppServiceTest', 'OppServiceTest', {
  annotations: ['istest'],
  methods: [
    mth('testApply', {
      line: 2,
      locals: [{ name: 'svc', type: 'OppService', line: 2 }],
      calls: [
        cl('new', 'OppService', { line: 2, lineText: 'OppService svc = new OppService();' }),
        cl('dot', 'applyDiscount', { receiver: 'svc', argTexts: ['null'], line: 3, lineText: 'svc.applyDiscount(null);' }),
      ],
    }),
  ],
});

// --- interface dispatch (approximate fan-out to all implementers) -------
const IHandler = ty('IHandler', 'IHandler', {
  isInterface: true,
  methods: [mth('handle', { line: 1, params: [{ name: 'ctx', type: 'String' }] })],
});
const HandlerA = ty('HandlerA', 'HandlerA', {
  implementsTypes: ['IHandler'],
  methods: [mth('handle', { line: 1, params: [{ name: 'ctx', type: 'String' }] })],
});
const HandlerB = ty('HandlerB', 'HandlerB', {
  implementsTypes: ['IHandler'],
  methods: [mth('handle', { line: 1, params: [{ name: 'ctx', type: 'String' }] })],
});
const InterfaceCaller = ty('InterfaceCaller', 'InterfaceCaller', {
  methods: [
    mth('dispatch', {
      line: 1,
      locals: [{ name: 'h', type: 'IHandler', line: 1 }],
      calls: [cl('dot', 'handle', { receiver: 'h', argTexts: ['"go"'], line: 2, lineText: 'h.handle("go");' })],
    }),
  ],
});

// --- constructor '<init>' edges from new / this() / super() -------------
const CtorBase = ty('CtorBase', 'CtorBase', {
  methods: [mth('CtorBase', { isCtor: true, line: 1, params: [] })],
});
const CtorChild = ty('CtorChild', 'CtorChild', {
  extendsType: 'CtorBase',
  methods: [
    mth('CtorChild', {
      isCtor: true,
      line: 2,
      params: [],
      calls: [cl('bare', 'this', { argTexts: ['0'], line: 2, lineText: 'this(0);' })],
    }),
    mth('CtorChild', {
      isCtor: true,
      line: 3,
      params: [{ name: 'x', type: 'Integer' }],
      calls: [cl('bare', 'super', { argTexts: [], line: 3, lineText: 'super();' })],
    }),
  ],
});

// --- cycle guard (explicit mutual recursion via static dispatch) --------
const RecA = ty('RecA', 'RecA', {
  methods: [mth('ping', { line: 1, calls: [cl('dot', 'pong', { receiver: 'RecB', line: 1, lineText: 'RecB.pong();' })] })],
});
const RecB = ty('RecB', 'RecB', {
  methods: [mth('pong', { line: 1, calls: [cl('dot', 'ping', { receiver: 'RecA', line: 1, lineText: 'RecA.ping();' })] })],
});

// --- depth cap (linear chain, traced with a small maxDepth) -------------
const D0 = ty('D0', 'D0', { methods: [mth('m', { line: 1 })] });
const D1 = ty('D1', 'D1', { methods: [mth('m', { line: 1, calls: [cl('dot', 'm', { receiver: 'D0', line: 1 })] })] });
const D2 = ty('D2', 'D2', { methods: [mth('m', { line: 1, calls: [cl('dot', 'm', { receiver: 'D1', line: 1 })] })] });
const D3 = ty('D3', 'D3', { methods: [mth('m', { line: 1, calls: [cl('dot', 'm', { receiver: 'D2', line: 1 })] })] });
const D4 = ty('D4', 'D4', { methods: [mth('m', { line: 1, calls: [cl('dot', 'm', { receiver: 'D3', line: 1 })] })] });

// --- entries: Batchable (own + inherited execute), Queueable, Schedulable,
//     method-level @AuraEnabled, trigger root (OppTrigger above) ---------
const BatchJob = ty('BatchJob', 'BatchJob', {
  implementsTypes: ['Database.Batchable<sObject>'],
  methods: [mth('execute', { line: 5, params: [{ name: 'bc', type: 'Database.BatchableContext' }, { name: 'scope', type: 'List<SObject>' }] })],
});
const BatchBase = ty('BatchBase', 'BatchBase', {
  methods: [mth('execute', { line: 1, params: [{ name: 'bc', type: 'Database.BatchableContext' }, { name: 'scope', type: 'List<SObject>' }] })],
});
const BatchChild = ty('BatchChild', 'BatchChild', {
  extendsType: 'BatchBase',
  implementsTypes: ['Database.Batchable<sObject>'],
  methods: [], // no own execute() -> must walk extends chain to BatchBase
});
const QJob = ty('QJob', 'QJob', {
  implementsTypes: ['Queueable'],
  methods: [mth('execute', { line: 1, params: [{ name: 'qc', type: 'QueueableContext' }] })],
});
const SchedJob = ty('SchedJob', 'SchedJob', {
  implementsTypes: ['Schedulable'],
  methods: [mth('execute', { line: 1, params: [{ name: 'sc', type: 'SchedulableContext' }] })],
});
const AuraService = ty('AuraService', 'AuraService', {
  methods: [mth('getData', { line: 1, annotations: ['auraenabled'] })],
});

// --- unique-name approximate fallback ------------------------------------
const UniqueTarget = ty('UniqueTarget', 'UniqueTarget', {
  methods: [mth('uniqueMethod', { line: 1 })],
});
const UniqueCaller = ty('UniqueCaller', 'UniqueCaller', {
  methods: [
    mth('run', {
      line: 1,
      calls: [cl('dot', 'uniqueMethod', { receiver: '(someExpr ? a : b)', line: 1, lineText: '(someExpr?a:b).uniqueMethod();' })],
    }),
  ],
});

// --- platform denylist (no edge) + user-class shadowing (typed wins) ----
const DenyCaller = ty('DenyCaller', 'DenyCaller', {
  methods: [
    mth('run', {
      line: 1,
      calls: [cl('dot', 'debug', { receiver: 'System', argTexts: ['"hi"'], line: 1, lineText: 'System.debug("hi");' })],
    }),
  ],
});
const DatabaseHelper = ty('DatabaseHelper', 'DatabaseHelper', {
  methods: [mth('run', { line: 1 })],
});
const ShadowCaller = ty('ShadowCaller', 'ShadowCaller', {
  methods: [
    mth('go', {
      line: 1,
      // local named 'database' (a denylisted head-word) but TYPED to a real
      // user class DatabaseHelper -> must resolve via 'typed', denylist
      // must never override this (must-fix #7).
      locals: [{ name: 'database', type: 'DatabaseHelper', line: 1 }],
      calls: [cl('dot', 'run', { receiver: 'database', line: 2, lineText: 'database.run();' })],
    }),
  ],
});

// --- BUG #1 regression: overload arity split across an extends chain ----
// OwArBase declares log(String); OwArMid extends it and declares a
// DIFFERENT-arity overload log(String, Integer) -- NOT an override. A
// 1-arg call on an OwArMid-typed receiver must resolve to the INHERITED
// OwArBase.log(String), not misattribute to OwArMid.log just because
// OwArMid is the nearest class declaring *some* overload named 'log'.
const OwArBase = ty('OwArBase', 'OwArBase', {
  methods: [mth('log', { line: 1, params: [{ name: 'msg', type: 'String' }] })],
});
const OwArMid = ty('OwArMid', 'OwArMid', {
  extendsType: 'OwArBase',
  methods: [mth('log', { line: 1, params: [{ name: 'msg', type: 'String' }, { name: 'n', type: 'Integer' }] })],
});
const OwArCaller = ty('OwArCaller', 'OwArCaller', {
  methods: [
    mth('run', {
      line: 1,
      locals: [{ name: 'm', type: 'OwArMid', line: 1 }],
      calls: [cl('dot', 'log', { receiver: 'm', argTexts: ['"hi"'], line: 2, lineText: "m.log('hi');" })],
    }),
  ],
});

// --- BUG #2 regression: interface satisfied via an INHERITED base-class
// method (implementer declares no method of its own) -------------------
const IGreet = ty('IGreet', 'IGreet', { isInterface: true, methods: [mth('greet', { line: 1 })] });
const BaseGreetImpl = ty('BaseGreetImpl', 'BaseGreetImpl', {
  methods: [mth('greet', { line: 1 })],
});
const ConcreteGreetImpl = ty('ConcreteGreetImpl', 'ConcreteGreetImpl', {
  extendsType: 'BaseGreetImpl',
  implementsTypes: ['IGreet'],
  methods: [], // deliberately does NOT redeclare greet() -- legal Apex
});
const IGreetCaller = ty('IGreetCaller', 'IGreetCaller', {
  methods: [
    mth('run', {
      line: 1,
      locals: [{ name: 'g', type: 'IGreet', line: 1 }],
      calls: [cl('dot', 'greet', { receiver: 'g', line: 2, lineText: 'g.greet();' })],
    }),
  ],
});

// --- BUG #3 regression: local variable's name case-insensitively collides
// with a class name and must shadow it (typed instance dispatch wins over
// static class-name dispatch) --------------------------------------------
const ShadowTargetCls = ty('ShadowTargetCls', 'ShadowTargetCls', {
  methods: [mth('bar', { line: 1, isStatic: true })],
});
const ShadowOtherCls = ty('ShadowOtherCls', 'ShadowOtherCls', {
  methods: [mth('bar', { line: 1 })],
});
const VarShadowCaller = ty('VarShadowCaller', 'VarShadowCaller', {
  methods: [
    mth('run', {
      line: 1,
      // local literally named after class ShadowTargetCls but typed to
      // ShadowOtherCls -- must resolve to ShadowOtherCls.bar() (instance),
      // never to the static ShadowTargetCls.bar() the name collides with.
      locals: [{ name: 'ShadowTargetCls', type: 'ShadowOtherCls', line: 1 }],
      calls: [cl('dot', 'bar', { receiver: 'ShadowTargetCls', line: 2, lineText: 'ShadowTargetCls.bar();' })],
    }),
  ],
});

// --- BUG #4 regression: cast-then-call receiver uses the only syntax Apex
// actually allows -- an extra outer paren layer: ((Type) expr).method() --
const CastTargetX = ty('CastTargetX', 'CastTargetX', { methods: [mth('ping', { line: 1 })] });
const CastTargetY = ty('CastTargetY', 'CastTargetY', { methods: [mth('ping', { line: 1 })] }); // same method name, non-unique
const CastChainCallerX = ty('CastChainCallerX', 'CastChainCallerX', {
  methods: [
    mth('run', {
      line: 1,
      calls: [
        cl('dot', 'ping', {
          receiver: '((CastTargetX) getSomething())',
          line: 2,
          lineText: '((CastTargetX) getSomething()).ping();',
        }),
      ],
    }),
  ],
});

// --- inner-class bare-name self-reference immune to global collisions ---
const Outer1Inner = ty('Inner', 'Outer1.Inner', { methods: [mth('act', { line: 1 })] });
const Outer1 = ty('Outer1', 'Outer1', {
  methods: [mth('run', { line: 1, calls: [cl('new', 'Inner', { line: 1, lineText: 'new Inner().act();' })] })],
});
const Outer1File = file(P('Outer1'), 'class', [Outer1, Outer1Inner]);
// unrelated class with an inner type of the SAME bare name -> makes 'Inner'
// globally ambiguous; Outer1's own reference must still resolve locally.
const Outer2Inner = ty('Inner', 'Outer2.Inner', { methods: [mth('act', { line: 1 })] });
const Outer2 = ty('Outer2', 'Outer2', { methods: [] });
const Outer2File = file(P('Outer2'), 'class', [Outer2, Outer2Inner]);

// --- duplicate qualified-class-name collision (first-parsed wins) -------
const DupFileA = file('/ws/classes/dupA/DupClass.cls', 'class', [ty('DupClass', 'DupClass', { methods: [mth('a', { line: 1 })] })]);
const DupFileB = file('/ws/classes/dupB/DupClass.cls', 'class', [ty('DupClass', 'DupClass', { methods: [mth('b', { line: 1 })] })]);

// --- parse-error lexical fallback ----------------------------------------
const BrokenFile = file(P('BrokenGlue'), 'class', [], {
  parseError: 'unexpected token at line 2',
  text: 'public class BrokenGlue {\n  void run() { OppService.doStuff(); }\n}\n',
});

// =========================================================================
// A2/A3/A4/A6 amendment fixtures (additive -- existing fixtures above are
// untouched).
// =========================================================================

// ---- A2: property accessor call sites -----------------------------------
// QuoteModel declares a real PROPERTY (Status, with synthetic accessor
// scopes) and a plain FIELD (InternalFlag, no accessor scopes) -- the
// negative case must produce no edge even though the receiver resolves fine.
const QuoteModel = ty('QuoteModel', 'QuoteModel', {
  properties: [{ name: 'Status', type: 'String' }],
  fields: [{ name: 'InternalFlag', type: 'Boolean', isStatic: false }],
  methods: [mth('(get Status)', { line: 10 }), mth('(set Status)', { line: 11 })],
});
// Declares no property/field of its own -- accessing .Status through a
// QuoteModelChild-typed receiver must still resolve, attributed to the
// ANCESTOR (QuoteModel) that actually declares the property.
const QuoteModelChild = ty('QuoteModelChild', 'QuoteModelChild', {
  extendsType: 'QuoteModel',
  methods: [],
});
const PropConsumer = ty('PropConsumer', 'PropConsumer', {
  methods: [
    mth('touchStatus', {
      line: 1,
      locals: [{ name: 'q', type: 'QuoteModel', line: 1 }],
      calls: [
        cl('prop', 'Status', { receiver: 'q', accessor: 'get', argTexts: [], line: 2, lineText: 'String s = q.Status;' }),
        cl('prop', 'Status', { receiver: 'q', accessor: 'set', argTexts: ['newStatus'], line: 3, lineText: 'q.Status = newStatus;' }),
        cl('prop', 'InternalFlag', { receiver: 'q', accessor: 'get', argTexts: [], line: 4, lineText: 'Boolean f = q.InternalFlag;' }),
      ],
    }),
    mth('touchInherited', {
      line: 5,
      locals: [{ name: 'qc', type: 'QuoteModelChild', line: 5 }],
      calls: [cl('prop', 'Status', { receiver: 'qc', accessor: 'get', argTexts: [], line: 6, lineText: 'String s2 = qc.Status;' })],
    }),
    mth('touchStatic', {
      line: 7,
      calls: [cl('prop', 'Status', { receiver: 'QuoteModel', accessor: 'set', argTexts: ["'Open'"], line: 8, lineText: "QuoteModel.Status = 'Open';" })],
    }),
  ],
});

// ---- A3(a): cast receiver (dedicated amendment coverage, distinct from the
// pre-existing BUG #4 regression fixture above) ---------------------------
const CastPingTarget = ty('CastPingTarget', 'CastPingTarget', { methods: [mth('greet', { line: 1 })] });
const CastReceiverCaller = ty('CastReceiverCaller', 'CastReceiverCaller', {
  methods: [
    mth('run', {
      line: 1,
      calls: [
        cl('dot', 'greet', {
          receiver: '((CastPingTarget) somethingElse())',
          line: 2,
          lineText: '((CastPingTarget) somethingElse()).greet();',
        }),
      ],
    }),
  ],
});

// ---- A3(b): ternary receiver -- same-type (both sides resolve to the same
// class -> 'typed') and one-side (only one branch resolves -> 'unique-name',
// approximate) ------------------------------------------------------------
const TernBothCls = ty('TernBothCls', 'TernBothCls', { methods: [mth('act', { line: 1 })] });
const TernOnlyCls = ty('TernOnlyCls', 'TernOnlyCls', { methods: [mth('onlyAct', { line: 1 })] });
const TernCaller = ty('TernCaller', 'TernCaller', {
  methods: [
    mth('bothSame', {
      line: 1,
      locals: [
        { name: 'x', type: 'TernBothCls', line: 1 },
        { name: 'y', type: 'TernBothCls', line: 1 },
      ],
      calls: [cl('dot', 'act', { receiver: '(flag ? x : y)', line: 2, lineText: '(flag ? x : y).act();' })],
    }),
    mth('oneSide', {
      line: 3,
      locals: [{ name: 'p', type: 'TernOnlyCls', line: 3 }], // 'q' deliberately undeclared/unresolved
      calls: [cl('dot', 'onlyAct', { receiver: '(flag2 ? p : q)', line: 4, lineText: '(flag2 ? p : q).onlyAct();' })],
    }),
  ],
});

// ---- A3(c): chained receiver -- 2-total-hop, 3-total-hop, and a
// broken-segment (unresolvable return type) that must fall through to the
// existing unique-name fallback rather than mis-resolve ------------------
const ChainFinal = ty('ChainFinal', 'ChainFinal', { methods: [mth('chainFinish', { line: 1 })] });
const ChainMid = ty('ChainMid', 'ChainMid', { methods: [mth('chainStep', { line: 1, returnType: 'ChainFinal' })] });
const ChainStart = ty('ChainStart', 'ChainStart', { methods: [mth('chainBegin', { line: 1, returnType: 'ChainMid' })] });
const ChainBrokenMid = ty('ChainBrokenMid', 'ChainBrokenMid', {
  methods: [mth('chainStepBroken', { line: 1 })], // no returnType declared -> chain must fail here
});
const ChainBrokenStart = ty('ChainBrokenStart', 'ChainBrokenStart', {
  methods: [mth('chainBeginBroken', { line: 1, returnType: 'ChainBrokenMid' })],
});
// globally-unique name so the broken-chain call site's fallthrough to rule 7
// (unique-name) is unambiguous proof the chain resolver bailed out cleanly.
const ChainBrokenTarget = ty('ChainBrokenTarget', 'ChainBrokenTarget', {
  methods: [mth('chainBrokenFinish', { line: 1 })],
});
const ChainCaller = ty('ChainCaller', 'ChainCaller', {
  methods: [
    mth('runTwoHop', {
      line: 1,
      locals: [{ name: 'c', type: 'ChainStart', line: 1 }],
      calls: [cl('dot', 'chainStep', { receiver: 'c.chainBegin()', line: 2, lineText: 'c.chainBegin().chainStep();' })],
    }),
    mth('runThreeHop', {
      line: 3,
      locals: [{ name: 'c', type: 'ChainStart', line: 3 }],
      calls: [cl('dot', 'chainFinish', { receiver: 'c.chainBegin().chainStep()', line: 4, lineText: 'c.chainBegin().chainStep().chainFinish();' })],
    }),
    mth('runBroken', {
      line: 5,
      locals: [{ name: 'c', type: 'ChainBrokenStart', line: 5 }],
      calls: [
        cl('dot', 'chainBrokenFinish', {
          receiver: 'c.chainBeginBroken().chainStepBroken()',
          line: 6,
          lineText: 'c.chainBeginBroken().chainStepBroken().chainBrokenFinish();',
        }),
      ],
    }),
  ],
});

// ---- v0.10/A1 (was A3(c)): chained receiver -- a 5-segment chain is now
// WELL WITHIN the widened CHAIN_MAX=12 cap (pre-v0.10 this exceeded the old
// 4-segment cap and had to drop honestly -- see the REGRESSION-POLICY-
// PERMITTED rewrite below). OverflowHop4 sits exactly at the OLD segment-4
// truncation boundary and declares a decoy method with the SAME name as the
// real 5th-hop target, so this fixture still earns its keep post-A1: it now
// proves the walk goes ALL THE WAY to the real target (OverflowHop6) and
// never stops early at the old boundary class (OverflowHop5) just because
// that's where the pre-v0.10 cap used to bite.
const OverflowHop6 = ty('OverflowHop6', 'OverflowHop6', { methods: [mth('landHere', { line: 1 })] });
const OverflowHop5 = ty('OverflowHop5', 'OverflowHop5', {
  methods: [
    mth('hop5', { line: 1, returnType: 'OverflowHop6' }),
    mth('landHere', { line: 2 }), // decoy: same name as the real 5th-hop target, sitting at the segment-4 boundary
  ],
});
const OverflowHop4 = ty('OverflowHop4', 'OverflowHop4', { methods: [mth('hop4', { line: 1, returnType: 'OverflowHop5' })] });
const OverflowHop3 = ty('OverflowHop3', 'OverflowHop3', { methods: [mth('hop3', { line: 1, returnType: 'OverflowHop4' })] });
const OverflowHop2 = ty('OverflowHop2', 'OverflowHop2', { methods: [mth('hop2', { line: 1, returnType: 'OverflowHop3' })] });
const OverflowHop1 = ty('OverflowHop1', 'OverflowHop1', { methods: [mth('hop1', { line: 1, returnType: 'OverflowHop2' })] });
const OverflowChainCaller = ty('OverflowChainCaller', 'OverflowChainCaller', {
  methods: [
    mth('runOverflow', {
      line: 1,
      locals: [{ name: 'h', type: 'OverflowHop1', line: 1 }],
      calls: [
        cl('dot', 'landHere', {
          // 5 dot-segments in the receiver (hop1..hop5), one past the
          // documented 4-segment cap -- the traced call is landHere().
          receiver: 'h.hop1().hop2().hop3().hop4().hop5()',
          line: 2,
          lineText: 'h.hop1().hop2().hop3().hop4().hop5().landHere();',
        }),
      ],
    }),
  ],
});

// ---- A4: overload arg-type scoring must recognize subclass args, not just
// exact-head matches -- a `new SubOverloadDog()` argument must beat an
// unrelated overload (SubOverloadVehicle) and be scored as assignable to
// its declared ancestor (SubOverloadAnimal), even though the two overloads
// tie 0-0 under a head-string-only comparison. SubOverloadVehicle is
// declared FIRST so the pre-fix "first-declared wins on 0-0 tie" behavior
// would otherwise silently win.
const SubOverloadVehicle = ty('SubOverloadVehicle', 'SubOverloadVehicle', {});
const SubOverloadAnimal = ty('SubOverloadAnimal', 'SubOverloadAnimal', {});
const SubOverloadDog = ty('SubOverloadDog', 'SubOverloadDog', { extendsType: 'SubOverloadAnimal' });
const SubOverloadPicker = ty('SubOverloadPicker', 'SubOverloadPicker', {
  methods: [
    mth('pick', { line: 1, params: [{ name: 'v', type: 'SubOverloadVehicle' }] }),
    mth('pick', { line: 2, params: [{ name: 'a', type: 'SubOverloadAnimal' }] }),
  ],
});
const SubOverloadConsumer = ty('SubOverloadConsumer', 'SubOverloadConsumer', {
  methods: [
    mth('run', {
      line: 1,
      locals: [{ name: 'target', type: 'SubOverloadPicker', line: 1 }],
      calls: [
        cl('dot', 'pick', {
          receiver: 'target',
          argTexts: ['new SubOverloadDog()'],
          line: 2,
          lineText: 'target.pick(new SubOverloadDog());',
        }),
      ],
    }),
  ],
});

// ---- A4: overload type-pick across String/Integer/SObject/custom-class --
const OverloadCustomClass = ty('OverloadCustomClass', 'OverloadCustomClass', { methods: [mth('build', { line: 1 })] });
const OverloadTarget = ty('OverloadTarget', 'OverloadTarget', {
  methods: [
    mth('calculatePriceX', { line: 1, params: [{ name: 'code', type: 'String' }] }),
    mth('calculatePriceX', { line: 2, params: [{ name: 'qty', type: 'Integer' }] }),
    mth('calculatePriceX', { line: 3, params: [{ name: 'ord', type: 'Acme_Order__c' }] }),
    mth('calculatePriceX', { line: 4, params: [{ name: 'obj', type: 'OverloadCustomClass' }] }),
  ],
});
const OverloadCaller = ty('OverloadCaller', 'OverloadCaller', {
  methods: [
    mth('callString', {
      line: 1,
      calls: [cl('dot', 'calculatePriceX', { receiver: 'OverloadTarget', argTexts: ['"ABC"'], line: 2, lineText: 'OverloadTarget.calculatePriceX("ABC");' })],
    }),
    mth('callInteger', {
      line: 3,
      calls: [cl('dot', 'calculatePriceX', { receiver: 'OverloadTarget', argTexts: ['42'], line: 4, lineText: 'OverloadTarget.calculatePriceX(42);' })],
    }),
    mth('callSObject', {
      line: 5,
      locals: [{ name: 'ord', type: 'Acme_Order__c', line: 5 }],
      calls: [cl('dot', 'calculatePriceX', { receiver: 'OverloadTarget', argTexts: ['ord'], line: 6, lineText: 'OverloadTarget.calculatePriceX(ord);' })],
    }),
    mth('callCustomClass', {
      line: 7,
      calls: [
        cl('dot', 'calculatePriceX', {
          receiver: 'OverloadTarget',
          argTexts: ['new OverloadCustomClass()'],
          line: 8,
          lineText: 'OverloadTarget.calculatePriceX(new OverloadCustomClass());',
        }),
      ],
    }),
  ],
});

// ---- A6: metadata callers (LWC/Aura/Flow/OmniScript/VF) -- resolver-side
// tree synthesis only; MetaRefs are hand-stubbed here per the task brief
// (does not depend on metascan.js existing/matching exactly).
const AcmeMetaTarget = ty('AcmeMetaTarget', 'AcmeMetaTarget', {
  methods: [mth('doWork', { line: 1 }), mth('otherWork', { line: 2 })],
});

// =========================================================================
// Build the index once for most assertions.
// =========================================================================

const factsList = [
  mkFile(OppServiceBase),
  mkFile(OppService),
  mkFile(LogCaller),
  mkFile(InheritCaller),
  mkFile(OppTriggerHandler),
  OppTriggerFile,
  mkFile(ZController),
  mkFile(OppServiceTest),
  mkFile(IHandler),
  mkFile(HandlerA),
  mkFile(HandlerB),
  mkFile(InterfaceCaller),
  mkFile(CtorBase),
  mkFile(CtorChild),
  mkFile(RecA),
  mkFile(RecB),
  mkFile(D0),
  mkFile(D1),
  mkFile(D2),
  mkFile(D3),
  mkFile(D4),
  mkFile(BatchJob),
  mkFile(BatchBase),
  mkFile(BatchChild),
  mkFile(QJob),
  mkFile(SchedJob),
  mkFile(AuraService),
  mkFile(UniqueTarget),
  mkFile(UniqueCaller),
  mkFile(DenyCaller),
  mkFile(DatabaseHelper),
  mkFile(ShadowCaller),
  mkFile(OwArBase),
  mkFile(OwArMid),
  mkFile(OwArCaller),
  mkFile(IGreet),
  mkFile(BaseGreetImpl),
  mkFile(ConcreteGreetImpl),
  mkFile(IGreetCaller),
  mkFile(ShadowTargetCls),
  mkFile(ShadowOtherCls),
  mkFile(VarShadowCaller),
  mkFile(CastTargetX),
  mkFile(CastTargetY),
  mkFile(CastChainCallerX),
  Outer1File,
  Outer2File,
  DupFileA,
  DupFileB,
  BrokenFile,
  mkFile(QuoteModel),
  mkFile(QuoteModelChild),
  mkFile(PropConsumer),
  mkFile(CastPingTarget),
  mkFile(CastReceiverCaller),
  mkFile(TernBothCls),
  mkFile(TernOnlyCls),
  mkFile(TernCaller),
  mkFile(ChainFinal),
  mkFile(ChainMid),
  mkFile(ChainStart),
  mkFile(ChainBrokenMid),
  mkFile(ChainBrokenStart),
  mkFile(ChainBrokenTarget),
  mkFile(ChainCaller),
  mkFile(OverflowHop6),
  mkFile(OverflowHop5),
  mkFile(OverflowHop4),
  mkFile(OverflowHop3),
  mkFile(OverflowHop2),
  mkFile(OverflowHop1),
  mkFile(OverflowChainCaller),
  mkFile(OverloadCustomClass),
  mkFile(OverloadTarget),
  mkFile(OverloadCaller),
  mkFile(SubOverloadVehicle),
  mkFile(SubOverloadAnimal),
  mkFile(SubOverloadDog),
  mkFile(SubOverloadPicker),
  mkFile(SubOverloadConsumer),
  mkFile(AcmeMetaTarget),
];

const index = buildSemanticIndex(factsList);

// A6: attach hand-stubbed MetaRefs onto the shared index (mutates in place;
// safe to do once at top level since only AcmeMetaTarget-scoped lookups are
// affected).
const metaRefs = [
  {
    kind: 'lwc',
    label: 'acmeMetaDashboard',
    className: 'AcmeMetaTarget',
    methodName: 'doWork',
    path: 'lwc/acmeMetaDashboard/acmeMetaDashboard.js',
    line: 3,
    lineText: "import doWork from '@salesforce/apex/AcmeMetaTarget.doWork';",
  },
  {
    // second ref from the SAME lwc bundle -> must group onto the SAME node
    // as one extra site, not a second sibling node.
    kind: 'lwc',
    label: 'acmeMetaDashboard',
    className: 'AcmeMetaTarget',
    methodName: 'doWork',
    path: 'lwc/acmeMetaDashboard/acmeMetaDashboard.js',
    line: 9,
    lineText: 'doWork({ recordId: this.recordId });',
  },
  {
    kind: 'aura',
    label: 'AcmeMetaPanel',
    className: 'AcmeMetaTarget',
    methodName: null, // class-level controller="..." reference
    path: 'aura/AcmeMetaPanel/AcmeMetaPanel.cmp',
    line: 1,
    lineText: '<aura:component controller="AcmeMetaTarget">',
  },
  {
    kind: 'flow',
    label: 'AcmeMetaScreenFlow',
    className: 'AcmeMetaTarget',
    methodName: 'otherWork',
    path: 'flows/AcmeMetaScreenFlow.flow-meta.xml',
    line: 5,
    lineText: '<actionName>AcmeMetaTarget.otherWork</actionName>',
  },
  {
    // class-level Custom Metadata linkage (F4b) -- must land on the
    // metaEntryLabel('cmdt') branch, not the default fallthrough.
    kind: 'cmdt',
    label: 'AcmeMetaConfig.MetaTargetHandler',
    className: 'AcmeMetaTarget',
    methodName: null,
    path: 'customMetadata/AcmeMetaConfig.MetaTargetHandler.md-meta.xml',
    line: 4,
    lineText: '<value xsi:type="xsd:string">AcmeMetaTarget</value>',
  },
];
attachMetaCallers(index, metaRefs);

// =========================================================================
// Assertions
// =========================================================================

// ---- args -> param-name mapping in argsRendered -------------------------
{
  const tree = buildCallerTree(index, { classLower: 'oppservice', methodLower: 'applydiscount' });
  const child = findChild(tree.root.children, 'OppTriggerHandler.afterUpdate');
  assert.ok(child, 'expected OppTriggerHandler.afterUpdate as a caller of OppService.applyDiscount');
  const site = child.sites.find((s) => s.lineText.includes('applyDiscount'));
  assert.ok(site, 'expected the applyDiscount call site');
  assert.strictEqual(site.argsRendered, 'id: oppId', 'args should zip against the declared param name, not the arg text');
}

// ---- overload arity pick (log/1 vs log/2) --------------------------------
{
  const tree = buildCallerTree(index, { classLower: 'oppservice', methodLower: 'log' });
  const c1 = findChild(tree.root.children, 'LogCaller.debugLog1');
  const c2 = findChild(tree.root.children, 'LogCaller.debugLog2');
  assert.ok(c1 && c2, 'expected both debugLog1 and debugLog2 as callers of OppService.log');
  assert.strictEqual(c1.sites[0].argsRendered, 'msg: "hi"', '1-arg overload should zip against the 1-arg signature');
  assert.strictEqual(c2.sites[0].argsRendered, 'msg: "hi", verbose: true', '2-arg overload should zip against the 2-arg signature');
}

// ---- inheritance resolution (bare + typed-field, walking extends) ------
{
  // bare call inside OppService.useBase() -> OppServiceBase.baseHelper via extends chain
  const treeBare = buildCallerTree(index, { classLower: 'oppservicebase', methodLower: 'basehelper' });
  const bareCaller = findChild(treeBare.root.children, 'OppService.useBase');
  assert.ok(bareCaller, 'bare call should resolve baseHelper() through the extends chain');
  assert.strictEqual(bareCaller.via, 'this');

  // typed FIELD dispatch on an OppService instance also walks to the inherited method
  const fieldCaller = findChild(treeBare.root.children, 'InheritCaller.run');
  assert.ok(fieldCaller, 'typed field dispatch should resolve baseHelper() through the extends chain too');
  assert.strictEqual(fieldCaller.via, 'typed');
}

// ---- interface dispatch approximate (fan-out to interface + implementers) --
{
  const treeIface = buildCallerTree(index, { classLower: 'ihandler', methodLower: 'handle' });
  const ifaceCaller = findChild(treeIface.root.children, 'InterfaceCaller.dispatch');
  assert.ok(ifaceCaller, 'expected InterfaceCaller.dispatch as a caller of the interface method itself');
  assert.strictEqual(ifaceCaller.via, 'interface');
  assert.strictEqual(ifaceCaller.approximate, true, 'interface-dispatch edges must be marked approximate');

  const treeA = buildCallerTree(index, { classLower: 'handlera', methodLower: 'handle' });
  const treeB = buildCallerTree(index, { classLower: 'handlerb', methodLower: 'handle' });
  assert.ok(findChild(treeA.root.children, 'InterfaceCaller.dispatch'), 'fan-out must also reach HandlerA.handle');
  assert.ok(findChild(treeB.root.children, 'InterfaceCaller.dispatch'), 'fan-out must also reach HandlerB.handle');
}

// ---- constructor '<init>' edges from new / this() / super() -------------
{
  // new
  const treeCtor = buildCallerTree(index, { classLower: 'oppservice', methodLower: '<init>' });
  const zCtorCaller = findChild(treeCtor.root.children, 'ZController.init');
  const testCtorCaller = findChild(treeCtor.root.children, 'OppServiceTest.testApply');
  assert.ok(zCtorCaller && testCtorCaller, 'expected both ctor callers of OppService');
  assert.strictEqual(zCtorCaller.via, 'new');
  assert.strictEqual(zCtorCaller.sites[0].argsRendered, 'oppId: acc.Id', '1-arg ctor overload should zip correctly despite the merged <init> node');
  assert.strictEqual(testCtorCaller.sites[0].argsRendered, '', '0-arg ctor overload should render as empty args');

  // this()
  const treeChildCtor = buildCallerTree(index, { classLower: 'ctorchild', methodLower: '<init>' });
  const selfChain = findChild(treeChildCtor.root.children, 'CtorChild.<init>');
  assert.ok(selfChain, 'this(...) should create a self-referential <init> edge');
  assert.strictEqual(selfChain.via, 'this');

  // super()
  const treeBaseCtor = buildCallerTree(index, { classLower: 'ctorbase', methodLower: '<init>' });
  const superCaller = findChild(treeBaseCtor.root.children, 'CtorChild.<init>');
  assert.ok(superCaller, 'super() should create an edge from CtorChild.<init> to CtorBase.<init>');
  assert.strictEqual(superCaller.via, 'super');

  // chained-new bonus: new OppTriggerHandler().afterUpdate()
  const treeHandler = buildCallerTree(index, { classLower: 'opptriggerhandler', methodLower: 'afterupdate' });
  const chainCaller = findChild(treeHandler.root.children, 'OppTrigger');
  assert.ok(chainCaller, 'chained-new receiver should resolve afterUpdate() back to the trigger');
  assert.strictEqual(chainCaller.via, 'typed');
}

// ---- cycle guard ----------------------------------------------------------
{
  const tree = buildCallerTree(index, { classLower: 'reca', methodLower: 'ping' });
  const level1 = findChild(tree.root.children, 'RecB.pong');
  assert.ok(level1, 'expected RecB.pong as the direct caller of RecA.ping');
  assert.strictEqual(level1.cyclic, false);
  const level2 = findChild(level1.children, 'RecA.ping');
  assert.ok(level2, 'expected the cycle to re-surface RecA.ping one level down');
  assert.strictEqual(level2.cyclic, true, 'revisiting an ancestor (classLower#methodLower) must be flagged cyclic');
  assert.strictEqual(level2.children.length, 0, 'a cyclic node must not recurse further');
}

// ---- depth cap --------------------------------------------------------
{
  const tree = buildCallerTree(index, { classLower: 'd0', methodLower: 'm' }, { maxDepth: 3 });
  const d1 = findChild(tree.root.children, 'D1.m');
  assert.ok(d1 && !d1.truncated);
  const d2 = findChild(d1.children, 'D2.m');
  assert.ok(d2 && !d2.truncated);
  const d3 = findChild(d2.children, 'D3.m');
  assert.ok(d3, 'expected D3.m to still appear as the depth-cap boundary node');
  assert.strictEqual(d3.truncated, true, 'D3.m is reached exactly at maxDepth and must be truncated');
  assert.strictEqual(d3.children.length, 0, 'a truncated node must not recurse further (D4 must never appear)');
}

// ---- entries: Batchable (own + inherited), Queueable, Schedulable,
//      method-level @AuraEnabled, trigger root ----------------------------
{
  const batchJobExec = index.classes.get('batchjob').methods.find((m) => m.name === 'execute');
  assert.ok(batchJobExec.entries.includes('Batchable'), 'own execute() should get the Batchable entry');

  // BatchChild declares no execute() of its own -> entry attaches to the
  // ancestor (BatchBase) that actually implements it.
  const batchChildOwnExec = index.classes.get('batchchild').methods.find((m) => m.name === 'execute');
  assert.strictEqual(batchChildOwnExec, undefined, 'BatchChild has no declared execute() method of its own');
  const batchBaseExec = index.classes.get('batchbase').methods.find((m) => m.name === 'execute');
  assert.ok(batchBaseExec.entries.includes('Batchable'), 'inherited execute() should get the Batchable entry via the extends-chain walk');

  const qExec = index.classes.get('qjob').methods.find((m) => m.name === 'execute');
  assert.ok(qExec.entries.includes('Queueable'));
  const sExec = index.classes.get('schedjob').methods.find((m) => m.name === 'execute');
  assert.ok(sExec.entries.includes('Schedulable'));

  const auraMethod = index.classes.get('auraservice').methods.find((m) => m.name === 'getData');
  assert.ok(auraMethod.entries.includes('@AuraEnabled (LWC/Aura)'));

  const triggerTree = buildCallerTree(index, { classLower: 'opptrigger', methodLower: null });
  assert.strictEqual(triggerTree.root.kind, 'trigger');
  assert.strictEqual(triggerTree.root.label, 'OppTrigger');
  assert.ok(
    triggerTree.root.entries.some((e) => e === 'trigger on Opportunity (after update, after insert)'),
    'trigger pseudo-method entry should read the object + events'
  );
}

// ---- tests-sorted-last (non-test wins over alphabetical order) ---------
{
  const tree = buildCallerTree(index, { classLower: 'oppservice', methodLower: '<init>' });
  const labels = labelsOf(tree.root.children);
  const zIdx = labels.indexOf('ZController.init');
  const testIdx = labels.indexOf('OppServiceTest.testApply');
  assert.ok(zIdx !== -1 && testIdx !== -1);
  assert.ok(zIdx < testIdx, 'non-test caller must sort before a test caller even when alphabetically later');
  const zNode = tree.root.children[zIdx];
  const testNode = tree.root.children[testIdx];
  assert.strictEqual(zNode.isTest, false);
  assert.strictEqual(testNode.isTest, true);
}

// ---- unique-name approximate fallback -----------------------------------
{
  const tree = buildCallerTree(index, { classLower: 'uniquetarget', methodLower: 'uniquemethod' });
  const caller = findChild(tree.root.children, 'UniqueCaller.run');
  assert.ok(caller, 'complex/unresolved receiver should still resolve via the unique-name fallback');
  assert.strictEqual(caller.via, 'unique-name');
  assert.strictEqual(caller.approximate, true);
}

// ---- platform denylist (no edge) + user-class shadowing (typed wins) ---
{
  // System.debug(...) must produce NO edge anywhere.
  for (const key of index.methodCallers.keys()) {
    assert.ok(!key.endsWith('#debug'), `platform-denylisted "System.debug" must not create any edge (found key ${key})`);
  }

  // A local named 'database' (denylist head-word) but typed to a real user
  // class must still resolve via 'typed' — denylist never overrides a
  // resolved TYPE ENV shadow (must-fix #7).
  const tree = buildCallerTree(index, { classLower: 'databasehelper', methodLower: 'run' });
  const shadow = findChild(tree.root.children, 'ShadowCaller.go');
  assert.ok(shadow, 'typed local named after a denylisted word must still resolve');
  assert.strictEqual(shadow.via, 'typed');
}

// ---- BUG #1 regression: overload arity split across an extends chain ---
{
  const base = index.methodCallers.get('owarbase#log') || [];
  const mid = index.methodCallers.get('owarmid#log') || [];
  assert.strictEqual(mid.length, 0, 'the 1-arg call must NOT be misattributed to OwArMid.log(String,Integer), which does not accept 1 arg');
  assert.strictEqual(base.length, 1, 'the 1-arg call must resolve to the inherited OwArBase.log(String), the only overload whose arity matches');
  assert.strictEqual(base[0].via, 'typed');
  assert.strictEqual(base[0].callerClass, 'OwArCaller');
}

// ---- BUG #2 regression: interface satisfied via an inherited base-class
// method (implementer declares no method of its own) ---------------------
{
  const iface = index.methodCallers.get('igreet#greet') || [];
  const base = index.methodCallers.get('basegreetimpl#greet') || [];
  const concrete = index.methodCallers.get('concretegreetimpl#greet') || [];
  assert.strictEqual(iface.length, 1, 'the interface method itself should still get the approximate edge');
  assert.strictEqual(base.length, 1, 'the implementer\'s INHERITED base-class method must receive the edge -- it is the class that actually supplies the runtime behavior');
  assert.strictEqual(base[0].via, 'interface');
  assert.strictEqual(concrete.length, 0, 'ConcreteGreetImpl declares no greet() of its own, so it has no methodCallers key to receive an edge under');
}

// ---- BUG #3 regression: local variable shadows a same-named class ------
{
  const target = index.methodCallers.get('shadowtargetcls#bar') || [];
  const other = index.methodCallers.get('shadowothercls#bar') || [];
  assert.strictEqual(target.length, 0, 'a local variable named after class ShadowTargetCls must shadow it -- no static edge to ShadowTargetCls.bar()');
  assert.strictEqual(other.length, 1, 'the shadowing local\'s declared type (ShadowOtherCls) must receive the instance-dispatch edge');
  assert.strictEqual(other[0].via, 'typed');
}

// ---- BUG #4 regression: cast-then-call receiver, real Apex/Java syntax -
{
  const x = index.methodCallers.get('casttargetx#ping') || [];
  const y = index.methodCallers.get('casttargety#ping') || [];
  assert.strictEqual(x.length, 1, '((CastTargetX) getSomething()).ping() must resolve to CastTargetX.ping() via the cast-chain heuristic, even though ping() is non-unique across the codebase');
  assert.strictEqual(x[0].via, 'typed');
  assert.strictEqual(y.length, 0, 'the unrelated same-named CastTargetY.ping() must not receive an edge');
}

// ---- inner-class bare-name self-reference immune to global collisions --
{
  const tree = buildCallerTree(index, { classLower: 'outer1.inner', methodLower: '<init>' });
  const caller = findChild(tree.root.children, 'Outer1.run');
  assert.ok(caller, 'Outer1 must resolve its own bare "Inner" to Outer1.Inner despite Outer2.Inner existing elsewhere');
}

// ---- duplicate qualified-class-name collision (first-parsed wins) ------
{
  assert.ok(index.duplicates.includes('DupClass'), 'the losing duplicate should be recorded');
  const dup = index.classes.get('dupclass');
  assert.ok(dup.methods.some((m) => m.name === 'a'), 'the FIRST-parsed file (DupFileA) must win the Map slot');
  assert.ok(!dup.methods.some((m) => m.name === 'b'), 'the second (losing) duplicate must be fully ignored for resolution');
}

// ---- parse-error lexical fallback ---------------------------------------
{
  assert.ok(index.parseFallbacks.includes(P('BrokenGlue')));
  const tree = buildCallerTree(index, { classLower: 'oppservice', methodLower: null });
  // v0.13/H2: findChild (not a raw .find) -- a lexical node is approximate,
  // so it now lives nested under the default 'rollup' pseudo-node rather
  // than directly in tree.root.children; findChild recurses to find it.
  const lex = findChild(tree.root.children, 'BrokenGlue');
  assert.ok(lex, 'lexical fallback should surface a class-mention edge from the unparsable file');
  assert.strictEqual(lex.kind, 'class');
  assert.strictEqual(lex.via, 'lexical');
  assert.strictEqual(lex.approximate, true);
}

// ---- entries incl. Batchable/Queueable/Schedulable already covered above;
//      also confirm class-level entries rollup surfaces them -------------
{
  const cm = index.classes.get('batchjob');
  assert.ok(cm.entries.includes('Batchable'), "ClassMeta.entries should roll up its methods' entries");
}

// ---- suggestTargets: class + method entries, accessors suppressed ------
{
  const suggestions = suggestTargets(index);
  const labels = new Set(suggestions.map((s) => s.label));
  assert.ok(labels.has('OppService'));
  assert.ok(labels.has('OppService.applyDiscount'));
  assert.ok(!labels.has('OppService.(get Name)'), 'accessor scopes must never be suggested as trace targets (must-fix #5)');
  const oppSvcClassEntry = suggestions.find((s) => s.label === 'OppService' && s.methodLower === null);
  assert.ok(oppSvcClassEntry);
  const oppSvcMethodEntry = suggestions.find((s) => s.label === 'OppService.applyDiscount');
  assert.strictEqual(oppSvcMethodEntry.methodLower, 'applydiscount');
  // sorted
  const sorted = suggestions.map((s) => s.label).slice().sort((a, b) => a.localeCompare(b));
  assert.deepStrictEqual(suggestions.map((s) => s.label), sorted, 'suggestTargets must be sorted by label');
}

// ---- class-level rollup: classCallers ('new' + this/super) UNION
//      methodCallers of all OTHER methods, without double-counting -------
{
  const tree = buildCallerTree(index, { classLower: 'oppservice', methodLower: null });
  const labels = labelsOf(tree.root.children);
  assert.ok(labels.includes('ZController.init'));
  assert.ok(labels.includes('OppServiceTest.testApply'));
  assert.ok(labels.includes('OppTriggerHandler.afterUpdate'));
  assert.ok(labels.includes('LogCaller.debugLog1'));
  assert.ok(labels.includes('LogCaller.debugLog2'));
  // OppTriggerHandler.afterUpdate calls BOTH new OppService() and
  // svc.applyDiscount(oppId) -> must merge into ONE child node, not two.
  const dupCount = tree.root.children.filter((n) => n.label === 'OppTriggerHandler.afterUpdate').length;
  assert.strictEqual(dupCount, 1, 'a caller method touching the target via two different edges must appear once, not double-counted');
  const handlerNode = findChild(tree.root.children, 'OppTriggerHandler.afterUpdate');
  assert.strictEqual(handlerNode.sites.length, 2, 'both call sites (new + applyDiscount) should be attached to the single merged node');
}

// ---- buildCallerTree on an unknown target still returns a TreeResult ---
{
  const result = buildCallerTree(index, { classLower: 'nosuchclass', methodLower: null });
  assert.ok(result && result.root);
  assert.ok(result.note);
}

// =========================================================================
// A2: property accessor call-site resolution
// =========================================================================

// ---- get: instance property read, plus the inherited-property case -----
{
  const tree = buildCallerTree(index, { classLower: 'quotemodel', methodLower: '(get Status)' });
  const direct = findChild(tree.root.children, 'PropConsumer.touchStatus');
  assert.ok(direct, 'q.Status (get) should resolve to QuoteModel.(get Status)');
  assert.strictEqual(direct.via, 'typed');
  assert.strictEqual(direct.sites[0].argsRendered, '', 'a property getter never has args');

  const inherited = findChild(tree.root.children, 'PropConsumer.touchInherited');
  assert.ok(inherited, 'qc.Status (get), qc typed to the CHILD class, must still resolve to the ANCESTOR QuoteModel that declares the property');
  assert.strictEqual(inherited.via, 'typed');
}

// ---- set: instance property write, argsRendered = 'value: <text>' ------
{
  const tree = buildCallerTree(index, { classLower: 'quotemodel', methodLower: '(set Status)' });
  const direct = findChild(tree.root.children, 'PropConsumer.touchStatus');
  assert.ok(direct, 'q.Status = newStatus should resolve to QuoteModel.(set Status)');
  assert.strictEqual(direct.via, 'typed');
  assert.strictEqual(direct.sites[0].argsRendered, 'value: newStatus');

  // static (class-name) receiver -> via='static'
  const staticCaller = findChild(tree.root.children, 'PropConsumer.touchStatic');
  assert.ok(staticCaller, 'QuoteModel.Status = ... (class-name receiver) should also resolve');
  assert.strictEqual(staticCaller.via, 'static');
  assert.strictEqual(staticCaller.sites[0].argsRendered, "value: 'Open'");
}

// ---- field-not-property negative: no CallFacts-level edge at all -------
{
  assert.ok(!index.methodCallers.has('quotemodel#(get internalflag)'), 'a FIELD (not a property) must never get a synthetic accessor edge');
  for (const key of index.methodCallers.keys()) {
    assert.ok(!key.includes('internalflag'), `no accessor key should ever be created for the field-only InternalFlag (found ${key})`);
  }
}

// =========================================================================
// A3: receiver-upgrade resolution (cast / ternary / chained)
// =========================================================================

// ---- A3(a): cast receiver ------------------------------------------------
{
  const tree = buildCallerTree(index, { classLower: 'castpingtarget', methodLower: 'greet' });
  const caller = findChild(tree.root.children, 'CastReceiverCaller.run');
  assert.ok(caller, '((CastPingTarget) somethingElse()).greet() should resolve via the cast heuristic');
  assert.strictEqual(caller.via, 'typed');
}

// ---- A3(b): ternary receiver, same type on both sides -------------------
{
  const tree = buildCallerTree(index, { classLower: 'ternbothcls', methodLower: 'act' });
  const caller = findChild(tree.root.children, 'TernCaller.bothSame');
  assert.ok(caller, '(flag ? x : y).act() with x/y both typed TernBothCls should resolve');
  assert.strictEqual(caller.via, 'typed', 'both ternary branches resolving to the SAME class must use via=typed, not approximate');
  assert.strictEqual(caller.approximate, false);
}

// ---- A3(b): ternary receiver, only one side resolves ---------------------
{
  const tree = buildCallerTree(index, { classLower: 'ternonlycls', methodLower: 'onlyAct' });
  const caller = findChild(tree.root.children, 'TernCaller.oneSide');
  assert.ok(caller, '(flag2 ? p : q).onlyAct() with only p resolving should still resolve via the one-side ternary bonus');
  assert.strictEqual(caller.via, 'unique-name', 'only one ternary branch resolving must use the approximate unique-name via');
  assert.strictEqual(caller.approximate, true);
}

// ---- A3(c): chained receiver -- 2-hop and 3-hop --------------------------
{
  const treeTwoHop = buildCallerTree(index, { classLower: 'chainmid', methodLower: 'chainStep' });
  const twoHop = findChild(treeTwoHop.root.children, 'ChainCaller.runTwoHop');
  assert.ok(twoHop, 'c.chainBegin().chainStep() (2-hop chain) should resolve chainStep() on the walked-to class ChainMid');
  assert.strictEqual(twoHop.via, 'typed');

  const treeThreeHop = buildCallerTree(index, { classLower: 'chainfinal', methodLower: 'chainFinish' });
  const threeHop = findChild(treeThreeHop.root.children, 'ChainCaller.runThreeHop');
  assert.ok(threeHop, 'c.chainBegin().chainStep().chainFinish() (3-hop chain) should resolve chainFinish() on the walked-to class ChainFinal');
  assert.strictEqual(threeHop.via, 'typed');
}

// ---- A3(c): chained receiver -- broken segment falls through cleanly ----
{
  const tree = buildCallerTree(index, { classLower: 'chainbrokentarget', methodLower: 'chainBrokenFinish' });
  const caller = findChild(tree.root.children, 'ChainCaller.runBroken');
  assert.ok(caller, 'a chain whose middle segment has no declared returnType must still fall through to the unique-name fallback, not silently drop the edge');
  assert.strictEqual(caller.via, 'unique-name', 'the broken chain segment must NOT produce a typed/chained edge -- only the rule-7 fallback should fire');
  assert.strictEqual(caller.approximate, true);
}

// ---- v0.10/A1 REWRITE (was A3(c) "5-segment chain must drop honestly"):
// CHAIN_MAX widened from 4 to 12, so this 5-segment receiver (hop1..hop5)
// now WALKS THE FULL CHAIN and resolves the trailing landHere() call to the
// REAL target (OverflowHop6.landHere), via 'typed' -- never the decoy
// sitting at the old segment-4 boundary (OverflowHop5.landHere). This is
// the ONE permitted expectation rewrite the A1 amendment calls for
// explicitly; every other pre-v0.10 assertion in this file is unchanged.
{
  const overflowTargetTree = buildCallerTree(index, { classLower: 'overflowhop5', methodLower: 'landHere' });
  const wrongCaller = findChild(overflowTargetTree.root.children, 'OverflowChainCaller.runOverflow');
  assert.ok(!wrongCaller, 'v0.10/A1: the walk must NEVER stop early and credit the old segment-4 boundary class (OverflowHop5) now that CHAIN_MAX=12 lets it keep going');

  const realTargetTree = buildCallerTree(index, { classLower: 'overflowhop6', methodLower: 'landHere' });
  const realCaller = findChild(realTargetTree.root.children, 'OverflowChainCaller.runOverflow');
  assert.ok(realCaller, 'v0.10/A1: a 5-segment chain is within CHAIN_MAX=12 -- it must now resolve to the REAL target (OverflowHop6.landHere), not drop');
  assert.strictEqual(realCaller.via, 'typed', "v0.10/A1: resolved via the chained-receiver walk's own 'typed' via label, not a fallback rule");

  assert.strictEqual(index.methodCallers.get('overflowhop5#landhere'), undefined, 'v0.10/A1: still no caller entry at all for the decoy target');
  assert.ok(index.methodCallers.get('overflowhop6#landhere'), 'v0.10/A1: a real caller entry now exists for the real target, unlike the pre-v0.10 "absence is correct" outcome');
}

// =========================================================================
// A4: overload type-pick (String/Integer/SObject/custom-class 4-way tie)
// =========================================================================
{
  const tree = buildCallerTree(index, { classLower: 'overloadtarget', methodLower: 'calculatepricex' });

  const stringCaller = findChild(tree.root.children, 'OverloadCaller.callString');
  assert.ok(stringCaller);
  assert.strictEqual(stringCaller.sites[0].overloadSig, 'calculatePriceX(String)');
  assert.strictEqual(stringCaller.sites[0].argsRendered, 'code: "ABC"');

  const intCaller = findChild(tree.root.children, 'OverloadCaller.callInteger');
  assert.ok(intCaller);
  assert.strictEqual(intCaller.sites[0].overloadSig, 'calculatePriceX(Integer)');
  assert.strictEqual(intCaller.sites[0].argsRendered, 'qty: 42');

  const sobjCaller = findChild(tree.root.children, 'OverloadCaller.callSObject');
  assert.ok(sobjCaller);
  assert.strictEqual(sobjCaller.sites[0].overloadSig, 'calculatePriceX(Acme_Order__c)');
  assert.strictEqual(sobjCaller.sites[0].argsRendered, 'ord: ord');

  const customCaller = findChild(tree.root.children, 'OverloadCaller.callCustomClass');
  assert.ok(customCaller);
  assert.strictEqual(customCaller.sites[0].overloadSig, 'calculatePriceX(OverloadCustomClass)');
  assert.strictEqual(customCaller.sites[0].argsRendered, 'obj: new OverloadCustomClass()');

  // methodCallers keying stays name-level (unchanged) -- all 4 collapse onto ONE key.
  assert.strictEqual(index.methodCallers.get('overloadtarget#calculatepricex').length, 4);

  // A non-overloaded method must never carry an overloadSig.
  const plainTree = buildCallerTree(index, { classLower: 'oppservicebase', methodLower: 'basehelper' });
  const plainCaller = findChild(plainTree.root.children, 'OppService.useBase');
  assert.strictEqual(plainCaller.sites[0].overloadSig, null, 'a method with no sibling overloads must not carry an overloadSig');
}

// ---- A4: overload arg-type scoring recognizes subclass args (IS-A), not
// just exact head matches (regression for "new Subclass() scores the same
// as a totally-unrelated type" defect) -------------------------------------
{
  const tree = buildCallerTree(index, { classLower: 'suboverloadpicker', methodLower: 'pick' });
  const caller = findChild(tree.root.children, 'SubOverloadConsumer.run');
  assert.ok(caller, 'expected a caller node for target.pick(new SubOverloadDog())');
  assert.strictEqual(
    caller.sites[0].overloadSig,
    'pick(SubOverloadAnimal)',
    `a new SubOverloadDog() argument (SubOverloadDog extends SubOverloadAnimal) must pick the pick(SubOverloadAnimal) overload, not the unrelated first-declared pick(SubOverloadVehicle); got ${caller.sites[0].overloadSig}`
  );
}

// =========================================================================
// A6: metaCallers / metaMethodCallers tree synthesis
// =========================================================================
{
  assert.ok(index.metaCallers instanceof Map, 'attachMetaCallers must populate index.metaCallers');
  assert.ok(index.metaMethodCallers instanceof Map, 'attachMetaCallers must populate index.metaMethodCallers');

  // ---- method-level target: only refs pinned to THAT method appear ------
  const methodTree = buildCallerTree(index, { classLower: 'acmemetatarget', methodLower: 'doWork' });
  const metaChildren = methodTree.root.children.filter((n) => n.via === 'metadata');
  assert.strictEqual(metaChildren.length, 1, 'the two lwc refs for the SAME bundle must group onto one terminal node, and the flow ref (different method) must not appear here');
  const lwcNode = metaChildren[0];
  assert.strictEqual(lwcNode.kind, 'lwc');
  assert.strictEqual(lwcNode.label, 'acmeMetaDashboard');
  assert.strictEqual(lwcNode.via, 'metadata');
  assert.strictEqual(lwcNode.methodLower, null);
  assert.strictEqual(lwcNode.className, '');
  assert.deepStrictEqual(lwcNode.children, [], 'metadata callers are always terminal nodes');
  assert.strictEqual(lwcNode.isTest, false);
  assert.ok(lwcNode.entries.includes('@salesforce/apex import'));
  assert.strictEqual(lwcNode.sites.length, 2, 'both lwc refs (wire import + imperative call) must attach as two sites on the one grouped node');

  const otherWorkTree = buildCallerTree(index, { classLower: 'acmemetatarget', methodLower: 'otherWork' });
  const flowChildren = otherWorkTree.root.children.filter((n) => n.via === 'metadata');
  assert.strictEqual(flowChildren.length, 1);
  assert.strictEqual(flowChildren[0].kind, 'flow');
  assert.strictEqual(flowChildren[0].label, 'AcmeMetaScreenFlow');
  assert.ok(flowChildren[0].entries.includes('Flow apex action'));

  // ---- class-level target: roll up every metadata surface for every method
  // plus class-only refs, mirroring the Apex caller rollup itself.
  const classTree = buildCallerTree(index, { classLower: 'acmemetatarget', methodLower: null });
  const classMetaChildren = classTree.root.children.filter((n) => n.via === 'metadata');
  assert.strictEqual(classMetaChildren.length, 4, 'class-level target should show LWC, Flow, Aura, and CMDT references');
  assert.ok(classMetaChildren.some((n) => n.kind === 'lwc'));
  assert.ok(classMetaChildren.some((n) => n.kind === 'flow'));
  const auraChild = classMetaChildren.find((n) => n.kind === 'aura');
  assert.ok(auraChild, 'expected the aura class-level ref');
  assert.strictEqual(auraChild.label, 'AcmeMetaPanel');
  assert.ok(auraChild.entries.includes('Aura controller'));

  // F4b regression: kind='cmdt' nodes must get entries=['Custom Metadata
  // record'] (metaEntryLabel had no 'cmdt' case and fell through to the
  // generic 'metadata reference' default).
  const cmdtChild = classMetaChildren.find((n) => n.kind === 'cmdt');
  assert.ok(cmdtChild, 'expected the cmdt class-level ref');
  assert.strictEqual(cmdtChild.label, 'AcmeMetaConfig.MetaTargetHandler');
  assert.deepStrictEqual(cmdtChild.entries, ['Custom Metadata record'], `metaEntryLabel('cmdt') must return 'Custom Metadata record' per MANIFEST F4b, got ${JSON.stringify(cmdtChild.entries)}`);
  assert.strictEqual(cmdtChild.via, 'metadata');
  assert.deepStrictEqual(cmdtChild.children, [], 'cmdt nodes are terminal');
}

// =========================================================================
// Trigger Actions Framework: Action class <- Trigger_Action__mdt <- trigger
// =========================================================================
{
  const TafAfterUpdateAction = ty('TafAfterUpdateAction', 'TafAfterUpdateAction', {
    implementsTypes: ['TriggerAction.AfterUpdate'],
    methods: [mth('afterUpdate', { line: 2 })],
  });
  const TafRecordTrigger = ty('TafRecordTrigger', 'TafRecordTrigger', {
    methods: [mth('(trigger)', {
      line: 1,
      calls: [
        cl('dot', 'run', {
          receiver: 'new MetadataTriggerHandler()',
          line: 2,
          lineText: 'new MetadataTriggerHandler().run();',
        }),
        cl('new', 'MetadataTriggerHandler', {
          line: 2,
          lineText: 'new MetadataTriggerHandler().run();',
        }),
      ],
    })],
  });
  const UnrelatedRecordTrigger = ty('UnrelatedRecordTrigger', 'UnrelatedRecordTrigger', {
    methods: [mth('(trigger)', { line: 1 })],
  });
  const tafIndex = buildSemanticIndex([
    mkFile(TafAfterUpdateAction),
    file(PT('TafRecordTrigger'), 'trigger', [TafRecordTrigger], {
      triggerInfo: { object: 'Taf_Record__c', events: ['after update'] },
    }),
    file(PT('UnrelatedRecordTrigger'), 'trigger', [UnrelatedRecordTrigger], {
      triggerInfo: { object: 'Taf_Record__c', events: ['after update'] },
    }),
  ]);
  attachMetaCallers(tafIndex, [
    {
      kind: 'cmdt', label: 'Trigger_Action.Validate_Record',
      className: 'TafAfterUpdateAction', methodName: null,
      fieldName: 'Apex_Class_Name__c', path: '/ws/customMetadata/Trigger_Action.Validate_Record.md-meta.xml',
      line: 4, lineText: '<value xsi:type="xsd:string">TafAfterUpdateAction</value>',
    },
    {
      kind: 'cmdt', label: 'Trigger_Action.Validate_Record',
      className: 'Taf_Record_Setting', methodName: null,
      fieldName: 'After_Update__c', path: '/ws/customMetadata/Trigger_Action.Validate_Record.md-meta.xml',
      line: 8, lineText: '<value xsi:type="xsd:string">Taf_Record_Setting</value>',
    },
  ]);
  // The setting arrives in a later batch to pin attachMetaCallers' existing
  // order-independent multi-call contract.
  attachMetaCallers(tafIndex, [
    {
      kind: 'cmdt', label: 'sObject_Trigger_Setting.Taf_Record_Setting',
      className: 'Taf_Record__c', methodName: null,
      fieldName: 'Object_API_Name__c', path: '/ws/customMetadata/sObject_Trigger_Setting.Taf_Record_Setting.md-meta.xml',
      line: 4, lineText: '<value xsi:type="xsd:string">Taf_Record__c</value>',
    },
  ]);

  const classTree = buildCallerTree(tafIndex, { classLower: 'tafafterupdateaction', methodLower: null });
  const actionMetadata = classTree.root.children.find((node) => node.kind === 'cmdt');
  assert(actionMetadata, 'TAF action class trace includes its Trigger_Action__mdt record');
  assert(actionMetadata.entries.includes('Trigger action: after update'));
  assert.deepStrictEqual(actionMetadata.children.map((node) => node.label), ['TafRecordTrigger'],
    'only the object/event trigger proven to call MetadataTriggerHandler is linked');
  assert.strictEqual(actionMetadata.children[0].via, 'metadata');
  assert.strictEqual(actionMetadata.children[0].approximate, false);
  assert.strictEqual(actionMetadata.children[0].sites[0].lineText, 'new MetadataTriggerHandler().run();');

  const methodTree = buildCallerTree(tafIndex, { classLower: 'tafafterupdateaction', methodLower: 'afterupdate' });
  const methodMetadata = methodTree.root.children.find((node) => node.kind === 'cmdt');
  assert(methodMetadata, 'TAF context metadata also attaches to the exact afterUpdate implementation method');
  assert.deepStrictEqual(methodMetadata.children.map((node) => node.label), ['TafRecordTrigger']);
}

// A single matching object/event trigger without a recognizable canonical
// dispatcher is useful evidence but remains explicitly approximate.
{
  const TafFallbackAction = ty('TafFallbackAction', 'TafFallbackAction', {
    implementsTypes: ['TriggerAction.BeforeInsert'],
    methods: [mth('beforeInsert', { line: 2 })],
  });
  const TafCustomTrigger = ty('TafCustomTrigger', 'TafCustomTrigger', {
    methods: [mth('(trigger)', { line: 1 })],
  });
  const fallbackIndex = buildSemanticIndex([
    mkFile(TafFallbackAction),
    file(PT('TafCustomTrigger'), 'trigger', [TafCustomTrigger], {
      triggerInfo: { object: 'Taf_Fallback__c', events: ['before insert'] },
    }),
  ]);
  attachMetaCallers(fallbackIndex, [
    { kind: 'cmdt', label: 'Trigger_Action.Fallback', className: 'TafFallbackAction', methodName: null, fieldName: 'Apex_Class_Name__c', path: '/ws/action.xml', line: 1 },
    { kind: 'cmdt', label: 'Trigger_Action.Fallback', className: 'Fallback_Setting', methodName: null, fieldName: 'Before_Insert__c', path: '/ws/action.xml', line: 2 },
    { kind: 'cmdt', label: 'sObject_Trigger_Setting.Fallback_Setting', className: 'Taf_Fallback__c', methodName: null, fieldName: 'Object_API_Name__c', path: '/ws/setting.xml', line: 1 },
  ]);
  const tree = buildCallerTree(fallbackIndex, { classLower: 'taffallbackaction', methodLower: null });
  const cmdt = tree.root.children.find((node) => node.kind === 'cmdt');
  assert(cmdt && cmdt.children.length === 1);
  assert.strictEqual(cmdt.children[0].label, 'TafCustomTrigger');
  assert.strictEqual(cmdt.children[0].approximate, true, 'custom-dispatcher fallback must be visibly approximate');
}

// Disabled Trigger Actions Framework records remain visible as ordinary CMDT
// references at class level, but must not advertise executable trigger paths.
// Both the action-level and object-setting-level bypass flags are authoritative.
{
  const TafBypassAction = ty('TafBypassAction', 'TafBypassAction', {
    implementsTypes: ['TriggerAction.AfterUpdate'],
    methods: [mth('afterUpdate', { line: 2 })],
  });
  const TafBypassTrigger = ty('TafBypassTrigger', 'TafBypassTrigger', {
    methods: [mth('(trigger)', {
      line: 1,
      calls: [
        cl('dot', 'run', { receiver: 'MetadataTriggerHandler', line: 2 }),
      ],
    })],
  });
  const bypassIndex = buildSemanticIndex([
    mkFile(TafBypassAction),
    file(PT('TafBypassTrigger'), 'trigger', [TafBypassTrigger], {
      triggerInfo: { object: 'Taf_Bypass__c', events: ['after update'] },
    }),
  ]);
  attachMetaCallers(bypassIndex, [
    { kind: 'cmdt', label: 'Trigger_Action.Action_Bypassed', className: 'TafBypassAction', methodName: null, fieldName: 'Apex_Class_Name__c', path: '/ws/action-bypassed.xml', line: 1 },
    { kind: 'cmdt', label: 'Trigger_Action.Action_Bypassed', className: 'Active_Setting', methodName: null, fieldName: 'After_Update__c', path: '/ws/action-bypassed.xml', line: 2 },
    { kind: 'cmdt', label: 'Trigger_Action.Action_Bypassed', className: 'true', methodName: null, fieldName: 'Bypass_Execution__c', path: '/ws/action-bypassed.xml', line: 3 },
    { kind: 'cmdt', label: 'Trigger_Action.Setting_Bypassed', className: 'TafBypassAction', methodName: null, fieldName: 'Apex_Class_Name__c', path: '/ws/setting-bypassed-action.xml', line: 1 },
    { kind: 'cmdt', label: 'Trigger_Action.Setting_Bypassed', className: 'Bypassed_Setting', methodName: null, fieldName: 'After_Update__c', path: '/ws/setting-bypassed-action.xml', line: 2 },
    { kind: 'cmdt', label: 'sObject_Trigger_Setting.Active_Setting', className: 'Taf_Bypass__c', methodName: null, fieldName: 'Object_API_Name__c', path: '/ws/active-setting.xml', line: 1 },
    { kind: 'cmdt', label: 'sObject_Trigger_Setting.Bypassed_Setting', className: 'Taf_Bypass__c', methodName: null, fieldName: 'Object_API_Name__c', path: '/ws/bypassed-setting.xml', line: 1 },
    { kind: 'cmdt', label: 'sObject_Trigger_Setting.Bypassed_Setting', className: 'true', methodName: null, fieldName: 'Bypass_Execution__c', path: '/ws/bypassed-setting.xml', line: 2 },
  ]);

  const classTree = buildCallerTree(bypassIndex, { classLower: 'tafbypassaction', methodLower: null });
  const disabledActions = classTree.root.children.filter((node) =>
    node.kind === 'cmdt' && (node.label === 'Trigger_Action.Action_Bypassed' || node.label === 'Trigger_Action.Setting_Bypassed')
  );
  assert.strictEqual(disabledActions.length, 2, 'both bypassed action records remain inspectable at class level');
  for (const node of disabledActions) {
    assert.deepStrictEqual(node.children, [], `${node.label} must not link to a trigger while bypassed`);
    assert(!node.entries.some((entry) => entry.startsWith('Trigger action:')),
      `${node.label} must not be presented as an executable trigger action`);
  }
  const methodTree = buildCallerTree(bypassIndex, { classLower: 'tafbypassaction', methodLower: 'afterupdate' });
  assert(!methodTree.root.children.some((node) => node.kind === 'cmdt'),
    'bypassed actions must not attach to the exact TriggerAction context method');
}

// =========================================================================
// v0.4.0: F1 (resolver half: dml->trigger edges + Database.xxx mapping +
// record-flow children), F2 (collection-generic receivers), F3 (virtual
// override fan-out), F4a (Type.forName), F5 (entry-kind tail).
//
// Built against a SEPARATE factsList/index (factsListV4/indexV4), fully
// isolated from the shared corpus above -- this keeps the 86 pre-existing
// assertions immune to any interaction with the new fixtures (distinct
// class names besides), and keeps this section self-contained and easy to
// read top-to-bottom. Facts are hand-stubbed exactly per the frozen
// MethodFacts.dml shape from the v0.4 spec ({op, targetText, line, col,
// lineText}) -- this file does NOT depend on parser.js emitting it.
// =========================================================================

function dmlFact(op, targetText, opts = {}) {
  return {
    op,
    targetText,
    line: opts.line || 1,
    col: opts.col || 0,
    lineText: opts.lineText || `${op} ${targetText};`,
  };
}

// v0.5/G2: one MethodFacts.throwsSites entry -- either the creator-type form
// ('throw new AcmeX(...)' -> typeName set, varName omitted) or the rethrow
// form ('throw e;' -> typeName null, varName set).
function throwSite(opts = {}) {
  return {
    typeName: opts.typeName != null ? opts.typeName : null,
    varName: opts.varName || null,
    line: opts.line || 1,
    col: opts.col || 0,
    lineText: opts.lineText || (opts.typeName ? `throw new ${opts.typeName}(...);` : 'throw e;'),
  };
}

// v0.5/G2: one MethodFacts.catches entry.
function catchFact(typeName, varName, line) {
  return { typeName, varName, line: line || 1 };
}

// v0.5/G3: one MethodFacts.narrowings entry ('x instanceof T').
function narrowFact(varName, typeName, line) {
  return { varName, typeName, line: line || 1 };
}

// ---- F1: trigger inventory -----------------------------------------------
// Acme_Order__c-equivalent: ONE trigger, insert+update only (no delete/
// undelete event at all -- exercises the "op has no matching trigger"
// negative case). Acme_Shipment__c-equivalent: TWO triggers splitting
// insert/update vs delete/undelete -- exercises upsert/merge matching
// distinct trigger SUBSETS, incl. merge matching BOTH at once.
const V4OrderTriggerType = ty('V4OrderTrigger', 'V4OrderTrigger', {
  methods: [mth('(trigger)', { line: 1 })],
});
const V4OrderTriggerFile = file(PT('V4OrderTrigger'), 'trigger', [V4OrderTriggerType], {
  triggerInfo: { object: 'V4_Order__c', events: ['before insert', 'after insert', 'before update', 'after update'] },
});

const V4ShipmentTriggerType = ty('V4ShipmentTrigger', 'V4ShipmentTrigger', {
  methods: [
    mth('(trigger)', {
      line: 1,
      // Ordinary wiring call, also the OTHER half of the F1 self-DML cycle
      // fixture below (closes the cycle back onto this same '(trigger)' key).
      calls: [cl('dot', 'handle', { receiver: 'V4ShipmentTriggerHandler', line: 2, lineText: 'V4ShipmentTriggerHandler.handle(Trigger.new);' })],
    }),
  ],
});
const V4ShipmentTriggerFile = file(PT('V4ShipmentTrigger'), 'trigger', [V4ShipmentTriggerType], {
  triggerInfo: { object: 'V4_Shipment__c', events: ['before insert', 'after insert', 'before update', 'after update'] },
});

const V4ShipmentLifecycleTriggerType = ty('V4ShipmentLifecycleTrigger', 'V4ShipmentLifecycleTrigger', {
  methods: [mth('(trigger)', { line: 1 })],
});
const V4ShipmentLifecycleTriggerFile = file(PT('V4ShipmentLifecycleTrigger'), 'trigger', [V4ShipmentLifecycleTriggerType], {
  triggerInfo: { object: 'V4_Shipment__c', events: ['before delete', 'after undelete'] },
});

// ---- F1: statement-form + Database.xxx() method-form DML sites ----------
// Also doubles as the "single-record vs List<> target" and
// "Database.insert() form" coverage in one class.
const V4DmlService = ty('V4DmlService', 'V4DmlService', {
  methods: [
    mth('insertOrders', {
      line: 1,
      locals: [{ name: 'orders', type: 'List<V4_Order__c>', line: 1 }],
      dml: [dmlFact('insert', 'orders', { line: 2, lineText: 'insert orders;' })],
    }),
    mth('insertSingleShipment', {
      line: 3,
      locals: [{ name: 'shipment', type: 'V4_Shipment__c', line: 3 }],
      dml: [dmlFact('insert', 'shipment', { line: 4, lineText: 'insert shipment;' })],
    }),
    mth('updateShipments', {
      line: 5,
      locals: [{ name: 'shipments', type: 'List<V4_Shipment__c>', line: 5 }],
      dml: [dmlFact('update', 'shipments', { line: 6, lineText: 'update shipments;' })],
    }),
    mth('updateSingleOrder', {
      line: 7,
      locals: [{ name: 'order', type: 'V4_Order__c', line: 7 }],
      dml: [dmlFact('update', 'order', { line: 8, lineText: 'update order;' })],
    }),
    mth('deleteShipments', {
      line: 9,
      locals: [{ name: 'shipments', type: 'List<V4_Shipment__c>', line: 9 }],
      dml: [dmlFact('delete', 'shipments', { line: 10, lineText: 'delete shipments;' })],
    }),
    mth('deleteSingleOrder', {
      // negative case: V4_Order__c has no delete-capable trigger at all.
      line: 11,
      locals: [{ name: 'order', type: 'V4_Order__c', line: 11 }],
      dml: [dmlFact('delete', 'order', { line: 12, lineText: 'delete order;' })],
    }),
    mth('upsertOrders', {
      line: 13,
      locals: [{ name: 'orders', type: 'List<V4_Order__c>', line: 13 }],
      dml: [dmlFact('upsert', 'orders', { line: 14, lineText: 'upsert orders;' })],
    }),
    mth('upsertSingleShipment', {
      line: 15,
      locals: [{ name: 'shipment', type: 'V4_Shipment__c', line: 15 }],
      dml: [dmlFact('upsert', 'shipment', { line: 16, lineText: 'upsert shipment;' })],
    }),
    mth('mergeShipments', {
      // headline case: one merge statement -> two distinct trigger targets.
      line: 17,
      locals: [{ name: 'shipments', type: 'List<V4_Shipment__c>', line: 17 }],
      dml: [dmlFact('merge', 'shipments', { line: 18, lineText: 'merge shipments[0] shipments;' })],
    }),
    mth('mergeOrders', {
      line: 19,
      locals: [{ name: 'orders', type: 'List<V4_Order__c>', line: 19 }],
      dml: [dmlFact('merge', 'orders', { line: 20, lineText: 'merge orders[0] orders;' })],
    }),
    mth('undeleteShipments', {
      line: 21,
      locals: [{ name: 'shipments', type: 'List<V4_Shipment__c>', line: 21 }],
      dml: [dmlFact('undelete', 'shipments', { line: 22, lineText: 'undelete shipments;' })],
    }),
    mth('insertOrdersViaDatabase', {
      line: 23,
      locals: [{ name: 'orders', type: 'List<V4_Order__c>', line: 23 }],
      calls: [cl('dot', 'insert', { receiver: 'Database', argTexts: ['orders', 'false'], line: 24, lineText: 'Database.insert(orders, false);' })],
    }),
    mth('updateShipmentsViaDatabase', {
      line: 25,
      locals: [{ name: 'shipments', type: 'List<V4_Shipment__c>', line: 25 }],
      calls: [cl('dot', 'update', { receiver: 'Database', argTexts: ['shipments', 'true'], line: 26, lineText: 'Database.update(shipments, true);' })],
    }),
  ],
});

// A user class literally named 'Database' (same platform-shadow shape as
// the v0.3 fixture) -- declares no insert/update method. Proves the F1
// Database.xxx() method-form mapping runs independent of rule 5's
// definitive class-name match (which would otherwise resolve this receiver
// to THIS class, find no such method, and stop with 0 edges).
const V4DatabaseShadow = ty('Database', 'Database', { methods: [mth('describe', { line: 1 })] });

// ---- F1: self-DML cycle ---------------------------------------------------
// V4ShipmentTriggerHandler.handle() calls V4RollupHandler.rollupTotals(),
// which does 'update' DML on V4_Shipment__c -- closing the loop back onto
// V4ShipmentTrigger's own '(trigger)' pseudo-method, already on the
// ancestor path when tracing callers of that trigger.
const V4RollupHandler = ty('V4RollupHandler', 'V4RollupHandler', {
  methods: [
    mth('rollupTotals', {
      line: 1,
      locals: [{ name: 'shipment', type: 'V4_Shipment__c', line: 1 }],
      dml: [dmlFact('update', 'shipment', { line: 2, lineText: 'update shipment;' })],
    }),
  ],
});
const V4ShipmentTriggerHandler = ty('V4ShipmentTriggerHandler', 'V4ShipmentTriggerHandler', {
  methods: [
    mth('handle', {
      line: 1,
      calls: [cl('dot', 'rollupTotals', { receiver: 'V4RollupHandler', line: 2, lineText: 'V4RollupHandler.rollupTotals(newShipments);' })],
    }),
  ],
});

// ---- F1(b): record-triggered flow -> DML children ------------------------
const V4InvocableUpdate = ty('V4InvocableUpdate', 'V4InvocableUpdate', {
  methods: [mth('execute', { line: 1, annotations: ['invocablemethod'] })],
});
const V4InvocableCreate = ty('V4InvocableCreate', 'V4InvocableCreate', {
  methods: [mth('execute', { line: 1, annotations: ['invocablemethod'] })],
});
const metaRefsV4 = [
  {
    kind: 'flow',
    label: 'V4OrderUpdateFlow',
    className: 'V4InvocableUpdate',
    methodName: 'execute',
    flowObject: 'V4_Order__c',
    flowRecordTriggerType: 'Update',
    path: 'flows/V4OrderUpdateFlow.flow-meta.xml',
    line: 1,
    lineText: '<actionName>V4InvocableUpdate</actionName>',
  },
  {
    kind: 'flow',
    label: 'V4OrderCreateFlow',
    className: 'V4InvocableCreate',
    methodName: 'execute',
    flowObject: 'V4_Order__c',
    flowRecordTriggerType: 'Create',
    path: 'flows/V4OrderCreateFlow.flow-meta.xml',
    line: 1,
    lineText: '<actionName>V4InvocableCreate</actionName>',
  },
];

// ---- F2: collection-generic receivers -------------------------------------
const V4StepHandler = ty('V4StepHandler', 'V4StepHandler', {
  isInterface: true,
  methods: [mth('handleStep', { line: 1, params: [{ name: 'ctx', type: 'String' }] })],
});
const V4ValidateStepHandler = ty('V4ValidateStepHandler', 'V4ValidateStepHandler', {
  implementsTypes: ['V4StepHandler'],
  methods: [mth('handleStep', { line: 1, params: [{ name: 'ctx', type: 'String' }] })],
});
const V4NotifyStepHandler = ty('V4NotifyStepHandler', 'V4NotifyStepHandler', {
  implementsTypes: ['V4StepHandler'],
  methods: [mth('handleStep', { line: 1, params: [{ name: 'ctx', type: 'String' }] })],
});
const V4Step = ty('V4Step', 'V4Step', { methods: [mth('run', { line: 1 })] });
const V4StepDispatcher = ty('V4StepDispatcher', 'V4StepDispatcher', {
  methods: [
    mth('dispatch', {
      line: 1,
      params: [{ name: 'key', type: 'String' }],
      locals: [{ name: 'handlersByKey', type: 'Map<String,V4StepHandler>', line: 1 }],
      calls: [cl('dot', 'handleStep', { receiver: 'handlersByKey.get(key)', argTexts: ['key'], line: 2, lineText: 'handlersByKey.get(key).handleStep(key);' })],
    }),
    mth('runFirstStep', {
      line: 3,
      locals: [{ name: 'steps', type: 'List<V4Step>', line: 3 }],
      calls: [cl('dot', 'run', { receiver: 'steps[0]', line: 4, lineText: 'steps[0].run();' })],
    }),
    mth('runStepAt', {
      line: 5,
      params: [{ name: 'i', type: 'Integer' }],
      locals: [{ name: 'steps', type: 'List<V4Step>', line: 5 }],
      calls: [cl('dot', 'run', { receiver: 'steps.get(i)', line: 6, lineText: 'steps.get(i).run();' })],
    }),
    mth('runAllHandlers', {
      // F2: .values() on Map<K,V> -> List<V> must stay CHAINABLE (the .get()
      // right after it must resolve against the List's element type).
      line: 7,
      locals: [{ name: 'handlersByKey', type: 'Map<String,V4StepHandler>', line: 7 }],
      calls: [cl('dot', 'handleStep', { receiver: 'handlersByKey.values().get(0)', argTexts: ['"x"'], line: 8, lineText: 'handlersByKey.values().get(0).handleStep("x");' })],
    }),
  ],
});

// ---- F3: virtual override fan-out -----------------------------------------
const V4ShapeBase = ty('V4ShapeBase', 'V4ShapeBase', { methods: [mth('surchargeFactor', { line: 1 })] });
const V4ShapeMid = ty('V4ShapeMid', 'V4ShapeMid', {
  extendsType: 'V4ShapeBase',
  methods: [mth('surchargeFactor', { line: 1 })],
});
const V4ShapeConcrete = ty('V4ShapeConcrete', 'V4ShapeConcrete', {
  extendsType: 'V4ShapeMid',
  methods: [mth('surchargeFactor', { line: 1 })],
});
const V4ShapeAuditor = ty('V4ShapeAuditor', 'V4ShapeAuditor', {
  methods: [
    mth('auditSurcharge', {
      line: 1,
      params: [{ name: 'shape', type: 'V4ShapeBase' }],
      calls: [cl('dot', 'surchargeFactor', { receiver: 'shape', line: 2, lineText: 'shape.surchargeFactor();' })],
    }),
  ],
});

// ---- F4a: Type.forName(...) -----------------------------------------------
const V4EmailNotifier = ty('V4EmailNotifier', 'V4EmailNotifier', { methods: [] });
const V4HandlerFactory = ty('V4HandlerFactory', 'V4HandlerFactory', {
  methods: [
    mth('createEmailNotifier', {
      line: 1,
      calls: [cl('dot', 'forName', { receiver: 'Type', argTexts: ["'V4EmailNotifier'"], line: 2, lineText: "Type.forName('V4EmailNotifier');" })],
    }),
    mth('createGhostNotifier', {
      // negative case: literal names no class anywhere in this index.
      line: 3,
      calls: [cl('dot', 'forName', { receiver: 'Type', argTexts: ["'V4GhostNotifierDoesNotExist'"], line: 4, lineText: "Type.forName('V4GhostNotifierDoesNotExist');" })],
    }),
    mth('createNotifier', {
      // negative case: non-literal (variable) arg never qualifies.
      line: 5,
      params: [{ name: 'handlerName', type: 'String' }],
      calls: [cl('dot', 'forName', { receiver: 'Type', argTexts: ['handlerName'], line: 6, lineText: 'Type.forName(handlerName);' })],
    }),
  ],
});

// ---- F5: entry-kind tail ----------------------------------------------
const V4EmailHandler = ty('V4EmailHandler', 'V4EmailHandler', {
  implementsTypes: ['Messaging.InboundEmailHandler'],
  methods: [
    mth('handleInboundEmail', {
      line: 1,
      params: [{ name: 'email', type: 'Messaging.InboundEmail' }, { name: 'env', type: 'Messaging.InboundEnvelope' }],
    }),
  ],
});
const V4Priority = ty('V4Priority', 'V4Priority', {
  implementsTypes: ['Comparable'],
  methods: [mth('compareTo', { line: 1, params: [{ name: 'other', type: 'Object' }] })],
});
const V4Finalizer = ty('V4Finalizer', 'V4Finalizer', {
  implementsTypes: ['System.Finalizer'],
  methods: [mth('execute', { line: 1, params: [{ name: 'ctx', type: 'System.FinalizerContext' }] })],
});
const V4InstallHandler = ty('V4InstallHandler', 'V4InstallHandler', {
  implementsTypes: ['InstallHandler'],
  methods: [mth('onInstall', { line: 1, params: [{ name: 'ctx', type: 'InstallContext' }] })],
});
const V4UninstallHandler = ty('V4UninstallHandler', 'V4UninstallHandler', {
  implementsTypes: ['UninstallHandler'],
  methods: [mth('onUninstall', { line: 1, params: [{ name: 'ctx', type: 'UninstallContext' }] })],
});
const V4RegHandler = ty('V4RegHandler', 'V4RegHandler', {
  implementsTypes: ['Auth.RegistrationHandler'],
  methods: [
    mth('createUser', { line: 1, params: [{ name: 'a', type: 'Id' }, { name: 'b', type: 'Auth.UserData' }] }),
    mth('updateUser', { line: 2, params: [{ name: 'a', type: 'Id' }, { name: 'b', type: 'Id' }, { name: 'c', type: 'Auth.UserData' }] }),
  ],
});
const V4BatchJob = ty('V4BatchJob', 'V4BatchJob', {
  implementsTypes: ['Database.Batchable<sObject>'],
  methods: [
    mth('start', { line: 1, params: [{ name: 'bc', type: 'Database.BatchableContext' }] }),
    mth('execute', { line: 2, params: [{ name: 'bc', type: 'Database.BatchableContext' }, { name: 'scope', type: 'List<SObject>' }] }),
    mth('finish', { line: 3, params: [{ name: 'bc', type: 'Database.BatchableContext' }] }),
  ],
});

const factsListV4 = [
  V4OrderTriggerFile,
  V4ShipmentTriggerFile,
  V4ShipmentLifecycleTriggerFile,
  mkFile(V4DmlService),
  mkFile(V4DatabaseShadow),
  mkFile(V4RollupHandler),
  mkFile(V4ShipmentTriggerHandler),
  mkFile(V4InvocableUpdate),
  mkFile(V4InvocableCreate),
  mkFile(V4StepHandler),
  mkFile(V4ValidateStepHandler),
  mkFile(V4NotifyStepHandler),
  mkFile(V4Step),
  mkFile(V4StepDispatcher),
  mkFile(V4ShapeBase),
  mkFile(V4ShapeMid),
  mkFile(V4ShapeConcrete),
  mkFile(V4ShapeAuditor),
  mkFile(V4EmailNotifier),
  mkFile(V4HandlerFactory),
  mkFile(V4EmailHandler),
  mkFile(V4Priority),
  mkFile(V4Finalizer),
  mkFile(V4InstallHandler),
  mkFile(V4UninstallHandler),
  mkFile(V4RegHandler),
  mkFile(V4BatchJob),
];

const indexV4 = buildSemanticIndex(factsListV4);
attachMetaCallers(indexV4, metaRefsV4);

assert.ok(indexV4.dmlSitesByObject instanceof Map, 'buildSemanticIndex must expose dmlSitesByObject (F1(b) support)');

// =========================================================================
// F1(a): full DML op -> trigger event-mapping matrix
// =========================================================================

// ---- insert: List<> target (Order, single trigger) -----------------------
{
  const tree = buildCallerTree(indexV4, { classLower: 'v4ordertrigger', methodLower: '(trigger)' });
  const child = findChild(tree.root.children, 'V4DmlService.insertOrders');
  assert.ok(child, 'insert of a List<V4_Order__c> must trigger V4OrderTrigger (before/after insert)');
  assert.strictEqual(child.via, 'dml');
  assert.strictEqual(child.approximate, false, "via='dml' must NOT be approximate -- the trigger genuinely fires");
}

// ---- insert: SINGLE-record target (Shipment) ------------------------------
{
  const tree = buildCallerTree(indexV4, { classLower: 'v4shipmenttrigger', methodLower: '(trigger)' });
  const child = findChild(tree.root.children, 'V4DmlService.insertSingleShipment');
  assert.ok(child, 'insert of a SINGLE (non-List) V4_Shipment__c record must still trigger V4ShipmentTrigger');
  assert.strictEqual(child.via, 'dml');
}

// ---- update: List<> and single-record targets -----------------------------
{
  const treeShipment = buildCallerTree(indexV4, { classLower: 'v4shipmenttrigger', methodLower: '(trigger)' });
  assert.ok(findChild(treeShipment.root.children, 'V4DmlService.updateShipments'), 'update of List<V4_Shipment__c> must trigger V4ShipmentTrigger');

  const treeOrder = buildCallerTree(indexV4, { classLower: 'v4ordertrigger', methodLower: '(trigger)' });
  assert.ok(findChild(treeOrder.root.children, 'V4DmlService.updateSingleOrder'), 'update of a single V4_Order__c record must trigger V4OrderTrigger');
}

// ---- delete: matches ONLY the lifecycle trigger, never the main one ------
{
  const treeLifecycle = buildCallerTree(indexV4, { classLower: 'v4shipmentlifecycletrigger', methodLower: '(trigger)' });
  assert.ok(findChild(treeLifecycle.root.children, 'V4DmlService.deleteShipments'), 'delete DML on V4_Shipment__c must trigger V4ShipmentLifecycleTrigger (before/after delete)');

  const treeShipment = buildCallerTree(indexV4, { classLower: 'v4shipmenttrigger', methodLower: '(trigger)' });
  assert.ok(!findChild(treeShipment.root.children, 'V4DmlService.deleteShipments'), 'V4ShipmentTrigger has no delete event -- deleteShipments must NOT be one of its callers');
}

// ---- delete negative case: object has no delete-capable trigger at all --
{
  const tree = buildCallerTree(indexV4, { classLower: 'v4ordertrigger', methodLower: '(trigger)' });
  assert.ok(!findChild(tree.root.children, 'V4DmlService.deleteSingleOrder'), 'V4_Order__c has no trigger with a delete event -- delete DML on it must produce NO trigger edge');
}

// ---- upsert -> insert AND update trigger events ---------------------------
{
  const treeOrder = buildCallerTree(indexV4, { classLower: 'v4ordertrigger', methodLower: '(trigger)' });
  assert.ok(findChild(treeOrder.root.children, 'V4DmlService.upsertOrders'), 'upsert must match V4OrderTrigger via its combined insert+update event mapping');

  const treeShipment = buildCallerTree(indexV4, { classLower: 'v4shipmenttrigger', methodLower: '(trigger)' });
  assert.ok(findChild(treeShipment.root.children, 'V4DmlService.upsertSingleShipment'), 'upsert on a single shipment record must match V4ShipmentTrigger (insert+update events)');

  const treeLifecycle = buildCallerTree(indexV4, { classLower: 'v4shipmentlifecycletrigger', methodLower: '(trigger)' });
  assert.ok(!findChild(treeLifecycle.root.children, 'V4DmlService.upsertSingleShipment'), 'upsert must NOT match V4ShipmentLifecycleTrigger (delete/undelete events only)');
}

// ---- merge -> delete+update mapping; ONE statement, TWO trigger targets --
{
  const treeShipment = buildCallerTree(indexV4, { classLower: 'v4shipmenttrigger', methodLower: '(trigger)' });
  const treeLifecycle = buildCallerTree(indexV4, { classLower: 'v4shipmentlifecycletrigger', methodLower: '(trigger)' });
  assert.ok(findChild(treeShipment.root.children, 'V4DmlService.mergeShipments'), 'merge must match V4ShipmentTrigger via its update-half mapping');
  assert.ok(findChild(treeLifecycle.root.children, 'V4DmlService.mergeShipments'), 'merge must ALSO match V4ShipmentLifecycleTrigger via its delete-half mapping -- one DML statement, two distinct trigger targets');

  // On Order, only ONE trigger exists and it only covers insert/update, so
  // merge's delete-half matches nothing there -- but the update-half still
  // produces exactly one edge (same reasoning as the deleteSingleOrder
  // negative case, just for the other half of a merge).
  const treeOrder = buildCallerTree(indexV4, { classLower: 'v4ordertrigger', methodLower: '(trigger)' });
  assert.ok(findChild(treeOrder.root.children, 'V4DmlService.mergeOrders'), 'merge on V4_Order__c must match V4OrderTrigger via its update-half mapping');
}

// ---- undelete -> after-undelete event only --------------------------------
{
  const treeLifecycle = buildCallerTree(indexV4, { classLower: 'v4shipmentlifecycletrigger', methodLower: '(trigger)' });
  const treeShipment = buildCallerTree(indexV4, { classLower: 'v4shipmenttrigger', methodLower: '(trigger)' });
  assert.ok(findChild(treeLifecycle.root.children, 'V4DmlService.undeleteShipments'), 'undelete must match V4ShipmentLifecycleTrigger (after undelete)');
  assert.ok(!findChild(treeShipment.root.children, 'V4DmlService.undeleteShipments'), 'undelete must NOT match V4ShipmentTrigger (no undelete event declared)');
}

// ---- Database.insert()/.update() method-forms, incl. shadow-collision ---
{
  const treeOrder = buildCallerTree(indexV4, { classLower: 'v4ordertrigger', methodLower: '(trigger)' });
  const dbInsertChild = findChild(treeOrder.root.children, 'V4DmlService.insertOrdersViaDatabase');
  assert.ok(dbInsertChild, 'Database.insert(orders, false) method-form DML must produce a trigger edge, despite a user class literally named Database existing in this index (shadow-collision independence)');
  assert.strictEqual(dbInsertChild.via, 'dml');

  const treeShipment = buildCallerTree(indexV4, { classLower: 'v4shipmenttrigger', methodLower: '(trigger)' });
  const dbUpdateChild = findChild(treeShipment.root.children, 'V4DmlService.updateShipmentsViaDatabase');
  assert.ok(dbUpdateChild, 'Database.update(shipments, true) method-form DML must produce a trigger edge');
  assert.strictEqual(dbUpdateChild.via, 'dml');

  // Ordinary call-graph resolution for these SAME call sites stays harmless
  // (0 edges to the user Database class, which declares no insert/update
  // method) -- proves the DML mapping runs INDEPENDENTLY of, not by
  // suppressing or replacing, rule 5's ordinary dispatch.
  assert.strictEqual(indexV4.methodCallers.get('database#insert'), undefined);
  assert.strictEqual(indexV4.methodCallers.get('database#update'), undefined);
}

// =========================================================================
// F1: self-DML cycle -- must set the existing cyclic flag
// =========================================================================
{
  const tree = buildCallerTree(indexV4, { classLower: 'v4shipmenttrigger', methodLower: '(trigger)' });
  const rollupChild = findChild(tree.root.children, 'V4RollupHandler.rollupTotals');
  assert.ok(rollupChild, 'V4RollupHandler.rollupTotals does update DML on V4_Shipment__c -- must appear as a via=dml caller of V4ShipmentTrigger');
  assert.strictEqual(rollupChild.via, 'dml');
  assert.strictEqual(rollupChild.approximate, false);

  const handlerChild = findChild(rollupChild.children, 'V4ShipmentTriggerHandler.handle');
  assert.ok(handlerChild, 'expected V4ShipmentTriggerHandler.handle as a caller of rollupTotals');
  assert.strictEqual(handlerChild.via, 'static');

  const triggerChild = findChild(handlerChild.children, 'V4ShipmentTrigger');
  assert.ok(triggerChild, 'expected the trigger body itself as a caller of handle() (closing the cycle)');
  assert.strictEqual(
    triggerChild.cyclic,
    true,
    'the DML-induced cycle must set cyclic:true once the walk re-encounters V4ShipmentTrigger#(trigger), already on the ancestor path'
  );
}

// =========================================================================
// F1(b): record-triggered flow -> DML children
// =========================================================================
{
  const treeUpdate = buildCallerTree(indexV4, { classLower: 'v4invocableupdate', methodLower: 'execute' });
  const flowNode = treeUpdate.root.children.find((n) => n.via === 'metadata' && n.kind === 'flow');
  assert.ok(flowNode, 'expected the record-triggered flow node as a metadata caller of V4InvocableUpdate.execute');
  assert.strictEqual(flowNode.label, 'V4OrderUpdateFlow');
  const updateLabels = labelsOf(flowNode.children);
  assert.ok(updateLabels.includes('V4DmlService.updateSingleOrder'), 'Update-type flow children must include the update DML site');
  assert.ok(updateLabels.includes('V4DmlService.upsertOrders'), 'Update-type flow children must include the upsert DML site (upsert maps to Update too)');
  assert.ok(updateLabels.includes('V4DmlService.mergeOrders'), 'Update-type flow children must include the merge DML site (update half)');
  assert.ok(!updateLabels.includes('V4DmlService.insertOrders'), 'a pure insert DML site must NOT appear under an Update-type flow');
  assert.strictEqual(flowNode.children[0].via, 'dml');
  assert.strictEqual(flowNode.children[0].approximate, false);
  assert.deepStrictEqual(flowNode.children[0].children, [], 'flow-DML children are themselves terminal');

  const treeCreate = buildCallerTree(indexV4, { classLower: 'v4invocablecreate', methodLower: 'execute' });
  const flowNodeCreate = treeCreate.root.children.find((n) => n.via === 'metadata' && n.kind === 'flow');
  assert.ok(flowNodeCreate, 'expected the Create-type flow node as a metadata caller of V4InvocableCreate.execute');
  const createLabels = labelsOf(flowNodeCreate.children);
  assert.ok(createLabels.includes('V4DmlService.insertOrders'), 'Create-type flow children must include the insert DML site');
  assert.ok(createLabels.includes('V4DmlService.upsertOrders'), 'Create-type flow children must include the upsert DML site (upsert maps to Create too)');
  assert.ok(createLabels.includes('V4DmlService.insertOrdersViaDatabase'), 'Create-type flow children must include the Database.insert() method-form site too');
  assert.ok(!createLabels.includes('V4DmlService.updateSingleOrder'), 'a pure update DML site must NOT appear under a Create-type flow');
}

// =========================================================================
// F2: collection-generic receivers
// =========================================================================

// ---- Map<K,V>.get(...) -> V (interface -> approximate fan-out) -----------
{
  const treeValidate = buildCallerTree(indexV4, { classLower: 'v4validatestephandler', methodLower: 'handlestep' });
  const dispatchCaller = findChild(treeValidate.root.children, 'V4StepDispatcher.dispatch');
  assert.ok(dispatchCaller, 'handlersByKey.get(key).handleStep(...) must resolve via the F2 Map.get() chain to V4ValidateStepHandler');
  assert.strictEqual(dispatchCaller.via, 'interface');
  assert.strictEqual(dispatchCaller.approximate, true);

  const treeNotify = buildCallerTree(indexV4, { classLower: 'v4notifystephandler', methodLower: 'handlestep' });
  assert.ok(findChild(treeNotify.root.children, 'V4StepDispatcher.dispatch'), 'the same Map.get() chain call site must ALSO fan out to the second implementer, V4NotifyStepHandler');
}

// ---- List<T>[i] subscript -> T, and List<T>.get(i) -> T (concrete, typed) --
{
  const treeStep = buildCallerTree(indexV4, { classLower: 'v4step', methodLower: 'run' });
  const subscriptCaller = findChild(treeStep.root.children, 'V4StepDispatcher.runFirstStep');
  assert.ok(subscriptCaller, 'steps[0].run() (List<V4Step> subscript) must resolve to V4Step.run via F2');
  assert.strictEqual(subscriptCaller.via, 'typed');
  assert.strictEqual(subscriptCaller.approximate, false);

  const getCaller = findChild(treeStep.root.children, 'V4StepDispatcher.runStepAt');
  assert.ok(getCaller, 'steps.get(i).run() (List<V4Step>.get() chain) must resolve to V4Step.run via F2');
  assert.strictEqual(getCaller.via, 'typed');
  assert.strictEqual(getCaller.approximate, false);
}

// ---- Map<K,V>.values() -> List<V>, kept CHAINABLE into a further .get() --
{
  const tree = buildCallerTree(indexV4, { classLower: 'v4validatestephandler', methodLower: 'handlestep' });
  const allCaller = findChild(tree.root.children, 'V4StepDispatcher.runAllHandlers');
  assert.ok(allCaller, 'handlersByKey.values().get(0).handleStep(...) must chain Map.values() (-> List<V4StepHandler>) into a further List.get(), then fan out via interface (F2 chainability)');
  assert.strictEqual(allCaller.via, 'interface');
  assert.strictEqual(allCaller.approximate, true);
}

// =========================================================================
// F3: virtual override fan-out
// =========================================================================
{
  const treeBase = buildCallerTree(indexV4, { classLower: 'v4shapebase', methodLower: 'surchargefactor' });
  const baseCaller = findChild(treeBase.root.children, 'V4ShapeAuditor.auditSurcharge');
  assert.ok(baseCaller, 'expected the base-class typed edge (unaffected by F3)');
  assert.strictEqual(baseCaller.via, 'typed');
  assert.strictEqual(baseCaller.approximate, false);

  const treeMid = buildCallerTree(indexV4, { classLower: 'v4shapemid', methodLower: 'surchargefactor' });
  const midCaller = findChild(treeMid.root.children, 'V4ShapeAuditor.auditSurcharge');
  assert.ok(midCaller, 'F3: the same call site must ALSO fan out to V4ShapeMid.surchargeFactor (a direct override)');
  assert.strictEqual(midCaller.via, 'override');
  assert.strictEqual(midCaller.approximate, true);

  const treeConcrete = buildCallerTree(indexV4, { classLower: 'v4shapeconcrete', methodLower: 'surchargefactor' });
  const concreteCaller = findChild(treeConcrete.root.children, 'V4ShapeAuditor.auditSurcharge');
  assert.ok(concreteCaller, 'F3: fan-out must reach TWO levels down the hierarchy too (V4ShapeConcrete overrides via V4ShapeMid)');
  assert.strictEqual(concreteCaller.via, 'override');
  assert.strictEqual(concreteCaller.approximate, true);
}

// =========================================================================
// F4a: Type.forName(...) -- known class, unknown class, non-literal arg
// =========================================================================
{
  const tree = buildCallerTree(indexV4, { classLower: 'v4emailnotifier', methodLower: '<init>' });
  const caller = findChild(tree.root.children, 'V4HandlerFactory.createEmailNotifier');
  assert.ok(caller, "Type.forName('V4EmailNotifier') with a single string-literal arg matching a known class must produce an edge to V4EmailNotifier.<init>");
  assert.strictEqual(caller.via, 'dynamic');
  assert.strictEqual(caller.approximate, true);
}
{
  // negative case: literal names no class anywhere in the index.
  assert.strictEqual(indexV4.methodCallers.get('v4ghostnotifierdoesnotexist#<init>'), undefined, "Type.forName('V4GhostNotifierDoesNotExist') must produce NO edge");
}
{
  // negative case: non-literal (variable) arg never qualifies, regardless
  // of what handlerName might hold at runtime.
  let sawCreateNotifierCtorEdge = false;
  for (const sites of indexV4.methodCallers.values()) {
    for (const s of sites) {
      if (s.callerMethod === 'createNotifier' && s.via === 'dynamic') sawCreateNotifierCtorEdge = true;
    }
  }
  assert.strictEqual(sawCreateNotifierCtorEdge, false, 'Type.forName(handlerName) with a variable arg must produce NO dynamic edge');
}

// =========================================================================
// F5: entry-kind tail -- one new entry-kind per new interface, plus
// Batchable's start()/finish() joining execute() (regression-checked too).
// =========================================================================
{
  const findMethod = (classLower, methodName) => {
    const cm = indexV4.classes.get(classLower);
    return cm && cm.methods.find((m) => m.name === methodName);
  };

  const mmEmail = findMethod('v4emailhandler', 'handleInboundEmail');
  assert.ok(mmEmail && mmEmail.entries.includes('InboundEmailHandler (Email Service)'), 'Messaging.InboundEmailHandler implementer must get the InboundEmailHandler entry');

  const mmCompare = findMethod('v4priority', 'compareTo');
  assert.ok(mmCompare && mmCompare.entries.includes('Comparable (invoked by sort)'), 'Comparable implementer must get the Comparable entry');

  const mmFinalize = findMethod('v4finalizer', 'execute');
  assert.ok(mmFinalize && mmFinalize.entries.includes('Finalizer (async)'), 'System.Finalizer implementer must get the Finalizer entry');

  const mmInstall = findMethod('v4installhandler', 'onInstall');
  assert.ok(mmInstall && mmInstall.entries.includes('InstallHandler (package install)'), 'InstallHandler implementer must get the InstallHandler entry');

  const mmUninstall = findMethod('v4uninstallhandler', 'onUninstall');
  assert.ok(mmUninstall && mmUninstall.entries.includes('UninstallHandler (package uninstall)'), 'UninstallHandler implementer must get the UninstallHandler entry');

  const mmCreateUser = findMethod('v4reghandler', 'createUser');
  const mmUpdateUser = findMethod('v4reghandler', 'updateUser');
  assert.ok(mmCreateUser && mmCreateUser.entries.includes('RegistrationHandler (SSO)'), 'Auth.RegistrationHandler.createUser must get the RegistrationHandler entry');
  assert.ok(mmUpdateUser && mmUpdateUser.entries.includes('RegistrationHandler (SSO)'), 'Auth.RegistrationHandler.updateUser must get the RegistrationHandler entry too');

  const mmStart = findMethod('v4batchjob', 'start');
  const mmExecute = findMethod('v4batchjob', 'execute');
  const mmFinish = findMethod('v4batchjob', 'finish');
  assert.ok(mmStart && mmStart.entries.includes('Batchable'), 'F5: Batchable.start() must also get the Batchable entry');
  assert.ok(mmFinish && mmFinish.entries.includes('Batchable'), 'F5: Batchable.finish() must also get the Batchable entry');
  assert.ok(mmExecute && mmExecute.entries.includes('Batchable'), 'Batchable.execute() already got this pre-v0.4 -- regression check');
}

// =========================================================================
// v0.5 fixture workspace: G1 (publish), G2 (throw/catch), G3 (narrowed),
// G5 (async), G6 (iface-extends)
// =========================================================================

// ---- G1: EventBus.publish -> platform-event trigger linkage -------------
const V5NoteEventTriggerType = ty('V5NoteEventTrigger', 'V5NoteEventTrigger', {
  methods: [
    mth('(trigger)', {
      line: 1,
      calls: [cl('dot', 'handle', { receiver: 'V5NoteEventHandler', line: 2, lineText: 'V5NoteEventHandler.handle(Trigger.new);' })],
    }),
  ],
});
const V5NoteEventTriggerFile = file(PT('V5NoteEventTrigger'), 'trigger', [V5NoteEventTriggerType], {
  triggerInfo: { object: 'Acme_Note__e', events: ['after insert'] },
});
const V5NoteEventHandler = ty('V5NoteEventHandler', 'V5NoteEventHandler', {
  methods: [mth('handle', { line: 1 })],
});
const V5NoteEventPublisher = ty('V5NoteEventPublisher', 'V5NoteEventPublisher', {
  methods: [
    mth('publishNote', {
      line: 1,
      params: [{ name: 'msg', type: 'String' }],
      calls: [
        cl('dot', 'publish', {
          receiver: 'EventBus',
          argTexts: ['new Acme_Note__e(Message__c=msg)'],
          line: 2,
          lineText: 'EventBus.publish(new Acme_Note__e(Message__c=msg));',
        }),
      ],
    }),
    mth('publishNotes', {
      line: 3,
      params: [{ name: 'msgs', type: 'List<String>' }],
      locals: [{ name: 'events', type: 'List<Acme_Note__e>', line: 4 }],
      calls: [cl('dot', 'publish', { receiver: 'EventBus', argTexts: ['events'], line: 5, lineText: 'EventBus.publish(events);' })],
    }),
  ],
});
// Reused by an existing @InvocableMethod class the same way F1(b)'s test
// reuses V4InvocableUpdate/V4InvocableCreate -- the flow's actionCalls
// target, distinct from the flow's own object/triggerType metadata.
const V5NoteFlowAction = ty('V5NoteFlowAction', 'V5NoteFlowAction', {
  methods: [mth('execute', { line: 1, annotations: ['invocablemethod'] })],
});
const metaRefsV5 = [
  {
    kind: 'flow',
    label: 'V5NoteEventFlow',
    className: 'V5NoteFlowAction',
    methodName: 'execute',
    flowObject: 'Acme_Note__e',
    // Per metascan.js's real MetaRef contract (see its extractFlowStart doc
    // comment): a platform-event flow's <start> NEVER carries
    // <recordTriggerType> -- that element only appears on the three
    // RecordBefore*/RecordAfterSave shapes -- so flowRecordTriggerType stays
    // null and the PlatformEvent signal lives in the separate
    // flowTriggerType field instead. This fixture previously (incorrectly)
    // put the string 'PlatformEvent' in flowRecordTriggerType, which matched
    // a resolver.js buildMetaChildren bug (gating on flowRecordTriggerType
    // instead of flowTriggerType) rather than the real metascan.js shape --
    // fixed together so this fixture now exercises the actual G1(b) code
    // path a real workspace scan produces.
    flowRecordTriggerType: null,
    flowTriggerType: 'PlatformEvent',
    path: 'flows/V5NoteEventFlow.flow-meta.xml',
    line: 1,
    lineText: '<actionName>V5NoteFlowAction</actionName>',
  },
];

// ---- G2: exception throw/catch tracing -----------------------------------
const V5BaseException = ty('V5BaseException', 'V5BaseException', { extendsType: 'Exception', methods: [] });
const V5ValidationException = ty('V5ValidationException', 'V5ValidationException', {
  extendsType: 'V5BaseException',
  methods: [],
});
// Fallback-detection fixture: name ends in 'Exception', no extends clause at
// all -- exercises isExceptionTargetClass's "no other resolution" branch.
const V5GhostException = ty('V5GhostException', 'V5GhostException', { methods: [] });

const V5OrderValidator = ty('V5OrderValidator', 'V5OrderValidator', {
  methods: [
    mth('validate', {
      line: 3,
      params: [{ name: 'orderId', type: 'Id' }],
      throwsSites: [
        throwSite({ typeName: 'V5ValidationException', line: 9, lineText: "throw new V5ValidationException('Order Id is required.');" }),
      ],
    }),
  ],
});
const V5OrderService = ty('V5OrderService', 'V5OrderService', {
  methods: [
    mth('processOrders', {
      line: 1,
      calls: [cl('dot', 'validate', { receiver: 'V5OrderValidator', argTexts: ['orderId'], line: 2, lineText: 'V5OrderValidator.validate(orderId);' })],
    }),
  ],
});

// Catch scenario 1: exact-type catch.
const V5BatchProcessor = ty('V5BatchProcessor', 'V5BatchProcessor', {
  methods: [
    mth('execute', {
      line: 1,
      calls: [cl('dot', 'processOrders', { receiver: 'V5OrderService', line: 2, lineText: 'V5OrderService.processOrders();' })],
      catches: [catchFact('V5ValidationException', 've', 29)],
    }),
  ],
});
// Catch scenario 2: supertype catch (V5BaseException catches V5ValidationException).
const V5RestResource = ty('V5RestResource', 'V5RestResource', {
  methods: [
    mth('handlePost', {
      line: 1,
      annotations: ['httppost'],
      calls: [cl('dot', 'processOrders', { receiver: 'V5OrderService', line: 2, lineText: 'V5OrderService.processOrders();' })],
      catches: [catchFact('V5BaseException', 'be', 25)],
    }),
  ],
});
// Catch scenario 3: bare 'Exception' catch, one hop further removed (through
// an uncaught intermediate frame, handle(), on the way to the trigger).
const V5OrderTriggerHandler = ty('V5OrderTriggerHandler', 'V5OrderTriggerHandler', {
  methods: [
    mth('handle', {
      line: 1,
      calls: [cl('dot', 'processOrders', { receiver: 'V5OrderService', line: 2, lineText: 'V5OrderService.processOrders();' })],
    }),
  ],
});
const V5OrderTriggerType = ty('V5OrderTrigger', 'V5OrderTrigger', {
  methods: [
    mth('(trigger)', {
      line: 1,
      calls: [cl('dot', 'handle', { receiver: 'V5OrderTriggerHandler', line: 2, lineText: 'V5OrderTriggerHandler.handle(Trigger.new);' })],
      catches: [catchFact('Exception', 'ex', 17)],
    }),
  ],
});
const V5OrderTriggerFile = file(PT('V5OrderTrigger'), 'trigger', [V5OrderTriggerType], {
  triggerInfo: { object: 'V5_Order__c', events: ['after insert'] },
});
// Catch scenario 4 (negative): no catch anywhere -- reaches an @isTest entry
// with the exception still formally "in flight."
const V5OrderServiceTest = ty('V5OrderServiceTest', 'V5OrderServiceTest', {
  annotations: ['istest'],
  methods: [
    mth('testProcessOrders', {
      line: 1,
      calls: [cl('dot', 'processOrders', { receiver: 'V5OrderService', line: 2, lineText: 'V5OrderService.processOrders();' })],
    }),
  ],
});

// Rethrow form ('throw e;'), and a thrower with ZERO callers of its own --
// still a valid, terminal via='throws' leaf.
const V5ShipmentUtil = ty('V5ShipmentUtil', 'V5ShipmentUtil', {
  methods: [mth('computeEta', { line: 1, params: [{ name: 'shipmentId', type: 'Id' }] })],
});
const V5ShipmentService = ty('V5ShipmentService', 'V5ShipmentService', {
  methods: [
    mth('reprocessFailedShipment', {
      line: 1,
      params: [{ name: 'shipmentId', type: 'Id' }],
      calls: [cl('dot', 'computeEta', { receiver: 'V5ShipmentUtil', argTexts: ['shipmentId'], line: 2, lineText: 'V5ShipmentUtil.computeEta(shipmentId);' })],
      catches: [catchFact('V5ValidationException', 'e', 26)],
      throwsSites: [throwSite({ varName: 'e', line: 28, lineText: 'throw e;' })],
    }),
  ],
});

const V5GhostThrower = ty('V5GhostThrower', 'V5GhostThrower', {
  methods: [mth('doRiskyThing', { line: 1, throwsSites: [throwSite({ typeName: 'V5GhostException', line: 5 })] })],
});

// ---- G3: instanceof narrowing (labeled fallback only) --------------------
const V5ShapeBase = ty('V5ShapeBase', 'V5ShapeBase', { methods: [mth('describeShape', { line: 1 })] });
const V5ShapeConcrete = ty('V5ShapeConcrete', 'V5ShapeConcrete', {
  extendsType: 'V5ShapeBase',
  methods: [mth('crateLabel', { line: 1 })],
});
const V5ShapeNarrowingAuditor = ty('V5ShapeNarrowingAuditor', 'V5ShapeNarrowingAuditor', {
  methods: [
    mth('auditLabel', {
      // positive: crateLabel() is NOT declared on V5ShapeBase (shape's
      // declared type) -- declared-type resolution fails, narrowing fallback
      // is consulted and finds it on V5ShapeConcrete.
      line: 1,
      params: [{ name: 'shape', type: 'V5ShapeBase' }],
      narrowings: [narrowFact('shape', 'V5ShapeConcrete', 2)],
      calls: [cl('dot', 'crateLabel', { receiver: 'shape', line: 3, lineText: 'shape.crateLabel();' })],
    }),
    mth('auditDescribeShape', {
      // negative: describeShape() IS declared directly on V5ShapeBase --
      // declared-type resolution succeeds immediately, so the (textually
      // present) narrowing must NOT be consulted.
      line: 4,
      params: [{ name: 'shape', type: 'V5ShapeBase' }],
      narrowings: [narrowFact('shape', 'V5ShapeConcrete', 5)],
      calls: [cl('dot', 'describeShape', { receiver: 'shape', line: 6, lineText: 'shape.describeShape();' })],
    }),
  ],
});

// ---- G5: async-hop edges --------------------------------------------------
const V5QueueableWorker = ty('V5QueueableWorker', 'V5QueueableWorker', { methods: [mth('execute', { line: 1 })] });
const V5BatchWorker = ty('V5BatchWorker', 'V5BatchWorker', { methods: [mth('execute', { line: 1 })] });
const V5ScheduledWorker = ty('V5ScheduledWorker', 'V5ScheduledWorker', { methods: [mth('execute', { line: 1 })] });
const V5AsyncOrchestrator = ty('V5AsyncOrchestrator', 'V5AsyncOrchestrator', {
  methods: [
    mth('runMaintenance', {
      // all three schedulers, each with an inline `new` constructor argument.
      line: 1,
      calls: [
        cl('dot', 'enqueueJob', { receiver: 'System', argTexts: ['new V5QueueableWorker()'], line: 2, lineText: 'System.enqueueJob(new V5QueueableWorker());' }),
        cl('dot', 'executeBatch', { receiver: 'Database', argTexts: ['new V5BatchWorker()', '200'], line: 3, lineText: 'Database.executeBatch(new V5BatchWorker(), 200);' }),
        cl('dot', 'schedule', {
          receiver: 'System',
          argTexts: ["'Nightly'", 'cronExpr', 'new V5ScheduledWorker()'],
          line: 4,
          lineText: "System.schedule('Nightly', cronExpr, new V5ScheduledWorker());",
        }),
      ],
    }),
    mth('runMaintenanceVar', {
      // negative twin: a pre-declared local variable, not an inline `new` in
      // the enqueueJob call's own argText -- the existing 'new' ctor edge is
      // unaffected, but no additional async-hop edge should appear.
      line: 5,
      locals: [{ name: 'worker', type: 'V5QueueableWorker', line: 6 }],
      calls: [
        cl('new', 'V5QueueableWorker', { line: 6, lineText: 'V5QueueableWorker worker = new V5QueueableWorker();' }),
        cl('dot', 'enqueueJob', { receiver: 'System', argTexts: ['worker'], line: 7, lineText: 'System.enqueueJob(worker);' }),
      ],
    }),
  ],
});

// ---- G6: interface-extends-interface fan-out ------------------------------
const V5ParentIntf = ty('V5ParentIntf', 'V5ParentIntf', { isInterface: true, methods: [mth('ping', { line: 1 })] });
const V5ChildIntf = ty('V5ChildIntf', 'V5ChildIntf', { isInterface: true, extendsType: 'V5ParentIntf', methods: [] });
const V5DirectPingHandler = ty('V5DirectPingHandler', 'V5DirectPingHandler', {
  implementsTypes: ['V5ParentIntf'],
  methods: [mth('ping', { line: 1 })],
});
const V5ChildPingHandler = ty('V5ChildPingHandler', 'V5ChildPingHandler', {
  implementsTypes: ['V5ChildIntf'],
  methods: [mth('ping', { line: 1 })],
});
const V5IntfDispatcher = ty('V5IntfDispatcher', 'V5IntfDispatcher', {
  methods: [
    mth('dispatchPing', {
      line: 1,
      locals: [{ name: 'handler', type: 'V5ParentIntf', line: 1 }],
      calls: [
        cl('new', 'V5ChildPingHandler', { line: 1, lineText: 'V5ParentIntf handler = new V5ChildPingHandler();' }),
        cl('dot', 'ping', { receiver: 'handler', line: 2, lineText: 'handler.ping();' }),
      ],
    }),
  ],
});

// ---- G6 (diamond): multi-parent interface extends -- regression fixture
// for "every parent after the first in a multi-parent extends list is
// silently dropped". V5DiamondC extends BOTH V5DiamondA and V5DiamondB;
// V5DiamondImpl implements V5DiamondC only. A caller through a
// V5DiamondB-typed local (B is the SECOND extends-list entry) must still
// reach V5DiamondImpl -- pre-fix, only the first entry (A) survived parsing
// into extendsType, so the B-typed call site had zero implementers.
const V5DiamondA = ty('V5DiamondA', 'V5DiamondA', { isInterface: true, methods: [mth('ping', { line: 1 })] });
const V5DiamondB = ty('V5DiamondB', 'V5DiamondB', { isInterface: true, methods: [mth('pong', { line: 1 })] });
const V5DiamondC = ty('V5DiamondC', 'V5DiamondC', {
  isInterface: true,
  extendsTypes: ['V5DiamondA', 'V5DiamondB'],
  methods: [],
});
const V5DiamondImpl = ty('V5DiamondImpl', 'V5DiamondImpl', {
  implementsTypes: ['V5DiamondC'],
  methods: [mth('ping', { line: 1 }), mth('pong', { line: 2 })],
});
const V5DiamondADispatcher = ty('V5DiamondADispatcher', 'V5DiamondADispatcher', {
  methods: [
    mth('dispatchPing', {
      line: 1,
      locals: [{ name: 'h', type: 'V5DiamondA', line: 1 }],
      calls: [
        cl('new', 'V5DiamondImpl', { line: 1, lineText: 'V5DiamondA h = new V5DiamondImpl();' }),
        cl('dot', 'ping', { receiver: 'h', line: 2, lineText: 'h.ping();' }),
      ],
    }),
  ],
});
const V5DiamondBDispatcher = ty('V5DiamondBDispatcher', 'V5DiamondBDispatcher', {
  methods: [
    mth('dispatchPong', {
      line: 1,
      locals: [{ name: 'h', type: 'V5DiamondB', line: 1 }],
      calls: [
        cl('new', 'V5DiamondImpl', { line: 1, lineText: 'V5DiamondB h = new V5DiamondImpl();' }),
        cl('dot', 'pong', { receiver: 'h', line: 2, lineText: 'h.pong();' }),
      ],
    }),
  ],
});

const factsListV5 = [
  V5NoteEventTriggerFile,
  mkFile(V5NoteEventHandler),
  mkFile(V5NoteEventPublisher),
  mkFile(V5NoteFlowAction),
  mkFile(V5BaseException),
  mkFile(V5ValidationException),
  mkFile(V5GhostException),
  mkFile(V5OrderValidator),
  mkFile(V5OrderService),
  mkFile(V5BatchProcessor),
  mkFile(V5RestResource),
  mkFile(V5OrderTriggerHandler),
  V5OrderTriggerFile,
  mkFile(V5OrderServiceTest),
  mkFile(V5ShipmentUtil),
  mkFile(V5ShipmentService),
  mkFile(V5GhostThrower),
  mkFile(V5ShapeBase),
  mkFile(V5ShapeConcrete),
  mkFile(V5ShapeNarrowingAuditor),
  mkFile(V5QueueableWorker),
  mkFile(V5BatchWorker),
  mkFile(V5ScheduledWorker),
  mkFile(V5AsyncOrchestrator),
  mkFile(V5ParentIntf),
  mkFile(V5ChildIntf),
  mkFile(V5DirectPingHandler),
  mkFile(V5ChildPingHandler),
  mkFile(V5IntfDispatcher),
  mkFile(V5DiamondA),
  mkFile(V5DiamondB),
  mkFile(V5DiamondC),
  mkFile(V5DiamondImpl),
  mkFile(V5DiamondADispatcher),
  mkFile(V5DiamondBDispatcher),
];

const indexV5 = buildSemanticIndex(factsListV5);
attachMetaCallers(indexV5, metaRefsV5);

assert.ok(indexV5.throwers instanceof Map, 'buildSemanticIndex must expose throwers (G2 support)');
assert.ok(indexV5.publishSitesByObject instanceof Map, 'buildSemanticIndex must expose publishSitesByObject (G1(b) support)');

// =========================================================================
// G1(a): EventBus.publish -> platform-event trigger edges
// =========================================================================
{
  const tree = buildCallerTree(indexV5, { classLower: 'v5noteeventtrigger', methodLower: '(trigger)' });

  const noteChild = findChild(tree.root.children, 'V5NoteEventPublisher.publishNote');
  assert.ok(noteChild, 'EventBus.publish(new Acme_Note__e(...)) (single-record inline form) must trigger V5NoteEventTrigger');
  assert.strictEqual(noteChild.via, 'publish');
  assert.strictEqual(noteChild.approximate, false, "via='publish' must NOT be approximate -- the platform event genuinely does fire the trigger");

  const notesChild = findChild(tree.root.children, 'V5NoteEventPublisher.publishNotes');
  assert.ok(notesChild, 'EventBus.publish(events) with events:List<Acme_Note__e> (collection form) must ALSO trigger V5NoteEventTrigger');
  assert.strictEqual(notesChild.via, 'publish');
  assert.strictEqual(notesChild.approximate, false);

  // Ordinary wiring (resolves-today): the trigger CALLS the handler, so
  // tracing the HANDLER's own callers (not the trigger's) is what surfaces
  // it -- unaffected by G1, included here as a sanity check that the
  // publish special-case didn't disturb ordinary dispatch on the same file.
  const handlerTree = buildCallerTree(indexV5, { classLower: 'v5noteeventhandler', methodLower: 'handle' });
  const handlerCaller = findChild(handlerTree.root.children, 'V5NoteEventTrigger');
  assert.ok(handlerCaller, 'ordinary trigger -> handler wiring must resolve today via plain static dispatch, unaffected by G1');
  assert.strictEqual(handlerCaller.via, 'static');
}

// =========================================================================
// G1(b): platform-event-triggered flow -> publish children
// =========================================================================
{
  const tree = buildCallerTree(indexV5, { classLower: 'v5noteflowaction', methodLower: 'execute' });
  const flowNode = tree.root.children.find((n) => n.via === 'metadata' && n.kind === 'flow');
  assert.ok(flowNode, 'expected the platform-event-triggered flow node as a metadata caller of V5NoteFlowAction.execute');
  assert.strictEqual(flowNode.label, 'V5NoteEventFlow');
  const childLabels = labelsOf(flowNode.children);
  assert.ok(childLabels.includes('V5NoteEventPublisher.publishNote'), 'platform-event flow children must include the single-record publish site');
  assert.ok(childLabels.includes('V5NoteEventPublisher.publishNotes'), 'platform-event flow children must include the collection-form publish site');
  assert.strictEqual(flowNode.children[0].via, 'publish');
  assert.strictEqual(flowNode.children[0].approximate, false);
  assert.deepStrictEqual(flowNode.children[0].children, [], 'flow-publish children are themselves terminal');
}

// =========================================================================
// G2: exception throw/catch tracing
// =========================================================================

// ---- throw sites: creator-type form + rethrow form; thrower reachability --
{
  const tree = buildCallerTree(indexV5, { classLower: 'v5validationexception', methodLower: null });
  assert.strictEqual(tree.root.kind, 'class');

  const throwerNode = findChild(tree.root.children, 'V5OrderValidator.validate');
  assert.ok(throwerNode, "'throw new V5ValidationException(...)' must produce a via=throws root-level child");
  assert.strictEqual(throwerNode.via, 'throws');
  assert.strictEqual(throwerNode.approximate, false, "via='throws' must NOT be approximate -- the throw genuinely does throw");
  assert.strictEqual(throwerNode.sites[0].line, 9);

  const rethrowNode = findChild(tree.root.children, 'V5ShipmentService.reprocessFailedShipment');
  assert.ok(rethrowNode, "'throw e;' (rethrow form) must resolve e's type via the enclosing catch clause and produce a via=throws root-level child");
  assert.strictEqual(rethrowNode.via, 'throws');
  assert.strictEqual(rethrowNode.approximate, false);
  assert.strictEqual(rethrowNode.sites[0].line, 28);
  assert.deepStrictEqual(rethrowNode.children, [], 'a thrower node needs no callers of its own to be valid -- reprocessFailedShipment has none in this fixture');
  // reprocessFailedShipment's OWN catch clause (line 26, same method) is
  // what resolves 'throw e' to V5ValidationException in the first place --
  // it is the throw site's own frame (via='throws'), not an ancestor
  // intercepting propagation from below, so it must NOT self-badge even
  // though the catch clause syntactically matches the traced exception.
  // Per MANIFEST.md's v0.5 G2 tally: exactly 4 caughtHere classifications
  // exist in the real corpus (3 badges + 1 documented absence) and this
  // analogous thrower-with-matching-self-catch node is deliberately NOT a
  // 5th one.
  assert.strictEqual(rethrowNode.caughtHere, undefined, "a thrower's own enclosing catch clause must not badge the thrower node itself");

  // Ordinary caller-tree recursion continues above the thrower exactly as
  // it would for any other node: processOrders is validate's caller.
  const processOrdersNode = findChild(throwerNode.children, 'V5OrderService.processOrders');
  assert.ok(processOrdersNode, 'recursion above a thrower node is the ordinary caller tree');
  assert.strictEqual(processOrdersNode.via, 'static');
  assert.strictEqual(processOrdersNode.caughtHere, undefined, 'processOrders has no catch of its own -- must not carry the badge');

  // ---- all three catch-match kinds, plus the uncaught negative -----------
  const execNode = findChild(processOrdersNode.children, 'V5BatchProcessor.execute');
  assert.ok(execNode, 'exact-type catch scenario: V5BatchProcessor.execute must be reachable');
  assert.strictEqual(execNode.caughtHere, true, 'catch (V5ValidationException ve) is an EXACT type match -- caughtHere must be true');
  assert.ok(execNode.entries.includes('catches V5ValidationException'), "exact-type catch must carry the 'catches V5ValidationException' badge");

  const restNode = findChild(processOrdersNode.children, 'V5RestResource.handlePost');
  assert.ok(restNode, 'supertype catch scenario: V5RestResource.handlePost must be reachable');
  assert.strictEqual(restNode.caughtHere, true, 'catch (V5BaseException be) matches via the USER exception hierarchy (V5ValidationException extends V5BaseException) -- caughtHere must be true');
  assert.ok(restNode.entries.includes('catches V5ValidationException'), "supertype catch badge must name the TRACED exception, not the catch clause's own declared type");

  const handleNode = findChild(processOrdersNode.children, 'V5OrderTriggerHandler.handle');
  assert.ok(handleNode, 'the uncaught intermediate frame, handle(), must still be reachable');
  assert.strictEqual(handleNode.caughtHere, undefined, 'handle() has no catch of its own -- must not carry the badge');
  const trigNode = findChild(handleNode.children, 'V5OrderTrigger');
  assert.ok(trigNode, 'bare-Exception catch scenario: the trigger itself must be reachable one hop past the uncaught handle() frame');
  assert.strictEqual(trigNode.caughtHere, true, "catch (Exception ex) is a bare-Exception catch -- matches everything, caughtHere must be true");
  assert.ok(trigNode.entries.includes('catches V5ValidationException'), "bare-Exception catch badge must ALSO name the traced exception");

  const testNode = findChild(processOrdersNode.children, 'V5OrderServiceTest.testProcessOrders');
  assert.ok(testNode, 'the negative (no-catch-anywhere) scenario must still be reachable');
  assert.strictEqual(testNode.caughtHere, undefined, 'no catch anywhere in this branch -- absence of the badge is itself the ground truth, not an omission');
  assert.ok(!testNode.entries.some((e) => e.startsWith('catches ')), 'no catches-badge of any kind on the uncaught branch');
}

// ---- fallback exception-target detection: name ends in 'Exception', no
// extends clause at all ("no other resolution") ---------------------------
{
  const tree = buildCallerTree(indexV5, { classLower: 'v5ghostexception', methodLower: null });
  const ghostThrowerNode = findChild(tree.root.children, 'V5GhostThrower.doRiskyThing');
  assert.ok(ghostThrowerNode, "a class with no 'extends Exception' at all, but whose name ends in 'Exception', must still be treated as an exception target (fallback rule)");
  assert.strictEqual(ghostThrowerNode.via, 'throws');
}

// ---- negative: an ORDINARY (non-exception) class-level trace must NEVER
// pick up throwers or catch badges ------------------------------------------
{
  const tree = buildCallerTree(indexV5, { classLower: 'v5ordervalidator', methodLower: null });
  assert.ok(!tree.root.children.some((n) => n.via === 'throws'), 'an ordinary (non-exception) class target must not surface any via=throws children');
}

// =========================================================================
// G3: instanceof narrowing (labeled fallback only)
// =========================================================================
{
  // positive: declared-type (V5ShapeBase) resolution fails for crateLabel()
  // (not declared there) -- the narrowing fallback finds it on
  // V5ShapeConcrete, approximate:true (branch polarity not tracked).
  const treeConcrete = buildCallerTree(indexV5, { classLower: 'v5shapeconcrete', methodLower: 'cratelabel' });
  const narrowedCaller = findChild(treeConcrete.root.children, 'V5ShapeNarrowingAuditor.auditLabel');
  assert.ok(narrowedCaller, "shape.crateLabel() must resolve via the G3 narrowing fallback to V5ShapeConcrete.crateLabel");
  assert.strictEqual(narrowedCaller.via, 'narrowed');
  assert.strictEqual(narrowedCaller.approximate, true, "via='narrowed' must be approximate -- branch polarity is not tracked");

  // negative: declared-type (V5ShapeBase) resolution SUCCEEDS for
  // describeShape() (declared directly there) -- the narrowing (textually
  // present in the same method) must NOT be consulted, and no edge to
  // V5ShapeConcrete must appear for this call site.
  const treeBase = buildCallerTree(indexV5, { classLower: 'v5shapebase', methodLower: 'describeshape' });
  const typedCaller = findChild(treeBase.root.children, 'V5ShapeNarrowingAuditor.auditDescribeShape');
  assert.ok(typedCaller, 'shape.describeShape() must resolve via ordinary typed dispatch (declared-type resolution succeeds immediately)');
  assert.strictEqual(typedCaller.via, 'typed');
  assert.strictEqual(typedCaller.approximate, false);

  let sawNarrowedEdgeForDescribeShape = false;
  for (const sites of indexV5.methodCallers.values()) {
    for (const s of sites) {
      if (s.callerMethod === 'auditDescribeShape' && s.via === 'narrowed') sawNarrowedEdgeForDescribeShape = true;
    }
  }
  assert.strictEqual(sawNarrowedEdgeForDescribeShape, false, 'narrowing must NEVER be consulted once declared-type resolution has already succeeded');
}

// =========================================================================
// G4: anonymous Apex -- FileFacts.kind:'anonymous' must reach the TNode as
// kind:'anonymous' (not the default 'method'/'class' path), and the
// parser-supplied MethodFacts.entries label ('Anonymous Apex script') must
// be MERGED into computeAnnotationEntries' output, not overwritten by it.
// Self-contained (an anonymous script is a pure root -- nothing calls it),
// deliberately NOT sharing the big V5 corpus above.
// =========================================================================
{
  const anonType = ty('adhoc-recalc', 'adhoc-recalc', {
    methods: [
      mth('(anonymous)', {
        line: 1,
        entries: ['Anonymous Apex script'], // parser-supplied label (AMENDMENT G4) -- must survive resolver's pass A entries merge
        calls: [cl('dot', 'recalculatePricing', { receiver: 'AcmeOrderService', line: 5, lineText: 'AcmeOrderService.recalculatePricing(id);' })],
      }),
    ],
  });
  const anonFile = file('/ws/scripts/adhoc-recalc.apex', 'anonymous', [anonType]);
  const orderService = mkFile(
    ty('AcmeOrderService', 'AcmeOrderService', { methods: [mth('recalculatePricing', { line: 1 })] })
  );
  const indexAnon = buildSemanticIndex([anonFile, orderService]);
  const treeAnon = buildCallerTree(indexAnon, { classLower: 'adhoc-recalc', methodLower: '(anonymous)' });

  assert.strictEqual(treeAnon.root.kind, 'anonymous', "G4: an anonymous-script TNode's root.kind must be 'anonymous', not the default 'method'/'class' -- ICON_ANONYMOUS/pathmap accent are otherwise dead code");
  assert.deepStrictEqual(treeAnon.root.entries, ['Anonymous Apex script'], "G4: the parser-supplied entries label must survive resolver.js's pass A merge, not be discarded by computeAnnotationEntries");

  // its own calls resolve normally -- the anonymous-script special-casing
  // must not disturb ordinary outbound call resolution.
  const treeOrderService = buildCallerTree(indexAnon, { classLower: 'acmeorderservice', methodLower: 'recalculatepricing' });
  assert.ok(findChild(treeOrderService.root.children, 'adhoc-recalc.(anonymous)'), 'the anonymous script itself must appear as an ordinary caller of the class it calls into');
}

// =========================================================================
// G5: async-hop edges -- all three schedulers, plus the variable-arg negative
// =========================================================================
{
  const treeQueueable = buildCallerTree(indexV5, { classLower: 'v5queueableworker', methodLower: 'execute' });
  const queueableCaller = findChild(treeQueueable.root.children, 'V5AsyncOrchestrator.runMaintenance');
  assert.ok(queueableCaller, "System.enqueueJob(new V5QueueableWorker()) must add an async-hop edge to V5QueueableWorker.execute");
  assert.strictEqual(queueableCaller.via, 'async');
  assert.strictEqual(queueableCaller.approximate, false, "via='async' must NOT be approximate -- the enqueue genuinely does hand off to execute()");

  const treeBatch = buildCallerTree(indexV5, { classLower: 'v5batchworker', methodLower: 'execute' });
  const batchCaller = findChild(treeBatch.root.children, 'V5AsyncOrchestrator.runMaintenance');
  assert.ok(batchCaller, "Database.executeBatch(new V5BatchWorker(), 200) must add an async-hop edge to V5BatchWorker.execute");
  assert.strictEqual(batchCaller.via, 'async');
  assert.strictEqual(batchCaller.approximate, false);

  const treeScheduled = buildCallerTree(indexV5, { classLower: 'v5scheduledworker', methodLower: 'execute' });
  const scheduledCaller = findChild(treeScheduled.root.children, 'V5AsyncOrchestrator.runMaintenance');
  assert.ok(scheduledCaller, "System.schedule('Nightly', cronExpr, new V5ScheduledWorker()) must add an async-hop edge to V5ScheduledWorker.execute");
  assert.strictEqual(scheduledCaller.via, 'async');
  assert.strictEqual(scheduledCaller.approximate, false);

  // negative: runMaintenanceVar's enqueueJob(worker) argText is a plain
  // variable, not an inline `new` -- no async-hop edge to execute(), even
  // though the separate 'new' ctor statement on the prior line still stands.
  assert.ok(!findChild(treeQueueable.root.children, 'V5AsyncOrchestrator.runMaintenanceVar'), 'a pre-declared local variable arg (not an inline new) must produce NO async-hop edge to execute()');
  const treeQueueableCtor = buildCallerTree(indexV5, { classLower: 'v5queueableworker', methodLower: '<init>' });
  assert.ok(findChild(treeQueueableCtor.root.children, 'V5AsyncOrchestrator.runMaintenanceVar'), "the separate 'new V5QueueableWorker()' statement itself must still produce its OWN ordinary via='new' ctor edge, unaffected by the async-hop rule");
}

// =========================================================================
// G6: interface-extends-interface fan-out
// =========================================================================
{
  // control case: direct implementer, already resolves today via v0.3's
  // plain direct-implementsTypes fan-out.
  const treeDirect = buildCallerTree(indexV5, { classLower: 'v5directpinghandler', methodLower: 'ping' });
  const directCaller = findChild(treeDirect.root.children, 'V5IntfDispatcher.dispatchPing');
  assert.ok(directCaller, 'V5DirectPingHandler implements V5ParentIntf directly -- must be reachable from the V5ParentIntf-typed caller');
  assert.strictEqual(directCaller.via, 'interface');
  assert.strictEqual(directCaller.approximate, true);

  // the G6 fix itself: V5ChildPingHandler implements V5ChildIntf, which
  // extends V5ParentIntf -- reachable ONLY through the interface-extends
  // transitive closure.
  const treeChild = buildCallerTree(indexV5, { classLower: 'v5childpinghandler', methodLower: 'ping' });
  const childCaller = findChild(treeChild.root.children, 'V5IntfDispatcher.dispatchPing');
  assert.ok(childCaller, 'V5ChildPingHandler implements V5ChildIntf (extends V5ParentIntf) -- must be reachable from the V5ParentIntf-typed caller via the transitive interface-extends closure (G6)');
  assert.strictEqual(childCaller.via, 'interface');
  assert.strictEqual(childCaller.approximate, true);
}

// =========================================================================
// G6 (diamond): multi-parent interface extends -- every parent after the
// first must fan out, not just extendsType's single-string first entry.
// =========================================================================
{
  // control: FIRST extends-list entry (V5DiamondA) already worked even with
  // the pre-fix single-parent extendsType, so this must keep passing.
  const treeA = buildCallerTree(indexV5, { classLower: 'v5diamondimpl', methodLower: 'ping' });
  const aCaller = findChild(treeA.root.children, 'V5DiamondADispatcher.dispatchPing');
  assert.ok(aCaller, 'V5DiamondImpl implements V5DiamondC (extends V5DiamondA, V5DiamondB) -- must be reachable from the V5DiamondA-typed caller (1st extends entry)');
  assert.strictEqual(aCaller.via, 'interface');
  assert.strictEqual(aCaller.approximate, true);

  // the diamond fix itself: SECOND extends-list entry (V5DiamondB) was
  // silently dropped by parser.js's extendsType (first-entry-only) pre-fix,
  // so V5DiamondImpl had zero registered implementers under V5DiamondB and
  // this call site resolved to an empty children array.
  const treeB = buildCallerTree(indexV5, { classLower: 'v5diamondimpl', methodLower: 'pong' });
  const bCaller = findChild(treeB.root.children, 'V5DiamondBDispatcher.dispatchPong');
  assert.ok(bCaller, 'V5DiamondImpl implements V5DiamondC (extends V5DiamondA, V5DiamondB) -- must ALSO be reachable from the V5DiamondB-typed caller (2nd extends entry, previously dropped)');
  assert.strictEqual(bCaller.via, 'interface');
  assert.strictEqual(bCaller.approximate, true);
}

// =========================================================================
// H2: interface x override composition -- interface dispatch fans to direct
// implementers and walks UP an implementer's own extends chain (BUG FIX
// finding #2, already covered above), but pre-fix never fanned DOWN to an
// override declared in a SUBCLASS of an implementer. Repro (mirrors the
// GOAL text exactly): `interface I{void m();}` / `virtual class Impl
// implements I { virtual void m(){} }` / `class SubImpl extends Impl {
// override void m(){} }` (deliberately does NOT redeclare `implements I`
// itself) / `class Disp { void fan(I i){ i.m(); } }` -- pre-fix, tracing
// SubImpl.m returned ZERO callers even though Disp.fan calls exactly this
// override through the interface-typed parameter.
// =========================================================================
const H2Iface = ty('H2Iface', 'H2Iface', {
  isInterface: true,
  methods: [mth('m', { line: 1 })],
});
const H2Impl = ty('H2Impl', 'H2Impl', {
  implementsTypes: ['H2Iface'],
  methods: [mth('m', { line: 2 })], // virtual void m(){}
});
const H2SubImpl = ty('H2SubImpl', 'H2SubImpl', {
  extendsType: 'H2Impl',
  // deliberately does NOT redeclare `implements H2Iface` -- this is the
  // exact H2 repro shape (an override reachable ONLY via the fan-down fix).
  methods: [mth('m', { line: 3 })], // override void m(){}
});
const H2Disp = ty('H2Disp', 'H2Disp', {
  methods: [
    mth('fan', {
      line: 1,
      params: [{ name: 'i', type: 'H2Iface' }],
      calls: [cl('dot', 'm', { receiver: 'i', line: 2, lineText: 'i.m();' })],
    }),
  ],
});
// H2 dedup guard: a class that redeclares `implements H2Iface` on ITSELF
// (not merely inheriting it) and ALSO overrides m() must get exactly ONE
// edge, not two -- it already receives its own direct edge from the
// implementers-loop's own iteration; the NEW fan-down (triggered while
// processing H2Impl's iteration of that same loop) must skip it rather than
// double-writing the same call site.
const H2SubImplRedeclare = ty('H2SubImplRedeclare', 'H2SubImplRedeclare', {
  extendsType: 'H2Impl',
  implementsTypes: ['H2Iface'], // redeclares implements on the subclass
  methods: [mth('m', { line: 4 })], // AND overrides m() itself
});

const factsListH2 = [mkFile(H2Iface), mkFile(H2Impl), mkFile(H2SubImpl), mkFile(H2Disp), mkFile(H2SubImplRedeclare)];
const indexH2 = buildSemanticIndex(factsListH2);

{
  // control: the direct implementer's own method -- unaffected by the H2
  // fix, must keep resolving exactly as before.
  const treeImpl = buildCallerTree(indexH2, { classLower: 'h2impl', methodLower: 'm' });
  const implCaller = findChild(treeImpl.root.children, 'H2Disp.fan');
  assert.ok(implCaller, 'H2Impl.m (the direct implementer) must be reachable from the interface-typed dispatch');
  assert.strictEqual(implCaller.via, 'interface');
  assert.strictEqual(implCaller.approximate, true);

  // the H2 fix itself.
  const treeSubImpl = buildCallerTree(indexH2, { classLower: 'h2subimpl', methodLower: 'm' });
  const subImplCaller = findChild(treeSubImpl.root.children, 'H2Disp.fan');
  assert.ok(
    subImplCaller,
    'H2: H2SubImpl.m (an override declared in a SUBCLASS of the direct implementer, never redeclaring `implements` itself) must be reachable from the interface-typed dispatch -- the confirmed missing-edge bug'
  );
  assert.strictEqual(subImplCaller.via, 'interface', "H2: the fan-down edge must be labeled via='interface' (the dispatch is still through the interface-typed parameter), not 'override'");
  assert.strictEqual(subImplCaller.approximate, true);

  // dedup guard: exactly one edge each, never two, for the redeclaring
  // subclass -- the fan-down must skip descendants that are themselves
  // already independently registered implementers.
  assert.strictEqual((indexH2.methodCallers.get('h2impl#m') || []).length, 1, 'H2: H2Impl must receive exactly one edge from this call site');
  assert.strictEqual(
    (indexH2.methodCallers.get('h2subimplredeclare#m') || []).length,
    1,
    'H2: a subclass that BOTH redeclares `implements` AND overrides m() must receive exactly one edge (its own direct one), not a second duplicate from the fan-down'
  );
}

// =========================================================================
// H4 (resolver half): index.stats.unresolvedSites counts call sites this
// build positively identified as dropped (unknown receiver, chain >
// CHAIN_MAX segments [v0.10/A1: 12, was 4], non-literal Type.forName);
// every TreeResult carries the same workspace-wide count through unchanged
// (stats passthrough); a resolved target with genuinely zero callers gets
// an honest info note.
// =========================================================================
const H4Known = ty('H4Known', 'H4Known', {
  methods: [mth('helper', { line: 1 }), mth('orphanMethod', { line: 2 })],
});
const H4Caller = ty('H4Caller', 'H4Caller', {
  methods: [
    mth('run', {
      line: 1,
      params: [{ name: 'dynamicName', type: 'String' }],
      calls: [
        // (1) unknown receiver: 'ghostReceiver' names nothing in scope, and
        // 'frobnicate' isn't a known method name anywhere in the index.
        cl('dot', 'frobnicate', { receiver: 'ghostReceiver', line: 1, lineText: 'ghostReceiver.frobnicate();' }),
        // (2) v0.10/A1: chain > CHAIN_MAX(12) segments -- was a 5-segment
        // chain pre-v0.10 (over the OLD 4-segment cap); widened to 13
        // segments here so this site still genuinely exercises the
        // cap-exceeded path (the cap check runs BEFORE any head/type
        // resolution, so segment COUNT alone -- not whether 'x' itself is a
        // known local -- is what must trip it here).
        cl('dot', 'finalCall', {
          receiver: 'x.hop1().hop2().hop3().hop4().hop5().hop6().hop7().hop8().hop9().hop10().hop11().hop12().hop13()',
          line: 2,
          lineText: 'x.hop1()...hop13().finalCall(); // 13 segments, one past CHAIN_MAX',
        }),
        // (3) Type.forName(...) with a non-literal (variable) argument.
        cl('dot', 'forName', { receiver: 'Type', argTexts: ['dynamicName'], line: 3, lineText: 'Type.forName(dynamicName);' }),
        // negative controls -- neither of these is a "dropped" site and
        // neither may inflate the counter.
        cl('dot', 'helper', { receiver: 'H4Known', line: 4, lineText: 'H4Known.helper();' }), // ordinary resolved call
        cl('dot', 'debug', { receiver: 'System', argTexts: ['1'], line: 5, lineText: 'System.debug(1);' }), // deliberate platform exclusion
      ],
    }),
  ],
});
const indexH4 = buildSemanticIndex([mkFile(H4Known), mkFile(H4Caller)]);

{
  assert.strictEqual(
    indexH4.stats.unresolvedSites,
    3,
    'index.stats.unresolvedSites must count exactly the 3 genuinely-dropped call sites (unknown receiver, chain>4, non-literal Type.forName) -- the ordinary resolved call and the deliberately-denylisted platform call must NOT inflate it'
  );

  // stats passthrough: every TreeResult, regardless of which target is
  // being traced, carries the SAME workspace-wide unresolvedSites count.
  const treeWithCallers = buildCallerTree(indexH4, { classLower: 'h4known', methodLower: 'helper' });
  assert.strictEqual(treeWithCallers.stats.unresolvedSites, 3, 'H4: TreeResult.stats.unresolvedSites must pass the same workspace-wide count through, even for a target that itself has callers');
  assert.strictEqual(treeWithCallers.note, null, 'a target with at least one caller must not get the zero-caller note');

  // H4 zero-caller note: a resolved target with genuinely zero callers.
  const treeOrphan = buildCallerTree(indexH4, { classLower: 'h4known', methodLower: 'orphanmethod' });
  assert.strictEqual(treeOrphan.root.children.length, 0);
  assert.strictEqual(
    treeOrphan.note,
    'No callers found — this is likely an entry point or unused code.',
    'H4: a resolved target with zero callers must get the exact honest info note, not a silently empty tree'
  );
  assert.strictEqual(treeOrphan.stats.unresolvedSites, 3, 'the zero-caller note and the unresolvedSites passthrough are independent -- both must be correct on the same TreeResult');

  // negative: the pre-existing "target class not found" case keeps its own
  // distinct note text (unaffected by the H4 zero-caller note).
  const treeMissing = buildCallerTree(indexH4, { classLower: 'nosuchclassatall', methodLower: null });
  assert.strictEqual(treeMissing.note, 'target class not found in index');
}

// =========================================================================
// H1: buildCallerTree DAG memoization + node cap + stats
// =========================================================================

// ---- seenElsewhere dedup semantics: sites kept, subtree deduped, cyclic
// still wins over seenElsewhere on an ancestor-path hit -----------------
//
// Call graph (who calls whom): Q calls P, R calls P (P is the trace
// target's two direct callers); S calls Q AND S calls R (S is a caller of
// BOTH); Q also calls S (closing a Q<->S 2-cycle one level down).
//
//   P <- Q <- S <- Q (cyclic: Q is its own ancestor on this branch)
//   P <- R <- S (seenElsewhere: S's subtree was already expanded via the Q
//                branch, since Q is processed first)
const H1P = ty('H1P', 'H1P', { methods: [mth('m', { line: 1 })] });
const H1Q = ty('H1Q', 'H1Q', {
  methods: [
    mth('m', {
      line: 1,
      calls: [
        cl('dot', 'm', { receiver: 'H1P', line: 1, lineText: 'H1P.m();' }),
        cl('dot', 'm', { receiver: 'H1S', line: 2, lineText: 'H1S.m();' }),
      ],
    }),
  ],
});
const H1R = ty('H1R', 'H1R', {
  methods: [mth('m', { line: 1, calls: [cl('dot', 'm', { receiver: 'H1P', line: 1, lineText: 'H1P.m();' })] })],
});
const H1S = ty('H1S', 'H1S', {
  methods: [
    mth('m', {
      line: 1,
      calls: [
        cl('dot', 'm', { receiver: 'H1Q', line: 1, lineText: 'H1Q.m();' }),
        cl('dot', 'm', { receiver: 'H1R', line: 2, lineText: 'H1R.m();' }),
      ],
    }),
  ],
});
const indexH1 = buildSemanticIndex([mkFile(H1P), mkFile(H1Q), mkFile(H1R), mkFile(H1S)]);

{
  const tree = buildCallerTree(indexH1, { classLower: 'h1p', methodLower: 'm' });
  const qNode = findChild(tree.root.children, 'H1Q.m');
  const rNode = findChild(tree.root.children, 'H1R.m');
  assert.ok(qNode && rNode, 'expected both H1Q.m and H1R.m as direct callers of H1P.m');
  assert.strictEqual(qNode.seenElsewhere, false, 'H1Q.m (first occurrence) must expand normally, not seenElsewhere');
  assert.strictEqual(qNode.cyclic, false);

  const sUnderQ = findChild(qNode.children, 'H1S.m');
  assert.ok(sUnderQ, "H1S.m must appear as H1Q.m's caller (H1S calls H1Q)");
  assert.strictEqual(sUnderQ.seenElsewhere, false, "H1S.m's FIRST occurrence (under H1Q) must expand normally");
  assert.strictEqual(sUnderQ.children.length, 1, "H1S.m's own subtree (its caller H1Q.m, cyclic) must still be built on its first, expanding occurrence");

  const qUnderS = findChild(sUnderQ.children, 'H1Q.m');
  assert.ok(qUnderS, 'H1Q.m must reappear one level under H1S.m (H1Q calls H1S)');
  assert.strictEqual(qUnderS.cyclic, true, 'H1: cyclic flag must still win -- H1Q is its own ancestor on this branch (H1P->H1Q->H1S->H1Q)');
  assert.strictEqual(qUnderS.seenElsewhere, false, 'a cyclic node must never ALSO be flagged seenElsewhere -- cyclic wins outright');
  assert.strictEqual(qUnderS.children.length, 0, 'a cyclic node must not recurse further');

  const sUnderR = findChild(rNode.children, 'H1S.m');
  assert.ok(sUnderR, "H1S.m must ALSO appear as H1R.m's caller (H1S calls H1R too)");
  assert.strictEqual(sUnderR.seenElsewhere, true, "H1: H1S.m's SECOND occurrence (under H1R, not on H1R's own ancestor path) must be a seenElsewhere reference node -- its subtree was already expanded once, under H1Q");
  assert.strictEqual(sUnderR.cyclic, false, 'seenElsewhere is not cyclic -- H1S is not H1R\'s own ancestor');
  assert.deepStrictEqual(sUnderR.children, [], 'H1: a seenElsewhere node\'s children must be forced empty (the subtree is not re-walked)');
  assert.strictEqual(sUnderR.sites.length, 1, "H1: a seenElsewhere node's OWN sites (who calls it along THIS path) must still be kept, only its subtree is deduped");
  assert.strictEqual(sUnderR.label, 'H1S.m', 'H1: a seenElsewhere node\'s label is unchanged -- only children/seenElsewhere differ from an ordinary node');

  // stats: uniqueMethods counts each distinct classLower#methodLower
  // identity once among the CHILD nodes (H1Q, H1R, H1S = 3 -- the root
  // itself is tracked separately and isn't counted here), regardless of how
  // many times an identity appears as a node (H1S appears twice: once
  // expanded, once seenElsewhere).
  assert.strictEqual(tree.stats.uniqueMethods, 3);
  assert.strictEqual(tree.stats.nodes, 6, 'H1: node COUNT (as opposed to uniqueMethods) counts every occurrence: root + Q + R + S(under Q) + Q(cyclic, under S) + S(seenElsewhere, under R) = 6');
  assert.strictEqual(tree.stats.capped, false);
}

// ---- maxNodes capped flag: a hard cap that is visible on TreeResult.stats,
// not a silent drop ---------------------------------------------------------
{
  // A genuinely non-repeating fan-in chain (every identity distinct, no
  // dedup possible) so the cap is what actually stops expansion, not the
  // DAG memoization above.
  const capFacts = [];
  const names = [];
  for (let i = 0; i < 30; i++) names.push(`H1Cap${i}`);
  for (let i = 0; i < names.length; i++) {
    const calls = i > 0 ? [cl('dot', 'm', { receiver: names[i - 1], line: 1, lineText: `${names[i - 1]}.m();` })] : [];
    capFacts.push(mkFile(ty(names[i], names[i], { methods: [mth('m', { line: 1, calls })] })));
  }
  const indexCap = buildSemanticIndex(capFacts);
  const treeCapped = buildCallerTree(indexCap, { classLower: names[0].toLowerCase(), methodLower: 'm' }, { maxDepth: 100, maxNodes: 10 });
  assert.strictEqual(treeCapped.stats.capped, true, 'H1: exceeding maxNodes must set stats.capped = true');
  assert.strictEqual(treeCapped.stats.nodes, 10, 'H1: node creation must stop AT maxNodes, not silently continue past it');

  const treeUncapped = buildCallerTree(indexCap, { classLower: names[0].toLowerCase(), methodLower: 'm' }, { maxDepth: 100, maxNodes: 2000 });
  assert.strictEqual(treeUncapped.stats.capped, false, 'a trace that never reaches maxNodes must report capped: false');
  assert.strictEqual(treeUncapped.stats.nodes, names.length, 'the uncapped trace must show every one of the 30 distinct callers');
}

// ---- W-fan-in generator probe: DAG memoization must keep buildCallerTree
// far under the H1 perf bar's node-count ceiling on the exact adversarial
// shape the GOAL's measured baseline (6.7M nodes pre-fix) was built from --
// classes L0..L11, W=7 classes per layer, every layer-N method called by
// ALL W layer-(N+1) methods; trace a layer-0 method. This is a functional
// assertion (node count), not the full timing/heap perf-bar check (run
// separately, outside the self-check suite, since timing is environment-
// sensitive) -- but node count alone is enough to prove the memoization is
// actually deduping subtrees rather than fully re-materializing them.
{
  const W = 7;
  const LAYERS = 12; // L0..L11
  const layerNames = [];
  for (let layer = 0; layer < LAYERS; layer++) {
    const names = [];
    const width = layer === 0 ? 1 : W; // layer 0 is the single trace target
    for (let w = 0; w < width; w++) names.push(`WFan${layer}_${w}`);
    layerNames.push(names);
  }
  const wFanFacts = [];
  for (let layer = 0; layer < LAYERS; layer++) {
    for (const name of layerNames[layer]) {
      const calls = layer > 0 ? layerNames[layer - 1].map((tgt) => cl('dot', 'm', { receiver: tgt, line: 1, lineText: `${tgt}.m();` })) : [];
      wFanFacts.push(mkFile(ty(name, name, { methods: [mth('m', { line: 1, calls })] })));
    }
  }
  const indexWFan = buildSemanticIndex(wFanFacts);
  const treeWFan = buildCallerTree(indexWFan, { classLower: layerNames[0][0].toLowerCase(), methodLower: 'm' });
  assert.ok(treeWFan.stats.nodes < 5000, `H1 perf probe (functional): W=7/depth-12 fan-in must produce well under 5000 nodes via DAG memoization, got ${treeWFan.stats.nodes}`);
  assert.strictEqual(treeWFan.stats.capped, false, 'the W=7/depth-12 probe must not need the maxNodes cap at all -- memoization alone keeps it small');
}

// =========================================================================
// v0.7 A1/A2: forward tracing (buildCalleeTree) -- "what does this call?"
// =========================================================================
// Every fixture below is NEW (a "W7" prefix keeps it out of every earlier
// section's namespace); nothing above this line is touched, per the task's
// "keep every existing assert unchanged" instruction.

// ---- W7 fixture workspace: one caller method exercising every A1 forward
// edge kind in a single body (call/dml/publish/async/throw/unresolved) -----

const W7Target = ty('W7Target', 'W7Target', {
  methods: [mth('doStatic', { line: 1, isStatic: true })],
});

const W7Job = ty('W7Job', 'W7Job', {
  methods: [mth('execute', { line: 1 })],
});

// Per isExceptionTargetClass's fallback rule (no extends chain, name ends
// 'Exception'), this is recognized as an exception target with no need for
// a hand-built extends-'Exception' chain.
const W7BoomException = ty('W7BoomException', 'W7BoomException', { methods: [] });

const W7Notifiable = ty('W7Notifiable', 'W7Notifiable', {
  isInterface: true,
  methods: [mth('notify', { line: 1, params: [{ name: 'msg', type: 'String' }] })],
});
const W7EmailNotifier = ty('W7EmailNotifier', 'W7EmailNotifier', {
  implementsTypes: ['W7Notifiable'],
  methods: [mth('notify', { line: 5, params: [{ name: 'msg', type: 'String' }] })],
});
const W7SmsNotifier = ty('W7SmsNotifier', 'W7SmsNotifier', {
  implementsTypes: ['W7Notifiable'],
  methods: [mth('notify', { line: 5, params: [{ name: 'msg', type: 'String' }] })],
});

const W7AccountTriggerType = ty('W7AccountTrigger', 'W7AccountTrigger', {
  methods: [mth('(trigger)', { line: 1 })],
});
const W7AccountTriggerFile = file(PT('W7AccountTrigger'), 'trigger', [W7AccountTriggerType], {
  triggerInfo: { object: 'W7_Account__c', events: ['before insert', 'after insert'] },
});

const W7NoteTriggerType = ty('W7NoteTrigger', 'W7NoteTrigger', {
  methods: [mth('(trigger)', { line: 1 })],
});
const W7NoteTriggerFile = file(PT('W7NoteTrigger'), 'trigger', [W7NoteTriggerType], {
  triggerInfo: { object: 'W7_Note__e', events: ['after insert'] },
});

const W7Caller = ty('W7Caller', 'W7Caller', {
  methods: [
    mth('entry', {
      line: 1,
      locals: [
        { name: 'acct', type: 'W7_Account__c', line: 1 },
        { name: 'notifier', type: 'W7Notifiable', line: 1 },
      ],
      calls: [
        cl('dot', 'doStatic', { receiver: 'W7Target', line: 2, lineText: 'W7Target.doStatic();' }),
        cl('new', 'W7Target', { line: 3, lineText: 'new W7Target();' }),
        cl('dot', 'publish', { receiver: 'EventBus', argTexts: ['new W7_Note__e()'], line: 4, lineText: 'EventBus.publish(new W7_Note__e());' }),
        cl('dot', 'enqueueJob', { receiver: 'System', argTexts: ['new W7Job()'], line: 5, lineText: 'System.enqueueJob(new W7Job());' }),
        // G5's own dual-fact shape: the SAME line's inline `new W7Job()`
        // argument is ALSO parsed as its own ordinary rule-1 CallFacts --
        // A1/A3's forward-collapse rule (isNewSuppressedFromForward) must
        // suppress this half so async-hop-forward shows exactly ONE child
        // (via=async), not two.
        cl('new', 'W7Job', { line: 5, lineText: 'System.enqueueJob(new W7Job());' }),
        cl('dot', 'notify', { receiver: 'notifier', argTexts: ['"hi"'], line: 6, lineText: 'notifier.notify("hi");' }),
        cl('dot', 'zzzW7Unresolved', { receiver: 'mystery', line: 7, lineText: 'mystery.zzzW7Unresolved();' }),
      ],
      dml: [dmlFact('insert', 'acct', { line: 8, lineText: 'insert acct;' })],
      throwsSites: [throwSite({ typeName: 'W7BoomException', line: 9, lineText: "throw new W7BoomException('boom');" })],
    }),
  ],
});
// G2's own dual-fact shape for the throw statement: same collapse rule.
W7Caller.methods[0].calls.push(cl('new', 'W7BoomException', { line: 9, lineText: "throw new W7BoomException('boom');" }));

const factsListW7 = [
  W7AccountTriggerFile,
  W7NoteTriggerFile,
  mkFile(W7Target),
  mkFile(W7Job),
  mkFile(W7BoomException),
  mkFile(W7Notifiable),
  mkFile(W7EmailNotifier),
  mkFile(W7SmsNotifier),
  mkFile(W7Caller),
];
const indexW7 = buildSemanticIndex(factsListW7);
const metaRefsW7 = [
  {
    kind: 'flow',
    label: 'W7AccountFlow',
    className: 'W7Target', // arbitrary -- forward DML->flow linkage never consults className/methodName, only flowObject (see resolver.js's own attachMetaCallers comment)
    methodName: null,
    flowObject: 'W7_Account__c',
    flowRecordTriggerType: 'Create',
    flowTriggerType: 'RecordAfterSave',
    path: 'flows/W7AccountFlow.flow-meta.xml',
    line: 1,
    lineText: '<object>W7_Account__c</object>',
  },
  {
    kind: 'flow',
    label: 'W7NoteFlow',
    className: 'W7Target',
    methodName: null,
    flowObject: 'W7_Note__e',
    flowRecordTriggerType: null,
    flowTriggerType: 'PlatformEvent',
    path: 'flows/W7NoteFlow.flow-meta.xml',
    line: 1,
    lineText: '<object>W7_Note__e</object>',
  },
];
attachMetaCallers(indexW7, metaRefsW7);

// ---- A1/A2: forward semantics per edge kind --------------------------------
{
  const tree = buildCalleeTree(indexW7, { classLower: 'w7caller', methodLower: 'entry' });
  assert.strictEqual(tree.direction, 'callees', 'buildCalleeTree TreeResult.direction must be "callees"');
  const kids = tree.root.children;

  const staticChild = findChild(kids, 'W7Target.doStatic');
  assert.ok(staticChild, 'call/static: forward child for the static dispatch must exist');
  assert.strictEqual(staticChild.via, 'static');
  assert.strictEqual(staticChild.kind, 'method');
  assert.strictEqual(staticChild.approximate, false);

  const ctorChild = findChild(kids, 'W7Target.<init>');
  assert.ok(ctorChild, "call/new: forward child for 'new W7Target()' must exist");
  assert.strictEqual(ctorChild.via, 'new');

  const trig = findChild(kids, 'W7AccountTrigger');
  assert.ok(trig, 'dml->trigger: the insert DML site must forward to the matching trigger');
  assert.strictEqual(trig.via, 'dml');
  assert.strictEqual(trig.kind, 'trigger');
  assert.strictEqual(trig.approximate, false, "via='dml' must not be approximate -- the trigger genuinely fires");

  const flow = findChild(kids, 'W7AccountFlow');
  assert.ok(flow, 'dml->flow: the SAME insert DML site must ALSO forward to the matching record-triggered flow');
  assert.strictEqual(flow.via, 'dml');
  assert.strictEqual(flow.kind, 'flow');
  assert.strictEqual(flow.truncated, true, 'A2: a record-triggered flow node is TERMINAL in the forward direction');
  assert.deepStrictEqual(flow.children, [], 'a terminal flow node must have no children');

  const pubTrig = findChild(kids, 'W7NoteTrigger');
  assert.ok(pubTrig, 'publish->trigger: EventBus.publish on a __e object must forward to its trigger');
  assert.strictEqual(pubTrig.via, 'publish');
  assert.strictEqual(pubTrig.kind, 'trigger');

  const pubFlow = findChild(kids, 'W7NoteFlow');
  assert.ok(pubFlow, 'publish->flow: the SAME publish site must ALSO forward to the matching platform-event flow');
  assert.strictEqual(pubFlow.via, 'publish');
  assert.strictEqual(pubFlow.kind, 'flow');
  assert.strictEqual(pubFlow.truncated, true, 'A4: a platform-event flow node is TERMINAL in the forward direction');

  const asyncChild = findChild(kids, 'W7Job.execute');
  assert.ok(asyncChild, 'async: System.enqueueJob(new W7Job()) must forward to the job\'s execute() method');
  assert.strictEqual(asyncChild.via, 'async');
  assert.ok(!findChild(kids, 'W7Job.<init>'), 'G5 forward-collapse: the inline `new W7Job()` argument must NOT ALSO appear as a separate <init> child');

  const excChild = findChild(kids, 'W7BoomException');
  assert.ok(excChild, 'throw: the throw statement must forward to the exception class');
  assert.strictEqual(excChild.via, 'throws');
  assert.strictEqual(excChild.kind, 'exception');
  assert.strictEqual(excChild.truncated, true, 'A3: an exception-class node is TERMINAL in the forward direction');
  assert.strictEqual(excChild.approximate, false, "via='throws' must not be approximate -- not in APPROX_VIA, matches MANIFEST A3 (the exception-class node line carries no 'approximate' tag, unlike the interface/unresolved lines beside it)");
  assert.deepStrictEqual(excChild.children, [], 'a terminal exception node must have no children');
  assert.ok(!findChild(kids, 'W7BoomException.<init>'), 'G2 forward-collapse: the throw statement\'s own `new W7BoomException(...)` must NOT ALSO appear as a separate <init> child');

  const ifaceChild = findChild(kids, 'W7Notifiable.notify');
  assert.ok(ifaceChild, 'interface: a call through an interface-typed receiver forwards to the INTERFACE method itself, kept as one sibling (not a wrapper) -- v0.7.1/R7');
  assert.strictEqual(ifaceChild.via, 'interface');
  assert.strictEqual(ifaceChild.approximate, true);
  // v0.7.1/R7 (was A5 pre-fix, now UPDATED -- VALIDATION-REPORT.md fix
  // backlog #9 / Callee-direction interface dispatch tree shape): the
  // resolved implementer(s) must appear as DIRECT children of the calling
  // method's call site, not buried two levels down under the interface
  // node as a synthetic non-call-site wrapper. The interface node above is
  // kept alongside as one additional sibling, not removed.
  const emailImplDirect = findChild(kids, 'W7EmailNotifier.notify');
  const smsImplDirect = findChild(kids, 'W7SmsNotifier.notify');
  assert.ok(emailImplDirect && smsImplDirect, 'v0.7.1/R7: implementer(s) must be DIRECT children of the call site, not buried under the interface node');
  assert.strictEqual(emailImplDirect.via, 'interface');
  assert.strictEqual(emailImplDirect.approximate, true);
  assert.strictEqual(smsImplDirect.via, 'interface');
  assert.strictEqual(smsImplDirect.approximate, true);

  const unresolved = kids.find((k) => k.kind === 'unresolved');
  assert.ok(unresolved, 'unresolved-aggregate: the one genuinely-unresolved dot-call (mystery.zzzW7Unresolved()) must produce an aggregated leaf');
  assert.strictEqual(unresolved.label, '1 unresolved site');
  assert.strictEqual(unresolved.truncated, true, 'the unresolved-aggregate leaf is terminal');
  assert.strictEqual(unresolved.approximate, true);
  assert.deepStrictEqual(unresolved.children, []);

  // A5 (continued): forward-tracing the INTERFACE method itself fans out to
  // every implementer -- the relationship the call site above deliberately
  // deferred.
  // v0.13/H2: showUnconfirmed:'expand' -- this block's own point is "every
  // one of these children is via='interface'/approximate", which is a
  // pre-H2 assertion about EACH fanned-out node, not about how they're
  // grouped. Passing 'expand' keeps them flat (old behavior) so the loop
  // below still iterates real per-node children instead of one rollup
  // pseudo-node; the dedicated H2 rollup tests (below) cover the DEFAULT
  // 'rollup' grouping behavior this same fixture would otherwise exercise.
  const ifaceTree = buildCalleeTree(indexW7, { classLower: 'w7notifiable', methodLower: 'notify' }, { showUnconfirmed: 'expand' });
  const ifaceKids = ifaceTree.root.children;
  assert.ok(findChild(ifaceKids, 'W7EmailNotifier.notify'), 'A5: AcmeNotifiable#notify\'s own forward children fan out to every implementer (W7EmailNotifier)');
  assert.ok(findChild(ifaceKids, 'W7SmsNotifier.notify'), 'A5: ...and W7SmsNotifier');
  for (const k of ifaceKids) {
    assert.strictEqual(k.via, 'interface');
    assert.strictEqual(k.approximate, true);
  }
}

// ---- direction field --------------------------------------------------
{
  const calleeTree = buildCalleeTree(indexW7, { classLower: 'w7caller', methodLower: 'entry' });
  assert.strictEqual(calleeTree.direction, 'callees');
  const callerTree = buildCallerTree(indexW7, { classLower: 'w7target', methodLower: 'dostatic' });
  assert.strictEqual(callerTree.direction, 'callers', 'buildCallerTree TreeResult.direction must be "callers"');
  // not-found shells carry direction too (both are additive fields; see
  // resolver.js's own comment on each not-found branch).
  const missingCallee = buildCalleeTree(indexW7, { classLower: 'nope', methodLower: 'x' });
  assert.strictEqual(missingCallee.direction, 'callees');
  const missingCaller = buildCallerTree(indexW7, { classLower: 'nope', methodLower: 'x' });
  assert.strictEqual(missingCaller.direction, 'callers');
}

// ---- forward cycles + seenElsewhere + cap (mirrors the existing H1 tests'
// exact P/Q/R/S shape, edges reversed since callees pairs are OUTBOUND:
// W7CycP calls BOTH W7CycQ and W7CycR directly; both Q and R call W7CycS;
// S calls back to Q, which IS an ancestor on the P->Q->S->Q branch (cyclic)
// but NOT on the P->R->S->Q branch's own ancestor path the first time S is
// reached from Q -- S's SECOND occurrence (under R) is what exercises
// seenElsewhere, exactly mirroring H1's own P/Q/R/S fixture one level
// removed in the opposite direction) -----------------------------------
{
  const W7CycQ = ty('W7CycQ', 'W7CycQ', {
    methods: [mth('m', { line: 1, calls: [cl('dot', 'm', { receiver: 'W7CycS', line: 1, lineText: 'W7CycS.m();' })] })],
  });
  const W7CycR = ty('W7CycR', 'W7CycR', {
    methods: [mth('m', { line: 1, calls: [cl('dot', 'm', { receiver: 'W7CycS', line: 1, lineText: 'W7CycS.m();' })] })],
  });
  const W7CycS = ty('W7CycS', 'W7CycS', {
    methods: [mth('m', { line: 1, calls: [cl('dot', 'm', { receiver: 'W7CycQ', line: 1, lineText: 'W7CycQ.m();' })] })],
  });
  const W7CycP = ty('W7CycP', 'W7CycP', {
    methods: [
      mth('m', {
        line: 1,
        calls: [
          cl('dot', 'm', { receiver: 'W7CycQ', line: 1, lineText: 'W7CycQ.m();' }),
          cl('dot', 'm', { receiver: 'W7CycR', line: 2, lineText: 'W7CycR.m();' }),
        ],
      }),
    ],
  });
  const indexCyc = buildSemanticIndex([mkFile(W7CycP), mkFile(W7CycQ), mkFile(W7CycR), mkFile(W7CycS)]);
  const tree = buildCalleeTree(indexCyc, { classLower: 'w7cycp', methodLower: 'm' });
  const qNode = findChild(tree.root.children, 'W7CycQ.m');
  const rNode = findChild(tree.root.children, 'W7CycR.m');
  assert.ok(qNode && rNode, 'forward: both W7CycQ.m and W7CycR.m must be direct callees of W7CycP.m');
  assert.strictEqual(qNode.seenElsewhere, false, 'forward: W7CycQ.m (first occurrence) must expand normally');

  const sUnderQ = findChild(qNode.children, 'W7CycS.m');
  assert.ok(sUnderQ, 'forward: W7CycS.m must appear as W7CycQ.m\'s callee');
  assert.strictEqual(sUnderQ.seenElsewhere, false, "forward: W7CycS.m's FIRST occurrence (under W7CycQ) must expand normally");
  assert.strictEqual(sUnderQ.children.length, 1, "forward: W7CycS.m's own subtree (its callee W7CycQ.m, cyclic) must still be built on its first, expanding occurrence");

  const qUnderS = findChild(sUnderQ.children, 'W7CycQ.m');
  assert.ok(qUnderS, 'forward cycle: W7CycQ must reappear one level under W7CycS (P -> Q -> S -> Q)');
  assert.strictEqual(qUnderS.cyclic, true, 'forward: cyclic flag must be set when the identity is already on the ancestor path');
  assert.deepStrictEqual(qUnderS.children, []);

  const sUnderR = findChild(rNode.children, 'W7CycS.m');
  assert.ok(sUnderR, 'forward: W7CycS.m must ALSO appear as W7CycR.m\'s callee (R -> S, a second edge to an already-expanded identity)');
  assert.strictEqual(sUnderR.seenElsewhere, true, 'forward: a second occurrence of an already-expanded identity must be seenElsewhere, not re-walked');
  assert.strictEqual(sUnderR.cyclic, false, 'seenElsewhere is not cyclic -- W7CycS is not W7CycR\'s own ancestor');
  assert.deepStrictEqual(sUnderR.children, [], 'a seenElsewhere node\'s subtree must not be re-materialized');

  // maxNodes cap, forward direction: a non-repeating fan-out chain (every
  // identity distinct) so the cap itself is what stops expansion.
  const capFactsFwd = [];
  const namesFwd = [];
  for (let i = 0; i < 30; i++) namesFwd.push(`W7Cap${i}`);
  for (let i = 0; i < namesFwd.length; i++) {
    const calls = i < namesFwd.length - 1 ? [cl('dot', 'm', { receiver: namesFwd[i + 1], line: 1, lineText: `${namesFwd[i + 1]}.m();` })] : [];
    capFactsFwd.push(mkFile(ty(namesFwd[i], namesFwd[i], { methods: [mth('m', { line: 1, calls })] })));
  }
  const indexCapFwd = buildSemanticIndex(capFactsFwd);
  const treeCappedFwd = buildCalleeTree(indexCapFwd, { classLower: namesFwd[0].toLowerCase(), methodLower: 'm' }, { maxDepth: 100, maxNodes: 10 });
  assert.strictEqual(treeCappedFwd.stats.capped, true, 'forward: exceeding maxNodes must set stats.capped = true');
  assert.strictEqual(treeCappedFwd.stats.nodes, 10, 'forward: node creation must stop AT maxNodes');
  const treeUncappedFwd = buildCalleeTree(indexCapFwd, { classLower: namesFwd[0].toLowerCase(), methodLower: 'm' }, { maxDepth: 100, maxNodes: 2000 });
  assert.strictEqual(treeUncappedFwd.stats.capped, false);
  assert.strictEqual(treeUncappedFwd.stats.nodes, namesFwd.length, 'forward: the uncapped trace must show every one of the 30 distinct callees');
}

// =========================================================================
// v0.7 B2: multi-package awareness (duplicate-name bucket resolution)
// =========================================================================

// Three packages: 'pkgA' (default), 'pkgB', 'pkgC'. 'W7Dup' is declared in
// ALL THREE (the qualified-name collision fixture); 'W7OnlyB' exists only
// in pkgB (an ordinary, non-duplicated name, used for the default-package-
// fallback case: a pkgC caller referencing a name that exists in NEITHER
// its own package NOR the default falls through to... nothing here, since
// W7OnlyB isn't duplicated at all -- see the dedicated default-fallback
// fixture below for the real B2 rule-2 case).
const W7DupA = ty('W7Dup', 'W7Dup', { methods: [mth('identify', { line: 1 })] });
const W7DupB = ty('W7Dup', 'W7Dup', { methods: [mth('identify', { line: 1 })] });
const W7DupC = ty('W7Dup', 'W7Dup', { methods: [mth('identify', { line: 1 })] });

const W7SamePkgCaller = ty('W7SamePkgCaller', 'W7SamePkgCaller', {
  methods: [mth('go', { line: 1, calls: [cl('dot', 'identify', { receiver: 'W7Dup', line: 1, lineText: 'W7Dup.identify();' })] })],
});
const W7DefaultFallbackCaller = ty('W7DefaultFallbackCaller', 'W7DefaultFallbackCaller', {
  methods: [mth('go', { line: 1, calls: [cl('dot', 'identify', { receiver: 'W7Dup', line: 1, lineText: 'W7Dup.identify();' })] })],
});
const W7AmbiguousCaller = ty('W7AmbiguousCaller', 'W7AmbiguousCaller', {
  methods: [mth('go', { line: 1, calls: [cl('dot', 'identify', { receiver: 'W7Dup', line: 1, lineText: 'W7Dup.identify();' })] })],
});

// Files, mapped to packages purely by PATH PREFIX (mirrors how a real
// extension.js would derive opts.packageOf from sfdx-project.json's
// packageDirectories -- resolver.js itself never parses paths for this,
// see buildSemanticIndex's own header note on the opts contract).
const w7DupAFile = file('/ws/pkgA/classes/W7Dup.cls', 'class', [W7DupA]);
const w7DupBFile = file('/ws/pkgB/classes/W7Dup.cls', 'class', [W7DupB]);
const w7DupCFile = file('/ws/pkgC/classes/W7Dup.cls', 'class', [W7DupC]);
// B1: same-package preference -- caller lives in pkgB, same as one candidate.
const w7SamePkgCallerFile = file('/ws/pkgB/classes/W7SamePkgCaller.cls', 'class', [W7SamePkgCaller]);
// B2: default-package fallback -- caller lives in pkgD, a FOURTH package
// that declares no W7Dup of its own at all (rule 1 must fail cleanly);
// pkgA is the default package, so resolution falls through to it. (pkgC
// deliberately does NOT work for this fixture -- W7Dup is duplicated
// across all of pkgA/B/C, so a pkgC caller would hit rule 1 against its
// OWN pkgC candidate first; see MANIFEST's own real-corpus note that
// default-fallback and ambiguity require a referrer OUTSIDE every
// candidate package.)
const w7DefaultFallbackCallerFile = file('/ws/pkgD/classes/W7DefaultFallbackCaller.cls', 'class', [W7DefaultFallbackCaller]);

function w7PackageOf(fsPath) {
  const m = /\/ws\/(pkg[ABCD])\//.exec(fsPath || '');
  return m ? m[1] : null;
}
const W7_DEFAULT_PACKAGE = 'pkgA';

// ---- B1/B2: same-package preference + default-package fallback ------------
{
  const facts = [w7DupAFile, w7DupBFile, w7DupCFile, w7SamePkgCallerFile, w7DefaultFallbackCallerFile];
  const index = buildSemanticIndex(facts, { packageOf: w7PackageOf, defaultPackage: W7_DEFAULT_PACKAGE });

  assert.strictEqual(index.stats.duplicateNames, 1, 'B2: exactly ONE duplicated qualified name (W7Dup, in 3 buckets) when packageOf is active');
  assert.deepStrictEqual(index.duplicates, ['W7Dup', 'W7Dup'], 'duplicates keeps the pre-existing flat name list (2 losers of the 3-way collision)');

  const bucket = index.classBuckets.get('w7dup');
  assert.strictEqual(bucket.length, 3, 'classBuckets must expose all 3 same-name candidates');
  const bPkgEntry = bucket.find((b) => b.package === 'pkgB');
  const aPkgEntry = bucket.find((b) => b.package === 'pkgA');

  const treeSamePkg = buildCallerTree(index, { classLower: bPkgEntry.classLower, methodLower: 'identify' });
  const samePkgCaller = findChild(treeSamePkg.root.children, 'W7SamePkgCaller.go');
  assert.ok(samePkgCaller, 'B1: pkgB\'s own W7Dup.identify must be called by W7SamePkgCaller (same-package preference)');
  assert.strictEqual(samePkgCaller.via, 'static');
  const treeOtherPkg = buildCallerTree(index, { classLower: aPkgEntry.classLower, methodLower: 'identify' });
  assert.ok(!findChild(treeOtherPkg.root.children, 'W7SamePkgCaller.go'), 'B1: pkgA\'s (default-package) W7Dup.identify must NOT ALSO be called by W7SamePkgCaller -- same-package wins outright, no fan-out to the default package too');

  const treeDefault = buildCallerTree(index, { classLower: aPkgEntry.classLower, methodLower: 'identify' });
  const defaultCaller = findChild(treeDefault.root.children, 'W7DefaultFallbackCaller.go');
  assert.ok(defaultCaller, 'B2 rule 2: pkgC (no W7Dup of its own) falls through to the DEFAULT package (pkgA)');
  assert.strictEqual(defaultCaller.via, 'static');
  const cPkgEntry = bucket.find((b) => b.package === 'pkgC');
  const treeNonDefault = buildCallerTree(index, { classLower: cPkgEntry.classLower, methodLower: 'identify' });
  assert.ok(!findChild(treeNonDefault.root.children, 'W7DefaultFallbackCaller.go'), 'B2 rule 2: the non-default pkgC candidate must NOT be chosen instead');
}

// ---- B3: ambiguous fan-out (neither same-package nor default-package
// preference can disambiguate -- caller lives in a THIRD package declaring
// neither candidate, and the default package ALSO isn't one of the two
// candidates) ---------------------------------------------------------------
{
  // W7Dup2 duplicated ONLY across pkgB/pkgC (NOT pkgA, the default) --
  // exactly the shape B2's own spec requires for genuine ambiguity to be
  // reachable at all (see resolver.js's classBuckets header note / the
  // real corpus's own B3 fixture design note in MANIFEST.md).
  const W7Dup2B = ty('W7Dup2', 'W7Dup2', { methods: [mth('identify', { line: 1 })] });
  const W7Dup2C = ty('W7Dup2', 'W7Dup2', { methods: [mth('identify', { line: 1 })] });
  const W7AmbigCaller2 = ty('W7AmbigCaller2', 'W7AmbigCaller2', {
    methods: [mth('go', { line: 1, calls: [cl('dot', 'identify', { receiver: 'W7Dup2', line: 1, lineText: 'W7Dup2.identify();' })] })],
  });
  const facts = [
    file('/ws/pkgB/classes/W7Dup2.cls', 'class', [W7Dup2B]),
    file('/ws/pkgC/classes/W7Dup2.cls', 'class', [W7Dup2C]),
    file('/ws/pkgA/classes/W7AmbigCaller2.cls', 'class', [W7AmbigCaller2]),
  ];
  const index = buildSemanticIndex(facts, { packageOf: w7PackageOf, defaultPackage: W7_DEFAULT_PACKAGE });
  const bucket = index.classBuckets.get('w7dup2');
  assert.strictEqual(bucket.length, 2);

  const treeB = buildCallerTree(index, { classLower: bucket.find((b) => b.package === 'pkgB').classLower, methodLower: 'identify' });
  const callerInB = findChild(treeB.root.children, 'W7AmbigCaller2.go');
  assert.ok(callerInB, 'B3: the ambiguous call site must produce an edge to the pkgB candidate');
  assert.strictEqual(callerInB.via, 'ambiguous');
  assert.strictEqual(callerInB.approximate, true, "B3: via='ambiguous' must join the approximate set");

  const treeC = buildCallerTree(index, { classLower: bucket.find((b) => b.package === 'pkgC').classLower, methodLower: 'identify' });
  const callerInC = findChild(treeC.root.children, 'W7AmbigCaller2.go');
  assert.ok(callerInC, 'B3: ...AND to the pkgC candidate, from the SAME call site (fan-out, not a single pick)');
  assert.strictEqual(callerInC.via, 'ambiguous');

  // Forward direction sees the same fan-out from the caller's own side.
  // v0.13/H2: showUnconfirmed:'expand' -- this assertion is about the raw
  // fan-out SHAPE (two distinct 'ambiguous' children, both approximate),
  // which is exactly what 'rollup' would otherwise collapse into one
  // pseudo-node; 'expand' keeps pre-H2 flat behavior for this check.
  const calleeTree = buildCalleeTree(index, { classLower: 'w7ambigcaller2', methodLower: 'go' }, { showUnconfirmed: 'expand' });
  const targets = calleeTree.root.children.map((c) => c.label).sort();
  assert.deepStrictEqual(targets, ['W7Dup2.identify', 'W7Dup2.identify'].sort(), 'B3 forward: the ambiguous call site forwards to BOTH candidates too');
  for (const c of calleeTree.root.children) {
    assert.strictEqual(c.via, 'ambiguous');
    assert.strictEqual(c.approximate, true);
  }
}

// ---- B5: packageless identity -- opts absent must reproduce today's
// first-wins-drop behavior EXACTLY (no bucket surfacing, no via='ambiguous',
// stats.duplicateNames stays 0) even though the SAME 3-way name collision
// is present in the fixture ---------------------------------------------
{
  const facts = [w7DupAFile, w7DupBFile, w7DupCFile, w7SamePkgCallerFile, w7DefaultFallbackCallerFile];
  const index = buildSemanticIndex(facts); // no opts at all -- the pre-v0.7 call shape

  assert.strictEqual(index.stats.duplicateNames, 0, 'B5: stats.duplicateNames must be 0 (not merely absent) when opts.packageOf is inactive, even with real duplicate names present');
  assert.deepStrictEqual(index.duplicates, ['W7Dup', 'W7Dup'], 'the pre-existing flat duplicates list is unaffected either way');

  // First-parsed file (w7DupAFile, pkgA) wins the plain 'w7dup' slot --
  // identical to the documented pre-v0.7 collision policy.
  const tree = buildCallerTree(index, { classLower: 'w7dup', methodLower: 'identify' });
  const callers = tree.root.children.map((c) => c.label).sort();
  assert.deepStrictEqual(
    callers,
    ['W7DefaultFallbackCaller.go', 'W7SamePkgCaller.go'],
    'B5: BOTH callers resolve to the single first-wins W7Dup slot (pkgA) -- no package-based split, exactly today\'s behavior'
  );
  for (const c of tree.root.children) {
    assert.strictEqual(c.via, 'static', "B5: via stays 'static' -- 'ambiguous' must never appear when packageOf is inactive");
  }
}

// =========================================================================
// MUST-FIX #5 regression: packageless-identity must hold for a LIVE
// packageOf function that merely returns null for every path -- not just
// when opts.packageOf is omitted entirely. This is byte-for-byte what
// extension.js's discoverPackageMap() produces whenever a workspace has no
// discoverable sfdx-project.json (see extension.js's scanAndBuildIndex,
// which always passes `{ packageOf }`, never omits the key). Before this
// fix, buildSemanticIndex gated ALL of B2's behavior on mere function
// PRESENCE (`opts && typeof opts.packageOf === 'function'`), so this exact
// shape wrongly turned on bucket surfacing / stats.duplicateNames /
// via='ambiguous' edges even though packageOf never told it anything real.
// =========================================================================
{
  const facts = [w7DupAFile, w7DupBFile, w7DupCFile, w7SamePkgCallerFile, w7DefaultFallbackCallerFile];
  const indexOmitted = buildSemanticIndex(facts); // opts fully omitted
  const indexLiveNullPackageOf = buildSemanticIndex(facts, { packageOf: () => null }); // MUST-FIX #5 shape

  assert.strictEqual(
    indexLiveNullPackageOf.stats.duplicateNames,
    indexOmitted.stats.duplicateNames,
    'MUST-FIX #5: a live packageOf that always returns null must produce the SAME stats.duplicateNames as opts omitted entirely (both 0), not merely "opts.packageOf is a function"'
  );
  assert.strictEqual(indexLiveNullPackageOf.stats.duplicateNames, 0, 'MUST-FIX #5: duplicateNames must be 0, not surfaced, when package metadata is never actually discovered');

  const treeOmitted = buildCallerTree(indexOmitted, { classLower: 'w7dup', methodLower: 'identify' });
  const treeLiveNullPackageOf = buildCallerTree(indexLiveNullPackageOf, { classLower: 'w7dup', methodLower: 'identify' });
  const viasOmitted = treeOmitted.root.children.map((c) => c.via).sort();
  const viasLiveNullPackageOf = treeLiveNullPackageOf.root.children.map((c) => c.via).sort();
  assert.deepStrictEqual(viasLiveNullPackageOf, viasOmitted, 'MUST-FIX #5: via values must be byte-identical between opts-omitted and a live packageOf returning null for everything');
  for (const v of viasLiveNullPackageOf) {
    assert.strictEqual(v, 'static', "MUST-FIX #5: via must stay 'static' -- 'ambiguous' must never appear when packageOf never actually resolves a real label");
  }
}

// =========================================================================
// MUST-FIX #2/#3 regression: a method's forward children (methodCallees)
// must be in TRUE SOURCE-LINE order even when the underlying facts come
// from THREE separate MethodFacts arrays (calls/dml/throwsSites) processed
// as three separate loops in buildSemanticIndex's pass B. Before this fix,
// mf.calls[] was always flushed to methodCallees before mf.dml[], which was
// always flushed before mf.throwsSites[], regardless of which one actually
// sits earlier in the source -- reproduces MANIFEST v0.7 chains #3 (DML
// before a later call) and #5 (throw before a later call).
// =========================================================================
{
  // Mirrors AcmeOrderUtil.markApproved (MANIFEST v0.7 chain #3): a DML
  // statement at an EARLIER line than an ordinary call, using the exact
  // same object/trigger-resolution pattern the pre-existing W7 fixture
  // above already proves works (local var typed 'W7_Account__c', a trigger
  // registered on the same object) -- reused here so the DML statement
  // actually produces a real forward child, not merely a no-op.
  const W7OrdTarget = ty('W7OrdTarget', 'W7OrdTarget', { methods: [mth('doStatic', { line: 1, isStatic: true })] });
  const W7OrdBoom = ty('W7OrdBoom', 'W7OrdBoom', { methods: [] }); // recognized as an exception target by its name alone (isExceptionTargetClass fallback)
  const W7OrdMix = ty('W7OrdMix', 'W7OrdMix', {
    methods: [
      mth('orderedMix', {
        line: 1,
        locals: [{ name: 'acct', type: 'W7_Account__c', line: 1 }],
        // Source order (true line numbers): DML (L5), throw (L6), call (L7)
        // -- pass B's own internal loop order is calls[]/dml[]/throwsSites[]
        // (the OPPOSITE order), so this fixture only passes once the
        // post-loop sort (MUST-FIX #2/#3) is actually applied.
        calls: [cl('dot', 'doStatic', { receiver: 'W7OrdTarget', line: 7, lineText: 'W7OrdTarget.doStatic();' })],
        dml: [dmlFact('insert', 'acct', { line: 5, lineText: 'insert acct;' })],
        throwsSites: [throwSite({ typeName: 'W7OrdBoom', line: 6, lineText: "throw new W7OrdBoom('x');" })],
      }),
    ],
  });
  const W7OrdTriggerType = ty('W7OrdTrigger', 'W7OrdTrigger', { methods: [mth('(trigger)', { line: 1 })] });
  const W7OrdTriggerFile = file(PT('W7OrdTrigger'), 'trigger', [W7OrdTriggerType], {
    triggerInfo: { object: 'W7_Account__c', events: ['before insert'] },
  });
  const facts = [mkFile(W7OrdTarget), mkFile(W7OrdBoom), mkFile(W7OrdMix), W7OrdTriggerFile];
  const index = buildSemanticIndex(facts);
  const tree = buildCalleeTree(index, { classLower: 'w7ordmix', methodLower: 'orderedmix' });
  const order = tree.root.children.map((c) => ({ label: c.label, via: c.via }));
  assert.deepStrictEqual(
    order.map((c) => c.via),
    ['dml', 'throws', 'static'],
    `MUST-FIX #2/#3: forward children must be in TRUE SOURCE-LINE order (dml L5, throws L6, call L7) regardless of the calls[]/dml[]/throwsSites[] loop order pass B walks them in -- got ${JSON.stringify(order)}`
  );
  assert.strictEqual(order[0].label, 'W7OrdTrigger', 'MUST-FIX #2: the DML (L5, earliest) must be first -- reproduces MANIFEST v0.7 chain #3 (AcmeOrderUtil.markApproved: dml L22 before static call L23)');
  assert.strictEqual(order[1].label, 'W7OrdBoom', 'MUST-FIX #3: the throw (L6) must be second, before the later ordinary call -- reproduces MANIFEST v0.7 chain #5 (AcmeOrderValidator.validate: throws L9 before checkStock call L16)');
  assert.strictEqual(order[2].label, 'W7OrdTarget.doStatic', 'the ordinary call (L7, latest) must come last');
}

// =========================================================================
// MUST-FIX #4 regression: forward interface fan-out order must follow each
// implementer's earliest known construction site in the codebase (e.g. a
// dispatcher's own `List<Iface>{ new A(), new B(), new C() }` literal), NOT
// raw interfaceImplementers scan/registration order -- reproduces MANIFEST
// v0.7 chain #8 (AcmeNotifiable#notify's fan-out must be Email/Sms/Base
// -- the dispatchToAll list-literal order -- not the alphabetical
// Email/Base(Slack)/Sms scan order the file layout would otherwise produce).
// =========================================================================
{
  const W7Iface = ty('W7NotifIface', 'W7NotifIface', { isInterface: true, methods: [mth('notify', { line: 1 })] });
  // Deliberately registered in ALPHABETICAL order (Alpha, Bravo, Charlie)
  // so scan-order alone would already produce the "correct-looking" answer
  // if this regression test were weaker -- the dispatcher below constructs
  // them in the REVERSE (Charlie, Bravo, Alpha) order, which is what must
  // win.
  const W7Alpha = ty('W7NotifAlpha', 'W7NotifAlpha', { implementsTypes: ['W7NotifIface'], methods: [mth('notify', { line: 1 })] });
  const W7Bravo = ty('W7NotifBravo', 'W7NotifBravo', { implementsTypes: ['W7NotifIface'], methods: [mth('notify', { line: 1 })] });
  const W7Charlie = ty('W7NotifCharlie', 'W7NotifCharlie', { implementsTypes: ['W7NotifIface'], methods: [mth('notify', { line: 1 })] });
  const W7Dispatcher = ty('W7NotifDispatcher', 'W7NotifDispatcher', {
    methods: [
      mth('dispatchAll', {
        line: 1,
        calls: [
          cl('new', 'W7NotifCharlie', { line: 10, lineText: 'new W7NotifCharlie()' }),
          cl('new', 'W7NotifBravo', { line: 11, lineText: 'new W7NotifBravo()' }),
          cl('new', 'W7NotifAlpha', { line: 12, lineText: 'new W7NotifAlpha()' }),
        ],
      }),
    ],
  });
  const facts = [mkFile(W7Iface), mkFile(W7Alpha), mkFile(W7Bravo), mkFile(W7Charlie), mkFile(W7Dispatcher)];
  const index = buildSemanticIndex(facts);
  // v0.13/H2: showUnconfirmed:'expand' -- this fixture's own point is the
  // construction-site ORDER among the fanned-out interface implementers;
  // 'rollup' would otherwise collapse all three into one pseudo-node
  // (order preserved inside it, but this assertion checks root.children
  // directly).
  const ifaceTree = buildCalleeTree(index, { classLower: 'w7notififace', methodLower: 'notify' }, { showUnconfirmed: 'expand' });
  const order = ifaceTree.root.children.map((c) => c.label);
  assert.deepStrictEqual(
    order,
    ['W7NotifCharlie.notify', 'W7NotifBravo.notify', 'W7NotifAlpha.notify'],
    `MUST-FIX #4: interface fan-out order must follow construction-site order (Charlie/Bravo/Alpha per the dispatcher's own list), NOT alphabetical scan order (Alpha/Bravo/Charlie) -- got ${JSON.stringify(order)}`
  );
}

// =========================================================================
// MUST-FIX #1 regression: suggestTargets() must stamp each duplicate-name
// candidate with ITS OWN distinct classLower (cm.classLower, the real
// classes.get() key), not the shared lc(qualified) every candidate would
// otherwise collapse onto -- and buildCallerTree/buildCalleeTree, driven
// with EXACTLY the target object suggestTargets()'s own output produces
// (mirroring the real QuickPick flow: buildSuggestPicks -> resolveTarget),
// must reach the CORRECT candidate, not silently fall back to the
// first-registered one.
// =========================================================================
{
  const facts = [w7DupAFile, w7DupBFile, w7DupCFile, w7SamePkgCallerFile, w7DefaultFallbackCallerFile];
  const index = buildSemanticIndex(facts, { packageOf: w7PackageOf, defaultPackage: W7_DEFAULT_PACKAGE });

  const picks = suggestTargets(index).filter((p) => p.label === 'W7Dup' || p.label === 'W7Dup.identify');
  const classLowers = new Set(picks.map((p) => p.classLower));
  assert.strictEqual(classLowers.size, 3, `MUST-FIX #1: 3 duplicate W7Dup candidates must produce 3 DISTINCT classLower values, got ${JSON.stringify([...classLowers])}`);
  for (const p of picks) {
    assert.ok(Object.prototype.hasOwnProperty.call(p, 'package'), 'MUST-FIX #1: a suggestTargets() item for a duplicated name must carry a package field once package metadata is active');
  }

  // Drive buildCallerTree with the EXACT target shape a real QuickPick pick
  // produces -- {classLower, methodLower} straight off the suggestTargets()
  // item, no reaching into index.classBuckets.
  const bPkgPick = picks.find((p) => p.methodLower === 'identify' && p.package === 'pkgB');
  assert.ok(bPkgPick, 'MUST-FIX #1: the pkgB W7Dup.identify candidate must be suggestable');
  const treeB = buildCallerTree(index, { classLower: bPkgPick.classLower, methodLower: bPkgPick.methodLower }, {});
  assert.ok(findChild(treeB.root.children, 'W7SamePkgCaller.go'), 'MUST-FIX #1: buildCallerTree, driven by suggestTargets()\'s own classLower, must reach the pkgB candidate\'s real caller (same-package preference)');

  // Forward direction: same guarantee via buildCalleeTree.
  const calleeTreeB = buildCalleeTree(index, { classLower: bPkgPick.classLower, methodLower: bPkgPick.methodLower }, {});
  assert.ok(calleeTreeB && calleeTreeB.root, 'MUST-FIX #1: buildCalleeTree must also resolve the suggestTargets()-derived duplicate classLower (not collapse to the primary candidate)');
  assert.strictEqual(calleeTreeB.root.className, 'W7Dup', 'MUST-FIX #1: the resolved root must be a REAL W7Dup candidate, not a "target not found" shell');
}

// =========================================================================
// v0.7: end of A1/A2/B2 additions.
// =========================================================================

// =========================================================================
// v0.7.1 GAUNTLET REGRESSION PINS -- each block below ports one confirmed
// finding from test-fixtures/gauntlet-org/
// VALIDATION-REPORT.md (R1-R8) into a self-contained assert, named after
// the finding. R7's pin lives inline above (the W7 interface-dispatch
// block, updated in place -- see its own "v0.7.1/R7" comments) since it
// amends an existing assertion rather than adding a new one.
// =========================================================================

// ---- v0.7.1/R1: namespace-qualified receiver guard ------------------------
// VALIDATION-REPORT.md Tier-1 #2: `zenq.Billing.charge()` (a reference into
// a namespace that doesn't exist in the workspace) must NOT bare-tail-match
// the unrelated LOCAL class whose simple name happens to equal the
// receiver's last dotted segment. Pins dev/gauntlet/probe3.js +
// run-namespace-probes.js PROBE 1 (VertexLedgerBridge.cls:19 shape).
{
  const G71Billing = ty('G71Billing', 'G71Billing', {
    methods: [mth('charge', { line: 1, params: [{ name: 'amount', type: 'Decimal' }] })],
  });
  const G71LedgerBridge = ty('G71LedgerBridge', 'G71LedgerBridge', {
    methods: [
      mth('postToLedger', {
        line: 1,
        calls: [cl('dot', 'charge', { receiver: 'zenq.G71Billing', argTexts: ['amount'], line: 2, lineText: 'zenq.G71Billing.charge(amount);' })],
      }),
    ],
  });
  const index = buildSemanticIndex([mkFile(G71Billing), mkFile(G71LedgerBridge)]);
  const tree = buildCallerTree(index, { classLower: 'g71billing', methodLower: 'charge' });
  assert.deepStrictEqual(tree.root.children, [], 'v0.7.1/R1: zenq.G71Billing.charge() must NOT resolve onto the unrelated local G71Billing.charge (namespace-prefix bare-tail collision)');
  assert.strictEqual(tree.note, 'No callers found — this is likely an entry point or unused code.');
  // v0.8/N1(a)/N2 step 3 (REGRESSION POLICY category (a)): this EXACT shape
  // is now the corpus's own promoted namespace probe (see gauntlet-org's
  // GROUND-TRUTH.md v0.8-A1) -- the reference no longer stays an anonymous
  // unresolved site, it becomes a first-class EXTERNAL node instead. The
  // "no false LOCAL edge" invariant above is UNCHANGED; only where the
  // reference lands changes.
  assert.strictEqual(index.stats.unresolvedSites, 0, 'v0.8/N2: the namespaced call is no longer counted as unresolved -- it is now modeled as an external edge');
  assert.strictEqual(index.stats.externalRefs, 1, 'v0.8/N5: exactly one external ref recorded');
  assert.deepStrictEqual(index.stats.externalNamespaces, ['zenq'], 'v0.8/N5: the external namespace surfaces on index.stats');
  const ext = index.externals.get('zenq.g71billing');
  assert.ok(ext, 'v0.8/N1(a): an ExternalMeta for zenq.G71Billing must exist, keyed nslower.classlower');
  assert.strictEqual(ext.ns, 'zenq');
  assert.strictEqual(ext.className, 'G71Billing');
  assert.strictEqual(ext.label, 'zenq.G71Billing', "v0.8/N1: external label is 'ns.Class' for a namespaced Apex call site");
  assert.strictEqual(ext.refCount, 1);
  assert.deepStrictEqual([...ext.methods], ['charge'], 'v0.8/N1: the observed method is recorded on the ExternalMeta');
  // v0.8/N4: the external IS a valid trace target in the callers direction,
  // with the referencing LOCAL site (G71LedgerBridge.postToLedger) as its
  // caller -- "full normal caller tree above them".
  const extTree = buildCallerTree(index, { classLower: 'zenq.g71billing', methodLower: null });
  assert.strictEqual(extTree.root.kind, 'external');
  assert.strictEqual(extTree.root.label, 'zenq.G71Billing');
  assert.strictEqual(extTree.root.ns, 'zenq');
  const extCaller = findChild(extTree.root.children, 'G71LedgerBridge.postToLedger');
  assert.ok(extCaller, 'v0.8/N4: G71LedgerBridge.postToLedger must appear as a caller of the external zenq.G71Billing node');
  assert.strictEqual(extCaller.via, 'external');
  assert.strictEqual(extCaller.approximate, false, "v0.8/N2: 'external' is NOT approximate -- a genuine namespace match is exact, not a guess");
}

// ---- v0.7.1/R1 re-hunt: known-class head does not imply known chain ------
// Adversarial re-hunt finding (dev/gauntlet/repro-zenq-known-class-bare-tail.js
// + run-namespace-probes-v2-rehunt.js PROBE A): isUnknownNamespacedReceiver
// previously treated ANY dotted receiver as "in scope" the moment its HEAD
// segment matched some known local class AT ALL (`classes.has(headLower)` /
// `simpleNameIndex.has(headLower)`), without checking that the REMAINDER of
// the chain actually resolves within that class's own inner-class hierarchy.
// A genuine local top-level class literally named `zenq` (whose only inner
// class is `Foo`, entirely unrelated to G71KappaGateway) must NOT cause
// `zenq.G71KappaGateway.dispatch(...)` to be treated as in-scope just
// because `zenq` itself is real -- it must still be excluded exactly as if
// `zenq` were an unknown namespace token, and it must NOT resurrect the
// false edge for the pre-existing zenq.G71Billing.charge() site either
// (same fixture, two independent receivers sharing the `zenq` head).
{
  const G71ZenqFoo = ty('Foo', 'zenq.Foo', { methods: [mth('bar', { line: 1 })] });
  const G71Zenq = ty('zenq', 'zenq', { methods: [] });
  const G71ZenqFile = file(P('G71Zenq'), 'class', [G71Zenq, G71ZenqFoo]);

  const G71RehuntKappaGateway = ty('G71RehuntKappaGateway', 'G71RehuntKappaGateway', {
    methods: [mth('dispatch', { line: 1, params: [{ name: 'cmd', type: 'String' }] })],
  });
  const G71RehuntBilling = ty('G71RehuntBilling', 'G71RehuntBilling', {
    methods: [mth('charge', { line: 1, params: [{ name: 'amount', type: 'Decimal' }] })],
  });
  const G71RehuntCaller = ty('G71RehuntCaller', 'G71RehuntCaller', {
    methods: [
      mth('run', {
        line: 1,
        calls: [
          cl('dot', 'dispatch', { receiver: 'zenq.G71RehuntKappaGateway', argTexts: ['cmd'], line: 2, lineText: "zenq.G71RehuntKappaGateway.dispatch('cmd');" }),
          cl('dot', 'charge', { receiver: 'zenq.G71RehuntBilling', argTexts: ['amount'], line: 3, lineText: 'zenq.G71RehuntBilling.charge(amount);' }),
        ],
      }),
    ],
  });
  const index = buildSemanticIndex([G71ZenqFile, mkFile(G71RehuntKappaGateway), mkFile(G71RehuntBilling), mkFile(G71RehuntCaller)]);

  const kgTree = buildCallerTree(index, { classLower: 'g71rehuntkappagateway', methodLower: 'dispatch' });
  assert.deepStrictEqual(
    kgTree.root.children,
    [],
    "v0.7.1/R1 re-hunt: zenq.G71RehuntKappaGateway.dispatch() must NOT resolve onto the unrelated local G71RehuntKappaGateway.dispatch merely because 'zenq' is itself a genuine local class -- the chain's remainder (G71RehuntKappaGateway) isn't a member of zenq's own hierarchy"
  );

  const billingTree = buildCallerTree(index, { classLower: 'g71rehuntbilling', methodLower: 'charge' });
  assert.deepStrictEqual(
    billingTree.root.children,
    [],
    "v0.7.1/R1 re-hunt: the presence of a genuine local 'zenq' class must not resurrect the original bare-tail false edge for zenq.G71RehuntBilling.charge() either"
  );

  // v0.8/N2 step 3 (REGRESSION POLICY category (a)): both zenq.*-prefixed
  // calls are now external edges, NOT unresolved counts -- named regression
  // test for the R1-guard interplay: a GENUINE local class named `zenq`
  // (with its own unrelated inner class `Foo`) coexists in this exact
  // fixture, and must neither (a) resurrect a false local edge (pinned
  // above, unchanged) NOR (b) block/corrupt the external-node creation for
  // either receiver -- both invariants proven simultaneously by one fixture.
  assert.strictEqual(index.stats.unresolvedSites, 0, "v0.8/N2: both zenq.*-prefixed calls are no longer counted as unresolved");
  assert.strictEqual(index.stats.externalRefs, 2);
  assert.deepStrictEqual(index.stats.externalNamespaces, ['zenq']);
  assert.strictEqual(index.externals.size, 2, 'v0.8/N1(a): two DISTINCT external nodes -- one per (ns, className) pair -- not merged just because they share the zenq namespace');

  const kgExt = index.externals.get('zenq.g71rehuntkappagateway');
  assert.ok(kgExt);
  assert.strictEqual(kgExt.label, 'zenq.G71RehuntKappaGateway');
  assert.deepStrictEqual([...kgExt.methods], ['dispatch']);

  const billingExt = index.externals.get('zenq.g71rehuntbilling');
  assert.ok(billingExt);
  assert.strictEqual(billingExt.label, 'zenq.G71RehuntBilling');
  assert.deepStrictEqual([...billingExt.methods], ['charge']);

  // Neither external collides with the GENUINE local 'zenq' class or its
  // real inner class 'zenq.Foo' -- index.classes keeps its own, completely
  // separate identity for those (a class-keyed lookup, not externals-keyed).
  assert.ok(index.classes.has('zenq'), "the genuine local 'zenq' class is still indexed normally");
  assert.ok(index.classes.has('zenq.foo'), "the genuine local 'zenq.Foo' inner class is still indexed normally");
  assert.ok(!index.externals.has('zenq.foo'), "the genuine local 'zenq.Foo' must never ALSO appear as an external node");

  const kgExtTree = buildCallerTree(index, { classLower: 'zenq.g71rehuntkappagateway', methodLower: null });
  assert.ok(findChild(kgExtTree.root.children, 'G71RehuntCaller.run'), 'v0.8/N4: G71RehuntCaller.run is a caller of the external zenq.G71RehuntKappaGateway node');
}

// ---- v0.7.1/R1 re-hunt over-correction guard: genuine Outer.Inner must still edge --
// The fix above must not blanket-block every 'zenq.X' chain -- only ones
// where the remainder doesn't resolve within the head class's own
// hierarchy. A genuine local 'zenq' class with a genuine inner class
// 'G71RehuntBilling2' must still resolve via ordinary static dispatch.
{
  const G71ZenqInner = ty('G71RehuntBilling2', 'zenq.G71RehuntBilling2', {
    methods: [mth('charge', { line: 1, params: [{ name: 'amount', type: 'Decimal' }] })],
  });
  const G71ZenqOuter = ty('zenq', 'zenq', { methods: [] });
  const G71ZenqFile2 = file(P('G71Zenq2'), 'class', [G71ZenqOuter, G71ZenqInner]);
  const G71RehuntCaller2 = ty('G71RehuntCaller2', 'G71RehuntCaller2', {
    methods: [
      mth('run', {
        line: 1,
        calls: [cl('dot', 'charge', { receiver: 'zenq.G71RehuntBilling2', argTexts: ['amount'], line: 2, lineText: 'zenq.G71RehuntBilling2.charge(amount);' })],
      }),
    ],
  });
  const index = buildSemanticIndex([G71ZenqFile2, mkFile(G71RehuntCaller2)]);
  const tree = buildCallerTree(index, { classLower: 'zenq.g71rehuntbilling2', methodLower: 'charge' });
  assert.ok(
    findChild(tree.root.children, 'G71RehuntCaller2.run'),
    "v0.7.1/R1 re-hunt over-correction check: zenq.G71RehuntBilling2.charge() -- a GENUINE Outer.Inner static call -- must still resolve; the guard must not blanket-exclude every dotted chain whose head is named 'zenq'"
  );
  // v0.8/N2 steps 1-2 (pinned as a named regression test): a local class
  // named like a namespace token that ACTUALLY resolves keeps winning --
  // NO external node is ever fabricated for a chain local resolution
  // already succeeded on, and the unresolvedSites count stays untouched too.
  assert.strictEqual(index.externals.size, 0, 'v0.8/N2: a genuinely-resolving Outer.Inner static call must never ALSO create an external node');
  assert.strictEqual(index.stats.unresolvedSites, 0);
  assert.strictEqual(index.stats.externalRefs, 0);
  assert.deepStrictEqual(index.stats.externalNamespaces, []);
}

// ---- v0.7.1/R2: Type-typed receiver denylist (by declared type) ----------
// VALIDATION-REPORT.md Tier-2 #3: `Type implType = ...; implType.newInstance()`
// must not fabricate an edge to an unrelated globally-unique `newInstance`
// method via rule 7 -- the denylist decision must key on the receiver's
// DECLARED TYPE ('Type'), not its identifier text ('implType'). Includes
// the reported spurious SELF-referential cyclic edge (the call sits inside
// the very method that would otherwise become its own "unique" target).
// Pins dev/gauntlet/probe1.js (VertexGenericTriggerDispatcher.cls:8 /
// VertexApplication.cls:8 shape).
{
  const G71Application = ty('G71Application', 'G71Application', {
    methods: [
      mth('newInstance', {
        line: 1,
        isStatic: true,
        locals: [{ name: 'implType', type: 'Type', line: 1 }],
        calls: [cl('dot', 'newInstance', { receiver: 'implType', line: 2, lineText: 'return implType.newInstance();' })],
      }),
    ],
  });
  const index = buildSemanticIndex([mkFile(G71Application)]);
  const tree = buildCallerTree(index, { classLower: 'g71application', methodLower: 'newinstance' });
  assert.deepStrictEqual(
    tree.root.children,
    [],
    "v0.7.1/R2: a Type-typed local's .newInstance() call must not fabricate a false edge -- incl. a spurious SELF-referential cyclic edge -- via rule 7's unique-name fallback (denylist must gate on declared TYPE, not identifier text)"
  );
}

// ---- v0.7.1/R3: collection-accessor poisoning ------------------------------
// VALIDATION-REPORT.md Tier-2 #4: a Map/List/Set builtin accessor call
// (`.get`/`.put`/`.add`/...) on a collection-typed (or otherwise unresolved)
// receiver must never reach rule 7's unique-name fallback, even when
// exactly one unrelated method of that name happens to exist elsewhere in
// the workspace. Pins the KappaUnitOfWork.cls:20/25 shape
// (newRecordsByType.get(tkey) colliding onto KappaServiceLocator.get).
{
  const G71ServiceLocator = ty('G71ServiceLocator', 'G71ServiceLocator', {
    methods: [mth('get', { line: 1, isStatic: true, params: [{ name: 'key', type: 'String' }] })],
  });
  const G71UnitOfWork = ty('G71UnitOfWork', 'G71UnitOfWork', {
    fields: [{ name: 'byType', type: 'Map<Schema.SObjectType, List<SObject>>', isStatic: false }],
    methods: [
      mth('registerNew', {
        line: 1,
        params: [{ name: 'tkey', type: 'Schema.SObjectType' }],
        calls: [cl('dot', 'get', { receiver: 'byType', argTexts: ['tkey'], line: 2, lineText: 'byType.get(tkey);' })],
      }),
    ],
  });
  const index = buildSemanticIndex([mkFile(G71ServiceLocator), mkFile(G71UnitOfWork)]);
  const tree = buildCallerTree(index, { classLower: 'g71servicelocator', methodLower: 'get' });
  assert.deepStrictEqual(
    tree.root.children,
    [],
    "a known Map.get(...) call is platform behavior: it must neither fabricate an edge nor pollute a user method's unresolved-caller suggestions"
  );
  assert.strictEqual(index.stats.unresolvedSites, 0, 'known collection calls are not unresolved Apex dispatch');
  assert.strictEqual(index.unresolvedSitesByName.has('get'), false);
  assert.strictEqual(index.unresolvedForwardCounts.get('g71unitofwork#registernew') || 0, 0);
}

// Known non-collection platform receivers are equally non-candidates. An
// unresolved receiver with the same method name still remains inspectable.
{
  const PlatformContainsTarget = ty('PlatformContainsTarget', 'PlatformContainsTarget', {
    methods: [mth('contains', { params: [{ name: 'value', type: 'String' }] })],
  });
  const OtherContainsTarget = ty('OtherContainsTarget', 'OtherContainsTarget', {
    methods: [mth('contains', { params: [{ name: 'value', type: 'String' }] })],
  });
  const PlatformAndUnknownCaller = ty('PlatformAndUnknownCaller', 'PlatformAndUnknownCaller', {
    methods: [mth('run', {
      locals: [{ name: 'message', type: 'String', line: 1 }],
      calls: [
        cl('dot', 'contains', { receiver: 'message', argTexts: ["'x'"], line: 2, lineText: "message.contains('x');" }),
        cl('dot', 'contains', { receiver: 'mystery', argTexts: ["'x'"], line: 3, lineText: "mystery.contains('x');" }),
      ],
    })],
  });
  const index = buildSemanticIndex([
    mkFile(PlatformContainsTarget), mkFile(OtherContainsTarget), mkFile(PlatformAndUnknownCaller),
  ]);
  const mentions = index.unresolvedSitesByName.get('contains') || [];
  assert.strictEqual(mentions.length, 1, 'only the genuinely unknown receiver remains a potential caller');
  assert.strictEqual(mentions[0].line, 3);
  assert.strictEqual(index.stats.unresolvedSites, 1);
}

// Class-level caller rollups include method-specific LWC imports plus
// class-level access metadata. Method traces remain exact and do not inherit
// permission/profile grants, which authorize the class rather than call one
// method. Unknown instance-style calls with the same bare name are not
// candidates for a static @AuraEnabled method.
{
  const AccessTarget = ty('AccessTarget', 'AccessTarget', {
    methods: [
      mth('load', { annotations: ['auraenabled'], isStatic: true }),
      mth('save', { annotations: ['auraenabled'], isStatic: true }),
    ],
  });
  const UnrelatedLoadCaller = ty('UnrelatedLoadCaller', 'UnrelatedLoadCaller', {
    methods: [mth('run', {
      calls: [cl('dot', 'load', {
        receiver: 'unknownService', line: 7, lineText: 'unknownService.load();',
      })],
    })],
  });
  const index = buildSemanticIndex([mkFile(AccessTarget), mkFile(UnrelatedLoadCaller)]);
  attachMetaCallers(index, [
    { kind: 'lwc', label: 'acmeAccessPanel', className: 'AccessTarget', methodName: 'load', path: '/ws/lwc/acmeAccessPanel/acmeAccessPanel.js', line: 2, lineText: "import load from '@salesforce/apex/AccessTarget.load';" },
    { kind: 'lwc', label: 'acmeAccessPanel', className: 'AccessTarget', methodName: 'save', path: '/ws/lwc/acmeAccessPanel/acmeAccessPanel.js', line: 3, lineText: "import save from '@salesforce/apex/AccessTarget.save';" },
    { kind: 'permissionset', label: 'Acme_Portal_Access', className: 'AccessTarget', methodName: null, path: '/ws/permissionsets/Acme_Portal_Access.permissionset-meta.xml', line: 4, lineText: '<apexClass>AccessTarget</apexClass>' },
    { kind: 'profile', label: 'Acme_Consultant', className: 'AccessTarget', methodName: null, path: '/ws/profiles/Acme_Consultant.profile-meta.xml', line: 4, lineText: '<apexClass>AccessTarget</apexClass>' },
  ]);

  const methodTree = buildCallerTree(index, { classLower: 'accesstarget', methodLower: 'load' });
  assert.deepStrictEqual(methodTree.root.children.map((n) => n.kind), ['lwc'],
    'static @AuraEnabled trace shows its exact LWC import without unrelated name-only noise');
  assert.strictEqual(methodTree.root.children[0].sites.length, 1);
  assert.strictEqual((index.methodCallers.get('accesstarget#load') || []).length, 0,
    'unknown instance receiver must not attach to a static target through unique-name fallback');
  assert.strictEqual((index.unresolvedSitesByName.get('load') || []).length, 1,
    'the unknown call remains represented in workspace diagnostics');

  const classTree = buildCallerTree(index, { classLower: 'accesstarget', methodLower: null });
  const lwc = classTree.root.children.find((n) => n.kind === 'lwc');
  assert.ok(lwc, 'class-level trace rolls up method-specific LWC imports');
  assert.strictEqual(lwc.sites.length, 2, 'two method imports in one component group into one LWC node with two sites');
  const permissionSet = classTree.root.children.find((n) => n.kind === 'permissionset');
  const profile = classTree.root.children.find((n) => n.kind === 'profile');
  assert.ok(permissionSet && profile, 'class-level access metadata is visible');
  assert.strictEqual(permissionSet.via, 'access');
  assert.strictEqual(profile.via, 'access');
  assert.deepStrictEqual(permissionSet.entries, ['Permission Set Apex access']);
  assert.deepStrictEqual(profile.entries, ['Profile Apex access']);
}

// Static @InvocableMethod entry points have the same exact-metadata rule as
// LWC-facing @AuraEnabled methods. A Flow's bare action name resolves through
// the sole invocable annotation; an unrelated unknown receiver sharing the
// method name is neither a caller edge nor a target-specific suggestion.
{
  const InvocableTarget = ty('InvocableTarget', 'InvocableTarget', {
    methods: [mth('dispatch', {
      annotations: ['invocablemethod'], isStatic: true,
      params: [{ name: 'requests', type: 'List<String>' }],
    })],
  });
  const UnrelatedDispatchCaller = ty('UnrelatedDispatchCaller', 'UnrelatedDispatchCaller', {
    methods: [mth('run', {
      calls: [cl('dot', 'dispatch', {
        receiver: 'unknownRouter', argTexts: ['requests'], line: 8,
        lineText: 'unknownRouter.dispatch(requests);',
      })],
    })],
  });
  const index = buildSemanticIndex([mkFile(InvocableTarget), mkFile(UnrelatedDispatchCaller)]);
  attachMetaCallers(index, [{
    kind: 'flow', label: 'Acme_Action_Flow', className: 'InvocableTarget', methodName: null,
    path: '/ws/flows/Acme_Action_Flow.flow-meta.xml', line: 12,
    lineText: '<actionName>InvocableTarget</actionName>', namespace: null,
    flowObject: null, flowRecordTriggerType: null, flowTriggerType: null, subflows: [],
  }]);

  const tree = buildCallerTree(index, { classLower: 'invocabletarget', methodLower: 'dispatch' });
  assert.deepStrictEqual(tree.root.children.map((n) => n.kind), ['flow'],
    'static @InvocableMethod trace shows its exact Flow action without unrelated name-only noise');
  assert.strictEqual(tree.root.children[0].label, 'Acme_Action_Flow');
  assert.strictEqual(tree.root.children[0].via, 'metadata');
  assert.strictEqual((index.methodCallers.get('invocabletarget#dispatch') || []).length, 0,
    'unknown instance receiver must not attach to a static invocable target');
  assert.strictEqual((index.unresolvedSitesByName.get('dispatch') || []).length, 1,
    'the unrelated unknown site remains represented in workspace diagnostics');
}

// ---- v0.7.1/R4: template-method self-dispatch override fan-out -----------
// VALIDATION-REPORT.md Tier-3 #6: a base class's bare/`this`-qualified
// self-call to its own virtual hook method (the fflib/trigger-handler
// template-method idiom) must ALSO fan out to a subclass override, exactly
// as rule 6's typed dispatch already does -- otherwise a real, reachable
// override method is falsely reported as having no callers. Pins
// KappaTriggerHandler.cls / KappaOrderTriggerHandler.cls.
{
  const G71TriggerHandler = ty('G71TriggerHandler', 'G71TriggerHandler', {
    methods: [
      mth('run', { line: 1, calls: [cl('bare', 'beforeInsert', { line: 2, lineText: 'beforeInsert();' })] }),
      mth('beforeInsert', { line: 3 }), // virtual no-op hook
    ],
  });
  const G71OrderTriggerHandler = ty('G71OrderTriggerHandler', 'G71OrderTriggerHandler', {
    extendsType: 'G71TriggerHandler',
    methods: [mth('beforeInsert', { line: 1 })], // real override
  });
  const index = buildSemanticIndex([mkFile(G71TriggerHandler), mkFile(G71OrderTriggerHandler)]);
  const tree = buildCallerTree(index, { classLower: 'g71ordertriggerhandler', methodLower: 'beforeinsert' });
  const overrideCaller = findChild(tree.root.children, 'G71TriggerHandler.run');
  assert.ok(overrideCaller, 'v0.7.1/R4: a base class\'s bare self-call to its own virtual hook method must fan out to a subclass override -- was "No callers found" pre-fix');
  assert.strictEqual(overrideCaller.via, 'override');
  assert.strictEqual(overrideCaller.approximate, true);
}

// ---- v0.7.1/R5: maxNodes cap honesty ---------------------------------------
// VALIDATION-REPORT.md Tier-3 #5: the specific node whose expansion the
// maxNodes cap cut off must be stamped truncated=true, mirroring the
// existing depth-cap pattern -- otherwise a node with real further
// callers/callees renders identically to a genuine zero-children leaf.
// Pins the VertexBoltHub.dispatch (60 callers, maxNodes:20) shape at a
// tractable scale (5 callers, maxNodes:3).
{
  const G71FanTarget = ty('G71FanTarget', 'G71FanTarget', { methods: [mth('hit', { line: 1 })] });
  const fanFiles = [mkFile(G71FanTarget)];
  for (let i = 1; i <= 5; i++) {
    fanFiles.push(mkFile(ty(`G71FanCaller${i}`, `G71FanCaller${i}`, {
      methods: [mth('go', { line: 1, calls: [cl('dot', 'hit', { receiver: 'G71FanTarget', line: 2, lineText: 'G71FanTarget.hit();' })] })],
    })));
  }
  const index = buildSemanticIndex(fanFiles);
  const tree = buildCallerTree(index, { classLower: 'g71fantarget', methodLower: 'hit' }, { maxNodes: 3 });
  assert.strictEqual(tree.stats.capped, true, 'v0.7.1/R5: 5 real callers vs maxNodes:3 must trip the cap');
  assert.strictEqual(
    tree.root.truncated,
    true,
    'v0.7.1/R5: the SPECIFIC node whose children the cap cut off (root, here) must be stamped truncated=true -- was silently left unmarked pre-fix, indistinguishable from a genuine zero-caller leaf (the false "◉ root" signal)'
  );
  assert.ok(tree.root.children.length < 5, 'v0.7.1/R5: fewer than all 5 real callers were actually materialized -- the cap genuinely fired');

  // Callee direction: same guarantee via buildCalleeTree (the report's own
  // "reproduces identically in both buildCallerTree and buildCalleeTree").
  // buildChildrenLevel/buildOneChildNode are direction-agnostic shared code,
  // so a single-method, 5-callee fan-OUT fixture exercises the identical cap
  // logic from the other direction.
  const G71FanOutSource = ty('G71FanOutSource', 'G71FanOutSource', {
    methods: [mth('runAll', {
      line: 1,
      calls: [1, 2, 3, 4, 5].map((i) => cl('dot', `stepFn${i}`, { receiver: 'G71FanOutSource', line: i + 1, lineText: `stepFn${i}();` })),
    })].concat([1, 2, 3, 4, 5].map((i) => mth(`stepFn${i}`, { line: i + 1 }))),
  });
  const calleeIndex = buildSemanticIndex([mkFile(G71FanOutSource)]);
  const calleeTree = buildCalleeTree(calleeIndex, { classLower: 'g71fanoutsource', methodLower: 'runall' }, { maxNodes: 3 });
  assert.strictEqual(calleeTree.stats.capped, true, 'v0.7.1/R5 (callees): 5 real callees vs maxNodes:3 must trip the cap');
  assert.strictEqual(
    calleeTree.root.truncated,
    true,
    'v0.7.1/R5 (callees): the SPECIFIC node whose children the cap cut off (root, here) must be stamped truncated=true, same as the caller direction'
  );
}

// ---- v0.7.1/R6: forward unresolved-count parity ----------------------------
// VALIDATION-REPORT.md fix backlog #8: a denylisted-receiver call
// (`Database.getQueryLocator(...)`) must be excluded from the FORWARD
// unresolved-site count exactly like the backward-direction stat already
// excludes it -- a deliberate, known exclusion, not a "dropped" site. Pins
// VertexRepriceBatch.start() (SOQL-only, no Apex callee).
{
  const G71DenylistOnly = ty('G71DenylistOnly', 'G71DenylistOnly', {
    methods: [
      mth('start', {
        line: 1,
        calls: [cl('dot', 'getQueryLocator', { receiver: 'Database', argTexts: ['[SELECT Id FROM Account]'], line: 2, lineText: 'return Database.getQueryLocator([SELECT Id FROM Account]);' })],
      }),
    ],
  });
  const index = buildSemanticIndex([mkFile(G71DenylistOnly)]);
  const tree = buildCalleeTree(index, { classLower: 'g71denylistonly', methodLower: 'start' });
  assert.deepStrictEqual(tree.root.children, [], 'v0.7.1/R6: a denylisted-receiver-only method must show ZERO unresolved forward sites, matching the backward-direction H4 exclusion');
  assert.strictEqual(tree.note, 'This method makes no traceable outbound calls.');
}

// ---- v0.7.1/R8: generic-typed DML honest marker ----------------------------
// VALIDATION-REPORT.md fix backlog #10: a DML statement whose target
// reduces to the generic `SObject` placeholder (object identity erased
// through a `List<SObject>`-typed collection) must surface an honest "DML
// on unresolved SObject type" leaf instead of silently vanishing with zero
// callee edges AND zero unresolved marker. Pins KappaUnitOfWork.commitWork().
{
  const G71GenericUow = ty('G71GenericUow', 'G71GenericUow', {
    fields: [{ name: 'records', type: 'List<SObject>', isStatic: false }],
    methods: [
      mth('commitWork', {
        line: 1,
        dml: [dmlFact('insert', 'records', { line: 2, lineText: 'insert records;' })],
      }),
    ],
  });
  const index = buildSemanticIndex([mkFile(G71GenericUow)]);
  const tree = buildCalleeTree(index, { classLower: 'g71genericuow', methodLower: 'commitwork' });
  const marker = findChild(tree.root.children, 'DML on unresolved SObject type');
  assert.ok(marker, 'v0.7.1/R8: a generic List<SObject>-typed DML target must surface an honest "DML on unresolved SObject type" leaf instead of silently vanishing');
  assert.strictEqual(marker.kind, 'unresolved');
  assert.strictEqual(marker.via, 'dml-unresolved');
  assert.strictEqual(marker.approximate, true);
  assert.strictEqual(marker.truncated, true);
}

// =========================================================================
// v0.8: namespace/managed-package MODELING (N1(a)(b), N2, N3 resolver half
// -- opts.ownNamespace, N4, N5). Fixtures below mirror gauntlet-org's actual
// v0.8 corpus probes (GROUND-TRUTH.md's v0.8-A/v0.8-B sections) shape-for-
// shape, under fresh V8-prefixed names, so this suite pins the exact same
// scenarios the corpus exercises without depending on reading real files.
// =========================================================================

// ---- N1(a)/N2: KappaGatewayCaller-shape probes (case-fold dedup, cross-
// namespace distinctness, typo negative control) -----------------------
{
  const V8KappaGateway = ty('V8KappaGateway', 'V8KappaGateway', {
    methods: [mth('dispatch', { line: 1, params: [{ name: 'cmd', type: 'String' }] })],
  });
  const V8KappaGatewayCaller = ty('V8KappaGatewayCaller', 'V8KappaGatewayCaller', {
    methods: [
      mth('routeCommands', {
        line: 1,
        calls: [
          cl('dot', 'dispatch', { receiver: 'zenq.V8KappaGateway', argTexts: ['cmd'], line: 3, lineText: 'zenq.V8KappaGateway.dispatch(cmd);' }),
          // case-varied (Apex identifiers are case-insensitive) -- must
          // attach to the SAME external node as the site above.
          cl('dot', 'DISPATCH', { receiver: 'ZENQ.v8kappagateway', argTexts: ['cmd'], line: 9, lineText: 'ZENQ.v8kappagateway.DISPATCH(cmd);' }),
          // different namespace, same class simple name -> DISTINCT node.
          cl('dot', 'dispatch', { receiver: 'kwx.V8KappaGateway', argTexts: ['cmd'], line: 16, lineText: 'kwx.V8KappaGateway.dispatch(cmd);' }),
          // typo'd class name (negative control) -> its OWN, separate node.
          cl('dot', 'dispatch', { receiver: 'zenq.V8KappaGatewey', argTexts: ['cmd'], line: 21, lineText: 'zenq.V8KappaGatewey.dispatch(cmd);' }),
        ],
      }),
    ],
  });
  const index = buildSemanticIndex([mkFile(V8KappaGateway), mkFile(V8KappaGatewayCaller)]);

  const zenqKg = index.externals.get('zenq.v8kappagateway');
  assert.ok(zenqKg, 'v0.8/N1(a): zenq.V8KappaGateway.dispatch(cmd) creates an external node');
  assert.strictEqual(zenqKg.refCount, 2, 'v0.8/N1(a): case-varied call sites (zenq.V8KappaGateway vs ZENQ.v8kappagateway) attach to ONE external node, not two -- the index key is case-folded exactly like every other lookup');
  assert.strictEqual(zenqKg.label, 'zenq.V8KappaGateway', 'first-observation-wins label casing');
  assert.deepStrictEqual([...zenqKg.methods], ['dispatch']);

  const kwxKg = index.externals.get('kwx.v8kappagateway');
  assert.ok(kwxKg, 'v0.8/N1(a): a DIFFERENT namespace (kwx), same class simple name as zenq.V8KappaGateway');
  assert.notStrictEqual(zenqKg, kwxKg, 'external-node identity is the (namespace, class) pair, not the class name alone');
  assert.strictEqual(kwxKg.refCount, 1);

  const typoKg = index.externals.get('zenq.v8kappagatewey');
  assert.ok(typoKg, "v0.8/N2 step 3: a 1-letter-typo'd class name still fires namespace precedence verbatim -- the engine has no knowledge it's a typo");
  assert.notStrictEqual(typoKg, zenqKg, 'must stay a SEPARATE node from zenq.V8KappaGateway -- same namespace, different class text');
  assert.strictEqual(typoKg.refCount, 1);

  assert.strictEqual(index.externals.size, 3, 'exactly 3 distinct external nodes for this file (zenq.V8KappaGateway, kwx.V8KappaGateway, zenq.V8KappaGatewey)');
  assert.strictEqual(index.stats.unresolvedSites, 0, 'v0.8/N5: none of the 4 sites are counted as unresolved -- all 4 are now external refs');
  assert.strictEqual(index.stats.externalRefs, 4);
  assert.deepStrictEqual(index.stats.externalNamespaces, ['kwx', 'zenq'], 'v0.8/N5: sorted, deduped namespace list');

  // None of the four sites may ever attach to the local V8KappaGateway.dispatch
  // caller tree -- unchanged v0.7.1 invariant, still true post-v0.8.
  const localTree = buildCallerTree(index, { classLower: 'v8kappagateway', methodLower: 'dispatch' });
  assert.deepStrictEqual(localTree.root.children, [], 'v0.8/N2: none of the 4 namespaced sites may ever land on the local V8KappaGateway.dispatch');

  // v0.8/N4: caller-direction trace of the external shows the local
  // referencing method, grouped (both L3 and L9 sites under ONE node).
  const extTree = buildCallerTree(index, { classLower: 'zenq.v8kappagateway', methodLower: null });
  assert.strictEqual(extTree.root.kind, 'external');
  assert.strictEqual(extTree.root.label, 'zenq.V8KappaGateway');
  assert.strictEqual(extTree.root.ns, 'zenq');
  const routeCommandsCaller = findChild(extTree.root.children, 'V8KappaGatewayCaller.routeCommands');
  assert.ok(routeCommandsCaller, 'v0.8/N4: V8KappaGatewayCaller.routeCommands is a caller of the external zenq.V8KappaGateway node');
  assert.strictEqual(routeCommandsCaller.sites.length, 2, 'v0.8/N1(a): ONE node, TWO site rows (L3 + L9) -- not two nodes');
  assert.strictEqual(routeCommandsCaller.via, 'external');
  assert.strictEqual(routeCommandsCaller.approximate, false);
}

// ---- N2 step 3: inner-class tail-collision negative controls -----------
// (BoltRelayCaller/BeaconCaller-shape) -- tail-matching plays no role in
// the 3-segment precedence chain; N2 only ever consults HEAD.
{
  const V8BoltContainer = ty('V8BoltContainer', 'V8BoltContainer', { methods: [] });
  const V8BoltRelayInner = ty('Relay', 'V8BoltContainer.Relay', { methods: [mth('fire', { line: 1 })] });
  const V8BoltContainerFile = file(P('V8BoltContainer'), 'class', [V8BoltContainer, V8BoltRelayInner]);
  const V8BoltRelayCaller = ty('V8BoltRelayCaller', 'V8BoltRelayCaller', {
    methods: [mth('trigger', { line: 1, calls: [cl('dot', 'fire', { receiver: 'zenq.Relay', line: 3, lineText: 'zenq.Relay.fire();' })] })],
  });
  const index = buildSemanticIndex([V8BoltContainerFile, mkFile(V8BoltRelayCaller)]);
  const ext = index.externals.get('zenq.relay');
  assert.ok(ext, 'v0.8/N2 step 3: zenq.Relay.fire() becomes external even though "Relay" uniquely matches a LOCAL inner class workspace-wide -- inner-class tail-matching is not consulted, only HEAD ("zenq")');
  const localTree = buildCallerTree(index, { classLower: 'v8boltcontainer.relay', methodLower: 'fire' });
  assert.deepStrictEqual(localTree.root.children, [], 'must NOT land on V8BoltContainer.Relay.fire');
}
{
  const V8KappaContainerA = ty('V8KappaContainerA', 'V8KappaContainerA', { methods: [] });
  const V8BeaconA = ty('Beacon', 'V8KappaContainerA.Beacon', { methods: [mth('signal', { line: 1 })] });
  const V8KappaContainerAFile = file(P('V8KappaContainerA'), 'class', [V8KappaContainerA, V8BeaconA]);
  const V8KappaContainerB = ty('V8KappaContainerB', 'V8KappaContainerB', { methods: [] });
  const V8BeaconB = ty('Beacon', 'V8KappaContainerB.Beacon', { methods: [mth('signal', { line: 1 })] });
  const V8KappaContainerBFile = file(P('V8KappaContainerB'), 'class', [V8KappaContainerB, V8BeaconB]);
  const V8BeaconCaller = ty('V8BeaconCaller', 'V8BeaconCaller', {
    methods: [mth('ping', { line: 1, calls: [cl('dot', 'signal', { receiver: 'zenq.Beacon', line: 3, lineText: 'zenq.Beacon.signal();' })] })],
  });
  const index = buildSemanticIndex([V8KappaContainerAFile, V8KappaContainerBFile, mkFile(V8BeaconCaller)]);
  const ext = index.externals.get('zenq.beacon');
  assert.ok(
    ext,
    'v0.8/N2 step 3: zenq.Beacon.signal() becomes a CONFIDENT external edge -- the local N=2 inner-class ambiguity (KappaContainerA.Beacon / KappaContainerB.Beacon) is irrelevant since HEAD="zenq" already fails local-class resolution at step 2, before any inner-class tail-matching would even be attempted (this is the one promoted probe where the REASON changes: old = correctly-declined ambiguity, new = confident external resolution)'
  );
  assert.strictEqual(index.stats.unresolvedSites, 0);
}

// ---- N1(a)/N2 step 3: cross-namespace distinctness (minimal, single-
// purpose version of the KappaGatewayCaller shape above) ------------------
{
  const V8NamespaceDistinctGatewayCaller = ty('V8NamespaceDistinctGatewayCaller', 'V8NamespaceDistinctGatewayCaller', {
    methods: [
      mth('openBoth', {
        line: 2,
        calls: [
          cl('dot', 'open', { receiver: 'zenq.V8Gateway', line: 3, lineText: 'zenq.V8Gateway.open();' }),
          cl('dot', 'open', { receiver: 'kwx.V8Gateway', line: 10, lineText: 'kwx.V8Gateway.open();' }),
        ],
      }),
    ],
  });
  const index = buildSemanticIndex([mkFile(V8NamespaceDistinctGatewayCaller)]);
  const zenqGw = index.externals.get('zenq.v8gateway');
  const kwxGw = index.externals.get('kwx.v8gateway');
  assert.ok(zenqGw && kwxGw);
  assert.notStrictEqual(zenqGw, kwxGw, 'v0.8/N1(a): same class simple name (V8Gateway), different namespace -> two DISTINCT external nodes, never merged');
  assert.strictEqual(index.externals.size, 2);
}

// ---- N2 precedence traps: local class named like a namespace token ------
// (ZenqLocalPrecedenceCaller-shape) -- WITH a real member wins locally;
// WITHOUT one, namespace wins and no false local edge is fabricated.
{
  const V8ZenqLedger = ty('Ledger', 'v8zenq.Ledger', {
    methods: [mth('post', { line: 1, isStatic: true, params: [{ name: 'amount', type: 'Decimal' }] })],
  });
  const V8Zenq = ty('v8zenq', 'v8zenq', { methods: [] });
  const V8ZenqFile = file(P('V8Zenq'), 'class', [V8Zenq, V8ZenqLedger]);
  const V8ZenqLocalPrecedenceCaller = ty('V8ZenqLocalPrecedenceCaller', 'V8ZenqLocalPrecedenceCaller', {
    methods: [
      mth('callWithLocalMember', {
        line: 2,
        calls: [cl('dot', 'post', { receiver: 'v8zenq.Ledger', argTexts: ['amount'], line: 3, lineText: 'v8zenq.Ledger.post(amount);' })],
      }),
      mth('callWithoutLocalMember', {
        line: 10,
        calls: [cl('dot', 'emit', { receiver: 'v8zenq.Signal', argTexts: ['cmd'], line: 11, lineText: 'v8zenq.Signal.emit(cmd);' })],
      }),
    ],
  });
  const index = buildSemanticIndex([V8ZenqFile, mkFile(V8ZenqLocalPrecedenceCaller)]);

  const ledgerTree = buildCallerTree(index, { classLower: 'v8zenq.ledger', methodLower: 'post' });
  assert.ok(
    findChild(ledgerTree.root.children, 'V8ZenqLocalPrecedenceCaller.callWithLocalMember'),
    'v0.8/N2 step 2: HEAD resolves to a GENUINE local top-level class ("v8zenq") AND Mid ("Ledger") resolves on it as a real inner class -- local-class-chain resolution wins outright'
  );

  const sigExt = index.externals.get('v8zenq.signal');
  assert.ok(sigExt, 'v0.8/N2 step 3: v8zenq.Signal.emit(cmd) -- HEAD resolves to the local class but Mid ("Signal") does NOT resolve on it -- step 2 fails cleanly and falls through to step 3');
  assert.strictEqual(sigExt.label, 'v8zenq.Signal');
  assert.deepStrictEqual([...sigExt.methods], ['emit']);
  assert.strictEqual(index.externals.size, 1, 'exactly one external (v8zenq.Signal) -- v8zenq.Ledger.post must NOT ALSO create one, per the local-member leg above');
}

// ---- N2's 2-segment carve-out: Head.method() NEVER creates an external --
// (TwoSegmentUnknownCaller-shape)
{
  // A 2-segment call's receiver is a SINGLE identifier (no dot).
  const V8TwoSegmentUnknownCaller = ty('V8TwoSegmentUnknownCaller', 'V8TwoSegmentUnknownCaller', {
    methods: [
      mth('callUnknownTwoSegment', {
        line: 2,
        calls: [cl('dot', 'doThing', { receiver: 'V8UnknownPkg', line: 3, lineText: 'V8UnknownPkg.doThing();' })],
      }),
    ],
  });
  const index = buildSemanticIndex([mkFile(V8TwoSegmentUnknownCaller)]);
  assert.strictEqual(index.externals.size, 0, 'v0.8/N2: a 2-segment call (Head.method(), no Mid) NEVER creates an external, regardless of how "namespace-like" Head looks -- ambiguous with an ordinary unresolved local reference');
  assert.strictEqual(index.stats.unresolvedSites, 1, 'stays unresolved -- the pre-existing, non-namespace-promoted outcome for this shape');
  assert.strictEqual(index.stats.externalRefs, 0);
}

// ---- N1(b)/N4: DML/publish managed-object externals ---------------------
// (VertexLedgerBridge C5:13-shape) -- zero trigger targets preserved.
{
  const V8LedgerBridge = ty('V8LedgerBridge', 'V8LedgerBridge', {
    methods: [
      mth('postToLedger', {
        line: 1,
        dml: [dmlFact('insert', "new kwx__Ledger__c(Amount__c = amount)", { line: 13, lineText: 'insert new kwx__Ledger__c(Amount__c = amount);' })],
      }),
    ],
  });
  const index = buildSemanticIndex([mkFile(V8LedgerBridge)]);
  const ext = index.externals.get('kwx.ledger__c');
  assert.ok(ext, 'v0.8/N1(b): insert new kwx__Ledger__c(...) creates a managed-OBJECT external node');
  assert.strictEqual(ext.ns, 'kwx');
  assert.strictEqual(ext.className, 'Ledger__c');
  assert.strictEqual(ext.label, 'kwx__Ledger__c', 'v0.8/N1(b): label uses the underscore convention for a namespaced OBJECT reference, not the dot convention a namespaced CLASS/method reference gets');
  assert.strictEqual(ext.refCount, 1);
  assert.deepStrictEqual([...ext.methods], [], 'a DML object external has no "method" concept -- methods stays the empty Set');
  assert.strictEqual(index.stats.externalNamespaces.includes('kwx'), true);

  // Zero trigger targets -- no local trigger is declared on kwx__Ledger__c
  // anywhere in this fixture -- the external node's existence must not
  // fabricate a trigger fan-out that isn't really there.
  const tree = buildCallerTree(index, { classLower: 'v8ledgerbridge', methodLower: 'posttoledger' });
  assert.deepStrictEqual(tree.root.children, [], 'zero trigger fan-out for kwx__Ledger__c (no trigger declared on it)');

  // v0.8/N4: the external IS a valid caller-direction trace target too,
  // even though it originated from a DML site (not an Apex call).
  const extTree = buildCallerTree(index, { classLower: 'kwx.ledger__c', methodLower: null });
  assert.strictEqual(extTree.root.kind, 'external');
  assert.strictEqual(extTree.root.label, 'kwx__Ledger__c');
  assert.ok(findChild(extTree.root.children, 'V8LedgerBridge.postToLedger'));
}

// ---- N4: local trigger ON a managed object links exactly like a local
// object (VtxKwxInvoiceService/VtxKwxInvoiceTrigger-shape, requirement 2b) --
{
  const V8InvoiceService = ty('V8KwxInvoiceService', 'V8KwxInvoiceService', {
    methods: [
      mth('postInvoice', {
        line: 1,
        dml: [dmlFact('insert', "new kwx__V8Invoice__c(Amount__c = amount)", { line: 3, lineText: 'insert new kwx__V8Invoice__c(Amount__c = amount);' })],
      }),
    ],
  });
  const V8InvoiceTriggerType = ty('V8KwxInvoiceTrigger', 'V8KwxInvoiceTrigger', { methods: [mth('(trigger)', { line: 1 })] });
  const V8InvoiceTriggerFile = file(PT('V8KwxInvoiceTrigger'), 'trigger', [V8InvoiceTriggerType], {
    triggerInfo: { object: 'kwx__V8Invoice__c', events: ['before insert'] },
  });
  const index = buildSemanticIndex([mkFile(V8InvoiceService), V8InvoiceTriggerFile]);

  // The external OBJECT node still gets created (N1(b), independent
  // mechanism)...
  const ext = index.externals.get('kwx.v8invoice__c');
  assert.ok(ext);
  assert.strictEqual(ext.label, 'kwx__V8Invoice__c');

  // ...AND the DML fans out to the LOCAL trigger declared on it, exactly
  // like it would for any local object (N4: "event matching unchanged") --
  // traced from the TRIGGER's own side ("who calls V8KwxInvoiceTrigger"),
  // since the DML site is the CALLER here, not the target.
  const trigTree = buildCallerTree(index, { classLower: 'v8kwxinvoicetrigger', methodLower: null });
  const dmlCaller = findChild(trigTree.root.children, 'V8KwxInvoiceService.postInvoice');
  assert.ok(dmlCaller, 'v0.8/N4: DML on kwx__V8Invoice__c fans out to the LOCAL trigger declared on it exactly like V4OrderTrigger/KappaOrderTrigger do for their own objects');
  assert.strictEqual(dmlCaller.via, 'dml');
  assert.strictEqual(dmlCaller.kind, 'method');
}

// ---- N3 (resolver half, opts.ownNamespace): own-namespace resolves
// LOCALLY, no external node (VtxOwnNamespaceProbe-shape) -------------------
{
  const V8OwnPricingService = ty('V8OwnPricingService', 'V8OwnPricingService', {
    methods: [mth('repriceOrder', { line: 1, params: [{ name: 'order', type: 'Object' }] })],
  });
  const V8OwnNamespaceProbe = ty('V8OwnNamespaceProbe', 'V8OwnNamespaceProbe', {
    methods: [
      mth('callOwnNamespaceClass', {
        line: 2,
        calls: [cl('dot', 'repriceOrder', { receiver: 'vtx.V8OwnPricingService', argTexts: ['order'], line: 3, lineText: 'vtx.V8OwnPricingService.repriceOrder(order);' })],
      }),
      mth('dmlOwnNamespaceObjectBareForm', {
        line: 6,
        dml: [dmlFact('insert', "new V8OwnConfig__c(Name = 'bare-form')", { line: 7, lineText: "insert new V8OwnConfig__c(Name = 'bare-form');" })],
      }),
      mth('dmlOwnNamespaceObjectPrefixedForm', {
        line: 10,
        dml: [dmlFact('insert', "new vtx__V8OwnConfig__c(Name = 'prefixed-form')", { line: 11, lineText: "insert new vtx__V8OwnConfig__c(Name = 'prefixed-form');" })],
      }),
    ],
  });
  const index = buildSemanticIndex([mkFile(V8OwnPricingService), mkFile(V8OwnNamespaceProbe)], { ownNamespace: 'vtx' });

  // L3: own-namespace class call resolves LOCALLY (edge -> local class,
  // via='static'), no external.
  const tree = buildCallerTree(index, { classLower: 'v8ownpricingservice', methodLower: 'repriceorder' });
  const caller = findChild(tree.root.children, 'V8OwnNamespaceProbe.callOwnNamespaceClass');
  assert.ok(caller, "v0.8/N3: vtx.V8OwnPricingService.repriceOrder(...) resolves to the LOCAL class after own-namespace stripping -- 'vtx' is never treated as a namespace token because it IS the workspace's own declared namespace");
  assert.strictEqual(caller.via, 'static');

  // L7/L11: bare and vtx__-prefixed DML both land on the SAME local object
  // identity, not two different objects.
  assert.strictEqual((index.dmlSitesByObject.get('v8ownconfig__c') || []).length, 2, 'v0.8/N3: bare V8OwnConfig__c and vtx__V8OwnConfig__c collapse onto the SAME object identity');

  // Positive control for the whole fixture: no external node anywhere,
  // and the own-namespace token itself must never appear as an external's
  // namespace.
  assert.strictEqual(index.externals.size, 0, 'v0.8/N3: a live run that creates an external node for vtx.* / vtx__* is a BUG');
  assert.strictEqual(index.stats.externalRefs, 0);
  assert.deepStrictEqual(index.stats.externalNamespaces, []);
}

// ---- N3 (bonus symmetry check): a trigger declared directly on an
// own-namespace-prefixed object registers under the SAME stripped identity
// a bare-form DML resolves to. Not directly required by any gauntlet-org
// v0.8-B fixture (which deliberately never pairs vtx__ with a trigger), but
// a natural extension of N3's "in Apex receivers, DML object names, and
// metascan refs" text -- pinned here as its own small, isolated check.
{
  const V8VtxFooService = ty('V8VtxFooService', 'V8VtxFooService', {
    methods: [mth('doIt', { line: 1, dml: [dmlFact('insert', 'new V8Foo__c()', { line: 2, lineText: 'insert new V8Foo__c();' })] })],
  });
  const V8VtxFooTriggerType = ty('V8VtxFooTrigger', 'V8VtxFooTrigger', { methods: [mth('(trigger)', { line: 1 })] });
  const V8VtxFooTriggerFile = file(PT('V8VtxFooTrigger'), 'trigger', [V8VtxFooTriggerType], {
    triggerInfo: { object: 'vtx__V8Foo__c', events: ['before insert'] },
  });
  const index = buildSemanticIndex([mkFile(V8VtxFooService), V8VtxFooTriggerFile], { ownNamespace: 'vtx' });
  const trigTree = buildCallerTree(index, { classLower: 'v8vtxfootrigger', methodLower: null });
  const dmlCaller = findChild(trigTree.root.children, 'V8VtxFooService.doIt');
  assert.ok(dmlCaller, 'v0.8/N3 (bonus): a trigger declared on the own-namespace-prefixed vtx__V8Foo__c registers under the SAME stripped object identity as a bare V8Foo__c DML');
  assert.strictEqual(index.externals.size, 0);
}

// ---- N4: external nodes are TERMINAL in the callees direction -----------
{
  const V8CalleeDirCaller = ty('V8CalleeDirCaller', 'V8CalleeDirCaller', {
    methods: [
      mth('run', {
        line: 1,
        calls: [cl('dot', 'charge', { receiver: 'zenq.V8CalleeBilling', argTexts: ['amount'], line: 2, lineText: 'zenq.V8CalleeBilling.charge(amount);' })],
        dml: [dmlFact('insert', 'new kwx__V8CalleeLedger__c()', { line: 3, lineText: 'insert new kwx__V8CalleeLedger__c();' })],
      }),
    ],
  });
  const index = buildSemanticIndex([mkFile(V8CalleeDirCaller)]);
  const tree = buildCalleeTree(index, { classLower: 'v8calleedircaller', methodLower: 'run' });

  const extCallChild = tree.root.children.find((c) => c.kind === 'external' && c.label === 'zenq.V8CalleeBilling');
  assert.ok(extCallChild, 'v0.8/N4: an external Apex call surfaces as a TERMINAL kind:external child in the callees direction');
  assert.strictEqual(extCallChild.children.length, 0, 'terminal -- no children');
  assert.strictEqual(extCallChild.truncated, true, 'permanently terminal -- no source to recurse into (same convention buildOneChildNode\'s exception branch uses)');
  assert.strictEqual(extCallChild.approximate, false, "v0.8/N2: NOT approximate -- a genuine namespace match is exact, not a guess");
  assert.strictEqual(extCallChild.ns, 'zenq');
  assert.strictEqual(extCallChild.sites.length, 1);

  const extDmlChild = tree.root.children.find((c) => c.kind === 'external' && c.label === 'kwx__V8CalleeLedger__c');
  assert.ok(extDmlChild, 'v0.8/N4: a namespaced DML object ALSO surfaces as a TERMINAL kind:external child in the callees direction');
  assert.strictEqual(extDmlChild.ns, 'kwx');
  assert.strictEqual(extDmlChild.truncated, true);

  assert.strictEqual(tree.stats.externalRefs, 2);
  assert.deepStrictEqual(tree.stats.externalNamespaces, ['kwx', 'zenq']);
}

// ---- N4: suggestTargets includes externals, bare label, kind:'external' -
{
  const V8SuggestCaller = ty('V8SuggestCaller', 'V8SuggestCaller', {
    methods: [mth('run', { line: 1, calls: [cl('dot', 'charge', { receiver: 'zenq.V8SuggestBilling', line: 2, lineText: 'zenq.V8SuggestBilling.charge();' })] })],
  });
  const index = buildSemanticIndex([mkFile(V8SuggestCaller)]);
  const targets = suggestTargets(index);
  const extItem = targets.find((t) => t.classLower === 'zenq.v8suggestbilling');
  assert.ok(extItem, 'v0.8/N4: suggestTargets includes an item for the external node');
  assert.strictEqual(extItem.label, 'zenq.V8SuggestBilling', "bare label -- the ' (managed)' suffix is targets.js's refineTargets() job, not resolver.js's (see targets.js's own N4/N6 header note)");
  assert.strictEqual(extItem.kind, 'external');
  assert.strictEqual(extItem.methodLower, null);
  assert.ok(!Object.prototype.hasOwnProperty.call(extItem, 'package'), 'an external item never carries a package field');
}

// =========================================================================
// N1(c): metascan-sourced externals (attachMetaCallers) -- LWC (explicit
// ref.namespace, M1), Flow dotted-fold, Flow/CMDT bare double-underscore
// fold, cross-surface consistency (Apex + LWC + Flow all landing on ONE
// external node), and own-namespace metascan stripping.
// =========================================================================

// ---- LWC: explicit ref.namespace (M1) -> external, no longer metaUnresolved
{
  const V8KappaGatewayLwc = ty('V8KappaGatewayLwc', 'V8KappaGatewayLwc', {
    methods: [mth('dispatch', { line: 1 })],
  });
  const index = buildSemanticIndex([mkFile(V8KappaGatewayLwc)]);
  const metaRefs = [
    {
      kind: 'lwc',
      label: 'v8kappaGatewayPanel',
      className: 'V8KappaGatewayLwc',
      methodName: 'dispatch',
      namespace: 'zenq',
      path: 'lwc/v8kappaGatewayPanel/v8kappaGatewayPanel.js',
      line: 11,
      lineText: "import dispatch from '@salesforce/apex/zenq.V8KappaGatewayLwc.dispatch';",
    },
  ];
  attachMetaCallers(index, metaRefs);
  const ext = index.externals.get('zenq.v8kappagatewaylwc');
  assert.ok(ext, 'v0.8/N1(c): an LWC ref carrying a namespace attaches to an external node instead of metaUnresolved');
  assert.strictEqual(ext.label, 'zenq.V8KappaGatewayLwc');
  assert.deepStrictEqual([...ext.methods], ['dispatch']);
  assert.strictEqual(index.stats.metaUnresolved, 0, 'v0.8/N5: metaUnresolved for a namespaced ref becomes an external attach instead');
  assert.strictEqual(index.stats.externalRefs, 1);

  // Must still NOT attach to the local V8KappaGatewayLwc.dispatch.
  const localTree = buildCallerTree(index, { classLower: 'v8kappagatewaylwc', methodLower: 'dispatch' });
  assert.deepStrictEqual(localTree.root.children, []);

  // v0.8/N4: the LWC ref renders as a TERMINAL child under the external's
  // own caller-direction trace (kind:'lwc', same as buildMetaChildren
  // renders anywhere else).
  const extTree = buildCallerTree(index, { classLower: 'zenq.v8kappagatewaylwc', methodLower: null });
  const lwcChild = extTree.root.children.find((c) => c.kind === 'lwc');
  assert.ok(lwcChild, 'v0.8/N4: the LWC import is a TERMINAL caller of the external node');
  assert.strictEqual(lwcChild.label, 'v8kappaGatewayPanel');
}

// ---- Flow: dotted fold-in ('ns.Class.method' folded by metascan.js into
// className='ns', methodName='Class.method') -> external, cross-checked
// against the SAME Apex-sourced external node (A5/B5 cross-surface
// consistency: one external node, multiple referencing surfaces).
{
  const V8KappaGatewayCaller2 = ty('V8KappaGatewayCaller2', 'V8KappaGatewayCaller2', {
    methods: [
      mth('routeCommands', {
        line: 1,
        calls: [cl('dot', 'dispatch', { receiver: 'zenq.V8FlowKappaGateway', argTexts: ['cmd'], line: 3, lineText: 'zenq.V8FlowKappaGateway.dispatch(cmd);' })],
      }),
    ],
  });
  const index = buildSemanticIndex([mkFile(V8KappaGatewayCaller2)]);
  // metascan.js's real (frozen) flow extraction naively splits the dotted
  // actionName into { className: segs[0], methodName: segs.slice(1).join('.') }
  // -- 'zenq.V8FlowKappaGateway.dispatch' -> { className:'zenq',
  // methodName:'V8FlowKappaGateway.dispatch' }, exactly reproduced here.
  const metaRefs = [
    {
      kind: 'flow',
      label: 'V8NamespaceProbeFlow',
      className: 'zenq',
      methodName: 'V8FlowKappaGateway.dispatch',
      path: 'flows/V8NamespaceProbeFlow.flow-meta.xml',
      line: 22,
      lineText: '<actionName>zenq.V8FlowKappaGateway.dispatch</actionName>',
      flowObject: null,
      flowRecordTriggerType: null,
      flowTriggerType: null,
    },
  ];
  attachMetaCallers(index, metaRefs);
  const key = 'zenq.v8flowkappagateway';
  const ext = index.externals.get(key);
  assert.ok(ext, "v0.8/N1(c): a Flow actionName's dotted fold-in (className='zenq', methodName='V8FlowKappaGateway.dispatch') is detected and split into ns='zenq', class='V8FlowKappaGateway', method='dispatch'");
  assert.strictEqual(ext.label, 'zenq.V8FlowKappaGateway');
  assert.deepStrictEqual([...ext.methods], ['dispatch']);

  // Same external node the Apex call site attaches to -- cross-surface
  // consistency, one node not two.
  assert.strictEqual(ext.refCount, 2, 'v0.8/N1(c): the Apex call site (from buildSemanticIndex) AND the Flow ref (from attachMetaCallers) BOTH attach to the SAME external node');

  const extTree = buildCallerTree(index, { classLower: key, methodLower: null });
  assert.ok(findChild(extTree.root.children, 'V8KappaGatewayCaller2.routeCommands'), 'the Apex caller is present');
  assert.ok(extTree.root.children.some((c) => c.kind === 'flow'), 'the Flow ref is ALSO present, as a sibling terminal child');
}

// ---- Flow + CMDT: bare 'ns__Class' actionName/value (no dot -- Invocable-
// style) -> external, split on the FIRST '__', cross-checked against a
// SECOND metadata surface (Flow AND CMDT both landing on ONE node) --
// excludes a value ending '__c' (an ordinary custom-object-API-name shape,
// NOT a class reference).
{
  const index = buildSemanticIndex([]);
  const flowRef = {
    kind: 'flow',
    label: 'V8NamespaceProbeFlow2',
    className: 'kwx__V8PostLedgerEntry',
    methodName: null,
    path: 'flows/V8NamespaceProbeFlow2.flow-meta.xml',
    line: 34,
    lineText: '<actionName>kwx__V8PostLedgerEntry</actionName>',
    flowObject: null,
    flowRecordTriggerType: null,
    flowTriggerType: null,
  };
  const cmdtRef = {
    kind: 'cmdt',
    label: 'V8Kappa_Trigger_Config.Namespace_Handler',
    className: 'kwx__V8PostLedgerEntry',
    methodName: null,
    fieldName: 'Handler_Class_Name__c',
    path: 'customMetadata/V8Kappa_Trigger_Config.Namespace_Handler.md-meta.xml',
    line: 15,
    lineText: '<value xsi:type="xsd:string">kwx__V8PostLedgerEntry</value>',
  };
  // Negative control, same file: an ordinary custom-object-shaped CMDT
  // value (ends '__c') must NEVER be misread as a namespaced class ref.
  const objectShapedRef = {
    kind: 'cmdt',
    label: 'V8Kappa_Trigger_Config.Namespace_Handler',
    className: 'V8Kappa_Order__c',
    methodName: null,
    fieldName: 'SobjectApiName__c',
    path: 'customMetadata/V8Kappa_Trigger_Config.Namespace_Handler.md-meta.xml',
    line: 7,
    lineText: '<value xsi:type="xsd:string">V8Kappa_Order__c</value>',
  };
  attachMetaCallers(index, [flowRef, cmdtRef, objectShapedRef]);

  const key = 'kwx.v8postledgerentry';
  const ext = index.externals.get(key);
  assert.ok(ext, "v0.8/N1(c): a bare 'ns__Class' Flow actionName splits into ns='kwx', class='V8PostLedgerEntry', method=null");
  assert.strictEqual(ext.label, 'kwx.V8PostLedgerEntry', "bare Invocable-style refs get the DOT display convention (a CLASS reference), not the underscore convention DML/publish OBJECT externals get");
  assert.deepStrictEqual([...ext.methods], [], 'bare Invocable action -- no method segment, same methodName:null shape a local @InvocableMethod bare actionName already produces');
  assert.strictEqual(ext.refCount, 2, 'v0.8/N1(c): the Flow actionName AND the CMDT value BOTH attach to the SAME external node -- a second cross-surface (Flow + CMDT) consistency check');

  assert.strictEqual(index.externals.has('v8kappa_order.c'), false, 'the negative control must never create a spurious external key');
  assert.strictEqual(index.externals.size, 1, 'the object-shaped CMDT value stays inert (local-attach, matching its exact pre-v0.8 fate) -- only ONE external node total');

  const extTree = buildCallerTree(index, { classLower: key, methodLower: null });
  assert.strictEqual(extTree.root.children.length, 2, 'both the flow and the cmdt terminal children are present as siblings');
  assert.ok(extTree.root.children.some((c) => c.kind === 'flow'));
  assert.ok(extTree.root.children.some((c) => c.kind === 'cmdt'));
}

// ---- N3: own-namespace metascan ref resolves LOCALLY, no external -------
{
  const V8OwnMetaTarget = ty('V8OwnMetaTarget', 'V8OwnMetaTarget', { methods: [mth('doWork', { line: 1 })] });
  const index = buildSemanticIndex([mkFile(V8OwnMetaTarget)], { ownNamespace: 'vtx' });
  const metaRefs = [
    {
      kind: 'lwc',
      label: 'v8ownWidget',
      className: 'V8OwnMetaTarget',
      methodName: 'doWork',
      namespace: 'vtx',
      path: 'lwc/v8ownWidget/v8ownWidget.js',
      line: 1,
      lineText: "import doWork from '@salesforce/apex/vtx.V8OwnMetaTarget.doWork';",
    },
  ];
  attachMetaCallers(index, metaRefs);
  assert.strictEqual(index.externals.size, 0, "v0.8/N3: an LWC ref whose namespace IS the workspace's own must resolve locally, not externally");
  const tree = buildCallerTree(index, { classLower: 'v8ownmetatarget', methodLower: 'dowork' });
  const lwcChild = tree.root.children.find((c) => c.kind === 'lwc');
  assert.ok(lwcChild, 'v0.8/N3: the own-namespace-stripped LWC ref attaches to the LOCAL class/method exactly like a bare (no-namespace) ref would');
}

// =========================================================================
// P1 (v0.9): progressive depth -- expandable/pendingCount/frontier stats,
// expandedKeys semantics, the back-compat REGRESSION PIN, convergence, and
// interplay with seenElsewhere/cycles/maxNodes. Mirrors resolver.js's own
// P1 header comments (normalizeProgressiveOpts, buildOneChildNode's
// frontier branch, groupPairsByKey) -- read those first if a test here
// fails, they document the frozen semantics being pinned.
//
// Self-contained by design (matches this file's own top-of-file promise:
// "does NOT depend on parser.js existing") -- the back-compat pin below is
// a structural/logical proof (no node anywhere gets expandable/pendingCount
// under default opts, and default-opts output is byte-identical across
// every equivalent way of expressing "no opts") rather than a diff against
// an externally-extracted old engine binary. Real-corpus-level protection
// for the SAME pin is separately covered by dev/regress-v08.js (byte-
// identical site-edges against the actual published v0.7.1 engine over
// adv-org/gauntlet-org) and dev/gauntlet/run.js (0 BUG/0 NEW_GAP) -- both
// re-verified to still pass after this round's resolver.js changes.
// =========================================================================

function keyOf(node) {
  // Reconstructs the SAME 'classlower#methodlower' identity buildOneChildNode
  // computes internally as cycleKey (see resolver.js). Valid for these
  // fixtures because every class name here is unique workspace-wide (no B2
  // duplicate-name/package collision, the one case where the registration
  // key would diverge from a plain lowercased qualified name).
  return `${(node.className || '').toLowerCase()}#${node.methodLower || ''}`;
}

function walkTree(node, fn) {
  fn(node);
  for (const c of node.children || []) walkTree(c, fn);
}

function collectExpandableKeys(root) {
  const keys = [];
  walkTree(root, (n) => { if (n.expandable) keys.push(keyOf(n)); });
  return keys;
}

// Linear 5-level CALLER chain: V9Chain5Target.run <- L1.hop1 <- L2.hop2 <-
// L3.hop3 <- L4.hop4 <- L5.hop5 (L5 is a genuine leaf -- no further
// callers). Every method is static + class-name-receiver ('dot' via
// 'static', the same shape test-resolver.js's own W7Target.doStatic
// fixture already exercises) to keep call-site resolution unambiguous.
function buildV9Chain5() {
  const T = ty('V9Chain5Target', 'V9Chain5Target', { methods: [mth('run', { line: 1, isStatic: true })] });
  const L1 = ty('V9Chain5L1', 'V9Chain5L1', {
    methods: [mth('hop1', { line: 1, isStatic: true, calls: [cl('dot', 'run', { receiver: 'V9Chain5Target', line: 1, lineText: 'V9Chain5Target.run();' })] })],
  });
  const L2 = ty('V9Chain5L2', 'V9Chain5L2', {
    methods: [mth('hop2', { line: 1, isStatic: true, calls: [cl('dot', 'hop1', { receiver: 'V9Chain5L1', line: 1, lineText: 'V9Chain5L1.hop1();' })] })],
  });
  const L3 = ty('V9Chain5L3', 'V9Chain5L3', {
    methods: [mth('hop3', { line: 1, isStatic: true, calls: [cl('dot', 'hop2', { receiver: 'V9Chain5L2', line: 1, lineText: 'V9Chain5L2.hop2();' })] })],
  });
  const L4 = ty('V9Chain5L4', 'V9Chain5L4', {
    methods: [mth('hop4', { line: 1, isStatic: true, calls: [cl('dot', 'hop3', { receiver: 'V9Chain5L3', line: 1, lineText: 'V9Chain5L3.hop3();' })] })],
  });
  const L5 = ty('V9Chain5L5', 'V9Chain5L5', {
    methods: [mth('hop5', { line: 1, isStatic: true, calls: [cl('dot', 'hop4', { receiver: 'V9Chain5L4', line: 1, lineText: 'V9Chain5L4.hop4();' })] })],
  });
  const idx = buildSemanticIndex([mkFile(T), mkFile(L1), mkFile(L2), mkFile(L3), mkFile(L4), mkFile(L5)]);
  return { index: idx, target: { classLower: 'v9chain5target', methodLower: 'run' } };
}

// Mirror of buildV9Chain5, but a forward CALLEE chain: V9CChain5Target.start
// -> L1.step1 -> L2.step2 -> L3.step3 -> L4.step4 -> L5.step5 (leaf, makes
// no further calls). Used for the "both directions" P1 coverage.
function buildV9ChainCallee5() {
  const L5 = ty('V9CChain5L5', 'V9CChain5L5', { methods: [mth('step5', { line: 1, isStatic: true })] });
  const L4 = ty('V9CChain5L4', 'V9CChain5L4', {
    methods: [mth('step4', { line: 1, isStatic: true, calls: [cl('dot', 'step5', { receiver: 'V9CChain5L5', line: 1, lineText: 'V9CChain5L5.step5();' })] })],
  });
  const L3 = ty('V9CChain5L3', 'V9CChain5L3', {
    methods: [mth('step3', { line: 1, isStatic: true, calls: [cl('dot', 'step4', { receiver: 'V9CChain5L4', line: 1, lineText: 'V9CChain5L4.step4();' })] })],
  });
  const L2 = ty('V9CChain5L2', 'V9CChain5L2', {
    methods: [mth('step2', { line: 1, isStatic: true, calls: [cl('dot', 'step3', { receiver: 'V9CChain5L3', line: 1, lineText: 'V9CChain5L3.step3();' })] })],
  });
  const L1 = ty('V9CChain5L1', 'V9CChain5L1', {
    methods: [mth('step1', { line: 1, isStatic: true, calls: [cl('dot', 'step2', { receiver: 'V9CChain5L2', line: 1, lineText: 'V9CChain5L2.step2();' })] })],
  });
  const T = ty('V9CChain5Target', 'V9CChain5Target', {
    methods: [mth('start', { line: 1, calls: [cl('dot', 'step1', { receiver: 'V9CChain5L1', line: 1, lineText: 'V9CChain5L1.step1();' })] })],
  });
  const idx = buildSemanticIndex([mkFile(T), mkFile(L1), mkFile(L2), mkFile(L3), mkFile(L4), mkFile(L5)]);
  return { index: idx, target: { classLower: 'v9cchain5target', methodLower: 'start' } };
}

// ---- P1 REGRESSION PIN: initialDepth===maxDepth && expandedKeys empty ---
// -> byte-identical to pre-P1 (v0.8) output, in every equivalent way of
// expressing "no progressive-depth opts". Callers direction.
{
  const V9PinTarget = ty('V9PinTarget', 'V9PinTarget', { methods: [mth('run', { line: 1, isStatic: true })] });
  const V9PinL1 = ty('V9PinL1', 'V9PinL1', {
    methods: [mth('hop1', { line: 1, isStatic: true, calls: [cl('dot', 'run', { receiver: 'V9PinTarget', line: 1, lineText: 'V9PinTarget.run();' })] })],
  });
  const V9PinL2 = ty('V9PinL2', 'V9PinL2', {
    methods: [mth('hop2', { line: 1, isStatic: true, calls: [cl('dot', 'hop1', { receiver: 'V9PinL1', line: 1, lineText: 'V9PinL1.hop1();' })] })],
  });
  const idx = buildSemanticIndex([mkFile(V9PinTarget), mkFile(V9PinL1), mkFile(V9PinL2)]);
  const target = { classLower: 'v9pintarget', methodLower: 'run' };

  const tNoOpts = buildCallerTree(idx, target);
  const tUndefinedOpts = buildCallerTree(idx, target, undefined);
  const tEmptyOpts = buildCallerTree(idx, target, {});
  const tExplicitDefault = buildCallerTree(idx, target, { initialDepth: 8, expandedKeys: new Set() });
  const tExplicitDefaultUndef = buildCallerTree(idx, target, { initialDepth: undefined, expandedKeys: undefined });

  assert.deepStrictEqual(tUndefinedOpts, tNoOpts, 'P1 back-compat: opts undefined === opts omitted');
  assert.deepStrictEqual(tEmptyOpts, tNoOpts, 'P1 back-compat: opts={} === opts omitted');
  assert.deepStrictEqual(tExplicitDefault, tNoOpts, "P1 REGRESSION PIN: initialDepth===maxDepth && expandedKeys empty -> byte-identical to the pre-P1 default-opts output");
  assert.deepStrictEqual(tExplicitDefaultUndef, tNoOpts, 'P1 back-compat: initialDepth/expandedKeys explicitly undefined behaves exactly like opts omitted');

  let sawFrontierField = false;
  walkTree(tNoOpts.root, (n) => {
    if (n.expandable || Object.prototype.hasOwnProperty.call(n, 'pendingCount')) sawFrontierField = true;
  });
  assert.strictEqual(sawFrontierField, false, 'P1: under default opts, no node anywhere is ever marked expandable/pendingCount -- the frontier branch is provably unreachable when initialDepth===maxDepth');
  assert.strictEqual(tNoOpts.stats.frontierNodes, 0, 'P1: stats.frontierNodes is the new additive field, 0 under default opts');
  assert.strictEqual(Object.prototype.hasOwnProperty.call(tNoOpts.stats, 'frontierNodes'), true, 'frontierNodes is always present, even under default opts (additive, not conditional)');
}

// ---- P1 REGRESSION PIN, callees direction + not-found shells -----------
{
  const V9PinCalleeRoot = ty('V9PinCalleeRoot', 'V9PinCalleeRoot', {
    methods: [mth('start', { line: 1, calls: [cl('dot', 'mid', { receiver: 'V9PinCalleeMid', line: 1, lineText: 'V9PinCalleeMid.mid();' })] })],
  });
  const V9PinCalleeMid = ty('V9PinCalleeMid', 'V9PinCalleeMid', {
    methods: [mth('mid', { line: 1, isStatic: true, calls: [cl('dot', 'leaf', { receiver: 'V9PinCalleeLeaf', line: 1, lineText: 'V9PinCalleeLeaf.leaf();' })] })],
  });
  const V9PinCalleeLeaf = ty('V9PinCalleeLeaf', 'V9PinCalleeLeaf', { methods: [mth('leaf', { line: 1, isStatic: true })] });
  const idx = buildSemanticIndex([mkFile(V9PinCalleeRoot), mkFile(V9PinCalleeMid), mkFile(V9PinCalleeLeaf)]);
  const target = { classLower: 'v9pincalleeroot', methodLower: 'start' };

  const cNoOpts = buildCalleeTree(idx, target);
  const cExplicitDefault = buildCalleeTree(idx, target, { initialDepth: 8, expandedKeys: new Set() });
  assert.deepStrictEqual(cExplicitDefault, cNoOpts, 'P1 REGRESSION PIN (callees direction): initialDepth===maxDepth && expandedKeys empty -> byte-identical');
  assert.strictEqual(cNoOpts.stats.frontierNodes, 0);

  // Not-found shells (both directions) also gain the additive field, always 0.
  const notFoundCallers = buildCallerTree(idx, { classLower: 'nosuchclassv9', methodLower: null });
  const notFoundCallees = buildCalleeTree(idx, { classLower: 'nosuchclassv9', methodLower: null });
  assert.strictEqual(notFoundCallers.stats.frontierNodes, 0);
  assert.strictEqual(notFoundCallees.stats.frontierNodes, 0);
}

// ---- P1: expandable/pendingCount shape + convergence, CALLERS direction -
{
  const { index: idx, target } = buildV9Chain5();
  const tree = buildCallerTree(idx, target, { initialDepth: 2 });

  const l1 = findChild(tree.root.children, 'V9Chain5L1.hop1');
  assert.ok(l1, 'depth1 node (V9Chain5L1.hop1) is shown');
  assert.strictEqual(l1.expandable, undefined, 'depth1 < initialDepth(2) -- L1 auto-expands, never marked expandable');
  assert.strictEqual(l1.truncated, false);
  assert.strictEqual(l1.children.length, 1, "L1 auto-expanded down to reveal its own caller L2 -- 'initialDepth default 2' shows 2 levels");

  const l2 = l1.children[0];
  assert.strictEqual(l2.label, 'V9Chain5L2.hop2');
  assert.strictEqual(l2.expandable, true, 'depth2 >= initialDepth(2) and not in expandedKeys -- L2 is the frontier boundary');
  assert.strictEqual(l2.pendingCount, 1, 'exactly one direct caller (L3) waits behind the frontier');
  assert.deepStrictEqual(l2.children, [], 'a frontier node renders with NO children yet -- nothing materialized behind it');
  assert.strictEqual(l2.truncated, false, 'expandable (depth frontier) is distinct from truncated (hard cap) -- L2 is nowhere near maxDepth(8)');

  assert.strictEqual(tree.stats.frontierNodes, 1, 'exactly one frontier node in this shallow trace');

  // Convergence: iteratively expand every frontier key surfaced so far and
  // rebuild, until no frontier nodes remain -- must reproduce the full
  // (maxDepth-bounded, i.e. v0.8-style) tree exactly.
  const expandedKeys = new Set();
  let converged = tree;
  let iterations = 0;
  while (converged.stats.frontierNodes > 0 && iterations < 10) {
    for (const k of collectExpandableKeys(converged.root)) expandedKeys.add(k);
    converged = buildCallerTree(idx, target, { initialDepth: 2, expandedKeys });
    iterations++;
  }
  assert.ok(iterations > 0 && iterations < 10, `convergence took ${iterations} rounds (expected a handful for a 5-level chain)`);
  assert.strictEqual(converged.stats.frontierNodes, 0, 'fully converged -- no frontier nodes left');

  const fullTree = buildCallerTree(idx, target, {});
  assert.deepStrictEqual(converged.root, fullTree.root, 'P1 convergence: iteratively expanding every frontier key reproduces the FULL v0.8-style tree exactly (deep-equal)');
  assert.strictEqual(converged.stats.nodes, fullTree.stats.nodes);
  assert.strictEqual(converged.stats.uniqueMethods, fullTree.stats.uniqueMethods);
}

// ---- P1: expandable/pendingCount shape + convergence, CALLEES direction -
{
  const { index: idx, target } = buildV9ChainCallee5();
  const tree = buildCalleeTree(idx, target, { initialDepth: 2 });

  const l1 = findChild(tree.root.children, 'V9CChain5L1.step1');
  assert.ok(l1, 'depth1 node (V9CChain5L1.step1) is shown');
  assert.strictEqual(l1.expandable, undefined);
  assert.strictEqual(l1.children.length, 1);

  const l2 = l1.children[0];
  assert.strictEqual(l2.label, 'V9CChain5L2.step2');
  assert.strictEqual(l2.expandable, true, 'callees direction: depth frontier applies identically to forward tracing');
  assert.strictEqual(l2.pendingCount, 1);
  assert.deepStrictEqual(l2.children, []);
  assert.strictEqual(tree.stats.frontierNodes, 1);

  const expandedKeys = new Set();
  let converged = tree;
  let iterations = 0;
  while (converged.stats.frontierNodes > 0 && iterations < 10) {
    for (const k of collectExpandableKeys(converged.root)) expandedKeys.add(k);
    converged = buildCalleeTree(idx, target, { initialDepth: 2, expandedKeys });
    iterations++;
  }
  assert.ok(iterations > 0 && iterations < 10);
  assert.strictEqual(converged.stats.frontierNodes, 0);

  const fullTree = buildCalleeTree(idx, target, {});
  assert.deepStrictEqual(converged.root, fullTree.root, 'P1 convergence (callees direction): iteratively expanding every frontier key reproduces the FULL tree exactly');
}

// ---- P1: each click reveals EXACTLY the clicked node's direct children --
// (expandStep>1 is a caller-side concern -- the engine itself always stays
// single-level per opts.expandedKeys entry).
{
  const { index: idx, target } = buildV9Chain5();
  const shallow = buildCallerTree(idx, target, { initialDepth: 1 });
  const l1 = findChild(shallow.root.children, 'V9Chain5L1.hop1');
  assert.strictEqual(l1.expandable, true, 'initialDepth=1 -- depth1 (1 < 1 is false) is already past the frontier');
  assert.strictEqual(l1.pendingCount, 1);
  assert.deepStrictEqual(l1.children, []);

  const key1 = keyOf(l1); // 'v9chain5l1#hop1'
  const oneClick = buildCallerTree(idx, target, { initialDepth: 1, expandedKeys: new Set([key1]) });
  const l1b = findChild(oneClick.root.children, 'V9Chain5L1.hop1');
  assert.strictEqual(l1b.expandable, undefined, 'L1 is now explicitly expanded -- no longer marked expandable itself');
  assert.strictEqual(l1b.children.length, 1, "exactly ONE level revealed -- L1's own direct child (L2)");

  const l2b = l1b.children[0];
  assert.strictEqual(l2b.label, 'V9Chain5L2.hop2');
  assert.strictEqual(l2b.expandable, true, "L2 is NOT auto-expanded just because its parent was -- a single click only ever reveals the clicked node's OWN direct children, nothing deeper");
  assert.strictEqual(l2b.pendingCount, 1);
  assert.deepStrictEqual(l2b.children, []);
}

// ---- P1 x back-compat: opts.maxDepth alone (no initialDepth) silently ---
// defaults initialDepth to that maxDepth -- old-style hard truncation, NOT
// the new frontier -- exactly the frozen back-compat rule, exercised here
// against a NON-default maxDepth (the REGRESSION PIN above only proved it
// at the literal default value 8).
{
  const { index: idx, target } = buildV9Chain5();
  const tree = buildCallerTree(idx, target, { maxDepth: 3 });

  const l1 = findChild(tree.root.children, 'V9Chain5L1.hop1');
  const l2 = l1 && findChild(l1.children, 'V9Chain5L2.hop2');
  const l3 = l2 && findChild(l2.children, 'V9Chain5L3.hop3');
  assert.ok(l1 && l2 && l3);
  assert.strictEqual(l1.expandable, undefined);
  assert.strictEqual(l2.expandable, undefined);
  assert.strictEqual(l3.expandable, undefined, 'initialDepth defaulted to maxDepth(3) -- L3 hits the OLD-STYLE hard depth cap, not the new frontier');
  assert.strictEqual(l3.truncated, true, 'depth3 >= maxDepth(3) -- classic pre-P1 truncation, unchanged');
  assert.deepStrictEqual(l3.children, []);
  assert.strictEqual(tree.stats.frontierNodes, 0, 'no frontier nodes at all when initialDepth silently defaults to maxDepth, even a non-default one');
}

// ---- P1 x H1 interplay: a seenElsewhere reference node is NEVER --------
// expandable -- DAG dedup (checked before the frontier branch) always wins.
{
  const V9DiaTarget = ty('V9DiaTarget', 'V9DiaTarget', { methods: [mth('run', { line: 1, isStatic: true })] });
  const V9DiaA = ty('V9DiaA', 'V9DiaA', {
    methods: [mth('viaA', { line: 1, isStatic: true, calls: [cl('dot', 'run', { receiver: 'V9DiaTarget', line: 1, lineText: 'V9DiaTarget.run();' })] })],
  });
  const V9DiaShared = ty('V9DiaShared', 'V9DiaShared', {
    methods: [mth('direct', {
      line: 1,
      isStatic: true,
      calls: [
        cl('dot', 'run', { receiver: 'V9DiaTarget', line: 1, lineText: 'V9DiaTarget.run();' }),
        cl('dot', 'viaA', { receiver: 'V9DiaA', line: 2, lineText: 'V9DiaA.viaA();' }),
      ],
    })],
  });
  const idx = buildSemanticIndex([mkFile(V9DiaTarget), mkFile(V9DiaA), mkFile(V9DiaShared)]);
  const target = { classLower: 'v9diatarget', methodLower: 'run' };

  const tree = buildCallerTree(idx, target, { initialDepth: 2 });
  const a = findChild(tree.root.children, 'V9DiaA.viaA');
  const sharedDirect = findChild(tree.root.children, 'V9DiaShared.direct');
  assert.ok(a && sharedDirect, 'both direct callers of the target are shown at depth1');
  assert.strictEqual(a.expandable, undefined, 'depth1 < initialDepth(2) -- both auto-expand');
  assert.strictEqual(sharedDirect.expandable, undefined);

  const sharedViaA = findChild(a.children, 'V9DiaShared.direct');
  assert.ok(sharedViaA, 'V9DiaShared.direct is ALSO a caller of V9DiaA.viaA -- appears a second time, at depth2 under A');
  assert.strictEqual(sharedViaA.seenElsewhere, true, 'this identity was already expanded once (as the depth1 sibling) -- DAG dedup wins');
  assert.strictEqual(sharedViaA.expandable, undefined, 'P1 x H1 interplay: a seenElsewhere reference node is NEVER expandable -- it points at the occurrence already expanded elsewhere; seenElsewhere is checked BEFORE the frontier branch in buildOneChildNode');
  assert.ok(!Object.prototype.hasOwnProperty.call(sharedViaA, 'pendingCount'), 'no pendingCount on a seenElsewhere node either');
  assert.deepStrictEqual(sharedViaA.children, [], 'seenElsewhere nodes render with no children, same as pre-P1');
}

// ---- P1 x H1 REGRESSION: diamond fan-in reconverging BEYOND the frontier -
// (bugfix regression) both occurrences of a shared identity are reached
// PAST the initialDepth frontier (as opposed to the block above, where one
// occurrence sits AT the frontier depth already-expanded and the other is
// one hop further under it) -- e.g. Top is called by BOTH Left and Right,
// and Left/Right themselves are the frontier boundary, so Top would only
// ever be discovered by peeking behind two DIFFERENT frontier stubs, never
// by a real expansion. Before the fix, buildOneChildNode's frontier branch
// returned without registering cycleKey in ctx.expandedKeys, so neither
// occurrence's seenElsewhere check (which runs BEFORE the frontier check)
// ever fired -- both rendered as independent expandable:true stubs instead
// of one real + one seenElsewhere reference. See resolver.js's frontier
// branch comment (right above ctx.expandedKeys.add(cycleKey) in that
// branch) for the fix itself.
{
  const V9DiaFTarget = ty('V9DiaFTarget', 'V9DiaFTarget', { methods: [mth('run', { line: 1, isStatic: true })] });
  const V9DiaFLeft = ty('V9DiaFLeft', 'V9DiaFLeft', {
    methods: [mth('mid', { line: 1, isStatic: true, calls: [cl('dot', 'run', { receiver: 'V9DiaFTarget', line: 1, lineText: 'V9DiaFTarget.run();' })] })],
  });
  const V9DiaFRight = ty('V9DiaFRight', 'V9DiaFRight', {
    methods: [mth('mid', { line: 1, isStatic: true, calls: [cl('dot', 'run', { receiver: 'V9DiaFTarget', line: 1, lineText: 'V9DiaFTarget.run();' })] })],
  });
  const V9DiaFTop = ty('V9DiaFTop', 'V9DiaFTop', {
    methods: [mth('call', {
      line: 1,
      isStatic: true,
      calls: [
        cl('dot', 'mid', { receiver: 'V9DiaFLeft', line: 1, lineText: 'V9DiaFLeft.mid();' }),
        cl('dot', 'mid', { receiver: 'V9DiaFRight', line: 2, lineText: 'V9DiaFRight.mid();' }),
      ],
    })],
  });
  // Top itself has a further caller (Apex.entry) -- gives Top pendingCount=1
  // so it's a genuine expandable frontier boundary in its own right (not
  // just an honest leaf), matching the report's most illustrative repro
  // shape where BOTH duplicate occurrences independently render
  // expandable:true.
  const V9DiaFApex = ty('V9DiaFApex', 'V9DiaFApex', {
    methods: [mth('entry', { line: 1, isStatic: true, calls: [cl('dot', 'call', { receiver: 'V9DiaFTop', line: 1, lineText: 'V9DiaFTop.call();' })] })],
  });
  const idx = buildSemanticIndex([mkFile(V9DiaFTarget), mkFile(V9DiaFLeft), mkFile(V9DiaFRight), mkFile(V9DiaFTop), mkFile(V9DiaFApex)]);
  const target = { classLower: 'v9diaftarget', methodLower: 'run' };

  // Zero clicks, initialDepth=2: Left/Right (depth1) auto-expand (1 < 2),
  // revealing Top (depth2) TWICE -- both occurrences are beyond the
  // frontier simultaneously, reached via two different already-expanded
  // parents. Must dedup to exactly one real (expandable) + one
  // seenElsewhere reference, never two independent expandable stubs.
  const tree = buildCallerTree(idx, target, { initialDepth: 2 });
  const left = findChild(tree.root.children, 'V9DiaFLeft.mid');
  const right = findChild(tree.root.children, 'V9DiaFRight.mid');
  assert.ok(left && right, 'both direct callers auto-expand at depth1 < initialDepth(2)');
  const topUnderLeft = findChild(left.children, 'V9DiaFTop.call');
  const topUnderRight = findChild(right.children, 'V9DiaFTop.call');
  assert.ok(topUnderLeft && topUnderRight, 'V9DiaFTop.call reached via BOTH Left and Right, beyond the frontier');

  const topOccurrences = [topUnderLeft, topUnderRight];
  const realOnes = topOccurrences.filter((n) => !n.seenElsewhere);
  const seenElsewhereOnes = topOccurrences.filter((n) => n.seenElsewhere);
  assert.strictEqual(realOnes.length, 1, 'H1 regression: exactly ONE real (non-seenElsewhere) occurrence of the shared diamond identity beyond the frontier, not two independent stubs');
  assert.strictEqual(seenElsewhereOnes.length, 1, 'the other occurrence must be a seenElsewhere reference');
  assert.strictEqual(realOnes[0].expandable, true, 'the real occurrence still carries its own expandable/pendingCount frontier badge (Top has a further caller: Apex.entry)');
  assert.strictEqual(realOnes[0].pendingCount, 1, 'exactly one further caller (Apex.entry) waits behind V9DiaFTop.call');
  assert.strictEqual(seenElsewhereOnes[0].expandable, undefined, 'a seenElsewhere reference is never expandable');
  assert.ok(!Object.prototype.hasOwnProperty.call(seenElsewhereOnes[0], 'pendingCount'), 'no pendingCount on a seenElsewhere node either');
  // Left/Right themselves are NOT frontier nodes -- depth1 < initialDepth(2)
  // auto-expands them; it's their shared child V9DiaFTop.call (depth2) that
  // is the frontier boundary. Exactly ONE frontier node, not two -- the
  // seenElsewhere duplicate occurrence never reaches the frontier-counting
  // branch at all (H1 dedup short-circuits it first).
  assert.strictEqual(tree.stats.frontierNodes, 1, 'exactly one frontier node (the real V9DiaFTop.call occurrence) -- the seenElsewhere duplicate does not add a second');

  // Convergence: expanding every frontier key round-by-round must still
  // reproduce the full v0.8-style eager tree exactly (deep-equal) -- the
  // literal VERIFICATION BAR requirement, now proven for a diamond shape
  // (not just the linear V9Chain5 fixture above, which the bug slipped
  // past).
  const expandedKeys = new Set();
  let converged = buildCallerTree(idx, target, { initialDepth: 2, expandedKeys });
  let iterations = 0;
  while (converged.stats.frontierNodes > 0 && iterations < 10) {
    for (const k of collectExpandableKeys(converged.root)) expandedKeys.add(k);
    converged = buildCallerTree(idx, target, { initialDepth: 2, expandedKeys });
    iterations += 1;
  }
  assert.strictEqual(converged.stats.frontierNodes, 0, 'diamond fully converges to zero frontier nodes');
  const fullTree = buildCallerTree(idx, target, {});
  assert.deepStrictEqual(converged.root, fullTree.root, 'P1 x H1 diamond regression: expand-to-convergence reproduces the FULL v0.8-style tree exactly (deep-equal) -- one real + one seenElsewhere, same as eager');
}

// ---- P1 x cycles interplay: cyclic still wins over the frontier ---------
// classification, including for a node reached through the NEW
// expandedKeys-forced-expansion path (not just the plain initialDepth path).
{
  const V9CycTarget = ty('V9CycTarget', 'V9CycTarget', {
    methods: [mth('entry', { line: 1, isStatic: true, calls: [cl('dot', 'hop', { receiver: 'V9CycHop', line: 5, lineText: 'V9CycHop.hop();' })] })],
  });
  const V9CycHop = ty('V9CycHop', 'V9CycHop', {
    methods: [mth('hop', { line: 1, isStatic: true, calls: [cl('dot', 'entry', { receiver: 'V9CycTarget', line: 1, lineText: 'V9CycTarget.entry();' })] })],
  });
  const idx = buildSemanticIndex([mkFile(V9CycTarget), mkFile(V9CycHop)]);
  const target = { classLower: 'v9cyctarget', methodLower: 'entry' };

  // Baseline: with initialDepth=1, the ONLY direct caller (V9CycHop.hop) is
  // already past the frontier (1 < 1 is false), so it renders as a frontier
  // boundary and is NOT walked into -- the cycle back to the target is not
  // even discovered yet.
  const shallow = buildCallerTree(idx, target, { initialDepth: 1 });
  const hop = findChild(shallow.root.children, 'V9CycHop.hop');
  assert.ok(hop);
  assert.strictEqual(hop.expandable, true);
  assert.strictEqual(hop.pendingCount, 1);
  assert.deepStrictEqual(hop.children, []);

  // Force-expand it via expandedKeys -- its own direct caller is
  // V9CycTarget.entry again, which IS on the current root-to-node ancestor
  // path -- cyclic detection must still fire correctly for a node reached
  // through the expandedKeys-forced path, winning over the frontier check
  // (cyclic is checked first in buildOneChildNode, unconditionally).
  const expanded = buildCallerTree(idx, target, { initialDepth: 1, expandedKeys: new Set([keyOf(hop)]) });
  const hop2 = findChild(expanded.root.children, 'V9CycHop.hop');
  assert.strictEqual(hop2.expandable, undefined, 'explicitly expanded -- no longer a frontier boundary itself');
  assert.strictEqual(hop2.children.length, 1);

  const backToTarget = hop2.children[0];
  assert.strictEqual(backToTarget.label, 'V9CycTarget.entry');
  assert.strictEqual(backToTarget.cyclic, true, 'P1 x cycles interplay: cyclic wins over the frontier classification');
  assert.strictEqual(backToTarget.expandable, undefined, 'a cyclic node is never ALSO marked expandable -- the two flags are mutually exclusive');
  assert.ok(!Object.prototype.hasOwnProperty.call(backToTarget, 'pendingCount'));
  assert.deepStrictEqual(backToTarget.children, [], 'cyclic nodes stay terminal, exactly like pre-P1');
}

// ---- P1 x maxNodes cap interplay: `truncated` (cap) and `expandable` ----
// (depth frontier) are fully independent, mutually exclusive, and never
// conflated on the same OR different nodes.
{
  const V9CapTarget = ty('V9CapTarget', 'V9CapTarget', { methods: [mth('run', { line: 1, isStatic: true })] });
  function mkV9CapBranch(name) {
    const mid = ty(`V9Cap${name}`, `V9Cap${name}`, {
      methods: [mth('mid', { line: 1, isStatic: true, calls: [cl('dot', 'run', { receiver: 'V9CapTarget', line: 1, lineText: 'V9CapTarget.run();' })] })],
    });
    const leaf = ty(`V9Cap${name}Caller`, `V9Cap${name}Caller`, {
      methods: [mth('call', { line: 1, isStatic: true, calls: [cl('dot', 'mid', { receiver: `V9Cap${name}`, line: 1, lineText: `V9Cap${name}.mid();` })] })],
    });
    return [mid, leaf];
  }
  const [midA, leafA] = mkV9CapBranch('A');
  const [midB, leafB] = mkV9CapBranch('B');
  const [midC, leafC] = mkV9CapBranch('C');
  const idx = buildSemanticIndex([mkFile(V9CapTarget), mkFile(midA), mkFile(leafA), mkFile(midB), mkFile(leafB), mkFile(midC), mkFile(leafC)]);
  const target = { classLower: 'v9captarget', methodLower: 'run' };

  const tree = buildCallerTree(idx, target, { initialDepth: 1, maxNodes: 2 });
  assert.strictEqual(tree.root.children.length, 1, 'maxNodes=2 (root counts as 1) allows exactly ONE depth-1 child to be created; the other two direct callers are dropped by the cap, never even built');
  assert.strictEqual(tree.stats.capped, true);
  assert.strictEqual(tree.root.truncated, true, 'the CAP -- not the depth frontier -- is why the root is missing children; a distinct flag from expandable');
  assert.strictEqual(tree.root.expandable, undefined, 'a capped node is never ALSO marked expandable -- the two mechanisms never collide on the same node');
  assert.ok(!Object.prototype.hasOwnProperty.call(tree.root, 'pendingCount'));

  const survivor = tree.root.children[0];
  assert.strictEqual(survivor.truncated, false, 'the node that DID get built is not itself cap-truncated');
  assert.strictEqual(survivor.expandable, true, "the survivor is independently past the initialDepth(1) frontier (its own caller exists) -- expandable and the sibling-level maxNodes cap are fully independent mechanisms, and they DO coexist across DIFFERENT nodes in the same tree");
  assert.strictEqual(survivor.pendingCount, 1);
  assert.deepStrictEqual(survivor.children, []);
  assert.strictEqual(tree.stats.frontierNodes, 1, 'exactly the one survivor counts toward frontierNodes -- the two callers dropped by the cap were never even visited, so they cannot inflate this count either');
}

// =========================================================================
// v0.10 (Round A) new coverage
// =========================================================================
//
// A1: CHAIN_MAX=12 (was 4) + per-chain (typeLower,methodLower) visited
//     cycle guard.
// A2: VF method-ref attach gate (resolver half only -- metascan.js's own
//     extraction half is exercised in test-metascan.js, not here).
// A3: buildCallerTree/buildCalleeTree opts clamping.
//
// Mirrors GROUND-TRUTH.md's v0.10-A/v0.10-B sections (example-data/
// gauntlet-org) at a small, self-contained, hand-built scale -- these
// fixtures are deliberately NOT the real corpus (this file never depends on
// parser.js/metascan.js), just the same shapes.

// ---- v0.10/A1: CHAIN_MAX segment-length matrix -------------------------
// CMStageK ladder: CMStage(K-1).hopK() returns CMStageK, for K=1..13.
// build() is declared on CMStage5/8/12/13 ONLY (4 declarations -- already
// non-unique, so rule 7's unique-name fallback can never mask a dropped
// chain as a false edge, same anti-fallback purpose GROUND-TRUTH.md's own
// 13-declaration ladder uses). Four traced call sites off a fresh
// CMStage0, at exactly the segment counts the amendment's own table calls
// out: 5 (well within the old AND new cap), 8 (only resolves post-A1), 12
// (exactly at the new cap), 13 (one past the new cap -- must still drop).
{
  function chainRecv(headName, n) {
    let s = headName;
    for (let i = 1; i <= n; i++) s += `.hop${i}()`;
    return s;
  }
  const cmTypes = [];
  for (let i = 0; i <= 13; i++) {
    const methods = [];
    if (i < 13) methods.push(mth(`hop${i + 1}`, { line: 1, returnType: `CMStage${i + 1}` }));
    if ([5, 8, 12, 13].includes(i)) methods.push(mth('build', { line: 2 })); // non-unique decoy
    cmTypes.push(ty(`CMStage${i}`, `CMStage${i}`, { methods }));
  }
  const CMChainCaller = ty('CMChainCaller', 'CMChainCaller', {
    methods: [
      mth('run5', {
        line: 1,
        locals: [{ name: 'q', type: 'CMStage0', line: 1 }],
        calls: [cl('dot', 'build', { receiver: chainRecv('q', 5), line: 2, lineText: chainRecv('q', 5) + '.build();' })],
      }),
      mth('run8', {
        line: 3,
        locals: [{ name: 'q', type: 'CMStage0', line: 3 }],
        calls: [cl('dot', 'build', { receiver: chainRecv('q', 8), line: 4, lineText: chainRecv('q', 8) + '.build();' })],
      }),
      mth('run12', {
        line: 5,
        locals: [{ name: 'q', type: 'CMStage0', line: 5 }],
        calls: [cl('dot', 'build', { receiver: chainRecv('q', 12), line: 6, lineText: chainRecv('q', 12) + '.build();' })],
      }),
      mth('run13', {
        line: 7,
        locals: [{ name: 'q', type: 'CMStage0', line: 7 }],
        calls: [cl('dot', 'build', { receiver: chainRecv('q', 13), line: 8, lineText: chainRecv('q', 13) + '.build();' })],
      }),
    ],
  });
  const cmIndex = buildSemanticIndex([...cmTypes.map(mkFile), mkFile(CMChainCaller)]);

  const t5 = buildCallerTree(cmIndex, { classLower: 'cmstage5', methodLower: 'build' });
  const c5 = findChild(t5.root.children, 'CMChainCaller.run5');
  assert.ok(c5, 'v0.10/A1: a 5-segment chain resolves (was already true pre-v0.10, still true post-v0.10)');
  assert.strictEqual(c5.via, 'typed');

  const t8 = buildCallerTree(cmIndex, { classLower: 'cmstage8', methodLower: 'build' });
  const c8 = findChild(t8.root.children, 'CMChainCaller.run8');
  assert.ok(c8, 'v0.10/A1: an 8-segment chain now resolves (pre-v0.10 this exceeded the old 4-segment cap and dropped)');
  assert.strictEqual(c8.via, 'typed');

  const t12 = buildCallerTree(cmIndex, { classLower: 'cmstage12', methodLower: 'build' });
  const c12 = findChild(t12.root.children, 'CMChainCaller.run12');
  assert.ok(c12, 'v0.10/A1: a 12-segment chain resolves -- exactly AT the new CHAIN_MAX cap, still within bounds');
  assert.strictEqual(c12.via, 'typed');

  const t13 = buildCallerTree(cmIndex, { classLower: 'cmstage13', methodLower: 'build' });
  const c13 = findChild(t13.root.children, 'CMChainCaller.run13');
  assert.ok(!c13, 'v0.10/A1: a 13-segment chain is one past CHAIN_MAX=12 -- must still drop honestly, never a guessed edge onto CMStage12 or CMStage13');
  assert.strictEqual(cmIndex.methodCallers.get('cmstage13#build'), undefined, 'no caller entry at all for the 13-segment target');

  const t12Wrong = buildCallerTree(cmIndex, { classLower: 'cmstage12', methodLower: 'build' });
  assert.strictEqual((t12Wrong.root.children || []).filter((c) => c.label === 'CMChainCaller.run13').length, 0, 'the dropped 13-segment call must NEVER be mis-credited to the 12-segment boundary class either');
}

// ---- v0.10/A1: per-chain (typeLower,methodLower) cycle guard ------------
// CycNodeA.next() -> CycNodeB, CycNodeB.next() -> CycNodeA, forever. Both
// also declare terminal() (non-unique -- disables rule 7 for the S=6 site).
// S=0,1,2 stay within the not-yet-repeated part of the cycle and must
// resolve normally; S=3 is the first hop that needs (CycNodeA,'next')
// again (already visited at S=1's own first hop) and must drop; S=6
// (traced .terminal()) is the headline "6-deep cycle still degrades
// honestly" case GROUND-TRUTH.md's v0.10-A(iii) table calls out.
{
  function nextChain(n) {
    let s = 'n';
    for (let i = 0; i < n; i++) s += '.next()';
    return s;
  }
  const CycNodeA = ty('CycNodeA', 'CycNodeA', {
    methods: [mth('next', { line: 1, returnType: 'CycNodeB' }), mth('terminal', { line: 2 })],
  });
  const CycNodeB = ty('CycNodeB', 'CycNodeB', {
    methods: [mth('next', { line: 1, returnType: 'CycNodeA' }), mth('terminal', { line: 2 })],
  });
  const CycCaller = ty('CycCaller', 'CycCaller', {
    methods: [
      mth('run', {
        line: 1,
        locals: [{ name: 'n', type: 'CycNodeA', line: 1 }],
        calls: [
          cl('dot', 'next', { receiver: nextChain(0), line: 1, lineText: 'n.next(); // S=0' }),
          cl('dot', 'next', { receiver: nextChain(1), line: 2, lineText: 'n.next().next(); // S=1' }),
          cl('dot', 'next', { receiver: nextChain(2), line: 3, lineText: '...S=2...' }),
          cl('dot', 'next', { receiver: nextChain(3), line: 4, lineText: '...S=3, must drop...' }),
          cl('dot', 'terminal', { receiver: nextChain(6), line: 5, lineText: '...S=6, must drop...' }),
        ],
      }),
    ],
  });
  const cycIndex = buildSemanticIndex([mkFile(CycNodeA), mkFile(CycNodeB), mkFile(CycCaller)]);

  // S=0 (bare 'n', 0 segments -- plain typed dispatch, not the chain walker
  // at all) and S=2 (A->B->A, both hops genuinely new -- no repeat yet)
  // BOTH land on CycNodeA.next -- two independent, correctly-resolved sites.
  assert.strictEqual((cycIndex.methodCallers.get('cycnodea#next') || []).length, 2, 'S=0 and S=2 both correctly resolve to CycNodeA.next');
  // S=1 (A->B, one genuinely new hop) lands on CycNodeB.next. S=3 would
  // ALSO naively land here (A->B->A->B, a guardless walk revisits the same
  // edge a second time) -- the guard must stop it BEFORE that, so this
  // must stay at exactly 1 site, not 2.
  assert.strictEqual((cycIndex.methodCallers.get('cycnodeb#next') || []).length, 1, 'v0.10/A1: S=3 must NOT also land on CycNodeB.next -- the cycle guard must fire before a naive walk would silently re-use the (CycNodeA,next)->(CycNodeB) edge a second time');
  // S=6 (traced .terminal()) -- headline case: must drop entirely, on
  // EITHER class (terminal() is non-unique, so rule 7 also correctly
  // declines).
  assert.strictEqual(cycIndex.methodCallers.get('cycnodea#terminal'), undefined, 'v0.10/A1: a 6-deep return-type cycle must degrade to NO edge, not a lucky/wrong guess -- CycNodeA.terminal');
  assert.strictEqual(cycIndex.methodCallers.get('cycnodeb#terminal'), undefined, 'v0.10/A1: same, CycNodeB.terminal -- neither side of the cycle is credited');
}

// ---- v0.10/A3: clamp math (clampInt) unit tests -------------------------
{
  // Non-finite (or non-numeric) inputs fall back to the caller's default,
  // exactly as if opts had omitted the field entirely.
  assert.strictEqual(clampInt(NaN, 1, 64, 8), 8, 'NaN -> fallback');
  assert.strictEqual(clampInt(Infinity, 1, 64, 8), 8, 'Infinity -> fallback');
  assert.strictEqual(clampInt(-Infinity, 1, 64, 8), 8, '-Infinity -> fallback');
  assert.strictEqual(clampInt('x', 1, 64, 8), 8, "non-numeric string ('x') -> fallback");
  assert.strictEqual(clampInt(undefined, 1, 64, 8), 8, 'undefined -> fallback');
  assert.strictEqual(clampInt(null, 1, 64, 8), 1, 'null -> Number(null) is 0 (finite!), which clamps to min, NOT the fallback -- every real call site already guards this with `opts && opts.maxDepth`, so a bare `null` never actually reaches clampInt in practice, but the function itself must still be internally consistent');
  // Out-of-range but FINITE values clamp to the nearest bound -- NOT the
  // fallback (a below-range value like -5 is not "absent", it is a real,
  // if nonsensical, number).
  assert.strictEqual(clampInt(-5, 1, 64, 8), 1, 'below range -> clamped to min');
  assert.strictEqual(clampInt(1e9, 1, 64, 8), 64, 'above range -> clamped to max');
  assert.strictEqual(clampInt(0, 1, 100000, 2000), 1, 'zero clamps to min like any other below-range finite value (differs from the old pre-v0.10 `value || fallback` idiom, which would have treated 0 as "absent")');
  // In-range values pass through completely untouched.
  assert.strictEqual(clampInt(3, 1, 64, 8), 3, 'in-range value untouched');
  assert.strictEqual(clampInt(1, 1, 64, 8), 1, 'exactly at min -- untouched, not treated as "needs clamping"');
  assert.strictEqual(clampInt(64, 1, 64, 8), 64, 'exactly at max -- untouched');
  assert.strictEqual(clampInt(3.7, 1, 64, 8), 3, 'non-integer finite value truncated toward zero before range-checking');
}

// ---- v0.10/A3: end-to-end wiring proof (buildCallerTree/buildCalleeTree
// actually apply the clamp, not just that clampInt is correct in isolation)
{
  const A3Target = ty('A3Target', 'A3Target', { methods: [mth('run', { line: 1 })] });
  const A3Caller = ty('A3Caller', 'A3Caller', {
    methods: [mth('call', { line: 1, calls: [cl('dot', 'run', { receiver: 'A3Target', line: 1, lineText: 'A3Target.run();' })] })],
  });
  const a3Index = buildSemanticIndex([mkFile(A3Target), mkFile(A3Caller)]);
  const a3Target = { classLower: 'a3target', methodLower: 'run' };

  const base = buildCallerTree(a3Index, a3Target, {});
  const nanTree = buildCallerTree(a3Index, a3Target, { maxDepth: NaN, maxNodes: Infinity, initialDepth: 'x' });
  assert.deepStrictEqual(nanTree, base, 'v0.10/A3: non-finite/non-numeric maxDepth/maxNodes/initialDepth must fall back to the EXACT same result as omitting opts entirely -- must not change any existing behavior');

  const negTree = buildCallerTree(a3Index, a3Target, { maxDepth: -5, maxNodes: -5 });
  assert.strictEqual(negTree.stats.nodes, 1, 'v0.10/A3: maxNodes clamped from -5 up to 1 -- only the root node is ever built');
  assert.strictEqual(negTree.root.children.length, 0, 'a maxNodes:1 cap (clamped from -5) leaves no room for any children at all');
  assert.strictEqual(negTree.stats.capped, true);

  const hugeTree = buildCallerTree(a3Index, a3Target, { maxDepth: 1e9, maxNodes: 1e9 });
  assert.strictEqual(hugeTree.stats.capped, false, 'v0.10/A3: maxNodes clamped to 100000 (not left as literal 1e9) is still far more than this tiny fixture needs -- behaves exactly like "effectively uncapped", proving the clamp did not break the huge-but-legitimate case');
  const calleeBase = buildCalleeTree(a3Index, a3Target, {});
  const calleeNan = buildCalleeTree(a3Index, a3Target, { maxDepth: NaN, maxNodes: 'x' });
  assert.deepStrictEqual(calleeNan, calleeBase, 'v0.10/A3: same clamp wiring proof, callee direction');
}

// ---- v0.10/A2: VF method-ref attach gate (resolver half) ---------------
// Hand-built MetaRefs matching the contract metascan.js's own v0.10/A2 half
// actually emits (verified live against the real gauntlet-org VF corpus):
// { kind:'vf', label, className:null, methodName, line, lineText,
//   controllerClass:string|null, extensionClasses:string[] }. This section
// exercises the ATTACH GATE only (attachMetaCallers' dispatch + the
// declared-on-controller-or-extensions decision) -- metascan.js's own
// extraction logic (which attribute shapes qualify) is out of scope here
// and is covered by test-metascan.js instead.
{
  const VfBase = ty('VfBase', 'VfBase', { methods: [mth('inheritedAction', { line: 1 })] });
  const VfController = ty('VfController', 'VfController', {
    extendsType: 'VfBase',
    methods: [mth('controllerAction', { line: 1 }), mth('bothAction', { line: 2 })],
  });
  const VfExtension = ty('VfExtension', 'VfExtension', {
    methods: [mth('extensionAction', { line: 1 }), mth('bothAction', { line: 2 })],
  });
  const vfIndex = buildSemanticIndex([mkFile(VfBase), mkFile(VfController), mkFile(VfExtension)]);

  function vfRef(methodName, line, controllerClass, extensionClasses) {
    return {
      kind: 'vf',
      label: 'VfMatrixPage',
      className: null,
      methodName,
      line,
      lineText: `action="{!${methodName}}"`,
      controllerClass,
      extensionClasses: extensionClasses || [],
    };
  }

  const vfRefs = [
    vfRef('controllerAction', 1, 'VfController', ['VfExtension']), // controller-declared
    vfRef('extensionAction', 2, 'VfController', ['VfExtension']),  // extension-declared (not the controller)
    vfRef('inheritedAction', 3, 'VfController', ['VfExtension']),  // inherited (declared on VfController's OWN ancestor, VfBase)
    vfRef('bothAction', 4, 'VfController', ['VfExtension']),       // ambiguous -- declared on BOTH
    vfRef('vanishedAction', 5, 'VfController', ['VfExtension']),   // none declare it
  ];
  attachMetaCallers(vfIndex, vfRefs);

  // controller-declared -> method-level edge on the controller.
  const controllerTree = buildCallerTree(vfIndex, { classLower: 'vfcontroller', methodLower: 'controlleraction' });
  assert.ok(findChild(controllerTree.root.children, 'VfMatrixPage'), 'v0.10/A2: controller-declared action binding attaches at the METHOD level on the controller');

  // extension-declared -> method-level edge on the EXTENSION, not the
  // controller (the "extension not controller" ground-truth shape).
  const extensionTree = buildCallerTree(vfIndex, { classLower: 'vfextension', methodLower: 'extensionaction' });
  assert.ok(findChild(extensionTree.root.children, 'VfMatrixPage'), 'v0.10/A2: extension-declared action binding attaches at the METHOD level on the EXTENSION');
  assert.strictEqual(vfIndex.methodCallers.get('vfcontroller#extensionaction'), undefined, 'must NOT also (or instead) attach to the controller');

  // inherited -> the CONTROLLER (own or inherited counts) gets the method-
  // level edge, even though VfController itself never declares
  // inheritedAction directly -- only its ancestor VfBase does.
  const inheritedTree = buildCallerTree(vfIndex, { classLower: 'vfcontroller', methodLower: 'inheritedaction' });
  assert.ok(findChild(inheritedTree.root.children, 'VfMatrixPage'), 'v0.10/A2: "declared, own OR inherited" -- an ancestor-declared method still attaches to the PAGE-DECLARED class (VfController), not VfBase');
  assert.strictEqual(vfIndex.methodCallers.get('vfbase#inheritedaction'), undefined, 'the edge attaches to the controller class itself, never fabricated onto the ancestor that actually declares it');

  // ambiguous (declared on BOTH controller and extension) -> class-level
  // ref to the CONTROLLER only, no method fabricated on either class.
  assert.strictEqual(vfIndex.methodCallers.get('vfcontroller#bothaction'), undefined, 'v0.10/A2: ambiguous ("declared on both") must NOT fabricate a method-level edge on the controller');
  assert.strictEqual(vfIndex.methodCallers.get('vfextension#bothaction'), undefined, 'nor on the extension');
  const controllerClassTree = buildCallerTree(vfIndex, { classLower: 'vfcontroller', methodLower: null });
  assert.ok(findChild(controllerClassTree.root.children, 'VfMatrixPage'), 'v0.10/A2: the ambiguous binding still surfaces as a CLASS-level reference to the controller');

  // none declare it -> same class-level-only fallback to the controller,
  // no method fabricated anywhere.
  assert.strictEqual(vfIndex.methodCallers.get('vfcontroller#vanishedaction'), undefined, 'v0.10/A2: "matches no class" must not fabricate a method-level edge');
  assert.strictEqual(vfIndex.methodCallers.get('vfextension#vanishedaction'), undefined);

  // No controller/extensions at all (standardController-only page) -- the
  // literal "no edge possible" case: dropped entirely, not even a
  // class-level fallback (there is no controller to fall back to).
  const vfNoControllerRef = vfRef('edit', 1, null, []);
  vfNoControllerRef.label = 'VfNoControllerPage';
  attachMetaCallers(vfIndex, [vfNoControllerRef]);
  let sawNoControllerPage = false;
  for (const [, refs] of vfIndex.metaCallers) {
    if (refs.some((r) => r.label === 'VfNoControllerPage')) sawNoControllerPage = true;
  }
  assert.strictEqual(sawNoControllerPage, false, 'v0.10/A2: a standardController-only page (no controllerClass, no extensionClasses) has NO edge possible at any level -- the ref is dropped entirely, not just left unresolved at the method level');
}

// =========================================================================
// v0.11/B1: literal-flow Type.forName dynamic dispatch -- extends the
// pre-existing (F4a) single-inline-string-literal-only rule to three
// additive strictly-verifiable shapes (single-assignment never-reassigned
// local, static-final-String constant own/cross-class, ternary-of-two-
// literals), all landing via='dynamic'/approximate:true through the SAME
// class-lookup rules an inline literal already used (incl. namespace/
// external handling). Fixture shape mirrors gauntlet-org's GROUND-TRUTH.md
// v0.11-B1 section (VtxHandlerNames/VtxDynamicFactory/VtxRouterHandler/
// VtxLegacyHandler/VtxEscalationHandler) 1:1, under the SAME class/method
// names, so this suite pins the exact scenarios the corpus documents
// without depending on reading real files or an in-flight parser.js.
// =========================================================================
{
  const VtxHandlerNames = ty('VtxHandlerNames', 'VtxHandlerNames', {
    // ROUTER: static final String, single-literal init -- the ONE
    // qualifying constant. LEGACY_HANDLER_NAME (literal init, NOT final)
    // and COMPUTED_HANDLER_NAME (final, but a method-call init) are BOTH
    // deliberately absent here -- "the parser never records them" per the
    // PARSER CONTRACT.
    constants: [{ name: 'ROUTER', literal: 'VtxRouterHandler' }],
  });
  const VtxRouterHandler = ty('VtxRouterHandler', 'VtxRouterHandler', { methods: [] });
  const VtxLegacyHandler = ty('VtxLegacyHandler', 'VtxLegacyHandler', { methods: [] });
  const VtxEscalationHandler = ty('VtxEscalationHandler', 'VtxEscalationHandler', { methods: [] });

  const VtxDynamicFactory = ty('VtxDynamicFactory', 'VtxDynamicFactory', {
    constants: [{ name: 'ESCALATION_HANDLER', literal: 'VtxEscalationHandler' }],
    methods: [
      mth('createFromLiteralLocal', {
        // (a) positive: single-assignment literal local, never reassigned.
        line: 17,
        locals: [{ name: 'handlerName', type: 'String', line: 18, literal: 'VtxRouterHandler' }],
        calls: [cl('dot', 'forName', { receiver: 'Type', argTexts: ['handlerName'], line: 19, lineText: 'Type.forName(handlerName);' })],
      }),
      mth('createFromReassignedLocal', {
        // (a-neg): same literal-initializer shape, but reassigned
        // somewhere in the method (inside an `if`, syntactically -- the
        // parser's no-reassignment proof is purely syntactic, not
        // reachability-sensitive) -- `literal` is unconditionally ABSENT,
        // regardless of the guard's runtime reachability.
        line: 31,
        locals: [{ name: 'handlerName', type: 'String', line: 32 }],
        calls: [cl('dot', 'forName', { receiver: 'Type', argTexts: ['handlerName'], line: 36, lineText: 'Type.forName(handlerName);' })],
      }),
      mth('createFromOwnConstant', {
        // (b) positive: own-class bare constant reference.
        line: 45,
        calls: [cl('dot', 'forName', { receiver: 'Type', argTexts: ['ESCALATION_HANDLER'], line: 46, lineText: 'Type.forName(ESCALATION_HANDLER);' })],
      }),
      mth('createFromCrossClassConstant', {
        // (b) positive: cross-class QUALIFIED constant reference.
        line: 55,
        calls: [cl('dot', 'forName', { receiver: 'Type', argTexts: ['VtxHandlerNames.ROUTER'], line: 56, lineText: 'Type.forName(VtxHandlerNames.ROUTER);' })],
      }),
      mth('createFromNonFinalCrossClassField', {
        // (b-neg v1): the field's mutability alone (missing `final`)
        // disqualifies it -- absent from VtxHandlerNames.constants
        // entirely, independent of its (real) literal payload.
        line: 66,
        calls: [cl('dot', 'forName', { receiver: 'Type', argTexts: ['VtxHandlerNames.LEGACY_HANDLER_NAME'], line: 67, lineText: 'Type.forName(VtxHandlerNames.LEGACY_HANDLER_NAME);' })],
      }),
      mth('createFromComputedCrossClassField', {
        // (b-neg v2): `final`, but a method-call initializer, not a single
        // literal -- also absent from VtxHandlerNames.constants.
        line: 78,
        calls: [cl('dot', 'forName', { receiver: 'Type', argTexts: ['VtxHandlerNames.COMPUTED_HANDLER_NAME'], line: 79, lineText: 'Type.forName(VtxHandlerNames.COMPUTED_HANDLER_NAME);' })],
      }),
      mth('createFromTernary', {
        // (c) positive: ternary of two string literals -> BOTH candidates.
        line: 87,
        params: [{ name: 'escalate', type: 'Boolean' }],
        calls: [
          cl('dot', 'forName', {
            receiver: 'Type',
            argTexts: ["escalate ? 'VtxLegacyHandler' : 'VtxRouterHandler'"],
            line: 88,
            lineText: "Type.forName(escalate ? 'VtxLegacyHandler' : 'VtxRouterHandler');",
          }),
        ],
      }),
      mth('createFromNamespacedLiteral', {
        // (d) positive: a literal naming a foreign-namespace 2-segment
        // token falls through to the SAME external-node machinery a
        // genuine ns.Class(...) call site already uses.
        line: 100,
        calls: [cl('dot', 'forName', { receiver: 'Type', argTexts: ["'zenq.Billing'"], line: 101, lineText: "Type.forName('zenq.Billing');" })],
      }),
      mth('createFromParam', {
        // (e) negative: a method PARAMETER never appears in
        // MethodFacts.locals at all -- no literal is ever recorded.
        line: 112,
        params: [{ name: 'handlerName', type: 'String' }],
        calls: [cl('dot', 'forName', { receiver: 'Type', argTexts: ['handlerName'], line: 113, lineText: 'Type.forName(handlerName);' })],
      }),
    ],
  });

  // Pre-existing GENUINE external Apex call site (mirrors gauntlet-org's
  // v0.8-A1 VertexLedgerBridge.charge shape) -- sets up the SAME external
  // node (d)'s literal must attach an additional, DISTINCT site to.
  const VtxLedgerBridgeProbe = ty('VtxLedgerBridgeProbe', 'VtxLedgerBridgeProbe', {
    methods: [
      mth('chargeLedger', {
        line: 1,
        calls: [cl('dot', 'charge', { receiver: 'zenq.Billing', argTexts: ['amount'], line: 2, lineText: 'zenq.Billing.charge(amount);' })],
      }),
    ],
  });

  const index = buildSemanticIndex([
    mkFile(VtxHandlerNames), mkFile(VtxRouterHandler), mkFile(VtxLegacyHandler), mkFile(VtxEscalationHandler),
    mkFile(VtxDynamicFactory), mkFile(VtxLedgerBridgeProbe),
  ]);

  // (a) positive.
  const routerTree = buildCallerTree(index, { classLower: 'vtxrouterhandler', methodLower: '<init>' });
  const literalLocalCaller = findChild(routerTree.root.children, 'VtxDynamicFactory.createFromLiteralLocal');
  assert.ok(literalLocalCaller, 'v0.11/B1(a): a single-assignment literal local, never reassigned, must resolve exactly like an inline literal would');
  assert.strictEqual(literalLocalCaller.via, 'dynamic');
  assert.strictEqual(literalLocalCaller.approximate, true);

  // (a-neg) negative -- no edge to EITHER the local's original literal
  // value (VtxRouterHandler) or its reassigned one (VtxLegacyHandler).
  assert.strictEqual(findChild(routerTree.root.children, 'VtxDynamicFactory.createFromReassignedLocal'), undefined, "v0.11/B1(a-neg): a reassigned local must never resolve to its ORIGINAL literal value (VtxRouterHandler)");
  const legacyTree = buildCallerTree(index, { classLower: 'vtxlegacyhandler', methodLower: '<init>' });
  assert.strictEqual(findChild(legacyTree.root.children, 'VtxDynamicFactory.createFromReassignedLocal'), undefined, "v0.11/B1(a-neg): nor to its REASSIGNED value (VtxLegacyHandler) -- the parser's no-reassignment proof is purely syntactic, unconditional");

  // (b) positive: own-class bare constant.
  const escalationTree = buildCallerTree(index, { classLower: 'vtxescalationhandler', methodLower: '<init>' });
  const ownConstantCaller = findChild(escalationTree.root.children, 'VtxDynamicFactory.createFromOwnConstant');
  assert.ok(ownConstantCaller, "v0.11/B1(b): a bare reference to the CALLING class's own static final String constant must resolve");
  assert.strictEqual(ownConstantCaller.via, 'dynamic');
  assert.strictEqual(ownConstantCaller.approximate, true);

  // (b) positive: cross-class qualified constant.
  const crossClassConstantCaller = findChild(routerTree.root.children, 'VtxDynamicFactory.createFromCrossClassConstant');
  assert.ok(crossClassConstantCaller, "v0.11/B1(b): a QUALIFIED ClassName.CONST reference to a DIFFERENT class's static final String constant must resolve");
  assert.strictEqual(crossClassConstantCaller.via, 'dynamic');
  assert.strictEqual(crossClassConstantCaller.approximate, true);

  // (b-neg v1/v2): neither cross-class field ever qualifies, regardless of
  // their (real, coincidentally class-naming) literal payloads.
  assert.strictEqual(findChild(legacyTree.root.children, 'VtxDynamicFactory.createFromNonFinalCrossClassField'), undefined, 'v0.11/B1(b-neg v1): a non-final field must never appear in TypeFacts.constants');
  assert.strictEqual(index.methodCallers.get('vtxcomputedhandler#<init>'), undefined, 'v0.11/B1(b-neg v2): moot regardless -- no VtxComputedHandler class exists anywhere in this fixture set');
  let sawEitherNegFieldCtorEdge = false;
  for (const sites of index.methodCallers.values()) {
    for (const s of sites) {
      if ((s.callerMethod === 'createFromComputedCrossClassField' || s.callerMethod === 'createFromNonFinalCrossClassField') && s.via === 'dynamic') {
        sawEitherNegFieldCtorEdge = true;
      }
    }
  }
  assert.strictEqual(sawEitherNegFieldCtorEdge, false, 'v0.11/B1(b-neg v1/v2): neither cross-class field ever produces ANY dynamic edge, to any target');

  // (c) positive: ONE call site, TWO edges.
  const ternaryToLegacy = findChild(legacyTree.root.children, 'VtxDynamicFactory.createFromTernary');
  assert.ok(ternaryToLegacy, "v0.11/B1(c): the ternary's THEN-branch literal (VtxLegacyHandler) must resolve");
  assert.strictEqual(ternaryToLegacy.via, 'dynamic');
  assert.strictEqual(ternaryToLegacy.approximate, true);
  const ternaryToRouter = findChild(routerTree.root.children, 'VtxDynamicFactory.createFromTernary');
  assert.ok(ternaryToRouter, "v0.11/B1(c): the ternary's ELSE-branch literal (VtxRouterHandler) must ALSO resolve");
  assert.strictEqual(ternaryToRouter.via, 'dynamic');
  assert.strictEqual(ternaryToRouter.approximate, true);

  // (d) positive: attaches to the SAME external node the pre-existing
  // genuine Apex call already created, via='dynamic'/approximate:true --
  // NOT 'external'/false (that vocabulary is reserved for a genuinely
  // syntactic ns.Class(...) call expression, per N2).
  const zenqBilling = index.externals.get('zenq.billing');
  assert.ok(zenqBilling, "v0.11/B1(d): Type.forName('zenq.Billing') must attach to the SAME external node the pre-existing zenq.Billing.charge(...) call site created");
  assert.strictEqual(zenqBilling.refCount, 2, 'v0.11/B1(d): ONE new site on the pre-existing node -- 1 (charge) + 1 (createFromNamespacedLiteral) = 2');
  const billingCallerTree = buildCallerTree(index, { classLower: 'zenq.billing', methodLower: null });
  const namespacedLiteralCaller = findChild(billingCallerTree.root.children, 'VtxDynamicFactory.createFromNamespacedLiteral');
  assert.ok(namespacedLiteralCaller, "v0.11/B1(d): the new site must be traceable from the external node's own \"who calls this\" tree");
  assert.strictEqual(namespacedLiteralCaller.via, 'dynamic');
  assert.strictEqual(namespacedLiteralCaller.approximate, true);
  const chargeCaller = findChild(billingCallerTree.root.children, 'VtxLedgerBridgeProbe.chargeLedger');
  assert.ok(chargeCaller, 'the pre-existing genuine Apex call site must be UNCHANGED, still present alongside the new one');
  assert.strictEqual(chargeCaller.via, 'external', "v0.11/B1(d): the pre-existing genuine call site must keep via='external'/approximate:false -- B1 must never retroactively relabel it");
  assert.strictEqual(chargeCaller.approximate, false);

  // (e) negative.
  assert.strictEqual(findChild(routerTree.root.children, 'VtxDynamicFactory.createFromParam'), undefined, 'v0.11/B1(e): a param-fed arg must never resolve -- it is never a local declaration, regardless of what it might hold at runtime');

  // 4 genuine negatives (a-neg, b-neg v1, b-neg v2, e) -> exactly 4
  // unresolved sites; the pre-existing external Apex call site must NOT
  // inflate this count (v0.8/N2's own "namespaced call is no longer
  // counted as unresolved" convention, unaffected by B1).
  assert.strictEqual(index.stats.unresolvedSites, 4, 'v0.11/B1: exactly the 4 genuinely-dropped call sites (a-neg, b-neg v1, b-neg v2, e) count as unresolved');
}

// =========================================================================
// v0.11/B2: generic-DML narrowing -- when a DML statement's target is a
// LOCAL variable of generic SObject-collection type, intra-method
// add/addAll evidence on that SAME variable narrows the DML to real
// objects, replacing the honest "DML on unresolved SObject type" marker
// with per-type ~dml edges (approximate:true); zero valid evidence leaves
// the marker exactly as today. Fixture shape mirrors gauntlet-org's
// GROUND-TRUTH.md v0.11-B2 section (VtxUnitOfWorkNarrowing +
// KappaShipmentTrigger, plus a promoted-regression analog of the
// pre-existing KappaUnitOfWork.commitWork) 1:1.
// =========================================================================
{
  const V11KappaOrderTrigger = ty('V11KappaOrderTrigger', 'V11KappaOrderTrigger', { methods: [mth('(trigger)', { line: 1 })] });
  const V11KappaOrderTriggerFile = file(PT('V11KappaOrderTrigger'), 'trigger', [V11KappaOrderTrigger], {
    triggerInfo: { object: 'Kappa_Order__c', events: ['before insert', 'after insert', 'after update'] },
  });
  const V11KappaOrderUowTrigger = ty('V11KappaOrderUowTrigger', 'V11KappaOrderUowTrigger', { methods: [mth('(trigger)', { line: 1 })] });
  const V11KappaOrderUowTriggerFile = file(PT('V11KappaOrderUowTrigger'), 'trigger', [V11KappaOrderUowTrigger], {
    triggerInfo: { object: 'Kappa_Order__c', events: ['after insert'] },
  });
  const KappaShipmentTrigger = ty('KappaShipmentTrigger', 'KappaShipmentTrigger', { methods: [mth('(trigger)', { line: 1 })] });
  const KappaShipmentTriggerFile = file(PT('KappaShipmentTrigger'), 'trigger', [KappaShipmentTrigger], {
    triggerInfo: { object: 'Kappa_Shipment__c', events: ['before insert', 'after insert'] },
  });

  const VtxUnitOfWorkNarrowing = ty('VtxUnitOfWorkNarrowing', 'VtxUnitOfWorkNarrowing', {
    methods: [
      mth('commitBothTypes', {
        // both-types union: TWO add() calls, TWO distinct concrete types.
        line: 14,
        locals: [{ name: 'pending', type: 'List<SObject>', line: 15 }],
        calls: [
          cl('dot', 'add', { receiver: 'pending', argTexts: ["new Kappa_Order__c(Name = 'ord-1')"], line: 16, lineText: "pending.add(new Kappa_Order__c(Name = 'ord-1'));" }),
          cl('dot', 'add', { receiver: 'pending', argTexts: ["new Kappa_Shipment__c(Name = 'shp-1')"], line: 17, lineText: "pending.add(new Kappa_Shipment__c(Name = 'shp-1'));" }),
        ],
        dml: [dmlFact('insert', 'pending', { line: 18, lineText: 'insert pending;' })],
      }),
      mth('commitTypedOrdersViaAddAll', {
        // addAll-from-a-typed-List<Kappa_Order__c>-local: a simple
        // identifier evidence arg, resolved via the type env's DECLARED
        // type, not however it happened to be initialized.
        line: 25,
        locals: [
          { name: 'pending', type: 'List<SObject>', line: 26 },
          { name: 'typedOrders', type: 'List<Kappa_Order__c>', line: 27 },
        ],
        calls: [cl('dot', 'addAll', { receiver: 'pending', argTexts: ['typedOrders'], line: 28, lineText: 'pending.addAll(typedOrders);' })],
        dml: [dmlFact('insert', 'pending', { line: 29, lineText: 'insert pending;' })],
      }),
      mth('commitWithNoInMethodEvidence', {
        // zero in-method add/addAll evidence -- verb deliberately `update`,
        // not `insert`, to prove the marker's persistence is DML-verb-
        // independent.
        line: 37,
        locals: [{ name: 'pending', type: 'List<SObject>', line: 38 }],
        dml: [dmlFact('update', 'pending', { line: 39, lineText: 'update pending;' })],
      }),
      mth('commitWithComplexExpressionEvidence', {
        // a method-call-result add() argument matches NEITHER the
        // 'new Concrete__c(' pattern NOR a bare identifier -- must NOT
        // narrow (cross-method return-type inference is out of scope).
        line: 49,
        locals: [{ name: 'pending', type: 'List<SObject>', line: 50 }],
        calls: [cl('dot', 'add', { receiver: 'pending', argTexts: ['locateExistingOrder()'], line: 51, lineText: 'pending.add(locateExistingOrder());' })],
        dml: [dmlFact('insert', 'pending', { line: 52, lineText: 'insert pending;' })],
      }),
    ],
  });

  // B2-ii: a promoted-regression analog of the real pre-existing
  // KappaUnitOfWork.commitWork -- its `records` local has ZERO in-method
  // add/addAll evidence (the real .add() calls live in the SIBLING method
  // registerNew, out of scope by construction: same-METHOD evidence only).
  const V11KappaUnitOfWork = ty('V11KappaUnitOfWork', 'V11KappaUnitOfWork', {
    methods: [
      mth('commitWork', {
        line: 1,
        locals: [{ name: 'records', type: 'List<SObject>', line: 2 }],
        dml: [dmlFact('insert', 'records', { line: 3, lineText: 'insert records;' })],
      }),
      mth('registerNew', {
        // sibling method -- its OWN add() call on its OWN local must NOT
        // leak into commitWork's evidence gathering (same-method-only).
        line: 5,
        locals: [{ name: 'records', type: 'List<SObject>', line: 6 }],
        calls: [cl('dot', 'add', { receiver: 'records', argTexts: ["new Kappa_Order__c(Name = 'sibling')"], line: 7, lineText: "records.add(new Kappa_Order__c(Name = 'sibling'));" })],
      }),
    ],
  });

  const index = buildSemanticIndex([
    mkFile(VtxUnitOfWorkNarrowing), mkFile(V11KappaUnitOfWork),
    V11KappaOrderTriggerFile, V11KappaOrderUowTriggerFile, KappaShipmentTriggerFile,
  ]);

  // commitBothTypes: 3 narrowed edges total (2 on Kappa_Order__c's two
  // triggers, 1 on Kappa_Shipment__c's one trigger), marker gone.
  // v0.13/H2: showUnconfirmed:'expand' -- every child here (3 narrowed
  // approximate 'dml' edges + the approximate unresolved-aggregate leaf) is
  // approximate:true, so 'rollup' would otherwise fold the 3 narrowed edges
  // into one pseudo-node (the unresolved leaf is appended separately, by
  // appendCalleeExtras, AFTER buildChildrenLevel's own grouping runs, so it
  // never joins the rollup); this block's own point is the flat B2
  // narrowing shape, so 'expand' keeps it byte-identical to pre-H2.
  const bothTypesTree = buildCalleeTree(index, { classLower: 'vtxunitofworknarrowing', methodLower: 'commitBothTypes' }, { showUnconfirmed: 'expand' });
  assert.strictEqual(findChild(bothTypesTree.root.children, 'DML on unresolved SObject type'), undefined, 'v0.11/B2: the honest marker must be REPLACED once narrowing evidence exists');
  const orderTriggerChild = findChild(bothTypesTree.root.children, 'V11KappaOrderTrigger');
  assert.ok(orderTriggerChild, 'v0.11/B2: commitBothTypes narrows to Kappa_Order__c -> V11KappaOrderTrigger (before insert, after insert -- matches)');
  assert.strictEqual(orderTriggerChild.via, 'dml');
  assert.strictEqual(orderTriggerChild.approximate, true, "v0.11/B2: narrowed edges stay via='dml' (the trigger genuinely fires) but ARE approximate (the object identity is an inference)");
  const orderUowTriggerChild = findChild(bothTypesTree.root.children, 'V11KappaOrderUowTrigger');
  assert.ok(orderUowTriggerChild, 'v0.11/B2: commitBothTypes ALSO narrows to Kappa_Order__c -> V11KappaOrderUowTrigger (after insert -- matches)');
  assert.strictEqual(orderUowTriggerChild.approximate, true);
  const shipmentTriggerChild = findChild(bothTypesTree.root.children, 'KappaShipmentTrigger');
  assert.ok(shipmentTriggerChild, 'v0.11/B2: commitBothTypes ALSO narrows to Kappa_Shipment__c -> KappaShipmentTrigger (before insert, after insert -- matches)');
  assert.strictEqual(shipmentTriggerChild.approximate, true);
  // The two evidence-gathering List.add(...) calls are known platform calls,
  // so they neither become Apex edges nor unresolved-call noise.
  assert.strictEqual(findChild(bothTypesTree.root.children, '2 unresolved sites'), undefined);
  assert.strictEqual(bothTypesTree.root.children.length, 3, 'exactly 3 narrowed trigger edges, nothing else');

  // Same 3 edges, symmetric caller-direction check (who calls each trigger).
  const orderTriggerCallerTree = buildCallerTree(index, { classLower: 'v11kappaordertrigger', methodLower: null });
  const bothTypesAsOrderCaller = findChild(orderTriggerCallerTree.root.children, 'VtxUnitOfWorkNarrowing.commitBothTypes');
  assert.ok(bothTypesAsOrderCaller, 'v0.11/B2: caller-direction symmetry -- V11KappaOrderTrigger must list commitBothTypes as a (narrowed) caller');
  assert.strictEqual(bothTypesAsOrderCaller.via, 'dml');
  assert.strictEqual(bothTypesAsOrderCaller.approximate, true);
  const shipmentTriggerCallerTree = buildCallerTree(index, { classLower: 'kappashipmenttrigger', methodLower: null });
  const bothTypesAsShipmentCaller = findChild(shipmentTriggerCallerTree.root.children, 'VtxUnitOfWorkNarrowing.commitBothTypes');
  assert.ok(bothTypesAsShipmentCaller, "v0.11/B2: KappaShipmentTrigger's FIRST-EVER DML/trigger linkage in this fixture set");
  assert.strictEqual(bothTypesAsShipmentCaller.approximate, true);

  // commitTypedOrdersViaAddAll: narrows via the addAll-of-a-typed-local
  // shape -> Kappa_Order__c's 2 triggers, marker gone.
  // v0.13/H2: showUnconfirmed:'expand' -- same reasoning as commitBothTypes
  // above (both narrowed-dml children are approximate:true).
  const addAllTree = buildCalleeTree(index, { classLower: 'vtxunitofworknarrowing', methodLower: 'commitTypedOrdersViaAddAll' }, { showUnconfirmed: 'expand' });
  assert.strictEqual(findChild(addAllTree.root.children, 'DML on unresolved SObject type'), undefined, 'v0.11/B2: addAll-of-a-typed-List<Concrete__c> local must ALSO narrow (not just inline new Concrete__c(...))');
  const addAllOrderTrigger = findChild(addAllTree.root.children, 'V11KappaOrderTrigger');
  assert.ok(addAllOrderTrigger);
  assert.strictEqual(addAllOrderTrigger.approximate, true);
  const addAllOrderUowTrigger = findChild(addAllTree.root.children, 'V11KappaOrderUowTrigger');
  assert.ok(addAllOrderUowTrigger);
  assert.strictEqual(findChild(addAllTree.root.children, 'KappaShipmentTrigger'), undefined, 'must NOT ALSO narrow to Kappa_Shipment__c -- only Kappa_Order__c evidence exists in this method');
  assert.strictEqual(findChild(addAllTree.root.children, '1 unresolved site'), undefined, 'known List.addAll(...) is not unresolved Apex dispatch');
  assert.strictEqual(addAllTree.root.children.length, 2, 'exactly 2 narrowed trigger edges, nothing else');

  // commitWithNoInMethodEvidence: zero evidence -> marker stays exactly as
  // today, DML-verb-independent (this one is `update`, not `insert`).
  const noEvidenceTree = buildCalleeTree(index, { classLower: 'vtxunitofworknarrowing', methodLower: 'commitWithNoInMethodEvidence' });
  const noEvidenceMarker = findChild(noEvidenceTree.root.children, 'DML on unresolved SObject type');
  assert.ok(noEvidenceMarker, 'v0.11/B2: zero add/addAll evidence anywhere in the method -- the honest marker must stay exactly as pre-B2');
  assert.strictEqual(noEvidenceMarker.via, 'dml-unresolved');
  assert.strictEqual(noEvidenceMarker.approximate, true);
  assert.strictEqual(findChild(noEvidenceTree.root.children, 'V11KappaOrderTrigger'), undefined);
  assert.strictEqual(findChild(noEvidenceTree.root.children, 'KappaShipmentTrigger'), undefined);

  // commitWithComplexExpressionEvidence: the one candidate piece of
  // "evidence" doesn't qualify (a method-call-result argument) -> marker
  // stays, zero narrowed edges -- must NOT infer from the callee's return
  // type (explicitly out of scope).
  const complexExprTree = buildCalleeTree(index, { classLower: 'vtxunitofworknarrowing', methodLower: 'commitWithComplexExpressionEvidence' });
  assert.ok(findChild(complexExprTree.root.children, 'DML on unresolved SObject type'), 'v0.11/B2: a method-call-result add() argument must NOT count as narrowing evidence');
  assert.strictEqual(findChild(complexExprTree.root.children, 'V11KappaOrderTrigger'), undefined, 'must NOT narrow to Kappa_Order__c even though locateExistingOrder() happens to RETURN that type -- cross-method inference is out of scope');
  assert.strictEqual(complexExprTree.root.children.length, 1, 'only the honest DML marker remains; known List.add(...) is not unresolved Apex dispatch');

  // B2-ii promoted regression: real pre-existing-shaped commitWork, zero
  // in-method evidence (the real add() lives in the sibling registerNew)
  // -> marker stays, proving the zero-evidence path against non-fixture-
  // purpose-built code too.
  const commitWorkTree = buildCalleeTree(index, { classLower: 'v11kappaunitofwork', methodLower: 'commitWork' });
  const commitWorkMarker = findChild(commitWorkTree.root.children, 'DML on unresolved SObject type');
  assert.ok(commitWorkMarker, 'v0.11/B2-ii: commitWork keeps the honest marker -- its own add() calls live in a DIFFERENT method, out of scope by construction');
  assert.strictEqual(commitWorkMarker.approximate, true);
  assert.strictEqual(findChild(commitWorkTree.root.children, 'V11KappaOrderTrigger'), undefined, "sibling method registerNew's evidence must never leak into commitWork's own narrowing");
}

// =========================================================================
// v0.11 Round B BUG FIX #1: TERNARY_LITERAL_RE (now matchTernaryStringLiterals)
// was too permissive -- its old regex could match a ternary-of-two-literals
// NESTED INSIDE an unrelated wrapping call expression. Type.forName's real
// argument here is `someWrapper(...)`, a call expression whose return value
// is arbitrary and unknown at parse time -- per the B1 contract this must
// stay unresolved, exactly like any other non-literal expression would.
// Repro mirrors the confirmed defect verbatim.
// =========================================================================
{
  const Bug1FooHandler = ty('Bug1FooHandler', 'Bug1FooHandler', { methods: [] });
  const Bug1BarHandler = ty('Bug1BarHandler', 'Bug1BarHandler', { methods: [] });
  const Bug1Caller = ty('Bug1Caller', 'Bug1Caller', {
    methods: [
      mth('go2', {
        line: 1,
        params: [{ name: 'x', type: 'Boolean' }],
        calls: [
          cl('dot', 'forName', {
            receiver: 'Type',
            argTexts: ["someWrapper(x ? 'Bug1FooHandler' : 'Bug1BarHandler')"],
            line: 2,
            lineText: "Type t = Type.forName(someWrapper(x ? 'Bug1FooHandler' : 'Bug1BarHandler'));",
          }),
        ],
      }),
    ],
  });
  const index = buildSemanticIndex([mkFile(Bug1FooHandler), mkFile(Bug1BarHandler), mkFile(Bug1Caller)]);
  const tree = buildCalleeTree(index, { classLower: 'bug1caller', methodLower: 'go2' });
  assert.strictEqual(findChild(tree.root.children, 'Bug1FooHandler.<init>'), undefined, "BUG FIX regression: a ternary NESTED inside a wrapping call expression (someWrapper(x ? 'A' : 'B')) must NOT produce a dynamic ctor edge for the THEN branch");
  assert.strictEqual(findChild(tree.root.children, 'Bug1BarHandler.<init>'), undefined, 'BUG FIX regression: ...nor the ELSE branch -- the ternary is not Type.forName\'s actual argument, the wrapping call expression is');
  assert.strictEqual(tree.root.children.length, 0, 'no callee-tree children at all -- the call-expression argument produces zero edges, exactly like any other non-literal expression');
  assert.strictEqual(index.stats.unresolvedSites, 1, 'the call-expression argument must instead count as an ordinary genuinely-dropped/unresolved site (H4), same as any other non-literal expression');
}

// =========================================================================
// v0.11 Round B BUG FIX #2: tryNarrowGenericDml ignored source-code
// position -- add()/addAll() evidence written AFTER the DML statement
// still narrowed the edge, even though the collection is provably EMPTY
// at the moment the real insert/update/etc. actually runs. Repro mirrors
// the confirmed defect verbatim (evidence call textually after the DML
// statement's own line).
// =========================================================================
{
  const Bug2OrderTrigger = ty('Bug2OrderTrigger', 'Bug2OrderTrigger', { methods: [mth('(trigger)', { line: 1 })] });
  const Bug2OrderTriggerFile = file(PT('Bug2OrderTrigger'), 'trigger', [Bug2OrderTrigger], {
    triggerInfo: { object: 'Bug2_Order__c', events: ['after insert'] },
  });
  const Bug2PostDmlEvidence = ty('Bug2PostDmlEvidence', 'Bug2PostDmlEvidence', {
    methods: [
      mth('commitThenAdd', {
        line: 1,
        locals: [{ name: 'pending', type: 'List<SObject>', line: 2 }],
        // BUG repro: the DML statement runs FIRST (line 3); the add() call
        // -- the only candidate evidence in this method -- comes AFTER it
        // (line 4). At the moment `insert pending;` actually executes,
        // `pending` is provably empty, so this can never describe real
        // narrowing evidence.
        dml: [dmlFact('insert', 'pending', { line: 3, lineText: 'insert pending;' })],
        calls: [cl('dot', 'add', { receiver: 'pending', argTexts: ["new Bug2_Order__c(Name = 'late')"], line: 4, lineText: "pending.add(new Bug2_Order__c(Name = 'late'));" })],
      }),
    ],
  });
  const index = buildSemanticIndex([mkFile(Bug2PostDmlEvidence), Bug2OrderTriggerFile]);
  const tree = buildCalleeTree(index, { classLower: 'bug2postdmlevidence', methodLower: 'commitThenAdd' });
  assert.strictEqual(findChild(tree.root.children, 'Bug2OrderTrigger'), undefined, 'BUG FIX regression: add() evidence written AFTER the DML statement must NOT narrow the edge -- the collection is provably empty at real insert time');
  const marker = findChild(tree.root.children, 'DML on unresolved SObject type');
  assert.ok(marker, 'BUG FIX regression: with the only candidate evidence disqualified by position, the honest unresolved marker must stay exactly as it would with zero evidence at all');
  assert.strictEqual(marker.via, 'dml-unresolved');
  assert.strictEqual(marker.approximate, true);
}

// =========================================================================
// v0.11 Round B BUG FIX #3: the B1(b) dotted 'ClassName.CONST' branch called
// plain resolveType() directly, bypassing the SAME classBuckets/
// resolveDuplicateBucket ambiguity machinery ordinary static dispatch
// (resolveDotOther rule 5) already uses for a duplicated class name --
// silently picking an arbitrary, parse-order-dependent single candidate
// instead of failing safely or fanning out via='ambiguous'. Fixture shape
// mirrors the pre-existing B3 ambiguous-fan-out contrast test above (W7Dup2
// duplicated ONLY across pkgB/pkgC, caller in pkgA -- neither same-package
// nor default-package preference can disambiguate, so genuine ambiguity is
// reachable).
// =========================================================================
{
  const Bug3HandlerB = ty('Bug3Handler', 'Bug3Handler', { constants: [{ name: 'NAME', literal: 'Bug3FromB' }], methods: [mth('run', { line: 1, isStatic: true })] });
  const Bug3HandlerC = ty('Bug3Handler', 'Bug3Handler', { constants: [{ name: 'NAME', literal: 'Bug3FromC' }], methods: [mth('run', { line: 1, isStatic: true })] });
  const Bug3FromB = ty('Bug3FromB', 'Bug3FromB', { methods: [] });
  const Bug3FromC = ty('Bug3FromC', 'Bug3FromC', { methods: [] });
  const Bug3AmbigCaller = ty('Bug3AmbigCaller', 'Bug3AmbigCaller', {
    methods: [
      mth('go', { line: 1, calls: [cl('dot', 'forName', { receiver: 'Type', argTexts: ['Bug3Handler.NAME'], line: 1, lineText: 'Type.forName(Bug3Handler.NAME);' })] }),
      mth('goOrdinary', { line: 2, calls: [cl('dot', 'run', { receiver: 'Bug3Handler', line: 2, lineText: 'Bug3Handler.run();' })] }),
    ],
  });
  const facts = [
    file('/ws/pkgB/classes/Bug3Handler.cls', 'class', [Bug3HandlerB]),
    file('/ws/pkgC/classes/Bug3Handler.cls', 'class', [Bug3HandlerC]),
    file('/ws/pkgB/classes/Bug3FromB.cls', 'class', [Bug3FromB]),
    file('/ws/pkgC/classes/Bug3FromC.cls', 'class', [Bug3FromC]),
    file('/ws/pkgA/classes/Bug3AmbigCaller.cls', 'class', [Bug3AmbigCaller]),
  ];
  const index = buildSemanticIndex(facts, { packageOf: w7PackageOf, defaultPackage: W7_DEFAULT_PACKAGE });
  assert.strictEqual(index.stats.duplicateNames, 1, 'sanity: Bug3Handler must actually be an ambiguous duplicate in this fixture (same shape B3 already relies on)');

  // v0.13/H2: showUnconfirmed:'expand' -- this regression's own point is the
  // flat fan-out shape (both distinct ambiguous candidates as siblings).
  const calleeTree = buildCalleeTree(index, { classLower: 'bug3ambigcaller', methodLower: 'go' }, { showUnconfirmed: 'expand' });
  const dynTargets = calleeTree.root.children.map((c) => c.label).sort();
  assert.deepStrictEqual(dynTargets, ['Bug3FromB.<init>', 'Bug3FromC.<init>'], "BUG FIX regression: Type.forName(Bug3Handler.NAME) must fan out to BOTH ambiguous candidates' OWN literal values (FromB from pkgB's Handler, FromC from pkgC's), never an arbitrary parse-order-dependent single pick");
  for (const c of calleeTree.root.children) {
    assert.strictEqual(c.via, 'ambiguous', "BUG FIX regression: each fanned-out edge must be via='ambiguous' -- 'dynamic' would look identical to an honest, unambiguous single-candidate resolution and hide the guess");
    assert.strictEqual(c.approximate, true);
  }

  // Contrast: ordinary Bug3Handler.run() dispatch, from the SAME caller, on
  // the SAME ambiguous class, must fan out identically -- proving B1(b) is
  // now consistent with pre-existing dispatch instead of secretly using a
  // different (unsafe) resolution path.
  // v0.13/H2: showUnconfirmed:'expand' -- flat fan-out shape is this
  // assertion's own point (both candidates as direct siblings).
  const ordinaryTree = buildCalleeTree(index, { classLower: 'bug3ambigcaller', methodLower: 'goOrdinary' }, { showUnconfirmed: 'expand' });
  assert.strictEqual(ordinaryTree.root.children.length, 2, 'ordinary Bug3Handler.run() dispatch also fans out to both ambiguous candidates, matching B1(b)\'s new shape');
  for (const c of ordinaryTree.root.children) {
    assert.strictEqual(c.label, 'Bug3Handler.run');
    assert.strictEqual(c.via, 'ambiguous');
  }
}

// =========================================================================
// v0.12/C1: buildEntryCatalog(index) -- Entry Point Catalog
//
// Self-contained fixture workspace ('EC' prefix), covering: every one of
// the 10 catalog kinds, the dual-annotation case (one method, two catalog
// kinds), isTest exclusion (counted per label, not per method), dedupe
// (two same-qualified-name classes across packages sharing one entry-
// annotated method identity collapse to ONE entry), package labels (both
// the default-package-nulls-out rule and a real non-default label),
// stable sort-by-label within a kind, the fixed 10-kind group order, the
// REST multi-verb join format (explicitly flagged as untested-by-either-
// corpus, so pinned here), and determinism (deep-equal across two calls).
// =========================================================================

function ecPackageOf(fsPath) {
  const m = /\/ws\/ec\/(pkgA|pkgB|pkgC)\//.exec(fsPath || '');
  return m ? m[1] : null;
}
const EC_DEFAULT_PACKAGE = 'pkgA';
const ECP = (pkg, name) => `/ws/ec/${pkg}/classes/${name}.cls`;

// ---- trigger ------------------------------------------------------------
const ECOrderTriggerType = ty('ECOrderTrigger', 'ECOrderTrigger', {
  methods: [mth('(trigger)', { line: 1 })],
});
const ECOrderTriggerFile = file('/ws/ec/triggers/ECOrderTrigger.trigger', 'trigger', [ECOrderTriggerType], {
  // declaration order must survive verbatim into detail (not alphabetized).
  triggerInfo: { object: 'EC_Order__c', events: ['after update', 'after insert'] },
});

// ---- aura -----------------------------------------------------------------
const ECAuraSvc = ty('ECAuraSvc', 'ECAuraSvc', {
  methods: [mth('getData', { line: 1, annotations: ['auraenabled'] })],
});

// ---- invocable (one default-package, one non-default-package) -----------
const ECInvocableAction = ty('ECInvocableAction', 'ECInvocableAction', {
  methods: [mth('run', { line: 1, annotations: ['invocablemethod'] })],
});
const ECPkgDefaultClass = ty('ECPkgDefaultClass', 'ECPkgDefaultClass', {
  methods: [mth('run', { line: 1, annotations: ['invocablemethod'] })],
});
const ECPkgOtherClass = ty('ECPkgOtherClass', 'ECPkgOtherClass', {
  methods: [mth('run', { line: 1, annotations: ['invocablemethod'] })],
});

// ---- rest: two single-verb methods + one dual-verb method (join-format
// pin -- neither real corpus has a >1-HTTP-verb method) ---------------------
const ECRestResource = ty('ECRestResource', 'ECRestResource', {
  methods: [
    mth('handleGet', { line: 1, annotations: ['httpget'] }),
    mth('handlePost', { line: 2, annotations: ['httppost'] }),
    // Declaration order (httppost before httpget) deliberately non-
    // alphabetical, to prove the join preserves source order rather than
    // sorting the verbs.
    mth('handleBoth', { line: 3, annotations: ['httppost', 'httpget'] }),
  ],
});

// ---- soap -----------------------------------------------------------------
const ECSoapSvc = ty('ECSoapSvc', 'ECSoapSvc', {
  methods: [mth('doWork', { line: 1, modifiers: ['webservice'] })],
});

// ---- async: Batchable (3 entries from 1 class), Queueable, Schedulable,
// @future -------------------------------------------------------------------
const ECBatchJob = ty('ECBatchJob', 'ECBatchJob', {
  implementsTypes: ['Database.Batchable<sObject>'],
  methods: [
    mth('start', { line: 1, params: [{ name: 'bc', type: 'Database.BatchableContext' }] }),
    mth('execute', { line: 2, params: [{ name: 'bc', type: 'Database.BatchableContext' }, { name: 'scope', type: 'List<SObject>' }] }),
    mth('finish', { line: 3, params: [{ name: 'bc', type: 'Database.BatchableContext' }] }),
  ],
});
const ECQueueableJob = ty('ECQueueableJob', 'ECQueueableJob', {
  implementsTypes: ['Queueable'],
  methods: [mth('execute', { line: 1, params: [{ name: 'ctx', type: 'QueueableContext' }] })],
});
const ECScheduledJob = ty('ECScheduledJob', 'ECScheduledJob', {
  implementsTypes: ['Schedulable'],
  methods: [mth('execute', { line: 1, params: [{ name: 'ctx', type: 'SchedulableContext' }] })],
});
const ECFutureSvc = ty('ECFutureSvc', 'ECFutureSvc', {
  methods: [mth('doAsync', { line: 1, isStatic: true, annotations: ['future'] })],
});

// ---- dual-annotation: ONE method, TWO different catalog kinds ------------
const ECDualKind = ty('ECDualKind', 'ECDualKind', {
  methods: [mth('doBoth', { line: 1, isStatic: true, annotations: ['auraenabled', 'future'] })],
});

// ---- isTest exclusion: a dual-annotation method inside an @isTest class,
// so the excluded count must be 2 (one per label), not 1 (per method) ------
const ECTestDualClass = ty('ECTestDualClass', 'ECTestDualClass', {
  annotations: ['istest'],
  methods: [mth('doBothTest', { line: 1, isStatic: true, annotations: ['auraenabled', 'future'] })],
});

// ---- email / platform -----------------------------------------------------
const ECEmailHandler = ty('ECEmailHandler', 'ECEmailHandler', {
  implementsTypes: ['Messaging.InboundEmailHandler'],
  methods: [mth('handleInboundEmail', { line: 1, params: [{ name: 'email', type: 'Messaging.InboundEmail' }, { name: 'env', type: 'Messaging.InboundEnvelope' }] })],
});
const ECInstallHandler = ty('ECInstallHandler', 'ECInstallHandler', {
  implementsTypes: ['InstallHandler'],
  methods: [mth('onInstall', { line: 1, params: [{ name: 'ctx', type: 'InstallContext' }] })],
});
const ECUninstallSvc = ty('ECUninstallSvc', 'ECUninstallSvc', {
  implementsTypes: ['UninstallHandler'],
  methods: [mth('onUninstall', { line: 1, params: [{ name: 'ctx', type: 'UninstallContext' }] })],
});
const ECRegHandler = ty('ECRegHandler', 'ECRegHandler', {
  implementsTypes: ['Auth.RegistrationHandler'],
  methods: [
    mth('createUser', { line: 1, params: [{ name: 'a', type: 'Id' }, { name: 'b', type: 'Auth.UserData' }] }),
    mth('updateUser', { line: 2, params: [{ name: 'a', type: 'Id' }, { name: 'b', type: 'Id' }, { name: 'c', type: 'Auth.UserData' }] }),
  ],
});
const ECComparableThing = ty('ECComparableThing', 'ECComparableThing', {
  implementsTypes: ['Comparable'],
  methods: [mth('compareTo', { line: 1, params: [{ name: 'other', type: 'Object' }] })],
});
const ECFinalizerThing = ty('ECFinalizerThing', 'ECFinalizerThing', {
  implementsTypes: ['System.Finalizer'],
  methods: [mth('execute', { line: 1, params: [{ name: 'ctx', type: 'System.FinalizerContext' }] })],
});

// ---- constructors are never entries (sanity) -------------------------------
const ECCtorOnly = ty('ECCtorOnly', 'ECCtorOnly', {
  methods: [mth('ECCtorOnly', { isCtor: true, line: 1 })],
});

// ---- dedupe across packages: SAME qualified name, SAME entry-annotated
// method, registered in pkgB then pkgC -- must collapse to ONE aura entry,
// attributed to the FIRST-registered (pkgB) candidate. ----------------------
const ECDupAuraB = ty('ECDupAura', 'ECDupAura', { methods: [mth('run', { line: 1, annotations: ['auraenabled'] })] });
const ECDupAuraC = ty('ECDupAura', 'ECDupAura', { methods: [mth('run', { line: 1, annotations: ['auraenabled'] })] });
const ecDupAuraBFile = file(ECP('pkgB', 'ECDupAura'), 'class', [ECDupAuraB]);
const ecDupAuraCFile = file(ECP('pkgC', 'ECDupAura'), 'class', [ECDupAuraC]);

const ecPkgDefaultFile = file(ECP('pkgA', 'ECPkgDefaultClass'), 'class', [ECPkgDefaultClass]);
const ecPkgOtherFile = file(ECP('pkgB', 'ECPkgOtherClass'), 'class', [ECPkgOtherClass]);

// ---- anonymous --------------------------------------------------------
const ECScriptType = ty('ECScript', 'ECScript', {
  methods: [mth('(anonymous)', { line: 1, entries: ['Anonymous Apex script'] })],
});
const ecScriptFile = file('/ws/ec/scripts/ECScript.apex', 'anonymous', [ECScriptType]);

const ecEntryCatalogFacts = [
  ECOrderTriggerFile,
  mkFile(ECAuraSvc),
  mkFile(ECInvocableAction),
  mkFile(ECRestResource),
  mkFile(ECSoapSvc),
  mkFile(ECBatchJob),
  mkFile(ECQueueableJob),
  mkFile(ECScheduledJob),
  mkFile(ECFutureSvc),
  mkFile(ECDualKind),
  mkFile(ECTestDualClass),
  mkFile(ECEmailHandler),
  mkFile(ECInstallHandler),
  mkFile(ECUninstallSvc),
  mkFile(ECRegHandler),
  mkFile(ECComparableThing),
  mkFile(ECFinalizerThing),
  mkFile(ECCtorOnly),
  ecDupAuraBFile,
  ecDupAuraCFile,
  ecPkgDefaultFile,
  ecPkgOtherFile,
  ecScriptFile,
];

const ecIndex = buildSemanticIndex(ecEntryCatalogFacts, { packageOf: ecPackageOf, defaultPackage: EC_DEFAULT_PACKAGE });

// ---- flow refs: record-triggered (2 actions, must pick the LOWER line),
// platform-event, screen/autolaunched-with-a-ref (no start info), and one
// externally-attached action (namespaced dotted fold-in, same detection
// shape v0.8/N1(c) already established) ------------------------------------
const ecFlowRefs = [
  {
    kind: 'flow', label: 'ECOrderFlow', className: 'ECFlowAction1', methodName: 'run',
    flowObject: 'EC_Order__c', flowRecordTriggerType: 'CreateAndUpdate', flowTriggerType: 'RecordAfterSave',
    path: '/ws/ec/flows/ECOrderFlow.flow-meta.xml', line: 5, lineText: '<actionName>ECFlowAction1.run</actionName>',
  },
  {
    kind: 'flow', label: 'ECOrderFlow', className: 'ECFlowAction2', methodName: 'run',
    flowObject: 'EC_Order__c', flowRecordTriggerType: 'CreateAndUpdate', flowTriggerType: 'RecordAfterSave',
    path: '/ws/ec/flows/ECOrderFlow.flow-meta.xml', line: 2, lineText: '<actionName>ECFlowAction2.run</actionName>',
  },
  {
    kind: 'flow', label: 'ECEventFlow', className: 'ECEventAction', methodName: null,
    flowObject: 'EC_Notify__e', flowRecordTriggerType: null, flowTriggerType: 'PlatformEvent',
    path: '/ws/ec/flows/ECEventFlow.flow-meta.xml', line: 1, lineText: '<actionName>ECEventAction</actionName>',
  },
  {
    kind: 'flow', label: 'ECScreenFlow', className: 'ECScreenAction', methodName: 'run',
    flowObject: null, flowRecordTriggerType: null, flowTriggerType: null,
    path: '/ws/ec/flows/ECScreenFlow.flow-meta.xml', line: 1, lineText: '<actionName>ECScreenAction.run</actionName>',
  },
  {
    // dotted fold-in ('zenq.ECExternalHandler.run') -> external node, same
    // detection shape as the existing v0.8/N1(c) flow fixture.
    kind: 'flow', label: 'ECExternalActionFlow', className: 'zenq', methodName: 'ECExternalHandler.run',
    flowObject: 'EC_External__c', flowRecordTriggerType: 'Create', flowTriggerType: 'RecordBeforeSave',
    path: '/ws/ec/flows/ECExternalActionFlow.flow-meta.xml', line: 3, lineText: '<actionName>zenq.ECExternalHandler.run</actionName>',
  },
];
attachMetaCallers(ecIndex, ecFlowRefs);

// Raw flow-file paths (v0.12/C1 extension point -- see buildEntryCatalog's
// own header note in resolver.js): ECOrderFlow.flow-meta.xml is ALREADY
// covered by a ref above (must NOT duplicate or override its real detail);
// ECZeroActionFlow.flow-meta.xml has no apex actionCalls at all and is
// otherwise completely invisible to this index.
ecIndex.flowFilePaths = [
  '/ws/ec/flows/ECOrderFlow.flow-meta.xml',
  '/ws/ec/flows/ECZeroActionFlow.flow-meta.xml',
];

const ecCatalog = buildEntryCatalog(ecIndex);

// ---- fixed 10-kind group order, always fully enumerated -------------------
{
  const kinds = ecCatalog.groups.map((g) => g.kind);
  assert.deepStrictEqual(kinds, ['trigger', 'aura', 'invocable', 'rest', 'soap', 'async', 'email', 'platform', 'flow', 'anonymous'], 'C1: groups must appear in exactly the contract-specified kind order, every kind present even when (soap/email here are non-empty, but the ORDER itself must never depend on data)');
}

function findEntry(catalog, kind, label) {
  const g = catalog.groups.find((x) => x.kind === kind);
  return g && g.entries.find((e) => e.label === label);
}
function entryLabels(catalog, kind) {
  const g = catalog.groups.find((x) => x.kind === kind);
  return g ? g.entries.map((e) => e.label) : [];
}

// ---- trigger ----------------------------------------------------------
{
  const e = findEntry(ecCatalog, 'trigger', 'ECOrderTrigger');
  assert.ok(e, 'trigger entry must be present');
  assert.strictEqual(e.detail, 'on EC_Order__c (after update, after insert)', 'trigger detail must be "on <Object> (<events>)" in SOURCE declaration order, not alphabetized');
  assert.strictEqual(e.className, 'ECOrderTrigger');
  assert.strictEqual(e.methodLower, '(trigger)');
  assert.strictEqual(e.package, null);
}

// ---- aura (plain + dual-annotation + dedupe-collapsed) ---------------------
{
  assert.deepStrictEqual(entryLabels(ecCatalog, 'aura'), ['ECAuraSvc.getData', 'ECDualKind.doBoth', 'ECDupAura.run'], 'aura group: 3 entries (plain + dual-kind + dedupe-collapsed), sorted by label');
  const plain = findEntry(ecCatalog, 'aura', 'ECAuraSvc.getData');
  assert.strictEqual(plain.detail, '@AuraEnabled (LWC/Aura)', "'others' kind: detail is the entry annotation label verbatim");
  const dup = findEntry(ecCatalog, 'aura', 'ECDupAura.run');
  assert.strictEqual(dup.path, ecDupAuraBFile.path, 'dedupe: the FIRST-registered (pkgB) candidate wins, matching this file\'s existing first-parsed-wins convention');
  assert.strictEqual(dup.package, 'pkgB', 'dedupe: the surviving candidate\'s OWN package is reported');
}

// ---- invocable (default-package nulls out, non-default reports) -----------
{
  assert.deepStrictEqual(entryLabels(ecCatalog, 'invocable'), ['ECInvocableAction.run', 'ECPkgDefaultClass.run', 'ECPkgOtherClass.run']);
  const defaultPkgEntry = findEntry(ecCatalog, 'invocable', 'ECPkgDefaultClass.run');
  assert.strictEqual(defaultPkgEntry.package, null, 'package|null: a candidate living in the WORKSPACE DEFAULT package must report null, not the default label itself');
  const otherPkgEntry = findEntry(ecCatalog, 'invocable', 'ECPkgOtherClass.run');
  assert.strictEqual(otherPkgEntry.package, 'pkgB', 'a candidate in a real non-default package must report that package label');
  const noPkgEntry = findEntry(ecCatalog, 'invocable', 'ECInvocableAction.run');
  assert.strictEqual(noPkgEntry.package, null, 'a file outside every known package directory reports null (no package metadata at all)');
}

// ---- rest: single verbs + the untested-by-corpus multi-verb join format ---
{
  assert.deepStrictEqual(entryLabels(ecCatalog, 'rest'), ['ECRestResource.handleBoth', 'ECRestResource.handleGet', 'ECRestResource.handlePost']);
  assert.strictEqual(findEntry(ecCatalog, 'rest', 'ECRestResource.handleGet').detail, '@HttpGet', 'rest detail is the literal @HttpX verb text, not the generic "@HttpX (REST)" badge label');
  assert.strictEqual(findEntry(ecCatalog, 'rest', 'ECRestResource.handlePost').detail, '@HttpPost');
  assert.strictEqual(findEntry(ecCatalog, 'rest', 'ECRestResource.handleBoth').detail, '@HttpPost, @HttpGet', 'multi-verb join: SOURCE declaration order, not alphabetized -- this exact shape is untested by either real corpus, pinned here');
}

// ---- soap ---------------------------------------------------------------
{
  const e = findEntry(ecCatalog, 'soap', 'ECSoapSvc.doWork');
  assert.ok(e);
  assert.strictEqual(e.detail, 'webservice (SOAP API)');
}

// ---- async: Batchable contributes 3 entries from ONE class, plus
// Queueable/Schedulable/@future (incl. the dual-kind method's @future half,
// stripped of its internal ' (async)' suffix) -------------------------------
{
  assert.deepStrictEqual(entryLabels(ecCatalog, 'async'), [
    'ECBatchJob.execute', 'ECBatchJob.finish', 'ECBatchJob.start',
    'ECDualKind.doBoth', 'ECFutureSvc.doAsync', 'ECQueueableJob.execute', 'ECScheduledJob.execute',
  ], 'async group: Batchable = 3 entries (start/execute/finish) from ONE class, per F5\'s own "whole 3-method interface" comment');
  for (const label of ['ECBatchJob.start', 'ECBatchJob.execute', 'ECBatchJob.finish']) {
    assert.strictEqual(findEntry(ecCatalog, 'async', label).detail, 'Batchable');
  }
  assert.strictEqual(findEntry(ecCatalog, 'async', 'ECQueueableJob.execute').detail, 'Queueable');
  assert.strictEqual(findEntry(ecCatalog, 'async', 'ECScheduledJob.execute').detail, 'Schedulable');
  assert.strictEqual(findEntry(ecCatalog, 'async', 'ECFutureSvc.doAsync').detail, '@future', "@future detail is the bare string '@future', NOT the engine's internal '@future (async)' label");
  assert.strictEqual(findEntry(ecCatalog, 'async', 'ECDualKind.doBoth').detail, '@future');
}

// ---- dual-annotation: the SAME method appears once per matching kind ------
{
  const auraHalf = findEntry(ecCatalog, 'aura', 'ECDualKind.doBoth');
  const asyncHalf = findEntry(ecCatalog, 'async', 'ECDualKind.doBoth');
  assert.ok(auraHalf && asyncHalf, 'a method with two entry annotations must appear ONCE PER matching kind (one aura entry + one async entry), never merged into one, never dropped');
  assert.strictEqual(auraHalf.className, asyncHalf.className);
  assert.strictEqual(auraHalf.methodLower, asyncHalf.methodLower);
  assert.strictEqual(auraHalf.line, asyncHalf.line);
}

// ---- isTest exclusion: counted per LABEL, not per method -------------------
{
  assert.strictEqual(findEntry(ecCatalog, 'aura', 'ECTestDualClass.doBothTest'), undefined, 'an @isTest class\'s entry-annotated method must be excluded from the catalog entirely');
  assert.strictEqual(findEntry(ecCatalog, 'async', 'ECTestDualClass.doBothTest'), undefined);
  assert.strictEqual(ecCatalog.stats.excludedTestEntries, 2, 'excludedTestEntries counts once PER excluded catalog-kind label -- the dual-annotation isTest method contributes 2, not 1');
}

// ---- email / platform -------------------------------------------------
{
  assert.strictEqual(findEntry(ecCatalog, 'email', 'ECEmailHandler.handleInboundEmail').detail, 'InboundEmailHandler (Email Service)');
  assert.deepStrictEqual(entryLabels(ecCatalog, 'platform'), [
    'ECComparableThing.compareTo', 'ECFinalizerThing.execute', 'ECInstallHandler.onInstall',
    'ECRegHandler.createUser', 'ECRegHandler.updateUser', 'ECUninstallSvc.onUninstall',
  ], 'platform group folds all 5 F5 sub-interfaces (RegistrationHandler contributing 2 methods) into one kind, sorted by label');
}

// ---- constructors are never entries (sanity) -------------------------------
{
  for (const g of ecCatalog.groups) {
    assert.ok(!g.entries.some((e) => e.className === 'ECCtorOnly'), 'a class with only a constructor must contribute ZERO catalog entries in any kind');
  }
}

// ---- flow: record-triggered (multi-ref min-line pick), platform-event,
// screen/autolaunched-with-a-ref, externally-attached action, and a
// zero-actionCall flow file visible ONLY via index.flowFilePaths ------------
{
  const flowLabels = entryLabels(ecCatalog, 'flow').slice().sort();
  assert.deepStrictEqual(flowLabels, ['ECEventFlow', 'ECExternalActionFlow', 'ECOrderFlow', 'ECScreenFlow', 'ECZeroActionFlow'].slice().sort(), 'flow group: every distinct flow file seen -- ref-derived (local + external) AND the zero-actionCall file, deduped by label, ECOrderFlow counted once despite 2 actions + a flowFilePaths mention');

  const orderFlow = findEntry(ecCatalog, 'flow', 'ECOrderFlow');
  assert.strictEqual(orderFlow.detail, 'RecordAfterSave on EC_Order__c', "flow detail is '<flowTriggerType> on <flowObject>' when start info is known");
  assert.strictEqual(orderFlow.line, 2, 'multi-ref flow: the LOWER line among all actionCalls sharing this label is used');
  assert.strictEqual(orderFlow.className, null, 'flow entries never carry a className -- flows are not Apex types');
  assert.strictEqual(orderFlow.methodLower, null);

  // Integrator pass (v0.12/C1 fix): the C1 contract's Entry.detail comment
  // pins the platform-event shape as the LITERAL 'platform event on
  // <Object>' string (lowercase, spaced), distinct from the generic
  // '<triggerType> on <Object>' pattern used for genuine record-triggered
  // types -- confirmed against adv-org's MANIFEST.md 'Entry catalog'
  // section ('Additional flow details': `AcmeNoteEventFlow` ->
  // `platform event on Acme_Note__e`, verbatim). The previous assertion
  // here ('PlatformEvent on EC_Notify__e', the raw metascan.js constant
  // formatted through the generic pattern) was itself the bug this fixture
  // caught -- see resolver.js's collectFlowEntries for the fix.
  const eventFlow = findEntry(ecCatalog, 'flow', 'ECEventFlow');
  assert.strictEqual(eventFlow.detail, 'platform event on EC_Notify__e', "platform-event flow: the CONTRACT's literal 'platform event on <Object>' string, not the raw flowTriggerType constant");

  const screenFlow = findEntry(ecCatalog, 'flow', 'ECScreenFlow');
  assert.strictEqual(screenFlow.detail, 'screen or autolaunched', 'a flow WITH an apex action ref but no <start> object/triggerType falls back to the GOAL-ruled combined string, not the finer 3-way split the CONTRACT comment describes');

  const externalFlow = findEntry(ecCatalog, 'flow', 'ECExternalActionFlow');
  assert.ok(externalFlow, "a flow whose only apex action targets a MANAGED-PACKAGE class (externalMetaRefs, not metaCallers) must still appear -- it's still a real local flow file");
  assert.strictEqual(externalFlow.detail, 'RecordBeforeSave on EC_External__c');

  const zeroActionFlow = findEntry(ecCatalog, 'flow', 'ECZeroActionFlow');
  assert.ok(zeroActionFlow, "GOAL ruling: 'every distinct flow file seen' includes files with ZERO apex actionCalls, sourced from index.flowFilePaths since metascan's own ref list is silent for them");
  assert.strictEqual(zeroActionFlow.detail, 'screen or autolaunched');
  assert.strictEqual(zeroActionFlow.line, 0);
}

// ---- anonymous --------------------------------------------------------
{
  const e = findEntry(ecCatalog, 'anonymous', 'ECScript');
  assert.ok(e, "anonymous entry label is the SCRIPT NAME alone ('ECScript'), never 'ECScript.(anonymous)'");
  assert.strictEqual(e.detail, 'Anonymous Apex script');
  assert.strictEqual(e.methodLower, '(anonymous)');
}

// ---- stats: total/byKind/packages are all internally consistent -----------
{
  let sumByKind = 0;
  for (const k of Object.keys(ecCatalog.stats.byKind)) sumByKind += ecCatalog.stats.byKind[k];
  assert.strictEqual(sumByKind, ecCatalog.stats.total, 'stats.total must equal the sum of stats.byKind');
  let sumGroups = 0;
  for (const g of ecCatalog.groups) sumGroups += g.entries.length;
  assert.strictEqual(sumGroups, ecCatalog.stats.total, 'stats.total must equal the sum of every group\'s entries.length');
  assert.strictEqual(ecCatalog.stats.unresolvedSites, ecIndex.stats.unresolvedSites, 'catalog carries the shared unresolved-site count into its header stats');
  assert.strictEqual(ecCatalog.stats.managedRefs, ecIndex.stats.externalRefs, 'catalog carries the shared managed-reference count into its header stats');
  assert.strictEqual(ecCatalog.stats.byKind.trigger, 1);
  assert.strictEqual(ecCatalog.stats.byKind.aura, 3);
  assert.strictEqual(ecCatalog.stats.byKind.invocable, 3);
  assert.strictEqual(ecCatalog.stats.byKind.rest, 3);
  assert.strictEqual(ecCatalog.stats.byKind.soap, 1);
  assert.strictEqual(ecCatalog.stats.byKind.async, 7);
  assert.strictEqual(ecCatalog.stats.byKind.email, 1);
  assert.strictEqual(ecCatalog.stats.byKind.platform, 6);
  assert.strictEqual(ecCatalog.stats.byKind.flow, 5);
  assert.strictEqual(ecCatalog.stats.byKind.anonymous, 1);
  assert.deepStrictEqual(ecCatalog.stats.packages, ['pkgB'], 'stats.packages: distinct non-default package labels actually present in the FINAL (post-dedupe) catalog, sorted');
}

// ---- determinism: the SAME index, built/queried twice, must be byte-
// identical (no Set/Map iteration-order leakage, no Date.now()-style noise) -
{
  const ecCatalogAgain = buildEntryCatalog(ecIndex);
  assert.deepStrictEqual(ecCatalog, ecCatalogAgain, 'C1 CONTRACT: deterministic output -- calling buildEntryCatalog(index) twice on the same index must be deep-equal');
  const ecIndex2 = buildSemanticIndex(ecEntryCatalogFacts, { packageOf: ecPackageOf, defaultPackage: EC_DEFAULT_PACKAGE });
  attachMetaCallers(ecIndex2, ecFlowRefs);
  ecIndex2.flowFilePaths = ecIndex.flowFilePaths;
  const ecCatalogFromFreshBuild = buildEntryCatalog(ecIndex2);
  assert.deepStrictEqual(ecCatalog, ecCatalogFromFreshBuild, 'determinism must also hold across a completely FRESH index built from the same fixture facts, not just a memoized re-call');
}

// ---- empty workspace: every kind still present, all zero -------------------
{
  const emptyCatalog = buildEntryCatalog(buildSemanticIndex([]));
  assert.deepStrictEqual(emptyCatalog.groups.map((g) => g.kind), ['trigger', 'aura', 'invocable', 'rest', 'soap', 'async', 'email', 'platform', 'flow', 'anonymous']);
  for (const g of emptyCatalog.groups) assert.deepStrictEqual(g.entries, []);
  assert.strictEqual(emptyCatalog.stats.total, 0);
  assert.deepStrictEqual(emptyCatalog.stats.packages, []);
  assert.strictEqual(emptyCatalog.stats.excludedTestEntries, 0);
  for (const k of Object.keys(emptyCatalog.stats.byKind)) assert.strictEqual(emptyCatalog.stats.byKind[k], 0);
}

// ---- defensive: buildEntryCatalog must never throw on a malformed/
// undefined index (mirrors this file's existing house style for every
// other post-build query function). -----------------------------------
{
  assert.doesNotThrow(() => buildEntryCatalog(undefined));
  assert.doesNotThrow(() => buildEntryCatalog(null));
  assert.doesNotThrow(() => buildEntryCatalog({}));
  const shell = buildEntryCatalog({});
  assert.strictEqual(shell.stats.total, 0);
}

// =========================================================================
// v0.13/S2: flow-to-subflow chains
// =========================================================================
// MetaRef.subflows is STUBBED by hand here, per the round's own contract
// (this file must not depend on the in-flight metascan.js implementation) --
// the shape below (subflows: string[], always present on a flow ref;
// className/methodName BOTH null on a "bare" ref that carries no apex
// action of its own) is documented in resolver.js's own attachMetaCallers
// header comment.
function flowRef13(label, opts = {}) {
  return {
    kind: 'flow',
    label,
    className: opts.className !== undefined ? opts.className : null,
    methodName: opts.methodName !== undefined ? opts.methodName : null,
    flowObject: opts.flowObject || null,
    flowRecordTriggerType: opts.flowRecordTriggerType || null,
    flowTriggerType: opts.flowTriggerType || null,
    path: `flows/${label}.flow-meta.xml`,
    line: opts.line || 1,
    lineText: opts.lineText || '',
    subflows: opts.subflows || [],
  };
}

const S13Anchor = ty('S13Anchor', 'S13Anchor', {
  methods: [
    mth('createWidget', {
      line: 1,
      locals: [{ name: 'w', type: 'S13_Widget__c', line: 1 }],
      dml: [dmlFact('insert', 'w', { line: 2, lineText: 'insert w;' })],
    }),
    // Second, independent DML launcher on the SAME object/op -- exists
    // purely to prove DAG memoization (seenElsewhere) fires on a SECOND
    // occurrence of the same DML-reached flow node in the callee direction,
    // exactly like an ordinary method node's second occurrence would.
    mth('createWidgetAgain', {
      line: 8,
      locals: [{ name: 'w2', type: 'S13_Widget__c', line: 8 }],
      dml: [dmlFact('insert', 'w2', { line: 9, lineText: 'insert w2;' })],
    }),
    mth('createBoth', {
      line: 5,
      calls: [
        cl('bare', 'createWidget', { line: 6, lineText: 'createWidget();' }),
        cl('bare', 'createWidgetAgain', { line: 7, lineText: 'createWidgetAgain();' }),
      ],
    }),
    // The parent flow's own direct apex action -- present only so
    // S13WidgetLifecycleFlow has >=1 apex actionCalls of its own (mirrors
    // the gauntlet-org corpus's VtxFlowWidgetDmlSource.logWidgetCreated).
    mth('logWidgetCreated', { line: 3 }),
    // The SUBFLOW's own apex action -- the req-1/req-4 anchor.
    mth('notifyTeam', { line: 4 }),
  ],
});
const S13ChainRelay = ty('S13ChainRelay', 'S13ChainRelay', {
  methods: [mth('relayMid', { line: 1 }), mth('relayLeaf', { line: 2 })],
});
const S13CycleHelper = ty('S13CycleHelper', 'S13CycleHelper', {
  methods: [mth('pingA', { line: 1 }), mth('pingB', { line: 2 })],
});
const S13SharedApex = ty('S13SharedApex', 'S13SharedApex', {
  methods: [mth('sharedAction', { line: 1 })],
});
const S13CapAnchor = ty('S13CapAnchor', 'S13CapAnchor', {
  methods: [mth('capRun', { line: 1 })],
});

const index13 = buildSemanticIndex([
  mkFile(S13Anchor),
  mkFile(S13ChainRelay),
  mkFile(S13CycleHelper),
  mkFile(S13SharedApex),
  mkFile(S13CapAnchor),
]);

const metaRefs13 = [
  // ---- Widget lifecycle: req-1 (callers: apex <- subflow <- parent flow <-
  // launcher) + req-4 (callees: DML -> parent flow -> subflow -> subflow's
  // apex action) + the unknown-subflow-ref negative (Call_Ghost_Followup-
  // style second <subflows> element naming a nonexistent flow), all in one
  // fixture, mirroring gauntlet-org's Vtx_WidgetLifecycleFlow pair exactly. --
  flowRef13('S13WidgetLifecycleFlow', {
    className: 'S13Anchor', methodName: 'logWidgetCreated',
    flowObject: 'S13_Widget__c', flowRecordTriggerType: 'Create', flowTriggerType: 'RecordAfterSave',
    subflows: ['S13WidgetNotifySubflow', 'S13GhostFlow'],
  }),
  flowRef13('S13WidgetNotifySubflow', { className: 'S13Anchor', methodName: 'notifyTeam' }),

  // ---- 3-deep chain: S13ChainTop is deliberately APEX-LESS (bare ref, no
  // className/methodName) -- the load-bearing stress case proving a flow's
  // own subflows are captured file-wide, not only when a MetaRef already
  // exists for an apex actionCalls block on that same file. ----------------
  flowRef13('S13ChainTop', { subflows: ['S13ChainMid'] }),
  flowRef13('S13ChainMid', { className: 'S13ChainRelay', methodName: 'relayMid', subflows: ['S13ChainLeaf'] }),
  flowRef13('S13ChainLeaf', { className: 'S13ChainRelay', methodName: 'relayLeaf' }),

  // ---- mutual cycle: A's <subflows> names B, B's names A. -----------------
  flowRef13('S13CycleA', { className: 'S13CycleHelper', methodName: 'pingA', subflows: ['S13CycleB'] }),
  flowRef13('S13CycleB', { className: 'S13CycleHelper', methodName: 'pingB', subflows: ['S13CycleA'] }),

  // ---- diamond (seenElsewhere on shared subflow): S13Shared has TWO
  // parents (S13ParentOne, S13ParentTwo), which in turn share ONE common
  // grandparent -- tracing S13Shared's own apex action up must show
  // S13GrandParent ONCE fully expanded (under whichever parent sorts first
  // alphabetically) and ONCE as a seenElsewhere reference (under the other).
  flowRef13('S13Shared', { className: 'S13SharedApex', methodName: 'sharedAction' }),
  flowRef13('S13ParentOne', { subflows: ['S13Shared'] }),
  flowRef13('S13ParentTwo', { subflows: ['S13Shared'] }),
  flowRef13('S13GrandParent', { subflows: ['S13ParentOne', 'S13ParentTwo'] }),

  // ---- cap interplay: a 6-level linear (non-branching) PARENT chain --
  // S13CapF0 (apex target) <- S13CapF1 <- S13CapF2 <- S13CapF3 <- S13CapF4 <-
  // S13CapF5. Deliberately non-branching: a naive "only check the budget
  // between SIBLINGS" implementation would never cap a pure linear chain at
  // all (see resolver.js's own buildOneFlowNode header note on exactly this
  // bug) -- this fixture exists specifically to catch that.
  flowRef13('S13CapF0', { className: 'S13CapAnchor', methodName: 'capRun' }),
  flowRef13('S13CapF1', { subflows: ['S13CapF0'] }),
  flowRef13('S13CapF2', { subflows: ['S13CapF1'] }),
  flowRef13('S13CapF3', { subflows: ['S13CapF2'] }),
  flowRef13('S13CapF4', { subflows: ['S13CapF3'] }),
  flowRef13('S13CapF5', { subflows: ['S13CapF4'] }),

  // ---- deferred resolution: S13OrchestratorFlow's <subflows> names
  // S13LeafOnlyFlow, a flow with ZERO metaRefs of ANY kind (no apex
  // actionCalls of its own AND no <subflows> of its own either, so even the
  // bare-ref exception never fires for it -- mirrors adv-org's real
  // AcmeNotifyCustomerSubflow, whose only action is a non-apex emailSimple).
  // Resolvable ONLY once index.flowFilePaths is populated (see
  // finalizeFlowSubflowRefs's own header note) -- deliberately NOT resolved
  // yet at the point attachMetaCallers returns, below.
  flowRef13('S13OrchestratorFlow', { subflows: ['S13LeafOnlyFlow'] }),
];
attachMetaCallers(index13, metaRefs13);

// ---- flowGraph: built by attachMetaCallers itself, immediately, for every
// edge resolvable from metaRefs13 alone (the overwhelmingly common case). ---
{
  assert.deepStrictEqual(index13.flowGraph.get('s13widgetlifecycleflow'), { parents: [], children: ['s13widgetnotifysubflow'] });
  assert.deepStrictEqual(index13.flowGraph.get('s13widgetnotifysubflow'), { parents: ['s13widgetlifecycleflow'], children: [] });
  assert.deepStrictEqual(index13.flowGraph.get('s13chaintop'), { parents: [], children: ['s13chainmid'] });
  assert.deepStrictEqual(index13.flowGraph.get('s13chainmid'), { parents: ['s13chaintop'], children: ['s13chainleaf'] });
  assert.deepStrictEqual(index13.flowGraph.get('s13chainleaf'), { parents: ['s13chainmid'], children: [] });
  assert.deepStrictEqual(index13.flowGraph.get('s13cyclea'), { parents: ['s13cycleb'], children: ['s13cycleb'] });
  assert.deepStrictEqual(index13.flowGraph.get('s13cycleb'), { parents: ['s13cyclea'], children: ['s13cyclea'] });
  // Not yet resolvable: the child (S13LeafOnlyFlow) has no metaRef at all
  // yet, so this edge is still pending, NOT a fabricated flowGraph entry and
  // NOT yet counted unknown either.
  assert.strictEqual(index13.flowGraph.has('s13leafonlyflow'), false, 'unresolvable-so-far subflow ref must never fabricate a flowGraph node');
  assert.ok(Array.isArray(index13._pendingSubflowRefs), 'unresolved subflow refs are deferred, not dropped');
  assert.ok(
    index13._pendingSubflowRefs.some((p) => p.parentLower === 's13orchestratorflow' && p.childLower === 's13leafonlyflow'),
    'the deferred S13OrchestratorFlow -> S13LeafOnlyFlow ref is pending'
  );
  assert.ok(
    index13._pendingSubflowRefs.some((p) => p.parentLower === 's13widgetlifecycleflow' && p.childLower === 's13ghostflow'),
    'the genuinely-unknown S13GhostFlow ref is ALSO pending (not yet decided) until a consumer finalizes it'
  );
  assert.strictEqual(index13.stats.unknownSubflowRefs, 0, 'nothing is decided unknown until finalizeFlowSubflowRefs runs (lazily, inside buildCallerTree/buildCalleeTree/buildEntryCatalog)');
}

// v0.13 ORDERING: extension.js's real pipeline sets index.flowFilePaths
// AFTER attachMetaCallers -- reproduced here exactly, so the deferred
// S13OrchestratorFlow -> S13LeafOnlyFlow edge is only resolvable from this
// point forward.
index13.flowFilePaths = ['flows/S13LeafOnlyFlow.flow-meta.xml'];

// ---- req-1 / caller direction: apex <- subflow <- parent flow <- launcher --
{
  const tree = buildCallerTree(index13, { classLower: 's13anchor', methodLower: 'notifyteam' });
  const subflowNode = findChild(tree.root.children, 'S13WidgetNotifySubflow');
  assert.ok(subflowNode, 'expected the subflow (S13WidgetNotifySubflow) as a metadata caller of its own apex action');
  assert.strictEqual(subflowNode.via, 'metadata');
  assert.strictEqual(subflowNode.kind, 'flow');
  const parentFlowNode = findChild(subflowNode.children, 'S13WidgetLifecycleFlow');
  assert.ok(parentFlowNode, 'NEW v0.13 edge: the subflow node must show its own PARENT flow as a child');
  assert.strictEqual(parentFlowNode.via, 'subflow', "the new edge's via must be exactly 'subflow'");
  assert.strictEqual(parentFlowNode.approximate, false, "'subflow' is a declared reference, never approximate");
  assert.strictEqual(parentFlowNode.cyclic, false);
  assert.strictEqual(parentFlowNode.seenElsewhere, false);
  const launcherLabels = labelsOf(parentFlowNode.children);
  assert.ok(launcherLabels.includes('S13Anchor.createWidget'), 'the parent flow\'s own pre-existing DML-launcher children (F1(b)) must still be reachable one hop deeper, unchanged');
  const launcherNode = findChild(parentFlowNode.children, 'S13Anchor.createWidget');
  assert.strictEqual(launcherNode.via, 'dml');
  assert.deepStrictEqual(launcherNode.children, [], 'flow-DML launcher children stay terminal, exactly like pre-v0.13 F1(b)');
}

// ---- 3-deep chain, both directions (req-2) -------------------------------
{
  const treeLeaf = buildCallerTree(index13, { classLower: 's13chainrelay', methodLower: 'relayleaf' });
  const leafFlow = findChild(treeLeaf.root.children, 'S13ChainLeaf');
  assert.ok(leafFlow && leafFlow.via === 'metadata');
  const midFlow = findChild(leafFlow.children, 'S13ChainMid');
  assert.ok(midFlow && midFlow.via === 'subflow', '3-deep chain, level 2: ChainMid is ChainLeaf\'s parent');
  const topFlow = findChild(midFlow.children, 'S13ChainTop');
  assert.ok(topFlow && topFlow.via === 'subflow', '3-deep chain, level 3: ChainTop (apex-less) is ChainMid\'s parent');
  assert.deepStrictEqual(topFlow.children, [], 'ChainTop has no parent of its own (nobody subflows it) -- chain terminates here, not hardcoded to any fixed depth');
  assert.strictEqual(topFlow.cyclic, false);
  assert.strictEqual(topFlow.truncated, false);

  // Cross-check: relayMid's OWN caller-tree is 2-deep, not hardcoded to 3 --
  // it genuinely recurses per-node rather than always emitting exactly 3
  // levels regardless of target.
  const treeMid = buildCallerTree(index13, { classLower: 's13chainrelay', methodLower: 'relaymid' });
  const midFlow2 = findChild(treeMid.root.children, 'S13ChainMid');
  assert.ok(midFlow2 && midFlow2.via === 'metadata');
  const topFlow2 = findChild(midFlow2.children, 'S13ChainTop');
  assert.ok(topFlow2 && topFlow2.via === 'subflow');
  assert.deepStrictEqual(topFlow2.children, []);
}

// ---- req-3: mutual cycle -- must flag cyclic, never hang -----------------
{
  const treeA = buildCallerTree(index13, { classLower: 's13cyclehelper', methodLower: 'pinga' });
  const cycleAFlow = findChild(treeA.root.children, 'S13CycleA');
  assert.ok(cycleAFlow && cycleAFlow.via === 'metadata');
  const cycleBFlow = findChild(cycleAFlow.children, 'S13CycleB');
  assert.ok(cycleBFlow && cycleBFlow.via === 'subflow');
  const cycleAAgain = findChild(cycleBFlow.children, 'S13CycleA');
  assert.ok(cycleAAgain, 'the cycle must close back onto S13CycleA');
  assert.strictEqual(cycleAAgain.cyclic, true, 'the ancestor-path mechanism (key "flow:"+lower) must flag the repeat as cyclic');
  assert.deepStrictEqual(cycleAAgain.children, [], 'recursion stops the instant the cycle is detected -- zero children, not one more hop first');
  assert.strictEqual(cycleAAgain.seenElsewhere, false, 'cyclic wins over seenElsewhere on an ancestor-path hit, same H1 rule the pure-Apex/DML cycles already use');

  // Mirror image starting from pingB.
  const treeB = buildCallerTree(index13, { classLower: 's13cyclehelper', methodLower: 'pingb' });
  const cycleBFlowRoot = findChild(treeB.root.children, 'S13CycleB');
  const cycleAFlowChild = findChild(cycleBFlowRoot.children, 'S13CycleA');
  const cycleBAgain = findChild(cycleAFlowChild.children, 'S13CycleB');
  assert.strictEqual(cycleBAgain.cyclic, true);
  assert.deepStrictEqual(cycleBAgain.children, []);
}

// ---- seenElsewhere on a shared subflow (diamond) --------------------------
{
  const tree = buildCallerTree(index13, { classLower: 's13sharedapex', methodLower: 'sharedaction' });
  const sharedFlow = findChild(tree.root.children, 'S13Shared');
  assert.ok(sharedFlow && sharedFlow.via === 'metadata');
  assert.strictEqual(sharedFlow.children.length, 2, 'S13Shared has TWO parents -- both must appear as children');
  const parentOne = findChild(sharedFlow.children, 'S13ParentOne');
  const parentTwo = findChild(sharedFlow.children, 'S13ParentTwo');
  assert.ok(parentOne && parentTwo);
  assert.strictEqual(parentOne.via, 'subflow');
  assert.strictEqual(parentTwo.via, 'subflow');
  const grandUnderOne = findChild(parentOne.children, 'S13GrandParent');
  const grandUnderTwo = findChild(parentTwo.children, 'S13GrandParent');
  assert.ok(grandUnderOne && grandUnderTwo, 'S13GrandParent is the common parent of BOTH S13ParentOne and S13ParentTwo -- it must appear under both');
  // Exactly one of the two occurrences is the FULL expansion; the other is
  // the seenElsewhere reference -- never both, never neither.
  const flags = [grandUnderOne.seenElsewhere, grandUnderTwo.seenElsewhere];
  assert.strictEqual(flags.filter(Boolean).length, 1, 'exactly one S13GrandParent occurrence must be flagged seenElsewhere');
  const seenElsewhereOne = grandUnderOne.seenElsewhere ? grandUnderOne : grandUnderTwo;
  const fullOne = grandUnderOne.seenElsewhere ? grandUnderTwo : grandUnderOne;
  assert.deepStrictEqual(seenElsewhereOne.children, [], 'the seenElsewhere occurrence renders with its subtree collapsed to []');
  assert.strictEqual(seenElsewhereOne.cyclic, false, 'seenElsewhere on a DIAMOND (not a real cycle) must not also flag cyclic');
  assert.strictEqual(seenElsewhereOne.truncated, false, "seenElsewhere alone must not also imply truncated (that flag means 'a cap was hit', not 'deduped')");
  assert.strictEqual(fullOne.seenElsewhere, false);
}

// ---- cap interplay: a long, NON-BRANCHING linear chain must still be
// bounded by maxNodes -- a naive "check the budget only between sibling
// iterations" implementation would never cap a chain with exactly one
// parent per level (see resolver.js's own buildOneFlowNode header note). ---
{
  const tree = buildCallerTree(index13, { classLower: 's13capanchor', methodLower: 'caprun' }, { maxNodes: 3 });
  assert.strictEqual(tree.stats.capped, true, 'a 6-level linear parent chain against maxNodes:3 must trip the cap');
  const f0 = findChild(tree.root.children, 'S13CapF0');
  assert.ok(f0 && f0.via === 'metadata');
  const f1 = findChild(f0.children, 'S13CapF1');
  assert.ok(f1 && f1.via === 'subflow');
  const f2 = findChild(f1.children, 'S13CapF2');
  assert.ok(f2, 'the cap must still allow the walk to reach exactly as far as the budget allows');
  assert.strictEqual(f2.truncated, true, 'the SPECIFIC node whose own further expansion was cut off gets truncated:true');
  assert.deepStrictEqual(f2.children, [], 'nothing beyond the cap is shown');
  assert.strictEqual(findChild(f0.children, 'S13CapF3'), undefined, 'F3/F4/F5 must never appear anywhere in this capped tree');
}

// ---- req-4 / callee direction: DML -> parent flow -> subflow -> subflow's
// apex action ---------------------------------------------------------------
{
  const tree = buildCalleeTree(index13, { classLower: 's13anchor', methodLower: 'createwidget' });
  const parentFlow = findChild(tree.root.children, 'S13WidgetLifecycleFlow');
  assert.ok(parentFlow, 'dml->flow: pre-existing A1 fan-out, unaffected');
  assert.strictEqual(parentFlow.via, 'dml');
  const subflowChild = findChild(parentFlow.children, 'S13WidgetNotifySubflow');
  assert.ok(subflowChild, "NEW v0.13: makeCalleeFlowNode's children are no longer forced empty -- this flow's own <subflows> list is walked forward");
  assert.strictEqual(subflowChild.via, 'subflow');
  assert.strictEqual(subflowChild.approximate, false);
  const apexAction = findChild(subflowChild.children, 'S13Anchor.notifyTeam');
  assert.ok(apexAction, "the subflow's own apex action must be forward-visible, per the GOAL text \"each subflow expanding to its own apex actions/DML/subflows\"");
  assert.strictEqual(apexAction.kind, 'method');
  assert.strictEqual(apexAction.via, 'metadata');
  assert.strictEqual(apexAction.truncated, true, 'forward tracing stops AT the apex action -- what it itself calls is a separate ordinary trace');
  assert.deepStrictEqual(apexAction.children, []);

  // [SPEC-OPEN] (documented choice, not a ground-truth-pinned requirement):
  // the DML-reached parent flow itself is NOT also expanded to show its own
  // direct apex action (logWidgetCreated) as a sibling of the subflow child
  // -- only a node reached VIA a 'subflow' edge gets that treatment. Locked
  // in as a regression pin so a future change to this choice is deliberate.
  assert.strictEqual(findChild(parentFlow.children, 'S13Anchor.logWidgetCreated'), undefined, 'the DML-root flow node does not ALSO forward-expose its own apex action (documented [SPEC-OPEN] choice)');
  assert.strictEqual(parentFlow.children.length, 1, 'the DML-root flow node has exactly one child: its subflow');
}

// ---- bonus: DAG memoization (seenElsewhere) also applies in the CALLEE
// direction -- the SAME flow reached via two DIFFERENT DML sites elsewhere
// in one forward trace must dedupe exactly like an ordinary method node. ---
{
  const tree = buildCalleeTree(index13, { classLower: 's13anchor', methodLower: 'createboth' });
  const firstCall = findChild(tree.root.children, 'S13Anchor.createWidget');
  const secondCall = findChild(tree.root.children, 'S13Anchor.createWidgetAgain');
  assert.ok(firstCall && secondCall, 'both DML launchers must appear as ordinary forward callees of createBoth');
  const firstFlow = findChild(firstCall.children, 'S13WidgetLifecycleFlow');
  const secondFlow = findChild(secondCall.children, 'S13WidgetLifecycleFlow');
  assert.ok(firstFlow && secondFlow, 'the SAME flow is reached from both DML sites');
  assert.strictEqual(firstFlow.seenElsewhere, false, 'the FIRST occurrence (processed first, per source order) is the full expansion');
  assert.ok(findChild(firstFlow.children, 'S13WidgetNotifySubflow'), 'the first occurrence shows its real subflow children');
  assert.strictEqual(secondFlow.seenElsewhere, true, 'the SECOND occurrence must be deduped');
  assert.deepStrictEqual(secondFlow.children, [], 'a seenElsewhere flow node renders with children collapsed to []');
  assert.strictEqual(secondFlow.truncated, false, "seenElsewhere alone must not ALSO imply truncated (that flag means 'a cap was hit', not 'deduped') -- even though this exact node kind defaults truncated:true when it has no subflow data at all");
  assert.strictEqual(secondFlow.cyclic, false);
}

// ---- unknown-subflow-ref negative: counted, never fabricated as a node ---
{
  // Neither S13GhostFlow nor S13LeafOnlyFlow have been finalized yet purely
  // by virtue of the tree-building calls above having ALREADY triggered
  // finalizeFlowSubflowRefs (buildCallerTree/buildCalleeTree both call it) --
  // by this point in the file, both pending refs are already decided.
  assert.strictEqual(index13.stats.unknownSubflowRefs, 1, 'exactly one genuinely-unknown ref (S13GhostFlow) -- S13LeafOnlyFlow resolved via flowFilePaths, not counted');
  assert.strictEqual(index13.flowGraph.has('s13nonexistentghostflow'), false);
  assert.strictEqual(index13.flowGraph.has('s13ghostflow'), false, 'no flowGraph entry is ever fabricated for an unknown subflow name');
  assert.deepStrictEqual(index13.flowGraph.get('s13widgetlifecycleflow').children, ['s13widgetnotifysubflow'], 'the ghost reference contributes to the stat and NOTHING else -- exactly 1 real child, not 2');
  // The deferred-but-real edge (via flowFilePaths) DID resolve, though --
  // proves finalizeFlowSubflowRefs correctly distinguishes "not yet known"
  // from "genuinely unknown".
  assert.deepStrictEqual(index13.flowGraph.get('s13orchestratorflow'), { parents: [], children: ['s13leafonlyflow'] });
  assert.deepStrictEqual(index13.flowGraph.get('s13leafonlyflow'), { parents: ['s13orchestratorflow'], children: [] });

  // A trace never shows a node with the unknown label, anywhere.
  function findLabelDeep(node, label) {
    if (!node) return false;
    if (node.label === label) return true;
    return (node.children || []).some((c) => findLabelDeep(c, label));
  }
  const widgetTree = buildCallerTree(index13, { classLower: 's13anchor', methodLower: 'notifyteam' });
  assert.strictEqual(findLabelDeep(widgetTree.root, 'S13GhostFlow'), false);
}

// ---- entry catalog delta (v0.13): the 'subflow of <parent>' detail suffix -
{
  const cat = buildEntryCatalog(index13);
  const flowGroup = cat.groups.find((g) => g.kind === 'flow');
  const byLabel = new Map(flowGroup.entries.map((e) => [e.label, e]));

  assert.strictEqual(
    byLabel.get('S13WidgetLifecycleFlow').detail,
    'RecordAfterSave on S13_Widget__c',
    'record-triggered -- has its own <start> trigger info, so the subflow-suffix rule never applies regardless of parents'
  );
  assert.strictEqual(
    byLabel.get('S13WidgetNotifySubflow').detail,
    'screen or autolaunched (subflow of S13WidgetLifecycleFlow)',
    'fallback shape + exactly 1 parent -> suffix applies'
  );
  assert.strictEqual(
    byLabel.get('S13ChainTop').detail,
    'screen or autolaunched',
    'fallback shape but ZERO parents (nobody subflows it) -> no suffix, unchanged fallback'
  );
  assert.strictEqual(byLabel.get('S13ChainMid').detail, 'screen or autolaunched (subflow of S13ChainTop)');
  assert.strictEqual(byLabel.get('S13ChainLeaf').detail, 'screen or autolaunched (subflow of S13ChainMid)');
  assert.strictEqual(
    byLabel.get('S13CycleA').detail,
    'screen or autolaunched (subflow of S13CycleB)',
    'the cycle does not confuse the suffix -- it only ever names its OWN direct parent, never walks the cycle'
  );
  assert.strictEqual(byLabel.get('S13CycleB').detail, 'screen or autolaunched (subflow of S13CycleA)');
  // The deferred-resolution flow gets its suffix too, once flowFilePaths
  // made it resolvable.
  assert.strictEqual(byLabel.get('S13LeafOnlyFlow').detail, 'screen or autolaunched (subflow of S13OrchestratorFlow)');
  assert.strictEqual(byLabel.get('S13OrchestratorFlow').detail, 'screen or autolaunched');

  // Multiple-parent format is documented as UNSPECIFIED by the GOAL text
  // (neither reference corpus has a >1-parent flow) -- only a light,
  // non-prescriptive smoke check that it degrades sanely (both parent names
  // present, never a crash) rather than pinning an exact separator.
  const sharedDetail = byLabel.get('S13Shared').detail;
  assert.ok(sharedDetail.includes('S13ParentOne') && sharedDetail.includes('S13ParentTwo'), 'multi-parent suffix must mention every parent, exact format unspecified');

  // Counts unchanged elsewhere -- v0.13 additions are ALL new 'flow' entries
  // (no trigger/aura/invocable/etc. surface on any of these plain classes).
  assert.strictEqual(cat.stats.byKind.trigger, 0);
  assert.strictEqual(cat.stats.byKind.invocable, 0);
  assert.strictEqual(cat.stats.excludedTestEntries, 0);
}

// ---- regression: a flow with NO flowGraph data at all (no parents, no
// children -- e.g. every pre-v0.13 fixture elsewhere in this file, like
// V4OrderUpdateFlow/W7AccountFlow/AcmeMetaScreenFlow above) is completely
// unaffected -- byte-identical shape to before this round. -----------------
{
  const plainFlowRef = {
    kind: 'flow', label: 'S13PlainFlow', className: 'S13SharedApex', methodName: 'sharedAction',
    flowObject: null, flowRecordTriggerType: null, flowTriggerType: null,
    path: 'flows/S13PlainFlow.flow-meta.xml', line: 1, lineText: '', subflows: [],
  };
  const plainIndex = buildSemanticIndex([mkFile(S13SharedApex)]);
  attachMetaCallers(plainIndex, [plainFlowRef]);
  const tree = buildCallerTree(plainIndex, { classLower: 's13sharedapex', methodLower: 'sharedaction' });
  const flowNode = findChild(tree.root.children, 'S13PlainFlow');
  assert.ok(flowNode);
  assert.deepStrictEqual(flowNode.children, [], 'a flow with zero flowGraph parents keeps empty children, unchanged');
  assert.strictEqual(flowNode.truncated, false);
}

// =========================================================================
// v0.13 hardening round (Round 2.5): H1 (arity gate + attachment cap), H2
// (approximate rollup), H3 (scoped caller-direction header), H4
// (opts.shouldCancel). Fixtures prefixed 'V13' throughout to avoid
// colliding with this file's pre-existing amendment-letter-coded fixtures
// (H1/H2/H3/H4 above are historical v0.7.1-era codes, unrelated to this
// round's own H1-H4 letters).
// =========================================================================

// ---- H1(a) ARITY GATE: a wrong-arity call to the sole declarer of a
// name must decline (stay unresolved), never fan out to the mismatched
// overload the way typed/interface dispatch's OWN arity-mismatch fallback
// does -- rule 7 has no receiver-class anchor to justify a guess. ---------
{
  const V13H1AritySole = ty('V13H1AritySole', 'V13H1AritySole', {
    methods: [mth('onlyOverload', { line: 1, params: [{ name: 's', type: 'String' }] })],
  });
  const V13H1ArityCaller = ty('V13H1ArityCaller', 'V13H1ArityCaller', {
    methods: [mth('run', {
      line: 1,
      calls: [cl('dot', 'onlyOverload', { receiver: 'unresolvedThing', argTexts: ['a', 'b'], line: 1, lineText: 'unresolvedThing.onlyOverload(a, b);' })],
    })],
  });
  const idx = buildSemanticIndex([mkFile(V13H1AritySole), mkFile(V13H1ArityCaller)]);
  assert.strictEqual(
    (idx.methodCallers.get('v13h1aritysole#onlyoverload') || []).length,
    0,
    'H1(a): a 2-arg call site must NOT attach to the sole declarer\'s 1-arg onlyOverload -- arity mismatch declines outright'
  );
  assert.strictEqual(idx.stats.unresolvedSites, 1);
  assert.strictEqual(idx.stats.unresolvedByReason['unknown-receiver'], 1, 'H1(a): an arity-gate decline is bookkept as an ordinary unknown-receiver miss, never name-too-common (it never even attempted an attachment)');
  assert.strictEqual(idx.stats.unresolvedByReason['name-too-common'], 0);

  // Positive control: the SAME call site, arity-matched, DOES attach.
  const V13H1ArityCallerOk = ty('V13H1ArityCallerOk', 'V13H1ArityCallerOk', {
    methods: [mth('run', {
      line: 1,
      calls: [cl('dot', 'onlyOverload', { receiver: 'unresolvedThing2', argTexts: ["'x'"], line: 1, lineText: "unresolvedThing2.onlyOverload('x');" })],
    })],
  });
  const idxOk = buildSemanticIndex([mkFile(V13H1AritySole), mkFile(V13H1ArityCallerOk)]);
  const okSites = idxOk.methodCallers.get('v13h1aritysole#onlyoverload') || [];
  assert.strictEqual(okSites.length, 1, 'H1(a): an ARITY-MATCHED unresolvable-receiver call must still attach via unique-name, exactly like pre-H1');
  assert.strictEqual(okSites[0].via, 'unique-name');
}

// ---- H1(b) ATTACHMENT CAP boundary: exactly UNIQUE_NAME_MAX (5) survives
// in full; one more (6) strips ALL of them back to unresolved. -----------
{
  const V13H1BoundaryTarget = ty('V13H1BoundaryTarget', 'V13H1BoundaryTarget', {
    methods: [mth('poke', { line: 1, params: [{ name: 'x', type: 'String' }] })],
  });
  function mkV13BoundaryCaller(name, n) {
    const calls = [];
    for (let i = 0; i < n; i++) {
      calls.push(cl('dot', 'poke', { receiver: `v13bReceiver${name}${i}`, argTexts: ["'a'"], line: i + 1, lineText: `v13bReceiver${name}${i}.poke('a');` }));
    }
    return ty(name, name, { methods: [mth('run', { line: 1, calls })] });
  }
  const idxAtCap = buildSemanticIndex([mkFile(V13H1BoundaryTarget), mkFile(mkV13BoundaryCaller('V13H1AtCapCaller', 5))]);
  assert.strictEqual(
    (idxAtCap.methodCallers.get('v13h1boundarytarget#poke') || []).length,
    5,
    'H1(b): exactly UNIQUE_NAME_MAX (5) attachments must ALL survive -- the cap only fires when the count EXCEEDS the max'
  );
  assert.strictEqual(idxAtCap.stats.unresolvedByReason['name-too-common'], 0);

  const idxOverCap = buildSemanticIndex([mkFile(V13H1BoundaryTarget), mkFile(mkV13BoundaryCaller('V13H1OverCapCaller', 6))]);
  assert.strictEqual(
    (idxOverCap.methodCallers.get('v13h1boundarytarget#poke') || []).length,
    0,
    'H1(b): one attachment past the cap (6 total) strips ALL of them, not just the excess -- "attach NONE of them for that target"'
  );
  assert.strictEqual(idxOverCap.stats.unresolvedSites, 6);
  assert.strictEqual(idxOverCap.stats.unresolvedByReason['name-too-common'], 6);
}

// ---- H1 MAGNET / CONTROL matrix (mirrors the gauntlet-org corpus shape):
// a framework-common name (bind) declared ONCE, called from 40 unresolvable-
// receiver sites across 10 caller classes (30 arity-1 matches + 10 arity-2
// mismatches) -- ALL 40 must end up unresolved and ZERO must attach. A
// separate, unrelated name (relayNotice) called from only 2 sites (well
// under the cap) must attach BOTH, exactly like pre-H1. ------------------
const V13H1MagnetTarget = ty('V13H1MagnetTarget', 'V13H1MagnetTarget', {
  methods: [mth('bind', { line: 1, params: [{ name: 'info', type: 'V13BindInfo' }] })],
});
const v13MagnetCallerFiles = [];
for (let i = 0; i < 10; i++) {
  const calls = [];
  for (let j = 0; j < 3; j++) {
    calls.push(cl('dot', 'bind', {
      receiver: `v13unresolvedRecv${i}_${j}`, argTexts: ['x'],
      line: j + 1, lineText: `v13unresolvedRecv${i}_${j}.bind(x); // arity-1, matches the sole overload`,
    }));
  }
  // one arity-2 call per class -> 10 total arity-mismatched sites, declined
  // by H1(a) before ever reaching the cap machinery at all.
  calls.push(cl('dot', 'bind', {
    receiver: `v13unresolvedRecv${i}_3`, argTexts: ['x', 'y'],
    line: 4, lineText: `v13unresolvedRecv${i}_3.bind(x, y); // arity-2, no matching overload`,
  }));
  const cls = ty(`V13MagnetCaller${i}`, `V13MagnetCaller${i}`, { methods: [mth('run', { line: 1, calls })] });
  v13MagnetCallerFiles.push(mkFile(cls));
}
const V13H1ControlTarget = ty('V13H1ControlTarget', 'V13H1ControlTarget', {
  methods: [mth('relayNotice', { line: 1, params: [{ name: 'msg', type: 'String' }] })],
});
const V13H1ControlCallerA = ty('V13H1ControlCallerA', 'V13H1ControlCallerA', {
  methods: [mth('run', { line: 1, calls: [cl('dot', 'relayNotice', { receiver: 'v13unresolvedRelayA', argTexts: ["'hi'"], line: 1, lineText: "v13unresolvedRelayA.relayNotice('hi');" })] })],
});
const V13H1ControlCallerB = ty('V13H1ControlCallerB', 'V13H1ControlCallerB', {
  methods: [mth('run', { line: 1, calls: [cl('dot', 'relayNotice', { receiver: 'v13unresolvedRelayB', argTexts: ["'hi'"], line: 1, lineText: "v13unresolvedRelayB.relayNotice('hi');" })] })],
});
const indexV13H1Magnet = buildSemanticIndex([
  mkFile(V13H1MagnetTarget), ...v13MagnetCallerFiles,
  mkFile(V13H1ControlTarget), mkFile(V13H1ControlCallerA), mkFile(V13H1ControlCallerB),
]);

{
  assert.strictEqual(
    (indexV13H1Magnet.methodCallers.get('v13h1magnettarget#bind') || []).length,
    0,
    'H1 MAGNET: a name attracting 40 unresolvable-receiver sites through the sole declarer must attach ZERO of them'
  );
  assert.strictEqual(indexV13H1Magnet.stats.unresolvedByReason['name-too-common'], 30, 'H1: the 30 arity-MATCHED sites were optimistically attached then stripped by the cap');
  assert.strictEqual(indexV13H1Magnet.stats.magnetSuppressedAttachments, 30, 'H8 diagnostics expose the exact number of stripped magnet attachments');
  assert.strictEqual(indexV13H1Magnet.stats.unresolvedByReason['unknown-receiver'] >= 10, true, 'H1: the 10 arity-MISMATCHED sites decline via the ordinary arity-gate path, never even attempting an attachment');

  const controlSites = indexV13H1Magnet.methodCallers.get('v13h1controltarget#relaynotice') || [];
  assert.strictEqual(controlSites.length, 2, 'H1 CONTROL: a name attracting only 2 unresolvable-receiver sites (well under the cap of 5) must still attach BOTH, exactly like pre-H1');
  assert.ok(controlSites.every((s) => s.via === 'unique-name'), 'H1 CONTROL: both attached sites must be via unique-name');
  assert.strictEqual(indexV13H1Magnet.stats.viaHistogram['unique-name'], 2, 'H8 via histogram is derived after magnet reconciliation, so only the two surviving control edges remain');
}

// =========================================================================
// v0.13/H3: scoped caller-direction header -- "K unresolved sites elsewhere
// mention <method>(" -- reuses the SAME H1 magnet/control index above,
// since the magnet's own cap-stripped sites are exactly what feeds K.
// =========================================================================
{
  const magnetTree = buildCallerTree(indexV13H1Magnet, { classLower: 'v13h1magnettarget', methodLower: 'bind' });
  const mentionsNode = magnetTree.root.children.find((n) => n.kind === 'unresolved-mentions');
  assert.ok(mentionsNode, 'H3: a scoped info node must surface once K>0 for the traced method');
  assert.strictEqual(
    mentionsNode.children.length,
    40,
    'H3: K=40, arity-agnostic -- all 30 cap-stripped (name-too-common) + all 10 arity-mismatched (unknown-receiver) sites mention bind( by name, regardless of their own argTexts count'
  );
  assert.ok(mentionsNode.label.includes('40 unresolved sites elsewhere mention'), `unexpected label: ${mentionsNode.label}`);
  assert.ok(mentionsNode.label.includes('bind('));
  assert.strictEqual(mentionsNode.collapsibleState, 'collapsed');
  assert.strictEqual(mentionsNode.kind, 'unresolved-mentions');
  assert.strictEqual(mentionsNode.truncated, false);
  // each mention child is a real, inspectable site (class + line), not just
  // a bare count.
  for (const child of mentionsNode.children) {
    assert.ok(child.className);
    assert.strictEqual(typeof child.line, 'number');
    assert.strictEqual(child.sites.length, 1);
  }

  const cappedMentionsTree = buildCallerTree(
    indexV13H1Magnet,
    { classLower: 'v13h1magnettarget', methodLower: 'bind' },
    { maxNodes: 5 }
  );
  const cappedMentionsNode = cappedMentionsTree.root.children.find((n) => n.kind === 'unresolved-mentions');
  assert.strictEqual(cappedMentionsTree.stats.nodes, 5, 'H3 mention-site inspection obeys the same hard maxNodes budget as the call tree');
  assert.strictEqual(cappedMentionsTree.stats.capped, true);
  assert.strictEqual(cappedMentionsNode.children.length, 3, 'root + info node leave exactly three child slots under maxNodes=5');
  assert.strictEqual(cappedMentionsNode.truncated, true);
  assert.ok(cappedMentionsNode.label.startsWith('40 unresolved sites'), 'the full scoped count stays honest even when only a capped sample is listable');

  // Control: both sites resolved as real callers -- K must be 0/omitted
  // entirely (no info node at all), and both real callers show up normally.
  // v0.13/H2: both attached callers are via='unique-name' (approximate), so
  // by default they're grouped under ONE rollup pseudo-node -- pass
  // 'expand' to check the flat underlying edge count directly.
  const controlTree = buildCallerTree(indexV13H1Magnet, { classLower: 'v13h1controltarget', methodLower: 'relaynotice' }, { showUnconfirmed: 'expand' });
  const controlMentions = controlTree.root.children.find((n) => n.kind === 'unresolved-mentions');
  assert.strictEqual(controlMentions, undefined, "H3: K=0 -- the control target's 2 sites both resolved as real callers, none stay unresolved under this name");
  assert.strictEqual(controlTree.root.children.length, 2, 'H1 control: both unresolvable-receiver sites attach via unique-name (under the cap)');

  // Callee direction is UNCHANGED by H3 -- it already had its own per-method
  // scoped "N unresolved sites" leaf (A6/H4, pre-v0.13); no mentions node
  // of this NEW kind should ever appear there.
  const calleeSideTree = buildCalleeTree(indexV13H1Magnet, { classLower: 'v13magnetcaller0', methodLower: 'run' });
  assert.ok(!calleeSideTree.root.children.some((n) => n.kind === 'unresolved-mentions'), 'H3: the new scoped-mentions node is caller-direction only');
}

// =========================================================================
// v0.13/H3: stats.unresolvedByReason breakdown, workspace-wide -- reuses
// the PRE-EXISTING H4 sanity fixture (indexH4, above: one unknown-receiver,
// one deep-chain, one non-literal-dynamic site) plus the top-level shared
// `index` (which already contains a parse-error file, BrokenGlue).
// =========================================================================
{
  assert.strictEqual(indexH4.stats.unresolvedByReason['unknown-receiver'], 1);
  assert.strictEqual(indexH4.stats.unresolvedByReason['deep-chain'], 1);
  assert.strictEqual(indexH4.stats.unresolvedByReason['non-literal-dynamic'], 1);
  assert.strictEqual(indexH4.stats.unresolvedByReason['name-too-common'], 0);
  assert.strictEqual(indexH4.stats.unresolvedByReason['parse-fallback'], 0, 'indexH4 has no parse-error file');
  // the four reasons that DO apply here sum to the same total unresolvedSites
  // already asserted above (3) -- 'parse-fallback' is file-, not
  // site-granular, and deliberately excluded from this sum (see its own
  // header note in resolver.js).
  const siteGranularSum = indexH4.stats.unresolvedByReason['unknown-receiver']
    + indexH4.stats.unresolvedByReason['deep-chain']
    + indexH4.stats.unresolvedByReason['non-literal-dynamic']
    + indexH4.stats.unresolvedByReason['name-too-common'];
  assert.strictEqual(siteGranularSum, indexH4.stats.unresolvedSites);

  assert.strictEqual(
    index.stats.unresolvedByReason['parse-fallback'],
    index.parseFallbacks.length,
    "H3: 'parse-fallback' is set directly from parseFallbacks.length (file-granular), independent of unresolvedSites"
  );
  assert.ok(index.stats.unresolvedByReason['parse-fallback'] >= 1, 'the shared index includes at least the BrokenGlue parse-error fixture');
}

// =========================================================================
// v0.13/H2: approximate rollup -- 'rollup' (default) | 'hide' | 'expand'.
// Mixed confirmed + approximate siblings at ONE level (callee direction:
// H2Caller.run() calls both a confirmed static target AND an
// interface-typed receiver, which forward-collapses onto the interface's
// own node, approximate:true) -- proves grouping/hiding/expanding all
// operate on the SAME underlying edge set (regression policy (b): flatten
// equivalence).
// =========================================================================
const V13H2Iface = ty('V13H2Iface', 'V13H2Iface', { isInterface: true, methods: [mth('act', { line: 1 })] });
const V13H2ImplA = ty('V13H2ImplA', 'V13H2ImplA', { implementsTypes: ['V13H2Iface'], methods: [mth('act', { line: 1 })] });
const V13H2ImplB = ty('V13H2ImplB', 'V13H2ImplB', { implementsTypes: ['V13H2Iface'], methods: [mth('act', { line: 1 })] });
const V13H2DirectTarget = ty('V13H2DirectTarget', 'V13H2DirectTarget', { methods: [mth('direct', { line: 1 })] });
const V13H2Caller = ty('V13H2Caller', 'V13H2Caller', {
  methods: [mth('run', {
    line: 1,
    params: [{ name: 'i', type: 'V13H2Iface' }],
    calls: [
      cl('dot', 'act', { receiver: 'i', line: 1, lineText: 'i.act();' }),
      cl('dot', 'direct', { receiver: 'V13H2DirectTarget', line: 2, lineText: 'V13H2DirectTarget.direct();' }),
    ],
  })],
});
const indexV13H2 = buildSemanticIndex([mkFile(V13H2Iface), mkFile(V13H2ImplA), mkFile(V13H2ImplB), mkFile(V13H2DirectTarget), mkFile(V13H2Caller)]);

function v13FlattenRollup(nodes) {
  const out = [];
  for (const n of nodes) {
    if (n.kind === 'rollup') out.push(...n.children);
    else out.push(n);
  }
  return out;
}

{
  // 'expand' -- the pre-H2 flat baseline: the interface call site fans out
  // to the interface method itself AND both implementers (3 approximate
  // 'interface' children), plus the one confirmed static target -- 4 direct
  // siblings, no pseudo-node.
  const calleeExpand = buildCalleeTree(indexV13H2, { classLower: 'v13h2caller', methodLower: 'run' }, { showUnconfirmed: 'expand' });
  assert.strictEqual(calleeExpand.root.children.length, 4, "H2 'expand': byte-identical to pre-H2 -- all 4 children flat, no pseudo-node");
  const expandLabels = calleeExpand.root.children.map((n) => n.label).sort();
  assert.deepStrictEqual(expandLabels, ['V13H2Iface.act', 'V13H2ImplA.act', 'V13H2ImplB.act', 'V13H2DirectTarget.direct'].sort());
  const expandDirect = calleeExpand.root.children.find((n) => n.label === 'V13H2DirectTarget.direct');
  assert.strictEqual(expandDirect.approximate, false);
  for (const label of ['V13H2Iface.act', 'V13H2ImplA.act', 'V13H2ImplB.act']) {
    assert.strictEqual(calleeExpand.root.children.find((n) => n.label === label).approximate, true);
  }

  // 'rollup' (default) -- confirmed node passes through untouched; all 3
  // approximate nodes move under one new pseudo-node.
  const calleeDefault = buildCalleeTree(indexV13H2, { classLower: 'v13h2caller', methodLower: 'run' });
  assert.strictEqual(calleeDefault.root.children.length, 2, "H2 default 'rollup': the confirmed node (1) + the ONE rollup pseudo-node (1) = 2 top-level children");
  const rollupDirect = calleeDefault.root.children.find((n) => n.label === 'V13H2DirectTarget.direct');
  assert.ok(rollupDirect, 'H2: the confirmed node is completely untouched by rollup grouping');
  assert.strictEqual(rollupDirect.approximate, false);
  const rollupNode = calleeDefault.root.children.find((n) => n.kind === 'rollup');
  assert.ok(rollupNode, "H2: a 'rollup' pseudo-node must exist by default");
  assert.strictEqual(rollupNode.label, '3 possible callees (unconfirmed)');
  assert.strictEqual(rollupNode.collapsibleState, 'collapsed');
  assert.strictEqual(rollupNode.approximate, true);
  assert.strictEqual(rollupNode.children.length, 3);
  assert.deepStrictEqual(
    rollupNode.children.map((n) => n.label).sort(),
    ['V13H2Iface.act', 'V13H2ImplA.act', 'V13H2ImplB.act'].sort()
  );
  assert.ok(rollupNode.children.every((n) => n.approximate === true));

  // FLATTEN EQUIVALENCE PROOF (regression policy (b)): flatten(rollup
  // children) + confirmed === the old (expand-mode) flat child set.
  const flattenedDefault = v13FlattenRollup(calleeDefault.root.children).map((n) => n.label).sort();
  assert.deepStrictEqual(flattenedDefault, expandLabels, 'H2: flatten(rollup children)+confirmed must equal the pre-H2 flat child set -- the underlying edge set is unchanged, only its RENDERING is regrouped');

  // 'hide' -- approximate children dropped entirely, confirmed set unchanged.
  const calleeHide = buildCalleeTree(indexV13H2, { classLower: 'v13h2caller', methodLower: 'run' }, { showUnconfirmed: 'hide' });
  assert.strictEqual(calleeHide.root.children.length, 1, "H2 'hide': the approximate nodes are dropped entirely, not even a count");
  assert.strictEqual(calleeHide.root.children[0].label, 'V13H2DirectTarget.direct');
  assert.deepStrictEqual(
    calleeHide.root.children.map((n) => n.label).sort(),
    expandLabels.filter((l) => !['V13H2Iface.act', 'V13H2ImplA.act', 'V13H2ImplB.act'].includes(l)),
    "H2 'hide': confirmed-only set must equal expand-mode's confirmed subset"
  );
}

// ---- H2 caller direction + all-approximate level (no confirmed siblings
// at all -- the rollup pseudo-node is the ONLY child). --------------------
{
  // Reuses the shared top-level `index`'s pre-existing IHandler/InterfaceCaller
  // fixture (a single approximate 'interface' caller, no confirmed siblings
  // at this level).
  const ifaceCallerTree = buildCallerTree(index, { classLower: 'ihandler', methodLower: 'handle' });
  const rollup = ifaceCallerTree.root.children.find((n) => n.kind === 'rollup');
  assert.ok(rollup, 'H2 callers direction: rollup grouping applies identically to both directions');
  assert.strictEqual(rollup.label, '1 possible caller (unconfirmed)');
  assert.strictEqual(ifaceCallerTree.root.children.length, 1, 'H2: with zero confirmed siblings, the rollup pseudo-node is the ONLY child');
  const nested = findChild(ifaceCallerTree.root.children, 'InterfaceCaller.dispatch');
  assert.ok(nested, 'H2: findChild recurses into the rollup to find the real nested caller');
  assert.strictEqual(nested.via, 'interface');
}

// =========================================================================
// v0.13/H4: opts.shouldCancel() guards resolver.js's own outer index-build
// loops (pass A/B/C/D/E) -- a signal observed partway through is LATCHED
// and skips every remaining pass, not just the one that first saw it.
// =========================================================================
{
  const V13H4CancelA = ty('V13H4CancelA', 'V13H4CancelA', { methods: [mth('m', { line: 1 })] });
  const V13H4CancelB = ty('V13H4CancelB', 'V13H4CancelB', {
    methods: [mth('n', { line: 1, calls: [cl('dot', 'm', { receiver: 'V13H4CancelA', line: 1, lineText: 'V13H4CancelA.m();' })] })],
  });
  const facts4 = [mkFile(V13H4CancelA), mkFile(V13H4CancelB)];

  // Immediate cancellation -- fires on the very first file pass A visits.
  const idxImmediate = buildSemanticIndex(facts4, { shouldCancel: () => true });
  assert.strictEqual(idxImmediate.cancelled, true, 'H4: an always-true shouldCancel must be observed and latched');
  assert.strictEqual(idxImmediate.classes.size, 0, 'H4: cancelled before pass A registers even the first class');
  assert.strictEqual(idxImmediate.methodCallers.size, 0);

  // Cancel exactly once pass A has registered both classes (2 files -> 2
  // calls) but on pass B's very FIRST iteration (the 3rd call overall) --
  // pass B must never resolve anything once latched.
  let calls = 0;
  const idxMidway = buildSemanticIndex(facts4, { shouldCancel: () => { calls++; return calls > 2; } });
  assert.strictEqual(idxMidway.cancelled, true, "H4: a shouldCancel flipping true PARTWAY through must still be observed by a LATER pass's own guard");
  assert.strictEqual(idxMidway.classes.size, 2, 'H4: pass A itself completed normally (both classes registered) before the signal fired');
  assert.strictEqual((idxMidway.methodCallers.get('v13h4cancela#m') || []).length, 0, "H4: pass B never resolves V13H4CancelB's call once cancelled is latched, even though both classes were already registered");

  // Never cancels -- byte-identical to omitting opts.shouldCancel entirely.
  const idxNormal = buildSemanticIndex(facts4, { shouldCancel: () => false });
  assert.strictEqual(idxNormal.cancelled, false);
  assert.strictEqual((idxNormal.methodCallers.get('v13h4cancela#m') || []).length, 1, 'H4: a shouldCancel that never fires must resolve completely normally');

  // Omitted entirely -- must behave exactly like idxNormal (no crash, no
  // silent regression for every pre-H4 caller of buildSemanticIndex).
  const idxOmitted = buildSemanticIndex(facts4);
  assert.strictEqual(idxOmitted.cancelled, false);
  assert.strictEqual((idxOmitted.methodCallers.get('v13h4cancela#m') || []).length, 1);

  // Trace-time cancellation (buildCallerTree/buildCalleeTree's own BFS
  // expansion loop) must never crash and must mark the tree capped instead
  // of silently rendering a partial-but-unmarked tree.
  const cancelledTree = buildCallerTree(index, { classLower: 'oppservice', methodLower: null }, { shouldCancel: () => true });
  assert.ok(cancelledTree && cancelledTree.root, 'H4: a trace-time shouldCancel must never crash the tree walk');
  assert.strictEqual(cancelledTree.stats.capped, true, 'H4: an always-true shouldCancel must mark the tree capped (BFS expansion stopped before draining the queue)');
}

// =========================================================================
// v0.14 Impact Analysis: overload precision, uncertain picks, contract
// surfaces, metadata, parent-flow chains, and empty-honest negatives.
// =========================================================================
{
  const ImpactIface = ty('ImpactIface', 'ImpactIface', {
    isInterface: true,
    methods: [mth('change', { line: 2, params: [{ name: 'value', type: 'String' }] })],
  });
  const ImpactBase = ty('ImpactBase', 'ImpactBase', {
    methods: [mth('change', { line: 3, params: [{ name: 'value', type: 'String' }] })],
  });
  const ImpactTarget = ty('ImpactTarget', 'ImpactTarget', {
    extendsType: 'ImpactBase',
    implementsTypes: ['ImpactIface'],
    methods: [
      mth('change', { line: 10, params: [{ name: 'value', type: 'String' }] }),
      mth('change', { line: 11, params: [{ name: 'value', type: 'Integer' }] }),
      mth('change', { line: 12, params: [{ name: 'value', type: 'Decimal' }] }),
      mth('unusedPrivate', { line: 20, modifiers: ['private'] }),
    ],
  });
  const ImpactChild = ty('ImpactChild', 'ImpactChild', {
    extendsType: 'ImpactTarget',
    methods: [mth('change', { line: 4, params: [{ name: 'value', type: 'String' }] })],
  });
  const ImpactExactCaller = ty('ImpactExactCaller', 'ImpactExactCaller', {
    methods: [mth('run', {
      line: 1,
      locals: [{ name: 'target', type: 'ImpactTarget', line: 1 }],
      calls: [cl('dot', 'change', { receiver: 'target', argTexts: ["'hello'"], line: 2, lineText: "target.change('hello');" })],
    })],
  });
  const ImpactTieCaller = ty('ImpactTieCaller', 'ImpactTieCaller', {
    methods: [mth('run', {
      line: 1,
      locals: [{ name: 'target', type: 'ImpactTarget', line: 1 }],
      calls: [cl('dot', 'change', { receiver: 'target', argTexts: ['null'], line: 2, lineText: 'target.change(null);' })],
    })],
  });
  const ImpactFallbackCaller = ty('ImpactFallbackCaller', 'ImpactFallbackCaller', {
    methods: [mth('run', {
      line: 1,
      locals: [{ name: 'target', type: 'ImpactTarget', line: 1 }],
      calls: [cl('dot', 'change', { receiver: 'target', argTexts: ["'x'", "'y'"], line: 2, lineText: "target.change('x', 'y');" })],
    })],
  });
  const ImpactIfaceCaller = ty('ImpactIfaceCaller', 'ImpactIfaceCaller', {
    methods: [mth('run', {
      line: 1,
      params: [{ name: 'target', type: 'ImpactIface' }],
      calls: [cl('dot', 'change', { receiver: 'target', argTexts: ["'iface'"], line: 2, lineText: "target.change('iface');" })],
    })],
  });
  const ImpactBaseCaller = ty('ImpactBaseCaller', 'ImpactBaseCaller', {
    methods: [mth('run', {
      line: 1,
      params: [{ name: 'target', type: 'ImpactBase' }],
      calls: [cl('dot', 'change', { receiver: 'target', argTexts: ["'base'"], line: 2, lineText: "target.change('base');" })],
    })],
  });
  const impactIndex = buildSemanticIndex([
    mkFile(ImpactIface), mkFile(ImpactBase), mkFile(ImpactTarget), mkFile(ImpactChild),
    mkFile(ImpactExactCaller), mkFile(ImpactTieCaller), mkFile(ImpactFallbackCaller),
    mkFile(ImpactIfaceCaller), mkFile(ImpactBaseCaller),
  ]);
  attachMetaCallers(impactIndex, [
    { kind: 'lwc', label: 'impactPanel', path: '/ws/lwc/impactPanel.js', line: 1, className: 'ImpactTarget', methodName: 'change' },
    { kind: 'vf', label: 'ImpactPage', path: '/ws/pages/ImpactPage.page', line: 2, className: 'ImpactTarget', methodName: 'change' },
    { kind: 'flow', label: 'ImpactChildFlow', path: '/ws/flows/ImpactChildFlow.flow-meta.xml', line: 3, className: 'ImpactTarget', methodName: 'change', subflows: [] },
    { kind: 'flow', label: 'ImpactParentFlow', path: '/ws/flows/ImpactParentFlow.flow-meta.xml', line: 4, className: null, methodName: null, subflows: ['ImpactChildFlow'] },
  ]);

  assert.strictEqual(impactMethodSignature(ImpactTarget.methods[0]), 'change(String)');
  const impactSites = impactIndex.methodCallers.get('impacttarget#change') || [];
  assert(impactSites.some((s) => s.callerClass === 'ImpactExactCaller' && s.overloadPick === 'exact'), JSON.stringify(impactSites));
  const impactTieSite = impactSites.find((s) => s.callerClass === 'ImpactTieCaller' && s.overloadPick === 'arity-tie');
  assert(impactTieSite);
  assert.deepStrictEqual(
    impactTieSite.tiedOverloadSigs,
    ['change(String)', 'change(Integer)', 'change(Decimal)'],
    'arity-tie evidence retains every equally-best signature, not only the deterministic graph edge'
  );
  assert(impactSites.some((s) => s.callerClass === 'ImpactFallbackCaller' && s.overloadPick === 'fallback'));

  const report = buildImpactReport(impactIndex, {
    classLower: 'impacttarget', methodLower: 'change', overloadSig: 'change(String)',
  });
  assert(report && !report.needsOverloadChoice);
  assert.strictEqual(report.target.label, 'ImpactTarget.change(String)');
  assert(report.breaks.some((s) => s.callerClass === 'ImpactExactCaller'), 'exact typed caller is a direct break');
  assert(!report.breaks.some((s) => s.callerClass === 'ImpactTieCaller'), 'arity tie is never promoted to a direct break');
  assert(report.mightBreak.some((s) => s.callerClass === 'ImpactTieCaller' && s.overloadPick === 'arity-tie'));
  assert(report.mightBreak.some((s) => s.callerClass === 'ImpactFallbackCaller' && s.overloadPick === 'fallback'));
  assert(report.mightBreak.some((s) => s.callerClass === 'ImpactIfaceCaller' && s.via === 'interface'));
  assert(report.mightBreak.some((s) => s.callerClass === 'ImpactBaseCaller' && s.via === 'override'));
  assert.strictEqual(report.contract.interfaces.length, 1);
  assert.strictEqual(report.contract.interfaces[0].iface, 'ImpactIface');
  assert.strictEqual(report.contract.interfaces[0].callers.length, 1, 'one physical interface call is not duplicated across declaration + implementation indexes');
  assert(report.contract.overrides.base && report.contract.overrides.base.label === 'ImpactBase.change(String)');
  assert.deepStrictEqual(report.contract.overrides.overriddenBy.map((o) => o.label), ['ImpactChild.change(String)']);
  assert(report.contract.overrides.callersOfBase.some((s) => s.callerClass === 'ImpactBaseCaller'));
  assert.deepStrictEqual(report.metadata.map((m) => m.kind), ['flow', 'lwc', 'vf']);
  const flowImpact = report.metadata.find((m) => m.kind === 'flow');
  assert.deepStrictEqual(flowImpact.parentFlows.map((f) => f.label), ['ImpactParentFlow']);
  assert.deepStrictEqual(report.otherOverloads.map((o) => o.overloadSig), ['change(Integer)', 'change(Decimal)']);
  assert.strictEqual(report.stats.metadataSurfaces, 3);
  assert.strictEqual(report.stats.contractSurfaces, 3, 'interface + base + overriding child');

  for (const tiedSignature of ['change(Integer)', 'change(Decimal)']) {
    const tiedReport = buildImpactReport(impactIndex, {
      classLower: 'impacttarget', methodLower: 'change', overloadSig: tiedSignature,
    });
    assert(
      tiedReport.mightBreak.some((s) => s.callerClass === 'ImpactTieCaller' && s.overloadPick === 'arity-tie'),
      `${tiedSignature} must include the same physical null-call tie under MIGHT BREAK`
    );
    assert(
      !tiedReport.breaks.some((s) => s.callerClass === 'ImpactExactCaller'),
      `${tiedSignature} must not inherit the exact String caller`
    );
  }

  // A score tie can cover only a SUBSET of same-arity siblings. Preserve the
  // actual top-scoring signature set rather than treating every same-arity
  // overload as relevant.
  const ImpactSubsetTarget = ty('ImpactSubsetTarget', 'ImpactSubsetTarget', {
    methods: [
      mth('choose', { params: [{ name: 'left', type: 'String' }, { name: 'right', type: 'Integer' }] }),
      mth('choose', { params: [{ name: 'left', type: 'String' }, { name: 'right', type: 'Decimal' }] }),
      mth('choose', { params: [{ name: 'left', type: 'Integer' }, { name: 'right', type: 'Boolean' }] }),
    ],
  });
  const ImpactSubsetCaller = ty('ImpactSubsetCaller', 'ImpactSubsetCaller', {
    methods: [mth('run', {
      locals: [{ name: 'target', type: 'ImpactSubsetTarget', line: 1 }],
      calls: [cl('dot', 'choose', { receiver: 'target', argTexts: ["'x'", 'null'], line: 2 })],
    })],
  });
  const subsetIndex = buildSemanticIndex([mkFile(ImpactSubsetTarget), mkFile(ImpactSubsetCaller)]);
  const subsetTieSite = (subsetIndex.methodCallers.get('impactsubsettarget#choose') || [])[0];
  assert.deepStrictEqual(
    subsetTieSite.tiedOverloadSigs,
    ['choose(String, Integer)', 'choose(String, Decimal)'],
    'only equally-top-scoring siblings are retained as tie candidates'
  );
  for (const tiedSignature of subsetTieSite.tiedOverloadSigs) {
    const tiedReport = buildImpactReport(subsetIndex, {
      classLower: 'impactsubsettarget', methodLower: 'choose', overloadSig: tiedSignature,
    });
    assert(tiedReport.mightBreak.some((s) => s.callerClass === 'ImpactSubsetCaller'));
  }
  const unrelatedSameArity = buildImpactReport(subsetIndex, {
    classLower: 'impactsubsettarget', methodLower: 'choose', overloadSig: 'choose(Integer, Boolean)',
  });
  assert(
    !unrelatedSameArity.mightBreak.some((s) => s.callerClass === 'ImpactSubsetCaller'),
    'a lower-scoring same-arity sibling must not be contaminated by the tie'
  );

  const needsChoice = buildImpactReport(impactIndex, { classLower: 'impacttarget', methodLower: 'change' });
  assert.strictEqual(needsChoice.needsOverloadChoice, true);
  assert.deepStrictEqual(needsChoice.availableOverloads.map((o) => o.overloadSig), ['change(String)', 'change(Integer)', 'change(Decimal)']);

  const empty = buildImpactReport(impactIndex, {
    classLower: 'impacttarget', methodLower: 'unusedprivate', overloadSig: 'unusedPrivate()',
  });
  assert(empty && empty.breaks.length === 0 && empty.mightBreak.length === 0 && empty.metadata.length === 0, 'private uncalled method produces an honest empty report');
  assert.strictEqual(buildImpactReport(impactIndex, { classLower: 'missing', methodLower: 'change' }), null);
}

console.log('test-resolver.js: all assertions passed.');

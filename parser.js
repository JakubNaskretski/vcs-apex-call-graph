'use strict';
// Semantic (AST-based) Apex facts extractor — a thin facade over
// @apexdevtools/apex-parser that produces the frozen FileFacts contract with
// a SINGLE listener walk per file. parseFile() must never throw: any parse
// or walk failure degrades to `parseError` set + whatever partial facts were
// gathered before the failure (resolver.js falls back to lexical scanning
// for files with parseError set).
//
// Design notes (spec was ambiguous on these; simplest reading picked, see
// KNOWN PITFALLS review this was written against):
//
// - SOQL bind-expression calls (`[SELECT Id FROM Account WHERE Id = :f()]`):
//   verified live — no special extraction needed. `:f()` parses as an
//   ordinary bound expression wrapping a normal methodCall/dotExpression
//   node, so the walker descends into it and enterMethodCall/enterDotExpression
//   fire exactly as they would anywhere else in a statement.
// - Constructors keep MethodFacts.name === their declared (simple) name and
//   isCtor=true; folding that to a synthetic `#<init>` methodKey is
//   resolver.js's indexing concern, not parser.js's extraction concern.
// - annotations[] stores the bare annotation NAME only, lowercased, no `@`,
//   no parenthesized argument list — `@InvocableMethod(label='x')` yields
//   'invocablemethod'. This is required for ENTRIES matching in resolver.js.
// - implementsTypes / extendsType store RAW declaration text (may carry a
//   namespace prefix and/or generic args, e.g. 'Database.Batchable<sObject>');
//   normalizing that is resolver.js's job.
// - interfaces may `extends` multiple parents; TypeFacts.extendsType is a
//   single nullable string per the frozen shape, so only the FIRST
//   extends-list entry is kept — an accepted, documented approximation.
// - '(init)' is ONE synthetic method per type that aggregates every field
//   initializer plus every static/instance initializer block in that type
//   (Apex has no way to distinguish "which init ran first" statically, and
//   the frozen shape has no room for more than one such scope per type).
//   Its line/endLine expand to span every contributing occurrence.
// - '(get NAME)'/'(set NAME)' synthetic scopes are created for EVERY
//   declared accessor (enterGetter/enterSetter fire once per accessor,
//   independent of whether it has a body) so resolver.js's A2 property-
//   accessor edges always have a real MethodFacts entry to land on --
//   auto-implemented accessors (`{ get; set; }`, no body block) register
//   the scope but simply have nothing to walk (no pushScope), so `calls`
//   stays empty. Only when the accessor HAS a body block do we push it as
//   the active scope so calls inside it get attributed correctly.
// - Compound modifiers ('with sharing', 'without sharing') are emitted as
//   whatever antlr4's whitespace-free getText() produces (e.g.
//   'withsharing') since the grammar packs them into a single
//   ModifierContext token run. Cosmetic-only; not part of the required
//   test-coverage list.
// - AMENDMENT F1 (DML statement facts, MethodFacts.dml[]): the grammar gives
//   each DML STATEMENT form (`insert x;`, `update x;`, ...) its own rule/
//   context type (InsertStatementContext, UpdateStatementContext,
//   DeleteStatementContext, UndeleteStatementContext, UpsertStatementContext,
//   MergeStatementContext), verified live via introspection against the
//   installed @apexdevtools/apex-parser: each exposes `expression()` (the
//   DML target) except MergeStatementContext, which exposes
//   `expression_list()` (master record first, record(s)-to-merge second --
//   confirmed live with `merge master dupes;`). targetText is the
//   source-faithful slice of that target expression (for merge, the FIRST
//   list entry -- the master/kept record, which is what determines the
//   object type; both sides are the same SObject type by construction so
//   this loses no information relevant to op->trigger-event mapping). This
//   deliberately mirrors addCall's convention: the ctx passed for line/col
//   is the whole statement context, so line/col land on the leading keyword
//   (`insert`/`update`/...), not the target expression. Database.xxx()
//   METHOD-form DML (`Database.insert(x, false)`) needs no handling here --
//   verified live it already flows through enterDotExpression/enterMethodCall
//   as an ordinary 'dot' CallFacts with receiver 'Database'; resolver.js maps
//   the method name to a DML op instead of parser.js special-casing it.
// - AMENDMENT G2 (throw/catch tracing, MethodFacts.throwsSites[]/catches[]):
//   a `throw` statement's expression is either a NewExpressionContext
//   (`throw new AcmeX(...)`) -- creator head text, same generics-stripped
//   convention as enterNewExpression -- or, for the caught-and-rethrown
//   `throw e;` form, a PrimaryExpressionContext wrapping an IdPrimaryContext
//   (a bare identifier) -- varName captured, typeName left null for
//   resolver.js to resolve later via the enclosing method's catches/locals/
//   params (verified live: both shapes parse to exactly these two context
//   types). Any other throw-expression shape (cast, dotted property, method
//   call result, ...) is out of the two documented shapes -- both typeName
//   and varName are left null rather than guessing; resolver.js's "throw e"
//   resolution already treats an unresolvable varName as "skip", so an
//   unrecognized shape degrades the same way. `catches[]` is populated from
//   enterCatchClause (which already existed for locals[] registration) --
//   ctx.start is the CATCH token, matching the MANIFEST's cited catch-site
//   line numbers exactly. Neither throwsSites nor catches push a new scope:
//   a try/catch/finally block is NOT a MethodFacts boundary, so throw sites
//   and catch clauses at any nesting depth (multi-catch on one try, nested
//   try inside a catch/finally) all attribute to the same enclosing method
//   scope, which is what lets resolver.js's ancestor-catch-badge walk work
//   with a flat per-method catches[] list.
// - AMENDMENT G3 (instanceof narrowing, MethodFacts.narrowings[]): only the
//   "simple-identifier receiver" shape is captured (`x instanceof T`, where
//   `x` is a bare local/param/field reference) -- same
//   PrimaryExpressionContext/IdPrimaryContext shape check as the G2 `throw e`
//   case, reused via simpleIdentifierName(). A non-identifier receiver
//   (`this.x instanceof T`, `getX() instanceof T`) is captured nowhere,
//   since resolver.js's G3 fallback is keyed purely on varName. No scope
//   push: instanceOf expressions can appear anywhere an expression is legal
//   (if-condition, ternary, plain statement, ...) and always attribute to
//   whatever method-like scope is already active.
// - AMENDMENT G4 (anonymous Apex, FileFacts.kind 'anonymous'): a `.apex`
//   path is parsed via parser.anonymousUnit() (grammar entry rule for
//   "Execute Anonymous" scripts) instead of parser.compilationUnit() --
//   verified live, no top-level type wrapper is required or expected. A
//   single synthetic pseudo-type (name/qualified = the file stem, same
//   baseName() used for .cls/.trigger) is pushed on enterAnonymousUnit with
//   one synthetic method '(anonymous)', which is pushed as the active scope
//   so every statement in the script's top-level block -- calls, DML,
//   locals, throws, catches, narrowings alike -- attributes to it exactly
//   like any other method body. Per the G4 spec this method also directly
//   carries `entries: ['Anonymous Apex script']` on its MethodFacts (unlike
//   every other entry-point label in this codebase, which resolver.js
//   derives from annotations/modifiers -- an anonymous script has no
//   annotation to derive from, so parser.js hard-codes it here instead).
// - AMENDMENT A1 (property accessor CallFacts, kind 'prop'): the grammar's
//   left-recursive `expression DOT (dotMethodCall | anyId)` production means
//   a DotExpressionContext with no dotMethodCall() is the anyId()-only
//   alternative -- a bare `x.Prop` reference, not a method call. That is a
//   property READ unless this exact ctx is the assignment TARGET of an
//   AssignExpressionContext (`x.Prop = ...` / `x.Prop += ...` / any compound
//   assign operator), in which case enterAssignExpression() claims it first
//   (via propWriteTargets, a WeakSet keyed by ctx so the later
//   enterDotExpression() visit on that same node knows to stay silent) and
//   emits a single 'set' instead of a 'get'. Nested dotted receivers (e.g.
//   `a.b.c = x`) still correctly emit a 'get' for the inner `a.b` -- that
//   sub-expression is genuinely read (to obtain the object `.c` is set on)
//   even though the outermost expression is a write, so no special-casing
//   is needed there. `x.Prop(...)` is unaffected (dotMethodCall() present)
//   and keeps producing kind 'dot' exactly as before. Only the dot form is
//   handled per the amendment's own scope note ("dot property READS");
//   implicit/bare (`Prop = x` with no receiver, inside the declaring class)
//   is out of scope. Over-emission (e.g. a dotted access that turns out to
//   be a field, not a declared property) is explicitly acceptable per the
//   amendment -- resolver.js is the one that filters to declared
//   properties, not parser.js.

const {
  ApexParserFactory,
  ApexParserBaseListener,
  ApexParseTreeWalker,
  ApexErrorListener,
  DotExpressionContext,
  NewExpressionContext,
  PrimaryExpressionContext,
  IdPrimaryContext,
} = require('@apexdevtools/apex-parser');

// --- small text/source helpers ------------------------------------------

function baseName(p) {
  const b = String(p || '').split(/[\\/]/).pop() || '';
  // G4: '.apex' (anonymous-script) files join the existing cls/trigger
  // extensions here -- same stem-extraction convention, no -meta.xml
  // sidecar exists for anonymous scripts but the alternation is harmless.
  return b.replace(/\.(cls|trigger|apex)(-meta\.xml)?$/i, '');
}

// G2/G3: source-faithful "is this expression a bare identifier?" check,
// shared by throw-statement rethrow resolution (`throw e;`) and instanceof
// narrowing (`x instanceof T`). A bare identifier parses as a
// PrimaryExpressionContext wrapping an IdPrimaryContext -- verified live.
// Returns the identifier text, or null if the expression is any other shape.
function simpleIdentifierName(exprCtx) {
  if (!(exprCtx instanceof PrimaryExpressionContext)) return null;
  const primary = exprCtx.primary();
  if (!(primary instanceof IdPrimaryContext)) return null;
  return primary.id().getText();
}

// BUG FIX (finding #5): @apexdevtools/apex-parser's CharStream is built with
// decodeToUnicodeCodePoints=true (verified live in
// node_modules/@apexdevtools/apex-parser/dist/esm/CaseInsensitiveInputStream.js,
// which passes that flag straight to antlr4's CharStream ctor), so
// ctx.start.start / ctx.stop.stop count Unicode CODE POINTS, not UTF-16 code
// units. JS strings (and String.prototype.slice) index by UTF-16 code unit.
// Those two counts are identical until the source contains an astral-plane
// character (a surrogate pair — two UTF-16 units, one code point) ANYWHERE
// earlier in the file, including inside a comment or string literal; every
// offset after that point is then off by one JS index per such character,
// silently slicing the wrong substring with no thrown error and no
// parseError. buildCpToUtf16Map()/cpToUtf16() translate a code-point offset
// back to the correct JS string index before slicing.
function buildCpToUtf16Map(text) {
  const map = [0];
  let u = 0;
  while (u < text.length) {
    const cp = text.codePointAt(u);
    u += cp > 0xffff ? 2 : 1; // surrogate pair consumes 2 UTF-16 units but 1 code point
    map.push(u);
  }
  return map;
}

// Source-faithful text for any parse-tree node: antlr4's getText() strips
// whitespace between tokens, which would turn `svc.process(o, count)` into
// `svc.process(o,count)`. Slicing the original source by token char offsets
// preserves it exactly, per the CallFacts contract's 'source-faithful text'
// requirement for argTexts/receiver. `cpMap` (see buildCpToUtf16Map) converts
// the parser's code-point offsets to the JS string's UTF-16 offsets first.
function sliceSource(text, cpMap, ctx) {
  if (!ctx || !ctx.start || !ctx.stop) return '';
  const startCp = ctx.start.start;
  const stopCp = ctx.stop.stop;
  if (!cpMap) return text.slice(startCp, stopCp + 1); // defensive fallback, should not happen
  return text.slice(cpMap[startCp], cpMap[stopCp + 1]);
}

function lineTextAt(lines, line1based) {
  const raw = lines[line1based - 1] || '';
  const t = raw.trim();
  return t.length > 160 ? t.slice(0, 160) : t;
}

// Modifiers/annotations never live directly on a method/field/class
// declaration node itself — they live on the nearest ancestor that wraps it
// (ClassBodyDeclarationContext for class members, TriggerBlockMemberContext
// for trigger-body members, TypeDeclarationContext for top-level types,
// InterfaceMethodDeclarationContext already carries its own). Climb until a
// node exposing modifier_list() is found; capped to stay bounded.
function findModifierList(ctx) {
  let p = ctx;
  let hops = 0;
  while (p && typeof p.modifier_list !== 'function' && hops < 6) {
    p = p.parentCtx;
    hops++;
  }
  return p && typeof p.modifier_list === 'function' ? p.modifier_list() : [];
}

function splitModifiers(modifierCtxList) {
  const annotations = [];
  const modifiers = [];
  for (const m of modifierCtxList || []) {
    const ann = m.annotation ? m.annotation() : null;
    if (ann && ann.qualifiedName) {
      annotations.push(ann.qualifiedName().getText().toLowerCase());
    } else {
      modifiers.push(m.getText().toLowerCase());
    }
  }
  return { annotations, modifiers };
}

function extractParams(formalParametersCtx) {
  if (!formalParametersCtx || !formalParametersCtx.formalParameterList) return [];
  const list = formalParametersCtx.formalParameterList();
  if (!list) return [];
  return list.formalParameter_list().map((p) => ({
    name: p.id().getText(),
    type: p.typeRef().getText(),
  }));
}

function extractCallArgs(text, cpMap, expressionListCtx) {
  if (!expressionListCtx) return [];
  return expressionListCtx.expression_list().map((e) => sliceSource(text, cpMap, e));
}

function triggerCaseText(tc) {
  const when = tc.BEFORE() ? 'before' : tc.AFTER() ? 'after' : '';
  let action = '';
  if (tc.INSERT()) action = 'insert';
  else if (tc.UPDATE()) action = 'update';
  else if (tc.DELETE()) action = 'delete';
  else if (tc.UNDELETE()) action = 'undelete';
  return (when + ' ' + action).trim();
}

// --- listener -------------------------------------------------------------
// Single top-down walk. Two explicit stacks track "where am I":
//   typeStack  — current TypeFacts (class/interface/enum/trigger-pseudo-type)
//   scopeStack — current MethodFacts (method/ctor/accessor/init/trigger body)
// Calls and locals encountered mid-walk are appended to whatever is on top
// of scopeStack; nothing is buffered/re-attached after the fact.
class FactsListener extends ApexParserBaseListener {
  constructor(text, lines, fileFacts, cpMap) {
    super();
    this.text = text;
    this.lines = lines;
    this.fileFacts = fileFacts;
    this.cpMap = cpMap; // code-point -> UTF-16 offset map, see buildCpToUtf16Map
    this.typeStack = [];
    this.scopeStack = [];
    // typeFacts object identity -> Map<syntheticName, MethodFacts>, so that
    // e.g. every field initializer in a class reuses the SAME '(init)' entry
    // instead of creating one per field.
    this.syntheticByType = new Map();
    // ctx -> pushed, so an exit handler only pops if its matching enter
    // actually pushed. Several enters guard the push on `currentType()`
    // being non-null (or another condition) — on a malformed/error-recovered
    // tree that invariant can't be trusted to hold symmetrically at exit
    // time, so track it explicitly rather than re-deriving the condition
    // (which risks popping a scope that belongs to someone else).
    this.pushedScopes = new WeakSet();
    // A1: DotExpressionContext nodes claimed by enterAssignExpression() as a
    // property-WRITE target (`x.Prop = ...` / compound assign). Populated
    // before the walker descends into that same node, so the later
    // enterDotExpression(ctx) visit can tell "this is a write, already
    // emitted as 'set'" apart from "this is a plain read, emit 'get'".
    this.propWriteTargets = new WeakSet();
  }

  pushScope(ctx, mf) {
    this.scopeStack.push(mf);
    this.pushedScopes.add(ctx);
  }

  popScopeIfPushed(ctx) {
    if (this.pushedScopes.has(ctx)) {
      this.scopeStack.pop();
      this.pushedScopes.delete(ctx);
    }
  }

  currentType() {
    return this.typeStack.length ? this.typeStack[this.typeStack.length - 1] : null;
  }

  currentScope() {
    return this.scopeStack.length ? this.scopeStack[this.scopeStack.length - 1] : null;
  }

  qualifiedFor(name) {
    const parent = this.currentType();
    return parent ? parent.qualified + '.' + name : name;
  }

  pushType(tf) {
    this.fileFacts.types.push(tf);
    this.typeStack.push(tf);
  }

  popType() {
    this.typeStack.pop();
  }

  getOrCreateSynthetic(typeFacts, name, ctx) {
    let byName = this.syntheticByType.get(typeFacts);
    if (!byName) {
      byName = new Map();
      this.syntheticByType.set(typeFacts, byName);
    }
    let mf = byName.get(name);
    if (!mf) {
      mf = {
        name,
        isCtor: false,
        isStatic: false,
        returnType: null,
        line: ctx.start.line,
        endLine: ctx.stop.line,
        annotations: [],
        modifiers: [],
        params: [],
        locals: [],
        calls: [],
        dml: [],
        throwsSites: [],
        catches: [],
        narrowings: [],
      };
      byName.set(name, mf);
      typeFacts.methods.push(mf);
    } else {
      if (ctx.stop.line > mf.endLine) mf.endLine = ctx.stop.line;
      if (ctx.start.line < mf.line) mf.line = ctx.start.line;
    }
    return mf;
  }

  addCall(kind, receiver, method, argTexts, ctx) {
    const scope = this.currentScope();
    if (!scope) return; // defensive: every real call site sits inside some scope
    const line = ctx.start.line;
    scope.calls.push({
      kind,
      receiver,
      method,
      argTexts,
      lineText: lineTextAt(this.lines, line),
      line,
      col: ctx.start.column,
    });
  }

  addLocal(name, type, ctx) {
    const scope = this.currentScope();
    if (!scope) return;
    scope.locals.push({ name, type, line: ctx.start.line });
  }

  // F1: DML statement facts. ctx is the whole DML *StatementContext (its
  // .start is the leading keyword: `insert`/`update`/`delete`/`undelete`/
  // `upsert`/`merge`), matching addCall's line/col convention.
  addDml(op, targetText, ctx) {
    const scope = this.currentScope();
    if (!scope) return; // defensive: every real DML statement sits inside some scope
    const line = ctx.start.line;
    scope.dml.push({
      op,
      targetText,
      line,
      col: ctx.start.column,
      lineText: lineTextAt(this.lines, line),
    });
  }

  // G2: `throw` statement facts. ctx is the whole ThrowStatementContext
  // (.start is the THROW token), matching addCall/addDml's line/col
  // convention. typeName is set for the `throw new X(...)` creator-type
  // shape; varName is set (typeName left null) for the bare-identifier
  // `throw e;` rethrow shape, for resolver.js to resolve later against the
  // enclosing method's catches/locals/params.
  addThrow(typeName, varName, ctx) {
    const scope = this.currentScope();
    if (!scope) return; // defensive: every real throw statement sits inside some scope
    const line = ctx.start.line;
    scope.throwsSites.push({
      typeName,
      varName,
      line,
      col: ctx.start.column,
      lineText: lineTextAt(this.lines, line),
    });
  }

  // G2: catch-clause facts. ctx is the CatchClauseContext (.start is the
  // CATCH token) -- reuses the same ctx already passed to addLocal() by
  // enterCatchClause, so line numbers match exactly.
  addCatchFact(typeName, varName, ctx) {
    const scope = this.currentScope();
    if (!scope) return;
    scope.catches.push({ typeName, varName, line: ctx.start.line });
  }

  // A1: property accessor call sites (kind 'prop'). ctx is the
  // DotExpressionContext for the whole `receiver.Prop` access (its .start
  // is the start of the receiver, matching the convention already used by
  // addCall for kind 'dot'/'new').
  addPropCall(accessor, receiver, method, argTexts, ctx) {
    const scope = this.currentScope();
    if (!scope) return;
    const line = ctx.start.line;
    scope.calls.push({
      kind: 'prop',
      accessor,
      receiver,
      method,
      argTexts,
      lineText: lineTextAt(this.lines, line),
      line,
      col: ctx.start.column,
    });
  }

  // ---- types --------------------------------------------------------

  enterClassDeclaration(ctx) {
    const name = ctx.id().getText();
    const { annotations } = splitModifiers(findModifierList(ctx));
    const tf = {
      name,
      qualified: this.qualifiedFor(name),
      isInterface: false,
      isEnum: false,
      extendsType: ctx.EXTENDS && ctx.EXTENDS() && ctx.typeRef() ? ctx.typeRef().getText() : null,
      implementsTypes:
        ctx.IMPLEMENTS && ctx.IMPLEMENTS() && ctx.typeList()
          ? ctx.typeList().typeRef_list().map((t) => t.getText())
          : [],
      annotations,
      fields: [],
      properties: [],
      methods: [],
    };
    this.pushType(tf);
  }

  exitClassDeclaration() {
    this.popType();
  }

  enterInterfaceDeclaration(ctx) {
    const name = ctx.id().getText();
    const { annotations } = splitModifiers(findModifierList(ctx));
    let extendsType = null;
    let extendsTypes = [];
    if (ctx.EXTENDS && ctx.EXTENDS() && ctx.typeList()) {
      const list = ctx.typeList().typeRef_list();
      // Apex interfaces may extend multiple parents. extendsType keeps the
      // frozen single-string shape (first entry — existing consumers/tests
      // rely on this). G6: extendsTypes additively carries the FULL raw
      // list so resolver.js can fan out interface-extends-interface diamond
      // closures instead of silently dropping every parent after the first.
      if (list.length) {
        extendsTypes = list.map((t) => t.getText());
        extendsType = extendsTypes[0];
      }
    }
    const tf = {
      name,
      qualified: this.qualifiedFor(name),
      isInterface: true,
      isEnum: false,
      extendsType,
      extendsTypes,
      implementsTypes: [],
      annotations,
      fields: [],
      properties: [],
      methods: [],
    };
    this.pushType(tf);
  }

  exitInterfaceDeclaration() {
    this.popType();
  }

  enterEnumDeclaration(ctx) {
    const name = ctx.id().getText();
    const { annotations } = splitModifiers(findModifierList(ctx));
    const tf = {
      name,
      qualified: this.qualifiedFor(name),
      isInterface: false,
      isEnum: true,
      extendsType: null,
      implementsTypes: [],
      annotations,
      fields: [],
      properties: [],
      methods: [],
    };
    this.pushType(tf);
  }

  exitEnumDeclaration() {
    this.popType();
  }

  // ---- trigger --------------------------------------------------------

  enterTriggerUnit(ctx) {
    const ids = ctx.id_list();
    const name = ids[0] ? ids[0].getText() : this.fileFacts.name;
    const object = ids[1] ? ids[1].getText() : null;
    const events = (ctx.triggerCase_list() || []).map(triggerCaseText).filter(Boolean);
    this.fileFacts.triggerInfo = { object, events };
    const tf = {
      name,
      qualified: name,
      isInterface: false,
      isEnum: false,
      extendsType: null,
      implementsTypes: [],
      annotations: [],
      fields: [],
      properties: [],
      methods: [],
    };
    this.pushType(tf);
    const scope = this.getOrCreateSynthetic(tf, '(trigger)', ctx);
    this.pushScope(ctx, scope);
  }

  exitTriggerUnit(ctx) {
    this.popScopeIfPushed(ctx);
    this.popType();
  }

  // ---- anonymous Apex (G4) -----------------------------------------------

  // parser.anonymousUnit() (see parseFile) has no top-level type wrapper at
  // all -- a single synthetic pseudo-type named from the file stem (already
  // computed as fileFacts.name by baseName()) stands in for it, with one
  // synthetic '(anonymous)' method scope so every top-level statement in the
  // script attributes to it exactly like an ordinary method body. Per the G4
  // spec this method directly carries entries: ['Anonymous Apex script'] --
  // see the AMENDMENT G4 header note for why that lives here instead of
  // being derived by resolver.js the way other entry labels are.
  enterAnonymousUnit(ctx) {
    const name = this.fileFacts.name;
    const tf = {
      name,
      qualified: name,
      isInterface: false,
      isEnum: false,
      extendsType: null,
      implementsTypes: [],
      annotations: [],
      fields: [],
      properties: [],
      methods: [],
    };
    this.pushType(tf);
    const mf = {
      name: '(anonymous)',
      isCtor: false,
      isStatic: false,
      returnType: null,
      line: ctx.start.line,
      endLine: ctx.stop.line,
      annotations: [],
      modifiers: [],
      params: [],
      locals: [],
      calls: [],
      dml: [],
      throwsSites: [],
      catches: [],
      narrowings: [],
      entries: ['Anonymous Apex script'],
    };
    tf.methods.push(mf);
    this.pushScope(ctx, mf);
  }

  exitAnonymousUnit(ctx) {
    this.popScopeIfPushed(ctx);
    this.popType();
  }

  // ---- methods / constructors ------------------------------------------

  enterMethodDeclaration(ctx) {
    const type = this.currentType();
    if (!type) return;
    const { annotations, modifiers } = splitModifiers(findModifierList(ctx));
    const mf = {
      name: ctx.id().getText(),
      isCtor: false,
      isStatic: modifiers.includes('static'),
      returnType: ctx.VOID && ctx.VOID() ? 'void' : ctx.typeRef() ? ctx.typeRef().getText() : null,
      line: ctx.start.line,
      endLine: ctx.stop.line,
      annotations,
      modifiers,
      params: extractParams(ctx.formalParameters()),
      locals: [],
      calls: [],
      dml: [],
      throwsSites: [],
      catches: [],
      narrowings: [],
    };
    type.methods.push(mf);
    this.pushScope(ctx, mf);
  }

  exitMethodDeclaration(ctx) {
    this.popScopeIfPushed(ctx);
  }

  enterConstructorDeclaration(ctx) {
    const type = this.currentType();
    if (!type) return;
    const { annotations, modifiers } = splitModifiers(findModifierList(ctx));
    const mf = {
      name: ctx.qualifiedName().getText(),
      isCtor: true,
      isStatic: false,
      returnType: null,
      line: ctx.start.line,
      endLine: ctx.stop.line,
      annotations,
      modifiers,
      params: extractParams(ctx.formalParameters()),
      locals: [],
      calls: [],
      dml: [],
      throwsSites: [],
      catches: [],
      narrowings: [],
    };
    type.methods.push(mf);
    this.pushScope(ctx, mf);
  }

  exitConstructorDeclaration(ctx) {
    this.popScopeIfPushed(ctx);
  }

  // Interface methods never have a body (grammar enforces `;` only) — no
  // scope push needed since no calls/locals can ever occur inside one.
  enterInterfaceMethodDeclaration(ctx) {
    const type = this.currentType();
    if (!type) return;
    const { annotations, modifiers } = splitModifiers(findModifierList(ctx));
    const mf = {
      name: ctx.id().getText(),
      isCtor: false,
      isStatic: modifiers.includes('static'),
      returnType: ctx.VOID && ctx.VOID() ? 'void' : ctx.typeRef() ? ctx.typeRef().getText() : null,
      line: ctx.start.line,
      endLine: ctx.stop.line,
      annotations,
      modifiers,
      params: extractParams(ctx.formalParameters()),
      locals: [],
      calls: [],
      dml: [],
      throwsSites: [],
      catches: [],
      narrowings: [],
    };
    type.methods.push(mf);
  }

  // ---- fields / properties ----------------------------------------------

  enterFieldDeclaration(ctx) {
    const type = this.currentType();
    if (!type) return;
    const { modifiers } = splitModifiers(findModifierList(ctx));
    const isStatic = modifiers.includes('static');
    const fieldType = ctx.typeRef().getText();
    for (const vd of ctx.variableDeclarators().variableDeclarator_list()) {
      type.fields.push({ name: vd.id().getText(), type: fieldType, isStatic });
    }
    // Field initializer expressions (if any) are walked as children of this
    // node; route any calls found there to the type's synthetic '(init)'.
    const scope = this.getOrCreateSynthetic(type, '(init)', ctx);
    this.pushScope(ctx, scope);
  }

  exitFieldDeclaration(ctx) {
    this.popScopeIfPushed(ctx);
  }

  enterPropertyDeclaration(ctx) {
    const type = this.currentType();
    if (!type) return;
    type.properties.push({ name: ctx.id().getText(), type: ctx.typeRef().getText() });
  }

  enterPropertyBlock(ctx) {
    // No scope of its own -- enterGetter/enterSetter (fired for each child
    // accessor) do the per-accessor registration/scoping below. This hook
    // just needs to exist so ANTLR's listener dispatch descends normally.
  }

  exitPropertyBlock(ctx) {}

  // Fires once per declared getter, whether or not it has a body block --
  // that is what makes auto-implemented accessors (`{ get; set; }`) get a
  // real '(get NAME)' MethodFacts entry (see A2 note above).
  enterGetter(ctx) {
    const type = this.currentType();
    if (!type) return;
    const propBlock = ctx.parentCtx;
    const propName = propBlock && propBlock.parentCtx && propBlock.parentCtx.id
      ? propBlock.parentCtx.id().getText()
      : '?';
    const scope = this.getOrCreateSynthetic(type, `(get ${propName})`, ctx);
    if (ctx.block()) this.pushScope(ctx, scope);
  }

  exitGetter(ctx) {
    this.popScopeIfPushed(ctx);
  }

  enterSetter(ctx) {
    const type = this.currentType();
    if (!type) return;
    const propBlock = ctx.parentCtx;
    const propName = propBlock && propBlock.parentCtx && propBlock.parentCtx.id
      ? propBlock.parentCtx.id().getText()
      : '?';
    const scope = this.getOrCreateSynthetic(type, `(set ${propName})`, ctx);
    if (ctx.block()) this.pushScope(ctx, scope);
  }

  exitSetter(ctx) {
    this.popScopeIfPushed(ctx);
  }

  // Bare `{ ... }` (static or instance initializer block) inside a class
  // body: ClassBodyDeclarationContext with a block() but no memberDeclaration().
  enterClassBodyDeclaration(ctx) {
    const type = this.currentType();
    if (!type) return;
    if (!ctx.memberDeclaration() && ctx.block()) {
      this.pushScope(ctx, this.getOrCreateSynthetic(type, '(init)', ctx));
    }
  }

  exitClassBodyDeclaration(ctx) {
    this.popScopeIfPushed(ctx);
  }

  // ---- locals: regular decls, enhanced-for loop vars, catch vars --------
  // (enhanced-for and catch variables are NOT delivered via
  // enterLocalVariableDeclaration — verified live against 5.1.0 — so both
  // need their own explicit hook or they silently vanish from the type env.)

  enterLocalVariableDeclaration(ctx) {
    const type = ctx.typeRef().getText();
    for (const vd of ctx.variableDeclarators().variableDeclarator_list()) {
      this.addLocal(vd.id().getText(), type, vd);
    }
  }

  enterEnhancedForControl(ctx) {
    this.addLocal(ctx.id().getText(), ctx.typeRef().getText(), ctx);
  }

  enterCatchClause(ctx) {
    if (!ctx.qualifiedName() || !ctx.id()) return;
    const typeName = ctx.qualifiedName().getText();
    const varName = ctx.id().getText();
    this.addLocal(varName, typeName, ctx);
    // G2: also index as a catches[] fact (distinct from locals[] -- callers
    // resolving `throw e;`/badge-matching want typed catch clauses only,
    // not the full local-variable env).
    this.addCatchFact(typeName, varName, ctx);
  }

  // G2: `throw new AcmeX(...)` (creator-type shape, generics stripped same
  // as enterNewExpression) or `throw e;` (bare-identifier rethrow shape --
  // typeName left null, varName captured for resolver.js to resolve via the
  // enclosing method's catches/locals/params). Any other throw-expression
  // shape records neither (see AMENDMENT G2 header note).
  enterThrowStatement(ctx) {
    const expr = ctx.expression();
    let typeName = null;
    let varName = null;
    if (expr instanceof NewExpressionContext) {
      const creator = expr.creator();
      if (creator && creator.createdName()) {
        typeName = creator.createdName().getText().split('<')[0];
      }
    } else {
      varName = simpleIdentifierName(expr);
    }
    this.addThrow(typeName, varName, ctx);
  }

  // G3: `x instanceof T` narrowing -- only the simple-identifier-receiver
  // shape is recorded (see AMENDMENT G3 header note); a non-identifier
  // receiver contributes no narrowings[] entry.
  enterInstanceOfExpression(ctx) {
    const scope = this.currentScope();
    if (!scope) return;
    const varName = simpleIdentifierName(ctx.expression());
    if (!varName) return;
    scope.narrowings.push({
      varName,
      typeName: ctx.typeRef().getText(),
      line: ctx.start.line,
    });
  }

  // ---- calls --------------------------------------------------------

  enterDotExpression(ctx) {
    const dm = ctx.dotMethodCall();
    if (dm) {
      if (!dm.anyId()) return;
      const receiverCtx = ctx.expression();
      const receiver = sliceSource(this.text, this.cpMap, receiverCtx);
      const method = dm.anyId().getText();
      const argTexts = extractCallArgs(this.text, this.cpMap, dm.expressionList());
      this.addCall('dot', receiver, method, argTexts, ctx);
      return;
    }
    // A1: no dotMethodCall means the grammar took the anyId()-only
    // alternative -- a bare `receiver.Prop` reference, not `receiver.Prop(`.
    // Skip if enterAssignExpression already claimed this exact node as a
    // write target (it emits the 'set' itself); otherwise this is a read.
    const anyId = ctx.anyId();
    if (!anyId) return;
    if (this.propWriteTargets.has(ctx)) return;
    const receiverCtx = ctx.expression();
    const receiver = sliceSource(this.text, this.cpMap, receiverCtx);
    const method = anyId.getText();
    this.addPropCall('get', receiver, method, [], ctx);
  }

  // A1: `receiver.Prop = value` / `receiver.Prop += value` / any compound
  // assignment operator -- all share one grammar production
  // (AssignExpressionContext: expression (ASSIGN|..._ASSIGN) expression),
  // so a single handler covers plain and compound assignment alike, per the
  // amendment's "compound += etc. as 'set'" instruction. Only fires a 'prop'
  // set when the LHS is itself a bare dotted property reference (not e.g. a
  // plain identifier or a `receiver.Prop(...)` call result, which can't be
  // an assignment target anyway). Runs before the walker descends into the
  // LHS child node, so marking it in propWriteTargets here reliably
  // precedes -- and suppresses -- the 'get' that enterDotExpression would
  // otherwise emit for that same node.
  enterAssignExpression(ctx) {
    const lhs = ctx.expression(0);
    if (!(lhs instanceof DotExpressionContext)) return;
    if (lhs.dotMethodCall()) return; // defensive: not a valid assignment target anyway
    const anyId = lhs.anyId();
    if (!anyId) return;
    this.propWriteTargets.add(lhs);
    const receiverCtx = lhs.expression();
    const receiver = sliceSource(this.text, this.cpMap, receiverCtx);
    const method = anyId.getText();
    const rhs = ctx.expression(1);
    const assignedValueText = rhs ? sliceSource(this.text, this.cpMap, rhs) : '';
    this.addPropCall('set', receiver, method, [assignedValueText], lhs);
  }

  enterMethodCall(ctx) {
    let method;
    if (ctx.THIS && ctx.THIS()) method = 'this';
    else if (ctx.SUPER && ctx.SUPER()) method = 'super';
    else if (ctx.id()) method = ctx.id().getText();
    else return;
    const argTexts = extractCallArgs(this.text, this.cpMap, ctx.expressionList());
    this.addCall('bare', null, method, argTexts, ctx);
  }

  enterNewExpression(ctx) {
    const creator = ctx.creator();
    if (!creator || !creator.createdName()) return;
    const headText = creator.createdName().getText().split('<')[0];
    let argTexts = [];
    const rest = creator.classCreatorRest ? creator.classCreatorRest() : null;
    if (rest && rest.arguments && rest.arguments()) {
      argTexts = extractCallArgs(this.text, this.cpMap, rest.arguments().expressionList());
    }
    this.addCall('new', null, headText, argTexts, ctx);
  }

  // ---- DML statements (F1) ------------------------------------------

  enterInsertStatement(ctx) {
    if (!ctx.expression()) return;
    this.addDml('insert', sliceSource(this.text, this.cpMap, ctx.expression()), ctx);
  }

  enterUpdateStatement(ctx) {
    if (!ctx.expression()) return;
    this.addDml('update', sliceSource(this.text, this.cpMap, ctx.expression()), ctx);
  }

  enterDeleteStatement(ctx) {
    if (!ctx.expression()) return;
    this.addDml('delete', sliceSource(this.text, this.cpMap, ctx.expression()), ctx);
  }

  enterUndeleteStatement(ctx) {
    if (!ctx.expression()) return;
    this.addDml('undelete', sliceSource(this.text, this.cpMap, ctx.expression()), ctx);
  }

  enterUpsertStatement(ctx) {
    if (!ctx.expression()) return;
    this.addDml('upsert', sliceSource(this.text, this.cpMap, ctx.expression()), ctx);
  }

  // MergeStatementContext exposes expression_list() (master record first,
  // record(s)-to-merge second), not a single expression() -- verified live,
  // see the AMENDMENT F1 header note.
  enterMergeStatement(ctx) {
    const exprs = ctx.expression_list();
    if (!exprs || !exprs.length) return;
    this.addDml('merge', sliceSource(this.text, this.cpMap, exprs[0]), ctx);
  }
}

// --- entry point ------------------------------------------------------

function parseFile({ path, text }) {
  // G4: '.apex' (anonymous-script) files get their own kind + grammar entry
  // rule, checked before the trigger/class split.
  const kind = /\.apex$/i.test(path || '') ? 'anonymous' : /\.trigger$/i.test(path || '') ? 'trigger' : 'class';
  const name = baseName(path);
  const fileFacts = { path, kind, name, parseError: null, triggerInfo: null, types: [] };
  const source = text || '';

  try {
    const lines = source.split('\n');

    const errors = [];
    class CollectingErrorListener extends ApexErrorListener {
      apexSyntaxError(line, column, msg) {
        errors.push({ line, column, msg });
      }
    }

    let tree = null;
    try {
      const { parser } = ApexParserFactory.createLexerAndParser(source, new CollectingErrorListener());
      tree =
        kind === 'trigger'
          ? parser.triggerUnit()
          : kind === 'anonymous'
            ? parser.anonymousUnit()
            : parser.compilationUnit();
    } catch (e) {
      fileFacts.parseError = 'parse failed: ' + (e && e.message ? e.message : String(e));
      tree = null;
    }

    if (errors.length) {
      const first = errors[0];
      fileFacts.parseError = `Line ${first.line}:${first.column}: ${first.msg}`;
    }

    if (tree) {
      try {
        const cpMap = buildCpToUtf16Map(source);
        const listener = new FactsListener(source, lines, fileFacts, cpMap);
        ApexParseTreeWalker.DEFAULT.walk(listener, tree);
      } catch (e) {
        if (!fileFacts.parseError) {
          fileFacts.parseError = 'walk failed: ' + (e && e.message ? e.message : String(e));
        }
      }
    }
  } catch (e) {
    // absolute last resort — parseFile must never throw
    fileFacts.parseError = fileFacts.parseError || 'unexpected: ' + (e && e.message ? e.message : String(e));
  }

  // CONTRACT MISMATCH FIX (integrator): the frozen FileFacts shape has no
  // `text` field, but resolver.js's PARSE-ERROR FALLBACK rule requires the
  // raw source of a file whose parseError is set (to lexically scan it for
  // class-name mentions) and has no other way to obtain it (pure data-in/
  // data-out, no fs access). Without this, that fallback rule would be
  // permanently unreachable for any real parseFile() output. Scoped tightly
  // to the documented use case: only attached when parseError is set, so
  // non-error FileFacts objects match the frozen shape exactly.
  if (fileFacts.parseError) fileFacts.text = source;

  return fileFacts;
}

module.exports = { parseFile, baseName };

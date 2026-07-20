// GAUNTLET (v0.11 Round B / B1): literal-flow Type.forName resolution --
// one method per CONTRACT sub-shape (a)/(a-neg)/(b)/(b-neg)/(c)/(d)/(e).
// Every method follows the SAME `Type.forName(...) -> newInstance()` shape
// as the pre-existing KappaGenericTriggerDispatcher.dispatch fixture; per
// handleTypeForName's own header note the edge (when one fires) is written
// directly off the forName call itself -- newInstance() is realistic
// surrounding code, not load-bearing for resolution.
public class VtxDynamicFactory {

    // (b) own-class static final String constant, single-literal
    // initializer -- qualifies for TypeFacts.constants, referenced BARE
    // (no class qualifier) within this same class.
    private static final String ESCALATION_HANDLER = 'VtxEscalationHandler';

    // (a) MUST resolve: single-assignment literal local, never reassigned
    // anywhere else in this method.
    public Object createFromLiteralLocal() {
        String handlerName = 'VtxRouterHandler';
        Type handlerType = Type.forName(handlerName);
        if (handlerType == null) {
            return null;
        }
        return handlerType.newInstance();
    }

    // (a-neg) MUST NOT resolve: same single-literal-initializer shape as
    // above, but reassigned later in the method (inside a conditional --
    // the parser's no-reassignment proof is purely syntactic/conservative,
    // not reachability-sensitive, so this clears `literal` regardless of
    // whether the branch is ever actually taken at runtime).
    public Object createFromReassignedLocal(Boolean useAlternate) {
        String handlerName = 'VtxRouterHandler';
        if (useAlternate) {
            handlerName = 'VtxLegacyHandler';
        }
        Type handlerType = Type.forName(handlerName);
        if (handlerType == null) {
            return null;
        }
        return handlerType.newInstance();
    }

    // (b) MUST resolve: own-class static final String constant, bare
    // reference.
    public Object createFromOwnConstant() {
        Type handlerType = Type.forName(ESCALATION_HANDLER);
        if (handlerType == null) {
            return null;
        }
        return handlerType.newInstance();
    }

    // (b) MUST resolve: cross-class static final String constant,
    // qualified reference (VtxHandlerNames.ROUTER).
    public Object createFromCrossClassConstant() {
        Type handlerType = Type.forName(VtxHandlerNames.ROUTER);
        if (handlerType == null) {
            return null;
        }
        return handlerType.newInstance();
    }

    // (b-neg, variant 1) MUST NOT resolve: cross-class field is NOT final
    // (VtxHandlerNames.LEGACY_HANDLER_NAME) -- absent from
    // TypeFacts.constants entirely.
    public Object createFromNonFinalCrossClassField() {
        Type handlerType = Type.forName(VtxHandlerNames.LEGACY_HANDLER_NAME);
        if (handlerType == null) {
            return null;
        }
        return handlerType.newInstance();
    }

    // (b-neg, variant 2) MUST NOT resolve: cross-class field IS final but
    // its initializer is a method call, not a literal
    // (VtxHandlerNames.COMPUTED_HANDLER_NAME) -- also absent from
    // TypeFacts.constants entirely.
    public Object createFromComputedCrossClassField() {
        Type handlerType = Type.forName(VtxHandlerNames.COMPUTED_HANDLER_NAME);
        if (handlerType == null) {
            return null;
        }
        return handlerType.newInstance();
    }

    // (c) MUST edge BOTH candidates: ternary of two string literals.
    public Object createFromTernary(Boolean useAlternate) {
        Type handlerType = Type.forName(useAlternate ? 'VtxLegacyHandler' : 'VtxRouterHandler');
        if (handlerType == null) {
            return null;
        }
        return handlerType.newInstance();
    }

    // (d) MUST edge the external node: literal naming a namespaced
    // external ('zenq.Billing' -- the SAME fictional managed class the
    // pre-existing VertexLedgerBridge.cls/KappaGatewayCaller.cls namespace
    // probes already reference; the workspace's own namespace is 'vtx' per
    // sfdx-project.json, so 'zenq' is definitively foreign).
    public Object createFromNamespacedLiteral() {
        Type handlerType = Type.forName('zenq.Billing');
        if (handlerType == null) {
            return null;
        }
        return handlerType.newInstance();
    }

    // (e) MUST NOT resolve: param-fed Type.forName -- the SAME shape as
    // the pre-existing KappaGenericTriggerDispatcher.dispatch fixture
    // (there, a queried record's field access; here, a plain method
    // parameter), both unknowable statically.
    public Object createFromParam(String handlerName) {
        Type handlerType = Type.forName(handlerName);
        if (handlerType == null) {
            return null;
        }
        return handlerType.newInstance();
    }
}

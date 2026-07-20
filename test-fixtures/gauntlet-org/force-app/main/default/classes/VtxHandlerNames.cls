// GAUNTLET (v0.11 Round B / B1): cross-class constant container for
// literal-flow Type.forName resolution. ROUTER is the one qualifying
// constant (static final String, single-literal initializer) -- both
// b-neg variants below are constructed so the parser's own additive
// TypeFacts.constants[] contract (per the B1 CONTRACT: "static final
// String fields with single-literal initializers") must NOT include them
// at all, which is the actual mechanism that makes VtxDynamicFactory.cls's
// two b-neg call sites unresolvable, not any resolver-side special-casing.
public class VtxHandlerNames {

    // (b) qualifying: static final String, single string-literal initializer.
    public static final String ROUTER = 'VtxRouterHandler';

    // (b-neg, variant 1): literal initializer, but NOT final -- mutable, so
    // must be excluded from TypeFacts.constants entirely.
    public static String LEGACY_HANDLER_NAME = 'VtxLegacyHandler';

    // (b-neg, variant 2): final, but the initializer is NOT a single string
    // literal (a method call) -- must also be excluded from
    // TypeFacts.constants entirely.
    public static final String COMPUTED_HANDLER_NAME = deriveComputedName();

    private static String deriveComputedName() {
        return 'VtxComputedHandler';
    }
}

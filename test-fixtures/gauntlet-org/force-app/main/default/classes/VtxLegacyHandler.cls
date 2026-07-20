// GAUNTLET (v0.11 Round B / B1): second dynamic-dispatch target -- reached
// via the (c) ternary literal-flow case's alternate branch in
// VtxDynamicFactory.cls (createFromTernary). Every OTHER reference to this
// class name among this file's sibling fixtures is a deliberate NEGATIVE
// case that must NOT resolve here (the reassigned local in
// createFromReassignedLocal, the non-final cross-class field in
// VtxHandlerNames.LEGACY_HANDLER_NAME).
public class VtxLegacyHandler {
    public void handle() {
        System.debug('legacy handler');
    }
}

// GAUNTLET (v0.11 Round B / B1): trivial dynamic-dispatch target -- the
// literal-flow POSITIVE-resolution cases in VtxDynamicFactory.cls
// construct this class via Type.forName + newInstance(). Also one of the
// two candidates in the (c) ternary-of-two-literals case.
public class VtxRouterHandler {
    public void handle() {
        System.debug('router handler');
    }
}

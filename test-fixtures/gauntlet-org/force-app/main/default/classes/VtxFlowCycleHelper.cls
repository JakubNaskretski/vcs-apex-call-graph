// v0.13 (S-corpus): apex anchors for the mutual subflow cycle
// Vtx_FlowCycleA <-> Vtx_FlowCycleB (A's <subflows> names B, B's <subflows>
// names A). Tracing either method's callers must terminate with a
// cyclic:true node on the SECOND re-occurrence of the flow it started
// from, never hang.
public class VtxFlowCycleHelper {

  public static void pingA(Id recordId) {
    System.debug('ping A: ' + recordId);
  }

  public static void pingB(Id recordId) {
    System.debug('ping B: ' + recordId);
  }
}

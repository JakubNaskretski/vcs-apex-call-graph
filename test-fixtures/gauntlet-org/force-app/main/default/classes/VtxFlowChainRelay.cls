// v0.13 (S-corpus): the two traceable anchors of the 3-deep flow chain
// (Vtx_FlowChainTop -> Vtx_FlowChainMid -> Vtx_FlowChainLeaf). Top is
// deliberately apex-less (a pure subflow-orchestrator flow with zero
// <actionCalls>) to exercise the case where a flow's OUTGOING <subflows>
// reference must still be captured even though the flow itself never
// produces an apex-actionCalls MetaRef of its own.
public class VtxFlowChainRelay {

  public static void relayMid(Id recordId) {
    System.debug('relay mid: ' + recordId);
  }

  public static void relayLeaf(Id recordId) {
    System.debug('relay leaf: ' + recordId);
  }
}

public class VertexBindTarget {
  // H1 MAGNET TARGET: the ONLY local declarer of `bind` workspace-wide.
  // Confirmed callers (exactly 2): VertexBindTargetTest.cls (typed static
  // call) and the vertexBindPanel LWC's @salesforce/apex import. Everything
  // else that ever calls something named `.bind(...)` in this corpus does so
  // on an unresolvable receiver -- see the ~40 framework-style call sites
  // spread across the Vertex*Engine/Runner/Host/Broker/Manager/Chain/
  // Registry/Router classes below this one in the classes/ directory.
  public static VertexOpInfo bind(VertexBindInfo info) {
    VertexOpInfo result = new VertexOpInfo();
    result.opId = info.requestId;
    result.success = true;
    return result;
  }
}

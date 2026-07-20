public class BoltSettleCaller {
  public void settleDynamic(String key, Vertex_Order__c order) {
    locateSettler(key).settle(order);
    // NAMESPACE/UNIQUE-NAME PROBE (N=15): "settle" is declared identically by
    // 15 unrelated classes (BoltSettle01Alpha .. BoltSettle15Oscar). The
    // receiver's declared type (Object, from locateSettler()) can't be
    // followed, so rule 6 fails; the unique-name fallback (rule 7) requires
    // EXACTLY ONE declaring class and must refuse with 15 candidates -- zero
    // edges into ANY of the 15, call site counted unresolved. [IDEAL --
    // confirms the unique-name candidate-count guard scales correctly past
    // the N=12 case already in this corpus; a false edge to any ONE of the
    // 15 here would be a BUG, and a materially different perf/behavior
    // cliff at N=15 vs N=12 would also be worth flagging.]
  }
  private Object locateSettler(String key) {
    return null;
  }
}

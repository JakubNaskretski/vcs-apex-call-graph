public class VertexOrderMigrationUtil {
  public void legacyRepriceDispatch(String serviceKey, Vertex_Order__c order) {
    locateService(serviceKey).reprice(order);
    // NON-EDGE: 2 classes declare `reprice` (VertexPricingService, VertexShippingCostService).
    // The receiver's type comes from a same-file method call whose return type (Object) the
    // resolver does not/cannot follow into either candidate, so typed resolution fails; the
    // unique-name fallback requires EXACTLY ONE declaring class and must refuse with 2 -- no
    // edge to either class, call site counted unresolved. [IDEAL -- confirms the unique-name
    // candidate-count guard at N=2; risk if violated: a false edge to whichever of the 2 the
    // engine happens to pick first would be a BUG, not a gap.]
  }
  private Object locateService(String key) {
    return null;
  }
}

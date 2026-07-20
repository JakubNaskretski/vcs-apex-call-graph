public class BoltPrimeCaller {
  public void primeDynamic(String key, Vertex_Order__c order) {
    locatePrimer(key).primeOnce(order);
    // UNIQUE-NAME PROBE (N=1 contrast): "primeOnce" is declared by exactly
    // ONE class workspace-wide (BoltPrimeTarget). Expected: unique-name
    // fallback (rule 7) fires and DOES resolve, via='unique-name', and the
    // resulting node/site is marked approximate=true. This is the engine's
    // OWN honest treatment of "single global candidate, low confidence" --
    // used here as the control case to contrast against the KappaGateway/
    // Relay/Billing findings, where an equally-single-candidate bare-name
    // match (inside resolveType's rule-5 class-name path, not rule 7) gets
    // NO approximate flag at all.
  }
  private Object locatePrimer(String key) {
    return null;
  }
}

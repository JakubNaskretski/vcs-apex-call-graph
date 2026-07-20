public class BoltRelayCaller {
  public void trigger() {
    zenq.Relay.fire();
    // NAMESPACE PROBE 5 (inner-class tail collision): the namespace-qualified
    // receiver's LAST segment "Relay" happens to uniquely match the INNER
    // class BoltContainer.Relay (there is exactly one class anywhere in this
    // workspace with simple name "Relay"). Honest expected output: no edge
    // (namespaced reference, unrelated to the local nested type) -- an edge
    // to BoltContainer.Relay.fire here would be a false positive that also
    // proves the collision isn't limited to top-level classes.
  }
}

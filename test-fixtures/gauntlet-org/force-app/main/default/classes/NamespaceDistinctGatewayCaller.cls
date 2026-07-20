public class NamespaceDistinctGatewayCaller {
  public void openBoth() {
    zenq.Gateway.open();
    // NAMESPACE PROBE (requirement 2d, leg 1): 3-segment call into the
    // fictional `zenq` namespace's own Gateway class. "Gateway" is not a
    // local class anywhere in this corpus (only KappaGateway exists, a
    // distinct simple name) -- no local resolution risk either way.
    // Expected: EXTERNAL node 'zenq.Gateway', method 'open'.

    kwx.Gateway.open();
    // NAMESPACE PROBE (requirement 2d, leg 2): SAME class simple name
    // ("Gateway"), method ("open"), and call shape, but a DIFFERENT
    // namespace token ("kwx"). Expected: a SECOND, DISTINCT external node
    // 'kwx.Gateway' -- must NOT collapse/merge with 'zenq.Gateway' above
    // just because the class name and method match; the (namespace, class)
    // pair is the external-node identity, not the class name alone.
  }
}

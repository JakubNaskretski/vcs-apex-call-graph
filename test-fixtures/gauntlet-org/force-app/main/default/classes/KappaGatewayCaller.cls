public class KappaGatewayCaller {
  public void routeCommands(String cmd) {
    zenq.KappaGateway.dispatch(cmd);
    // NAMESPACE PROBE 1: namespace-qualified call to the fictional managed
    // package `zenq`'s own KappaGateway class -- unrelated to the LOCAL
    // KappaGateway declared above. Honest expected output: no edge to the
    // local class (namespaced/managed references are documented as
    // not-yet-modeled) -- a resolved edge here would be a false positive.

    ZENQ.kappagateway.DISPATCH(cmd);
    // NAMESPACE PROBE 2: case-insensitive variant of the same reference
    // (Apex identifiers are case-insensitive) -- same expectation as above.

    kwx.KappaGateway.dispatch(cmd);
    // NAMESPACE PROBE 3: a DIFFERENT fictional namespace token (`kwx`,
    // dotted form -- distinct from the `kwx__` custom-object/field prefix
    // convention used elsewhere in this corpus), same collision shape --
    // confirms the risk is general to any namespace prefix, not specific
    // to `zenq`.

    zenq.KappaGatewey.dispatch(cmd);
    // NAMESPACE PROBE 4 (near-miss / negative control): "Gatewey" is a
    // one-letter typo of the local "Gateway" -- must NOT match anything,
    // namespaced or local. Confirms the fallback isn't fuzzy-matching.
  }
}

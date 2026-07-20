public class VertexLedgerBridge {
  public void postToLedger(Vertex_Order__c order) {
    Billing.charge(order.TotalAmount__c);
    // -> Billing.charge (local) [via=static] [MUST]

    kwx__LedgerService.postEntry(order.Id, order.TotalAmount__c);
    // NON-EDGE: kwx__LedgerService is never declared anywhere in this corpus (fictional
    // managed class). Zero possible local edge. Should still be extracted as a well-formed
    // dot-call CallFacts entry and counted toward the workspace-wide unresolved tally — if it
    // is silently dropped instead (e.g. the `kwx__` token confuses the parser), that under-
    // counts and should be flagged. [IDEAL]

    insert new kwx__Ledger__c(Order__c = order.Id, Amount__c = order.TotalAmount__c);
    // NON-EDGE (trigger fan-out): DML on fictional managed custom object kwx__Ledger__c; no
    // trigger on that object exists anywhere in this corpus, so the dml->trigger fan-out
    // correctly finds zero targets. This is CORRECT behavior, not a gap — no special
    // namespaced-object handling is needed for this line to behave. [MUST-equivalent]

    zenq.Billing.charge(order.TotalAmount__c);
    // PRECISION-TRAP NON-EDGE: namespace-qualified reference to fictional managed
    // `zenq.Billing.charge`. Must NOT collapse onto the LOCAL `Billing.charge` (line 3) just
    // because the bare method/class name matches once the `zenq.` prefix is stripped.
    // [IDEAL — namespaced/managed references are not modeled, so honest expected output is
    // "no edge, counted unresolved". BUG-vs-GAP: if a live run shows an edge from this line to
    // the LOCAL Billing.charge, that is a BUG (false-positive namespace-prefix collapse onto
    // an unrelated local class). If it shows unresolved/absent, that is correct and consistent
    // with the documented "namespaced/managed references not yet modeled" limit.]
  }
}

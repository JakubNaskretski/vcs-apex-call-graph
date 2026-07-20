public class ZenqLocalPrecedenceCaller {
  public void callWithLocalMember(Decimal amount) {
    zenq.Ledger.post(amount);
    // PRECEDENCE PROBE (local wins): Head "zenq" resolves to the GENUINE
    // local top-level class zenq.cls, and Mid "Ledger" resolves on it (a
    // real inner class). Existing local-class-chain resolution rules apply
    // unchanged -> LOCAL edge to zenq.Ledger.post, NOT an external node.
  }

  public void callWithoutLocalMember(String cmd) {
    zenq.Signal.emit(cmd);
    // PRECEDENCE PROBE (external wins, no false local edge): Head "zenq"
    // again resolves to the genuine local class zenq.cls, but Mid "Signal"
    // does NOT resolve on it (zenq.cls declares no such inner class/static
    // member). Local-class-chain resolution must decline (no false local
    // edge fabricated just because Head matched a real class), falling
    // through to namespace-token precedence -> EXTERNAL node 'zenq.Signal',
    // method 'emit'.
  }
}

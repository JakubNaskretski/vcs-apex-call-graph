// v0.10-A: return-type CYCLE fixture. `next()` bounces the receiver's
// tracked type back and forth between VtxChainCycleNodeA and
// VtxChainCycleNodeB forever -- a chain built from this pair never
// terminates on its own, so the per-chain visited guard on
// (typeLower, methodLower) pairs is the ONLY thing that stops the walk. Also
// declares `terminal()` -- deliberately NOT globally unique (VtxChainCycleNodeB
// declares the identical name) so rule 7's unique-name fallback can never
// mask a dropped/cycled chain as a false edge.
public class VtxChainCycleNodeA {
  public VtxChainCycleNodeB next() {
    return new VtxChainCycleNodeB();
  }

  public String terminal() {
    return 'terminal-from-A';
  }
}

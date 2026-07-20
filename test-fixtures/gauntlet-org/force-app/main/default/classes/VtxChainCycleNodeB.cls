// v0.10-A: the other half of the return-type cycle -- `next()` bounces back
// to VtxChainCycleNodeA. See VtxChainCycleNodeA's header for the full trap
// description.
public class VtxChainCycleNodeB {
  public VtxChainCycleNodeA next() {
    return new VtxChainCycleNodeA();
  }

  public String terminal() {
    return 'terminal-from-B';
  }
}

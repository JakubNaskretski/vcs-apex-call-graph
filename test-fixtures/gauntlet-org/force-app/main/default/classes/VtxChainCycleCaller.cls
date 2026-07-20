// v0.10-A: return-type CYCLE chain, 6 `.next()` segments deep (well under
// CHAIN_MAX=12) before the traced `.terminal()` call. Must degrade to NO
// edge via the per-chain visited guard on (typeLower, methodLower) pairs --
// NOT merely "walk until CHAIN_MAX and then stop": the guard fires as soon
// as a (type, method) pair repeats (the 3rd hop re-visits
// (VtxChainCycleNodeA, next), already seen at the 1st hop), long before the
// segment count itself would ever be a problem. One physical line, same
// "no whitespace between segments" reason as VtxReportChainCaller.
public class VtxChainCycleCaller {
  public String runSixDeepCycle() {
    VtxChainCycleNodeA n = new VtxChainCycleNodeA();
    return n.next().next().next().next().next().next().terminal();
  }
}

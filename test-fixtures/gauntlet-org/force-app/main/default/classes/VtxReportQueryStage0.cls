// v0.10-A: entry point of the fictional report-query fluent builder web.
// A caller obtains one of these, then chains an arbitrary number of
// `.withXxx()`/`.whereXxx()` hops before finally calling `.build()` on
// whichever stage the chain lands on. Each hop is declared on a DISTINCT
// stage class (Stage0 -> Stage1 -> ... -> Stage13), so a chain of N hops
// walks N distinct return types before the final `.build()` call.
public class VtxReportQueryStage0 {
  public VtxReportQueryStage1 selectFields() {
    return new VtxReportQueryStage1();
  }
}

// v0.10-A: fluent report-query builder, stage 6 of 13. Reached after
// exactly 6 chained hop(s) from VtxReportQueryStage0. Declares the next
// hop (-> Stage7) plus a terminal `build()` (declared on every stage
// from Stage1 through Stage13 -- deliberately NOT globally unique, so rule
// 7's unique-name fallback can never mask a dropped chain as a false edge).
public class VtxReportQueryStage6 {
  public VtxReportQueryStage7 groupBy() {
    return new VtxReportQueryStage7();
  }

  public VtxReportQueryResult build() {
    return new VtxReportQueryResult('stage6');
  }
}

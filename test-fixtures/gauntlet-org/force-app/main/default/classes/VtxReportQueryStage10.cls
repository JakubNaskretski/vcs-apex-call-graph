// v0.10-A: fluent report-query builder, stage 10 of 13. Reached after
// exactly 10 chained hop(s) from VtxReportQueryStage0. Declares the next
// hop (-> Stage11) plus a terminal `build()` (declared on every stage
// from Stage1 through Stage13 -- deliberately NOT globally unique, so rule
// 7's unique-name fallback can never mask a dropped chain as a false edge).
public class VtxReportQueryStage10 {
  public VtxReportQueryStage11 joinRelated() {
    return new VtxReportQueryStage11();
  }

  public VtxReportQueryResult build() {
    return new VtxReportQueryResult('stage10');
  }
}

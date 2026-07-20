// v0.10-A: fluent report-query builder, stage 11 of 13. Reached after
// exactly 11 chained hop(s) from VtxReportQueryStage0. Declares the next
// hop (-> Stage12) plus a terminal `build()` (declared on every stage
// from Stage1 through Stage13 -- deliberately NOT globally unique, so rule
// 7's unique-name fallback can never mask a dropped chain as a false edge).
public class VtxReportQueryStage11 {
  public VtxReportQueryStage12 withLocale() {
    return new VtxReportQueryStage12();
  }

  public VtxReportQueryResult build() {
    return new VtxReportQueryResult('stage11');
  }
}

// v0.10-A: fluent report-query builder, stage 9 of 13. Reached after
// exactly 9 chained hop(s) from VtxReportQueryStage0. Declares the next
// hop (-> Stage10) plus a terminal `build()` (declared on every stage
// from Stage1 through Stage13 -- deliberately NOT globally unique, so rule
// 7's unique-name fallback can never mask a dropped chain as a false edge).
public class VtxReportQueryStage9 {
  public VtxReportQueryStage10 offsetBy() {
    return new VtxReportQueryStage10();
  }

  public VtxReportQueryResult build() {
    return new VtxReportQueryResult('stage9');
  }
}

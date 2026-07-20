// v0.10-A: fluent report-query builder, stage 13 of 13 -- terminal stage.
// Reached only by a 13-segment chain, which per CHAIN_MAX=12 must NEVER
// actually resolve here (the walk aborts at segment 13, before this class
// is ever consulted). Declares `build()` like every other stage purely so
// the method-name-uniqueness invariant (build() is non-unique workspace-wide)
// holds even for the one call site that is supposed to drop.
public class VtxReportQueryStage13 {
  public VtxReportQueryResult build() {
    return new VtxReportQueryResult('stage13');
  }
}

// v0.10-A: exercises the VtxReportQueryStageN fluent builder web at four
// receiver-chain lengths (5, 8, 12, 13 `.method()` segments before the
// traced `.build()` call) against the new CHAIN_MAX=12 walk cap. Segment
// counts below are the resolver's own `parseChainSegments` terminology --
// the number of `.hopMethod()` calls in the RECEIVER text, not counting the
// final traced `.build()` call itself. See GROUND-TRUTH.md's
// "v0.10 ground-truth edges" section for the exact expected outcome of each
// method below.
public class VtxReportChainCaller {
  // 5 segments (selectFields..whereStatus) -- previously (4-segment cap)
  // dropped; under CHAIN_MAX=12 this now RESOLVES, landing on
  // VtxReportQueryStage5.build().
  public VtxReportQueryResult runFiveSegmentChain() {
    VtxReportQueryStage0 q = new VtxReportQueryStage0();
    return q.selectFields().whereRegion().whereChannel().wherePeriod().whereStatus().build();
  }

  // 8 segments (selectFields..having) -- also resolves under CHAIN_MAX=12,
  // landing on VtxReportQueryStage8.build(). NOTE: the whole chain must sit
  // on ONE physical line -- parseChainSegments' regex requires each
  // `.method()` segment to butt directly against the previous segment's
  // closing paren with zero characters (not even a newline) in between; a
  // wrapped/indented continuation line would silently break the match.
  public VtxReportQueryResult runEightSegmentChain() {
    VtxReportQueryStage0 q = new VtxReportQueryStage0();
    return q.selectFields().whereRegion().whereChannel().wherePeriod().whereStatus().orderBy().groupBy().having().build();
  }

  // 12 segments (selectFields..withLocale) -- exactly at the new cap, still
  // resolves, landing on VtxReportQueryStage12.build(). One physical line,
  // same reason as runEightSegmentChain above.
  public VtxReportQueryResult runTwelveSegmentChain() {
    VtxReportQueryStage0 q = new VtxReportQueryStage0();
    return q.selectFields().whereRegion().whereChannel().wherePeriod().whereStatus().orderBy().groupBy().having().limitTo().offsetBy().joinRelated().withLocale().build();
  }

  // 13 segments (selectFields..withTimezone) -- one past the cap. Must drop
  // honestly: no edge to VtxReportQueryStage13.build() (the "true" landing
  // spot), and no false edge to VtxReportQueryStage12.build() either (the
  // walker must not silently stop at segment 12 and credit whatever it was
  // standing on -- see resolveChainedReceiver's own "exceeding the cap is
  // itself a failure" contract). One physical line, same reason as above.
  public VtxReportQueryResult runThirteenSegmentChain() {
    VtxReportQueryStage0 q = new VtxReportQueryStage0();
    return q.selectFields().whereRegion().whereChannel().wherePeriod().whereStatus().orderBy().groupBy().having().limitTo().offsetBy().joinRelated().withLocale().withTimezone().build();
  }
}

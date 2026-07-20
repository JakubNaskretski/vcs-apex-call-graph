// v0.10-A: plain data class returned by every VtxReportQueryStageN.build()
// call. Parse-robustness/realism only -- not itself a target of any
// ground-truth assertion.
public class VtxReportQueryResult {
  public String builtFromStage;

  public VtxReportQueryResult(String builtFromStage) {
    this.builtFromStage = builtFromStage;
  }
}

// v0.10-A2: sole controller for pages/VtxOrderHistoryPage.page -- a "clean"
// page (no extensions, no traps) exercising ordinary commandButton,
// commandLink, and actionPoller bindings that all resolve normally to this
// one class.
public class VtxOrderHistoryController {
  public String lastSyncedLabel { get; private set; }

  public VtxOrderHistoryController() {
    this.lastSyncedLabel = 'never';
  }

  public PageReference exportHistory() {
    return null;
  }

  public PageReference retryFailedSync() {
    return null;
  }

  public PageReference refreshStatus() {
    this.lastSyncedLabel = String.valueOf(System.now());
    return null;
  }
}

// v0.13 (S-corpus): sole apex action of the SUBFLOW half of the
// widget-lifecycle fixture (Vtx_WidgetLifecycleNotifySubflow). Tracing
// notifyTeam's callers must walk: notifyTeam <- Vtx_WidgetLifecycleNotifySubflow
// [metadata] <- Vtx_WidgetLifecycleFlow [subflow, NEW v0.13 edge] <-
// VtxFlowWidgetDmlSource.createWidget [dml, op=insert].
public class VtxFlowWidgetNotifier {

  public static void notifyTeam(Id widgetId) {
    System.debug('notifying team about widget: ' + widgetId);
  }
}

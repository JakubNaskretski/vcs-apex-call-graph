// v0.13 (S-corpus): DML launcher context for the flow-to-subflow chain
// fixture. createWidget's `insert` is the transaction start — CALLER
// direction, this is the deepest ancestor reachable from
// VtxFlowWidgetNotifier.notifyTeam (apex <- subflow <- parent flow <-
// this DML). CALLEE direction, this is the trace root: DML -> parent flow
// -> subflow -> subflow's apex action. logWidgetCreated is Vtx_WidgetLifecycleFlow's
// own direct apex action (unrelated to the subflow chain itself) — it
// exists solely so that flow file has at least one apex actionCalls block
// of its own, matching the pre-existing corpus convention that every
// record-triggered flow with flowObject/flowRecordTriggerType metadata gets
// that metadata attached via a real MetaRef (see metascan.js's extractFlow:
// flowObject/flowRecordTriggerType/flowTriggerType are only ever populated
// on refs pushed from an <actionCalls><actionType>apex</actionType> match —
// a flow with zero apex actionCalls produces zero refs today).
public class VtxFlowWidgetDmlSource {

  public static void createWidget(String widgetName) {
    insert new Vertex_Widget__c(Name__c = widgetName);
  }

  public static void logWidgetCreated(Id widgetId) {
    System.debug('widget created: ' + widgetId);
  }
}

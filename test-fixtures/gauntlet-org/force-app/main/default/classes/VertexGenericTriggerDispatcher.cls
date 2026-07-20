public class VertexGenericTriggerDispatcher {
  private static Map<String, Type> handlerMap = new Map<String, Type>{
    'Vertex_Alert__c' => VertexAlertTriggerHandler.class
  };

  public void dispatch(String sobjectName) {
    Type handlerType = handlerMap.get(sobjectName);
    VertexTriggerHandlerInterface handler = (VertexTriggerHandlerInterface) handlerType.newInstance();
    // NON-EDGE (constructor): same Map<Type,Type>-sourced dynamic instantiation shape as
    // VertexApplication (D3) — no constructor edge to VertexAlertTriggerHandler.<init>. [IDEAL]
    handler.run();
    // -> VertexAlertTriggerHandler.run [via=interface, ~] [MUST] — resolves via the CAST's
    // declared type on line 8 only, same lesson as D4.
  }
}

@isTest
public class VertexOrderTriggerHandlerTest {
  @isTest
  static void testHandleAfterUpdateDirect() {
    Vertex_Order__c order = new Vertex_Order__c();
    VertexPricingService svc = new VertexPricingService();
    svc.reprice(order);
  }

  @isTest
  static void testHandleAfterUpdateViaHandler() {
    VertexOrderTriggerHandler handler = new VertexOrderTriggerHandler();
    handler.handleAfterUpdate(new List<Vertex_Order__c>{ new Vertex_Order__c() });
  }
}

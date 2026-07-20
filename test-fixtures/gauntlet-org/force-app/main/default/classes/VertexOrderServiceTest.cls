@isTest
public class VertexOrderServiceTest {

  @isTest
  static void testDirectReprice() {
    Vertex_Order__c order = new Vertex_Order__c();
    VertexPricingService svc = new VertexPricingService();
    svc.reprice(order);
  }

  @isTest
  static void testReconcileOrder() {
    VertexOrderService service = new VertexOrderService();
    service.reconcileOrder(new Vertex_Order__c(), true);
  }
}

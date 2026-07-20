@isTest
public class VertexPricingServiceTest {
  @isTest
  static void testReprice() {
    Vertex_Order__c order = new Vertex_Order__c();
    VertexPricingService svc = new VertexPricingService();
    svc.reprice(order);
  }
}

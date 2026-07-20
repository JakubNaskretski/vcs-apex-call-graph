public class VertexOrderTriggerHandler {

  public void handleAfterUpdate(List<Vertex_Order__c> orders) {
    VertexPricingService svc = new VertexPricingService();
    for (Vertex_Order__c order : orders) {
      svc.reprice(order);
    }
  }

  public void handleAfterInsert(List<Vertex_Order__c> orders) {
    VertexPricingService svc = new VertexPricingService();
    for (Vertex_Order__c order : orders) {
      svc.reprice(order);
    }
  }
}

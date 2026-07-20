public with sharing class VertexOrderController {

  @AuraEnabled
  public static void recalculate(Id orderId) {
    Vertex_Order__c order = new Vertex_Order__c(Id = orderId);
    VertexPricingService svc = new VertexPricingService();
    svc.reprice(order);
  }

  @AuraEnabled
  public static void bulkRecalculate(List<Id> orderIds) {
    VertexPricingService svc = new VertexPricingService();
    for (Id orderId : orderIds) {
      svc.reprice(new Vertex_Order__c(Id = orderId));
    }
  }
}

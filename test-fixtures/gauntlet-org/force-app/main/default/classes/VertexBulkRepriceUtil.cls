public class VertexBulkRepriceUtil {
  public static void repriceBatch(List<Vertex_Order__c> orders, Vertex_Order__c priorityOrder) {
    VertexPricingService svc = new VertexPricingService();
    for (Vertex_Order__c order : orders) {
      svc.reprice(order);
    }
    if (priorityOrder != null) {
      svc.reprice(priorityOrder);
    }
  }
}

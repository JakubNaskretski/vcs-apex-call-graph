public class VertexQuoteToOrderConverter {
  public void finalizeOrder(Vertex_Order__c order) {
    VertexPricingService svc = new VertexPricingService();
    svc.reprice(order);
  }
}

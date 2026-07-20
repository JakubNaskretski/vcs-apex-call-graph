public class VertexOrderConversionService {
  public void convertAndReprice(Vertex_Order__c order) {
    VertexPricingService svc = new VertexPricingService();
    svc.reprice(order);
  }
}

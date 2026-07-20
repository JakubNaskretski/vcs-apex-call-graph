public class VertexOrderStaticFacade {
  public static void triggerReprice(Vertex_Order__c order) {
    VertexPricingService.repriceOrder(order);
  }
}

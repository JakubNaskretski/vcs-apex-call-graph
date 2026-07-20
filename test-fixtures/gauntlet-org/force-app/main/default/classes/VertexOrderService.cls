public class VertexOrderService {

  public void processOrder(Vertex_Order__c order) {
    VertexPricingService svc = new VertexPricingService();
    svc.reprice(order);
  }

  public void reconcileOrder(Vertex_Order__c order, Boolean applyDiscount) {
    VertexPricingService svc = new VertexPricingService();
    svc.reprice(order);
    if (applyDiscount) {
      order.DiscountApplied__c = true;
      svc.reprice(order);
    }
  }

  public List<Vertex_Order__c> loadOrders(Set<Id> ids) {
    return VertexOrderSelector.selectById(ids);
  }

  public static void run(Vertex_Order__c order) {
    System.debug('VertexOrderService.run: ' + order);
  }
}

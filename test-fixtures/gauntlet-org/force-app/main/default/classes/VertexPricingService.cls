public class VertexPricingService implements VertexRepriceable {

  public virtual void reprice(Vertex_Order__c order) {
    applyBaseRate(order);
    applyDiscountTiers(order);
  }

  private void applyBaseRate(Vertex_Order__c order) {
    order.TotalAmount__c = order.TotalAmount__c;
  }

  private void applyDiscountTiers(Vertex_Order__c order) {
    order.TotalAmount__c = order.TotalAmount__c;
  }

  public static void repriceOrder(Vertex_Order__c order) {
    new VertexPricingService().reprice(order);
  }
}

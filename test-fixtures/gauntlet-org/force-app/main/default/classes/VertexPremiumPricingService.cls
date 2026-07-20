public class VertexPremiumPricingService extends VertexPricingService {
  public override void reprice(Vertex_Order__c order) {
    super.reprice(order);
    applyPremiumSurcharge(order);
  }
  private void applyPremiumSurcharge(Vertex_Order__c order) {
    order.TotalAmount__c = order.TotalAmount__c;
  }
}

public class VertexRepriceableDispatcher {
  public void dispatch(VertexRepriceable svc, Vertex_Order__c order) {
    svc.reprice(order);
    // -> VertexPricingService.reprice        [via=interface, ~] [MUST]
    // -> VertexPremiumPricingService.reprice  [via=interface, ~ override] [MUST] -- override fan-out
  }
}

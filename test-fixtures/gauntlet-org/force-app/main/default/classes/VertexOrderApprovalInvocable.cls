public class VertexOrderApprovalInvocable {
  @InvocableMethod(label='Approve And Reprice Orders')
  public static void execute(List<Id> orderIds) {
    VertexPricingService svc = new VertexPricingService();
    for (Id orderId : orderIds) {
      svc.reprice(new Vertex_Order__c(Id = orderId));
    }
  }
}

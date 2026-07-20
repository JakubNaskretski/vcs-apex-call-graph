public class VtxOwnNamespaceProbe {
  public void callOwnNamespaceClass(Vertex_Order__c order) {
    vtx.VertexPricingService.repriceOrder(order);
  }

  public void dmlOwnNamespaceObjectBareForm() {
    insert new Config__c(Name = 'bare-form');
  }

  public void dmlOwnNamespaceObjectPrefixedForm() {
    insert new vtx__Config__c(Name = 'prefixed-form');
  }
}

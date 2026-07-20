public with sharing class VertexShippingController {
  public void recalcShipping(Vertex_Shipment__c shipment) {
    VertexShippingCostService svc = new VertexShippingCostService();
    svc.reprice(shipment);
  }
}

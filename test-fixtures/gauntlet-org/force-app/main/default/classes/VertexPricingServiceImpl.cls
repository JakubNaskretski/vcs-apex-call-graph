public class VertexPricingServiceImpl implements VertexPricingServiceInterface {
  public Decimal priceItems(List<Vertex_Item__c> items) {
    return items.size() * 1.0;
  }
}

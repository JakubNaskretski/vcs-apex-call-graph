public class VertexApplicationConsumer {
  public Decimal priceViaFactory(List<Vertex_Item__c> items) {
    VertexPricingServiceInterface svc = (VertexPricingServiceInterface) VertexApplication.newInstance(VertexPricingServiceInterface.class);
    // -> VertexApplication.newInstance [via=static] [MUST]
    return svc.priceItems(items);
    // -> VertexPricingServiceImpl.priceItems [via=interface, ~] [MUST] — resolves via the
    // CAST's declared type on line 3, entirely independent of whether the engine understands
    // the Map<Type,Type> binding it can't see through. Worth stating explicitly: the engine
    // gets the right answer here for a simpler reason than "it understood the factory".
  }
}

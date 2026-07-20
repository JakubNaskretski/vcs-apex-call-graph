global class VertexRepriceBatch implements Database.Batchable<SObject> {

  global Database.QueryLocator start(Database.BatchableContext bc) {
    return Database.getQueryLocator([SELECT Id FROM Vertex_Order__c]);
  }

  global void execute(Database.BatchableContext bc, List<Vertex_Order__c> scope) {
    VertexPricingService svc = new VertexPricingService();
    for (Vertex_Order__c order : scope) {
      svc.reprice(order);
    }
  }

  global void finish(Database.BatchableContext bc) {
    Database.executeBatch(new VertexFollowupBatch());
  }
}

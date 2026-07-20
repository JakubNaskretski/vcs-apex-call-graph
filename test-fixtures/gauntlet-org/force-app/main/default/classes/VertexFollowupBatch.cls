global class VertexFollowupBatch implements Database.Batchable<SObject> {
  global Database.QueryLocator start(Database.BatchableContext bc) {
    return Database.getQueryLocator([SELECT Id FROM Vertex_Order__c WHERE FollowupNeeded__c = true]);
  }
  global void execute(Database.BatchableContext bc, List<Vertex_Order__c> scope) {
    System.debug('follow-up batch processed ' + scope.size());
  }
  global void finish(Database.BatchableContext bc) {
  }
}

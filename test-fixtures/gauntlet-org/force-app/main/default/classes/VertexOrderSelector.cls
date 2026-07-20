public class VertexOrderSelector {
  public static List<Vertex_Order__c> selectById(Set<Id> ids) {
    return [SELECT Id, TotalAmount__c FROM Vertex_Order__c WHERE Id IN :ids];
  }
}

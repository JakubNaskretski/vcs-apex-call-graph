public class VertexAuditProcessor {
  public void process(Vertex_Item__c item) {
    item.Status__c = 'Audited';
  }
}

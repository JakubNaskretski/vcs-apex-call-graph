public class VertexArchiveProcessor {
  public void process(Vertex_Item__c item) {
    item.Status__c = 'Archived';
  }
}

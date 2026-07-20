public class VertexFinalizeProcessor {
  public void process(Vertex_Item__c item) {
    item.Status__c = 'Finalized';
  }
}

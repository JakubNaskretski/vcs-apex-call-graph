public class VertexNotifyProcessor {
  public void process(Vertex_Item__c item) {
    item.Status__c = 'Notified';
  }
}

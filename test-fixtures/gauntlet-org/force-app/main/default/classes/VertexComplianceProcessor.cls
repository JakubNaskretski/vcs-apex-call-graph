public class VertexComplianceProcessor {
  public void process(Vertex_Item__c item) {
    item.Status__c = 'ComplianceChecked';
  }
}

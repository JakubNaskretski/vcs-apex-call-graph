public class VertexOrderRunnerUtil {

  public void triggerCaseVariantRun(Vertex_Order__c order) {
    vertexorderservice.RUN(order);
  }

  public void triggerPluralRun(Vertex_Order__c order) {
    VertexOrderServices.run(order);
  }

  public void triggerUnderscoreRun(Vertex_Order__c order) {
    Vertex_Order_Service.run(order);
  }
}

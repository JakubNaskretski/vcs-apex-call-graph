public class VertexPipelineRunner {

  public void runIngest(Vertex_Item__c item) {
    VertexIngestProcessor p = new VertexIngestProcessor();
    p.process(item);
  }

  public void runValidation(Vertex_Item__c item) {
    new VertexValidationProcessor().process(item);
  }

  public void runDynamic(String stepKey, Vertex_Item__c item) {
    locateStep(stepKey).process(item);
    // NON-EDGE: 12 classes declare `process`. locateStep()'s return type (Object) is not
    // inferred across the chain, so typed resolution fails; unique-name fallback requires
    // EXACTLY ONE declaring class and must refuse with 12 candidates -- zero edges into ANY
    // of the 12, call site counted unresolved. [IDEAL -- same guard as A22, at N=12. This is
    // the corpus's primary demonstration of must-cover #2: "must NOT produce unique-name
    // edges when 12 candidates exist".]
  }

  private Object locateStep(String key) {
    return null;
  }
}

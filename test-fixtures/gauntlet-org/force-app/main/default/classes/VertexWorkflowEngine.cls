public class VertexWorkflowEngine {
  private Object stepHandler;

  public void advanceStageOne(String payload) {
    Object handler = resolveStepHandler('one');
    handler.bind(payload);
  }

  public void advanceStageTwo(String payload) {
    Object handler = resolveStepHandler('two');
    handler.getDelegate().bind(payload);
  }

  public void advanceStageThree(String typeName, String payload) {
    Type dynType = Type.forName(typeName);
    Object inst = dynType.newInstance();
    inst.bind(payload);
  }

  public void advanceStageFour(String payload, String metadata) {
    Object handler = resolveStepHandler('four');
    handler.bind(payload, metadata);
  }

  private Object resolveStepHandler(String key) {
    return stepHandler;
  }
}

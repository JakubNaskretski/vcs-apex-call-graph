public class VertexRuleEvaluator {
  private Object ruleHandler;

  public void evaluateFirstPass(String payload) {
    Object handler = resolveRuleHandler('one');
    handler.bind(payload);
  }

  public void evaluateSecondPass(String payload) {
    Object handler = resolveRuleHandler('two');
    handler.getDelegate().bind(payload);
  }

  public void evaluateDynamicRule(String typeName, String payload) {
    Type dynType = Type.forName(typeName);
    Object inst = dynType.newInstance();
    inst.bind(payload);
  }

  public void evaluateWithContext(String payload, String metadata) {
    Object handler = resolveRuleHandler('four');
    handler.bind(payload, metadata);
  }

  private Object resolveRuleHandler(String key) {
    return ruleHandler;
  }
}

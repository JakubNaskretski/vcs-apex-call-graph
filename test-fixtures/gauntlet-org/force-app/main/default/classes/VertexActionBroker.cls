public class VertexActionBroker {
  private Object actionHandler;

  public void brokerFirstAction(String payload) {
    Object handler = resolveActionHandler('one');
    handler.bind(payload);
  }

  public void brokerChainedAction(String payload) {
    Object handler = resolveActionHandler('two');
    handler.getDelegate().bind(payload);
  }

  public void brokerDynamicAction(String typeName, String payload) {
    Type dynType = Type.forName(typeName);
    Object inst = dynType.newInstance();
    inst.bind(payload);
  }

  public void brokerActionWithMeta(String payload, String metadata) {
    Object handler = resolveActionHandler('four');
    handler.bind(payload, metadata);
  }

  private Object resolveActionHandler(String key) {
    return actionHandler;
  }
}

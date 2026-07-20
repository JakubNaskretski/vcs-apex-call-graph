public class VertexEventDispatcher {
  private Object eventHandler;

  public void dispatchCreated(String payload) {
    Object handler = resolveEventHandler('one');
    handler.bind(payload);
  }

  public void dispatchUpdated(String payload) {
    Object handler = resolveEventHandler('two');
    handler.getDelegate().bind(payload);
  }

  public void dispatchDynamicEvent(String typeName, String payload) {
    Type dynType = Type.forName(typeName);
    Object inst = dynType.newInstance();
    inst.bind(payload);
  }

  public void dispatchWithEnvelope(String payload, String metadata) {
    Object handler = resolveEventHandler('four');
    handler.bind(payload, metadata);
  }

  private Object resolveEventHandler(String key) {
    return eventHandler;
  }
}

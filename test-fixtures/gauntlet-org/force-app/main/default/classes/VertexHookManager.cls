public class VertexHookManager {
  private Object hookHandler;

  public void fireBeforeHook(String payload) {
    Object handler = resolveHookHandler('one');
    handler.bind(payload);
  }

  public void fireAfterHook(String payload) {
    Object handler = resolveHookHandler('two');
    handler.getDelegate().bind(payload);
  }

  public void fireDynamicHook(String typeName, String payload) {
    Type dynType = Type.forName(typeName);
    Object inst = dynType.newInstance();
    inst.bind(payload);
  }

  public void fireHookWithPayload(String payload, String metadata) {
    Object handler = resolveHookHandler('four');
    handler.bind(payload, metadata);
  }

  private Object resolveHookHandler(String key) {
    return hookHandler;
  }
}

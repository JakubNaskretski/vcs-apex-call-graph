public class VertexAdapterRegistry {
  private Object adapterHandler;

  public void wireFirstAdapter(String payload) {
    Object handler = resolveAdapterHandler('one');
    handler.bind(payload);
  }

  public void wireChainedAdapter(String payload) {
    Object handler = resolveAdapterHandler('two');
    handler.getDelegate().bind(payload);
  }

  public void wireDynamicAdapter(String typeName, String payload) {
    Type dynType = Type.forName(typeName);
    Object inst = dynType.newInstance();
    inst.bind(payload);
  }

  public void wireAdapterWithConfig(String payload, String metadata) {
    Object handler = resolveAdapterHandler('four');
    handler.bind(payload, metadata);
  }

  private Object resolveAdapterHandler(String key) {
    return adapterHandler;
  }
}

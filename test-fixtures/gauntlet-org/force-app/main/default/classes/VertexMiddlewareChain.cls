public class VertexMiddlewareChain {
  private Object linkHandler;

  public void invokeFirstLink(String payload) {
    Object handler = resolveLinkHandler('one');
    handler.bind(payload);
  }

  public void invokeChainedLink(String payload) {
    Object handler = resolveLinkHandler('two');
    handler.getDelegate().bind(payload);
  }

  public void invokeDynamicLink(String typeName, String payload) {
    Type dynType = Type.forName(typeName);
    Object inst = dynType.newInstance();
    inst.bind(payload);
  }

  public void invokeLinkWithContext(String payload, String metadata) {
    Object handler = resolveLinkHandler('four');
    handler.bind(payload, metadata);
  }

  private Object resolveLinkHandler(String key) {
    return linkHandler;
  }
}

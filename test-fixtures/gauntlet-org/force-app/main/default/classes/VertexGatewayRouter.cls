public class VertexGatewayRouter {
  private Object routeHandler;

  public void routeFirstHop(String payload) {
    Object handler = resolveRouteHandler('one');
    handler.bind(payload);
  }

  public void routeChainedHop(String payload) {
    Object handler = resolveRouteHandler('two');
    handler.getDelegate().bind(payload);
  }

  public void routeDynamicHop(String typeName, String payload) {
    Type dynType = Type.forName(typeName);
    Object inst = dynType.newInstance();
    inst.bind(payload);
  }

  public void routeHopWithMeta(String payload, String metadata) {
    Object handler = resolveRouteHandler('four');
    handler.bind(payload, metadata);
  }

  private Object resolveRouteHandler(String key) {
    return routeHandler;
  }
}

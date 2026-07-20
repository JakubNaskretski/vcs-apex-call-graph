public class VertexPluginHost {
  private Object pluginHandler;

  public void loadPluginStageOne(String payload) {
    Object handler = resolvePluginHandler('one');
    handler.bind(payload);
  }

  public void loadPluginStageTwo(String payload) {
    Object handler = resolvePluginHandler('two');
    handler.getDelegate().bind(payload);
  }

  public void loadPluginDynamically(String typeName, String payload) {
    Type dynType = Type.forName(typeName);
    Object inst = dynType.newInstance();
    inst.bind(payload);
  }

  public void loadPluginWithManifest(String payload, String metadata) {
    Object handler = resolvePluginHandler('four');
    handler.bind(payload, metadata);
  }

  private Object resolvePluginHandler(String key) {
    return pluginHandler;
  }
}

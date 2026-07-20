public class VertexTaskRunner {
  private Object taskHandler;

  public void runQueuedTask(String payload) {
    Object handler = resolveTaskHandler('one');
    handler.bind(payload);
  }

  public void runChainedTask(String payload) {
    Object handler = resolveTaskHandler('two');
    handler.getDelegate().bind(payload);
  }

  public void runDynamicTask(String typeName, String payload) {
    Type dynType = Type.forName(typeName);
    Object inst = dynType.newInstance();
    inst.bind(payload);
  }

  public void runTaskWithOptions(String payload, String metadata) {
    Object handler = resolveTaskHandler('four');
    handler.bind(payload, metadata);
  }

  private Object resolveTaskHandler(String key) {
    return taskHandler;
  }
}

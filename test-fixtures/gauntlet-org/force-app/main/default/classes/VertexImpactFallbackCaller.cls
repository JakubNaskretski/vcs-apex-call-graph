public class VertexImpactFallbackCaller {
  public void changeWithExtraContext() {
    VertexImpactService service = new VertexImpactService();
    service.change('alpha', 'context');
  }
}

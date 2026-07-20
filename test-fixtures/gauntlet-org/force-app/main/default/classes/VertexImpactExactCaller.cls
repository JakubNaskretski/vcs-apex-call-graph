public class VertexImpactExactCaller {
  public void changeString() {
    VertexImpactService service = new VertexImpactService();
    service.change('alpha');
  }

  public void changeInteger() {
    VertexImpactService service = new VertexImpactService();
    service.change(7);
  }

  public void changeBoolean() {
    VertexImpactService service = new VertexImpactService();
    service.change(true);
  }
}

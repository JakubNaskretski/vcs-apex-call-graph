public class VertexNestedConsumer {
  public void run() {
    VertexOrderProcessor.Batch.Row row = new VertexOrderProcessor.Batch.Row();
    // -> VertexOrderProcessor.Batch.Row.<init> [via=new] [MUST] — fully-qualified Outer.Mid.Inner, cross-file, 2 levels deep
    row.process();
    // -> VertexOrderProcessor.Batch.Row.process [via=typed] [MUST]
  }
}

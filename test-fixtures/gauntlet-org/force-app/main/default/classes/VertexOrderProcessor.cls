public class VertexOrderProcessor {

  public class Batch {
    public class Row {
      public String label;
      public void process() {
        VertexOrderProcessor.staticHelper();
      }
    }
  }

  public static void staticHelper() {
    System.debug('outer helper called from 2-deep inner');
  }
}

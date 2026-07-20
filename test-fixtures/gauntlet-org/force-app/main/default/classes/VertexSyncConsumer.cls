public class VertexSyncConsumer {

  public void runViaSyncable() {
    VertexSyncable s = new VertexDataBridge();
    s.sync();    // -> VertexDataBridge.sync [via=interface, ~] [MUST] — direct: VertexDataBridge directly `implements VertexSyncable`
  }

  public void runViaReadable() {
    VertexReadable r = new VertexDataBridge();
    r.sync();
    // -> VertexDataBridge.sync [via=interface, ~] [MUST — adjudicated 2026-07-17: see Target 19.]
    // VertexDataBridge never directly `implements VertexReadable` — it is reached only
    // transitively through `VertexSyncable extends VertexReadable, VertexWritable`. The
    // engine's G6 interface-extends transitive closure (resolver.js, v0.5) registers
    // implementers under every ancestor interface, so this edge is documented behavior.
  }
}

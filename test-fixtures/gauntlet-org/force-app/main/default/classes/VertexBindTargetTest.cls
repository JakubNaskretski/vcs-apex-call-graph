@isTest
private class VertexBindTargetTest {
  @isTest
  static void testBindReturnsOpInfo() {
    VertexBindInfo info = new VertexBindInfo();
    info.requestId = 'REQ-1';
    VertexOpInfo result = VertexBindTarget.bind(info);
    System.assertNotEquals(null, result);
  }
}

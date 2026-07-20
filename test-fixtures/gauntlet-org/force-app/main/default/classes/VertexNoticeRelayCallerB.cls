public class VertexNoticeRelayCallerB {
  public void sendSecondNotice(String message) {
    resolveDelegate().relayNotice(message);
  }

  private Object resolveDelegate() {
    return null;
  }
}

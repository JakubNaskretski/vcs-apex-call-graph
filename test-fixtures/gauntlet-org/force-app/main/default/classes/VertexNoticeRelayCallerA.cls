public class VertexNoticeRelayCallerA {
  private Object notifier;

  public void sendFirstNotice(String message) {
    notifier.relayNotice(message);
  }

  public void wireNotifier(Object n) {
    notifier = n;
  }
}

/**
 * Notification contract implemented by every Acme notifier channel.
 */
public interface AcmeNotifiable {
    void notify(String message);
}

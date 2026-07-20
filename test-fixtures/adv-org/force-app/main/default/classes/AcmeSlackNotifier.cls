/**
 * Slack notification channel. Deliberately does not redeclare notify() —
 * AcmeNotifiable is satisfied entirely through the inherited
 * AcmeBaseNotifier implementation.
 */
public class AcmeSlackNotifier extends AcmeBaseNotifier implements AcmeNotifiable {

    public AcmeSlackNotifier(String channelName) {
        super(channelName);
    }
}

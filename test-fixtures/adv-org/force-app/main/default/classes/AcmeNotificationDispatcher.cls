/**
 * Fans a single message out to every registered notification channel via
 * the AcmeNotifiable interface, including the Slack channel that only
 * satisfies the interface through inheritance.
 */
public class AcmeNotificationDispatcher {

    public void dispatchToAll(String message) {
        List<AcmeNotifiable> notifiers = new List<AcmeNotifiable>{
            new AcmeEmailNotifier('example-recipient'),
            new AcmeSmsNotifier('https://sms-gateway.acmemanufacturing.example/send'),
            new AcmeSlackNotifier('#acme-quotes')
        };
        for (AcmeNotifiable notifier : notifiers) {
            notifier.notify(message);
        }
    }
}

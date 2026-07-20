/**
 * Email notification channel: implements AcmeNotifiable directly.
 */
public class AcmeEmailNotifier implements AcmeNotifiable {

    public String fromAddress;

    public AcmeEmailNotifier(String fromAddress) {
        this.fromAddress = fromAddress;
    }

    public void notify(String message) {
        sendEmail(message);
    }

    private void sendEmail(String message) {
        Messaging.SingleEmailMessage mail = new Messaging.SingleEmailMessage();
        mail.setSubject('Acme Manufacturing Notification');
        mail.setPlainTextBody(message);
        mail.setReplyTo(fromAddress);
        Messaging.sendEmail(new List<Messaging.SingleEmailMessage>{ mail });
    }
}

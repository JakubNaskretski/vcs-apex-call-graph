/**
 * @future email notifier invoked from AcmeOrderUtil.markApproved(). Async
 * leaf: sends a single approval email and calls nothing else.
 */
public without sharing class AcmeFutureNotifier {

    @future
    public static void sendApprovalEmail(Id orderId, String emailAddress) {
        if (String.isBlank(emailAddress)) {
            return;
        }
        Messaging.SingleEmailMessage mail = new Messaging.SingleEmailMessage();
        mail.setToAddresses(new List<String>{ emailAddress });
        mail.setSubject('Acme Order Approved: ' + orderId);
        mail.setPlainTextBody('Your order ' + orderId + ' has been approved.');
        Messaging.sendEmail(new List<Messaging.SingleEmailMessage>{ mail });
    }
}

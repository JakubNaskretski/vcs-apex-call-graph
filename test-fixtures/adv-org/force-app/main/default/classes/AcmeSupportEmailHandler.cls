/**
 * v0.4 corpus fixture for F5 entry-kind detection: implements
 * Messaging.InboundEmailHandler, so handleInboundEmail() should be tagged
 * with the 'InboundEmailHandler (Email Service)' entry.
 */
public class AcmeSupportEmailHandler implements Messaging.InboundEmailHandler {

    public Messaging.InboundEmailResult handleInboundEmail(Messaging.InboundEmail email, Messaging.InboundEnvelope envelope) {
        Messaging.InboundEmailResult result = new Messaging.InboundEmailResult();
        result.success = true;
        System.debug('Support email received: ' + (email == null ? null : email.subject));
        return result;
    }
}

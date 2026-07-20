/**
 * AcmeStepHandler channel: notification step. See AcmeStepHandler.cls doc
 * comment.
 */
public class AcmeNotifyStepHandler implements AcmeStepHandler {

    public void handleStep(Acme_Order__c order) {
        System.debug('Notifying for order ' + (order == null ? null : order.Id));
    }
}

/**
 * AcmeStepHandler channel: validation step. See AcmeStepHandler.cls doc
 * comment.
 */
public class AcmeValidateStepHandler implements AcmeStepHandler {

    public void handleStep(Acme_Order__c order) {
        System.debug('Validating order ' + (order == null ? null : order.Id));
    }
}

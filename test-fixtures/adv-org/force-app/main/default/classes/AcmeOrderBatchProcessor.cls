/**
 * Database.Batchable<sObject> over orders. start() sources its query text
 * from AcmeOrderUtil.buildQuery(); execute() re-enters
 * AcmeOrderService.processOrders() per chunk (normalization/validation is
 * idempotent, so re-running it on a batch scope is safe); finish() fans a
 * completion notice out to every registered channel.
 */
public with sharing class AcmeOrderBatchProcessor implements Database.Batchable<SObject> {

    private List<Acme_Order__c> seedOrders;

    public AcmeOrderBatchProcessor() {
        this(null);
    }

    public AcmeOrderBatchProcessor(List<Acme_Order__c> seedOrders) {
        this.seedOrders = seedOrders;
    }

    public Database.QueryLocator start(Database.BatchableContext bc) {
        String query = AcmeOrderUtil.buildQuery();
        return Database.getQueryLocator(query);
    }

    public void execute(Database.BatchableContext bc, List<SObject> scope) {
        List<Acme_Order__c> orders = (List<Acme_Order__c>) scope;
        try {
            AcmeOrderService.processOrders(orders);
        } catch (AcmeValidationException ve) {
            System.debug('Batch execute caught validation exception: ' + ve.getMessage());
        }
    }

    public void finish(Database.BatchableContext bc) {
        new AcmeNotificationDispatcher().dispatchToAll('AcmeOrderBatchProcessor run complete.');
        NovaBillingService.recordBatchCompletion(); // v0.7: core -> billing cross-package call
    }
}

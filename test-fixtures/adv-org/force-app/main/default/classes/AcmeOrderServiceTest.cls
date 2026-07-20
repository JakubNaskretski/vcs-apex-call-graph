/**
 * Exercises the order lifecycle end-to-end: the service layer, the batch
 * processor, the bulk invocable, quote construction, the notification
 * dispatcher, and the nightly scheduled job.
 */
@isTest
private class AcmeOrderServiceTest {

    @isTest
    static void testProcessOrders() {
        List<Acme_Order__c> orders = new List<Acme_Order__c>{
            new Acme_Order__c(Acme_Status__c = 'New', Amount__c = 100)
        };

        Test.startTest();
        AcmeOrderService.processOrders(orders);
        Test.stopTest();
    }

    @isTest
    static void testBatchProcessor() {
        AcmeOrderBatchProcessor batch = new AcmeOrderBatchProcessor();

        Test.startTest();
        Database.executeBatch(batch);
        Test.stopTest();
    }

    @isTest
    static void testInvocable() {
        List<Id> orderIds = new List<Id>();

        Test.startTest();
        AcmeOrderInvocable.execute(orderIds);
        Test.stopTest();
    }

    @isTest
    static void testQuoteBuilder() {
        AcmeQuoteBuilder builder = new AcmeQuoteBuilder();
        AcmeQuote quote = builder.build();

        System.assertNotEquals(null, quote, 'Builder should always produce a quote instance.');
    }

    @isTest
    static void testNotificationDispatcher() {
        Test.startTest();
        new AcmeNotificationDispatcher().dispatchToAll('Test notification');
        Test.stopTest();
    }

    @isTest
    static void testScheduledJob() {
        AcmeNightlyReconciliationScheduler scheduler = new AcmeNightlyReconciliationScheduler();
        String cronExpression = '0 0 2 * * ?';

        Test.startTest();
        System.schedule('Acme Nightly Reconciliation Test', cronExpression, scheduler);
        Test.stopTest();
    }
}

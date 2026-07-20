/**
 * Order service layer. processOrders() is the trigger/batch entry point:
 * it normalizes incoming rows, revalidates each one through the
 * validate -> checkStock -> resolve -> validate cycle, then kicks off a
 * batch pass. approveOrder() and recalculatePricing() are the two
 * record-level entry points shared by async, UI, and flow callers.
 */
public with sharing class AcmeOrderService {

    public static void processOrders(List<Acme_Order__c> orders) {
        if (orders == null || orders.isEmpty()) {
            return;
        }
        List<Acme_Order__c> normalized = AcmeOrderUtil.normalize(orders);
        for (Acme_Order__c ord : normalized) {
            AcmeOrderValidator.validate(ord.Id);
        }
        Database.executeBatch(new AcmeOrderBatchProcessor(normalized));
    }

    public static void approveOrder(Id orderId) {
        Acme_Order__c ord = [
            SELECT Id, Acme_Status__c
            FROM Acme_Order__c
            WHERE Id = :orderId
            LIMIT 1
        ];
        AcmeOrderUtil.markApproved(ord);
    }

    public static void recalculatePricing(Id orderId) {
        Acme_Order__c ord = [
            SELECT Id, Amount__c, LineItemCount__c
            FROM Acme_Order__c
            WHERE Id = :orderId
            LIMIT 1
        ];
        ord.Amount__c = AcmePricingEngine.calculatePrice(ord);
        update ord;
    }
}

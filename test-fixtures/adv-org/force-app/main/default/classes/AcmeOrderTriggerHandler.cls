/**
 * Order trigger handler. Link 2 of the order trigger -> handler -> service ->
 * util chain: normalizes trigger context flags into a single decision about
 * whether to hand the batch of new/changed orders to AcmeOrderService.
 */
public with sharing class AcmeOrderTriggerHandler {

    public void handle(
        List<Acme_Order__c> newOrders,
        Map<Id, Acme_Order__c> oldMap,
        Boolean isBefore,
        Boolean isAfter,
        Boolean isInsert,
        Boolean isUpdate
    ) {
        if (newOrders == null || newOrders.isEmpty()) {
            return;
        }
        if (isBefore && (isInsert || isUpdate)) {
            AcmeOrderService.processOrders(newOrders);
        }
    }
}

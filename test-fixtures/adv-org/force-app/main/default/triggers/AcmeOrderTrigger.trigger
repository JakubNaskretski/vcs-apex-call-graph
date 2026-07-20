/**
 * Order automation entry point. Kept intentionally thin: all logic lives in
 * AcmeOrderTriggerHandler -> AcmeOrderService -> AcmeOrderUtil so the trigger
 * body itself never needs to change when order rules change.
 */
trigger AcmeOrderTrigger on Acme_Order__c (before insert, before update, after insert, after update) {
    AcmeOrderTriggerHandler handler = new AcmeOrderTriggerHandler();
    try {
        handler.handle(
            Trigger.new,
            Trigger.oldMap,
            Trigger.isBefore,
            Trigger.isAfter,
            Trigger.isInsert,
            Trigger.isUpdate
        );
    } catch (Exception ex) {
        System.debug('AcmeOrderTrigger caught: ' + ex.getMessage());
    }
}

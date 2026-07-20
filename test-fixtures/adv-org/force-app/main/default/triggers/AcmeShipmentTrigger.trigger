/**
 * Shipment automation entry point. Mirrors AcmeOrderTrigger's shape: thin
 * delegation into AcmeShipmentTriggerHandler -> AcmeShipmentService ->
 * AcmeShipmentUtil.
 */
trigger AcmeShipmentTrigger on Acme_Shipment__c (before insert, before update, after insert, after update) {
    AcmeShipmentTriggerHandler handler = new AcmeShipmentTriggerHandler();
    handler.handle(
        Trigger.new,
        Trigger.oldMap,
        Trigger.isBefore,
        Trigger.isAfter,
        Trigger.isInsert,
        Trigger.isUpdate
    );
}

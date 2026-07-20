/**
 * v0.4 corpus fixture: a SECOND trigger on Acme_Shipment__c, deliberately
 * declaring a distinct event set (before delete, after undelete) from
 * AcmeShipmentTrigger's (before/after insert, before/after update) so the
 * DML -> trigger event-mapping matrix has more than one trigger on the
 * same object to fan out to -- e.g. a `merge` DML statement on
 * Acme_Shipment__c (delete + update events) should reach BOTH this
 * trigger (its before-delete event) and AcmeShipmentTrigger (its
 * before/after-update events).
 */
trigger AcmeShipmentLifecycleTrigger on Acme_Shipment__c (before delete, after undelete) {
    AcmeShipmentRollupHandler.handleLifecycleEvent(
        Trigger.old,
        Trigger.isDelete,
        Trigger.isUndelete
    );
}

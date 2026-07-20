/**
 * v0.4 corpus fixture for two things at once:
 *  1. The second trigger on Acme_Shipment__c (AcmeShipmentLifecycleTrigger,
 *     "before delete, after undelete") delegates to
 *     handleLifecycleEvent() here, giving the object a distinct-event-set
 *     second trigger so the DML -> trigger event-mapping matrix has more
 *     than one trigger per object to fan out to.
 *  2. rollupTotals() is called from AcmeShipmentTriggerHandler.handle()
 *     (see that file) and performs statement-form DML on Acme_Shipment__c
 *     -- the SAME object AcmeShipmentTrigger (the first, insert/update
 *     trigger) fires on. This deliberately closes a cycle: tracing callers
 *     of AcmeShipmentTrigger's trigger body walks up through
 *     AcmeShipmentTriggerHandler.handle -> AcmeShipmentRollupHandler
 *     .rollupTotals -> (DML update on Acme_Shipment__c) -> back to
 *     AcmeShipmentTrigger, which is already on the ancestor path. Used to
 *     verify the resolver's existing cyclic flag fires for a DML-induced
 *     cycle, not just a plain method-call cycle (contrast with the
 *     pre-existing AcmeOrderValidator -> AcmeInventoryChecker ->
 *     AcmeBackorderResolver -> AcmeOrderValidator method-call cycle).
 */
public with sharing class AcmeShipmentRollupHandler {

    public static void handleLifecycleEvent(List<Acme_Shipment__c> oldShipments, Boolean isDelete, Boolean isUndelete) {
        if (oldShipments == null || oldShipments.isEmpty()) {
            return;
        }
        System.debug('Shipment lifecycle event, delete=' + isDelete + ' undelete=' + isUndelete + ' count=' + oldShipments.size());
    }

    public static void rollupTotals(List<Acme_Shipment__c> shipments) {
        if (shipments == null || shipments.isEmpty()) {
            return;
        }
        for (Acme_Shipment__c shipment : shipments) {
            shipment.RollupTotal__c = (shipment.RollupTotal__c == null ? 0 : shipment.RollupTotal__c) + 1;
        }
        update shipments;
    }
}

/**
 * Shipment trigger handler; delegates enrichment/dispatch of newly
 * inserted or updated shipments to AcmeShipmentService.
 *
 * v0.4: also calls AcmeShipmentRollupHandler.rollupTotals(), which performs
 * DML on Acme_Shipment__c itself -- a deliberate "handler does DML on its
 * own object" cycle fixture (see AcmeShipmentRollupHandler.cls doc comment
 * for the full ancestor-path explanation).
 */
public with sharing class AcmeShipmentTriggerHandler {

    public void handle(
        List<Acme_Shipment__c> newShipments,
        Map<Id, Acme_Shipment__c> oldMap,
        Boolean isBefore,
        Boolean isAfter,
        Boolean isInsert,
        Boolean isUpdate
    ) {
        if (newShipments == null || newShipments.isEmpty()) {
            return;
        }
        if (isAfter && (isInsert || isUpdate)) {
            AcmeShipmentService.processShipments(newShipments);
            AcmeShipmentRollupHandler.rollupTotals(newShipments);
        }
    }
}

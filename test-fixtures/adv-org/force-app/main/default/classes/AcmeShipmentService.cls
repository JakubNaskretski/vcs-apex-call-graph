/**
 * Shipment service layer. processShipments() enriches the given shipments
 * and hands them to a Queueable for further async processing.
 * scheduleDelivery() is the record-level entry point shared by OmniStudio
 * and the shipment-tracker Aura/LWC surfaces.
 */
public with sharing class AcmeShipmentService {

    public static void processShipments(List<Acme_Shipment__c> shipments) {
        if (shipments == null || shipments.isEmpty()) {
            return;
        }
        List<Acme_Shipment__c> enriched = AcmeShipmentUtil.enrich(shipments);
        System.enqueueJob(new AcmeShipmentQueueableDispatcher(enriched));
    }

    public static Datetime scheduleDelivery(Id shipmentId) {
        Datetime eta = AcmeShipmentUtil.computeEta(shipmentId);
        update new Acme_Shipment__c(Id = shipmentId, EstimatedDelivery__c = eta);
        return eta;
    }

    public static void reprocessFailedShipment(Id shipmentId) {
        try {
            AcmeShipmentUtil.computeEta(shipmentId);
        } catch (AcmeValidationException e) {
            System.debug('Shipment reprocessing failed: ' + e.getMessage());
            throw e;
        }
    }
}

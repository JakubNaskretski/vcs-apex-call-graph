/**
 * Queueable enqueued from AcmeShipmentService.processShipments(). Its
 * execute() calls back into the shipment service so the enriched shipments
 * finish their lifecycle (ETA scheduling, downstream dispatch) off the
 * original trigger's transaction.
 */
public with sharing class AcmeShipmentQueueableDispatcher implements Queueable {

    private List<Acme_Shipment__c> shipments;

    public AcmeShipmentQueueableDispatcher(List<Acme_Shipment__c> shipments) {
        this.shipments = shipments;
    }

    public void execute(QueueableContext qc) {
        if (shipments == null || shipments.isEmpty()) {
            return;
        }
        AcmeShipmentService.processShipments(shipments);
    }
}

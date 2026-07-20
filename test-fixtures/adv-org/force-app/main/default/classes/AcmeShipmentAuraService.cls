/**
 * @AuraEnabled shipment service backing the acmeShipmentTracker LWC (wire +
 * imperative), the AcmeShipmentStatusBoard Aura component, and the
 * OmniStudio shipment OmniScript.
 */
public with sharing class AcmeShipmentAuraService {

    @AuraEnabled(cacheable=true)
    public static List<Acme_Shipment__c> getShipmentStatuses(Id orderId) {
        List<Acme_Shipment__c> shipments = [
            SELECT Id, Status__c, Carrier__c, EstimatedDelivery__c
            FROM Acme_Shipment__c
            WHERE Order__c = :orderId
        ];
        for (Acme_Shipment__c shp : shipments) {
            shp.EstimatedDelivery__c = AcmeShipmentUtil.computeEta(shp.Id);
        }
        return shipments;
    }

    @AuraEnabled
    public static void refreshTracking(Id orderId) {
        List<Acme_Shipment__c> shipments = [
            SELECT Id
            FROM Acme_Shipment__c
            WHERE Order__c = :orderId
        ];
        for (Acme_Shipment__c shp : shipments) {
            AcmeShipmentService.scheduleDelivery(shp.Id);
        }
    }
}

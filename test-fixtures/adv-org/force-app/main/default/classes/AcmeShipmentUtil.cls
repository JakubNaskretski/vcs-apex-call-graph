/**
 * Shipment utility layer. Link 4 of the shipment chain: enrich() fills in
 * defaults before a shipment is persisted or queued; computeEta() is the
 * single source of ETA math shared by the service layer and the Aura
 * shipment-tracker surface.
 */
public without sharing class AcmeShipmentUtil {

    public static List<Acme_Shipment__c> enrich(List<Acme_Shipment__c> shipments) {
        List<Acme_Shipment__c> result = new List<Acme_Shipment__c>();
        for (Acme_Shipment__c shp : shipments) {
            if (shp.Carrier__c == null) {
                shp.Carrier__c = 'Standard';
            }
            result.add(shp);
        }
        return result;
    }

    public static Datetime computeEta(Id shipmentId) {
        return Datetime.now().addDays(5);
    }
}

// v0.5 corpus fixture for G4 (anonymous Apex): ad-hoc recalculation script.
// Re-prices open orders via the real order service, reschedules delivery
// for pending shipments via the real shipment service, then persists the
// re-priced orders with a single DML statement on Acme_Order__c -- a
// triggered object (AcmeOrderTrigger) -- so the standard order automation
// re-fires for every row this script touches.
List<Acme_Order__c> openOrders = [
    SELECT Id, Amount__c, LineItemCount__c
    FROM Acme_Order__c
    WHERE Acme_Status__c = 'New'
    LIMIT 200
];

for (Acme_Order__c ord : openOrders) {
    AcmeOrderService.recalculatePricing(ord.Id);
}

List<Acme_Shipment__c> pendingShipments = [
    SELECT Id
    FROM Acme_Shipment__c
    WHERE Status__c = 'Pending'
    LIMIT 200
];

for (Acme_Shipment__c shp : pendingShipments) {
    AcmeShipmentService.scheduleDelivery(shp.Id);
}

update openOrders;

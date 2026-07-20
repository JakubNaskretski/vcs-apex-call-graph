/**
 * v0.4 corpus fixture for the DML -> trigger / record-triggered-flow
 * linkage feature: exercises every statement-form DML operation
 * (insert/update/delete/upsert/merge/undelete) plus the Database.xxx()
 * method-form equivalents, across both Acme_Order__c and Acme_Shipment__c,
 * mixing typed lists and single records. See MANIFEST.md "v0.4
 * ground-truth edges" for the exact intended edges each method below
 * produces.
 */
public with sharing class AcmeFulfillmentDmlService {

    // ---- insert ---------------------------------------------------------

    public static void insertOrders(List<Acme_Order__c> orders) {
        insert orders;
    }

    public static void insertSingleShipment(Acme_Shipment__c shipment) {
        insert shipment;
    }

    // ---- update -----------------------------------------------------------

    public static void updateShipments(List<Acme_Shipment__c> shipments) {
        update shipments;
    }

    public static void updateSingleOrder(Acme_Order__c order) {
        update order;
    }

    // ---- delete -----------------------------------------------------------

    public static void deleteShipments(List<Acme_Shipment__c> shipments) {
        delete shipments;
    }

    public static void deleteSingleOrder(Acme_Order__c order) {
        // No Acme_Order__c trigger declares a delete event today (only
        // AcmeOrderTrigger exists, insert/update only) -- this call site
        // deliberately exercises the "no trigger matches" branch of the
        // DML -> trigger event-mapping matrix.
        delete order;
    }

    // ---- upsert -----------------------------------------------------------

    public static void upsertOrders(List<Acme_Order__c> orders) {
        upsert orders;
    }

    public static void upsertSingleShipment(Acme_Shipment__c shipment) {
        upsert shipment;
    }

    // ---- merge --------------------------------------------------------

    public static void mergeShipments(Acme_Shipment__c masterShipment, Acme_Shipment__c duplicateShipment) {
        merge masterShipment duplicateShipment;
    }

    public static void mergeOrders(Acme_Order__c masterOrder, Acme_Order__c duplicateOrder) {
        merge masterOrder duplicateOrder;
    }

    // ---- undelete -----------------------------------------------------

    public static void undeleteShipments(List<Acme_Shipment__c> shipments) {
        undelete shipments;
    }

    // ---- Database.xxx() method-form DML --------------------------------

    public static void insertOrdersViaDatabase(List<Acme_Order__c> orders) {
        Database.insert(orders, false);
    }

    public static void updateShipmentsViaDatabase(List<Acme_Shipment__c> shipments) {
        Database.update(shipments, true);
    }
}

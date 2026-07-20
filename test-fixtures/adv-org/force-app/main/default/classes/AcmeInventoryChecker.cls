/**
 * Node 2 of the order-validation cycle: checkStock delegates to the
 * backorder resolver whenever on-hand quantity is insufficient.
 */
public class AcmeInventoryChecker {

    public static Boolean checkStock(Id orderId, Integer cycleDepth) {
        Boolean hasStock = queryAvailableUnits(orderId) > 0;
        if (hasStock) {
            return true;
        }
        return AcmeBackorderResolver.resolve(orderId, cycleDepth);
    }

    private static Integer queryAvailableUnits(Id orderId) {
        // stub for demo purposes; real implementation queries Acme_Order__c
        // line items against on-hand warehouse inventory
        return 0;
    }
}

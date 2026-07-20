/**
 * Node 3 of the order-validation cycle: once a backorder is cleared with the
 * supplier, revalidation is kicked back off through AcmeOrderValidator,
 * closing the three-class cycle.
 */
public class AcmeBackorderResolver {

    public static Boolean resolve(Id orderId, Integer cycleDepth) {
        Boolean backorderCleared = attemptSupplierReplenish(orderId);
        if (backorderCleared) {
            return AcmeOrderValidator.validate(orderId, cycleDepth);
        }
        return false;
    }

    private static Boolean attemptSupplierReplenish(Id orderId) {
        // stub for demo purposes; real implementation calls the supplier
        // replenishment API and waits for a confirmation callback
        return true;
    }
}

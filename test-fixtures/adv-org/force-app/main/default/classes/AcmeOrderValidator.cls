/**
 * Node 1 of the order-validation cycle: validate -> checkStock -> resolve ->
 * validate. cycleDepth guards against runaway recursion on pathological data.
 */
public class AcmeOrderValidator {

    public static Boolean validate(Id orderId, Integer cycleDepth) {
        if (orderId == null) {
            throw new AcmeValidationException('Order Id is required for validation.');
        }
        if (cycleDepth != null && cycleDepth > 3) {
            System.debug('Max validation cycle depth reached for order: ' + orderId);
            return false;
        }
        Integer nextDepth = cycleDepth == null ? 1 : cycleDepth + 1;
        return AcmeInventoryChecker.checkStock(orderId, nextDepth);
    }

    public static Boolean validate(Id orderId) {
        return validate(orderId, 0);
    }
}

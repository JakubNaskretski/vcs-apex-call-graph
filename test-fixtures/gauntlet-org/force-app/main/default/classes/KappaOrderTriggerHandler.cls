public class KappaOrderTriggerHandler extends KappaTriggerHandler {

    public override void afterInsert() {
        validateNewOrders();
    }

    public override void afterUpdate() {
        reconcileOrders();
    }

    private void validateNewOrders() {
        System.debug('kappa order validation');
    }

    private void reconcileOrders() {
        System.debug('kappa order reconciliation');
    }
}

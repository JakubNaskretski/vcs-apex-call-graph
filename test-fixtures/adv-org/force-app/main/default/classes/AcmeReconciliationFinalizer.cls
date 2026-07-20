/**
 * v0.4 corpus fixture for F5 entry-kind detection: implements
 * System.Finalizer, so execute() should be tagged with the
 * 'Finalizer (async)' entry.
 */
public class AcmeReconciliationFinalizer implements System.Finalizer {

    public void execute(System.FinalizerContext ctx) {
        System.debug('Reconciliation finalizer executed with result: ' + ctx.getResult());
    }
}

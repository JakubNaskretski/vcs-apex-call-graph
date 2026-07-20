/**
 * v0.7 corpus fixture (multi-package awareness): a SECOND, unrelated class
 * named AcmeOrderUtil, distinct from
 * force-app/main/default/classes/AcmeOrderUtil.cls (the default package).
 * Same qualified name, deliberately DIFFERENT methods -- this is the
 * "duplicate class name across packages" fixture the corpus was asked to
 * add. A caller inside pkg-billing referencing AcmeOrderUtil must resolve
 * to THIS class via the same-package preference rule, never to force-app's,
 * even though force-app is the default package (see MANIFEST v0.7 package
 * matrix). This class intentionally does NOT declare normalize/
 * markApproved/buildQuery -- those stay exclusive to force-app's
 * AcmeOrderUtil.
 */
public with sharing class AcmeOrderUtil {

    public static void reconcileBillingStatus(Id orderId) {
        System.debug('Reconciling billing status for order: ' + orderId);
    }

    public static void applyLateFee(Id orderId) {
        System.debug('Applying late fee for order: ' + orderId);
    }
}

/**
 * v0.7 corpus fixture: billing package's own NovaBillingUtil. A SECOND,
 * unrelated class of the exact same qualified name also lives at
 * pkg-shared/main/default/classes/NovaBillingUtil.cls. Neither package is
 * the default package, so a caller that lives in a package declaring
 * NEITHER candidate (force-app) cannot disambiguate via the same-package
 * rule OR the default-package rule -- auditPricingSync() is the shared
 * method name that makes that ambiguous fan-out concrete (see MANIFEST
 * v0.7 package matrix).
 */
public with sharing class NovaBillingUtil {

    public static String formatInvoiceNumber(Id orderId) {
        return 'INV-' + orderId;
    }

    public static void logCompletion() {
        System.debug('Billing batch completion logged.');
    }

    public static void auditPricingSync(Id orderId) {
        System.debug('pkg-billing audit of pricing sync for: ' + orderId);
    }
}

/**
 * v0.7 corpus fixture: the SECOND half of the cross-package NovaBillingUtil
 * duplicate pair -- unrelated to
 * pkg-billing/main/default/classes/NovaBillingUtil.cls beyond sharing a
 * qualified name. Also declares auditPricingSync(), the shared method name
 * the ambiguous fan-out call site (in force-app) resolves onto, alongside
 * pkg-billing's candidate (see MANIFEST v0.7 package matrix).
 */
public with sharing class NovaBillingUtil {

    public static void auditPricingSync(Id orderId) {
        System.debug('pkg-shared audit of pricing sync for: ' + orderId);
    }

    public static void flagSharedDiscrepancy(Id orderId) {
        System.debug('Flagging shared discrepancy for order: ' + orderId);
    }
}

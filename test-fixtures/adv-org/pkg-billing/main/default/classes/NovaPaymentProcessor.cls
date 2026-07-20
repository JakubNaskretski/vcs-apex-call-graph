/**
 * v0.7 corpus fixture: billing package's payment entry point.
 * processPayment() calls NovaBillingService (same package), then
 * AcmeOrderUtil.reconcileBillingStatus() -- since pkg-billing declares its
 * OWN AcmeOrderUtil (a duplicate qualified name of the force-app class of
 * the same name), this call must resolve to pkg-billing's candidate via the
 * same-package preference rule, never force-app's, even though force-app is
 * the default package (see MANIFEST v0.7 package matrix).
 */
public with sharing class NovaPaymentProcessor {

    public static void processPayment(Id orderId, Decimal amount) {
        NovaBillingService.generateInvoice(orderId);
        AcmeOrderUtil.reconcileBillingStatus(orderId);
    }
}

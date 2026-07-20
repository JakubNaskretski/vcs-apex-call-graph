/**
 * v0.7 corpus fixture: billing package's invoice assembly helper, called
 * only from NovaBillingService within the same package (pkg-billing) --
 * an ordinary same-package call, unaffected by the duplicate-name/ambiguity
 * fixtures elsewhere in this package.
 */
public with sharing class NovaInvoiceGenerator {

    public static String build(Id orderId) {
        return NovaBillingUtil.formatInvoiceNumber(orderId);
    }
}

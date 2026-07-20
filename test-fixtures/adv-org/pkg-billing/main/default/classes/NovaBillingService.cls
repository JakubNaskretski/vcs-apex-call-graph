/**
 * v0.7 corpus fixture (multi-package awareness): billing package's service
 * entry point. generateInvoice() is the "billing calling core" half of the
 * bidirectional cross-package fixture -- it calls
 * AcmeOrderService.recalculatePricing() in force-app (the default package),
 * then hands off to NovaInvoiceGenerator within its own package (pkg-billing).
 * recordBatchCompletion() is the target of the "core calling billing" half:
 * AcmeOrderBatchProcessor.finish() in force-app calls back into this method
 * (see MANIFEST v0.7 package matrix).
 */
public with sharing class NovaBillingService {

    public static void generateInvoice(Id orderId) {
        AcmeOrderService.recalculatePricing(orderId);
        NovaInvoiceGenerator.build(orderId);
    }

    public static void recordBatchCompletion() {
        NovaBillingUtil.logCompletion();
    }
}

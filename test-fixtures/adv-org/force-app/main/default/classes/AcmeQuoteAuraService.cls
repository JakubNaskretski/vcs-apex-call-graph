/**
 * @AuraEnabled quote service backing 3 LWC bundles:
 *  - acmeOrderDashboard  (wire)       -> getRecentQuotes
 *  - acmeQuoteWizard     (imperative) -> createQuote
 *  - acmeInvoiceViewer   (wire + imperative) -> getInvoiceSummary / recalculateInvoice
 * submitForApproval() is the approval-kickoff entry point, fanning a
 * notice out through AcmeNotificationDispatcher.
 */
public with sharing class AcmeQuoteAuraService {

    @AuraEnabled(cacheable=true)
    public static List<Acme_Quote__c> getRecentQuotes() {
        return [
            SELECT Id, Name, Acme_Status__c
            FROM Acme_Quote__c
            ORDER BY CreatedDate DESC
            LIMIT 20
        ];
    }

    @AuraEnabled
    public static Id createQuote(String quoteName) {
        AcmeQuoteBuilder builder = new AcmeQuoteBuilder();
        AcmeQuote quote = builder.withCustomer(quoteName).build();
        return quote.quoteId;
    }

    @AuraEnabled
    public static AcmeInvoice getInvoiceSummary(Id quoteId) {
        AcmeQuote quote = new AcmeQuote();
        quote.quoteId = quoteId;
        return quote.toInvoice();
    }

    @AuraEnabled
    public static Decimal recalculateInvoice(Id quoteId) {
        AcmeQuote quote = new AcmeQuote();
        quote.quoteId = quoteId;
        AcmeInvoice invoice = quote.toInvoice();
        return invoice.total();
    }

    @AuraEnabled
    public static void submitForApproval(Id quoteId) {
        new AcmeNotificationDispatcher().dispatchToAll('Quote submitted for approval: ' + quoteId);
    }
}

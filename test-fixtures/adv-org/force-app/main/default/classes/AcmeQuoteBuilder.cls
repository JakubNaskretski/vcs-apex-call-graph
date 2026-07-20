/**
 * Fluent assembly of an AcmeQuote. Each line item is priced through
 * AcmePricingEngine, and build() prices the finished quote (including
 * freight) through the same engine's AcmeQuote overload.
 */
public class AcmeQuoteBuilder {

    private AcmeQuote workingQuote;

    public AcmeQuoteBuilder() {
        this.workingQuote = new AcmeQuote();
    }

    public AcmeQuoteBuilder withCustomer(String customerName) {
        workingQuote.customerName = customerName;
        return this;
    }

    public AcmeQuoteBuilder withLineItem(String skuCode, Integer quantity) {
        Decimal unitPrice = AcmePricingEngine.calculatePrice(skuCode);
        Decimal tierMultiplier = AcmePricingEngine.calculatePrice(quantity);
        Decimal lineAmount = (unitPrice * quantity * tierMultiplier).setScale(2);
        workingQuote.addLineAmount(lineAmount);
        return this;
    }

    public AcmeQuoteBuilder withDiscount(Decimal discountPercent) {
        workingQuote.discountPercent = discountPercent;
        return this;
    }

    public AcmeQuote build() {
        workingQuote.freightAdjustedTotal = AcmePricingEngine.calculatePrice(workingQuote);
        return workingQuote;
    }
}

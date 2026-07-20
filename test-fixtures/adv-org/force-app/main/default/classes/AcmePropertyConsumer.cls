/**
 * Exercises AcmeQuote.Status and AcmeQuote.TotalAmount property access from a
 * separate compilation unit so access sites resolve back to the accessor bodies.
 */
public class AcmePropertyConsumer {

    public static Decimal reviewQuoteTotal(String customerName) {
        AcmeQuote quote = new AcmeQuote(customerName);
        quote.Status = 'Submitted';
        Decimal total = quote.TotalAmount;
        return total;
    }

    public void syncQuoteStatus(AcmeQuote quote, String newStatus) {
        quote.Status = newStatus;
        System.debug('Quote total after status sync: ' + quote.TotalAmount);
    }

    public Boolean isQuoteOverThreshold(AcmeQuote quote, Decimal threshold) {
        return quote.TotalAmount > threshold;
    }
}

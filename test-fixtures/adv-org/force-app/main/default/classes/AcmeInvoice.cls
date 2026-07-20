/**
 * Invoice domain model. Instances are normally produced via AcmeQuote.toInvoice()
 * once a quote reaches an invoiceable status.
 */
public class AcmeInvoice {

    public Id relatedQuoteId;
    public String customerName;
    public Decimal invoiceAmount;
    public Date invoiceDate;

    public AcmeInvoice(Id relatedQuoteId, String customerName, Decimal invoiceAmount) {
        this.relatedQuoteId = relatedQuoteId;
        this.customerName = customerName;
        this.invoiceAmount = invoiceAmount;
        this.invoiceDate = Date.today();
    }

    public Decimal total() {
        return invoiceAmount == null ? 0 : invoiceAmount.setScale(2);
    }
}

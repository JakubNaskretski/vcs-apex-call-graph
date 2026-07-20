/**
 * Core quote domain model for Acme Manufacturing quote-to-cash.
 * Status and TotalAmount are exposed as properties so that validation and
 * total calculation stay centralized no matter which caller mutates the quote.
 */
public class AcmeQuote {

    public static final Set<String> VALID_STATUSES = new Set<String>{
        'Draft', 'Submitted', 'Approved', 'Rejected', 'Closed'
    };

    public Id quoteId;
    public String customerName;
    public List<Decimal> lineAmounts;
    public Decimal discountPercent;
    public Decimal freightAdjustedTotal;

    private String status;
    private Decimal cachedTotal;
    private Boolean totalIsDirty;

    public AcmeQuote() {
        this.status = 'Draft';
        this.lineAmounts = new List<Decimal>();
        this.discountPercent = 0;
        this.totalIsDirty = true;
    }

    public AcmeQuote(String customerName) {
        this();
        this.customerName = customerName;
    }

    public String Status {
        get { return status; }
        set {
            validateStatusTransition(value);
            status = value;
        }
    }

    public Decimal TotalAmount {
        get {
            if (totalIsDirty || cachedTotal == null) {
                cachedTotal = calculateTotal();
                totalIsDirty = false;
            }
            return cachedTotal;
        }
        set {
            cachedTotal = value;
            totalIsDirty = false;
        }
    }

    private void validateStatusTransition(String newStatus) {
        if (newStatus == null || !VALID_STATUSES.contains(newStatus)) {
            throw new AcmeQuoteException('Invalid quote status: ' + newStatus);
        }
        if (status == 'Closed' && newStatus != 'Closed') {
            throw new AcmeQuoteException('Cannot transition a Closed quote to ' + newStatus);
        }
    }

    private Decimal calculateTotal() {
        Decimal sum = 0;
        for (Decimal lineAmount : lineAmounts) {
            sum += lineAmount == null ? 0 : lineAmount;
        }
        if (discountPercent != null && discountPercent > 0) {
            sum = sum * (1 - (discountPercent / 100));
        }
        return sum.setScale(2);
    }

    public void addLineAmount(Decimal amount) {
        lineAmounts.add(amount);
        totalIsDirty = true;
    }

    public AcmeInvoice toInvoice() {
        return new AcmeInvoice(this.quoteId, this.customerName, this.TotalAmount);
    }

    public class AcmeQuoteException extends Exception {}
}

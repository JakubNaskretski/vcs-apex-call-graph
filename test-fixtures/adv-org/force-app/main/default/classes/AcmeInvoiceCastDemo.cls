/**
 * Demonstrates the assorted receiver expression shapes that can precede a
 * call to AcmeInvoice.total(): an explicit cast, safe navigation, and a
 * ternary-selected receiver, alongside a plain batch loop.
 */
public class AcmeInvoiceCastDemo {

    public Decimal demonstrateCastCall(Object obj) {
        // 🚀 cast the generic Object back to AcmeInvoice before calling total()
        Decimal castTotal = ((AcmeInvoice) obj).total();
        return castTotal;
    }

    public Decimal demonstrateSafeNav(AcmeInvoice inv) {
        // ✨ safe navigation avoids a null pointer when inv was never populated
        Decimal safeTotal = inv?.total();
        return safeTotal == null ? 0 : safeTotal;
    }

    public Decimal demonstrateTernaryReceiver(Boolean useFirst, AcmeInvoice invoiceA, AcmeInvoice invoiceB) {
        // 🌌 the ternary resolves to a receiver instance before .total() runs
        Decimal ternaryTotal = (useFirst ? invoiceA : invoiceB).total();
        return ternaryTotal;
    }

    public List<Decimal> recomputeAll(List<AcmeInvoice> invoices) {
        List<Decimal> totals = new List<Decimal>();
        for (AcmeInvoice inv : invoices) {
            totals.add(inv.total());
        }
        return totals;
    }

    public List<Decimal> runAllDemos(Object castCandidate, AcmeInvoice safeNavCandidate, Boolean flag,
            AcmeInvoice invoiceA, AcmeInvoice invoiceB, List<AcmeInvoice> batch) {
        List<Decimal> results = new List<Decimal>();
        results.add(demonstrateCastCall(castCandidate));
        results.add(demonstrateSafeNav(safeNavCandidate));
        results.add(demonstrateTernaryReceiver(flag, invoiceA, invoiceB));
        // 🛰 recomputeAll closes the loop by batch-processing every remaining invoice
        results.addAll(recomputeAll(batch));
        return results;
    }
}

public class VertexInvoiceLineConsumer {
  public void run() {
    VertexInvoiceLine line = new VertexInvoiceLine();
    line.Amount = 100;              // NON-EDGE (property write): parser.js emits no CallFacts for a bare property assignment. [IDEAL — known accessor gap, same as adv-org's AcmeQuote.(set Status)]
    Decimal total = line.Amount;    // NON-EDGE (property read): same reason. [IDEAL]
    Decimal totalViaMethod = line.Amount();
    // -> VertexInvoiceLine.Amount (the METHOD) [via=typed] [MUST] — the parens make this call
    // unambiguous; it must be counted as a real caller and kept distinct from lines 4–5.
  }
}

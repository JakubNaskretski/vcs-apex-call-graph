// GAUNTLET v0.8 (namespace modeling, requirement 2c): a GENUINE local
// top-level class literally named like the fictional managed namespace
// token `zenq`. Distinct from classes/Billing.cls (which shadows only the
// bare tail of `zenq.Billing`) -- this class shadows the NAMESPACE SEGMENT
// itself. Declares exactly one inner class (Ledger) so precedence probes can
// contrast a Mid segment that DOES resolve on it (local must win) against
// one that does NOT (external must win, no false local edge). See
// ZenqLocalPrecedenceCaller.cls for the call sites and GROUND-TRUTH.md's
// v0.8 section for the exact expected resolution of each.
public class zenq {
  public class Ledger {
    public static void post(Decimal amount) {
      System.debug('local zenq.Ledger.post: ' + amount);
    }
  }
}

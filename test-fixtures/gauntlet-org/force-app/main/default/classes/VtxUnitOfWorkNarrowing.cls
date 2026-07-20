// GAUNTLET (v0.11 Round B / B2): generic-DML narrowing -- one method per
// CONTRACT sub-shape. `pending` is always a LOCAL variable declared
// `List<SObject>` (the generic sobject-collection shape the honest "DML on
// unresolved SObject type" marker exists for -- same declared-type shape
// as the pre-existing KappaUnitOfWork.commitWork's `records` local, which
// this fixture deliberately does NOT touch; see the v0.11 write-up for why
// that pre-existing method's zero-evidence outcome is itself a promoted
// regression check for this same contract).
public class VtxUnitOfWorkNarrowing {

    // MUST narrow to BOTH objects: two `.add(new Concrete__c(...))` calls
    // on `pending`, union = {Kappa_Order__c, Kappa_Shipment__c}. Marker
    // replaced by narrowed ~dml edges to both objects' triggers.
    public void commitBothTypes() {
        List<SObject> pending = new List<SObject>();
        pending.add(new Kappa_Order__c(Name = 'ord-1'));
        pending.add(new Kappa_Shipment__c(Name = 'shp-1'));
        insert pending;
    }

    // MUST narrow to Kappa_Order__c: `.addAll(typedOrders)` where
    // `typedOrders` is a local variable whose DECLARED type is
    // `List<Kappa_Order__c>` -- a concrete SObject-typed collection
    // resolvable via the type env, per the union's second evidence form.
    public void commitTypedOrdersViaAddAll() {
        List<SObject> pending = new List<SObject>();
        List<Kappa_Order__c> typedOrders = buildTypedOrders();
        pending.addAll(typedOrders);
        insert pending;
    }

    // MUST keep the honest marker, no edges: `pending` has ZERO
    // add/addAll calls anywhere in this method (it arrives pre-populated
    // from a helper), so there is no intra-method evidence to narrow from.
    // Uses `update` (not `insert`) deliberately, to prove the marker's
    // persistence is DML-verb-independent.
    public void commitWithNoInMethodEvidence() {
        List<SObject> pending = fetchPendingRecords();
        update pending;
    }

    // MUST NOT narrow from this evidence alone: the one `.add(...)` call
    // on `pending` is a method-call expression (`locateExistingOrder()`),
    // not a `new Concrete__c(...)` construction and not a simple
    // identifier resolvable via the type env -- cross-method evidence
    // (a called method's return type) is explicitly out of scope this
    // round, so this reduces to zero VALID evidence and the honest marker
    // stays.
    public void commitWithComplexExpressionEvidence() {
        List<SObject> pending = new List<SObject>();
        pending.add(locateExistingOrder());
        insert pending;
    }

    private List<Kappa_Order__c> buildTypedOrders() {
        return new List<Kappa_Order__c>();
    }

    private List<SObject> fetchPendingRecords() {
        return new List<SObject>();
    }

    private Kappa_Order__c locateExistingOrder() {
        return [SELECT Id FROM Kappa_Order__c LIMIT 1];
    }
}

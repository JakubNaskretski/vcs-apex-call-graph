// GAUNTLET (enterprise patterns, lens: unit-of-work register/commit,
// fflib_SObjectUnitOfWork shape). registerNew() buckets records by their
// RUNTIME Schema.SObjectType (from record.getSObjectType(), not a compile-
// time literal); commitWork() later fires DML generically over a
// List<SObject> pulled back out of that Map. The DML statement's own
// declared local type is the generic "List<SObject>", not any concrete
// object -- object identity is erased through the collection's declared
// type by the time DML actually runs, which is the specific shape under
// test here (contrast with insertDirect() below, a concretely-typed
// positive control).
public virtual class KappaUnitOfWork {

    private Map<Schema.SObjectType, List<SObject>> newRecordsByType = new Map<Schema.SObjectType, List<SObject>>();

    public void registerNew(SObject record) {
        Schema.SObjectType tkey = record.getSObjectType();
        if (!newRecordsByType.containsKey(tkey)) {
            newRecordsByType.put(tkey, new List<SObject>());
        }
        newRecordsByType.get(tkey).add(record);
    }

    public void commitWork() {
        for (Schema.SObjectType tkey : newRecordsByType.keySet()) {
            List<SObject> records = newRecordsByType.get(tkey);
            insert records;
        }
    }

    // Positive control: a concretely-typed DML site, to isolate the
    // generic-collection erasure above as the actual cause of any missed
    // trigger linkage (rather than e.g. a trigger-event mismatch or some
    // other unrelated corpus mistake).
    public void insertDirect(Kappa_Order__c order) {
        insert order;
    }
}

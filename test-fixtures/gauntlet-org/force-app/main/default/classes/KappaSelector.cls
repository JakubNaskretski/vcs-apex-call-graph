// GAUNTLET (enterprise patterns, lens: selector, fflib_SObjectSelector
// shape). getSObjectType()/getSelectFields() are virtual template hooks;
// selectById() is the base class's OWN template method that calls them via
// an implicit `this` -- the SAME self-dispatch shape as
// KappaTriggerHandler.run() calling its own virtual hooks. Kept deliberately
// parallel to that fixture so the same engine gap (or lack thereof) can be
// confirmed twice, in two different fflib layers, rather than trusting one
// single observation.
public virtual class KappaSelector {

    public virtual Schema.SObjectType getSObjectType() {
        return null;
    }

    public virtual List<String> getSelectFields() {
        return new List<String>{'Id'};
    }

    public List<SObject> selectById(Set<Id> ids) {
        String fieldList = String.join(getSelectFields(), ', ');
        String query = 'SELECT ' + fieldList + ' FROM ' + getSObjectType() + ' WHERE Id IN :ids';
        return Database.query(query);
    }
}

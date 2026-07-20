public class KappaSelectorConsumer {

    public List<SObject> viaChainedNew(Set<Id> ids) {
        return new KappaOrderSelector().selectById(ids);
    }

    public Schema.SObjectType viaBaseTypedLocal() {
        KappaSelector sel = new KappaOrderSelector();
        return sel.getSObjectType();
    }
}

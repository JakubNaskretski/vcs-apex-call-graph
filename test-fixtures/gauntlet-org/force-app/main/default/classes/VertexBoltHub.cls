public virtual class VertexBoltHub implements VertexBoltDispatchable {

    public virtual void dispatch(Kappa_Item__c item) {
        item.Status__c = 'Dispatched';
    }
}

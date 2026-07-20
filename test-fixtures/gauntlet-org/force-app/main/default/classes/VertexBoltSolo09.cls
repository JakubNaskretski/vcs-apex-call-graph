public class VertexBoltSolo09 {
    public void runDispatch(Kappa_Item__c item) {
        VertexBoltHub hub = new VertexBoltHub();
        hub.dispatch(item);
        hub.dispatch(item);
    }
}

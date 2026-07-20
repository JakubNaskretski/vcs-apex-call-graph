public class VertexBoltDecoy04 {
    public void handleDispatch(Kappa_Item__c item) {
        VertexBoltHub hub = new VertexBoltHub();
        hub.dispatch(item);
        hub.dispatch(item);
        hub.dispatch(item);
    }
}

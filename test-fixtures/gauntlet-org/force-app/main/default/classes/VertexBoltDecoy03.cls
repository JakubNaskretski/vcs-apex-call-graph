public class VertexBoltDecoy03 {
    public void handleDispatch(Kappa_Item__c item) {
        VertexBoltHub hub = new VertexBoltHub();
        hub.dispatch(item);
        hub.dispatch(item);
    }
}

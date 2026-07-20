public class VertexBoltRouter {
    public void route(VertexBoltDispatchable hub, Kappa_Item__c item) {
        hub.dispatch(item);
    }
}

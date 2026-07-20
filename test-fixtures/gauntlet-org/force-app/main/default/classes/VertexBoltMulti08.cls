public class VertexBoltMulti08 {
    public void runAlpha(Kappa_Item__c item) {
        VertexBoltHub hub = new VertexBoltHub();
        hub.dispatch(item);
        hub.dispatch(item);
        hub.dispatch(item);
    }

    public void runBeta(Kappa_Item__c item) {
        VertexBoltHub hub = new VertexBoltHub();
        hub.dispatch(item);
        hub.dispatch(item);
        hub.dispatch(item);
        hub.dispatch(item);
    }

    public void runGamma(Kappa_Item__c item) {
        VertexBoltHub hub = new VertexBoltHub();
        hub.dispatch(item);
        hub.dispatch(item);
        hub.dispatch(item);
        hub.dispatch(item);
        hub.dispatch(item);
    }
}

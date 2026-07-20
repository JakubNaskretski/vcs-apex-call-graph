@isTest
public class VertexBoltMulti01 {
    @isTest
    static void runAlpha() {
        VertexBoltHub hub = new VertexBoltHub();
        Kappa_Item__c item = new Kappa_Item__c();
        hub.dispatch(item);
        hub.dispatch(item);
    }

    public void runBeta(Kappa_Item__c item) {
        VertexBoltHub hub = new VertexBoltHub();
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
    }
}

@isTest
public class VertexBoltSolo05 {
    @isTest
    static void testDispatch() {
        VertexBoltHub hub = new VertexBoltHub();
        Kappa_Item__c item = new Kappa_Item__c();
        hub.dispatch(item);
        hub.dispatch(item);
    }
}

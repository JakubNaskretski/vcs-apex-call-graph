public with sharing class VertexBoltSolo01 {
    @AuraEnabled
    public static void runDispatch(Kappa_Item__c item) {
        VertexBoltHub hub = new VertexBoltHub();
        hub.dispatch(item);
        hub.dispatch(item);
    }
}

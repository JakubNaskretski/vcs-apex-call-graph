public class VertexBoltItemTriggerHandler {

    public void handleAfterInsert(List<Kappa_Item__c> items) {
        VertexBoltHub hub = new VertexBoltHub();
        for (Kappa_Item__c item : items) {
            hub.dispatch(item);
        }
    }

    public void handleAfterUpdate(List<Kappa_Item__c> items) {
        VertexBoltHub hub = new VertexBoltHub();
        for (Kappa_Item__c item : items) {
            hub.dispatch(item);
        }
    }
}

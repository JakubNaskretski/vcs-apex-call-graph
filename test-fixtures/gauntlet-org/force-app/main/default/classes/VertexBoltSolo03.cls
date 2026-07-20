public class VertexBoltSolo03 {
    @InvocableMethod(label='Bolt Dispatch 03')
    public static void runDispatch(List<Kappa_Item__c> items) {
        VertexBoltHub hub = new VertexBoltHub();
        for (Kappa_Item__c item : items) {
        hub.dispatch(item);
        hub.dispatch(item);
        hub.dispatch(item);
        hub.dispatch(item);
        }
    }
}

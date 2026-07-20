global class VertexBoltSolo04 implements Schedulable {
    global void execute(SchedulableContext sc) {
        VertexBoltHub hub = new VertexBoltHub();
        Kappa_Item__c item = new Kappa_Item__c();
        hub.dispatch(item);
        hub.dispatch(item);
        hub.dispatch(item);
        hub.dispatch(item);
        hub.dispatch(item);
    }
}

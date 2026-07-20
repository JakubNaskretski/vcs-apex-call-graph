global class VertexBoltNightlyRelayJob implements Schedulable {
    global void execute(SchedulableContext sc) {
        Kappa_Item__c item = new Kappa_Item__c();
        VertexBoltSolo01.runDispatch(item);
    }
}

trigger VertexBoltItemTrigger on Kappa_Item__c (after insert, after update) {
    VertexBoltItemTriggerHandler handler = new VertexBoltItemTriggerHandler();
    if (Trigger.isInsert) {
        handler.handleAfterInsert(Trigger.new);
    }
    if (Trigger.isUpdate) {
        handler.handleAfterUpdate(Trigger.new);
    }
}

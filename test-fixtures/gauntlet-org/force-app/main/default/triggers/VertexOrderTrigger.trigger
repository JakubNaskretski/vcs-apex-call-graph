trigger VertexOrderTrigger on Vertex_Order__c (after update, after insert) {
  VertexOrderTriggerHandler handler = new VertexOrderTriggerHandler();
  if (Trigger.isUpdate) {
    handler.handleAfterUpdate(Trigger.new);
  }
  if (Trigger.isInsert) {
    handler.handleAfterInsert(Trigger.new);
  }
}

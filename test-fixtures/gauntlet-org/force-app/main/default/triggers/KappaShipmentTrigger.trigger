// GAUNTLET (v0.11 Round B / B2): registers a real trigger on
// Kappa_Shipment__c so VtxUnitOfWorkNarrowing.commitBothTypes's narrowed
// DML evidence has a genuine second object to fan out to, alongside the
// pre-existing Kappa_Order__c triggers (KappaOrderTrigger,
// KappaOrderUowTrigger). Kappa_Shipment__c already exists as a plain
// param-type token in this corpus (VertexKappaShipmentHub.cls,
// VertexKappaShipmentCaller.cls) -- this is its first DML/trigger linkage.
trigger KappaShipmentTrigger on Kappa_Shipment__c (before insert, after insert) {
    System.debug('kappa shipment trigger fired');
}

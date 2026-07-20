// GAUNTLET: exists purely so triggersByObject has a real trigger registered
// on Kappa_Order__c to test whether KappaUnitOfWork.commitWork's generically
// typed `insert records` DML (List<SObject>, not List<Kappa_Order__c>)
// reaches it.
trigger KappaOrderUowTrigger on Kappa_Order__c (after insert) {
    System.debug('kappa order uow trigger fired');
}

trigger KappaOrderTrigger on Kappa_Order__c (before insert, after insert, after update) {
    new KappaGenericTriggerDispatcher().dispatch('Kappa_Order__c');
}

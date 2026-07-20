/**
 * v0.5 corpus fixture for G5 (async-hop edges): a single orchestrator that
 * exercises all three async entry points in one place, each with an
 * inline `new` constructor argument so the resolver's async-hop rule has
 * something to land on. Reuses existing async classes from the v0.3/v0.4
 * corpus (AcmeShipmentQueueableDispatcher, AcmeOrderBatchProcessor,
 * AcmeNightlyReconciliationScheduler) rather than declaring new ones.
 */
public with sharing class AcmeAsyncOrchestrator {

    public static void runNightlyMaintenance() {
        System.enqueueJob(new AcmeShipmentQueueableDispatcher(new List<Acme_Shipment__c>()));
        Database.executeBatch(new AcmeOrderBatchProcessor(), 200);
        System.schedule('AcmeNightly', '0 0 3 * * ?', new AcmeNightlyReconciliationScheduler());
    }
}

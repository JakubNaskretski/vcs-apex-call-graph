/**
 * Schedulable that kicks off a fresh AcmeOrderBatchProcessor run every
 * night. Scheduled via System.schedule() from AcmeOrderServiceTest for
 * coverage; a real deployment would register it via Setup > Scheduled Jobs
 * or an admin-facing scheduling utility.
 */
public with sharing class AcmeNightlyReconciliationScheduler implements Schedulable {

    public void execute(SchedulableContext sc) {
        Database.executeBatch(new AcmeOrderBatchProcessor());
    }
}

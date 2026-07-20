public class WorkerServiceBatch implements Database.Batchable<SObject> {

    public List<SObject> start(Database.BatchableContext bc) {
        return new List<Account>();
    }

    public void execute(Database.BatchableContext bc, List<SObject> scope) {
        WorkerService.process(scope[0].Id, scope.size());
    }

    public void finish(Database.BatchableContext bc) {
    }
}

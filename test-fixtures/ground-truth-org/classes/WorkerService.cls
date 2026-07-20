public class WorkerService {

    public WorkerService() {
    }

    @AuraEnabled
    public void process(Id recordId, Integer qty) {
        CallerOne c = new CallerOne();
        c.run();
    }

    public static void unused() {
    }
}

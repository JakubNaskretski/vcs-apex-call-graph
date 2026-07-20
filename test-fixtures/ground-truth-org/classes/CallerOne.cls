public class CallerOne {

    public void run() {
        WorkerService svc = new WorkerService();
        svc.process('001000000000001', 3);
    }
}

public class CallerTwo {

    public void runStatic() {
        WorkerService.process('001000000000002', 7);
    }

    public void runBadArity() {
        WorkerService.process(1);
    }
}

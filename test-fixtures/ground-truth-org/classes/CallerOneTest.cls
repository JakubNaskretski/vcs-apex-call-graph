@isTest
public class CallerOneTest {

    @isTest
    static void testProcess() {
        WorkerService svc = new WorkerService();
        svc.process('001000000000003', 1);
    }
}

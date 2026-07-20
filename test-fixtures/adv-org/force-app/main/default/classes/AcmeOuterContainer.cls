/**
 * Outer/inner pairing used to exercise inner-class instantiation and the
 * inner-to-outer static callback.
 */
public class AcmeOuterContainer {

    public String containerLabel;

    public AcmeOuterContainer(String containerLabel) {
        this.containerLabel = containerLabel;
    }

    public String kickOff(String jobName) {
        InnerWorker worker = new InnerWorker(jobName);
        return worker.doWork();
    }

    public static String outerHelper(String jobName) {
        return 'Completed job: ' + jobName + ' at ' + String.valueOf(Datetime.now());
    }

    public class InnerWorker {
        private String jobName;

        public InnerWorker(String jobName) {
            this.jobName = jobName;
        }

        public String doWork() {
            return AcmeOuterContainer.outerHelper(jobName);
        }
    }
}

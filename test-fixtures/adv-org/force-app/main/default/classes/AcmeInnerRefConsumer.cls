/**
 * Cross-file consumer of AcmeOuterContainer.InnerWorker, referenced via its
 * fully qualified Outer.Inner type name.
 */
public class AcmeInnerRefConsumer {

    public String runExternalJob(String jobName) {
        AcmeOuterContainer.InnerWorker worker = new AcmeOuterContainer.InnerWorker(jobName);
        return worker.doWork();
    }
}

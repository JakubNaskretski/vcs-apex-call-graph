/**
 * v0.4 corpus fixture for List<T> subscript/`.get(i)` generic receiver
 * resolution (F2): a concrete (non-interface) step type, only ever reached
 * through a List<AcmeStep> receiver in AcmeStepDispatcher.
 */
public class AcmeStep {

    public String stepName;

    public AcmeStep(String stepName) {
        this.stepName = stepName;
    }

    public void run() {
        System.debug('Running step ' + stepName);
    }
}

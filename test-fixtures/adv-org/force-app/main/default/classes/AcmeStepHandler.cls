/**
 * v0.4 corpus fixture for collection-generic receiver resolution (F2):
 * dispatch contract implemented by AcmeValidateStepHandler and
 * AcmeNotifyStepHandler, reached only through a Map<String,AcmeStepHandler>
 * receiver in AcmeStepDispatcher (never called directly by name), so any
 * caller edge into handleStep() only exists if the resolver can resolve
 * the Map<K,V> generic receiver first.
 */
public interface AcmeStepHandler {
    void handleStep(Acme_Order__c order);
}

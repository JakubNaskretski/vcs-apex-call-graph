/**
 * v0.4 corpus fixture for collection-generic receiver resolution (F2).
 * Exercises, in one class:
 *   - a Map<String, AcmeStepHandler> field with `.get(key).handleStep(...)`
 *     (Map<K,V>.get() -> V, then chained)
 *   - a List<AcmeStep> field with `[0].run()` (subscript -> T)
 *   - the same List<AcmeStep> field with `.get(i).run()` (List<T>.get() -> T)
 *   - a `.values()` loop over the same Map (Map<K,V>.values() -> List<V>,
 *     iterated in a for-each so the loop variable itself is the chainable
 *     receiver)
 */
public with sharing class AcmeStepDispatcher {

    private Map<String, AcmeStepHandler> handlersByKey;
    private List<AcmeStep> steps;

    public AcmeStepDispatcher() {
        handlersByKey = new Map<String, AcmeStepHandler>();
        handlersByKey.put('validate', new AcmeValidateStepHandler());
        handlersByKey.put('notify', new AcmeNotifyStepHandler());
        steps = new List<AcmeStep>{ new AcmeStep('prepare'), new AcmeStep('finalize') };
    }

    public void dispatch(String key, Acme_Order__c order) {
        handlersByKey.get(key).handleStep(order);
    }

    public void runFirstStep() {
        steps[0].run();
    }

    public void runStepAt(Integer i) {
        steps.get(i).run();
    }

    public void runAllHandlers(Acme_Order__c order) {
        for (AcmeStepHandler handler : handlersByKey.values()) {
            handler.handleStep(order);
        }
    }
}

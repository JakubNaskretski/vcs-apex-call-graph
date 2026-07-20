// GAUNTLET (enterprise patterns, lens: dependency injection via constructor
// interface param). The `notifier` FIELD's declared type is the interface
// KappaNotifier -- whichever concrete implementer was actually passed into
// THIS constructor call is never tracked; the field's static declared type
// is all the resolver ever sees at the notify() call site below.
public class KappaOrderProcessor {

    private KappaNotifier notifier;

    public KappaOrderProcessor(KappaNotifier notifier) {
        this.notifier = notifier;
    }

    public void process(String orderSummary) {
        notifier.notify(orderSummary);
    }
}

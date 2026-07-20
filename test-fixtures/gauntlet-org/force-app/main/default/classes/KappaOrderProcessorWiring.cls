// GAUNTLET: this is the ONLY construction site of KappaOrderProcessor in the
// whole corpus, and it only ever wires KappaEmailNotifier -- KappaSmsNotifier
// is never actually injected into a KappaOrderProcessor anywhere. Whether
// the engine's interface fan-out at notifier.notify() (in
// KappaOrderProcessor.process) reports BOTH implementers regardless is the
// precision question this fixture pair is built to answer.
public class KappaOrderProcessorWiring {

    public void run(String orderSummary) {
        KappaOrderProcessor processor = new KappaOrderProcessor(new KappaEmailNotifier());
        processor.process(orderSummary);
    }
}

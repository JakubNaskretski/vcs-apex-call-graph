// GAUNTLET: registered in KappaServiceLocator under a DIFFERENT key
// ('LegacyOrderService') than the one KappaServiceLocatorConsumer actually
// looks up ('OrderService') -- exists to show that the interface fan-out at
// the consumer's svc.process() call site is blind to the string key and
// reports BOTH implementers regardless of which one the locator would
// actually return for that key.
public class KappaLegacyOrderServiceImpl implements KappaOrderServiceInterface {

    public void process(Id orderId) {
        System.debug('kappa legacy processing order ' + orderId);
    }
}

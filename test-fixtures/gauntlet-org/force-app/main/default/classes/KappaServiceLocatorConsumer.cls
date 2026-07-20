public class KappaServiceLocatorConsumer {

    public void run(Id orderId) {
        KappaOrderServiceInterface svc = (KappaOrderServiceInterface) KappaServiceLocator.get('OrderService');
        svc.process(orderId);
    }
}

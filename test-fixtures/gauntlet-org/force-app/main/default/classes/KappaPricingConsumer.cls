public class KappaPricingConsumer {

    public Decimal run(Id orderId) {
        KappaPricingService svc = (KappaPricingService) KappaApplication.Service.newInstance(KappaPricingService.class);
        return svc.calculatePrice(orderId);
    }
}

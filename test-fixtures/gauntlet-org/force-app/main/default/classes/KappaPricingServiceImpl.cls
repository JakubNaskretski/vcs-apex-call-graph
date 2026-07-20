public class KappaPricingServiceImpl implements KappaPricingService {

    public Decimal calculatePrice(Id orderId) {
        return applyDiscount(orderId);
    }

    private Decimal applyDiscount(Id orderId) {
        return 100;
    }
}

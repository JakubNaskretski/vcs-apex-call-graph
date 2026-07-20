/**
 * Discount-tier utility. The tier table is built once via a static
 * initializer so both synchronous quoting code and async invocables share
 * a single warm lookup.
 */
public class AcmeDiscountUtil {

    private static Map<String, Decimal> discountTiers;

    static {
        discountTiers = initializeDiscountTiers();
    }

    private static Map<String, Decimal> initializeDiscountTiers() {
        Map<String, Decimal> tiers = new Map<String, Decimal>();
        tiers.put('BRONZE', 0.02);
        tiers.put('SILVER', 0.05);
        tiers.put('GOLD', 0.08);
        tiers.put('PLATINUM', 0.12);
        return tiers;
    }

    public static Decimal applyDiscount(Decimal amount, String tierName) {
        if (amount == null || tierName == null) {
            return amount;
        }
        Decimal rate = discountTiers.get(tierName.toUpperCase());
        if (rate == null) {
            return amount;
        }
        return (amount * (1 - rate)).setScale(2);
    }
}

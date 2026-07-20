/**
 * Overloaded pricing entry point used across quoting and order automation.
 * Each overload prices a different unit of work: a raw SKU lookup, a
 * quantity-break multiplier, an already-posted order, or a fully assembled
 * quote (which additionally prices freight via the packaging-shape hierarchy).
 */
public class AcmePricingEngine {

    private static final Decimal FREIGHT_RATE = 0.85;

    private static final Map<String, Decimal> SKU_PRICE_TABLE = new Map<String, Decimal>{
        'BOLT-001' => 4.25,
        'BOLT-002' => 6.10,
        'GEAR-100' => 128.50,
        'PLATE-STD' => 22.75,
        'BRACKET-9' => 3.40
    };

    public static Decimal calculatePrice(String skuCode) {
        if (skuCode == null) {
            return 0;
        }
        Decimal basePrice = SKU_PRICE_TABLE.get(skuCode);
        return basePrice == null ? 0 : basePrice;
    }

    public static Decimal calculatePrice(Integer quantity) {
        if (quantity == null || quantity <= 0) {
            return 1.0;
        }
        if (quantity >= 500) {
            return 0.72;
        } else if (quantity >= 100) {
            return 0.85;
        } else if (quantity >= 25) {
            return 0.93;
        }
        return 1.0;
    }

    public static Decimal calculatePrice(Acme_Order__c order) {
        if (order == null) {
            return 0;
        }
        Decimal baseAmount = order.Amount__c == null ? 0 : order.Amount__c;
        Integer lineCount = order.LineItemCount__c == null ? 0 : order.LineItemCount__c.intValue();
        Decimal tierMultiplier = calculatePrice(lineCount);
        return (baseAmount * tierMultiplier).setScale(2);
    }

    public static Decimal calculatePrice(AcmeQuote quote) {
        if (quote == null) {
            return 0;
        }
        AcmeShapeConcrete crate = new AcmeShapeConcrete(quote.lineAmounts.size(), 12.0, 8.0, 6.0);
        Decimal volume = crate.computeVolume();
        Decimal surcharge = crate.surchargeFactor();
        Decimal freight = (volume * surcharge * FREIGHT_RATE).setScale(2);
        return quote.TotalAmount + freight;
    }
}

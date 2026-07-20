/**
 * @InvocableMethod taking a wrapper Request (quoteId, promoCode) rather than
 * a bulk primitive list, since a discount approval needs two correlated
 * inputs per row. Applies the promo discount to the order's amount, then
 * recalculates pricing on top of the discounted figure.
 */
public with sharing class AcmeDiscountApprovalInvocable {

    public class Request {
        @InvocableVariable(label='Quote Id' required=true)
        public Id quoteId;

        @InvocableVariable(label='Promo Code')
        public String promoCode;
    }

    @InvocableMethod(label='Apply Acme Discount Approval' description='Applies a promo code discount to an order and recalculates its pricing.')
    public static void execute(List<Request> requests) {
        if (requests == null) {
            return;
        }
        for (Request req : requests) {
            Acme_Order__c ord = [
                SELECT Id, Amount__c
                FROM Acme_Order__c
                WHERE Id = :req.quoteId
                LIMIT 1
            ];
            ord.Amount__c = AcmeDiscountUtil.applyDiscount(ord.Amount__c, req.promoCode);
            update ord;
            AcmeOrderService.recalculatePricing(req.quoteId);
        }
    }
}

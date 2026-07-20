/**
 * Global SOAP surface for a legacy ERP integration that predates the REST
 * resource. legacyApproveOrder mirrors AcmeOrderApprovalController's
 * behavior but goes straight to AcmeOrderUtil.markApproved rather than the
 * lookup-then-approve shape of AcmeOrderService.approveOrder, since the
 * legacy caller already has the loaded order status in hand.
 */
global class AcmeLegacyOrderSoapService {

    webservice static void legacyApproveOrder(Id orderId) {
        Acme_Order__c ord = [
            SELECT Id, Acme_Status__c
            FROM Acme_Order__c
            WHERE Id = :orderId
            LIMIT 1
        ];
        AcmeOrderUtil.markApproved(ord);
    }
}

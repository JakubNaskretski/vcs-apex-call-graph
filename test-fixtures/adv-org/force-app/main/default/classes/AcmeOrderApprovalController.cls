/**
 * @AuraEnabled controller backing the Aura AcmeOrderApprovalPanel component
 * (controller="AcmeOrderApprovalController").
 */
public with sharing class AcmeOrderApprovalController {

    @AuraEnabled
    public static void approveOrder(Id orderId) {
        AcmeOrderService.approveOrder(orderId);
    }
}

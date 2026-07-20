/**
 * Bulk @InvocableMethod entry point: approves every order Id passed in.
 * Invoked from a bare-actionName Flow apex action and from a
 * subflow-adjacent flow, so the parameter list stays a single bulkified
 * List<Id> rather than a wrapper type.
 */
public with sharing class AcmeOrderInvocable {

    @InvocableMethod(label='Approve Acme Orders' description='Approves each order Id in the input list.')
    public static void execute(List<Id> orderIds) {
        if (orderIds == null) {
            return;
        }
        for (Id orderId : orderIds) {
            AcmeOrderService.approveOrder(orderId);
        }
    }
}

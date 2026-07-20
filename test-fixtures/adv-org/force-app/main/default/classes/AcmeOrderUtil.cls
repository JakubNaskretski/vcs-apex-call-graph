/**
 * Order utility layer. Link 4 of the order chain: normalize() fills in
 * required defaults before an order is persisted; markApproved() flips an
 * order to Approved and fires the @future email notifier; buildQuery()
 * centralizes the query text used by the nightly batch's start() method.
 */
public without sharing class AcmeOrderUtil {

    public static List<Acme_Order__c> normalize(List<Acme_Order__c> orders) {
        List<Acme_Order__c> result = new List<Acme_Order__c>();
        for (Acme_Order__c ord : orders) {
            if (String.isBlank(ord.Acme_Status__c)) {
                ord.Acme_Status__c = 'New';
            }
            result.add(ord);
        }
        return result;
    }

    public static void markApproved(Acme_Order__c ord) {
        ord.Acme_Status__c = 'Approved';
        update ord;
        AcmeFutureNotifier.sendApprovalEmail(ord.Id, ord.OwnerEmail__c);
    }

    public static String buildQuery() {
        return 'SELECT Id, Acme_Status__c, Amount__c, LineItemCount__c FROM Acme_Order__c';
    }
}

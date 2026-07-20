/**
 * REST front door for the order service: GET recalculates pricing for the
 * order Id in the URL path, POST accepts a JSON array of orders to process.
 */
@RestResource(urlMapping='/acmeOrders/*')
global with sharing class AcmeOrderRestResource {

    @HttpGet
    global static void handleGet() {
        RestRequest req = RestContext.request;
        String uri = req.requestURI;
        Id orderId = (Id) uri.substring(uri.lastIndexOf('/') + 1);
        AcmeOrderService.recalculatePricing(orderId); NovaBillingUtil.auditPricingSync(orderId); // v0.7: ambiguous cross-package fixture
    }

    @HttpPost
    global static void handlePost() {
        RestRequest req = RestContext.request;
        List<Acme_Order__c> orders = (List<Acme_Order__c>) JSON.deserialize(
            req.requestBody.toString(),
            List<Acme_Order__c>.class
        );
        try {
            AcmeOrderService.processOrders(orders);
        } catch (AcmeBaseException be) {
            System.debug('REST handlePost caught base exception: ' + be.getMessage());
        }
    }
}

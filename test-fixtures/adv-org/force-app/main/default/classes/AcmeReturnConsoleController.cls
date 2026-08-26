/**
 * @AuraEnabled controller backing the Aura AcmeReturnConsolePanel component
 * (controller="AcmeReturnConsoleController") and the LWC
 * acmeOrderDashboard bundle's secondary orderChartUtils.js module.
 */
public with sharing class AcmeReturnConsoleController {

    @AuraEnabled
    public static String getReturnSummary() {
        return 'Return summary unavailable';
    }

    @AuraEnabled
    public static String summarizeReturns() {
        return 'No returns to summarize';
    }
}

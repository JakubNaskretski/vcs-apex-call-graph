/**
 * v0.7 corpus fixture: pkg-shared's caller class. syncSharedQuery() calls
 * AcmeOrderUtil.buildQuery() -- pkg-shared declares no AcmeOrderUtil of its
 * own, so the same-package rule finds no candidate here; the default
 * package (force-app) DOES declare AcmeOrderUtil, so this call resolves
 * there via the default-package-fallback rule. This is the
 * default-package-fallback fixture (see MANIFEST v0.7 package matrix).
 */
public with sharing class NovaSharedBillingBridge {

    public static void syncSharedQuery() {
        String query = AcmeOrderUtil.buildQuery();
        System.debug('Shared bridge query: ' + query);
    }
}

/**
 * v0.4 corpus fixture for F5 entry-kind detection: implements
 * InstallHandler, so onInstall() should be tagged with the
 * 'InstallHandler (package install)' entry.
 */
public class AcmeCatalogInstallHandler implements InstallHandler {

    public void onInstall(InstallContext context) {
        System.debug('Acme catalog package installed for org ' + context.organizationId());
    }
}

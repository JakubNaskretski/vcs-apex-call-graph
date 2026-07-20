/**
 * Declares a locally typed Database (the user class in this org, not
 * System.Database) and calls it directly.
 */
public class AcmeShadowConsumer {

    public String describeLocalCatalog() {
        Database localCatalog = new Database();
        return localCatalog.describe();
    }
}

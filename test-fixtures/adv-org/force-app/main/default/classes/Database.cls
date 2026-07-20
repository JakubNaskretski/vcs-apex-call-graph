/**
 * User-defined class literally named Database. Deliberately shadows the
 * platform Database type so that in-org references to "Database" inside
 * this org resolve to this catalog helper, not System.Database.
 */
public class Database {

    public String catalogName;

    public Database() {
        this.catalogName = 'AcmePartsCatalog';
    }

    public String describe() {
        return 'Acme internal catalog database: ' + catalogName;
    }
}

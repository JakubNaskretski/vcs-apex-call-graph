// GAUNTLET (enterprise patterns, lens: service locator, STRING-keyed --
// distinct from the pre-existing gauntlet-org Cluster D7's Map<String,Type>
// (which at least keeps a Type token the engine could theoretically chase).
// Here the registry maps directly to pre-built OBJECT instances -- there is
// no Type value anywhere in this chain, only an opaque string key, so there
// is no `.newInstance()` reflection call at all to even partially recognize.
public class KappaServiceLocator {

    private static final Map<String, Object> registry = new Map<String, Object>{
        'OrderService' => new KappaOrderServiceImpl(),
        'LegacyOrderService' => new KappaLegacyOrderServiceImpl()
    };

    public static Object get(String serviceKey) {
        return registry.get(serviceKey);
    }
}

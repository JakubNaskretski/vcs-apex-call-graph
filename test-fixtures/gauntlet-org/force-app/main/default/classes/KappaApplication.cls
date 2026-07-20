// GAUNTLET (enterprise patterns, lens: Application factory) -- deliberately
// uses the REAL fflib shape (a static field holding a nested ServiceFactory
// INSTANCE, e.g. `Application.Service.newInstance(...)`) rather than the
// simpler flat-static-method shape already covered by the pre-existing
// gauntlet-org Cluster D (VertexApplication.newInstance is a bare static
// method, resolvable via rule 5 'static' on a single identifier receiver).
// This variant's consumer call site chains through a STATIC FIELD access
// (`KappaApplication.Service`) before the method call, which is a different
// receiver shape than a bare class-name receiver.
public class KappaApplication {

    public static final KappaApplication.ServiceFactory Service = new KappaApplication.ServiceFactory(
        new Map<Type, Type>{
            KappaPricingService.class => KappaPricingServiceImpl.class
        }
    );

    public class ServiceFactory {
        private Map<Type, Type> typeByInterface;

        public ServiceFactory(Map<Type, Type> typeByInterface) {
            this.typeByInterface = typeByInterface;
        }

        public Object newInstance(Type interfaceType) {
            Type implType = typeByInterface.get(interfaceType);
            return implType.newInstance();
        }
    }
}

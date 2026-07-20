public class VertexApplication {
  public static Map<Type, Type> serviceBindings = new Map<Type, Type>{
    VertexPricingServiceInterface.class => VertexPricingServiceImpl.class
  };

  public static Object newInstance(Type interfaceType) {
    Type implType = serviceBindings.get(interfaceType);
    return implType.newInstance();
    // NON-EDGE (constructor): implType is sourced from a Map<Type,Type> value lookup, not a
    // Type.forName('literal') call — this is a DIFFERENT and even-less-tractable shape than
    // the documented "Type.forName non-literal untraced" limit (there is no forName call here
    // at all to even partially recognize). Honest expected output: no constructor edge to
    // VertexPricingServiceImpl.<init>. [IDEAL]
  }
}

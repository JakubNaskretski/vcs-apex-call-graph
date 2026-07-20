/**
 * v0.4 corpus fixture for virtual-override fan-out (F3): calls
 * surchargeFactor() through a parameter typed to the ABSTRACT root of the
 * existing packaging-shape hierarchy (AcmeShapeBase -> AcmeShapeIntermediate
 * -> AcmeShapeConcrete), so both concrete overrides
 * (AcmeShapeIntermediate.surchargeFactor, AcmeShapeConcrete.surchargeFactor)
 * are legitimate runtime targets alongside AcmeShapeBase's own
 * implementation. surchargeFactor() (not the abstract computeVolume()) is
 * used deliberately so the base-class "typed" edge lands on a real method
 * body, not an abstract declaration with no implementation.
 */
public class AcmeShapeAuditor {

    public Decimal auditSurcharge(AcmeShapeBase shape) {
        return shape.surchargeFactor();
    }
}

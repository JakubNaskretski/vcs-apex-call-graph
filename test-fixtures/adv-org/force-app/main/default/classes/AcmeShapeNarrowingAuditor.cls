/**
 * v0.5 corpus fixture for G3 (instanceof narrowing): auditLabel() calls
 * crateLabel(), a method that exists ONLY on AcmeShapeConcrete -- neither
 * AcmeShapeBase nor AcmeShapeIntermediate declare it -- so ordinary typed
 * resolution on the AcmeShapeBase-declared `shape` parameter fails and the
 * resolver must fall back to the `shape instanceof AcmeShapeConcrete`
 * narrowing to find a target. auditDescribeShape() is the negative case:
 * describeShape() IS declared directly on AcmeShapeBase, so declared-type
 * resolution already succeeds and narrowing must NOT be consulted even
 * though the same instanceof guard is present.
 */
public class AcmeShapeNarrowingAuditor {

    public String auditLabel(AcmeShapeBase shape) {
        if (shape instanceof AcmeShapeConcrete) {
            return shape.crateLabel();
        }
        return null;
    }

    public String auditDescribeShape(AcmeShapeBase shape) {
        if (shape instanceof AcmeShapeConcrete) {
            return shape.describeShape();
        }
        return null;
    }
}

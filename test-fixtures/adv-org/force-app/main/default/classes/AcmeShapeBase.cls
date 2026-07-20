/**
 * Abstract root of the packaging-shape hierarchy used for freight/volume
 * calculations. Concrete shapes vary in how volume and handling surcharge
 * are computed.
 */
public abstract class AcmeShapeBase {

    public String shapeName;
    protected Integer unitCount;

    public AcmeShapeBase(String shapeName, Integer unitCount) {
        this.shapeName = shapeName;
        this.unitCount = unitCount == null ? 0 : unitCount;
    }

    public abstract Decimal computeVolume();

    public virtual Decimal surchargeFactor() {
        return 1.0;
    }

    public String describeShape() {
        return shapeName + ' (' + unitCount + ' units)';
    }
}

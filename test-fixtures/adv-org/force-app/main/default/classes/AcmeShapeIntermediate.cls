/**
 * Middle tier of the packaging-shape hierarchy. Provides a generic
 * length x width x count volume model that concrete shapes may refine.
 */
public virtual class AcmeShapeIntermediate extends AcmeShapeBase {

    protected Decimal length;
    protected Decimal width;

    public AcmeShapeIntermediate(String shapeName, Integer unitCount, Decimal length, Decimal width) {
        super(shapeName, unitCount);
        this.length = length == null ? 0 : length;
        this.width = width == null ? 0 : width;
    }

    public virtual override Decimal computeVolume() {
        return (length * width * unitCount).setScale(2);
    }

    public virtual override Decimal surchargeFactor() {
        return 1.15;
    }
}

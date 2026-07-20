/**
 * Bottom tier of the packaging-shape hierarchy: a rectangular crate.
 * This is the concrete type AcmePricingEngine instantiates when computing
 * freight surcharge for a quote.
 */
public class AcmeShapeConcrete extends AcmeShapeIntermediate {

    private Decimal height;

    public AcmeShapeConcrete(Integer unitCount, Decimal length, Decimal width, Decimal height) {
        super('Crate', unitCount, length, width);
        this.height = height == null ? 0 : height;
    }

    public override Decimal computeVolume() {
        return (length * width * height * unitCount).setScale(2);
    }

    public override Decimal surchargeFactor() {
        Decimal baseFactor = super.surchargeFactor();
        return unitCount > 250 ? baseFactor * 1.25 : baseFactor;
    }

    public String crateLabel() {
        return 'CRATE-' + shapeName;
    }
}

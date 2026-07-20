/**
 * H2 compositional fixture (v0.6): virtual base implementer of
 * AcmeSurchargeStrategy. Declares `implements` directly and a `virtual`
 * method body — AcmeExpeditedSurchargeStrategy extends this class and
 * overrides computeSurcharge() without redeclaring `implements
 * AcmeSurchargeStrategy` itself.
 */
public virtual class AcmeStandardSurchargeStrategy implements AcmeSurchargeStrategy {

    public virtual Decimal computeSurcharge(Decimal baseAmount) {
        return baseAmount * 0.05;
    }
}

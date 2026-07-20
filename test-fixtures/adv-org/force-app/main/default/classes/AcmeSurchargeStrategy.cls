/**
 * H2 compositional fixture (v0.6): interface implemented by a virtual base
 * surcharge strategy and overridden two tiers down by a subclass that does
 * NOT redeclare `implements`. See AcmeStandardSurchargeStrategy /
 * AcmeExpeditedSurchargeStrategy / AcmeSurchargeRouter.
 */
public interface AcmeSurchargeStrategy {
    Decimal computeSurcharge(Decimal baseAmount);
}

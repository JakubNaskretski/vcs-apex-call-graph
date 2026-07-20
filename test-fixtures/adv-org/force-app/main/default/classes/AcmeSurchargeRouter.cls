/**
 * H2 compositional fixture (v0.6): dispatcher that calls
 * AcmeSurchargeStrategy exclusively through the interface-typed `strategy`
 * parameter, never a concrete type. Tracing callers of
 * AcmeExpeditedSurchargeStrategy.computeSurcharge must surface
 * applySurcharge() here (via='interface', approximate) once interface
 * dispatch fans out downward to overrides, not just to direct implementers.
 */
public class AcmeSurchargeRouter {

    public Decimal applySurcharge(AcmeSurchargeStrategy strategy, Decimal baseAmount) {
        return strategy.computeSurcharge(baseAmount);
    }
}

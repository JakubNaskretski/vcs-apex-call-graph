/**
 * H2 compositional fixture (v0.6): overrides
 * AcmeStandardSurchargeStrategy.computeSurcharge() with an expedited-freight
 * multiplier. Deliberately does NOT redeclare `implements
 * AcmeSurchargeStrategy` — this class satisfies the interface purely by
 * extending an implementer that does.
 *
 * This is the confirmed-missing composition: interface dispatch fans out to
 * direct implementers and walks UP their extends chain to find an inherited
 * method body (already exercised by AcmeSlackNotifier/AcmeBaseNotifier in
 * the Notifications fixture group), but never fanned DOWN to an override
 * declared in a subclass of an implementer. Pre-fix, tracing
 * computeSurcharge() here shows zero callers even though
 * AcmeSurchargeRouter.applySurcharge calls exactly this override through the
 * interface-typed parameter.
 */
public class AcmeExpeditedSurchargeStrategy extends AcmeStandardSurchargeStrategy {

    public override Decimal computeSurcharge(Decimal baseAmount) {
        return baseAmount * 0.12;
    }
}

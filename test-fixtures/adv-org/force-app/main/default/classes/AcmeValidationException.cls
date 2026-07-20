/**
 * v0.5 corpus fixture for G2: the concrete exception thrown by order/
 * shipment validation guard clauses. Extends AcmeBaseException (not
 * Exception directly) so the corpus exercises supertype-catch resolution.
 */
public class AcmeValidationException extends AcmeBaseException {
}

/**
 * v0.4 corpus fixture for dynamic dispatch (F4a): Type.forName() with a
 * single string-literal argument.
 *   - createEmailNotifier(): literal arg names a REAL user class
 *     (AcmeEmailNotifier) -> expected edge to AcmeEmailNotifier.<init>,
 *     via=dynamic, approximate.
 *   - createGhostNotifier(): literal arg names a class that does NOT exist
 *     anywhere in this org -> no edge expected (t is always null at
 *     runtime; the guard below is realistic defensive code, not a fixture
 *     artifact).
 *   - createNotifier(String handlerName): the arg is a VARIABLE, not a
 *     string literal -> does not qualify for F4a's "single string-literal
 *     arg" rule -> no edge expected here either, a second negative case
 *     distinct from the nonexistent-class one above.
 */
public class AcmeHandlerFactory {

    public AcmeNotifiable createEmailNotifier() {
        Type t = Type.forName('AcmeEmailNotifier');
        return (AcmeNotifiable) t.newInstance();
    }

    public AcmeNotifiable createGhostNotifier() {
        Type t = Type.forName('AcmeGhostNotifierDoesNotExist');
        if (t == null) {
            return null;
        }
        return (AcmeNotifiable) t.newInstance();
    }

    public AcmeNotifiable createNotifier(String handlerName) {
        Type t = Type.forName(handlerName);
        if (t == null) {
            return null;
        }
        return (AcmeNotifiable) t.newInstance();
    }
}

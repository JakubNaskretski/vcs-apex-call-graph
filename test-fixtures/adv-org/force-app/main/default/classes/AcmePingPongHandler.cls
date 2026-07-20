/**
 * v0.5 corpus fixture for G6: implements AcmeChildIntf (not AcmeParentIntf
 * directly), so this class is only reachable from an AcmeParentIntf-typed
 * caller through the interface-extends transitive closure.
 *
 * G6 (diamond): AcmeChildIntf now also extends AcmeSecondaryIntf, so this
 * class must implement pong() too, and must be reachable from an
 * AcmeSecondaryIntf-typed caller through that SECOND extends-list parent.
 */
public class AcmePingPongHandler implements AcmeChildIntf {

    public void ping() {
        System.debug('ping from AcmePingPongHandler');
    }

    public void pong() {
        System.debug('pong from AcmePingPongHandler');
    }
}

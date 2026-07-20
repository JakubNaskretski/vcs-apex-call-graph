/**
 * v0.5 corpus fixture for G6: implements AcmeParentIntf directly, so
 * interface fan-out for AcmeParentIntf.ping must include this class
 * alongside the transitively-reached AcmePingPongHandler.
 */
public class AcmeDirectPingHandler implements AcmeParentIntf {

    public void ping() {
        System.debug('ping from AcmeDirectPingHandler');
    }
}

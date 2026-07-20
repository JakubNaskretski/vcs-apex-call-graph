/**
 * v0.5 corpus fixture for G6: calls ping() through an AcmeParentIntf-typed
 * local variable, so the resolver's interface fan-out for AcmeParentIntf
 * must reach both the implementer reached only via AcmeChildIntf extends
 * AcmeParentIntf (AcmePingPongHandler) and the direct implementer
 * (AcmeDirectPingHandler, see AcmeDirectPingHandler.cls).
 */
public class AcmeIntfDispatchDemo {

    public void dispatchPing() {
        AcmeParentIntf handler = new AcmePingPongHandler();
        handler.ping();
    }
}

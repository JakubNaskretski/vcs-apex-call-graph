/**
 * v0.5 corpus fixture for G6 (diamond): calls pong() through an
 * AcmeSecondaryIntf-typed local variable -- AcmeSecondaryIntf is the
 * SECOND entry in AcmeChildIntf's `extends AcmeParentIntf, AcmeSecondaryIntf`
 * list. Pre-fix, parser.js's extendsType kept only the first entry
 * (AcmeParentIntf), so AcmePingPongHandler had zero registered implementers
 * under AcmeSecondaryIntf and this call site resolved to no callers at all.
 */
public class AcmeIntfDispatchSecondaryDemo {

    public void dispatchPong() {
        AcmeSecondaryIntf handler = new AcmePingPongHandler();
        handler.pong();
    }
}

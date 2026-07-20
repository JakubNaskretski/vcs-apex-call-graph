/**
 * Non-interface virtual base with a default notify() implementation.
 * Subclasses may rely on inheritance alone to satisfy AcmeNotifiable.
 */
public virtual class AcmeBaseNotifier {

    protected String channelName;

    public AcmeBaseNotifier(String channelName) {
        this.channelName = channelName;
    }

    public virtual void notify(String message) {
        System.debug('[' + channelName + '] Default notification: ' + message);
    }
}

/**
 * v0.5 corpus fixture for G1 (EventBus -> platform-event trigger linkage):
 * handles Acme_Note__e platform events published by AcmeNoteEventPublisher.
 * Kept intentionally thin, mirroring the other trigger handlers in this
 * corpus.
 */
public class AcmeNoteEventHandler {

    public static void handle(List<Acme_Note__e> events) {
        for (Acme_Note__e evt : events) {
            System.debug('Received note event: ' + evt.Message__c);
        }
    }
}

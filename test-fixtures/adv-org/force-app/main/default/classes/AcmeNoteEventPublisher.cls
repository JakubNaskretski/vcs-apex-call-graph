/**
 * v0.5 corpus fixture for G1: publishNote() exercises the single-record
 * EventBus.publish(new Acme_Note__e(...)) form; publishNotes() exercises
 * the List<Acme_Note__e> collection form built up in a loop before a
 * single EventBus.publish(events) call.
 */
public class AcmeNoteEventPublisher {

    public static void publishNote(String message) {
        EventBus.publish(new Acme_Note__e(Message__c = message));
    }

    public static void publishNotes(List<String> messages) {
        List<Acme_Note__e> events = new List<Acme_Note__e>();
        for (String msg : messages) {
            events.add(new Acme_Note__e(Message__c = msg));
        }
        EventBus.publish(events);
    }
}

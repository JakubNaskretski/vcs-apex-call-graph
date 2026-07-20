/**
 * v0.5 corpus fixture for G1: after-insert trigger on the Acme_Note__e
 * platform event, published by AcmeNoteEventPublisher.publishNote/
 * publishNotes. Platform event triggers only ever fire after insert.
 */
trigger AcmeNoteEventTrigger on Acme_Note__e (after insert) {
    AcmeNoteEventHandler.handle(Trigger.new);
}

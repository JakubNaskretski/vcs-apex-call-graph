trigger ExampleTrigger on Account (after insert) {
    TriggerHandlerService.handle(Trigger.new);
}

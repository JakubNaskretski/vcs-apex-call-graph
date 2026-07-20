// GAUNTLET (enterprise patterns, lens: trigger framework, virtual handler
// base). The template-method shape: run() is the framework's own dispatch
// entry point, and it calls its OWN overridable virtual hooks via an
// implicit (bare) `this` -- exactly how fflib_SObjectDomain / a hand-rolled
// TriggerHandler base typically works. This is the key shape under test:
// does a bare self-call to a virtual method, made from WITHIN the base
// class's own body, ever reach a subclass's override?
public virtual class KappaTriggerHandler {

    public virtual void run() {
        if (Trigger.isBefore && Trigger.isInsert) {
            beforeInsert();
        }
        if (Trigger.isAfter && Trigger.isInsert) {
            afterInsert();
        }
        if (Trigger.isAfter && Trigger.isUpdate) {
            afterUpdate();
        }
    }

    public virtual void beforeInsert() {
        // default: no-op
    }

    public virtual void afterInsert() {
        // default: no-op
    }

    public virtual void afterUpdate() {
        // default: no-op
    }
}

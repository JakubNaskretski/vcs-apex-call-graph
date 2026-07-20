// GAUNTLET (enterprise patterns, lens: trigger framework, CMDT-driven
// handler names). Differs from the pre-existing gauntlet-org Cluster D7
// (VertexGenericTriggerDispatcher), which resolves its handler via an
// IN-CODE `Map<String, Type>` literal -- here the handler class NAME comes
// from an actual Custom Metadata Type record queried at runtime
// (Kappa_Trigger_Config__mdt.Handler_Class_Name__c), which is the more
// realistic fflib_TriggerHandlerFactory-style shape. This is the shape
// metascan.js's `cmdt` MetaRef kind exists for.
public class KappaGenericTriggerDispatcher {

    public void dispatch(String sobjectApiName) {
        List<Kappa_Trigger_Config__mdt> configs = [
            SELECT Handler_Class_Name__c
            FROM Kappa_Trigger_Config__mdt
            WHERE SobjectApiName__c = :sobjectApiName
            AND Active__c = true
        ];
        for (Kappa_Trigger_Config__mdt config : configs) {
            Type handlerType = Type.forName(config.Handler_Class_Name__c);
            if (handlerType == null) {
                continue;
            }
            KappaTriggerHandler handler = (KappaTriggerHandler) handlerType.newInstance();
            handler.run();
        }
    }
}

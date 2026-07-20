@isTest
public class VertexBoltWrapperTestA {
    @isTest
    static void testRunDispatchViaSolo01() {
        Kappa_Item__c item = new Kappa_Item__c();
        VertexBoltSolo01.runDispatch(item);
    }
}

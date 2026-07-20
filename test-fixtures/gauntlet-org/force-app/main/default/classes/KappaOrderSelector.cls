public class KappaOrderSelector extends KappaSelector {

    public override Schema.SObjectType getSObjectType() {
        return Kappa_Order__c.SObjectType;
    }

    public override List<String> getSelectFields() {
        return new List<String>{'Id', 'Name', 'Amount__c'};
    }
}

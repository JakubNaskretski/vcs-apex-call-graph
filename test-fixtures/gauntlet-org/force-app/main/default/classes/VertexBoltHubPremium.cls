public class VertexBoltHubPremium extends VertexBoltHub {
    public override void dispatch(Kappa_Item__c item) {
        super.dispatch(item);
        applySurcharge(item);
    }

    private void applySurcharge(Kappa_Item__c item) {
        item.Surcharge__c = true;
    }
}

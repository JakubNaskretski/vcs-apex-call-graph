public class VertexKappaShipmentCaller {
    public void routeShipment(Kappa_Shipment__c shipment) {
        VertexKappaShipmentHub trapHub = new VertexKappaShipmentHub();
        trapHub.dispatch(shipment);
    }
}

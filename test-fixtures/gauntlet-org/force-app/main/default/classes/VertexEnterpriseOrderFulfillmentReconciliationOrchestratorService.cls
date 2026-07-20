public class VertexEnterpriseOrderFulfillmentReconciliationOrchestratorService {
  public void reconcileFulfillmentDiscrepanciesAcrossAllDistributionCenters(Vertex_Order__c order) {
    VertexCrossRegionInventoryAvailabilitySynchronizationCoordinator coordinator = new VertexCrossRegionInventoryAvailabilitySynchronizationCoordinator();
    coordinator.synchronizeInventoryAvailabilitySnapshotsForDistributionRegion('NA-WEST');
  }
}

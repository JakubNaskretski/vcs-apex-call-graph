public class KappaOrderUowService {

    public void processNewOrder(Kappa_Order__c order) {
        KappaUnitOfWork uow = KappaUnitOfWorkFactory.newInstance();
        uow.registerNew(order);
        uow.commitWork();
    }
}

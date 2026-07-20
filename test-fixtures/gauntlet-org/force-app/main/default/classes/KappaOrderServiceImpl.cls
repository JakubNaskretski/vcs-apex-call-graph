public class KappaOrderServiceImpl implements KappaOrderServiceInterface {

    public void process(Id orderId) {
        System.debug('kappa processing order ' + orderId);
    }
}

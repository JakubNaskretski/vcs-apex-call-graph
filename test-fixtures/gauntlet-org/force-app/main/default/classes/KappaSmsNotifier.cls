public class KappaSmsNotifier implements KappaNotifier {

    public void notify(String message) {
        System.debug('kappa sms: ' + message);
    }
}

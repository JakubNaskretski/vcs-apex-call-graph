public class KappaEmailNotifier implements KappaNotifier {

    public void notify(String message) {
        System.debug('kappa email: ' + message);
    }
}

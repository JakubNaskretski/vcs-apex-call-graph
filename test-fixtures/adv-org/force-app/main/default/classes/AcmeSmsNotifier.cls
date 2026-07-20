/**
 * SMS notification channel: implements AcmeNotifiable directly, calling out
 * to a fictional gateway endpoint.
 */
public class AcmeSmsNotifier implements AcmeNotifiable {

    public String gatewayEndpoint;

    public AcmeSmsNotifier(String gatewayEndpoint) {
        this.gatewayEndpoint = gatewayEndpoint;
    }

    public void notify(String message) {
        sendSms(message);
    }

    private void sendSms(String message) {
        HttpRequest req = new HttpRequest();
        req.setEndpoint(gatewayEndpoint);
        req.setMethod('POST');
        req.setBody(message);
        Http http = new Http();
        HttpResponse res = http.send(req);
        System.debug('SMS gateway responded with status: ' + res.getStatusCode());
    }
}

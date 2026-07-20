public class VtxKwxInvoiceService {
  public void postInvoice(Decimal amount) {
    insert new kwx__Invoice__c(Amount__c = amount);
  }
}

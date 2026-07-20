/**
 * v0.4 corpus fixture for F5 entry-kind detection: implements Comparable,
 * so compareTo() should be tagged with the 'Comparable (invoked by sort)'
 * entry.
 */
public class AcmeOrderPriority implements Comparable {

    public String orderName;
    public Integer priority;

    public AcmeOrderPriority(String orderName, Integer priority) {
        this.orderName = orderName;
        this.priority = priority;
    }

    public Integer compareTo(Object compareTo) {
        AcmeOrderPriority other = (AcmeOrderPriority) compareTo;
        return this.priority - other.priority;
    }
}

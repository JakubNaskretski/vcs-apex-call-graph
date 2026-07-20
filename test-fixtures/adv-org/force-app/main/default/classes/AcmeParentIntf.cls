/**
 * v0.5 corpus fixture for G6 (interface-extends-interface): the parent
 * interface. AcmeChildIntf extends this with no methods of its own, so
 * classes implementing AcmeChildIntf must still be reachable from an
 * AcmeParentIntf-typed caller.
 */
public interface AcmeParentIntf {
    void ping();
}

/**
 * v0.5 corpus fixture for G6: extends AcmeParentIntf with no additional
 * members of its own, so implementers of AcmeChildIntf are ALSO valid
 * interface-fan-out targets for AcmeParentIntf callers -- the resolver
 * must compute the transitive closure of interface-extends edges, not
 * just direct `implements` relationships.
 *
 * G6 (diamond): also extends AcmeSecondaryIntf as a SECOND parent -- a
 * multi-parent extends list. Implementers of AcmeChildIntf must be
 * reachable from an AcmeSecondaryIntf-typed caller too, not just the
 * FIRST extends-list entry (AcmeParentIntf).
 */
public interface AcmeChildIntf extends AcmeParentIntf, AcmeSecondaryIntf {
}

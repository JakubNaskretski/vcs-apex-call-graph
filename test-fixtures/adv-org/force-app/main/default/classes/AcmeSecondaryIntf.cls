/**
 * v0.5 corpus fixture for G6 (diamond): a SECOND parent interface.
 * AcmeChildIntf extends BOTH AcmeParentIntf and AcmeSecondaryIntf -- the
 * multi-parent ("diamond") extends-list case. Pre-fix, parser.js kept only
 * the FIRST extends-list entry (AcmeParentIntf), so this second parent and
 * everything reachable only through it were silently dropped.
 */
public interface AcmeSecondaryIntf {
    void pong();
}

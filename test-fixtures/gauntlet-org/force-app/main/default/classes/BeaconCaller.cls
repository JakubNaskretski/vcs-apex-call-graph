public class BeaconCaller {
  public void ping() {
    zenq.Beacon.signal();
    // NAMESPACE PROBE 6 (N=2 contrast / negative control): the tail "Beacon"
    // matches TWO local inner classes (KappaContainerA.Beacon and
    // KappaContainerB.Beacon) -- genuinely ambiguous. Expected: the
    // simple-name fallback must decline (matches.length !== 1) and produce
    // NO edge to either candidate. If a live run instead shows an edge to
    // ONE of the two, that is a second, worse bug (silently picking a
    // winner among ambiguous candidates instead of declining).
  }
}

public class VertexNoticeRelay {
  // H1 CONTROL: the sole local declarer of `relayNotice`, with exactly 2
  // unresolvable-receiver call sites elsewhere (both arity 1, matching this
  // method's one declared overload). 2 is under UNIQUE_NAME_MAX, so both
  // MUST still attach via the unique-name fallback -- proving the fallback
  // stays useful at small scale even after the H1 magnet fix.
  public static void relayNotice(String message) {
    System.debug('relay: ' + message);
  }
}

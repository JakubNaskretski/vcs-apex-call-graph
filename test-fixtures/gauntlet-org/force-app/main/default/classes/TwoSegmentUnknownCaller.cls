public class TwoSegmentUnknownCaller {
  public void callUnknownTwoSegment() {
    UnknownPkg.doThing();
    // PRECEDENCE PROBE (2-segment ambiguity trap, requirement 2c): a bare
    // 2-segment dotted call Head.method() where Head ("UnknownPkg") is not
    // a local variable, not a local class, and not a declared namespace --
    // per the engine's own precedence contract, a 2-segment call NEVER
    // creates an external node (a 2-segment shape is ambiguous with an
    // ordinary unresolved local reference -- e.g. a class the corpus simply
    // never declared -- and there is no third segment to disambiguate it as
    // namespace-qualified). Expected: stays counted as an ordinary
    // unresolved site, exactly like pre-v0.8 behavior; NO external node.
    // See VertexLedgerBridge.cls line 6 (kwx__LedgerService.postEntry) for
    // this exact shape already present elsewhere in the corpus.
  }
}

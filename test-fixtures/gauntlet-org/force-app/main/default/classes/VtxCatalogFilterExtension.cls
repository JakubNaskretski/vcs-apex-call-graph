// v0.10-A2: controller extension for pages/VtxCatalogPage.page (paired with
// VtxCatalogController via extensions="VtxCatalogFilterExtension"). Declares
// `refreshResults()` -- the "action bound to a method declared on an
// EXTENSION, not the controller" case -- and also `resetAll()` (same name as
// VtxCatalogController.resetAll(), the ambiguous "declared on several
// classes" case).
public class VtxCatalogFilterExtension {
  public VtxCatalogFilterExtension(VtxCatalogController controller) {
    // real Visualforce extension constructors take the base controller;
    // nothing to store for this fixture's purposes.
  }

  public PageReference refreshResults() {
    return null;
  }

  public PageReference resetAll() {
    return null;
  }

  public PageReference legacyReset() {
    // Reachable only via the non-identifier expression
    // action="{!filterExt.legacyReset}" on the page, which per A2 is a
    // dotted (non-single-identifier) brace expression and must be SKIPPED
    // entirely at the metascan layer -- this method must therefore never
    // appear as a vf-kind caller target anywhere in the index.
    return null;
  }
}

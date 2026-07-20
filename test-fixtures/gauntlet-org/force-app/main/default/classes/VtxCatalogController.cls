// v0.10-A2: custom Visualforce controller for pages/VtxCatalogPage.page.
// Declares the page-root `action="{!initCatalog}"` target, plus `resetAll()`
// -- deliberately ALSO declared on VtxCatalogFilterExtension with the same
// name, so a binding to `resetAll` matches SEVERAL controller/extensions
// classes (the A2 spec's "several declare it" branch, alongside the
// "none declare it" branch covered by `vanishedSortHandler` on the page).
public class VtxCatalogController {
  public String statusLabel { get; private set; }

  public VtxCatalogController() {
    this.statusLabel = 'idle';
  }

  public PageReference initCatalog() {
    this.statusLabel = 'catalog loaded';
    return null;
  }

  public PageReference resetAll() {
    this.statusLabel = 'reset (controller leg)';
    return null;
  }
}

// NAMESPACE PROBE (metascan/LWC layer): this component calls the fictional
// managed package `zenq`'s OWN globally-exposed KappaGateway.dispatch Apex
// method -- entirely unrelated to the LOCAL KappaGateway class declared in
// force-app/main/default/classes/KappaGateway.cls. metascan.js's own header
// comment documents that namespace-dotted specifiers are "tolerated by
// always taking the LAST TWO dot-separated segments as Class.method" --
// which is correct AS FAR AS PARSING THE STRING GOES, but the namespace
// prefix ('zenq.') that would disambiguate this from the local class is
// discarded entirely, and resolver.js's attachMetaCallers() keys purely on
// that bare (lc) className with no namespace awareness at all.
import dispatch from '@salesforce/apex/zenq.KappaGateway.dispatch';

import { LightningElement } from 'lwc';

export default class KappaGatewayPanel extends LightningElement {
  handleClick() {
    dispatch({ cmd: 'go' });
  }
}

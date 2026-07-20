// H1 MAGNET: one of VertexBindTarget.bind's exactly-2 CONFIRMED callers
// (the other is VertexBindTargetTest.cls's typed static call).
import bind from '@salesforce/apex/VertexBindTarget.bind';

import { LightningElement } from 'lwc';

export default class VertexBindPanel extends LightningElement {
  handleBind() {
    bind({ info: { requestId: 'REQ-2' } });
  }
}

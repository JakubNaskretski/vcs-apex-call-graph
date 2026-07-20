import refresh from '@salesforce/apex/VertexImpactController.refresh';
import { LightningElement } from 'lwc';

export default class VertexImpactPanel extends LightningElement {
  refreshImpact() {
    return refresh();
  }
}

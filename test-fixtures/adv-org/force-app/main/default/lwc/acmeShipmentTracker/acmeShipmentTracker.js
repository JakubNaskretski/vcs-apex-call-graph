import { LightningElement, api, wire } from 'lwc';
import getShipmentStatuses from '@salesforce/apex/AcmeShipmentAuraService.getShipmentStatuses';
import refreshTracking from '@salesforce/apex/AcmeShipmentAuraService.refreshTracking';

export default class AcmeShipmentTracker extends LightningElement {
    @api recordId;

    isRefreshing = false;
    errorMessage;

    @wire(getShipmentStatuses, { orderId: '$recordId' })
    shipmentStatuses;

    get hasStatuses() {
        return Boolean(this.shipmentStatuses && this.shipmentStatuses.data && this.shipmentStatuses.data.length);
    }

    get hasError() {
        return Boolean(this.shipmentStatuses && this.shipmentStatuses.error);
    }

    handleRefresh() {
        this.isRefreshing = true;
        this.errorMessage = undefined;

        refreshTracking({ orderId: this.recordId })
            .then(() => {
                this.isRefreshing = false;
            })
            .catch((error) => {
                this.isRefreshing = false;
                this.errorMessage = (error && error.body && error.body.message)
                    || 'Unknown error refreshing tracking.';
            });
    }
}

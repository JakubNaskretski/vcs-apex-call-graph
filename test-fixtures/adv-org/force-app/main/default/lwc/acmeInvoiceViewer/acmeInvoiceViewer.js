import { LightningElement, api, wire } from 'lwc';
import { refreshApex } from '@salesforce/apex';
import getInvoiceSummary from '@salesforce/apex/AcmeQuoteAuraService.getInvoiceSummary';
import recalculateInvoice from '@salesforce/apex/AcmeQuoteAuraService.recalculateInvoice';

export default class AcmeInvoiceViewer extends LightningElement {
    @api recordId;

    isRecalculating = false;
    errorMessage;

    wiredInvoiceSummary;

    @wire(getInvoiceSummary, { quoteId: '$recordId' })
    wiredSummary(value) {
        this.wiredInvoiceSummary = value;
    }

    get invoiceSummary() {
        return this.wiredInvoiceSummary && this.wiredInvoiceSummary.data;
    }

    get hasError() {
        return Boolean(this.wiredInvoiceSummary && this.wiredInvoiceSummary.error);
    }

    handleRecalculate() {
        this.isRecalculating = true;
        this.errorMessage = undefined;

        recalculateInvoice({ quoteId: this.recordId })
            .then(() => {
                this.isRecalculating = false;
                return refreshApex(this.wiredInvoiceSummary);
            })
            .catch((error) => {
                this.isRecalculating = false;
                this.errorMessage = (error && error.body && error.body.message)
                    || 'Unknown error recalculating invoice.';
            });
    }
}

import { LightningElement, wire } from 'lwc';
import getRecentQuotes from '@salesforce/apex/AcmeQuoteAuraService.getRecentQuotes';

export default class AcmeOrderDashboard extends LightningElement {
    @wire(getRecentQuotes)
    recentQuotes;

    get hasQuotes() {
        return Boolean(this.recentQuotes && this.recentQuotes.data && this.recentQuotes.data.length);
    }

    get hasError() {
        return Boolean(this.recentQuotes && this.recentQuotes.error);
    }
}

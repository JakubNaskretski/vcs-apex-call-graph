import { LightningElement, track } from 'lwc';
import
    createQuote
    from '@salesforce/apex/AcmeQuoteAuraService.createQuote';

export default class AcmeQuoteWizard extends LightningElement {
    @track quoteName = '';
    @track isSaving = false;
    @track errorMessage;

    handleNameChange(event) {
        this.quoteName = event.target.value;
    }

    handleCreateQuote() {
        this.isSaving = true;
        this.errorMessage = undefined;

        createQuote({ quoteName: this.quoteName })
            .then((result) => {
                this.isSaving = false;
                this.dispatchEvent(
                    new CustomEvent('quotecreated', { detail: result })
                );
            })
            .catch((error) => {
                this.isSaving = false;
                this.errorMessage = (error && error.body && error.body.message)
                    || 'Unknown error creating quote.';
            });
    }
}

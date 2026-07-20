import { createElement } from 'lwc';
import AcmeQuoteWizard from 'c/acmeQuoteWizard';
import createQuote from '@salesforce/apex/AcmeQuoteAuraService.createQuote';

jest.mock(
    '@salesforce/apex/AcmeQuoteAuraService.createQuote',
    () => ({ default: jest.fn() }),
    { virtual: true }
);

describe('c-acme-quote-wizard', () => {
    afterEach(() => {
        while (document.body.firstChild) {
            document.body.removeChild(document.body.firstChild);
        }
        jest.clearAllMocks();
    });

    it('calls createQuote with the entered quote name when the button is clicked', () => {
        createQuote.mockResolvedValue({ Id: 'a0X000000000001EAA', Name: 'Test Quote' });

        const element = createElement('c-acme-quote-wizard', {
            is: AcmeQuoteWizard
        });
        document.body.appendChild(element);

        const input = element.shadowRoot.querySelector('lightning-input');
        input.value = 'Test Quote';
        input.dispatchEvent(new CustomEvent('change'));

        const button = element.shadowRoot.querySelector('lightning-button');
        button.click();

        return Promise.resolve().then(() => {
            expect(createQuote).toHaveBeenCalledTimes(1);
            expect(createQuote.mock.calls[0][0]).toEqual({ quoteName: 'Test Quote' });
        });
    });

    it('surfaces an error message when createQuote rejects', () => {
        createQuote.mockRejectedValue({ body: { message: 'Validation failed.' } });

        const element = createElement('c-acme-quote-wizard', {
            is: AcmeQuoteWizard
        });
        document.body.appendChild(element);

        const button = element.shadowRoot.querySelector('lightning-button');
        button.click();

        return Promise.resolve().then(() => {
            const errorEl = element.shadowRoot.querySelector('.slds-text-color_error');
            expect(errorEl.textContent).toBe('Validation failed.');
        });
    });
});

import summarizeReturns from '@salesforce/apex/AcmeReturnConsoleController.summarizeReturns';

export function loadReturnSummaryChart() {
    return summarizeReturns();
}

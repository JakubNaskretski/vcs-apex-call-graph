public class VertexStatusRouter {

  public void route(String statusCode) {
    switch on statusCode {
      when 'NEW'                     { handleNew(); }
      when 'VALIDATED'               { handleValidated(); }
      when 'ENRICHED'                { handleEnriched(); }
      when 'ROUTED'                  { handleRouted(); }
      when 'PRICED'                  { handlePriced(); }
      when 'APPROVED'                { handleApproved(); }
      when 'REJECTED'                { handleRejected(); }
      when 'ON_HOLD'                 { handleOnHold(); }
      when 'BACKORDERED'             { handleBackordered(); }
      when 'PARTIALLY_SHIPPED'       { handlePartiallyShipped(); }
      when 'SHIPPED'                 { handleShipped(); }
      when 'INVOICED'                { handleInvoiced(); }
      when 'PAID'                    { handlePaid(); }
      when 'DISPUTED'                { handleDisputed(); }
      when 'REFUNDED'                { handleRefunded(); }
      when 'CANCELLED'               { handleCancelled(); }
      when 'ARCHIVED'                { handleArchived(); }
      when 'ESCALATED'               { handleEscalated(); }
      when else { handleUnknown(); }
    }
  }

  // handleNew()
  // is a call-graph leaf handler for the VertexStatusRouter state machine.
  // It intentionally makes no further outbound calls of any kind so that
  // this switch-heavy method stays a clean completeness/robustness probe
  // rather than adding extra fan-out that would complicate the resolver
  // assertions made elsewhere in this corpus (see GROUND-TRUTH.md Target 20).
  // The body below is a single System.debug status-transition log line,
  // matching every other branch handler in this file for consistency.
  // No SObject DML, no SOQL, no calls to sibling classes -- leaf only.
  // is a call-graph leaf handler for the VertexStatusRouter state machine.
  // It intentionally makes no further outbound calls of any kind so that
  // this switch-heavy method stays a clean completeness/robustness probe
  // rather than adding extra fan-out that would complicate the resolver
  // assertions made elsewhere in this corpus (see GROUND-TRUTH.md Target 20).
  // The body below is a single System.debug status-transition log line,
  // matching every other branch handler in this file for consistency.
  private void handleNew() {
    System.debug('VertexStatusRouter.handleNew');
  }

  // handleValidated()
  // No SObject DML, no SOQL, no calls to sibling classes -- leaf only.
  // is a call-graph leaf handler for the VertexStatusRouter state machine.
  // It intentionally makes no further outbound calls of any kind so that
  // this switch-heavy method stays a clean completeness/robustness probe
  // rather than adding extra fan-out that would complicate the resolver
  // assertions made elsewhere in this corpus (see GROUND-TRUTH.md Target 20).
  // The body below is a single System.debug status-transition log line,
  // matching every other branch handler in this file for consistency.
  // No SObject DML, no SOQL, no calls to sibling classes -- leaf only.
  // is a call-graph leaf handler for the VertexStatusRouter state machine.
  // It intentionally makes no further outbound calls of any kind so that
  // this switch-heavy method stays a clean completeness/robustness probe
  // rather than adding extra fan-out that would complicate the resolver
  // assertions made elsewhere in this corpus (see GROUND-TRUTH.md Target 20).
  // The body below is a single System.debug status-transition log line,
  private void handleValidated() {
    System.debug('VertexStatusRouter.handleValidated');
  }

  // handleEnriched()
  // matching every other branch handler in this file for consistency.
  // No SObject DML, no SOQL, no calls to sibling classes -- leaf only.
  // is a call-graph leaf handler for the VertexStatusRouter state machine.
  // It intentionally makes no further outbound calls of any kind so that
  // this switch-heavy method stays a clean completeness/robustness probe
  // rather than adding extra fan-out that would complicate the resolver
  // assertions made elsewhere in this corpus (see GROUND-TRUTH.md Target 20).
  // The body below is a single System.debug status-transition log line,
  // matching every other branch handler in this file for consistency.
  // No SObject DML, no SOQL, no calls to sibling classes -- leaf only.
  // is a call-graph leaf handler for the VertexStatusRouter state machine.
  // It intentionally makes no further outbound calls of any kind so that
  // this switch-heavy method stays a clean completeness/robustness probe
  // rather than adding extra fan-out that would complicate the resolver
  // assertions made elsewhere in this corpus (see GROUND-TRUTH.md Target 20).
  private void handleEnriched() {
    System.debug('VertexStatusRouter.handleEnriched');
  }

  // handleRouted()
  // The body below is a single System.debug status-transition log line,
  // matching every other branch handler in this file for consistency.
  // No SObject DML, no SOQL, no calls to sibling classes -- leaf only.
  // is a call-graph leaf handler for the VertexStatusRouter state machine.
  // It intentionally makes no further outbound calls of any kind so that
  // this switch-heavy method stays a clean completeness/robustness probe
  // rather than adding extra fan-out that would complicate the resolver
  // assertions made elsewhere in this corpus (see GROUND-TRUTH.md Target 20).
  // The body below is a single System.debug status-transition log line,
  // matching every other branch handler in this file for consistency.
  // No SObject DML, no SOQL, no calls to sibling classes -- leaf only.
  // is a call-graph leaf handler for the VertexStatusRouter state machine.
  // It intentionally makes no further outbound calls of any kind so that
  // this switch-heavy method stays a clean completeness/robustness probe
  // rather than adding extra fan-out that would complicate the resolver
  private void handleRouted() {
    System.debug('VertexStatusRouter.handleRouted');
  }

  // handlePriced()
  // assertions made elsewhere in this corpus (see GROUND-TRUTH.md Target 20).
  // The body below is a single System.debug status-transition log line,
  // matching every other branch handler in this file for consistency.
  // No SObject DML, no SOQL, no calls to sibling classes -- leaf only.
  // is a call-graph leaf handler for the VertexStatusRouter state machine.
  // It intentionally makes no further outbound calls of any kind so that
  // this switch-heavy method stays a clean completeness/robustness probe
  // rather than adding extra fan-out that would complicate the resolver
  // assertions made elsewhere in this corpus (see GROUND-TRUTH.md Target 20).
  // The body below is a single System.debug status-transition log line,
  // matching every other branch handler in this file for consistency.
  // No SObject DML, no SOQL, no calls to sibling classes -- leaf only.
  // is a call-graph leaf handler for the VertexStatusRouter state machine.
  // It intentionally makes no further outbound calls of any kind so that
  // this switch-heavy method stays a clean completeness/robustness probe
  private void handlePriced() {
    System.debug('VertexStatusRouter.handlePriced');
  }

  // handleApproved()
  // rather than adding extra fan-out that would complicate the resolver
  // assertions made elsewhere in this corpus (see GROUND-TRUTH.md Target 20).
  // The body below is a single System.debug status-transition log line,
  // matching every other branch handler in this file for consistency.
  // No SObject DML, no SOQL, no calls to sibling classes -- leaf only.
  // is a call-graph leaf handler for the VertexStatusRouter state machine.
  // It intentionally makes no further outbound calls of any kind so that
  // this switch-heavy method stays a clean completeness/robustness probe
  // rather than adding extra fan-out that would complicate the resolver
  // assertions made elsewhere in this corpus (see GROUND-TRUTH.md Target 20).
  // The body below is a single System.debug status-transition log line,
  // matching every other branch handler in this file for consistency.
  // No SObject DML, no SOQL, no calls to sibling classes -- leaf only.
  // is a call-graph leaf handler for the VertexStatusRouter state machine.
  // It intentionally makes no further outbound calls of any kind so that
  private void handleApproved() {
    System.debug('VertexStatusRouter.handleApproved');
  }

  // handleRejected()
  // this switch-heavy method stays a clean completeness/robustness probe
  // rather than adding extra fan-out that would complicate the resolver
  // assertions made elsewhere in this corpus (see GROUND-TRUTH.md Target 20).
  // The body below is a single System.debug status-transition log line,
  // matching every other branch handler in this file for consistency.
  // No SObject DML, no SOQL, no calls to sibling classes -- leaf only.
  // is a call-graph leaf handler for the VertexStatusRouter state machine.
  // It intentionally makes no further outbound calls of any kind so that
  // this switch-heavy method stays a clean completeness/robustness probe
  // rather than adding extra fan-out that would complicate the resolver
  // assertions made elsewhere in this corpus (see GROUND-TRUTH.md Target 20).
  // The body below is a single System.debug status-transition log line,
  // matching every other branch handler in this file for consistency.
  // No SObject DML, no SOQL, no calls to sibling classes -- leaf only.
  // is a call-graph leaf handler for the VertexStatusRouter state machine.
  private void handleRejected() {
    System.debug('VertexStatusRouter.handleRejected');
  }

  // handleOnHold()
  // It intentionally makes no further outbound calls of any kind so that
  // this switch-heavy method stays a clean completeness/robustness probe
  // rather than adding extra fan-out that would complicate the resolver
  // assertions made elsewhere in this corpus (see GROUND-TRUTH.md Target 20).
  // The body below is a single System.debug status-transition log line,
  // matching every other branch handler in this file for consistency.
  // No SObject DML, no SOQL, no calls to sibling classes -- leaf only.
  // is a call-graph leaf handler for the VertexStatusRouter state machine.
  // It intentionally makes no further outbound calls of any kind so that
  // this switch-heavy method stays a clean completeness/robustness probe
  // rather than adding extra fan-out that would complicate the resolver
  // assertions made elsewhere in this corpus (see GROUND-TRUTH.md Target 20).
  // The body below is a single System.debug status-transition log line,
  // matching every other branch handler in this file for consistency.
  // No SObject DML, no SOQL, no calls to sibling classes -- leaf only.
  private void handleOnHold() {
    System.debug('VertexStatusRouter.handleOnHold');
  }

  // handleBackordered()
  // is a call-graph leaf handler for the VertexStatusRouter state machine.
  // It intentionally makes no further outbound calls of any kind so that
  // this switch-heavy method stays a clean completeness/robustness probe
  // rather than adding extra fan-out that would complicate the resolver
  // assertions made elsewhere in this corpus (see GROUND-TRUTH.md Target 20).
  // The body below is a single System.debug status-transition log line,
  // matching every other branch handler in this file for consistency.
  // No SObject DML, no SOQL, no calls to sibling classes -- leaf only.
  // is a call-graph leaf handler for the VertexStatusRouter state machine.
  // It intentionally makes no further outbound calls of any kind so that
  // this switch-heavy method stays a clean completeness/robustness probe
  // rather than adding extra fan-out that would complicate the resolver
  // assertions made elsewhere in this corpus (see GROUND-TRUTH.md Target 20).
  // The body below is a single System.debug status-transition log line,
  // matching every other branch handler in this file for consistency.
  private void handleBackordered() {
    System.debug('VertexStatusRouter.handleBackordered');
  }

  // handlePartiallyShipped()
  // No SObject DML, no SOQL, no calls to sibling classes -- leaf only.
  // is a call-graph leaf handler for the VertexStatusRouter state machine.
  // It intentionally makes no further outbound calls of any kind so that
  // this switch-heavy method stays a clean completeness/robustness probe
  // rather than adding extra fan-out that would complicate the resolver
  // assertions made elsewhere in this corpus (see GROUND-TRUTH.md Target 20).
  // The body below is a single System.debug status-transition log line,
  // matching every other branch handler in this file for consistency.
  // No SObject DML, no SOQL, no calls to sibling classes -- leaf only.
  // is a call-graph leaf handler for the VertexStatusRouter state machine.
  // It intentionally makes no further outbound calls of any kind so that
  // this switch-heavy method stays a clean completeness/robustness probe
  // rather than adding extra fan-out that would complicate the resolver
  // assertions made elsewhere in this corpus (see GROUND-TRUTH.md Target 20).
  // The body below is a single System.debug status-transition log line,
  private void handlePartiallyShipped() {
    System.debug('VertexStatusRouter.handlePartiallyShipped');
  }

  // handleShipped()
  // matching every other branch handler in this file for consistency.
  // No SObject DML, no SOQL, no calls to sibling classes -- leaf only.
  // is a call-graph leaf handler for the VertexStatusRouter state machine.
  // It intentionally makes no further outbound calls of any kind so that
  // this switch-heavy method stays a clean completeness/robustness probe
  // rather than adding extra fan-out that would complicate the resolver
  // assertions made elsewhere in this corpus (see GROUND-TRUTH.md Target 20).
  // The body below is a single System.debug status-transition log line,
  // matching every other branch handler in this file for consistency.
  // No SObject DML, no SOQL, no calls to sibling classes -- leaf only.
  // is a call-graph leaf handler for the VertexStatusRouter state machine.
  // It intentionally makes no further outbound calls of any kind so that
  // this switch-heavy method stays a clean completeness/robustness probe
  // rather than adding extra fan-out that would complicate the resolver
  // assertions made elsewhere in this corpus (see GROUND-TRUTH.md Target 20).
  private void handleShipped() {
    System.debug('VertexStatusRouter.handleShipped');
  }

  // handleInvoiced()
  // The body below is a single System.debug status-transition log line,
  // matching every other branch handler in this file for consistency.
  // No SObject DML, no SOQL, no calls to sibling classes -- leaf only.
  // is a call-graph leaf handler for the VertexStatusRouter state machine.
  // It intentionally makes no further outbound calls of any kind so that
  // this switch-heavy method stays a clean completeness/robustness probe
  // rather than adding extra fan-out that would complicate the resolver
  // assertions made elsewhere in this corpus (see GROUND-TRUTH.md Target 20).
  // The body below is a single System.debug status-transition log line,
  // matching every other branch handler in this file for consistency.
  // No SObject DML, no SOQL, no calls to sibling classes -- leaf only.
  // is a call-graph leaf handler for the VertexStatusRouter state machine.
  // It intentionally makes no further outbound calls of any kind so that
  // this switch-heavy method stays a clean completeness/robustness probe
  // rather than adding extra fan-out that would complicate the resolver
  private void handleInvoiced() {
    System.debug('VertexStatusRouter.handleInvoiced');
  }

  // handlePaid()
  // assertions made elsewhere in this corpus (see GROUND-TRUTH.md Target 20).
  // The body below is a single System.debug status-transition log line,
  // matching every other branch handler in this file for consistency.
  // No SObject DML, no SOQL, no calls to sibling classes -- leaf only.
  // is a call-graph leaf handler for the VertexStatusRouter state machine.
  // It intentionally makes no further outbound calls of any kind so that
  // this switch-heavy method stays a clean completeness/robustness probe
  // rather than adding extra fan-out that would complicate the resolver
  // assertions made elsewhere in this corpus (see GROUND-TRUTH.md Target 20).
  // The body below is a single System.debug status-transition log line,
  // matching every other branch handler in this file for consistency.
  // No SObject DML, no SOQL, no calls to sibling classes -- leaf only.
  // is a call-graph leaf handler for the VertexStatusRouter state machine.
  // It intentionally makes no further outbound calls of any kind so that
  // this switch-heavy method stays a clean completeness/robustness probe
  private void handlePaid() {
    System.debug('VertexStatusRouter.handlePaid');
  }

  // handleDisputed()
  // rather than adding extra fan-out that would complicate the resolver
  // assertions made elsewhere in this corpus (see GROUND-TRUTH.md Target 20).
  // The body below is a single System.debug status-transition log line,
  // matching every other branch handler in this file for consistency.
  // No SObject DML, no SOQL, no calls to sibling classes -- leaf only.
  // is a call-graph leaf handler for the VertexStatusRouter state machine.
  // It intentionally makes no further outbound calls of any kind so that
  // this switch-heavy method stays a clean completeness/robustness probe
  // rather than adding extra fan-out that would complicate the resolver
  // assertions made elsewhere in this corpus (see GROUND-TRUTH.md Target 20).
  // The body below is a single System.debug status-transition log line,
  // matching every other branch handler in this file for consistency.
  // No SObject DML, no SOQL, no calls to sibling classes -- leaf only.
  // is a call-graph leaf handler for the VertexStatusRouter state machine.
  // It intentionally makes no further outbound calls of any kind so that
  private void handleDisputed() {
    System.debug('VertexStatusRouter.handleDisputed');
  }

  // handleRefunded()
  // this switch-heavy method stays a clean completeness/robustness probe
  // rather than adding extra fan-out that would complicate the resolver
  // assertions made elsewhere in this corpus (see GROUND-TRUTH.md Target 20).
  // The body below is a single System.debug status-transition log line,
  // matching every other branch handler in this file for consistency.
  // No SObject DML, no SOQL, no calls to sibling classes -- leaf only.
  // is a call-graph leaf handler for the VertexStatusRouter state machine.
  // It intentionally makes no further outbound calls of any kind so that
  // this switch-heavy method stays a clean completeness/robustness probe
  // rather than adding extra fan-out that would complicate the resolver
  // assertions made elsewhere in this corpus (see GROUND-TRUTH.md Target 20).
  // The body below is a single System.debug status-transition log line,
  // matching every other branch handler in this file for consistency.
  // No SObject DML, no SOQL, no calls to sibling classes -- leaf only.
  // is a call-graph leaf handler for the VertexStatusRouter state machine.
  private void handleRefunded() {
    System.debug('VertexStatusRouter.handleRefunded');
  }

  // handleCancelled()
  // It intentionally makes no further outbound calls of any kind so that
  // this switch-heavy method stays a clean completeness/robustness probe
  // rather than adding extra fan-out that would complicate the resolver
  // assertions made elsewhere in this corpus (see GROUND-TRUTH.md Target 20).
  // The body below is a single System.debug status-transition log line,
  // matching every other branch handler in this file for consistency.
  // No SObject DML, no SOQL, no calls to sibling classes -- leaf only.
  // is a call-graph leaf handler for the VertexStatusRouter state machine.
  // It intentionally makes no further outbound calls of any kind so that
  // this switch-heavy method stays a clean completeness/robustness probe
  // rather than adding extra fan-out that would complicate the resolver
  // assertions made elsewhere in this corpus (see GROUND-TRUTH.md Target 20).
  // The body below is a single System.debug status-transition log line,
  // matching every other branch handler in this file for consistency.
  // No SObject DML, no SOQL, no calls to sibling classes -- leaf only.
  private void handleCancelled() {
    System.debug('VertexStatusRouter.handleCancelled');
  }

  // handleArchived()
  // is a call-graph leaf handler for the VertexStatusRouter state machine.
  // It intentionally makes no further outbound calls of any kind so that
  // this switch-heavy method stays a clean completeness/robustness probe
  // rather than adding extra fan-out that would complicate the resolver
  // assertions made elsewhere in this corpus (see GROUND-TRUTH.md Target 20).
  // The body below is a single System.debug status-transition log line,
  // matching every other branch handler in this file for consistency.
  // No SObject DML, no SOQL, no calls to sibling classes -- leaf only.
  // is a call-graph leaf handler for the VertexStatusRouter state machine.
  // It intentionally makes no further outbound calls of any kind so that
  // this switch-heavy method stays a clean completeness/robustness probe
  // rather than adding extra fan-out that would complicate the resolver
  // assertions made elsewhere in this corpus (see GROUND-TRUTH.md Target 20).
  // The body below is a single System.debug status-transition log line,
  // matching every other branch handler in this file for consistency.
  private void handleArchived() {
    System.debug('VertexStatusRouter.handleArchived');
  }

  // handleEscalated()
  // No SObject DML, no SOQL, no calls to sibling classes -- leaf only.
  // is a call-graph leaf handler for the VertexStatusRouter state machine.
  // It intentionally makes no further outbound calls of any kind so that
  // this switch-heavy method stays a clean completeness/robustness probe
  // rather than adding extra fan-out that would complicate the resolver
  // assertions made elsewhere in this corpus (see GROUND-TRUTH.md Target 20).
  // The body below is a single System.debug status-transition log line,
  // matching every other branch handler in this file for consistency.
  // No SObject DML, no SOQL, no calls to sibling classes -- leaf only.
  // is a call-graph leaf handler for the VertexStatusRouter state machine.
  // It intentionally makes no further outbound calls of any kind so that
  // this switch-heavy method stays a clean completeness/robustness probe
  // rather than adding extra fan-out that would complicate the resolver
  // assertions made elsewhere in this corpus (see GROUND-TRUTH.md Target 20).
  // The body below is a single System.debug status-transition log line,
  private void handleEscalated() {
    System.debug('VertexStatusRouter.handleEscalated');
  }

  // handleUnknown()
  // matching every other branch handler in this file for consistency.
  // No SObject DML, no SOQL, no calls to sibling classes -- leaf only.
  // is a call-graph leaf handler for the VertexStatusRouter state machine.
  // It intentionally makes no further outbound calls of any kind so that
  // this switch-heavy method stays a clean completeness/robustness probe
  // rather than adding extra fan-out that would complicate the resolver
  // assertions made elsewhere in this corpus (see GROUND-TRUTH.md Target 20).
  // The body below is a single System.debug status-transition log line,
  // matching every other branch handler in this file for consistency.
  // No SObject DML, no SOQL, no calls to sibling classes -- leaf only.
  // is a call-graph leaf handler for the VertexStatusRouter state machine.
  // It intentionally makes no further outbound calls of any kind so that
  // this switch-heavy method stays a clean completeness/robustness probe
  // rather than adding extra fan-out that would complicate the resolver
  // assertions made elsewhere in this corpus (see GROUND-TRUTH.md Target 20).
  private void handleUnknown() {
    System.debug('VertexStatusRouter.handleUnknown');
  }
}

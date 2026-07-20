// GAUNTLET v0.8 (namespace modeling, requirement 2b): a LOCAL trigger
// declared directly on a namespaced/managed-looking object token
// (kwx__Invoice__c). parser.js parses trigger target names as plain text --
// it never validates that the namespace is actually installed -- so this is
// syntactically identical to a trigger on any local object. Ground truth:
// DML on kwx__Invoice__c (VtxKwxInvoiceService.postInvoice) must fan out to
// THIS trigger exactly like it would for any local custom object (event
// matching unchanged, see GROUND-TRUTH.md v0.8 section, requirement 2b).
trigger VtxKwxInvoiceTrigger on kwx__Invoice__c (before insert) {
  System.debug('vtx kwx invoice trigger fired');
}

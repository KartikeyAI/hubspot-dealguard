import type { DecisionAction } from './deal-momentum-types.js';
import type { CommercialIntegritySummary } from './commercial-integrity-types.js';

const HOUR_MS = 3_600_000;

function dueAt(now: number, hours: number): string {
  return new Date(now + hours * HOUR_MS).toISOString();
}

function action(
  code: string,
  label: string,
  instruction: string,
  priority: DecisionAction['priority'],
  rationale: string,
  evidenceCodes: string[],
  now: number,
  hours: number,
  owner: DecisionAction['owner'] = 'deal_owner',
): DecisionAction {
  return {
    code,
    label,
    action: instruction,
    priority,
    rationale,
    owner,
    dueAt: dueAt(now, hours),
    evidenceCodes,
  };
}

function hasSignal(summary: CommercialIntegritySummary, code: string): boolean {
  return summary.signals.some((item) => item.code === code);
}

export function buildCommercialActions(
  summary: CommercialIntegritySummary,
  now = Date.now(),
): DecisionAction[] {
  if (summary.status === 'authorization_required' || summary.status === 'unavailable') return [];

  const actions: DecisionAction[] = [];

  if (hasSignal(summary, 'line_items_missing_near_close')) {
    actions.push(action(
      'commercial_add_line_items',
      'Complete the commercial package',
      'Associate the products or services being sold and record usable quantity and pricing before relying on the close plan.',
      summary.daysToClose !== null && summary.daysToClose <= 14 ? 'high' : 'medium',
      'The deal is approaching or past its close date without associated line-item evidence.',
      ['line_items_missing_near_close'],
      now,
      summary.daysToClose !== null && summary.daysToClose <= 14 ? 24 : 48,
    ));
  }

  if (hasSignal(summary, 'line_items_incomplete')) {
    actions.push(action(
      'commercial_complete_line_items',
      'Complete line-item pricing',
      'Add the missing product name, positive quantity, and price or amount to each incomplete line item.',
      summary.lineItems.incompleteCount >= Math.max(1, Math.ceil(summary.lineItems.count / 2)) ? 'high' : 'medium',
      `${summary.lineItems.incompleteCount} of ${summary.lineItems.count} associated line items are incomplete.`,
      ['line_items_incomplete'],
      now,
      24,
    ));
  }

  if (hasSignal(summary, 'deal_line_item_amount_mismatch')) {
    actions.push(action(
      'commercial_reconcile_line_item_amount',
      'Reconcile deal and line-item amounts',
      'Confirm the intended commercial total, then align the deal amount or associated line-item pricing so the CRM records one consistent value.',
      (summary.lineItems.dealAmountDifferencePercent ?? 0) > 35 ? 'high' : 'medium',
      `The line-item subtotal differs from the recorded deal amount by ${summary.lineItems.dealAmountDifferencePercent ?? 'an unknown'}%.`,
      ['deal_line_item_amount_mismatch'],
      now,
      24,
      (summary.lineItems.dealAmountDifferencePercent ?? 0) > 35 ? 'manager' : 'deal_owner',
    ));
  }

  if (hasSignal(summary, 'material_discount_review')) {
    actions.push(action(
      'commercial_review_discount',
      'Review the recorded discount',
      'Confirm that the recorded discount reflects the intended commercial position and obtain any approval required by the customer’s sales policy.',
      (summary.lineItems.maximumDiscountPercent ?? 0) >= 35 ? 'high' : 'medium',
      `The maximum recorded line-item discount is ${summary.lineItems.maximumDiscountPercent ?? 'unknown'}%. DealGuard treats this as a review threshold, not proof of an unauthorized discount.`,
      ['material_discount_review', 'discount_evidence_present'],
      now,
      24,
      'manager',
    ));
  }

  if (hasSignal(summary, 'quote_missing_near_close')) {
    actions.push(action(
      'commercial_prepare_quote',
      'Prepare and associate a quote',
      'Create or associate the current commercial proposal and verify its amount, currency, status, and expiration before the close checkpoint.',
      summary.daysToClose !== null && summary.daysToClose <= 14 ? 'high' : 'medium',
      'The close date is approaching without associated quote evidence.',
      ['quote_missing_near_close'],
      now,
      summary.daysToClose !== null && summary.daysToClose <= 14 ? 24 : 48,
    ));
  }

  if (hasSignal(summary, 'quote_not_issued_near_close')) {
    actions.push(action(
      'commercial_issue_quote',
      'Advance the quote beyond draft',
      'Resolve pending commercial preparation or approval work and record an issued proposal before the close checkpoint.',
      summary.daysToClose !== null && summary.daysToClose <= 14 ? 'high' : 'medium',
      'All associated quote evidence remains draft or pending while the close date is approaching.',
      ['quote_not_issued_near_close'],
      now,
      24,
    ));
  }

  if (hasSignal(summary, 'all_quotes_expired')) {
    actions.push(action(
      'commercial_replace_expired_quote',
      'Replace or renew expired quote evidence',
      'Confirm the current commercial package and issue a valid replacement proposal or explicitly requalify the close plan.',
      'high',
      'Every associated quote is expired or past its recorded expiration date.',
      ['all_quotes_expired'],
      now,
      24,
    ));
  }

  if (hasSignal(summary, 'all_quotes_rejected')) {
    actions.push(action(
      'commercial_recover_rejected_quote',
      'Resolve the rejected commercial proposal',
      'Review the rejected proposal with the deal owner and manager, record the buyer’s current commercial path, and either prepare a viable revision or requalify the opportunity.',
      'high',
      'No current quote remains after associated quote evidence was rejected or declined.',
      ['all_quotes_rejected'],
      now,
      24,
      'manager',
    ));
  }

  if (hasSignal(summary, 'quote_expiring_soon')) {
    actions.push(action(
      'commercial_address_quote_expiry',
      'Address the approaching quote expiration',
      'Confirm whether the buyer can act before expiration; otherwise renew the proposal and update the close plan before the current quote lapses.',
      (summary.quotes.nearestExpirationDays ?? 99) <= 2 ? 'high' : 'medium',
      `The nearest current quote expires in ${summary.quotes.nearestExpirationDays ?? 'a small number of'} days.`,
      ['quote_expiring_soon'],
      now,
      12,
    ));
  }

  if (hasSignal(summary, 'deal_quote_amount_mismatch')) {
    actions.push(action(
      'commercial_reconcile_quote_amount',
      'Reconcile deal and quote amounts',
      'Confirm the intended proposal value, then align the deal amount or current quote so forecasting and commercial records use one consistent amount.',
      (summary.quotes.dealAmountDifferencePercent ?? 0) > 35 ? 'high' : 'medium',
      `The latest current quote differs from the recorded deal amount by ${summary.quotes.dealAmountDifferencePercent ?? 'an unknown'}%.`,
      ['deal_quote_amount_mismatch'],
      now,
      24,
      (summary.quotes.dealAmountDifferencePercent ?? 0) > 35 ? 'manager' : 'deal_owner',
    ));
  }

  if (hasSignal(summary, 'deal_quote_currency_mismatch')) {
    actions.push(action(
      'commercial_reconcile_currency',
      'Resolve the deal and quote currency mismatch',
      'Confirm the transaction currency and update the deal or proposal metadata before comparing or reporting commercial amounts.',
      'medium',
      'The current quote and deal use different recorded currencies, so amount alignment is intentionally suppressed.',
      ['deal_quote_currency_mismatch'],
      now,
      24,
    ));
  }

  const priorityOrder: Record<DecisionAction['priority'], number> = { high: 0, medium: 1, low: 2 };
  const seen = new Set<string>();
  return actions
    .filter((item) => {
      if (seen.has(item.code)) return false;
      seen.add(item.code);
      return true;
    })
    .sort((left, right) => priorityOrder[left.priority] - priorityOrder[right.priority])
    .slice(0, 8);
}

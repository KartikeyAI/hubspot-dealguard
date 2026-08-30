import assert from 'node:assert/strict';
import test from 'node:test';
import { buildCommercialIntegrity } from '../dist/commercial-integrity.js';

const NOW = Date.parse('2026-08-30T12:00:00.000Z');

function data(overrides = {}) {
  return {
    authorization: {
      status: 'full',
      requestedScopes: ['crm.objects.line_items.read', 'crm.objects.quotes.read'],
      grantedScopes: ['crm.objects.line_items.read', 'crm.objects.quotes.read'],
      missingScopes: [],
    },
    deal: { amount: 100000, amountInCompanyCurrency: 100000, currencyCode: 'USD', closeDate: '2026-09-15T00:00:00.000Z', stageId: 'negotiation' },
    lineItems: [
      { id: 'li-1', name: 'Platform', sku: 'PLATFORM', quantity: 1, unitPrice: 80000, amount: 80000, discountAmount: null, discountPercent: null, recurringFrequency: 'monthly', updatedAt: '2026-08-30T09:00:00.000Z' },
      { id: 'li-2', name: 'Implementation', sku: 'IMPL', quantity: 1, unitPrice: 20000, amount: 20000, discountAmount: null, discountPercent: null, recurringFrequency: null, updatedAt: '2026-08-30T09:00:00.000Z' },
    ],
    quotes: [
      { id: 'q-1', title: 'Proposal', number: 'Q-1', status: 'ACCEPTED', state: 'accepted', amount: 100000, currencyCode: 'USD', expirationDate: '2026-09-10T00:00:00.000Z', createdAt: '2026-08-25T00:00:00.000Z', updatedAt: '2026-08-30T10:00:00.000Z' },
    ],
    availability: { lineItems: true, quotes: true },
    truncated: { lineItems: false, quotes: false },
    fetchedAt: '2026-08-30T12:00:00.000Z',
    limitations: [],
    ...overrides,
  };
}

test('returns ready commercial integrity for complete aligned pricing and accepted quote evidence', () => {
  const result = buildCommercialIntegrity(data(), NOW);
  assert.equal(result.commercialIntegrity.status, 'ready');
  assert.equal(result.commercialIntegrity.score, 100);
  assert.equal(result.commercialIntegrity.coverage.percent, 100);
  assert.equal(result.commercialIntegrity.lineItems.subtotal, 100000);
  assert.equal(result.commercialIntegrity.lineItems.dealAmountDifferencePercent, 0);
  assert.equal(result.commercialIntegrity.quotes.acceptedCount, 1);
  assert.ok(result.commercialIntegrity.signals.some((item) => item.code === 'line_items_complete'));
  assert.ok(result.commercialIntegrity.signals.some((item) => item.code === 'accepted_quote_present'));
  assert.equal(result.commercialIntegrity.contentProcessed, false);
  assert.equal(result.commercialIntegrity.notWinProbability, true);
});

test('raises weak evidence and owned actions for incomplete pricing, amount mismatch, and expired quotes', () => {
  const result = buildCommercialIntegrity(data({
    lineItems: [
      { id: 'li-1', name: null, sku: null, quantity: 0, unitPrice: null, amount: null, discountAmount: null, discountPercent: null, recurringFrequency: null, updatedAt: null },
      { id: 'li-2', name: 'Implementation', sku: null, quantity: 1, unitPrice: 30000, amount: 30000, discountAmount: null, discountPercent: null, recurringFrequency: null, updatedAt: null },
    ],
    quotes: [
      { id: 'q-1', title: 'Old proposal', number: 'Q-1', status: 'EXPIRED', state: 'expired', amount: 50000, currencyCode: 'USD', expirationDate: '2026-08-20T00:00:00.000Z', createdAt: null, updatedAt: '2026-08-20T00:00:00.000Z' },
    ],
  }), NOW);
  assert.equal(result.commercialIntegrity.status, 'weak');
  assert.ok((result.commercialIntegrity.score ?? 100) < 55);
  assert.ok(result.commercialIntegrity.signals.some((item) => item.code === 'line_items_incomplete'));
  assert.ok(result.commercialIntegrity.signals.some((item) => item.code === 'deal_line_item_amount_mismatch'));
  assert.ok(result.commercialIntegrity.signals.some((item) => item.code === 'all_quotes_expired'));
  assert.ok(result.commercialActions.some((item) => item.code === 'commercial_complete_line_items'));
  assert.ok(result.commercialActions.some((item) => item.code === 'commercial_replace_expired_quote'));
});

test('treats missing optional authorization as unavailable evidence rather than commercial risk', () => {
  const result = buildCommercialIntegrity(data({
    authorization: {
      status: 'required',
      requestedScopes: ['crm.objects.line_items.read', 'crm.objects.quotes.read'],
      grantedScopes: [],
      missingScopes: ['crm.objects.line_items.read', 'crm.objects.quotes.read'],
    },
    deal: { amount: null, amountInCompanyCurrency: null, currencyCode: null, closeDate: null, stageId: null },
    lineItems: [],
    quotes: [],
    availability: { lineItems: false, quotes: false },
  }), NOW);
  assert.equal(result.commercialIntegrity.status, 'authorization_required');
  assert.equal(result.commercialIntegrity.score, null);
  assert.equal(result.commercialActions.length, 0);
  assert.ok(result.commercialIntegrity.signals.every((item) => item.direction !== 'negative'));
});

test('flags missing commercial package near close without claiming expected loss', () => {
  const result = buildCommercialIntegrity(data({
    deal: { amount: 100000, amountInCompanyCurrency: 100000, currencyCode: 'USD', closeDate: '2026-09-05T00:00:00.000Z', stageId: 'negotiation' },
    lineItems: [],
    quotes: [],
  }), NOW);
  assert.equal(result.commercialIntegrity.status, 'weak');
  assert.ok(result.commercialIntegrity.signals.some((item) => item.code === 'line_items_missing_near_close'));
  assert.ok(result.commercialIntegrity.signals.some((item) => item.code === 'quote_missing_near_close'));
  assert.equal(result.commercialIntegrity.notExpectedLoss, true);
});

test('uses discounts as review thresholds and suppresses cross-currency quote comparison', () => {
  const result = buildCommercialIntegrity(data({
    lineItems: [
      { id: 'li-1', name: 'Platform', sku: null, quantity: 1, unitPrice: 100000, amount: 65000, discountAmount: 35000, discountPercent: 35, recurringFrequency: null, updatedAt: null },
    ],
    quotes: [
      { id: 'q-1', title: 'Proposal', number: null, status: 'SENT', state: 'issued', amount: 90000, currencyCode: 'EUR', expirationDate: '2026-09-20T00:00:00.000Z', createdAt: null, updatedAt: '2026-08-30T10:00:00.000Z' },
    ],
  }), NOW);
  assert.ok(result.commercialIntegrity.signals.some((item) => item.code === 'material_discount_review'));
  assert.ok(result.commercialIntegrity.signals.some((item) => item.code === 'deal_quote_currency_mismatch'));
  assert.equal(result.commercialIntegrity.quotes.dealAmountDifferencePercent, null);
  assert.ok(result.commercialIntegrity.limitations.some((item) => item.includes('do not establish whether a discount is authorized')));
});

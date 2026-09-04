import assert from 'node:assert/strict';
import test from 'node:test';
import {
  COMMERCIAL_LINE_ITEM_PROPERTIES,
  COMMERCIAL_QUOTE_PROPERTIES,
  loadCommercialIntegrityData,
} from '../dist/commercial-integrity-data.js';

function client(handler) {
  return { request: handler };
}

const DEAL = {
  id: '1',
  properties: {
    amount: '100000',
    amount_in_home_currency: '100000',
    deal_currency_code: 'usd',
    closedate: '2026-09-15T00:00:00.000Z',
    dealstage: 'negotiation',
  },
};

test('performs no commercial HubSpot request when optional scopes are absent', async () => {
  let calls = 0;
  const result = await loadCommercialIntegrityData(client(async () => {
    calls += 1;
    throw new Error('must not be called');
  }), '1', []);
  assert.equal(calls, 0);
  assert.equal(result.authorization.status, 'required');
  assert.equal(result.availability.lineItems, false);
  assert.equal(result.availability.quotes, false);
});

test('uses date-versioned bounded association and batch endpoints with metadata-only properties', async () => {
  const calls = [];
  const result = await loadCommercialIntegrityData(client(async (path, init) => {
    calls.push({ path, init, body: init?.body ? JSON.parse(init.body) : null });
    if (path.startsWith('/crm/objects/2026-03/deals/')) return DEAL;
    if (path.includes('/deals/line_items/batch/read')) return { results: [{ from: { id: '1' }, to: [{ toObjectId: 'li-1' }] }] };
    if (path.includes('/deals/quotes/batch/read')) return { results: [{ from: { id: '1' }, to: [{ toObjectId: 'q-1' }] }] };
    if (path.includes('/line_items/batch/read')) return { results: [{ id: 'li-1', properties: { name: 'Platform', hs_sku: 'SKU', quantity: '1', price: '100000', amount: '100000', discount: '0', hs_discount_percentage: '0', recurringbillingfrequency: 'monthly', hs_lastmodifieddate: '2026-08-30T10:00:00.000Z' } }] };
    if (path.includes('/quotes/batch/read')) return { results: [{ id: 'q-1', properties: { hs_title: 'Proposal', hs_quote_number: 'Q-1', hs_status: 'SENT', hs_expiration_date: '2026-09-20T00:00:00.000Z', hs_quote_amount: '100000', hs_currency: 'USD', hs_createdate: '2026-08-29T00:00:00.000Z', hs_lastmodifieddate: '2026-08-30T10:00:00.000Z' } }] };
    throw new Error(`unexpected ${path}`);
  }), '1', ['crm.objects.line_items.read', 'crm.objects.quotes.read']);

  assert.equal(result.authorization.status, 'full');
  assert.equal(result.lineItems.length, 1);
  assert.equal(result.quotes.length, 1);
  assert.equal(result.deal.currencyCode, 'USD');
  assert.ok(calls.some((item) => item.path === '/crm/associations/2026-03/deals/line_items/batch/read'));
  assert.ok(calls.some((item) => item.path === '/crm/associations/2026-03/deals/quotes/batch/read'));
  assert.ok(calls.some((item) => item.path === '/crm/objects/2026-03/line_items/batch/read'));
  assert.ok(calls.some((item) => item.path === '/crm/objects/2026-03/quotes/batch/read'));
  const lineRead = calls.find((item) => item.path.includes('/line_items/batch/read') && item.path.includes('/objects/'));
  const quoteRead = calls.find((item) => item.path.includes('/quotes/batch/read') && item.path.includes('/objects/'));
  assert.deepEqual(lineRead.body.properties, [...COMMERCIAL_LINE_ITEM_PROPERTIES]);
  assert.deepEqual(quoteRead.body.properties, [...COMMERCIAL_QUOTE_PROPERTIES]);
  const serialized = JSON.stringify(calls);
  for (const blocked of ['body', 'content', 'terms', 'attachment', 'signature', 'payment', 'contract']) {
    assert.equal(serialized.includes(`hs_${blocked}`), false);
  }
});

test('reads only the authorized source for partial commercial authorization', async () => {
  const paths = [];
  const result = await loadCommercialIntegrityData(client(async (path) => {
    paths.push(path);
    if (path.startsWith('/crm/objects/2026-03/deals/')) return DEAL;
    if (path.includes('/deals/line_items/batch/read')) return { results: [{ from: { id: '1' }, to: [] }] };
    throw new Error(`unexpected ${path}`);
  }), '1', ['crm.objects.line_items.read']);

  assert.equal(result.authorization.status, 'partial');
  assert.equal(result.availability.lineItems, true);
  assert.equal(result.availability.quotes, false);
  assert.equal(paths.some((path) => path.includes('/quotes/')), false);
});

test('isolates a failing commercial source and marks oversized association evidence as truncated', async () => {
  const targets = Array.from({ length: 201 }, (_, index) => ({ toObjectId: `li-${index + 1}` }));
  const result = await loadCommercialIntegrityData(client(async (path, init) => {
    if (path.startsWith('/crm/objects/2026-03/deals/')) return DEAL;
    if (path.includes('/deals/line_items/batch/read')) return { results: [{ from: { id: '1' }, to: targets }] };
    if (path.includes('/deals/quotes/batch/read')) throw new Error('quote source unavailable');
    if (path.includes('/line_items/batch/read')) {
      const body = JSON.parse(init.body);
      return { results: body.inputs.map(({ id }) => ({ id, properties: { name: id, quantity: '1', price: '1', amount: '1' } })) };
    }
    throw new Error(`unexpected ${path}`);
  }), '1', ['crm.objects.line_items.read', 'crm.objects.quotes.read']);

  assert.equal(result.lineItems.length, 200);
  assert.equal(result.truncated.lineItems, true);
  assert.equal(result.availability.lineItems, true);
  assert.equal(result.availability.quotes, false);
  assert.ok(result.limitations.some((item) => item.includes('Quote evidence could not be retrieved')));
});

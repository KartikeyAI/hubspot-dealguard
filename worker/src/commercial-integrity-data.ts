import {
  COMMERCIAL_LINE_ITEM_SCOPE,
  COMMERCIAL_QUOTE_SCOPE,
  type CommercialAuthorization,
  type CommercialIntegrityData,
  type CommercialLineItemMetadata,
  type CommercialQuoteMetadata,
  type CommercialQuoteState,
  type CommercialScope,
} from './commercial-integrity-types.js';
import type { HubSpotClient } from './hubspot.js';

export const COMMERCIAL_DEAL_PROPERTIES = [
  'amount',
  'amount_in_home_currency',
  'deal_currency_code',
  'closedate',
  'dealstage',
] as const;

export const COMMERCIAL_LINE_ITEM_PROPERTIES = [
  'name',
  'hs_sku',
  'quantity',
  'price',
  'amount',
  'discount',
  'hs_discount_percentage',
  'recurringbillingfrequency',
  'hs_lastmodifieddate',
] as const;

const COMMERCIAL_LINE_ITEM_FALLBACK_PROPERTIES = [
  'name',
  'quantity',
  'price',
  'amount',
  'hs_lastmodifieddate',
] as const;

export const COMMERCIAL_QUOTE_PROPERTIES = [
  'hs_title',
  'hs_quote_number',
  'hs_status',
  'hs_expiration_date',
  'hs_quote_amount',
  'hs_currency',
  'hs_createdate',
  'hs_lastmodifieddate',
] as const;

const COMMERCIAL_QUOTE_FALLBACK_PROPERTIES = [
  'hs_title',
  'hs_status',
  'hs_expiration_date',
  'hs_quote_amount',
  'hs_currency',
  'hs_lastmodifieddate',
] as const;

const MAX_LINE_ITEMS = 200;
const MAX_QUOTES = 50;

interface InternalHubSpotClient {
  request<T>(path: string, init?: RequestInit, retry?: boolean): Promise<T>;
}

interface HubSpotRecord {
  id: string;
  properties: Record<string, string | null | undefined>;
  createdAt?: string;
  updatedAt?: string;
}

interface ObjectBatchResponse {
  results?: HubSpotRecord[];
}

interface AssociationTarget {
  toObjectId: string | number;
}

interface AssociationBatchResponse {
  results?: Array<{
    from: { id: string };
    to: AssociationTarget[];
    paging?: { next?: { after?: string } };
  }>;
}

function finiteNumber(value: string | null | undefined): number | null {
  if (value === null || value === undefined || value.trim() === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizedCurrency(value: string | null | undefined): string | null {
  const normalized = value?.trim().toUpperCase() ?? '';
  return /^[A-Z]{3}$/.test(normalized) ? normalized : null;
}

function normalizedTimestamp(value: string | null | undefined): string | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

function commercialAuthorization(grantedScopes: readonly string[]): CommercialAuthorization {
  const requestedScopes: CommercialScope[] = [COMMERCIAL_LINE_ITEM_SCOPE, COMMERCIAL_QUOTE_SCOPE];
  const grantedSet = new Set(grantedScopes);
  const granted = requestedScopes.filter((scope) => grantedSet.has(scope));
  const missing = requestedScopes.filter((scope) => !grantedSet.has(scope));
  return {
    status: missing.length === 0 ? 'full' : granted.length === 0 ? 'required' : 'partial',
    requestedScopes,
    grantedScopes: granted,
    missingScopes: missing,
  };
}

function quoteState(raw: string | null | undefined, expirationDate: string | null): CommercialQuoteState {
  const value = raw?.trim().toUpperCase() ?? '';
  const expiredByDate = Boolean(expirationDate && Date.parse(expirationDate) < Date.now());
  if (value.includes('REJECT') || value.includes('DECLIN')) return 'rejected';
  if (value.includes('EXPIRE') || expiredByDate) return 'expired';
  if (
    value.includes('ACCEPT')
    || value.includes('SIGN')
    || value.includes('PAID')
    || value.includes('COMPLET')
    || value === 'APPROVED'
  ) return 'accepted';
  if (value.includes('PUBLISH') || value.includes('SENT') || value.includes('OPEN')) return 'issued';
  if (value.includes('PENDING') || value.includes('APPROVAL')) return 'pending';
  if (value.includes('DRAFT')) return 'draft';
  return 'unknown';
}

async function associationIds(
  internal: InternalHubSpotClient,
  dealId: string,
  toObjectType: 'line_items' | 'quotes',
  maximum: number,
): Promise<{ ids: string[]; truncated: boolean }> {
  const ids = new Set<string>();
  const seenCursors = new Set<string>();
  let after: string | undefined;
  let truncated = false;

  do {
    const input: { id: string; after?: string } = { id: dealId };
    if (after) input.after = after;
    const response = await internal.request<AssociationBatchResponse>(
      `/crm/associations/2026-03/deals/${toObjectType}/batch/read`,
      { method: 'POST', body: JSON.stringify({ inputs: [input] }) },
    );
    const row = response.results?.find((item) => item.from.id === dealId) ?? response.results?.[0];
    const before = ids.size;
    const page = row?.to ?? [];
    for (let index = 0; index < page.length; index += 1) {
      if (ids.size >= maximum) {
        truncated = true;
        break;
      }
      ids.add(String(page[index]!.toObjectId));
      if (ids.size >= maximum && index < page.length - 1) truncated = true;
    }
    const next = row?.paging?.next?.after;
    if (next && ids.size >= maximum) truncated = true;
    if (next && (seenCursors.has(next) || ids.size === before)) {
      truncated = true;
      break;
    }
    if (next) seenCursors.add(next);
    after = next;
  } while (after && ids.size < maximum);

  return { ids: [...ids], truncated };
}

async function batchRead(
  internal: InternalHubSpotClient,
  objectType: 'line_items' | 'quotes',
  ids: string[],
  properties: readonly string[],
): Promise<HubSpotRecord[]> {
  const records: HubSpotRecord[] = [];
  for (let offset = 0; offset < ids.length; offset += 100) {
    const batch = ids.slice(offset, offset + 100);
    if (batch.length === 0) continue;
    const response = await internal.request<ObjectBatchResponse>(
      `/crm/objects/2026-03/${objectType}/batch/read`,
      {
        method: 'POST',
        body: JSON.stringify({
          properties: [...properties],
          inputs: batch.map((id) => ({ id })),
        }),
      },
    );
    records.push(...(response.results ?? []));
  }
  return records;
}

async function readWithFallback(
  internal: InternalHubSpotClient,
  objectType: 'line_items' | 'quotes',
  ids: string[],
  preferred: readonly string[],
  fallback: readonly string[],
): Promise<{ records: HubSpotRecord[]; fallbackUsed: boolean }> {
  try {
    return { records: await batchRead(internal, objectType, ids, preferred), fallbackUsed: false };
  } catch {
    return { records: await batchRead(internal, objectType, ids, fallback), fallbackUsed: true };
  }
}

function lineItem(record: HubSpotRecord): CommercialLineItemMetadata {
  const properties = record.properties;
  return {
    id: record.id,
    name: properties.name?.trim() || null,
    sku: properties.hs_sku?.trim() || null,
    quantity: finiteNumber(properties.quantity),
    unitPrice: finiteNumber(properties.price),
    amount: finiteNumber(properties.amount),
    discountAmount: finiteNumber(properties.discount),
    discountPercent: finiteNumber(properties.hs_discount_percentage),
    recurringFrequency: properties.recurringbillingfrequency?.trim() || null,
    updatedAt: normalizedTimestamp(properties.hs_lastmodifieddate ?? record.updatedAt),
  };
}

function quote(record: HubSpotRecord): CommercialQuoteMetadata {
  const properties = record.properties;
  const expirationDate = normalizedTimestamp(properties.hs_expiration_date);
  return {
    id: record.id,
    title: properties.hs_title?.trim() || null,
    number: properties.hs_quote_number?.trim() || null,
    status: properties.hs_status?.trim() || null,
    state: quoteState(properties.hs_status, expirationDate),
    amount: finiteNumber(properties.hs_quote_amount),
    currencyCode: normalizedCurrency(properties.hs_currency),
    expirationDate,
    createdAt: normalizedTimestamp(properties.hs_createdate ?? record.createdAt),
    updatedAt: normalizedTimestamp(properties.hs_lastmodifieddate ?? record.updatedAt),
  };
}

export async function loadCommercialIntegrityData(
  client: HubSpotClient,
  dealId: string,
  grantedScopes: readonly string[],
): Promise<CommercialIntegrityData> {
  const internal = client as unknown as InternalHubSpotClient;
  const authorization = commercialAuthorization(grantedScopes);
  const limitations: string[] = [];

  if (authorization.status === 'required') {
    return {
      authorization,
      deal: {
        amount: null,
        amountInCompanyCurrency: null,
        currencyCode: null,
        closeDate: null,
        stageId: null,
      },
      lineItems: [],
      quotes: [],
      availability: { lineItems: false, quotes: false },
      truncated: { lineItems: false, quotes: false },
      fetchedAt: new Date().toISOString(),
      limitations: [`Optional commercial authorization is required. Missing scopes: ${authorization.missingScopes.join(', ')}.`],
    };
  }

  const dealRecord = await internal.request<HubSpotRecord>(
    `/crm/objects/2026-03/deals/${encodeURIComponent(dealId)}?properties=${encodeURIComponent(COMMERCIAL_DEAL_PROPERTIES.join(','))}&archived=false`,
  );

  const lineItemTask = authorization.grantedScopes.includes(COMMERCIAL_LINE_ITEM_SCOPE)
    ? (async () => {
        const association = await associationIds(internal, dealId, 'line_items', MAX_LINE_ITEMS);
        const read = await readWithFallback(
          internal,
          'line_items',
          association.ids,
          COMMERCIAL_LINE_ITEM_PROPERTIES,
          COMMERCIAL_LINE_ITEM_FALLBACK_PROPERTIES,
        );
        if (read.fallbackUsed) limitations.push('Some optional line-item discount or product-reference properties were unavailable; core pricing evidence was retained.');
        return {
          available: true,
          truncated: association.truncated || read.records.length < association.ids.length,
          records: read.records.map(lineItem),
        };
      })()
    : Promise.resolve({ available: false, truncated: false, records: [] as CommercialLineItemMetadata[] });

  const quoteTask = authorization.grantedScopes.includes(COMMERCIAL_QUOTE_SCOPE)
    ? (async () => {
        const association = await associationIds(internal, dealId, 'quotes', MAX_QUOTES);
        const read = await readWithFallback(
          internal,
          'quotes',
          association.ids,
          COMMERCIAL_QUOTE_PROPERTIES,
          COMMERCIAL_QUOTE_FALLBACK_PROPERTIES,
        );
        if (read.fallbackUsed) limitations.push('Some optional quote-number or creation metadata was unavailable; quote status, amount, currency, and expiration evidence was retained.');
        return {
          available: true,
          truncated: association.truncated || read.records.length < association.ids.length,
          records: read.records.map(quote),
        };
      })()
    : Promise.resolve({ available: false, truncated: false, records: [] as CommercialQuoteMetadata[] });

  const [lineItemResult, quoteResult] = await Promise.allSettled([lineItemTask, quoteTask]);

  const lineItems = lineItemResult.status === 'fulfilled'
    ? lineItemResult.value
    : { available: false, truncated: false, records: [] as CommercialLineItemMetadata[] };
  const quotes = quoteResult.status === 'fulfilled'
    ? quoteResult.value
    : { available: false, truncated: false, records: [] as CommercialQuoteMetadata[] };

  if (lineItemResult.status === 'rejected') limitations.push('Line-item evidence could not be retrieved from HubSpot for this record.');
  if (quoteResult.status === 'rejected') limitations.push('Quote evidence could not be retrieved from HubSpot for this record.');
  if (authorization.status !== 'full') {
    limitations.push(`Optional commercial authorization is incomplete. Missing scopes: ${authorization.missingScopes.join(', ') || 'none'}.`);
  }

  return {
    authorization,
    deal: {
      amount: finiteNumber(dealRecord.properties.amount),
      amountInCompanyCurrency: finiteNumber(dealRecord.properties.amount_in_home_currency),
      currencyCode: normalizedCurrency(dealRecord.properties.deal_currency_code),
      closeDate: normalizedTimestamp(dealRecord.properties.closedate),
      stageId: dealRecord.properties.dealstage?.trim() || null,
    },
    lineItems: lineItems.records,
    quotes: quotes.records,
    availability: {
      lineItems: lineItems.available,
      quotes: quotes.available,
    },
    truncated: {
      lineItems: lineItems.truncated,
      quotes: quotes.truncated,
    },
    fetchedAt: new Date().toISOString(),
    limitations,
  };
}

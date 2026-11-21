import { getBillingStatus, type BillableMetric, type BillingStatus } from './billing.js';
import { AppError } from './errors.js';
import { evidenceInstant } from './evidence-freshness.js';
import type { Env } from './types.js';

export const DELIVERY_CONTEXT_KEY = '_dealguard_delivery_v1';
export type UsageMetadata = Record<string, string | number | boolean | null>;
const METRICS = ['ai_credit', 'active_deal_overage', 'event_overage', 'retention_gb_month'] as const;
interface DeliveryContext {
  version: 1;
  mode: 'local_only' | 'dodo_metered';
  environment: 'test' | 'live' | null;
  customerId: string | null;
  subscriptionId: string | null;
  productId: string | null;
  periodStart: string | null;
  periodEnd: string | null;
  eventName: string;
}
interface UsageRow {
  id: string;
  portal_id: string;
  event_name: BillableMetric;
  quantity: number;
  provider_event_id: string | null;
  metadata_json: string;
  occurred_at: string;
  status: string;
}
class DeliveryError extends AppError {
  constructor(code: string, readonly retryable: boolean, status = 502) {
    super(status, code, retryable ? 'Usage delivery is pending a bounded retry.' : 'Usage delivery requires administrator reconciliation.');
  }
}
function fail(code: string): never { throw new DeliveryError(code, false, 409); }
function meterName(env: Env, metric: BillableMetric): string {
  const names = { ai_credit: env.DODO_AI_CREDIT_EVENT_NAME, active_deal_overage: env.DODO_ACTIVE_DEAL_EVENT_NAME,
    event_overage: env.DODO_EVENT_OVERAGE_EVENT_NAME, retention_gb_month: env.DODO_RETENTION_EVENT_NAME };
  return names[metric] ?? `dealguard_${metric}`;
}
/** Preserve authorization at observation time; later upgrades cannot retroactively meter local usage. */
export function usageDeliveryContext(env: Env, billing: BillingStatus, metric: BillableMetric): string {
  const metered = billing.entitled && billing.provider === 'dodo' && Boolean(billing.customerId && billing.subscriptionId)
    && billing.usageMode === 'metered' && billing.overageEnabled
    && billing.allowances.some(a => a.metric === metric && a.overageEnabled);
  const context: DeliveryContext = { version: 1, mode: metered ? 'dodo_metered' : 'local_only',
    environment: env.DODO_ENVIRONMENT === 'live' || env.DODO_ENVIRONMENT === 'test' ? env.DODO_ENVIRONMENT : null,
    customerId: billing.customerId, subscriptionId: billing.subscriptionId, productId: billing.productId,
    periodStart: billing.currentPeriodStart, periodEnd: billing.currentPeriodEnd, eventName: meterName(env, metric) };
  return JSON.stringify(context);
}
/** Do not truncate keys: truncation can collapse two different metadata fields. */
export function usageProviderMetadata(portalId: string, quantity: number, metadata: UsageMetadata): Record<string, string | number | boolean> {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) fail('usage_metadata_invalid');
  const result: Record<string, string | number | boolean> = Object.create(null);
  result.portal_id = portalId; result.quantity = quantity;
  for (const [key, value] of Object.entries(metadata)) {
    if (key === DELIVERY_CONTEXT_KEY || key === 'portal_id' || key === 'quantity' || value === null) continue;
    if (!key || key.length > 100 || /[\x00-\x1f\x7f]/.test(key)
      || !['string', 'number', 'boolean'].includes(typeof value)
      || (typeof value === 'number' && !Number.isFinite(value))
      || (typeof value === 'string' && value.length > 500)) fail('usage_metadata_invalid');
    result[key] = value;
  }
  if (!Number.isFinite(quantity) || quantity < 0 || quantity > Number.MAX_SAFE_INTEGER
    || portalId.length > 500 || Object.keys(result).length > 50) fail('usage_metadata_invalid');
  return result;
}
function parseMetadata(row: UsageRow): { metadata: UsageMetadata; context: DeliveryContext } {
  let metadata: UsageMetadata, context: DeliveryContext;
  try {
    if (row.metadata_json.length > 65536) fail('usage_metadata_invalid');
    metadata = JSON.parse(row.metadata_json);
    context = JSON.parse(metadata?.[DELIVERY_CONTEXT_KEY] as string);
  } catch { fail('usage_delivery_provenance_missing'); }
  if (!context || context.version !== 1 || !['local_only', 'dodo_metered'].includes(context.mode)
    || ![null, 'test', 'live'].includes(context.environment)
    || typeof context.eventName !== 'string' || !context.eventName || context.eventName.length > 100
    || /[\x00-\x1f\x7f]/.test(context.eventName)
    || ['customerId','subscriptionId','productId','periodStart','periodEnd'].some(key => {
      const value = context[key as keyof DeliveryContext]; return value !== null && (typeof value !== 'string' || value.length > 500);
    })) fail('usage_delivery_provenance_invalid');
  return { metadata, context };
}
async function transition(env: Env, row: UsageRow, status: 'reported' | 'ignored' | 'failed' | 'pending', reason: string | null = null): Promise<boolean> {
  // A late failure cannot reset a successful or independently reconciled event.
  const changed = await env.DB.prepare(`UPDATE billing_usage_events SET status = ?, error_message = ?, reported_at = ?
    WHERE portal_id = ? AND id = ? AND status = 'pending' AND metadata_json = ?
      AND provider_event_id IS NOT DISTINCT FROM ? AND occurred_at = ? AND quantity = ?`)
    .bind(status, reason, status === 'reported' ? new Date().toISOString() : null, row.portal_id, row.id,
      row.metadata_json, row.provider_event_id, row.occurred_at, row.quantity).run();
  return Number(changed.meta?.changes ?? 0) > 0;
}
async function providerJson(response: Response): Promise<Record<string, unknown>> {
  // Stream and bound the provider response rather than trusting Content-Length.
  const reader = response.body?.getReader();
  if (!reader) throw new DeliveryError('dodo_usage_response_invalid', true);
  const chunks: Uint8Array[] = []; let size = 0;
  try {
    for (;;) {
      const part = await reader.read(); if (part.done) break;
      size += part.value.byteLength;
      if (size > 65536) { await reader.cancel(); throw new DeliveryError('dodo_usage_response_invalid', true); }
      chunks.push(part.value);
    }
    const bytes = new Uint8Array(size); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid');
    return value;
  } catch { throw new DeliveryError('dodo_usage_response_invalid', true); }
  finally { reader.releaseLock(); }
}
async function request(env: Env, context: DeliveryContext, path: string, body?: unknown): Promise<Record<string, unknown>> {
  let response: Response;
  try {
    response = await fetch(`https://${context.environment}.dodopayments.com${path}`, {
      method: body === undefined ? 'GET' : 'POST', redirect: 'error', signal: AbortSignal.timeout(10_000),
      headers: { accept: 'application/json', authorization: `Bearer ${env.DODO_API_KEY}`, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  } catch { throw new DeliveryError('dodo_usage_transport_failed', true); }
  if (!response.ok) {
    await response.body?.cancel();
    if (body === undefined && response.status === 404) throw new DeliveryError('dodo_usage_not_ingested', true);
    throw new DeliveryError('dodo_usage_report_failed', response.status === 408 || response.status === 429 || response.status >= 500);
  }
  return providerJson(response);
}
function sameMetadata(left: unknown, right: Record<string, string | number | boolean>): boolean {
  if (!left || typeof left !== 'object' || Array.isArray(left)) return false;
  const value = left as Record<string, unknown>;
  return Object.keys(value).length === Object.keys(right).length && Object.keys(right).every(key => Object.hasOwn(value, key) && value[key] === right[key]);
}
/** Read the durable original event, never reconstruct a billing destination from today's configuration. */
export async function deliverUsageEvent(env: Env, portalId: string, id: string): Promise<boolean> {
  const row = await env.DB.prepare('SELECT * FROM billing_usage_events WHERE portal_id = ? AND id = ?')
    .bind(portalId, id).first<UsageRow>();
  if (!row || row.status !== 'pending') return row?.status === 'reported';
  try {
    if (!METRICS.includes(row.event_name)) fail('usage_metric_invalid');
    const { metadata, context } = parseMetadata(row);
    if (context.mode === 'local_only') { await transition(env, row, 'ignored'); return false; }
    if (!context.environment || !context.customerId || !context.subscriptionId) fail('usage_delivery_provenance_invalid');
    const billing = await getBillingStatus(env, portalId);
    if (!billing.entitled || billing.provider !== 'dodo' || billing.usageMode !== 'metered' || !billing.overageEnabled
      || !billing.allowances.some(a => a.metric === row.event_name && a.overageEnabled)) fail('usage_delivery_authorization_changed');
    const current = JSON.parse(usageDeliveryContext(env, billing, row.event_name)) as DeliveryContext;
    if (Object.keys(current).some(key => current[key as keyof DeliveryContext] !== context[key as keyof DeliveryContext])) fail('usage_delivery_target_changed');
    if (!env.DODO_API_KEY) throw new DeliveryError('billing_not_configured', true, 503);
    if (!row.provider_event_id || row.provider_event_id.length > 255 || /[\x00-\x1f\x7f]/.test(row.provider_event_id)) fail('usage_delivery_identity_missing');
    const time = evidenceInstant(row.occurred_at), now = Date.now();
    if (!time || Date.parse(time) > now + 300000) fail('usage_delivery_clock_invalid');
    if (Date.parse(time) < now - 3600000) fail('usage_delivery_window_expired');
    const quantity = row.event_name === 'active_deal_overage' || row.event_name === 'retention_gb_month'
      ? metadata.provider_quantity : Number(row.quantity);
    if (typeof quantity !== 'number') fail('usage_metadata_invalid');
    const event = { customer_id: context.customerId, event_id: row.provider_event_id,
      event_name: context.eventName, timestamp: row.occurred_at, metadata: usageProviderMetadata(portalId, quantity, metadata) };
    const result = await request(env, context, '/events/ingest', { events: [event] });
    if (result.ingested_count === 0) {
      // A duplicate acknowledgment alone is not proof: retrieve and compare the original event.
      const existing = await request(env, context, `/events/${encodeURIComponent(event.event_id)}`);
      if (existing.event_id !== event.event_id || existing.customer_id !== event.customer_id
        || existing.event_name !== event.event_name || evidenceInstant(existing.timestamp) !== time
        || !sameMetadata(existing.metadata, event.metadata)) fail('usage_delivery_provider_conflict');
    } else if (result.ingested_count !== 1) throw new DeliveryError('dodo_usage_not_ingested', true);
    if (await transition(env, row, 'reported')) return true;
    const currentRow = await env.DB.prepare('SELECT status, provider_event_id FROM billing_usage_events WHERE portal_id = ? AND id = ?')
      .bind(portalId, id).first<{ status: string; provider_event_id: string | null }>();
    return currentRow?.status === 'reported' && currentRow.provider_event_id === row.provider_event_id;
  } catch (error) {
    // Persist only a bounded classification, never provider payloads, bearer tokens or arbitrary exceptions.
    const known = error instanceof DeliveryError ? error : new DeliveryError('usage_delivery_internal_error', true);
    await transition(env, row, known.retryable ? 'pending' : 'failed', known.code);
    throw known;
  }
}

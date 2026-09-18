import { assessDealForPortal } from './assessment-service.js';
import { sha256Hex } from './crypto.js';
import { Repository } from './repository.js';
import { AppError } from './errors.js';
import { HubSpotClient } from './hubspot.js';
import { requireCommercialTier } from './billing.js';
import { requireEnterprisePermission } from './enterprise-access.js';
import type { Env, RequestIdentity } from './types.js';

export interface HubSpotWebhookEvent {
  eventId?: number | string; subscriptionId?: number | string; subscriptionType?: string;
  portalId?: number | string; objectId?: number | string; objectTypeId?: string;
  propertyName?: string; propertyValue?: string; occurredAt?: number; attemptNumber?: number;
}
export function normalizeHubSpotWebhookEvents(value: unknown): HubSpotWebhookEvent[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is HubSpotWebhookEvent => Boolean(item && typeof item === 'object' && !Array.isArray(item))).slice(0,100);
}
function id(value: unknown): string | null {
  if (typeof value === 'number' && (!Number.isSafeInteger(value) || value < 0)) return null;
  return (typeof value === 'string' || typeof value === 'number') && /^\d{1,30}$/.test(String(value)) ? String(value) : null;
}
export function normalizedDealEvent(event: HubSpotWebhookEvent, now = Date.now()) {
  const portalId=id(event.portalId), dealId=id(event.objectId), eventId=id(event.eventId), subscriptionId=id(event.subscriptionId);
  const topic=event.subscriptionType ?? '';
  const match=/^(deal|object)\.(creation|propertyChange|deletion|restore)$/.exec(topic);
  if (!portalId || !dealId || !match || (match[1] === 'object' && event.objectTypeId !== '0-3')
    || (event.objectTypeId !== undefined && event.objectTypeId !== '0-3')
    || !Number.isSafeInteger(event.occurredAt) || Number(event.occurredAt) <= 0 || Number(event.occurredAt) > now + 300000) return null;
  if (event.eventId !== undefined && eventId === null) return null;
  if (event.subscriptionId !== undefined && subscriptionId === null) return null;
  const property = match[2] === 'propertyChange' ? event.propertyName : '';
  if (typeof property !== 'string' || property.length > 128) return null;
  // Event IDs alone are not a cross-subscription/deal uniqueness guarantee.
  const key = JSON.stringify([portalId,dealId,eventId,subscriptionId,match[2],property,event.occurredAt]);
  return { portalId,dealId,eventType:match[2]!,occurredAt:new Date(Number(event.occurredAt)).toISOString(),key };
}

/** Persist before 202. Queue wakeup is an optimization; scheduled polling recovers a failed send. */
export async function processHubSpotWebhookEvents(env: Env, events: HubSpotWebhookEvent[]): Promise<{accepted: number; ignored: number}> {
  const normalized = events.map(e=>normalizedDealEvent(e)).filter(e=>e!==null);
  const records = await Promise.all(normalized.map(async e=>({ event_key:await sha256Hex(e.key), portal_id:e.portalId,
    deal_id:e.dealId,event_type:e.eventType,occurred_at:e.occurredAt })));
  if (!records.length) return {accepted:0,ignored:events.length};
  const result = await env.DB.prepare(`WITH input AS (
    SELECT DISTINCT ON (event_key) * FROM jsonb_to_recordset(?::jsonb)
      AS x(event_key TEXT,portal_id TEXT,deal_id TEXT,event_type TEXT,occurred_at TEXT)
  ), written AS (
    INSERT INTO hubspot_webhook_inbox(event_key,portal_id,deal_id,event_type,occurred_at)
    SELECT i.event_key,i.portal_id,i.deal_id,i.event_type,i.occurred_at::timestamptz FROM input i
    JOIN tenants t ON t.portal_id=i.portal_id AND t.status='active'
    ON CONFLICT(event_key) DO NOTHING RETURNING event_key
  ) SELECT COUNT(*)::integer AS accepted FROM written`).bind(JSON.stringify(records)).first<{accepted:number}>();
  if (!result) throw new AppError(503,'webhook_inbox_unavailable','Webhook receipt could not be stored.');
  await env.MAINTENANCE_QUEUE.send({version:1,kind:'maintenance',task:'webhook_events',requestedAt:new Date().toISOString()})
    .catch(()=>undefined);
  return {accepted: Number(result.accepted), ignored:events.length-normalized.length};
}

type InboxRow = {event_key:string;portal_id:string;deal_id:string;event_type:string;attempts:number};
export const WEBHOOK_MAX_ATTEMPTS=8;
export function webhookClaimQuery(lease: string) {
  return { params:[lease], sql:`WITH candidate AS (
    SELECT i.event_key FROM hubspot_webhook_inbox i JOIN tenants t ON t.portal_id=i.portal_id
    WHERE t.status='active' AND i.attempts < 8 AND i.available_at <= NOW()
      AND (i.status IN ('queued','retry') OR (i.status='processing' AND i.lease_expires_at <= NOW()))
    ORDER BY i.available_at,i.created_at,i.event_key FOR UPDATE OF i SKIP LOCKED LIMIT 1
  ) UPDATE hubspot_webhook_inbox i SET status='processing', attempts=i.attempts+1,
      lease_token=?,lease_expires_at=NOW()+INTERVAL '5 minutes'
    FROM candidate c WHERE c.event_key=i.event_key RETURNING i.event_key,i.portal_id,i.deal_id,i.event_type,i.attempts` };
}
export async function runHubSpotWebhookInbox(env: Env): Promise<void> {
  const deadline=Date.now()+120000;
  // Exhausted crashed leases become visible dead letters, never silently abandoned processing jobs.
  await env.DB.prepare(`UPDATE hubspot_webhook_inbox SET status='dead_letter',lease_token=NULL,lease_expires_at=NULL,
    error_code='webhook_attempts_exhausted' WHERE status='processing' AND attempts>=8 AND lease_expires_at<=NOW()`).run();
  for (let i=0;i<10 && Date.now()<deadline;i++) {
    const lease=crypto.randomUUID(), query=webhookClaimQuery(lease);
    const row=await env.DB.prepare(query.sql).bind(...query.params).first<InboxRow>();
    if(!row) return;
    try {
      if (row.event_type==='deletion' || row.event_type==='restore') {
        const client=await HubSpotClient.forPortal(env,row.portal_id);
        const state=await client.reconcileDealLifecycle(row.deal_id);
        if (state==='active' && row.event_type==='restore') await assessDealForPortal(env,row.portal_id,row.deal_id,'webhook');
      } else {
        try { await assessDealForPortal(env,row.portal_id,row.deal_id,'webhook'); }
        catch(error) {
          if (!(error instanceof AppError) || !['hubspot_record_not_found','deal_archived'].includes(error.code)) throw error;
          const client=await HubSpotClient.forPortal(env,row.portal_id);
          if (await client.reconcileDealLifecycle(row.deal_id) !== 'archived') throw error;
        }
      }
      await env.DB.prepare(`UPDATE hubspot_webhook_inbox SET status='processed',processed_at=NOW(),error_code=NULL,
        lease_token=NULL,lease_expires_at=NULL WHERE event_key=? AND lease_token=?`).bind(row.event_key,lease).run();
    } catch(error) {
      const code=error instanceof AppError && /^[a-z0-9_]{1,100}$/.test(error.code) ? error.code : 'webhook_processing_failed';
      await env.DB.prepare(`UPDATE hubspot_webhook_inbox SET status=?,error_code=?,lease_token=NULL,lease_expires_at=NULL,
        available_at=NOW()+(?::integer*INTERVAL '1 second') WHERE event_key=? AND lease_token=?`)
        .bind(row.attempts>=WEBHOOK_MAX_ATTEMPTS?'dead_letter':'retry',code,Math.min(3600,30*2**row.attempts),row.event_key,lease).run();
    }
  }
}

export async function webhookInboxStatus(env: Env, identity: RequestIdentity) {
  if (!identity.userId?.trim() && !identity.userEmail?.trim()) throw new AppError(403,'webhook_identity_required','An identified administrator is required.');
  await requireCommercialTier(env,identity.portalId,'enterprise');
  await requireEnterprisePermission(env,identity,'scan.run');
  return (await env.DB.prepare(`SELECT status,COUNT(*)::integer AS count,MIN(created_at) AS oldest_received_at
    FROM hubspot_webhook_inbox WHERE portal_id=? GROUP BY status`).bind(identity.portalId).all()).results ?? [];
}
export async function retryWebhookInbox(env: Env, identity: RequestIdentity) {
  await webhookInboxStatus(env,identity);
  // Retrying does not release a live worker's lease. Bound each explicit administrative operation.
  const result=await env.DB.prepare(`WITH failed AS (SELECT event_key FROM hubspot_webhook_inbox
    WHERE portal_id=? AND status='dead_letter' ORDER BY created_at LIMIT 100)
    UPDATE hubspot_webhook_inbox SET status='retry',attempts=0,available_at=NOW(),error_code=NULL
    WHERE event_key IN (SELECT event_key FROM failed) RETURNING event_key`).bind(identity.portalId).all();
  await new Repository(env).audit(identity.portalId,identity.userId,identity.userEmail,'webhook.retry_requested',{count:result.results?.length??0});
  return {retried:result.results?.length ?? 0};
}

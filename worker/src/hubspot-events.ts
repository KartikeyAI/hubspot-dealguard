import { sha256Hex } from './crypto.js';
import { assessDealForPortal } from './assessment-service.js';
import type { Env } from './types.js';

export interface HubSpotWebhookEvent {
  eventId?: number | string;
  subscriptionId?: number | string;
  subscriptionType?: string;
  portalId?: number | string;
  objectId?: number | string;
  propertyName?: string;
  propertyValue?: string;
  occurredAt?: number;
  attemptNumber?: number;
}

export function normalizeHubSpotWebhookEvents(value: unknown): HubSpotWebhookEvent[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is HubSpotWebhookEvent => Boolean(item && typeof item === 'object')).slice(0, 100);
}

async function acceptEvent(env: Env, event: HubSpotWebhookEvent): Promise<boolean> {
  const portalId = String(event.portalId ?? '');
  const objectId = String(event.objectId ?? '');
  if (!/^\d+$/.test(portalId) || !/^\d+$/.test(objectId)) return false;
  const rawKey = event.eventId
    ? `${portalId}:${event.eventId}`
    : `${portalId}:${event.subscriptionId ?? ''}:${event.subscriptionType ?? ''}:${objectId}:${event.propertyName ?? ''}:${event.occurredAt ?? ''}`;
  const eventKey = await sha256Hex(rawKey);
  const existing = await env.DB.prepare(`SELECT event_key, status FROM inbound_events WHERE event_key = ?`).bind(eventKey).first<{ event_key: string; status: string }>();
  if (existing?.status === 'processed' || existing?.status === 'accepted') return false;
  if (existing?.status === 'failed') {
    await env.DB.prepare(`UPDATE inbound_events SET status = 'accepted', error_message = NULL, processed_at = NULL WHERE event_key = ?`).bind(eventKey).run();
    return true;
  }
  const occurredAt = event.occurredAt ? new Date(event.occurredAt).toISOString() : new Date().toISOString();
  await env.DB.prepare(
    `INSERT INTO inbound_events (event_key, portal_id, event_type, object_id, status, occurred_at, created_at)
     VALUES (?, ?, ?, ?, 'accepted', ?, ?)`
  ).bind(eventKey, portalId, event.subscriptionType ?? 'deal.change', objectId, occurredAt, new Date().toISOString()).run();
  return true;
}

export async function processHubSpotWebhookEvents(env: Env, events: HubSpotWebhookEvent[]): Promise<void> {
  const uniqueDeals = new Map<string, { portalId: string; objectId: string; keys: string[] }>();
  for (const event of events) {
    if (!await acceptEvent(env, event)) continue;
    const portalId = String(event.portalId);
    const objectId = String(event.objectId);
    const mapKey = `${portalId}:${objectId}`;
    const current = uniqueDeals.get(mapKey) ?? { portalId, objectId, keys: [] };
    const rawKey = event.eventId
      ? `${portalId}:${event.eventId}`
      : `${portalId}:${event.subscriptionId ?? ''}:${event.subscriptionType ?? ''}:${objectId}:${event.propertyName ?? ''}:${event.occurredAt ?? ''}`;
    current.keys.push(await sha256Hex(rawKey));
    uniqueDeals.set(mapKey, current);
  }
  for (const item of uniqueDeals.values()) {
    try {
      await assessDealForPortal(env, item.portalId, item.objectId, 'webhook');
      const now = new Date().toISOString();
      for (const key of item.keys) {
        await env.DB.prepare(`UPDATE inbound_events SET status = 'processed', processed_at = ? WHERE event_key = ?`).bind(now, key).run();
      }
    } catch (error) {
      const message = (error instanceof Error ? error.message : String(error)).slice(0, 1000);
      for (const key of item.keys) {
        await env.DB.prepare(`UPDATE inbound_events SET status = 'failed', processed_at = ?, error_message = ? WHERE event_key = ?`)
          .bind(new Date().toISOString(), message, key).run();
      }
    }
  }
}

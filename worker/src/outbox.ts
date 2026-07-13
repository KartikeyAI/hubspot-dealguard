import { PLAN_LIMITS } from './config.js';
import { decryptSecret, encryptSecret, randomToken } from './crypto.js';
import { sendEmail } from './email.js';
import { AppError } from './errors.js';
import { Repository } from './repository.js';
import type { Env, IssueSeverity, RequestIdentity } from './types.js';

export type DestinationType = 'teams_workflow' | 'webhook' | 'email';

interface DestinationRow {
  id: string;
  portal_id: string;
  type: DestinationType;
  name: string;
  endpoint_cipher: string | null;
  endpoint_iv: string | null;
  signing_secret_cipher: string | null;
  signing_secret_iv: string | null;
  config_json: string;
  event_types_json: string;
  minimum_severity: IssueSeverity;
  pipeline_ids_json: string;
  enabled: number;
  created_at: string;
  updated_at: string;
}

interface OutboxRow {
  id: string;
  portal_id: string;
  event_type: string;
  severity: IssueSeverity;
  pipeline_id: string | null;
  aggregate_type: string;
  aggregate_id: string;
  payload_json: string;
  status: 'pending' | 'processing' | 'delivered' | 'failed' | 'dead_letter';
  available_at: string;
  attempts: number;
  last_error: string | null;
  created_at: string;
  delivered_at: string | null;
}

export interface DestinationView {
  id: string;
  type: DestinationType;
  name: string;
  eventTypes: string[];
  minimumSeverity: IssueSeverity;
  pipelineIds: string[];
  enabled: boolean;
  configured: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface OutboxEventView {
  id: string;
  eventType: string;
  severity: IssueSeverity;
  aggregateType: string;
  aggregateId: string;
  status: OutboxRow['status'];
  attempts: number;
  lastError: string | null;
  availableAt: string;
  createdAt: string;
  deliveredAt: string | null;
}

const severityRank: Record<IssueSeverity, number> = { info: 0, warning: 1, critical: 2 };
const encoder = new TextEncoder();

function stringArray(value: unknown, max: number): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0).map((item) => item.trim().slice(0, 128)))].slice(0, max);
}

function cleanName(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) throw new AppError(400, 'destination_name_required', 'A destination name is required.');
  return value.trim().slice(0, 120);
}

function parseDestination(row: DestinationRow): DestinationView {
  const recipients = row.type === 'email'
    ? (JSON.parse(row.config_json) as { recipients?: string[] }).recipients ?? []
    : [];
  return {
    id: row.id,
    type: row.type,
    name: row.name,
    eventTypes: JSON.parse(row.event_types_json) as string[],
    minimumSeverity: row.minimum_severity,
    pipelineIds: JSON.parse(row.pipeline_ids_json) as string[],
    enabled: Boolean(row.enabled),
    configured: row.type === 'email' ? recipients.length > 0 : Boolean(row.endpoint_cipher && row.endpoint_iv),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function destinationMatches(
  destination: Pick<DestinationRow, 'enabled' | 'event_types_json' | 'minimum_severity' | 'pipeline_ids_json'>,
  event: Pick<OutboxRow, 'event_type' | 'severity' | 'pipeline_id'>,
): boolean {
  if (!destination.enabled) return false;
  const eventTypes = JSON.parse(destination.event_types_json) as string[];
  if (eventTypes.length > 0 && !eventTypes.includes(event.event_type)) return false;
  if (severityRank[event.severity] < severityRank[destination.minimum_severity]) return false;
  const pipelines = JSON.parse(destination.pipeline_ids_json) as string[];
  if (pipelines.length > 0 && (!event.pipeline_id || !pipelines.includes(event.pipeline_id))) return false;
  return true;
}

export async function listDestinations(env: Env, portalId: string): Promise<DestinationView[]> {
  const rows = await env.DB.prepare(`SELECT * FROM notification_destinations WHERE portal_id = ? ORDER BY created_at ASC`).bind(portalId).all<DestinationRow>();
  return (rows.results ?? []).map(parseDestination);
}

export async function createDestination(env: Env, identity: RequestIdentity, value: unknown): Promise<DestinationView> {
  const tenant = await new Repository(env).getTenant(identity.portalId);
  const limits = PLAN_LIMITS[tenant.plan];
  if (!limits.multiDestinationDelivery) throw new AppError(403, 'enterprise_subscription_required', 'Multiple notification destinations require DealGuard Enterprise.');
  const count = await env.DB.prepare(`SELECT COUNT(*) AS count FROM notification_destinations WHERE portal_id = ?`).bind(identity.portalId).first<{ count: number }>();
  if (Number(count?.count ?? 0) >= limits.maxNotificationDestinations) {
    throw new AppError(409, 'destination_limit_reached', `This portal supports up to ${limits.maxNotificationDestinations} notification destinations.`);
  }
  const input = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  const allowed: DestinationType[] = ['teams_workflow', 'webhook', 'email'];
  const type = allowed.includes(input.type as DestinationType) ? input.type as DestinationType : null;
  if (!type) throw new AppError(400, 'destination_type_invalid', 'Choose Teams Workflow, webhook, or email.');
  const endpoint = typeof input.endpoint === 'string' ? input.endpoint.trim() : '';
  if (type !== 'email') {
    let parsed: URL;
    try { parsed = new URL(endpoint); } catch { throw new AppError(400, 'destination_url_invalid', 'Enter a valid HTTPS destination URL.'); }
    if (parsed.protocol !== 'https:') throw new AppError(400, 'destination_https_required', 'Notification destinations must use HTTPS.');
  }
  const recipients = stringArray(input.recipients, 25).filter((email) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email));
  if (type === 'email' && recipients.length === 0) throw new AppError(400, 'destination_recipient_required', 'At least one valid email recipient is required.');
  const minimumSeverity: IssueSeverity = input.minimumSeverity === 'critical' || input.minimumSeverity === 'warning' ? input.minimumSeverity : 'info';
  const encryptedEndpoint = type === 'email' ? null : await encryptSecret(endpoint, env.TOKEN_ENCRYPTION_KEY);
  const generatedSigningSecret = type === 'webhook'
    ? typeof input.signingSecret === 'string' && input.signingSecret.length >= 24 ? input.signingSecret : randomToken()
    : null;
  const encryptedSecret = generatedSigningSecret ? await encryptSecret(generatedSigningSecret, env.TOKEN_ENCRYPTION_KEY) : null;
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const destinationName = cleanName(input.name);
  await env.DB.prepare(
    `INSERT INTO notification_destinations (id, portal_id, type, name, endpoint_cipher, endpoint_iv, signing_secret_cipher, signing_secret_iv, config_json, event_types_json, minimum_severity, pipeline_ids_json, enabled, created_by_user_id, created_by_email, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)`
  ).bind(
    id,
    identity.portalId,
    type,
    destinationName,
    encryptedEndpoint?.cipher ?? null,
    encryptedEndpoint?.iv ?? null,
    encryptedSecret?.cipher ?? null,
    encryptedSecret?.iv ?? null,
    JSON.stringify(type === 'email' ? { recipients } : {}),
    JSON.stringify(stringArray(input.eventTypes, 50)),
    minimumSeverity,
    JSON.stringify(stringArray(input.pipelineIds, 50)),
    identity.userId,
    identity.userEmail,
    now,
    now,
  ).run();
  await new Repository(env).audit(identity.portalId, identity.userId, identity.userEmail, 'destination.created', { destinationId: id, type, name: destinationName });
  const row = await env.DB.prepare(`SELECT * FROM notification_destinations WHERE id = ? AND portal_id = ?`).bind(id, identity.portalId).first<DestinationRow>();
  if (!row) throw new AppError(500, 'destination_creation_failed', 'The notification destination could not be loaded.');
  return parseDestination(row);
}

export async function updateDestination(env: Env, identity: RequestIdentity, destinationId: string, value: unknown): Promise<DestinationView> {
  const input = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  const current = await env.DB.prepare(`SELECT * FROM notification_destinations WHERE id = ? AND portal_id = ?`).bind(destinationId, identity.portalId).first<DestinationRow>();
  if (!current) throw new AppError(404, 'destination_not_found', 'The notification destination does not exist.');
  const enabled = typeof input.enabled === 'boolean' ? input.enabled : Boolean(current.enabled);
  const minimumSeverity: IssueSeverity = input.minimumSeverity === 'critical' || input.minimumSeverity === 'warning' || input.minimumSeverity === 'info' ? input.minimumSeverity : current.minimum_severity;
  const eventTypes = input.eventTypes === undefined ? JSON.parse(current.event_types_json) as string[] : stringArray(input.eventTypes, 50);
  const pipelineIds = input.pipelineIds === undefined ? JSON.parse(current.pipeline_ids_json) as string[] : stringArray(input.pipelineIds, 50);
  const now = new Date().toISOString();
  await env.DB.prepare(`UPDATE notification_destinations SET name = ?, event_types_json = ?, minimum_severity = ?, pipeline_ids_json = ?, enabled = ?, updated_at = ? WHERE id = ? AND portal_id = ?`)
    .bind(cleanName(input.name ?? current.name), JSON.stringify(eventTypes), minimumSeverity, JSON.stringify(pipelineIds), enabled ? 1 : 0, now, destinationId, identity.portalId).run();
  await new Repository(env).audit(identity.portalId, identity.userId, identity.userEmail, 'destination.updated', { destinationId, enabled, minimumSeverity });
  const updated = await env.DB.prepare(`SELECT * FROM notification_destinations WHERE id = ? AND portal_id = ?`).bind(destinationId, identity.portalId).first<DestinationRow>();
  if (!updated) throw new AppError(500, 'destination_update_failed', 'The notification destination could not be loaded after update.');
  return parseDestination(updated);
}

export async function deleteDestination(env: Env, identity: RequestIdentity, destinationId: string): Promise<void> {
  const result = await env.DB.prepare(`DELETE FROM notification_destinations WHERE id = ? AND portal_id = ?`).bind(destinationId, identity.portalId).run();
  if (Number(result.meta?.changes ?? 0) === 0) throw new AppError(404, 'destination_not_found', 'The notification destination does not exist.');
  await new Repository(env).audit(identity.portalId, identity.userId, identity.userEmail, 'destination.deleted', { destinationId });
}

export async function enqueueOutboxEvent(
  env: Env,
  input: {
    portalId: string;
    eventType: string;
    severity?: IssueSeverity;
    pipelineId?: string | null;
    aggregateType: string;
    aggregateId: string;
    payload: Record<string, unknown>;
  },
): Promise<string> {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  await env.DB.prepare(
    `INSERT INTO outbox_events (id, portal_id, event_type, severity, pipeline_id, aggregate_type, aggregate_id, payload_json, status, available_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`
  ).bind(id, input.portalId, input.eventType.slice(0, 128), input.severity ?? 'info', input.pipelineId ?? null, input.aggregateType.slice(0, 64), input.aggregateId.slice(0, 128), JSON.stringify(input.payload), now, now).run();
  return id;
}

async function hmacHex(secret: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const signature = new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(body)));
  return Array.from(signature, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function deliver(env: Env, destination: DestinationRow, event: OutboxRow): Promise<number | null> {
  const payload = JSON.parse(event.payload_json) as Record<string, unknown>;
  const envelope = {
    id: event.id,
    type: event.event_type,
    severity: event.severity,
    occurredAt: event.created_at,
    portalId: event.portal_id,
    aggregate: { type: event.aggregate_type, id: event.aggregate_id },
    data: payload,
  };
  if (destination.type === 'email') {
    const config = JSON.parse(destination.config_json) as { recipients?: string[] };
    const recipients = config.recipients ?? [];
    await sendEmail(env, recipients, `DealGuard: ${event.event_type}`, `<h1>${event.event_type}</h1><pre>${JSON.stringify(payload, null, 2).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')}</pre>`);
    return null;
  }
  if (!destination.endpoint_cipher || !destination.endpoint_iv) throw new AppError(500, 'destination_endpoint_missing', 'The destination endpoint is unavailable.');
  const endpoint = await decryptSecret(destination.endpoint_cipher, destination.endpoint_iv, env.TOKEN_ENCRYPTION_KEY);
  const body = destination.type === 'teams_workflow'
    ? JSON.stringify({ text: `DealGuard ${event.severity}: ${event.event_type}\n${String(payload.summary ?? payload.title ?? event.aggregate_id)}` })
    : JSON.stringify(envelope);
  const headers: Record<string, string> = { 'content-type': 'application/json', 'user-agent': 'DealGuard-Delivery/1.4' };
  if (destination.type === 'webhook') {
    headers['x-dealguard-event'] = event.event_type;
    headers['x-dealguard-delivery'] = event.id;
    if (destination.signing_secret_cipher && destination.signing_secret_iv) {
      const secret = await decryptSecret(destination.signing_secret_cipher, destination.signing_secret_iv, env.TOKEN_ENCRYPTION_KEY);
      headers['x-dealguard-signature'] = `sha256=${await hmacHex(secret, body)}`;
    }
  }
  const response = await fetch(endpoint, { method: 'POST', headers, body });
  if (!response.ok) throw new AppError(502, 'destination_delivery_failed', `Destination returned HTTP ${response.status}.`);
  return response.status;
}

async function recordDelivery(env: Env, event: OutboxRow, destination: DestinationRow, status: 'delivered' | 'failed' | 'skipped', attempt: number, httpStatus: number | null, error: string | null): Promise<void> {
  await env.DB.prepare(`INSERT INTO outbox_deliveries (id, portal_id, outbox_event_id, destination_id, attempt_number, status, http_status, error_message, attempted_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(crypto.randomUUID(), event.portal_id, event.id, destination.id, attempt, status, httpStatus, error, new Date().toISOString()).run();
}

export function retryDelaySeconds(attempt: number, jitterSeconds = 0): number {
  return Math.min(6 * 60 * 60, 30 * (2 ** Math.min(attempt, 10))) + Math.max(0, Math.min(30, jitterSeconds));
}

function retryAt(attempt: number): string {
  return new Date(Date.now() + retryDelaySeconds(attempt, Math.floor(Math.random() * 30)) * 1000).toISOString();
}

async function updateHealth(env: Env, portalId: string, success: boolean, error: string | null): Promise<void> {
  const now = new Date().toISOString();
  await env.DB.prepare(
    `INSERT INTO service_health (portal_id, status, last_delivery_success_at, last_failure_at, consecutive_failures, last_error, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(portal_id) DO UPDATE SET
       status = excluded.status,
       last_delivery_success_at = CASE WHEN ? = 1 THEN excluded.last_delivery_success_at ELSE service_health.last_delivery_success_at END,
       last_failure_at = CASE WHEN ? = 0 THEN excluded.last_failure_at ELSE service_health.last_failure_at END,
       consecutive_failures = CASE WHEN ? = 1 THEN 0 ELSE service_health.consecutive_failures + 1 END,
       last_error = excluded.last_error,
       updated_at = excluded.updated_at`
  ).bind(portalId, success ? 'healthy' : 'degraded', success ? now : null, success ? null : now, success ? 0 : 1, error, now, success ? 1 : 0, success ? 1 : 0, success ? 1 : 0).run();
}

export async function dispatchOutbox(env: Env, limit = 25): Promise<void> {
  const staleCutoff = new Date(Date.now() - 15 * 60_000).toISOString();
  await env.DB.prepare(`UPDATE outbox_events SET status = 'failed', available_at = ?, last_error = COALESCE(last_error, 'Recovered abandoned processing lease.') WHERE status = 'processing' AND available_at < ?`)
    .bind(new Date().toISOString(), staleCutoff).run();
  const events = await env.DB.prepare(`SELECT * FROM outbox_events WHERE status IN ('pending', 'failed') AND available_at <= ? ORDER BY created_at ASC LIMIT ?`)
    .bind(new Date().toISOString(), limit).all<OutboxRow>();
  for (const event of events.results ?? []) {
    const claimed = await env.DB.prepare(`UPDATE outbox_events SET status = 'processing', available_at = ? WHERE id = ? AND status IN ('pending', 'failed')`)
      .bind(new Date(Date.now() + 15 * 60_000).toISOString(), event.id).run();
    if (Number(claimed.meta?.changes ?? 0) === 0) continue;
    const destinations = await env.DB.prepare(`SELECT * FROM notification_destinations WHERE portal_id = ? AND enabled = 1`).bind(event.portal_id).all<DestinationRow>();
    const matching = (destinations.results ?? []).filter((destination) => destinationMatches(destination, event));
    let failures = 0;
    let lastError: string | null = null;
    for (const destination of matching) {
      try {
        const status = await deliver(env, destination, event);
        await recordDelivery(env, event, destination, 'delivered', event.attempts + 1, status, null);
      } catch (error) {
        failures += 1;
        lastError = (error instanceof Error ? error.message : String(error)).slice(0, 1000);
        await recordDelivery(env, event, destination, 'failed', event.attempts + 1, null, lastError);
      }
    }
    const attempts = event.attempts + 1;
    if (failures === 0) {
      await env.DB.prepare(`UPDATE outbox_events SET status = 'delivered', attempts = ?, delivered_at = ?, last_error = NULL WHERE id = ?`).bind(attempts, new Date().toISOString(), event.id).run();
      await updateHealth(env, event.portal_id, true, null);
    } else if (attempts >= 8) {
      await env.DB.prepare(`UPDATE outbox_events SET status = 'dead_letter', attempts = ?, last_error = ? WHERE id = ?`).bind(attempts, lastError, event.id).run();
      await updateHealth(env, event.portal_id, false, lastError);
    } else {
      await env.DB.prepare(`UPDATE outbox_events SET status = 'failed', attempts = ?, available_at = ?, last_error = ? WHERE id = ?`).bind(attempts, retryAt(attempts), lastError, event.id).run();
      await updateHealth(env, event.portal_id, false, lastError);
    }
  }
}

export async function listOutbox(env: Env, portalId: string, status: string | null, limit = 100): Promise<OutboxEventView[]> {
  const rows = await env.DB.prepare(`SELECT * FROM outbox_events WHERE portal_id = ? AND (? = '' OR status = ?) ORDER BY created_at DESC LIMIT ?`)
    .bind(portalId, status ?? '', status ?? '', Math.min(500, Math.max(1, limit))).all<OutboxRow>();
  return (rows.results ?? []).map((row) => ({
    id: row.id,
    eventType: row.event_type,
    severity: row.severity,
    aggregateType: row.aggregate_type,
    aggregateId: row.aggregate_id,
    status: row.status,
    attempts: row.attempts,
    lastError: row.last_error,
    availableAt: row.available_at,
    createdAt: row.created_at,
    deliveredAt: row.delivered_at,
  }));
}

export async function replayOutboxEvent(env: Env, identity: RequestIdentity, eventId: string): Promise<void> {
  const result = await env.DB.prepare(`UPDATE outbox_events SET status = 'pending', attempts = 0, available_at = ?, last_error = NULL, delivered_at = NULL WHERE id = ? AND portal_id = ? AND status IN ('failed', 'dead_letter')`)
    .bind(new Date().toISOString(), eventId, identity.portalId).run();
  if (Number(result.meta?.changes ?? 0) === 0) throw new AppError(404, 'outbox_event_not_replayable', 'The delivery event does not exist or is not replayable.');
  await new Repository(env).audit(identity.portalId, identity.userId, identity.userEmail, 'outbox.replayed', { eventId });
}

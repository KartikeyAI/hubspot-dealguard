import { decryptSecret, encryptSecret, randomToken } from './crypto.js';
import { sendEmail } from './email.js';
import { requireEnterprisePermission } from './enterprise-access.js';
import { AppError } from './errors.js';
import { Repository } from './repository.js';
import type { Env, IssueSeverity, RequestIdentity } from './types.js';

type ChannelType = 'slack_webhook' | 'teams_workflow' | 'email' | 'webhook';
type AlertStatus = 'queued' | 'sent' | 'acknowledged' | 'suppressed' | 'escalated' | 'failed';

interface ChannelRow {
  id: string; portal_id: string; type: ChannelType; name: string;
  endpoint_cipher: string | null; endpoint_iv: string | null;
  signing_secret_cipher: string | null; signing_secret_iv: string | null;
  config_json: string; enabled: number; created_at: string; updated_at: string;
}

interface RouteRow {
  id: string; portal_id: string; name: string; event_types_json: string; minimum_severity: IssueSeverity;
  pipeline_ids_json: string; team_ids_json: string; owner_ids_json: string; region_codes_json: string;
  channel_ids_json: string; direct_owner: number; direct_manager: number; quiet_hours_calendar_id: string | null;
  escalation_policy_id: string | null; suppression_window_minutes: number; enabled: number; created_at: string; updated_at: string;
}

interface OutboxRow {
  id: string; portal_id: string; event_type: string; severity: IssueSeverity; pipeline_id: string | null;
  aggregate_type: string; aggregate_id: string; payload_json: string; created_at: string;
}

const severityRank: Record<IssueSeverity, number> = { info: 0, warning: 1, critical: 2 };
const encoder = new TextEncoder();

function strings(value: unknown, max = 500): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((item): item is string => typeof item === 'string' && Boolean(item.trim())).map((item) => item.trim().slice(0, 256)))].slice(0, max);
}

function clean(value: unknown, max: number): string {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

function jsonArray(value: string): string[] {
  try { const parsed = JSON.parse(value); return Array.isArray(parsed) ? parsed : []; } catch { return []; }
}

function validHttps(value: string): string {
  let parsed: URL;
  try { parsed = new URL(value); } catch { throw new AppError(400, 'notification_url_invalid', 'Enter a valid notification endpoint.'); }
  if (parsed.protocol !== 'https:') throw new AppError(400, 'notification_https_required', 'Notification endpoints must use HTTPS.');
  return parsed.toString();
}

function routeMatches(route: RouteRow, event: OutboxRow, payload: Record<string, unknown>): boolean {
  if (!route.enabled) return false;
  const eventTypes = jsonArray(route.event_types_json);
  if (eventTypes.length && !eventTypes.includes(event.event_type)) return false;
  if (severityRank[event.severity] < severityRank[route.minimum_severity]) return false;
  const checks: Array<[string[], unknown]> = [
    [jsonArray(route.pipeline_ids_json), event.pipeline_id ?? payload.pipelineId],
    [jsonArray(route.team_ids_json), payload.teamId],
    [jsonArray(route.owner_ids_json), payload.ownerId],
    [jsonArray(route.region_codes_json), payload.regionCode],
  ];
  return checks.every(([allowed, actual]) => allowed.length === 0 || (typeof actual === 'string' && allowed.includes(actual)));
}

function currentLocalParts(timeZone: string, date = new Date()): { weekday: string; hour: number; minute: number; date: string } {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone, weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(date);
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? '';
  return {
    weekday: get('weekday').toLowerCase(),
    hour: Number(get('hour')),
    minute: Number(get('minute')),
    date: `${get('year')}-${get('month')}-${get('day')}`,
  };
}

function minutes(value: string): number {
  const match = value.match(/^(\d{2}):(\d{2})$/);
  return match ? Number(match[1]) * 60 + Number(match[2]) : -1;
}

async function inQuietHours(env: Env, portalId: string, calendarId: string | null, date = new Date()): Promise<boolean> {
  if (!calendarId) return false;
  const row = await env.DB.prepare(`SELECT timezone, weekly_schedule_json, holidays_json FROM business_calendars WHERE portal_id = ? AND id = ?`)
    .bind(portalId, calendarId).first<{ timezone: string; weekly_schedule_json: string; holidays_json: string }>();
  if (!row) return false;
  const local = currentLocalParts(row.timezone, date);
  const holidays = jsonArray(row.holidays_json);
  if (holidays.includes(local.date)) return true;
  const schedule = JSON.parse(row.weekly_schedule_json) as Record<string, { start?: string; end?: string; enabled?: boolean }>;
  const day = schedule[local.weekday];
  if (!day?.enabled || !day.start || !day.end) return true;
  const now = local.hour * 60 + local.minute;
  const start = minutes(day.start);
  const end = minutes(day.end);
  return start < 0 || end < 0 || now < start || now >= end;
}

async function hmacBase64(secret: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const bytes = new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(body)));
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export async function createNotificationChannel(env: Env, identity: RequestIdentity, value: unknown): Promise<Record<string, unknown>> {
  await requireEnterprisePermission(env, identity, 'alert.manage');
  const input = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  const allowed: ChannelType[] = ['slack_webhook', 'teams_workflow', 'email', 'webhook'];
  const type = allowed.includes(input.type as ChannelType) ? input.type as ChannelType : null;
  const name = clean(input.name, 120);
  if (!type || !name) throw new AppError(400, 'notification_channel_invalid', 'A valid channel type and name are required.');
  const recipients = strings(input.recipients, 100).filter((email) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email));
  const endpoint = type === 'email' ? '' : validHttps(clean(input.endpoint, 2000));
  if (type === 'email' && recipients.length === 0) throw new AppError(400, 'notification_recipients_required', 'At least one email recipient is required.');
  const endpointEncrypted = endpoint ? await encryptSecret(endpoint, env.TOKEN_ENCRYPTION_KEY) : null;
  const signingSecret = type === 'webhook' ? (clean(input.signingSecret, 512) || randomToken()) : '';
  const secretEncrypted = signingSecret ? await encryptSecret(signingSecret, env.TOKEN_ENCRYPTION_KEY) : null;
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  await env.DB.prepare(
    `INSERT INTO notification_channels (id, portal_id, type, name, endpoint_cipher, endpoint_iv, signing_secret_cipher, signing_secret_iv, config_json, enabled, created_by_user_id, created_by_email, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)`
  ).bind(id, identity.portalId, type, name, endpointEncrypted?.cipher ?? null, endpointEncrypted?.iv ?? null, secretEncrypted?.cipher ?? null, secretEncrypted?.iv ?? null, JSON.stringify({ recipients }), identity.userId, identity.userEmail, now, now).run();
  await new Repository(env).audit(identity.portalId, identity.userId, identity.userEmail, 'alert.channel_created', { channelId: id, type, name });
  return { id, type, name, enabled: true, recipients: type === 'email' ? recipients : undefined, signingSecret: type === 'webhook' ? signingSecret : undefined, createdAt: now };
}

export async function listNotificationChannels(env: Env, identity: RequestIdentity): Promise<Array<Record<string, unknown>>> {
  await requireEnterprisePermission(env, identity, 'alert.view');
  const rows = await env.DB.prepare(`SELECT id, type, name, config_json, enabled, created_at, updated_at FROM notification_channels WHERE portal_id = ? ORDER BY name`)
    .bind(identity.portalId).all<Record<string, unknown>>();
  return (rows.results ?? []).map((row) => ({
    id: row.id, type: row.type, name: row.name, enabled: Boolean(row.enabled),
    recipients: (JSON.parse(String(row.config_json ?? '{}')) as { recipients?: string[] }).recipients ?? [],
    createdAt: row.created_at, updatedAt: row.updated_at,
  }));
}

export async function updateNotificationChannel(env: Env, identity: RequestIdentity, channelId: string, value: unknown): Promise<void> {
  await requireEnterprisePermission(env, identity, 'alert.manage');
  const input = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  const current = await env.DB.prepare(`SELECT * FROM notification_channels WHERE portal_id = ? AND id = ?`).bind(identity.portalId, channelId).first<ChannelRow>();
  if (!current) throw new AppError(404, 'notification_channel_not_found', 'The notification channel does not exist.');
  const name = clean(input.name, 120) || current.name;
  const enabled = input.enabled === undefined ? Boolean(current.enabled) : input.enabled === true;
  const recipients = input.recipients === undefined ? (JSON.parse(current.config_json) as { recipients?: string[] }).recipients ?? [] : strings(input.recipients, 100);
  let endpointCipher = current.endpoint_cipher;
  let endpointIv = current.endpoint_iv;
  if (typeof input.endpoint === 'string' && current.type !== 'email') {
    const encrypted = await encryptSecret(validHttps(input.endpoint.trim()), env.TOKEN_ENCRYPTION_KEY);
    endpointCipher = encrypted.cipher; endpointIv = encrypted.iv;
  }
  await env.DB.prepare(`UPDATE notification_channels SET name = ?, endpoint_cipher = ?, endpoint_iv = ?, config_json = ?, enabled = ?, updated_at = ? WHERE portal_id = ? AND id = ?`)
    .bind(name, endpointCipher, endpointIv, JSON.stringify({ recipients }), enabled ? 1 : 0, new Date().toISOString(), identity.portalId, channelId).run();
  await new Repository(env).audit(identity.portalId, identity.userId, identity.userEmail, 'alert.channel_updated', { channelId, name, enabled });
}

export async function deleteNotificationChannel(env: Env, identity: RequestIdentity, channelId: string): Promise<void> {
  await requireEnterprisePermission(env, identity, 'alert.manage');
  const used = await env.DB.prepare(`SELECT id FROM notification_routes WHERE portal_id = ? AND channel_ids_json LIKE ? LIMIT 1`)
    .bind(identity.portalId, `%${channelId}%`).first<{ id: string }>();
  if (used) throw new AppError(409, 'notification_channel_in_use', 'Remove this channel from notification routes before deleting it.');
  const result = await env.DB.prepare(`DELETE FROM notification_channels WHERE portal_id = ? AND id = ?`).bind(identity.portalId, channelId).run();
  if (!Number(result.meta?.changes ?? 0)) throw new AppError(404, 'notification_channel_not_found', 'The notification channel does not exist.');
  await new Repository(env).audit(identity.portalId, identity.userId, identity.userEmail, 'alert.channel_deleted', { channelId });
}

export async function upsertBusinessCalendar(env: Env, identity: RequestIdentity, value: unknown, calendarId: string | null = null): Promise<Record<string, unknown>> {
  await requireEnterprisePermission(env, identity, 'alert.manage');
  const input = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  const name = clean(input.name, 120);
  const timezone = clean(input.timezone, 100);
  if (!name || !timezone) throw new AppError(400, 'business_calendar_invalid', 'Calendar name and IANA timezone are required.');
  try { currentLocalParts(timezone); } catch { throw new AppError(400, 'business_calendar_timezone_invalid', 'Use a valid IANA timezone.'); }
  const id = calendarId ?? crypto.randomUUID();
  const schedule = input.weeklySchedule && typeof input.weeklySchedule === 'object' ? input.weeklySchedule : {};
  const holidays = strings(input.holidays, 1000);
  const now = new Date().toISOString();
  await env.DB.prepare(
    `INSERT INTO business_calendars (id, portal_id, name, timezone, weekly_schedule_json, holidays_json, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET name = excluded.name, timezone = excluded.timezone,
      weekly_schedule_json = excluded.weekly_schedule_json, holidays_json = excluded.holidays_json, updated_at = excluded.updated_at`
  ).bind(id, identity.portalId, name, timezone, JSON.stringify(schedule), JSON.stringify(holidays), now, now).run();
  await new Repository(env).audit(identity.portalId, identity.userId, identity.userEmail, calendarId ? 'alert.calendar_updated' : 'alert.calendar_created', { calendarId: id, name, timezone });
  return { id, name, timezone, weeklySchedule: schedule, holidays, updatedAt: now };
}

export async function upsertEscalationPolicy(env: Env, identity: RequestIdentity, value: unknown, policyId: string | null = null): Promise<Record<string, unknown>> {
  await requireEnterprisePermission(env, identity, 'alert.manage');
  const input = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  const name = clean(input.name, 120);
  const steps = Array.isArray(input.steps) ? input.steps.slice(0, 20).map((step, index) => {
    const item = step && typeof step === 'object' ? step as Record<string, unknown> : {};
    return { afterMinutes: Math.max(1, Math.min(43200, Number(item.afterMinutes ?? (index + 1) * 60) || 60)), channelIds: strings(item.channelIds, 100), notifyManager: item.notifyManager === true };
  }).sort((a, b) => a.afterMinutes - b.afterMinutes) : [];
  if (!name || steps.length === 0) throw new AppError(400, 'escalation_policy_invalid', 'Escalation policy name and at least one step are required.');
  const id = policyId ?? crypto.randomUUID();
  const now = new Date().toISOString();
  await env.DB.prepare(
    `INSERT INTO escalation_policies (id, portal_id, name, steps_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET name = excluded.name, steps_json = excluded.steps_json, updated_at = excluded.updated_at`
  ).bind(id, identity.portalId, name, JSON.stringify(steps), now, now).run();
  await new Repository(env).audit(identity.portalId, identity.userId, identity.userEmail, policyId ? 'alert.escalation_updated' : 'alert.escalation_created', { escalationPolicyId: id, name });
  return { id, name, steps, updatedAt: now };
}

export async function upsertNotificationRoute(env: Env, identity: RequestIdentity, value: unknown, routeId: string | null = null): Promise<Record<string, unknown>> {
  await requireEnterprisePermission(env, identity, 'alert.manage');
  const input = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  const name = clean(input.name, 120);
  const channelIds = strings(input.channelIds, 100);
  if (!name || channelIds.length === 0) throw new AppError(400, 'notification_route_invalid', 'Route name and at least one channel are required.');
  const validChannels = await env.DB.prepare(`SELECT id FROM notification_channels WHERE portal_id = ?`).bind(identity.portalId).all<{ id: string }>();
  const allowed = new Set((validChannels.results ?? []).map((item) => item.id));
  if (channelIds.some((id) => !allowed.has(id))) throw new AppError(400, 'notification_route_channel_invalid', 'One or more route channels do not belong to this portal.');
  const severity: IssueSeverity = input.minimumSeverity === 'critical' || input.minimumSeverity === 'warning' ? input.minimumSeverity : 'info';
  const id = routeId ?? crypto.randomUUID();
  const now = new Date().toISOString();
  await env.DB.prepare(
    `INSERT INTO notification_routes (
      id, portal_id, name, event_types_json, minimum_severity, pipeline_ids_json, team_ids_json,
      owner_ids_json, region_codes_json, channel_ids_json, direct_owner, direct_manager,
      quiet_hours_calendar_id, escalation_policy_id, suppression_window_minutes, enabled, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET name = excluded.name, event_types_json = excluded.event_types_json,
      minimum_severity = excluded.minimum_severity, pipeline_ids_json = excluded.pipeline_ids_json,
      team_ids_json = excluded.team_ids_json, owner_ids_json = excluded.owner_ids_json,
      region_codes_json = excluded.region_codes_json, channel_ids_json = excluded.channel_ids_json,
      direct_owner = excluded.direct_owner, direct_manager = excluded.direct_manager,
      quiet_hours_calendar_id = excluded.quiet_hours_calendar_id, escalation_policy_id = excluded.escalation_policy_id,
      suppression_window_minutes = excluded.suppression_window_minutes, enabled = excluded.enabled, updated_at = excluded.updated_at`
  ).bind(
    id, identity.portalId, name, JSON.stringify(strings(input.eventTypes, 100)), severity,
    JSON.stringify(strings(input.pipelineIds)), JSON.stringify(strings(input.teamIds)), JSON.stringify(strings(input.ownerIds)),
    JSON.stringify(strings(input.regionCodes)), JSON.stringify(channelIds), input.directOwner === true ? 1 : 0,
    input.directManager === true ? 1 : 0, clean(input.quietHoursCalendarId, 128) || null,
    clean(input.escalationPolicyId, 128) || null, Math.max(0, Math.min(10080, Number(input.suppressionWindowMinutes ?? 0) || 0)),
    input.enabled === false ? 0 : 1, now, now,
  ).run();
  await new Repository(env).audit(identity.portalId, identity.userId, identity.userEmail, routeId ? 'alert.route_updated' : 'alert.route_created', { routeId: id, name, channelIds });
  return { id, name, channelIds, minimumSeverity: severity, enabled: input.enabled !== false, updatedAt: now };
}

export async function listAlertConfiguration(env: Env, identity: RequestIdentity): Promise<Record<string, unknown>> {
  await requireEnterprisePermission(env, identity, 'alert.view');
  const [channels, routes, calendars, escalations, suppressions] = await Promise.all([
    listNotificationChannels(env, identity),
    env.DB.prepare(`SELECT * FROM notification_routes WHERE portal_id = ? ORDER BY name`).bind(identity.portalId).all<Record<string, unknown>>(),
    env.DB.prepare(`SELECT * FROM business_calendars WHERE portal_id = ? ORDER BY name`).bind(identity.portalId).all<Record<string, unknown>>(),
    env.DB.prepare(`SELECT * FROM escalation_policies WHERE portal_id = ? ORDER BY name`).bind(identity.portalId).all<Record<string, unknown>>(),
    env.DB.prepare(`SELECT * FROM alert_suppressions WHERE portal_id = ? AND (expires_at IS NULL OR expires_at > ?) ORDER BY created_at DESC`).bind(identity.portalId, new Date().toISOString()).all<Record<string, unknown>>(),
  ]);
  return {
    channels,
    routes: (routes.results ?? []).map((row) => ({
      id: row.id, name: row.name, eventTypes: JSON.parse(String(row.event_types_json)), minimumSeverity: row.minimum_severity,
      pipelineIds: JSON.parse(String(row.pipeline_ids_json)), teamIds: JSON.parse(String(row.team_ids_json)),
      ownerIds: JSON.parse(String(row.owner_ids_json)), regionCodes: JSON.parse(String(row.region_codes_json)),
      channelIds: JSON.parse(String(row.channel_ids_json)), directOwner: Boolean(row.direct_owner), directManager: Boolean(row.direct_manager),
      quietHoursCalendarId: row.quiet_hours_calendar_id, escalationPolicyId: row.escalation_policy_id,
      suppressionWindowMinutes: Number(row.suppression_window_minutes), enabled: Boolean(row.enabled),
    })),
    calendars: (calendars.results ?? []).map((row) => ({ id: row.id, name: row.name, timezone: row.timezone, weeklySchedule: JSON.parse(String(row.weekly_schedule_json)), holidays: JSON.parse(String(row.holidays_json)) })),
    escalationPolicies: (escalations.results ?? []).map((row) => ({ id: row.id, name: row.name, steps: JSON.parse(String(row.steps_json)) })),
    suppressions: suppressions.results ?? [],
  };
}

export async function createAlertSuppression(env: Env, identity: RequestIdentity, value: unknown): Promise<Record<string, unknown>> {
  await requireEnterprisePermission(env, identity, 'alert.manage');
  const input = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  const key = clean(input.key, 255);
  const reason = clean(input.reason, 2000);
  if (!key || !reason) throw new AppError(400, 'alert_suppression_invalid', 'Suppression key and reason are required.');
  const expiresAt = typeof input.expiresAt === 'string' && Number.isFinite(Date.parse(input.expiresAt)) ? new Date(input.expiresAt).toISOString() : null;
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  await env.DB.prepare(
    `INSERT INTO alert_suppressions (id, portal_id, suppression_key, reason, expires_at, created_by_user_id, created_by_email, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(portal_id, suppression_key) DO UPDATE SET reason = excluded.reason, expires_at = excluded.expires_at`
  ).bind(id, identity.portalId, key, reason, expiresAt, identity.userId, identity.userEmail, now).run();
  await new Repository(env).audit(identity.portalId, identity.userId, identity.userEmail, 'alert.suppression_created', { key, reason, expiresAt });
  return { id, key, reason, expiresAt, createdAt: now };
}

async function deliverChannel(env: Env, channel: ChannelRow, event: OutboxRow, payload: Record<string, unknown>): Promise<void> {
  if (!channel.enabled) return;
  const summary = String(payload.summary ?? payload.title ?? `${event.aggregate_type} ${event.aggregate_id}`);
  if (channel.type === 'email') {
    const recipients = (JSON.parse(channel.config_json) as { recipients?: string[] }).recipients ?? [];
    await sendEmail(env, recipients, `DealGuard ${event.severity}: ${event.event_type}`, `<h1>${event.event_type}</h1><p>${summary.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')}</p>`);
    return;
  }
  if (!channel.endpoint_cipher || !channel.endpoint_iv) throw new AppError(500, 'notification_channel_endpoint_missing', 'Notification channel endpoint is missing.');
  const endpoint = await decryptSecret(channel.endpoint_cipher, channel.endpoint_iv, env.TOKEN_ENCRYPTION_KEY);
  const envelope = JSON.stringify({
    id: event.id, type: event.event_type, severity: event.severity, occurredAt: event.created_at,
    portalId: event.portal_id, aggregate: { type: event.aggregate_type, id: event.aggregate_id }, data: payload,
  });
  const body = channel.type === 'slack_webhook'
    ? JSON.stringify({ text: `DealGuard ${event.severity}: ${event.event_type}\n${summary}` })
    : channel.type === 'teams_workflow'
      ? JSON.stringify({ text: `DealGuard ${event.severity}: ${event.event_type}\n${summary}` })
      : envelope;
  const headers: Record<string, string> = { 'content-type': 'application/json', 'user-agent': 'DealGuard-Enterprise-Delivery/2.0' };
  if (channel.type === 'webhook' && channel.signing_secret_cipher && channel.signing_secret_iv) {
    const secret = await decryptSecret(channel.signing_secret_cipher, channel.signing_secret_iv, env.TOKEN_ENCRYPTION_KEY);
    headers['x-dealguard-event'] = event.event_type;
    headers['x-dealguard-delivery'] = event.id;
    headers['x-dealguard-signature'] = `v1=${await hmacBase64(secret, body)}`;
  }
  const response = await fetch(endpoint, { method: 'POST', headers, body });
  if (!response.ok) throw new AppError(502, 'notification_channel_delivery_failed', `Notification delivery returned HTTP ${response.status}.`);
}

export async function dispatchEnterpriseAlerts(env: Env, limit = 100): Promise<void> {
  const events = await env.DB.prepare(
    `SELECT * FROM outbox_events WHERE status IN ('pending', 'failed') AND available_at <= ? ORDER BY created_at ASC LIMIT ?`
  ).bind(new Date().toISOString(), Math.min(500, Math.max(1, limit))).all<OutboxRow>();
  for (const event of events.results ?? []) {
    const payload = JSON.parse(event.payload_json) as Record<string, unknown>;
    const routes = await env.DB.prepare(`SELECT * FROM notification_routes WHERE portal_id = ? AND enabled = 1 ORDER BY created_at`)
      .bind(event.portal_id).all<RouteRow>();
    for (const route of routes.results ?? []) {
      if (!routeMatches(route, event, payload)) continue;
      const existing = await env.DB.prepare(`SELECT id, status FROM alert_instances WHERE portal_id = ? AND outbox_event_id = ? AND route_id = ? LIMIT 1`)
        .bind(event.portal_id, event.id, route.id).first<{ id: string; status: AlertStatus }>();
      if (existing && ['sent', 'acknowledged', 'suppressed', 'escalated'].includes(existing.status)) continue;
      const suppressionKey = `${route.id}:${event.aggregate_type}:${event.aggregate_id}:${event.event_type}`;
      const suppressed = await env.DB.prepare(`SELECT id FROM alert_suppressions WHERE portal_id = ? AND suppression_key = ? AND (expires_at IS NULL OR expires_at > ?) LIMIT 1`)
        .bind(event.portal_id, suppressionKey, new Date().toISOString()).first<{ id: string }>();
      const recentCutoff = new Date(Date.now() - Number(route.suppression_window_minutes) * 60000).toISOString();
      const recent = route.suppression_window_minutes > 0
        ? await env.DB.prepare(`SELECT id FROM alert_instances WHERE portal_id = ? AND route_id = ? AND suppression_key = ? AND status IN ('sent','acknowledged','escalated') AND created_at >= ? LIMIT 1`)
            .bind(event.portal_id, route.id, suppressionKey, recentCutoff).first<{ id: string }>()
        : null;
      const id = existing?.id ?? crypto.randomUUID();
      const now = new Date().toISOString();
      if (suppressed || recent) {
        await env.DB.prepare(
          `INSERT INTO alert_instances (id, portal_id, outbox_event_id, route_id, status, suppression_key, created_at, updated_at)
           VALUES (?, ?, ?, ?, 'suppressed', ?, ?, ?) ON CONFLICT(id) DO UPDATE SET status = 'suppressed', updated_at = excluded.updated_at`
        ).bind(id, event.portal_id, event.id, route.id, suppressionKey, now, now).run();
        continue;
      }
      if (await inQuietHours(env, event.portal_id, route.quiet_hours_calendar_id)) {
        await env.DB.prepare(
          `INSERT INTO alert_instances (id, portal_id, outbox_event_id, route_id, status, suppression_key, created_at, updated_at)
           VALUES (?, ?, ?, ?, 'queued', ?, ?, ?) ON CONFLICT(id) DO UPDATE SET status = 'queued', updated_at = excluded.updated_at`
        ).bind(id, event.portal_id, event.id, route.id, suppressionKey, now, now).run();
        continue;
      }
      try {
        const channelIds = jsonArray(route.channel_ids_json);
        const channels = await env.DB.prepare(`SELECT * FROM notification_channels WHERE portal_id = ? AND enabled = 1`).bind(event.portal_id).all<ChannelRow>();
        for (const channel of channels.results ?? []) if (channelIds.includes(channel.id)) await deliverChannel(env, channel, event, payload);
        const directRecipients = [
          route.direct_owner ? String(payload.ownerEmail ?? '') : '',
          route.direct_manager ? String(payload.managerEmail ?? '') : '',
        ].filter((item) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(item));
        if (directRecipients.length) await sendEmail(env, directRecipients, `DealGuard ${event.severity}: ${event.event_type}`, `<p>${String(payload.summary ?? payload.title ?? event.aggregate_id)}</p>`);
        await env.DB.prepare(
          `INSERT INTO alert_instances (id, portal_id, outbox_event_id, route_id, status, suppression_key, created_at, updated_at)
           VALUES (?, ?, ?, ?, 'sent', ?, ?, ?) ON CONFLICT(id) DO UPDATE SET status = 'sent', updated_at = excluded.updated_at`
        ).bind(id, event.portal_id, event.id, route.id, suppressionKey, now, now).run();
      } catch (error) {
        await env.DB.prepare(
          `INSERT INTO alert_instances (id, portal_id, outbox_event_id, route_id, status, suppression_key, created_at, updated_at)
           VALUES (?, ?, ?, ?, 'failed', ?, ?, ?) ON CONFLICT(id) DO UPDATE SET status = 'failed', updated_at = excluded.updated_at`
        ).bind(id, event.portal_id, event.id, route.id, suppressionKey, now, now).run();
      }
    }
  }
}

export async function acknowledgeAlert(env: Env, identity: RequestIdentity, alertId: string): Promise<void> {
  await requireEnterprisePermission(env, identity, 'alert.acknowledge');
  const now = new Date().toISOString();
  const result = await env.DB.prepare(
    `UPDATE alert_instances SET status = 'acknowledged', acknowledged_by_user_id = ?, acknowledged_by_email = ?, acknowledged_at = ?, updated_at = ?
     WHERE portal_id = ? AND id = ? AND status IN ('sent','escalated')`
  ).bind(identity.userId, identity.userEmail, now, now, identity.portalId, alertId).run();
  if (!Number(result.meta?.changes ?? 0)) throw new AppError(404, 'alert_not_acknowledgeable', 'The alert does not exist or cannot be acknowledged.');
  await new Repository(env).audit(identity.portalId, identity.userId, identity.userEmail, 'alert.acknowledged', { alertId });
}

export async function escalateUnacknowledgedAlerts(env: Env): Promise<void> {
  const rows = await env.DB.prepare(
    `SELECT a.*, r.escalation_policy_id, o.payload_json, o.event_type, o.severity, o.pipeline_id, o.aggregate_type, o.aggregate_id, o.created_at AS event_created_at
     FROM alert_instances a
     JOIN notification_routes r ON r.id = a.route_id
     JOIN outbox_events o ON o.id = a.outbox_event_id
     WHERE a.status = 'sent' AND r.escalation_policy_id IS NOT NULL ORDER BY a.created_at ASC LIMIT 500`
  ).all<Record<string, unknown>>();
  for (const row of rows.results ?? []) {
    const policy = await env.DB.prepare(`SELECT steps_json FROM escalation_policies WHERE portal_id = ? AND id = ?`)
      .bind(String(row.portal_id), String(row.escalation_policy_id)).first<{ steps_json: string }>();
    if (!policy) continue;
    const steps = JSON.parse(policy.steps_json) as Array<{ afterMinutes: number; channelIds: string[]; notifyManager: boolean }>;
    const ageMinutes = (Date.now() - Date.parse(String(row.created_at))) / 60000;
    const step = [...steps].reverse().find((item) => ageMinutes >= item.afterMinutes);
    if (!step) continue;
    const payload = JSON.parse(String(row.payload_json)) as Record<string, unknown>;
    const event: OutboxRow = {
      id: String(row.outbox_event_id), portal_id: String(row.portal_id), event_type: String(row.event_type),
      severity: row.severity as IssueSeverity, pipeline_id: row.pipeline_id ? String(row.pipeline_id) : null,
      aggregate_type: String(row.aggregate_type), aggregate_id: String(row.aggregate_id),
      payload_json: String(row.payload_json), created_at: String(row.event_created_at),
    };
    const channels = await env.DB.prepare(`SELECT * FROM notification_channels WHERE portal_id = ? AND enabled = 1`).bind(event.portal_id).all<ChannelRow>();
    for (const channel of channels.results ?? []) if (step.channelIds.includes(channel.id)) await deliverChannel(env, channel, event, payload);
    if (step.notifyManager && typeof payload.managerEmail === 'string') await sendEmail(env, [payload.managerEmail], `Escalated DealGuard alert: ${event.event_type}`, `<p>${String(payload.summary ?? payload.title ?? event.aggregate_id)}</p>`);
    await env.DB.prepare(`UPDATE alert_instances SET status = 'escalated', updated_at = ? WHERE id = ?`).bind(new Date().toISOString(), String(row.id)).run();
  }
}

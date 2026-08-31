import { decryptSecret } from './crypto.js';
import { sendEmail } from './email.js';
import { AppError } from './errors.js';
import { loadFollowupRoutingState, type FollowupChannelRow } from './recommendation-followup-delivery.js';
import { routingMatch } from './recommendation-operations-model.js';
import type { RecommendationFollowupScope } from './recommendation-operations-types.js';
import { wakeDeliveryQueue } from './queue-publisher.js';
import type {
  RecommendationDeliverySloEventType,
  RecommendationDeliverySloIncident,
  RecommendationDeliverySloNotificationStatus,
  RecommendationDeliverySloPolicy,
} from './recommendation-delivery-slo-types.js';
import type { Env } from './types.js';

const encoder = new TextEncoder();
const MAX_NOTIFICATION_ATTEMPTS = 5;
const QUIET_HOURS_RETRY_MINUTES = 15;
const PORTAL_SCOPE: RecommendationFollowupScope = {
  pipelineId: null,
  teamId: null,
  ownerId: null,
  regionCode: null,
};

interface NotificationRow extends Record<string, unknown> {
  id: string;
  portal_id: string;
  slo_policy_id: string;
  incident_id: string;
  route_id: string;
  event_type: RecommendationDeliverySloEventType;
  severity: 'info' | 'warning' | 'critical';
  status: RecommendationDeliverySloNotificationStatus;
  routing_fingerprint: string;
  payload_json: string;
  delivery_summary_json: string;
  attempts: number;
  available_at: string;
  last_error: string | null;
  dedupe_key: string;
  created_at: string;
  completed_at: string | null;
  updated_at: string;
}

function parseJson<T>(value: unknown, fallback: T): T {
  if (typeof value !== 'string') return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

async function hmacBase64(secret: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
  const bytes = new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(body)));
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function retryAt(attempt: number): string {
  const seconds = Math.min(3600, 30 * 2 ** Math.min(8, Math.max(0, attempt)));
  return new Date(Date.now() + seconds * 1000).toISOString();
}

function severityForEvent(
  policy: RecommendationDeliverySloPolicy,
  eventType: RecommendationDeliverySloEventType,
): 'info' | 'warning' | 'critical' {
  return eventType === 'recommendation.delivery.slo.recovered' ? 'info' : policy.severity;
}

function routingSeverity(
  policy: RecommendationDeliverySloPolicy,
  eventType: RecommendationDeliverySloEventType,
): 'warning' | 'critical' {
  const severity = severityForEvent(policy, eventType);
  return severity === 'critical' ? 'critical' : 'warning';
}

function eventLabel(eventType: RecommendationDeliverySloEventType): string {
  if (eventType === 'recommendation.delivery.slo.recovered') return 'recovered';
  if (eventType === 'recommendation.delivery.slo.reminder') return 'still breached';
  return 'breached';
}

export async function queueRecommendationDeliverySloNotification(
  env: Env,
  portalId: string,
  policy: RecommendationDeliverySloPolicy,
  incident: RecommendationDeliverySloIncident,
  eventType: RecommendationDeliverySloEventType,
  input: { summary: string; dedupeKey: string },
): Promise<string> {
  const state = await loadFollowupRoutingState(env, portalId);
  const route = state.routes.find((item) => item.id === policy.notificationRouteId);
  if (!route) {
    throw new AppError(409, 'delivery_slo_route_unavailable', 'The configured SLO notification route is unavailable.');
  }
  const match = await routingMatch({
    routes: [route],
    channels: state.channelSummaries,
    // Quiet hours defer actual delivery. They do not prevent a durable alert
    // from being queued after the SLO lifecycle has authorized it.
    quietRouteIds: new Set(),
    scope: PORTAL_SCOPE,
    severity: routingSeverity(policy, eventType),
    recommendationId: incident.id,
    recommendationStatus: incident.status,
    priority: policy.severity === 'critical' ? 'high' : 'medium',
    dueAt: null,
    kind: 'delivery_slo_alert',
    managerNote: input.summary,
    eventType,
  });
  if (!match.ready) {
    throw new AppError(
      409,
      'delivery_slo_route_not_opted_in',
      `The configured route must explicitly subscribe to ${eventType} and contain an enabled channel.`,
    );
  }

  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const dedupeKey = input.dedupeKey.slice(0, 500);
  const payload = {
    title: `Recommendation delivery SLO ${eventLabel(eventType)}: ${policy.name}`,
    summary: input.summary,
    policyId: policy.id,
    policyName: policy.name,
    incidentId: incident.id,
    incidentStatus: incident.status,
    metric: policy.metric,
    targetType: policy.targetType,
    targetId: policy.targetId,
    targetLabel: policy.targetLabel,
    comparison: policy.comparison,
    thresholdValue: policy.thresholdValue,
    observedValue: incident.lastValue,
    sampleCount: incident.lastSampleCount,
    operationalOnly: true,
    noCausalAttribution: true,
    noDealOutcomeInference: true,
    noCrmMutation: true,
  };
  await env.DB.prepare(
    `INSERT INTO recommendation_delivery_slo_notifications (
      id, portal_id, slo_policy_id, incident_id, route_id, event_type,
      severity, status, routing_fingerprint, payload_json,
      delivery_summary_json, attempts, available_at, dedupe_key,
      created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?, '[]', 0, ?, ?, ?, ?)
    ON CONFLICT(portal_id, dedupe_key) DO NOTHING`,
  ).bind(
    id,
    portalId,
    policy.id,
    incident.id,
    policy.notificationRouteId,
    eventType,
    severityForEvent(policy, eventType),
    match.fingerprint,
    JSON.stringify(payload),
    now,
    dedupeKey,
    now,
    now,
  ).run();

  const stored = await env.DB.prepare(
    `SELECT id FROM recommendation_delivery_slo_notifications
     WHERE portal_id = ? AND dedupe_key = ? LIMIT 1`,
  ).bind(portalId, dedupeKey).first<{ id: string }>();
  const notificationId = stored?.id ?? id;
  await env.DB.prepare(
    `UPDATE recommendation_delivery_slo_incidents
     SET last_notification_id = ?, last_notification_status = 'queued',
         last_alert_at = ?, updated_at = ?
     WHERE portal_id = ? AND id = ?`,
  ).bind(notificationId, now, now, portalId, incident.id).run();
  await wakeDeliveryQueue(env, 'outbox');
  return notificationId;
}

async function deliverChannel(
  env: Env,
  channel: FollowupChannelRow,
  row: NotificationRow,
  payload: Record<string, unknown>,
): Promise<void> {
  const title = String(payload.title ?? `DealGuard delivery SLO ${row.event_type}`);
  const summary = String(payload.summary ?? title);
  if (channel.type === 'email') {
    const recipients = parseJson<{ recipients?: string[] }>(channel.config_json, {}).recipients ?? [];
    const valid = [...new Set(recipients.filter((email) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)))];
    if (valid.length === 0) {
      throw new AppError(409, 'delivery_slo_email_unconfigured', `Email channel ${channel.name} has no valid recipients.`);
    }
    await sendEmail(
      env,
      valid,
      `DealGuard: ${title}`,
      `<h1>${escapeHtml(title)}</h1><p>${escapeHtml(summary)}</p><p><small>Operational delivery evidence only. DealGuard did not change CRM data and does not infer a deal outcome.</small></p>`,
    );
    return;
  }
  if (!channel.endpoint_cipher || !channel.endpoint_iv) {
    throw new AppError(409, 'delivery_slo_channel_unconfigured', `Notification channel ${channel.name} has no configured endpoint.`);
  }
  const endpoint = await decryptSecret(channel.endpoint_cipher, channel.endpoint_iv, env.TOKEN_ENCRYPTION_KEY);
  const envelope = JSON.stringify({
    id: row.id,
    type: row.event_type,
    severity: row.severity,
    occurredAt: row.created_at,
    portalId: row.portal_id,
    aggregate: { type: 'recommendation_delivery_slo_incident', id: row.incident_id },
    data: payload,
  });
  const body = channel.type === 'slack_webhook' || channel.type === 'teams_workflow'
    ? JSON.stringify({ text: `DealGuard ${row.severity}: ${title}\n${summary}` })
    : envelope;
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'user-agent': 'DealGuard-Delivery-SLO/1.0',
  };
  if (channel.type === 'webhook') {
    headers['x-dealguard-event'] = row.event_type;
    headers['x-dealguard-delivery'] = row.id;
    if (channel.signing_secret_cipher && channel.signing_secret_iv) {
      const secret = await decryptSecret(
        channel.signing_secret_cipher,
        channel.signing_secret_iv,
        env.TOKEN_ENCRYPTION_KEY,
      );
      headers['x-dealguard-signature'] = `v1=${await hmacBase64(secret, body)}`;
    }
  }
  const response = await fetch(endpoint, { method: 'POST', headers, body });
  if (!response.ok) {
    throw new AppError(502, 'delivery_slo_notification_failed', `Channel ${channel.name} returned HTTP ${response.status}.`);
  }
}

async function failNotification(
  env: Env,
  row: NotificationRow,
  error: string,
  retryable: boolean,
): Promise<void> {
  const attempts = Number(row.attempts ?? 0) + 1;
  const terminal = !retryable || attempts >= MAX_NOTIFICATION_ATTEMPTS;
  const now = new Date().toISOString();
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE recommendation_delivery_slo_notifications
       SET status = 'failed', attempts = ?, available_at = ?, last_error = ?,
           completed_at = CASE WHEN ? = 1 THEN ? ELSE NULL END, updated_at = ?
       WHERE portal_id = ? AND id = ?`,
    ).bind(
      attempts,
      terminal ? now : retryAt(attempts),
      error.slice(0, 1000),
      terminal ? 1 : 0,
      now,
      now,
      row.portal_id,
      row.id,
    ),
    env.DB.prepare(
      `UPDATE recommendation_delivery_slo_incidents
       SET last_notification_status = 'failed', updated_at = ?
       WHERE portal_id = ? AND id = ?`,
    ).bind(now, row.portal_id, row.incident_id),
  ]);
}

export async function dispatchRecommendationDeliverySloNotifications(
  env: Env,
  limit = 20,
): Promise<void> {
  const rows = await env.DB.prepare(
    `SELECT * FROM recommendation_delivery_slo_notifications
     WHERE status IN ('queued', 'deferred', 'failed')
       AND available_at::timestamptz <= NOW()
       AND attempts < ?
     ORDER BY created_at ASC
     LIMIT ?`,
  ).bind(MAX_NOTIFICATION_ATTEMPTS, Math.min(100, Math.max(1, limit))).all<NotificationRow>();

  for (const row of rows.results ?? []) {
    const claimedAt = new Date().toISOString();
    const claimed = await env.DB.prepare(
      `UPDATE recommendation_delivery_slo_notifications
       SET status = 'delivering', updated_at = ?
       WHERE portal_id = ? AND id = ? AND status IN ('queued', 'deferred', 'failed')`,
    ).bind(claimedAt, row.portal_id, row.id).run();
    if (Number(claimed.meta?.changes ?? 0) <= 0) continue;

    try {
      const payload = parseJson<Record<string, unknown>>(row.payload_json, {});
      const state = await loadFollowupRoutingState(env, row.portal_id);
      const route = state.routes.find((item) => item.id === row.route_id);
      if (!route) {
        await failNotification(env, row, 'Configured notification route no longer exists or is disabled.', false);
        continue;
      }
      if (state.quietRouteIds.has(route.id)) {
        const now = new Date().toISOString();
        const availableAt = new Date(Date.now() + QUIET_HOURS_RETRY_MINUTES * 60_000).toISOString();
        await env.DB.batch([
          env.DB.prepare(
            `UPDATE recommendation_delivery_slo_notifications
             SET status = 'deferred', available_at = ?,
                 last_error = 'Deferred by configured quiet hours.', updated_at = ?
             WHERE portal_id = ? AND id = ?`,
          ).bind(availableAt, now, row.portal_id, row.id),
          env.DB.prepare(
            `UPDATE recommendation_delivery_slo_incidents
             SET last_notification_status = 'deferred', updated_at = ?
             WHERE portal_id = ? AND id = ?`,
          ).bind(now, row.portal_id, row.incident_id),
        ]);
        continue;
      }

      const match = await routingMatch({
        routes: [route],
        channels: state.channelSummaries,
        quietRouteIds: new Set(),
        scope: PORTAL_SCOPE,
        severity: row.severity === 'critical' ? 'critical' : 'warning',
        recommendationId: row.incident_id,
        recommendationStatus: String(payload.incidentStatus ?? 'open'),
        priority: row.severity === 'critical' ? 'high' : 'medium',
        dueAt: null,
        kind: 'delivery_slo_alert',
        managerNote: String(payload.summary ?? ''),
        eventType: row.event_type,
      });
      if (!match.ready || match.fingerprint !== row.routing_fingerprint) {
        await failNotification(
          env,
          row,
          'Route or channel configuration changed after the SLO notification was queued.',
          false,
        );
        continue;
      }

      const channelById = new Map(state.channels.map((channel) => [channel.id, channel]));
      const channels = match.channelIds
        .map((id) => channelById.get(id))
        .filter((item): item is FollowupChannelRow => Boolean(item));
      const results: Array<{
        channelId: string;
        channelName: string;
        channelType: FollowupChannelRow['type'];
        status: 'delivered' | 'failed';
        error: string | null;
      }> = [];
      for (const channel of channels) {
        try {
          await deliverChannel(env, channel, row, payload);
          results.push({
            channelId: channel.id,
            channelName: channel.name,
            channelType: channel.type,
            status: 'delivered',
            error: null,
          });
        } catch (error) {
          results.push({
            channelId: channel.id,
            channelName: channel.name,
            channelType: channel.type,
            status: 'failed',
            error: (error instanceof Error ? error.message : String(error)).slice(0, 1000),
          });
        }
      }

      const delivered = results.filter((result) => result.status === 'delivered').length;
      const failed = results.length - delivered;
      if (delivered === 0) {
        await failNotification(
          env,
          row,
          results[0]?.error ?? 'No configured channel accepted the notification.',
          true,
        );
        continue;
      }

      const status: RecommendationDeliverySloNotificationStatus = failed > 0
        ? 'partially_failed'
        : 'delivered';
      const completedAt = new Date().toISOString();
      await env.DB.batch([
        env.DB.prepare(
          `UPDATE recommendation_delivery_slo_notifications
           SET status = ?, attempts = attempts + 1, delivery_summary_json = ?,
               last_error = ?, completed_at = ?, updated_at = ?
           WHERE portal_id = ? AND id = ?`,
        ).bind(
          status,
          JSON.stringify(results),
          results.find((result) => result.status === 'failed')?.error ?? null,
          completedAt,
          completedAt,
          row.portal_id,
          row.id,
        ),
        env.DB.prepare(
          `UPDATE recommendation_delivery_slo_incidents
           SET last_notification_status = ?, updated_at = ?
           WHERE portal_id = ? AND id = ?`,
        ).bind(status, completedAt, row.portal_id, row.incident_id),
      ]);
    } catch (error) {
      await failNotification(
        env,
        row,
        error instanceof Error ? error.message : String(error),
        true,
      );
    }
  }
}

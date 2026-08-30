import { decryptSecret } from './crypto.js';
import { sendEmail } from './email.js';
import { AppError } from './errors.js';
import {
  deliveryBatchStatus,
  inQuietHours,
  jsonStrings,
  routeExplicitlyMatches,
} from './recommendation-operations-model.js';
import {
  RECOMMENDATION_FOLLOWUP_EVENT,
  type RecommendationChannelSummary,
  type RecommendationFollowupBatchStatus,
  type RecommendationFollowupDeliveryResult,
  type RecommendationFollowupItemStatus,
  type RecommendationFollowupKind,
  type RecommendationFollowupRoutingMatch,
  type RecommendationFollowupScope,
  type RecommendationFollowupSeverity,
  type RecommendationRouteConfig,
} from './recommendation-operations-types.js';
import { Repository } from './repository.js';
import type { Env } from './types.js';

const encoder = new TextEncoder();

interface RouteRow extends Record<string, unknown> {
  id: string;
  name: string;
  event_types_json: string;
  minimum_severity: 'info' | 'warning' | 'critical';
  pipeline_ids_json: string;
  team_ids_json: string;
  owner_ids_json: string;
  region_codes_json: string;
  channel_ids_json: string;
  quiet_hours_calendar_id: string | null;
  enabled: number;
  updated_at: string;
}

export interface FollowupChannelRow extends Record<string, unknown> {
  id: string;
  type: RecommendationChannelSummary['type'];
  name: string;
  endpoint_cipher: string | null;
  endpoint_iv: string | null;
  signing_secret_cipher: string | null;
  signing_secret_iv: string | null;
  config_json: string;
  enabled: number;
  updated_at: string;
}

interface CalendarRow extends Record<string, unknown> {
  id: string;
  timezone: string;
  weekly_schedule_json: string;
  holidays_json: string;
}

export interface FollowupBatchRow extends Record<string, unknown> {
  id: string;
  portal_id: string;
  kind: RecommendationFollowupKind;
  severity: RecommendationFollowupSeverity;
  manager_note: string;
  status: RecommendationFollowupBatchStatus;
  requested_count: number;
  eligible_count: number;
  delivery_ready_count: number;
  confirmed_count: number;
  delivered_count: number;
  failed_count: number;
  routing_summary_json: string;
  preview_expires_at: string;
  created_by_user_id: string | null;
  created_by_email: string | null;
  confirmed_by_user_id: string | null;
  confirmed_by_email: string | null;
  confirmed_at: string | null;
  completed_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface FollowupItemRow extends Record<string, unknown> {
  id: string;
  portal_id: string;
  batch_id: string;
  recommendation_id: string;
  deal_id: string;
  recommendation_code: string;
  recommendation_label: string;
  recommendation_text: string;
  recommendation_status: string;
  priority: 'high' | 'medium' | 'low';
  due_at: string | null;
  pipeline_id: string | null;
  team_id: string | null;
  owner_id: string | null;
  region_code: string | null;
  matched_route_ids_json: string;
  matched_channel_ids_json: string;
  routing_fingerprint: string | null;
  status: RecommendationFollowupItemStatus;
  ineligibility_reason: string | null;
  delivery_summary_json: string;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

export interface FollowupRoutingState {
  routes: RecommendationRouteConfig[];
  channels: FollowupChannelRow[];
  channelSummaries: RecommendationChannelSummary[];
  quietRouteIds: Set<string>;
}

function parseJson<T>(value: unknown, fallback: T): T {
  if (typeof value !== 'string') return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

export function itemScope(row: FollowupItemRow): RecommendationFollowupScope {
  return {
    pipelineId: typeof row.pipeline_id === 'string' && row.pipeline_id ? row.pipeline_id : null,
    teamId: typeof row.team_id === 'string' && row.team_id ? row.team_id : null,
    ownerId: typeof row.owner_id === 'string' && row.owner_id ? row.owner_id : null,
    regionCode: typeof row.region_code === 'string' && row.region_code ? row.region_code : null,
  };
}

export async function loadFollowupRoutingState(
  env: Env,
  portalId: string,
  now = new Date(),
): Promise<FollowupRoutingState> {
  const [routeResult, channelResult, calendarResult] = await Promise.all([
    env.DB.prepare(
      `SELECT id, name, event_types_json, minimum_severity, pipeline_ids_json, team_ids_json,
              owner_ids_json, region_codes_json, channel_ids_json, quiet_hours_calendar_id,
              enabled, updated_at
       FROM notification_routes
       WHERE portal_id = ? AND enabled = 1
       ORDER BY created_at ASC`,
    ).bind(portalId).all<RouteRow>(),
    env.DB.prepare(
      `SELECT id, type, name, endpoint_cipher, endpoint_iv, signing_secret_cipher,
              signing_secret_iv, config_json, enabled, updated_at
       FROM notification_channels
       WHERE portal_id = ? AND enabled = 1
       ORDER BY created_at ASC`,
    ).bind(portalId).all<FollowupChannelRow>(),
    env.DB.prepare(
      `SELECT id, timezone, weekly_schedule_json, holidays_json
       FROM business_calendars
       WHERE portal_id = ?`,
    ).bind(portalId).all<CalendarRow>(),
  ]);
  const routeRows = routeResult.results ?? [];
  const channels = channelResult.results ?? [];
  const calendars = new Map((calendarResult.results ?? []).map((row) => [row.id, {
    timezone: row.timezone,
    weeklySchedule: parseJson<Record<string, { start?: string; end?: string; enabled?: boolean }>>(row.weekly_schedule_json, {}),
    holidays: jsonStrings(row.holidays_json, 1000),
  }]));
  const quietRouteIds = new Set<string>();
  for (const route of routeRows) {
    if (!route.quiet_hours_calendar_id) continue;
    if (inQuietHours(calendars.get(route.quiet_hours_calendar_id) ?? null, now)) quietRouteIds.add(route.id);
  }
  return {
    channels,
    quietRouteIds,
    routes: routeRows.map((route) => ({
      id: route.id,
      name: route.name,
      eventTypes: jsonStrings(route.event_types_json),
      minimumSeverity: route.minimum_severity,
      pipelineIds: jsonStrings(route.pipeline_ids_json),
      teamIds: jsonStrings(route.team_ids_json),
      ownerIds: jsonStrings(route.owner_ids_json),
      regionCodes: jsonStrings(route.region_codes_json),
      channelIds: jsonStrings(route.channel_ids_json),
      quietHoursCalendarId: route.quiet_hours_calendar_id,
      enabled: Boolean(route.enabled),
      updatedAt: route.updated_at,
    })),
    channelSummaries: channels.map((channel) => ({
      id: channel.id,
      name: channel.name,
      type: channel.type,
      updatedAt: channel.updated_at,
    })),
  };
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

function followupSummary(batch: FollowupBatchRow, item: FollowupItemRow): string {
  const kind = batch.kind === 'manager_review' ? 'Manager review requested' : 'Owner follow-up requested';
  return `${kind} for ${item.recommendation_label}: ${item.recommendation_text} Manager note: ${batch.manager_note}`;
}

async function deliverChannel(
  env: Env,
  batch: FollowupBatchRow,
  item: FollowupItemRow,
  channel: FollowupChannelRow,
): Promise<void> {
  const summary = followupSummary(batch, item);
  const recordUrl = `https://app.hubspot.com/contacts/${encodeURIComponent(batch.portal_id)}/record/0-3/${encodeURIComponent(item.deal_id)}`;
  const payload = {
    eventType: RECOMMENDATION_FOLLOWUP_EVENT,
    batchId: batch.id,
    followupKind: batch.kind,
    severity: batch.severity,
    managerNote: batch.manager_note,
    recommendation: {
      id: item.recommendation_id,
      code: item.recommendation_code,
      label: item.recommendation_label,
      action: item.recommendation_text,
      status: item.recommendation_status,
      priority: item.priority,
      dueAt: item.due_at,
    },
    deal: {
      id: item.deal_id,
      recordUrl,
      pipelineId: item.pipeline_id,
      teamId: item.team_id,
      ownerId: item.owner_id,
      regionCode: item.region_code,
    },
    semantics: { humanConfirmed: true, noCrmMutation: true, deterministicContent: true },
  };
  if (channel.type === 'email') {
    const recipients = jsonStrings(parseJson<{ recipients?: string[] }>(channel.config_json, {}).recipients, 100)
      .filter((email) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email));
    if (recipients.length === 0) {
      throw new AppError(409, 'recommendation_followup_email_unconfigured', `Email channel ${channel.name} has no valid recipients.`);
    }
    await sendEmail(
      env,
      recipients,
      `DealGuard follow-up: ${item.recommendation_label}`,
      `<h1>${escapeHtml(item.recommendation_label)}</h1><p>${escapeHtml(item.recommendation_text)}</p><p><strong>Manager note:</strong> ${escapeHtml(batch.manager_note)}</p><p><a href="${escapeHtml(recordUrl)}">Open deal record</a></p>`,
    );
    return;
  }
  if (!channel.endpoint_cipher || !channel.endpoint_iv) {
    throw new AppError(409, 'recommendation_followup_channel_unconfigured', `Notification channel ${channel.name} has no configured endpoint.`);
  }
  const endpoint = await decryptSecret(channel.endpoint_cipher, channel.endpoint_iv, env.TOKEN_ENCRYPTION_KEY);
  const envelope = JSON.stringify({
    id: crypto.randomUUID(),
    type: RECOMMENDATION_FOLLOWUP_EVENT,
    severity: batch.severity,
    occurredAt: new Date().toISOString(),
    portalId: batch.portal_id,
    aggregate: { type: 'recommendation', id: item.recommendation_id },
    data: payload,
  });
  const body = channel.type === 'slack_webhook' || channel.type === 'teams_workflow'
    ? JSON.stringify({ text: `DealGuard ${batch.severity}: ${summary}\n${recordUrl}` })
    : envelope;
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'user-agent': 'DealGuard-Recommendation-Followup/1.0',
  };
  if (channel.type === 'webhook') {
    headers['x-dealguard-event'] = RECOMMENDATION_FOLLOWUP_EVENT;
    headers['x-dealguard-delivery'] = `${batch.id}:${item.recommendation_id}`;
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
    throw new AppError(502, 'recommendation_followup_delivery_failed', `Channel ${channel.name} returned HTTP ${response.status}.`);
  }
}

async function markBatchFailed(env: Env, portalId: string, batchId: string, error: unknown): Promise<void> {
  const now = new Date().toISOString();
  const message = (error instanceof Error ? error.message : String(error)).slice(0, 1000);
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE recommendation_followup_batches
       SET status = 'failed', failed_count = GREATEST(failed_count, confirmed_count),
           completed_at = ?, updated_at = ?
       WHERE portal_id = ? AND id = ? AND status IN ('queued', 'delivering')`,
    ).bind(now, now, portalId, batchId),
    env.DB.prepare(
      `UPDATE recommendation_followup_items
       SET status = 'failed', last_error = ?, updated_at = ?
       WHERE portal_id = ? AND batch_id = ? AND status IN ('queued', 'delivering')`,
    ).bind(message, now, portalId, batchId),
  ]);
  console.error(JSON.stringify({
    level: 'error',
    task: 'recommendation_followup_delivery',
    portalId,
    batchId,
    error: message,
  }));
}

export async function deliverRecommendationFollowupBatch(
  env: Env,
  portalId: string,
  batchId: string,
): Promise<void> {
  const claimedAt = new Date().toISOString();
  const claimed = await env.DB.prepare(
    `UPDATE recommendation_followup_batches
     SET status = 'delivering', updated_at = ?
     WHERE portal_id = ? AND id = ? AND status = 'queued'`,
  ).bind(claimedAt, portalId, batchId).run();
  if (Number(claimed.meta?.changes ?? 0) <= 0) return;
  try {
    const batch = await env.DB.prepare(
      `SELECT * FROM recommendation_followup_batches WHERE portal_id = ? AND id = ? LIMIT 1`,
    ).bind(portalId, batchId).first<FollowupBatchRow>();
    if (!batch) throw new AppError(404, 'recommendation_followup_batch_not_found', 'The recommendation follow-up batch does not exist.');
    const itemResult = await env.DB.prepare(
      `SELECT * FROM recommendation_followup_items
       WHERE portal_id = ? AND batch_id = ? ORDER BY created_at ASC, id ASC`,
    ).bind(portalId, batchId).all<FollowupItemRow>();
    const items = itemResult.results ?? [];
    const state = await loadFollowupRoutingState(env, portalId);
    const channelById = new Map(state.channels.map((channel) => [channel.id, channel]));
    const routeById = new Map(state.routes.map((route) => [route.id, route]));
    const expectedByRecommendation = parseJson<{
      items?: Record<string, RecommendationFollowupRoutingMatch>;
    }>(batch.routing_summary_json, {}).items ?? {};
    let delivered = 0;
    let partiallyFailed = 0;
    let failed = 0;

    for (const item of items) {
      if (item.status !== 'queued') continue;
      const itemClaim = await env.DB.prepare(
        `UPDATE recommendation_followup_items SET status = 'delivering', updated_at = ?
         WHERE portal_id = ? AND batch_id = ? AND id = ? AND status = 'queued'`,
      ).bind(new Date().toISOString(), portalId, batchId, item.id).run();
      if (Number(itemClaim.meta?.changes ?? 0) <= 0) continue;

      const expected = expectedByRecommendation[item.recommendation_id];
      const expectedRouteById = new Map((expected?.routes ?? []).map((route) => [route.id, route]));
      const storedRouteIds = jsonStrings(item.matched_route_ids_json);
      const storedChannelIds = new Set(jsonStrings(item.matched_channel_ids_json));
      const activeChannelIds = new Set<string>();
      for (const routeId of storedRouteIds) {
        const route = routeById.get(routeId);
        const expectedRoute = expectedRouteById.get(routeId);
        if (!route || !expectedRoute || route.updatedAt !== expectedRoute.updatedAt) continue;
        if (state.quietRouteIds.has(routeId)) continue;
        if (!routeExplicitlyMatches(route, itemScope(item), batch.severity)) continue;
        const expectedChannelById = new Map(expectedRoute.channels.map((channel) => [channel.id, channel]));
        for (const channelId of route.channelIds) {
          const channel = channelById.get(channelId);
          const expectedChannel = expectedChannelById.get(channelId);
          if (!storedChannelIds.has(channelId) || !channel || !expectedChannel) continue;
          if (channel.type !== expectedChannel.type || channel.updated_at !== expectedChannel.updatedAt) continue;
          activeChannelIds.add(channelId);
        }
      }
      const selectedChannels = [...activeChannelIds]
        .sort()
        .map((id) => channelById.get(id)!)
        .filter(Boolean);
      const results: RecommendationFollowupDeliveryResult[] = [];
      for (const channel of selectedChannels) {
        try {
          await deliverChannel(env, batch, item, channel);
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
      const successes = results.filter((result) => result.status === 'delivered').length;
      const failures = results.filter((result) => result.status === 'failed').length;
      const status: RecommendationFollowupItemStatus = successes > 0 && failures === 0
        ? 'delivered'
        : successes > 0
          ? 'partially_failed'
          : 'failed';
      if (status === 'delivered') delivered += 1;
      else if (status === 'partially_failed') partiallyFailed += 1;
      else failed += 1;
      const lastError = selectedChannels.length === 0
        ? 'No unchanged, enabled, explicitly opted-in channels remained available at delivery time.'
        : results.find((result) => result.status === 'failed')?.error ?? null;
      await env.DB.prepare(
        `UPDATE recommendation_followup_items
         SET status = ?, delivery_summary_json = ?, last_error = ?, updated_at = ?
         WHERE portal_id = ? AND batch_id = ? AND id = ?`,
      ).bind(
        status,
        JSON.stringify(results),
        lastError,
        new Date().toISOString(),
        portalId,
        batchId,
        item.id,
      ).run();
    }

    const completedAt = new Date().toISOString();
    const finalStatus = deliveryBatchStatus(delivered, partiallyFailed, failed);
    await env.DB.prepare(
      `UPDATE recommendation_followup_batches
       SET status = ?, delivered_count = ?, failed_count = ?, completed_at = ?, updated_at = ?
       WHERE portal_id = ? AND id = ?`,
    ).bind(
      finalStatus,
      delivered,
      partiallyFailed + failed,
      completedAt,
      completedAt,
      portalId,
      batchId,
    ).run();
    await new Repository(env).audit(
      portalId,
      batch.confirmed_by_user_id,
      batch.confirmed_by_email,
      'recommendation.followup_delivery_completed',
      {
        batchId,
        status: finalStatus,
        delivered,
        partiallyFailed,
        failed,
        noCrmMutation: true,
      },
    );
  } catch (error) {
    await markBatchFailed(env, portalId, batchId, error).catch(() => undefined);
    throw error;
  }
}

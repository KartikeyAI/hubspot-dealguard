import { decryptSecret } from './crypto.js';
import { sendEmail } from './email.js';
import { requireEnterprisePermission, type EnterpriseAccessContext } from './enterprise-access.js';
import { AppError } from './errors.js';
import {
  deliveryBatchStatus,
  inQuietHours,
  jsonStrings,
  routingMatch,
  scopeAllowed,
  uniqueStrings,
} from './recommendation-operations-model.js';
import {
  RECOMMENDATION_FOLLOWUP_EVENT,
  type RecommendationChannelSummary,
  type RecommendationFollowupBatchStatus,
  type RecommendationFollowupBatchView,
  type RecommendationFollowupDeliveryResult,
  type RecommendationFollowupKind,
  type RecommendationFollowupPreviewItem,
  type RecommendationFollowupRoutingMatch,
  type RecommendationFollowupScope,
  type RecommendationFollowupSeverity,
  type RecommendationRouteConfig,
} from './recommendation-operations-types.js';
import {
  RECOMMENDATION_SELECT,
  type RecommendationRow,
} from './recommendation-outcome-storage.js';
import { Repository } from './repository.js';
import type { Env, RequestIdentity } from './types.js';

const PREVIEW_TTL_MS = 15 * 60_000;
const MAX_RECOMMENDATIONS = 100;
const MAX_BATCH_LIST = 20;
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
}

interface ChannelRow extends Record<string, unknown> {
  id: string;
  type: RecommendationChannelSummary['type'];
  name: string;
  endpoint_cipher: string | null;
  endpoint_iv: string | null;
  signing_secret_cipher: string | null;
  signing_secret_iv: string | null;
  config_json: string;
  enabled: number;
}

interface CalendarRow extends Record<string, unknown> {
  id: string;
  timezone: string;
  weekly_schedule_json: string;
  holidays_json: string;
}

interface BatchRow extends Record<string, unknown> {
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

interface ItemRow extends Record<string, unknown> {
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
  status: RecommendationFollowupPreviewItem['status'];
  ineligibility_reason: string | null;
  delivery_summary_json: string;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

interface RoutingState {
  routes: RecommendationRouteConfig[];
  routeRows: RouteRow[];
  channels: ChannelRow[];
  channelSummaries: RecommendationChannelSummary[];
  quietRouteIds: Set<string>;
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function text(value: unknown, maximum = 500): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  return normalized ? normalized.slice(0, maximum) : null;
}

function iso(value: unknown): string | null {
  const normalized = text(value, 80);
  if (!normalized) return null;
  const parsed = Date.parse(normalized);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

function parseJson<T>(value: unknown, fallback: T): T {
  if (typeof value !== 'string') return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function number(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function recommendationScope(row: RecommendationRow | ItemRow): RecommendationFollowupScope {
  return {
    pipelineId: text('baseline_pipeline_id' in row ? row.baseline_pipeline_id : row.pipeline_id, 128),
    teamId: text('baseline_team_id' in row ? row.baseline_team_id : row.team_id, 128),
    ownerId: text('baseline_owner_id' in row ? row.baseline_owner_id : row.owner_id, 128),
    regionCode: text('baseline_region_code' in row ? row.baseline_region_id : row.region_code, 128),
  };
}

function correctRecommendationScope(row: RecommendationRow): RecommendationFollowupScope {
  return {
    pipelineId: text(row.baseline_pipeline_id, 128),
    teamId: text(row.baseline_team_id, 128),
    ownerId: text(row.baseline_owner_id, 128),
    regionCode: text(row.baseline_region_code, 128),
  };
}

function itemScope(row: ItemRow): RecommendationFollowupScope {
  return {
    pipelineId: text(row.pipeline_id, 128),
    teamId: text(row.team_id, 128),
    ownerId: text(row.owner_id, 128),
    regionCode: text(row.region_code, 128),
  };
}

function actorPresent(identity: RequestIdentity): boolean {
  return Boolean(identity.userId || identity.userEmail);
}

function sameActor(batch: BatchRow, identity: RequestIdentity): boolean {
  if (batch.created_by_user_id) return batch.created_by_user_id === identity.userId;
  if (batch.created_by_email) {
    return batch.created_by_email.toLowerCase() === (identity.userEmail ?? '').toLowerCase();
  }
  return false;
}

function admin(access: EnterpriseAccessContext): boolean {
  return access.permissions.includes('*');
}

function recommendationIds(value: unknown): string[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new AppError(400, 'recommendation_followup_ids_required', 'Select at least one recommendation.');
  }
  if (value.length > MAX_RECOMMENDATIONS) {
    throw new AppError(400, 'recommendation_followup_limit', `A follow-up preview can contain at most ${MAX_RECOMMENDATIONS} recommendations.`);
  }
  const ids = uniqueStrings(value, MAX_RECOMMENDATIONS);
  if (ids.length === 0) {
    throw new AppError(400, 'recommendation_followup_ids_required', 'Select at least one valid recommendation.');
  }
  return ids;
}

function batchKind(value: unknown): RecommendationFollowupKind {
  if (value === 'owner_reminder' || value === 'manager_review') return value;
  throw new AppError(400, 'recommendation_followup_kind_invalid', 'Choose owner reminder or manager review.');
}

function batchSeverity(value: unknown): RecommendationFollowupSeverity {
  if (value === 'critical') return 'critical';
  if (value === undefined || value === null || value === 'warning') return 'warning';
  throw new AppError(400, 'recommendation_followup_severity_invalid', 'Choose warning or critical severity.');
}

function managerNote(value: unknown): string {
  const note = text(value, 2000);
  if (!note || note.length < 10) {
    throw new AppError(400, 'recommendation_followup_note_required', 'Add a manager note of at least 10 characters before previewing delivery.');
  }
  return note;
}

async function routingState(env: Env, portalId: string, now = new Date()): Promise<RoutingState> {
  const [routeResult, channelResult, calendarResult] = await Promise.all([
    env.DB.prepare(
      `SELECT id, name, event_types_json, minimum_severity, pipeline_ids_json, team_ids_json,
              owner_ids_json, region_codes_json, channel_ids_json, quiet_hours_calendar_id, enabled
       FROM notification_routes
       WHERE portal_id = ? AND enabled = 1
       ORDER BY created_at ASC`,
    ).bind(portalId).all<RouteRow>(),
    env.DB.prepare(
      `SELECT id, type, name, endpoint_cipher, endpoint_iv, signing_secret_cipher,
              signing_secret_iv, config_json, enabled
       FROM notification_channels
       WHERE portal_id = ? AND enabled = 1
       ORDER BY created_at ASC`,
    ).bind(portalId).all<ChannelRow>(),
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
    routeRows,
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
      quietHoursCalendarId: text(route.quiet_hours_calendar_id, 128),
      enabled: Boolean(route.enabled),
    })),
    channelSummaries: channels.map((channel) => ({
      id: channel.id,
      name: channel.name,
      type: channel.type,
    })),
  };
}

async function loadRecommendations(
  env: Env,
  portalId: string,
  ids: string[],
): Promise<RecommendationRow[]> {
  const placeholders = ids.map(() => '?').join(', ');
  const result = await env.DB.prepare(
    `${RECOMMENDATION_SELECT}
     WHERE recommendation.portal_id = ? AND recommendation.id IN (${placeholders})`,
  ).bind(portalId, ...ids).all<RecommendationRow>();
  const rows = result.results ?? [];
  if (rows.length !== ids.length) {
    throw new AppError(404, 'recommendation_followup_selection_invalid', 'One or more selected recommendations no longer exist. Refresh and preview again.');
  }
  const order = new Map(ids.map((id, index) => [id, index]));
  return [...rows].sort((left, right) => (order.get(left.id) ?? 0) - (order.get(right.id) ?? 0));
}

async function previewItem(
  row: RecommendationRow,
  state: RoutingState,
  input: {
    kind: RecommendationFollowupKind;
    severity: RecommendationFollowupSeverity;
    managerNote: string;
  },
): Promise<RecommendationFollowupPreviewItem> {
  const scope = correctRecommendationScope(row);
  const active = row.status === 'presented' || row.status === 'accepted';
  const routing = active
    ? await routingMatch({
        routes: state.routes,
        channels: state.channelSummaries,
        quietRouteIds: state.quietRouteIds,
        scope,
        severity: input.severity,
        recommendationId: row.id,
        recommendationStatus: row.status,
        priority: row.priority,
        dueAt: iso(row.due_at),
        kind: input.kind,
        managerNote: input.managerNote,
      })
    : { routeIds: [], channelIds: [], routes: [], fingerprint: '', ready: false };
  const ineligibilityReason = !active
    ? `Recommendation is ${row.status}; only presented or accepted recommendations can receive a follow-up.`
    : !routing.ready
      ? `No enabled notification route explicitly opts into ${RECOMMENDATION_FOLLOWUP_EVENT} for this recommendation's severity and data scope outside configured quiet hours.`
      : null;
  return {
    recommendationId: row.id,
    dealId: row.deal_id,
    recommendationCode: row.recommendation_code,
    label: row.recommendation_label,
    action: row.recommendation_text,
    recommendationStatus: row.status,
    priority: row.priority,
    dueAt: iso(row.due_at),
    overdue: row.status === 'accepted' && Boolean(row.due_at && Date.parse(row.due_at) < Date.now()),
    scope,
    status: !active ? 'skipped' : routing.ready ? 'previewed' : 'unroutable',
    eligible: active,
    deliveryReady: active && routing.ready,
    ineligibilityReason,
    routing,
  };
}

function routingSummary(items: RecommendationFollowupPreviewItem[]): Record<string, unknown> {
  const routes = new Map<string, { id: string; name: string; channelIds: string[]; channelNames: string[] }>();
  const itemRouting: Record<string, RecommendationFollowupRoutingMatch> = {};
  for (const item of items) {
    itemRouting[item.recommendationId] = item.routing;
    for (const route of item.routing.routes) routes.set(route.id, route);
  }
  return {
    eventType: RECOMMENDATION_FOLLOWUP_EVENT,
    explicitRouteOptInRequired: true,
    routes: [...routes.values()],
    items: itemRouting,
  };
}

function routingForStoredItem(batch: BatchRow, item: ItemRow): RecommendationFollowupRoutingMatch {
  const summary = parseJson<{ items?: Record<string, RecommendationFollowupRoutingMatch> }>(batch.routing_summary_json, {});
  const stored = summary.items?.[item.recommendation_id];
  if (stored) return stored;
  return {
    routeIds: jsonStrings(item.matched_route_ids_json),
    channelIds: jsonStrings(item.matched_channel_ids_json),
    routes: [],
    fingerprint: item.routing_fingerprint ?? '',
    ready: item.status !== 'unroutable' && item.status !== 'skipped',
  };
}

function mapStoredItem(batch: BatchRow, item: ItemRow): RecommendationFollowupPreviewItem {
  const routing = routingForStoredItem(batch, item);
  const active = item.recommendation_status === 'presented' || item.recommendation_status === 'accepted';
  return {
    recommendationId: item.recommendation_id,
    dealId: item.deal_id,
    recommendationCode: item.recommendation_code,
    label: item.recommendation_label,
    action: item.recommendation_text,
    recommendationStatus: item.recommendation_status,
    priority: item.priority,
    dueAt: iso(item.due_at),
    overdue: item.recommendation_status === 'accepted' && Boolean(item.due_at && Date.parse(item.due_at) < Date.now()),
    scope: itemScope(item),
    status: item.status,
    eligible: active,
    deliveryReady: active && routing.ready,
    ineligibilityReason: text(item.ineligibility_reason, 2000),
    routing,
  };
}

async function expirePreviewIfNeeded(env: Env, batch: BatchRow): Promise<BatchRow> {
  if (batch.status !== 'previewed' || Date.parse(batch.preview_expires_at) > Date.now()) return batch;
  const now = new Date().toISOString();
  await env.DB.prepare(
    `UPDATE recommendation_followup_batches
     SET status = 'expired', updated_at = ?
     WHERE portal_id = ? AND id = ? AND status = 'previewed'`,
  ).bind(now, batch.portal_id, batch.id).run();
  return { ...batch, status: 'expired', updated_at: now };
}

async function batchRows(env: Env, portalId: string, batchId: string): Promise<{ batch: BatchRow; items: ItemRow[] }> {
  const row = await env.DB.prepare(
    `SELECT * FROM recommendation_followup_batches WHERE portal_id = ? AND id = ? LIMIT 1`,
  ).bind(portalId, batchId).first<BatchRow>();
  if (!row) throw new AppError(404, 'recommendation_followup_batch_not_found', 'The recommendation follow-up batch does not exist.');
  const batch = await expirePreviewIfNeeded(env, row);
  const items = await env.DB.prepare(
    `SELECT * FROM recommendation_followup_items
     WHERE portal_id = ? AND batch_id = ?
     ORDER BY created_at ASC, id ASC`,
  ).bind(portalId, batchId).all<ItemRow>();
  return { batch, items: items.results ?? [] };
}

function mapBatch(batch: BatchRow, items: ItemRow[]): RecommendationFollowupBatchView {
  const deliveryReady = batch.requested_count > 0
    && batch.eligible_count === batch.requested_count
    && batch.delivery_ready_count === batch.requested_count;
  return {
    id: batch.id,
    kind: batch.kind,
    severity: batch.severity,
    managerNote: batch.manager_note,
    status: batch.status,
    requestedCount: number(batch.requested_count),
    eligibleCount: number(batch.eligible_count),
    deliveryReadyCount: number(batch.delivery_ready_count),
    confirmedCount: number(batch.confirmed_count),
    deliveredCount: number(batch.delivered_count),
    failedCount: number(batch.failed_count),
    deliveryReady,
    confirmationRequired: batch.status === 'previewed',
    previewExpiresAt: batch.preview_expires_at,
    confirmedAt: iso(batch.confirmed_at),
    completedAt: iso(batch.completed_at),
    createdAt: batch.created_at,
    updatedAt: batch.updated_at,
    items: items.map((item) => mapStoredItem(batch, item)),
    semantics: {
      explicitRouteOptInRequired: true,
      humanConfirmationRequired: true,
      noCrmMutation: true,
      noAutonomousOutreach: true,
      notificationContentIsDeterministic: true,
    },
  };
}

export async function previewRecommendationFollowup(
  env: Env,
  identity: RequestIdentity,
  value: unknown,
): Promise<RecommendationFollowupBatchView> {
  const access = await requireEnterprisePermission(env, identity, 'remediation.bulk');
  if (!actorPresent(identity)) {
    throw new AppError(403, 'recommendation_followup_actor_required', 'A HubSpot user identity is required to preview and confirm follow-up delivery.');
  }
  const input = object(value);
  const ids = recommendationIds(input.recommendationIds);
  const kind = batchKind(input.kind);
  const severity = batchSeverity(input.severity);
  const note = managerNote(input.managerNote);
  const [rows, routing] = await Promise.all([
    loadRecommendations(env, identity.portalId, ids),
    routingState(env, identity.portalId),
  ]);
  for (const row of rows) {
    if (!scopeAllowed(correctRecommendationScope(row), access)) {
      throw new AppError(403, 'recommendation_followup_scope_denied', 'One or more selected recommendations are outside your assigned data scope.');
    }
  }
  const items = await Promise.all(rows.map((row) => previewItem(row, routing, {
    kind,
    severity,
    managerNote: note,
  })));
  const eligible = items.filter((item) => item.eligible).length;
  const ready = items.filter((item) => item.deliveryReady).length;
  const now = new Date();
  const createdAt = now.toISOString();
  const expiresAt = new Date(now.getTime() + PREVIEW_TTL_MS).toISOString();
  const batchId = crypto.randomUUID();
  const statements = [
    env.DB.prepare(
      `INSERT INTO recommendation_followup_batches (
        id, portal_id, kind, severity, manager_note, status,
        requested_count, eligible_count, delivery_ready_count,
        routing_summary_json, preview_expires_at,
        created_by_user_id, created_by_email, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, 'previewed', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      batchId, identity.portalId, kind, severity, note,
      ids.length, eligible, ready, JSON.stringify(routingSummary(items)), expiresAt,
      identity.userId, identity.userEmail, createdAt, createdAt,
    ),
    ...items.map((item) => env.DB.prepare(
      `INSERT INTO recommendation_followup_items (
        id, portal_id, batch_id, recommendation_id, deal_id,
        recommendation_code, recommendation_label, recommendation_text, recommendation_status,
        priority, due_at, pipeline_id, team_id, owner_id, region_code,
        matched_route_ids_json, matched_channel_ids_json, routing_fingerprint,
        status, ineligibility_reason, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      crypto.randomUUID(), identity.portalId, batchId, item.recommendationId, item.dealId,
      item.recommendationCode, item.label, item.action, item.recommendationStatus,
      item.priority, item.dueAt, item.scope.pipelineId, item.scope.teamId, item.scope.ownerId, item.scope.regionCode,
      JSON.stringify(item.routing.routeIds), JSON.stringify(item.routing.channelIds), item.routing.fingerprint || null,
      item.status, item.ineligibilityReason, createdAt, createdAt,
    )),
  ];
  await env.DB.batch(statements);
  await new Repository(env).audit(identity.portalId, identity.userId, identity.userEmail, 'recommendation.followup_previewed', {
    batchId,
    kind,
    severity,
    requestedCount: ids.length,
    eligibleCount: eligible,
    deliveryReadyCount: ready,
    previewExpiresAt: expiresAt,
    notificationsSent: false,
  });
  return mapBatch({
    id: batchId,
    portal_id: identity.portalId,
    kind,
    severity,
    manager_note: note,
    status: 'previewed',
    requested_count: ids.length,
    eligible_count: eligible,
    delivery_ready_count: ready,
    confirmed_count: 0,
    delivered_count: 0,
    failed_count: 0,
    routing_summary_json: JSON.stringify(routingSummary(items)),
    preview_expires_at: expiresAt,
    created_by_user_id: identity.userId,
    created_by_email: identity.userEmail,
    confirmed_by_user_id: null,
    confirmed_by_email: null,
    confirmed_at: null,
    completed_at: null,
    created_at: createdAt,
    updated_at: createdAt,
  }, items.map((item, index) => ({
    id: `preview-${index}`,
    portal_id: identity.portalId,
    batch_id: batchId,
    recommendation_id: item.recommendationId,
    deal_id: item.dealId,
    recommendation_code: item.recommendationCode,
    recommendation_label: item.label,
    recommendation_text: item.action,
    recommendation_status: item.recommendationStatus,
    priority: item.priority,
    due_at: item.dueAt,
    pipeline_id: item.scope.pipelineId,
    team_id: item.scope.teamId,
    owner_id: item.scope.ownerId,
    region_code: item.scope.regionCode,
    matched_route_ids_json: JSON.stringify(item.routing.routeIds),
    matched_channel_ids_json: JSON.stringify(item.routing.channelIds),
    routing_fingerprint: item.routing.fingerprint || null,
    status: item.status,
    ineligibility_reason: item.ineligibilityReason,
    delivery_summary_json: '[]',
    last_error: null,
    created_at: createdAt,
    updated_at: createdAt,
  })));
}

export async function getRecommendationFollowupBatch(
  env: Env,
  identity: RequestIdentity,
  batchId: string,
): Promise<RecommendationFollowupBatchView> {
  const access = await requireEnterprisePermission(env, identity, 'remediation.bulk');
  const { batch, items } = await batchRows(env, identity.portalId, batchId);
  if (!admin(access) && !sameActor(batch, identity)) {
    throw new AppError(403, 'recommendation_followup_batch_denied', 'Only the initiating manager or an administrator can view this follow-up batch.');
  }
  if (!admin(access) && items.some((item) => !scopeAllowed(itemScope(item), access))) {
    throw new AppError(403, 'recommendation_followup_scope_denied', 'This follow-up batch is outside your current assigned data scope.');
  }
  return mapBatch(batch, items);
}

export async function listRecommendationFollowupBatches(
  env: Env,
  identity: RequestIdentity,
  url: URL,
): Promise<{ batches: RecommendationFollowupBatchView[] }> {
  const access = await requireEnterprisePermission(env, identity, 'remediation.bulk');
  const limit = Math.min(MAX_BATCH_LIST, Math.max(1, Number(url.searchParams.get('limit') ?? 10) || 10));
  const rows = admin(access)
    ? await env.DB.prepare(
        `SELECT * FROM recommendation_followup_batches
         WHERE portal_id = ? ORDER BY created_at DESC LIMIT ?`,
      ).bind(identity.portalId, limit).all<BatchRow>()
    : identity.userId
      ? await env.DB.prepare(
          `SELECT * FROM recommendation_followup_batches
           WHERE portal_id = ? AND created_by_user_id = ?
           ORDER BY created_at DESC LIMIT ?`,
        ).bind(identity.portalId, identity.userId, limit).all<BatchRow>()
      : await env.DB.prepare(
          `SELECT * FROM recommendation_followup_batches
           WHERE portal_id = ? AND lower(created_by_email) = lower(?)
           ORDER BY created_at DESC LIMIT ?`,
        ).bind(identity.portalId, identity.userEmail, limit).all<BatchRow>();
  const batches: RecommendationFollowupBatchView[] = [];
  for (const row of rows.results ?? []) {
    const { batch, items } = await batchRows(env, identity.portalId, row.id);
    if (!admin(access) && items.some((item) => !scopeAllowed(itemScope(item), access))) continue;
    batches.push(mapBatch(batch, items));
  }
  return { batches };
}

async function confirmedRouting(
  env: Env,
  batch: BatchRow,
  items: ItemRow[],
): Promise<{ currentRows: RecommendationRow[]; routingById: Map<string, RecommendationFollowupRoutingMatch> }> {
  const currentRows = await loadRecommendations(env, batch.portal_id, items.map((item) => item.recommendation_id));
  const currentById = new Map(currentRows.map((row) => [row.id, row]));
  const state = await routingState(env, batch.portal_id);
  const routingById = new Map<string, RecommendationFollowupRoutingMatch>();
  for (const item of items) {
    const current = currentById.get(item.recommendation_id)!;
    if (current.status !== 'presented' && current.status !== 'accepted') {
      throw new AppError(409, 'recommendation_followup_preview_changed', 'A selected recommendation is no longer active. Create a new preview.');
    }
    const routing = await routingMatch({
      routes: state.routes,
      channels: state.channelSummaries,
      quietRouteIds: state.quietRouteIds,
      scope: correctRecommendationScope(current),
      severity: batch.severity,
      recommendationId: current.id,
      recommendationStatus: current.status,
      priority: current.priority,
      dueAt: iso(current.due_at),
      kind: batch.kind,
      managerNote: batch.manager_note,
    });
    if (!routing.ready || routing.fingerprint !== item.routing_fingerprint) {
      throw new AppError(409, 'recommendation_followup_routing_changed', 'Recommendation state or notification routing changed after preview. Create and confirm a new preview.');
    }
    routingById.set(item.recommendation_id, routing);
  }
  return { currentRows, routingById };
}

export async function confirmRecommendationFollowup(
  env: Env,
  identity: RequestIdentity,
  batchId: string,
  ctx: { waitUntil(promise: Promise<unknown>): void },
): Promise<RecommendationFollowupBatchView> {
  const access = await requireEnterprisePermission(env, identity, 'remediation.bulk');
  const { batch, items } = await batchRows(env, identity.portalId, batchId);
  if (!admin(access) && !sameActor(batch, identity)) {
    throw new AppError(403, 'recommendation_followup_confirmation_denied', 'Only the initiating manager or an administrator can confirm this follow-up batch.');
  }
  if (batch.status !== 'previewed') return mapBatch(batch, items);
  if (Date.parse(batch.preview_expires_at) <= Date.now()) {
    throw new AppError(409, 'recommendation_followup_preview_expired', 'The follow-up preview expired. Create a new preview before sending notifications.');
  }
  if (
    batch.requested_count === 0
    || batch.eligible_count !== batch.requested_count
    || batch.delivery_ready_count !== batch.requested_count
    || items.some((item) => item.status !== 'previewed')
  ) {
    throw new AppError(409, 'recommendation_followup_not_ready', 'Every selected recommendation must be active and have an explicitly opted-in notification route before confirmation.');
  }
  if (items.some((item) => !scopeAllowed(itemScope(item), access))) {
    throw new AppError(403, 'recommendation_followup_scope_denied', 'A selected recommendation is outside your current assigned data scope.');
  }
  const { currentRows, routingById } = await confirmedRouting(env, batch, items);
  const now = new Date().toISOString();
  const statements = [
    env.DB.prepare(
      `UPDATE recommendation_followup_batches
       SET status = 'queued', confirmed_count = ?, confirmed_by_user_id = ?, confirmed_by_email = ?,
           confirmed_at = ?, updated_at = ?
       WHERE portal_id = ? AND id = ? AND status = 'previewed'`,
    ).bind(items.length, identity.userId, identity.userEmail, now, now, identity.portalId, batchId),
    ...items.map((item) => {
      const routing = routingById.get(item.recommendation_id)!;
      return env.DB.prepare(
        `UPDATE recommendation_followup_items
         SET status = 'queued', matched_route_ids_json = ?, matched_channel_ids_json = ?,
             routing_fingerprint = ?, updated_at = ?
         WHERE portal_id = ? AND batch_id = ? AND recommendation_id = ? AND status = 'previewed'`,
      ).bind(
        JSON.stringify(routing.routeIds), JSON.stringify(routing.channelIds), routing.fingerprint,
        now, identity.portalId, batchId, item.recommendation_id,
      );
    }),
    ...currentRows.map((row) => env.DB.prepare(
      `INSERT INTO recommendation_events (
        id, portal_id, recommendation_id, deal_id, event_type,
        actor_user_id, actor_email, metadata_json, occurred_at
      ) VALUES (?, ?, ?, ?, 'followup_requested', ?, ?, ?, ?)`,
    ).bind(
      crypto.randomUUID(), identity.portalId, row.id, row.deal_id,
      identity.userId, identity.userEmail,
      JSON.stringify({ batchId, kind: batch.kind, severity: batch.severity, managerNote: batch.manager_note }),
      now,
    )),
  ];
  const results = await env.DB.batch(statements);
  if (Number(results[0]?.meta?.changes ?? 0) <= 0) {
    const current = await batchRows(env, identity.portalId, batchId);
    return mapBatch(current.batch, current.items);
  }
  await new Repository(env).audit(identity.portalId, identity.userId, identity.userEmail, 'recommendation.followup_confirmed', {
    batchId,
    kind: batch.kind,
    severity: batch.severity,
    recommendationCount: items.length,
    humanConfirmed: true,
    noCrmMutation: true,
  });
  ctx.waitUntil(deliverRecommendationFollowupBatch(env, identity.portalId, batchId).catch((error) => {
    console.error(JSON.stringify({
      level: 'error',
      task: 'recommendation_followup_delivery',
      portalId: identity.portalId,
      batchId,
      error: error instanceof Error ? error.message : String(error),
    }));
  }));
  const queued = await batchRows(env, identity.portalId, batchId);
  return mapBatch(queued.batch, queued.items);
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

function followupSummary(batch: BatchRow, item: ItemRow): string {
  const kind = batch.kind === 'manager_review' ? 'Manager review requested' : 'Owner follow-up requested';
  return `${kind} for ${item.recommendation_label}: ${item.recommendation_text} Manager note: ${batch.manager_note}`;
}

async function deliverChannel(
  env: Env,
  batch: BatchRow,
  item: ItemRow,
  channel: ChannelRow,
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
    semantics: {
      humanConfirmed: true,
      noCrmMutation: true,
      deterministicContent: true,
    },
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
  const { batch, items } = await batchRows(env, portalId, batchId);
  const channelIds = [...new Set(items.flatMap((item) => jsonStrings(item.matched_channel_ids_json)))];
  const channels = channelIds.length > 0
    ? await env.DB.prepare(
        `SELECT id, type, name, endpoint_cipher, endpoint_iv, signing_secret_cipher,
                signing_secret_iv, config_json, enabled
         FROM notification_channels
         WHERE portal_id = ? AND enabled = 1 AND id IN (${channelIds.map(() => '?').join(', ')})`,
      ).bind(portalId, ...channelIds).all<ChannelRow>()
    : { results: [] as ChannelRow[], success: true };
  const channelById = new Map((channels.results ?? []).map((channel) => [channel.id, channel]));
  let delivered = 0;
  let partiallyFailed = 0;
  let failed = 0;
  for (const item of items) {
    if (item.status !== 'queued') continue;
    const startedAt = new Date().toISOString();
    await env.DB.prepare(
      `UPDATE recommendation_followup_items SET status = 'delivering', updated_at = ?
       WHERE portal_id = ? AND batch_id = ? AND id = ? AND status = 'queued'`,
    ).bind(startedAt, portalId, batchId, item.id).run();
    const selectedChannels = jsonStrings(item.matched_channel_ids_json)
      .map((id) => channelById.get(id))
      .filter((channel): channel is ChannelRow => Boolean(channel));
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
    const status: ItemRow['status'] = successes > 0 && failures === 0
      ? 'delivered'
      : successes > 0
        ? 'partially_failed'
        : 'failed';
    if (status === 'delivered') delivered += 1;
    else if (status === 'partially_failed') partiallyFailed += 1;
    else failed += 1;
    const lastError = results.find((result) => result.status === 'failed')?.error ?? null;
    await env.DB.prepare(
      `UPDATE recommendation_followup_items
       SET status = ?, delivery_summary_json = ?, last_error = ?, updated_at = ?
       WHERE portal_id = ? AND batch_id = ? AND id = ?`,
    ).bind(
      status, JSON.stringify(results), lastError, new Date().toISOString(), portalId, batchId, item.id,
    ).run();
  }
  const completedAt = new Date().toISOString();
  const finalStatus = deliveryBatchStatus(delivered, partiallyFailed, failed);
  await env.DB.prepare(
    `UPDATE recommendation_followup_batches
     SET status = ?, delivered_count = ?, failed_count = ?, completed_at = ?, updated_at = ?
     WHERE portal_id = ? AND id = ?`,
  ).bind(
    finalStatus, delivered, partiallyFailed + failed, completedAt, completedAt, portalId, batchId,
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
}

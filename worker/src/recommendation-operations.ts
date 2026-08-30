import { requireEnterprisePermission, type EnterpriseAccessContext } from './enterprise-access.js';
import { AppError } from './errors.js';
import {
  deliverRecommendationFollowupBatch,
  itemScope,
  loadFollowupRoutingState,
  type FollowupBatchRow,
  type FollowupItemRow,
  type FollowupRoutingState,
} from './recommendation-followup-delivery.js';
import {
  jsonStrings,
  routingMatch,
  scopeAllowed,
  uniqueStrings,
} from './recommendation-operations-model.js';
import {
  RECOMMENDATION_FOLLOWUP_EVENT,
  type RecommendationFollowupBatchView,
  type RecommendationFollowupKind,
  type RecommendationFollowupPreviewItem,
  type RecommendationFollowupRoutingMatch,
  type RecommendationFollowupScope,
  type RecommendationFollowupSeverity,
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

function numeric(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function recommendationScope(row: RecommendationRow): RecommendationFollowupScope {
  return {
    pipelineId: text(row.baseline_pipeline_id, 128),
    teamId: text(row.baseline_team_id, 128),
    ownerId: text(row.baseline_owner_id, 128),
    regionCode: text(row.baseline_region_code, 128),
  };
}

function actorPresent(identity: RequestIdentity): boolean {
  return Boolean(identity.userId || identity.userEmail);
}

function sameActor(batch: FollowupBatchRow, identity: RequestIdentity): boolean {
  if (batch.created_by_user_id) return batch.created_by_user_id === identity.userId;
  if (batch.created_by_email) {
    return batch.created_by_email.toLowerCase() === (identity.userEmail ?? '').toLowerCase();
  }
  return false;
}

function administrator(access: EnterpriseAccessContext): boolean {
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
  state: FollowupRoutingState,
  input: {
    kind: RecommendationFollowupKind;
    severity: RecommendationFollowupSeverity;
    managerNote: string;
  },
): Promise<RecommendationFollowupPreviewItem> {
  const scope = recommendationScope(row);
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

function routingForStoredItem(batch: FollowupBatchRow, item: FollowupItemRow): RecommendationFollowupRoutingMatch {
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

function mapStoredItem(batch: FollowupBatchRow, item: FollowupItemRow): RecommendationFollowupPreviewItem {
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

async function expirePreviewIfNeeded(env: Env, batch: FollowupBatchRow): Promise<FollowupBatchRow> {
  if (batch.status !== 'previewed' || Date.parse(batch.preview_expires_at) > Date.now()) return batch;
  const now = new Date().toISOString();
  await env.DB.prepare(
    `UPDATE recommendation_followup_batches
     SET status = 'expired', updated_at = ?
     WHERE portal_id = ? AND id = ? AND status = 'previewed'`,
  ).bind(now, batch.portal_id, batch.id).run();
  return { ...batch, status: 'expired', updated_at: now };
}

async function batchRows(
  env: Env,
  portalId: string,
  batchId: string,
): Promise<{ batch: FollowupBatchRow; items: FollowupItemRow[] }> {
  const row = await env.DB.prepare(
    `SELECT * FROM recommendation_followup_batches WHERE portal_id = ? AND id = ? LIMIT 1`,
  ).bind(portalId, batchId).first<FollowupBatchRow>();
  if (!row) throw new AppError(404, 'recommendation_followup_batch_not_found', 'The recommendation follow-up batch does not exist.');
  const batch = await expirePreviewIfNeeded(env, row);
  const items = await env.DB.prepare(
    `SELECT * FROM recommendation_followup_items
     WHERE portal_id = ? AND batch_id = ?
     ORDER BY created_at ASC, id ASC`,
  ).bind(portalId, batchId).all<FollowupItemRow>();
  return { batch, items: items.results ?? [] };
}

function mapBatch(batch: FollowupBatchRow, items: FollowupItemRow[]): RecommendationFollowupBatchView {
  const requested = numeric(batch.requested_count);
  const eligible = numeric(batch.eligible_count);
  const ready = numeric(batch.delivery_ready_count);
  return {
    id: batch.id,
    kind: batch.kind,
    severity: batch.severity,
    managerNote: batch.manager_note,
    status: batch.status,
    requestedCount: requested,
    eligibleCount: eligible,
    deliveryReadyCount: ready,
    confirmedCount: numeric(batch.confirmed_count),
    deliveredCount: numeric(batch.delivered_count),
    failedCount: numeric(batch.failed_count),
    deliveryReady: requested > 0 && eligible === requested && ready === requested,
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
    loadFollowupRoutingState(env, identity.portalId),
  ]);
  for (const row of rows) {
    if (!scopeAllowed(recommendationScope(row), access)) {
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
  const summary = routingSummary(items);
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO recommendation_followup_batches (
        id, portal_id, kind, severity, manager_note, status,
        requested_count, eligible_count, delivery_ready_count,
        routing_summary_json, preview_expires_at,
        created_by_user_id, created_by_email, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, 'previewed', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      batchId,
      identity.portalId,
      kind,
      severity,
      note,
      ids.length,
      eligible,
      ready,
      JSON.stringify(summary),
      expiresAt,
      identity.userId,
      identity.userEmail,
      createdAt,
      createdAt,
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
      crypto.randomUUID(),
      identity.portalId,
      batchId,
      item.recommendationId,
      item.dealId,
      item.recommendationCode,
      item.label,
      item.action,
      item.recommendationStatus,
      item.priority,
      item.dueAt,
      item.scope.pipelineId,
      item.scope.teamId,
      item.scope.ownerId,
      item.scope.regionCode,
      JSON.stringify(item.routing.routeIds),
      JSON.stringify(item.routing.channelIds),
      item.routing.fingerprint || null,
      item.status,
      item.ineligibilityReason,
      createdAt,
      createdAt,
    )),
  ]);
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
  const stored = await batchRows(env, identity.portalId, batchId);
  return mapBatch(stored.batch, stored.items);
}

export async function getRecommendationFollowupBatch(
  env: Env,
  identity: RequestIdentity,
  batchId: string,
): Promise<RecommendationFollowupBatchView> {
  const access = await requireEnterprisePermission(env, identity, 'remediation.bulk');
  const { batch, items } = await batchRows(env, identity.portalId, batchId);
  if (!administrator(access) && !sameActor(batch, identity)) {
    throw new AppError(403, 'recommendation_followup_batch_denied', 'Only the initiating manager or an administrator can view this follow-up batch.');
  }
  if (!administrator(access) && items.some((item) => !scopeAllowed(itemScope(item), access))) {
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
  if (!actorPresent(identity) && !administrator(access)) {
    throw new AppError(403, 'recommendation_followup_actor_required', 'A HubSpot user identity is required to list follow-up batches.');
  }
  const limit = Math.min(MAX_BATCH_LIST, Math.max(1, Number(url.searchParams.get('limit') ?? 10) || 10));
  const rows = administrator(access)
    ? await env.DB.prepare(
        `SELECT * FROM recommendation_followup_batches
         WHERE portal_id = ? ORDER BY created_at DESC LIMIT ?`,
      ).bind(identity.portalId, limit).all<FollowupBatchRow>()
    : identity.userId
      ? await env.DB.prepare(
          `SELECT * FROM recommendation_followup_batches
           WHERE portal_id = ? AND created_by_user_id = ?
           ORDER BY created_at DESC LIMIT ?`,
        ).bind(identity.portalId, identity.userId, limit).all<FollowupBatchRow>()
      : await env.DB.prepare(
          `SELECT * FROM recommendation_followup_batches
           WHERE portal_id = ? AND lower(created_by_email) = lower(?)
           ORDER BY created_at DESC LIMIT ?`,
        ).bind(identity.portalId, identity.userEmail, limit).all<FollowupBatchRow>();
  const batches: RecommendationFollowupBatchView[] = [];
  for (const row of rows.results ?? []) {
    const { batch, items } = await batchRows(env, identity.portalId, row.id);
    if (!administrator(access) && items.some((item) => !scopeAllowed(itemScope(item), access))) continue;
    batches.push(mapBatch(batch, items));
  }
  return { batches };
}

async function confirmedRouting(
  env: Env,
  batch: FollowupBatchRow,
  items: FollowupItemRow[],
): Promise<{ currentRows: RecommendationRow[]; routingById: Map<string, RecommendationFollowupRoutingMatch> }> {
  const currentRows = await loadRecommendations(env, batch.portal_id, items.map((item) => item.recommendation_id));
  const currentById = new Map(currentRows.map((row) => [row.id, row]));
  const state = await loadFollowupRoutingState(env, batch.portal_id);
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
      scope: recommendationScope(current),
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
  if (!administrator(access) && !sameActor(batch, identity)) {
    throw new AppError(403, 'recommendation_followup_confirmation_denied', 'Only the initiating manager or an administrator can confirm this follow-up batch.');
  }
  if (batch.status === 'expired') {
    throw new AppError(409, 'recommendation_followup_preview_expired', 'The follow-up preview expired. Create a new preview before sending notifications.');
  }
  if (batch.status !== 'previewed') return mapBatch(batch, items);
  if (
    numeric(batch.requested_count) === 0
    || numeric(batch.eligible_count) !== numeric(batch.requested_count)
    || numeric(batch.delivery_ready_count) !== numeric(batch.requested_count)
    || items.some((item) => item.status !== 'previewed')
  ) {
    throw new AppError(409, 'recommendation_followup_not_ready', 'Every selected recommendation must be active and have an explicitly opted-in notification route before confirmation.');
  }
  if (items.some((item) => !scopeAllowed(itemScope(item), access))) {
    throw new AppError(403, 'recommendation_followup_scope_denied', 'A selected recommendation is outside your current assigned data scope.');
  }
  const { currentRows, routingById } = await confirmedRouting(env, batch, items);
  const confirmedAt = new Date().toISOString();
  const claim = await env.DB.prepare(
    `UPDATE recommendation_followup_batches
     SET status = 'confirming', confirmed_count = ?, confirmed_by_user_id = ?, confirmed_by_email = ?,
         confirmed_at = ?, updated_at = ?
     WHERE portal_id = ? AND id = ? AND status = 'previewed' AND preview_expires_at::timestamptz > NOW()`,
  ).bind(
    items.length,
    identity.userId,
    identity.userEmail,
    confirmedAt,
    confirmedAt,
    identity.portalId,
    batchId,
  ).run();
  if (Number(claim.meta?.changes ?? 0) <= 0) {
    const current = await batchRows(env, identity.portalId, batchId);
    if (current.batch.status === 'expired') {
      throw new AppError(409, 'recommendation_followup_preview_expired', 'The follow-up preview expired. Create a new preview before sending notifications.');
    }
    return mapBatch(current.batch, current.items);
  }

  try {
    const transaction = [
      ...items.map((item) => {
        const routing = routingById.get(item.recommendation_id)!;
        return env.DB.prepare(
          `UPDATE recommendation_followup_items
           SET status = 'queued', matched_route_ids_json = ?, matched_channel_ids_json = ?,
               routing_fingerprint = ?, updated_at = ?
           WHERE portal_id = ? AND batch_id = ? AND recommendation_id = ? AND status = 'previewed'`,
        ).bind(
          JSON.stringify(routing.routeIds),
          JSON.stringify(routing.channelIds),
          routing.fingerprint,
          confirmedAt,
          identity.portalId,
          batchId,
          item.recommendation_id,
        );
      }),
      ...currentRows.map((row) => env.DB.prepare(
        `INSERT INTO recommendation_events (
          id, portal_id, recommendation_id, deal_id, event_type,
          actor_user_id, actor_email, metadata_json, occurred_at
        ) VALUES (?, ?, ?, ?, 'followup_requested', ?, ?, ?, ?)`,
      ).bind(
        crypto.randomUUID(),
        identity.portalId,
        row.id,
        row.deal_id,
        identity.userId,
        identity.userEmail,
        JSON.stringify({
          batchId,
          kind: batch.kind,
          severity: batch.severity,
          managerNote: batch.manager_note,
          humanConfirmed: true,
        }),
        confirmedAt,
      )),
      env.DB.prepare(
        `UPDATE recommendation_followup_batches
         SET status = 'queued', updated_at = ?
         WHERE portal_id = ? AND id = ? AND status = 'confirming'`,
      ).bind(confirmedAt, identity.portalId, batchId),
    ];
    const results = await env.DB.batch(transaction);
    if (Number(results.at(-1)?.meta?.changes ?? 0) <= 0) {
      throw new AppError(409, 'recommendation_followup_confirmation_conflict', 'The follow-up batch changed during confirmation.');
    }
  } catch (error) {
    const failedAt = new Date().toISOString();
    await env.DB.prepare(
      `UPDATE recommendation_followup_batches
       SET status = 'failed', failed_count = confirmed_count, completed_at = ?, updated_at = ?
       WHERE portal_id = ? AND id = ? AND status = 'confirming'`,
    ).bind(failedAt, failedAt, identity.portalId, batchId).run();
    throw error;
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

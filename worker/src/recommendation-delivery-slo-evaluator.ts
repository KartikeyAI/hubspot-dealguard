import {
  advanceRecommendationDeliverySlo,
  evaluateRecommendationDeliverySloMetric,
  worseDeliverySloValue,
  type RecommendationDeliverySloAttempt,
  type RecommendationDeliverySloDispatchEvidence,
  type RecommendationDeliverySloEvidence,
  type RecommendationDeliverySloEventEvidence,
} from './recommendation-delivery-slo-model.js';
import { queuePortalRecommendationDeliverySloNotification } from './recommendation-delivery-slo-notifications.js';
import {
  deliverySloPolicyFromRow,
  deliverySloStateFromRow,
  type DeliverySloIncidentRow,
  type DeliverySloPolicyRow,
  type DeliverySloStateRow,
} from './recommendation-delivery-slos.js';
import {
  RECOMMENDATION_DELIVERY_SLO_BREACHED_EVENT,
  RECOMMENDATION_DELIVERY_SLO_RECOVERED_EVENT,
  RECOMMENDATION_DELIVERY_SLO_REMINDER_EVENT,
  type RecommendationDeliverySloEvaluationSummary,
  type RecommendationDeliverySloIncident,
  type RecommendationDeliverySloPolicy,
  type RecommendationDeliverySloState,
} from './recommendation-delivery-slo-types.js';
import { Repository } from './repository.js';
import type { Env } from './types.js';

const MAX_POLICIES_PER_RUN = 500;
const ATTEMPT_LIMIT = 20_000;
const EVENT_LIMIT = 20_000;
const DISPATCH_LIMIT = 10_000;

interface AttemptRow extends Record<string, unknown> {
  batch_id: string;
  item_id: string;
  authorization_mode: 'human_confirmation' | 'configured_policy';
  automation_policy_id: string | null;
  item_status: string;
  created_at: string;
  confirmed_at: string | null;
  completed_at: string | null;
  matched_route_ids_json: string;
  delivery_summary_json: string;
}

interface EventRow extends Record<string, unknown> {
  event_type: string;
  policy_id: string | null;
  route_id: string | null;
  event_at: string;
}

interface DispatchRow extends Record<string, unknown> {
  id: string;
  policy_id: string;
  first_queued_at: string | null;
  escalated_at: string | null;
  resolved_at: string | null;
  escalation_after_minutes: number | null;
}

function parseJson<T>(value: unknown, fallback: T): T {
  if (typeof value !== 'string') return fallback;
  try { return JSON.parse(value) as T; } catch { return fallback; }
}

function strings(value: unknown): string[] {
  const parsed = parseJson<unknown[]>(value, []);
  return [...new Set(parsed.filter((item): item is string => typeof item === 'string' && Boolean(item.trim())).map((item) => item.trim()))];
}

function attempt(row: AttemptRow): RecommendationDeliverySloAttempt {
  const results: RecommendationDeliverySloAttempt['channelResults'] = [];
  for (const entry of parseJson<unknown[]>(row.delivery_summary_json, [])) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const item = entry as Record<string, unknown>;
    const channelId = typeof item.channelId === 'string' ? item.channelId : null;
    if (channelId && (item.status === 'delivered' || item.status === 'failed')) {
      results.push({ channelId, status: item.status });
    }
  }
  return {
    batchId: row.batch_id,
    itemId: row.item_id,
    authorizationMode: row.authorization_mode,
    routingPolicyId: row.automation_policy_id,
    itemStatus: row.item_status,
    createdAt: row.created_at,
    confirmedAt: row.confirmed_at,
    completedAt: row.completed_at,
    routeIds: strings(row.matched_route_ids_json),
    channelResults: results,
  };
}

function event(row: EventRow): RecommendationDeliverySloEventEvidence {
  return {
    eventType: row.event_type,
    routingPolicyId: row.policy_id,
    routeId: row.route_id,
    eventAt: row.event_at,
  };
}

function dispatch(row: DispatchRow): RecommendationDeliverySloDispatchEvidence {
  return {
    id: row.id,
    routingPolicyId: row.policy_id,
    firstQueuedAt: row.first_queued_at,
    escalatedAt: row.escalated_at,
    resolvedAt: row.resolved_at,
    escalationAfterMinutes: row.escalation_after_minutes === null ? null : Number(row.escalation_after_minutes),
  };
}

async function loadEvidence(
  env: Env,
  portalId: string,
  windowMinutes: number,
): Promise<RecommendationDeliverySloEvidence> {
  const end = new Date();
  const start = new Date(end.getTime() - windowMinutes * 60_000);
  const [attemptRows, eventRows, dispatchRows] = await Promise.all([
    env.DB.prepare(
      `SELECT batch.id AS batch_id, item.id AS item_id,
              batch.authorization_mode, batch.automation_policy_id,
              item.status AS item_status, batch.created_at,
              batch.confirmed_at, batch.completed_at,
              item.matched_route_ids_json, item.delivery_summary_json
       FROM recommendation_followup_items item
       JOIN recommendation_followup_batches batch
         ON batch.portal_id = item.portal_id AND batch.id = item.batch_id
       WHERE item.portal_id = ?
         AND batch.created_at::timestamptz >= ?::timestamptz
         AND batch.created_at::timestamptz <= ?::timestamptz
       ORDER BY batch.created_at DESC, item.created_at DESC
       LIMIT ?`,
    ).bind(portalId, start.toISOString(), end.toISOString(), ATTEMPT_LIMIT).all<AttemptRow>(),
    env.DB.prepare(
      `SELECT event_type, policy_id, route_id, event_at
       FROM recommendation_delivery_events
       WHERE portal_id = ?
         AND event_at::timestamptz >= ?::timestamptz
         AND event_at::timestamptz <= ?::timestamptz
       ORDER BY event_at DESC
       LIMIT ?`,
    ).bind(portalId, start.toISOString(), end.toISOString(), EVENT_LIMIT).all<EventRow>(),
    env.DB.prepare(
      `SELECT dispatch.id, dispatch.policy_id, dispatch.first_queued_at,
              dispatch.escalated_at, dispatch.resolved_at,
              policy.escalation_after_minutes
       FROM recommendation_policy_dispatches dispatch
       JOIN recommendation_routing_policies policy
         ON policy.portal_id = dispatch.portal_id AND policy.id = dispatch.policy_id
       WHERE dispatch.portal_id = ?
       ORDER BY dispatch.updated_at DESC
       LIMIT ?`,
    ).bind(portalId, DISPATCH_LIMIT).all<DispatchRow>(),
  ]);
  return {
    attempts: (attemptRows.results ?? []).map(attempt),
    events: (eventRows.results ?? []).map(event),
    dispatches: (dispatchRows.results ?? []).map(dispatch),
    start: start.toISOString(),
    end: end.toISOString(),
    truncated: (attemptRows.results?.length ?? 0) >= ATTEMPT_LIMIT
      || (eventRows.results?.length ?? 0) >= EVENT_LIMIT
      || (dispatchRows.results?.length ?? 0) >= DISPATCH_LIMIT,
  };
}

function incidentView(
  row: DeliverySloIncidentRow,
  policy: RecommendationDeliverySloPolicy,
): RecommendationDeliverySloIncident {
  return {
    id: row.id,
    sloPolicyId: row.slo_policy_id,
    policyName: policy.name,
    status: row.status,
    severity: row.severity,
    metric: row.metric,
    targetType: row.target_type,
    targetId: row.target_id,
    targetLabel: policy.targetLabel,
    comparison: row.comparison,
    thresholdValue: Number(row.threshold_value),
    firstValue: row.first_value === null ? null : Number(row.first_value),
    worstValue: row.worst_value === null ? null : Number(row.worst_value),
    lastValue: row.last_value === null ? null : Number(row.last_value),
    lastSampleCount: Number(row.last_sample_count ?? 0),
    openedAt: row.opened_at,
    lastObservedAt: row.last_observed_at,
    acknowledgedAt: row.acknowledged_at,
    resolvedAt: row.resolved_at,
    resolutionReason: row.resolution_reason,
    alertCount: Number(row.alert_count ?? 0),
    lastNotificationId: row.last_notification_id,
    lastNotificationStatus: row.last_notification_status,
    lastAlertAt: row.last_alert_at,
  };
}

async function saveState(
  env: Env,
  portalId: string,
  policyId: string,
  state: RecommendationDeliverySloState,
): Promise<void> {
  const now = new Date().toISOString();
  await env.DB.prepare(
    `INSERT INTO recommendation_delivery_slo_states (
      portal_id, slo_policy_id, status, consecutive_breaches, consecutive_recoveries,
      first_breached_at, last_breached_at, last_recovered_at,
      last_alert_at, next_alert_at, current_value, sample_count,
      evidence_start_at, evidence_end_at, evidence_truncated,
      last_reason, evaluated_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(portal_id, slo_policy_id) DO UPDATE SET
      status = excluded.status,
      consecutive_breaches = excluded.consecutive_breaches,
      consecutive_recoveries = excluded.consecutive_recoveries,
      first_breached_at = excluded.first_breached_at,
      last_breached_at = excluded.last_breached_at,
      last_recovered_at = excluded.last_recovered_at,
      last_alert_at = excluded.last_alert_at,
      next_alert_at = excluded.next_alert_at,
      current_value = excluded.current_value,
      sample_count = excluded.sample_count,
      evidence_start_at = excluded.evidence_start_at,
      evidence_end_at = excluded.evidence_end_at,
      evidence_truncated = excluded.evidence_truncated,
      last_reason = excluded.last_reason,
      evaluated_at = excluded.evaluated_at,
      updated_at = excluded.updated_at`,
  ).bind(
    portalId, policyId, state.status, state.consecutiveBreaches, state.consecutiveRecoveries,
    state.firstBreachedAt, state.lastBreachedAt, state.lastRecoveredAt,
    state.lastAlertAt, state.nextAlertAt, state.currentValue, state.sampleCount,
    state.evidenceStartAt, state.evidenceEndAt, state.evidenceTruncated ? 1 : 0,
    state.lastReason, state.evaluatedAt, now,
  ).run();
}

async function updatePolicyEvaluation(
  env: Env,
  row: DeliverySloPolicyRow,
  state: RecommendationDeliverySloState,
  error: string | null,
): Promise<void> {
  await env.DB.prepare(
    `UPDATE recommendation_delivery_slo_policies
     SET last_evaluated_at = ?, last_value = ?, last_sample_count = ?,
         last_status = ?, last_error = ?
     WHERE portal_id = ? AND id = ?`,
  ).bind(
    state.evaluatedAt, state.currentValue, state.sampleCount,
    state.status, error, row.portal_id, row.id,
  ).run();
}

async function openIncident(
  env: Env,
  row: DeliverySloPolicyRow,
  policy: RecommendationDeliverySloPolicy,
  state: RecommendationDeliverySloState,
): Promise<DeliverySloIncidentRow> {
  const id = crypto.randomUUID();
  const now = state.evaluatedAt;
  await env.DB.prepare(
    `INSERT INTO recommendation_delivery_slo_incidents (
      id, portal_id, slo_policy_id, status, severity, metric,
      target_type, target_id, comparison, threshold_value,
      first_value, worst_value, last_value, last_sample_count,
      opened_at, last_observed_at, alert_count, created_at, updated_at
    ) VALUES (?, ?, ?, 'open', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
  ).bind(
    id, row.portal_id, row.id, policy.severity, policy.metric,
    policy.targetType, policy.targetId, policy.comparison, policy.thresholdValue,
    state.currentValue, state.currentValue, state.currentValue, state.sampleCount,
    now, now, now, now,
  ).run();
  return (await env.DB.prepare(`SELECT * FROM recommendation_delivery_slo_incidents WHERE portal_id = ? AND id = ?`).bind(row.portal_id, id).first<DeliverySloIncidentRow>())!;
}

async function updateIncident(
  env: Env,
  row: DeliverySloIncidentRow,
  policy: RecommendationDeliverySloPolicy,
  state: RecommendationDeliverySloState,
): Promise<DeliverySloIncidentRow> {
  const worst = worseDeliverySloValue(
    policy.comparison,
    row.worst_value === null ? null : Number(row.worst_value),
    state.currentValue,
  );
  await env.DB.prepare(
    `UPDATE recommendation_delivery_slo_incidents
     SET worst_value = ?, last_value = ?, last_sample_count = ?,
         last_observed_at = ?, updated_at = ?
     WHERE portal_id = ? AND id = ?`,
  ).bind(worst, state.currentValue, state.sampleCount, state.evaluatedAt, state.evaluatedAt, row.portal_id, row.id).run();
  return { ...row, worst_value: worst, last_value: state.currentValue, last_sample_count: state.sampleCount, last_observed_at: state.evaluatedAt };
}

async function queueAlert(
  env: Env,
  portalId: string,
  policy: RecommendationDeliverySloPolicy,
  incidentRow: DeliverySloIncidentRow,
  eventType: typeof RECOMMENDATION_DELIVERY_SLO_BREACHED_EVENT | typeof RECOMMENDATION_DELIVERY_SLO_REMINDER_EVENT | typeof RECOMMENDATION_DELIVERY_SLO_RECOVERED_EVENT,
  sequence: number,
): Promise<boolean> {
  const incident = incidentView(incidentRow, policy);
  const comparison = policy.comparison === 'minimum' ? 'at least' : 'at most';
  const statusText = eventType === RECOMMENDATION_DELIVERY_SLO_RECOVERED_EVENT
    ? 'recovered and is meeting its configured objective'
    : eventType === RECOMMENDATION_DELIVERY_SLO_REMINDER_EVENT
      ? 'remains outside its configured objective'
      : 'breached its configured objective';
  const summary = `${policy.name} ${statusText}. ${policy.metric} is ${incident.lastValue ?? 'unavailable'} from ${incident.lastSampleCount} sample(s); the objective is ${comparison} ${policy.thresholdValue}.`;
  try {
    await queuePortalRecommendationDeliverySloNotification(env, portalId, policy, incident, eventType, {
      summary,
      dedupeKey: `${incident.id}:${eventType}:${sequence}`,
    });
    await env.DB.prepare(
      `UPDATE recommendation_delivery_slo_incidents
       SET alert_count = LEAST(10, alert_count + 1), last_alert_at = ?, updated_at = ?
       WHERE portal_id = ? AND id = ?`,
    ).bind(new Date().toISOString(), new Date().toISOString(), portalId, incident.id).run();
    return true;
  } catch (error) {
    await env.DB.prepare(
      `UPDATE recommendation_delivery_slo_incidents
       SET last_notification_status = 'failed', updated_at = ?
       WHERE portal_id = ? AND id = ?`,
    ).bind(new Date().toISOString(), portalId, incident.id).run();
    throw error;
  }
}

async function resolveIncident(
  env: Env,
  row: DeliverySloIncidentRow,
  state: RecommendationDeliverySloState,
): Promise<DeliverySloIncidentRow> {
  await env.DB.prepare(
    `UPDATE recommendation_delivery_slo_incidents
     SET status = 'resolved', last_value = ?, last_sample_count = ?,
         last_observed_at = ?, resolved_at = ?, resolution_reason = 'objective_recovered',
         updated_at = ?
     WHERE portal_id = ? AND id = ? AND status IN ('open', 'acknowledged')`,
  ).bind(
    state.currentValue, state.sampleCount, state.evaluatedAt,
    state.evaluatedAt, state.evaluatedAt, row.portal_id, row.id,
  ).run();
  return {
    ...row,
    status: 'resolved',
    last_value: state.currentValue,
    last_sample_count: state.sampleCount,
    last_observed_at: state.evaluatedAt,
    resolved_at: state.evaluatedAt,
    resolution_reason: 'objective_recovered',
  };
}

async function evaluatePolicy(
  env: Env,
  row: DeliverySloPolicyRow,
  evidence: RecommendationDeliverySloEvidence,
  previousState: DeliverySloStateRow | null,
  openIncidentRow: DeliverySloIncidentRow | null,
): Promise<{ status: RecommendationDeliverySloState['status']; opened: boolean; resolved: boolean; reminder: boolean; notification: boolean }> {
  const policy = deliverySloPolicyFromRow(row);
  const observation = evaluateRecommendationDeliverySloMetric(policy, evidence);
  const previous = deliverySloStateFromRow(previousState);
  const decision = advanceRecommendationDeliverySlo(
    policy,
    previous,
    observation,
    openIncidentRow ? {
      alertCount: Number(openIncidentRow.alert_count ?? 0),
      nextAlertAt: previous?.nextAlertAt ?? null,
    } : null,
    new Date().toISOString(),
  );
  await saveState(env, row.portal_id, row.id, decision.nextState);
  await updatePolicyEvaluation(env, row, decision.nextState, null);

  let incident = openIncidentRow;
  let opened = false;
  let resolved = false;
  let reminder = false;
  let notification = false;
  if (decision.action === 'open_incident') {
    incident = await openIncident(env, row, policy, decision.nextState);
    opened = true;
    notification = await queueAlert(env, row.portal_id, policy, incident, RECOMMENDATION_DELIVERY_SLO_BREACHED_EVENT, 1);
    await new Repository(env).audit(row.portal_id, row.updated_by_user_id ?? row.created_by_user_id, row.updated_by_email ?? row.created_by_email, 'recommendation.delivery_slo_incident_opened', {
      sloPolicyId: row.id, incidentId: incident.id, metric: policy.metric,
      observedValue: decision.nextState.currentValue, thresholdValue: policy.thresholdValue,
      operationalOnly: true, noCrmMutation: true,
    });
  } else if (incident && (decision.action === 'update_incident' || decision.action === 'send_reminder')) {
    incident = await updateIncident(env, incident, policy, decision.nextState);
    if (decision.action === 'send_reminder') {
      const sequence = Number(incident.alert_count ?? 0) + 1;
      notification = await queueAlert(env, row.portal_id, policy, incident, RECOMMENDATION_DELIVERY_SLO_REMINDER_EVENT, sequence);
      reminder = notification;
    }
  } else if (incident && decision.action === 'resolve_incident') {
    incident = await resolveIncident(env, incident, decision.nextState);
    resolved = true;
    if (policy.notifyRecovery) {
      notification = await queueAlert(env, row.portal_id, policy, incident, RECOMMENDATION_DELIVERY_SLO_RECOVERED_EVENT, 1);
    }
    await new Repository(env).audit(row.portal_id, row.updated_by_user_id ?? row.created_by_user_id, row.updated_by_email ?? row.created_by_email, 'recommendation.delivery_slo_incident_resolved', {
      sloPolicyId: row.id, incidentId: incident.id,
      observedValue: decision.nextState.currentValue,
      operationalOnly: true, noCrmMutation: true,
    });
  }
  return { status: decision.nextState.status, opened, resolved, reminder, notification };
}

export async function evaluateRecommendationDeliverySlos(
  env: Env,
  portalId?: string,
): Promise<RecommendationDeliverySloEvaluationSummary> {
  const policyRows = await env.DB.prepare(
    `SELECT * FROM recommendation_delivery_slo_policies
     WHERE enabled = 1 ${portalId ? 'AND portal_id = ?' : ''}
     ORDER BY portal_id, updated_at ASC
     LIMIT ?`,
  ).bind(...(portalId ? [portalId, MAX_POLICIES_PER_RUN] : [MAX_POLICIES_PER_RUN])).all<DeliverySloPolicyRow>();
  const byPortal = new Map<string, DeliverySloPolicyRow[]>();
  for (const row of policyRows.results ?? []) {
    const group = byPortal.get(row.portal_id) ?? [];
    group.push(row);
    byPortal.set(row.portal_id, group);
  }
  const summary: RecommendationDeliverySloEvaluationSummary = {
    evaluatedPolicies: 0,
    meeting: 0,
    breaching: 0,
    breached: 0,
    recovering: 0,
    insufficientData: 0,
    openedIncidents: 0,
    resolvedIncidents: 0,
    remindersQueued: 0,
    notificationsQueued: 0,
    errors: 0,
  };

  for (const [currentPortalId, policies] of byPortal.entries()) {
    const windows = [...new Set(policies.map((policy) => Number(policy.window_minutes)))];
    const evidenceByWindow = new Map<number, RecommendationDeliverySloEvidence>();
    for (const window of windows) evidenceByWindow.set(window, await loadEvidence(env, currentPortalId, window));
    const [stateRows, incidentRows] = await Promise.all([
      env.DB.prepare(`SELECT * FROM recommendation_delivery_slo_states WHERE portal_id = ?`).bind(currentPortalId).all<DeliverySloStateRow>(),
      env.DB.prepare(
        `SELECT * FROM recommendation_delivery_slo_incidents
         WHERE portal_id = ? AND status IN ('open', 'acknowledged')`,
      ).bind(currentPortalId).all<DeliverySloIncidentRow>(),
    ]);
    const stateByPolicy = new Map((stateRows.results ?? []).map((row) => [row.slo_policy_id, row]));
    const incidentByPolicy = new Map((incidentRows.results ?? []).map((row) => [row.slo_policy_id, row]));

    for (const policy of policies) {
      summary.evaluatedPolicies += 1;
      try {
        const result = await evaluatePolicy(
          env,
          policy,
          evidenceByWindow.get(Number(policy.window_minutes))!,
          stateByPolicy.get(policy.id) ?? null,
          incidentByPolicy.get(policy.id) ?? null,
        );
        if (result.status === 'meeting') summary.meeting += 1;
        else if (result.status === 'breaching') summary.breaching += 1;
        else if (result.status === 'breached') summary.breached += 1;
        else if (result.status === 'recovering') summary.recovering += 1;
        else summary.insufficientData += 1;
        if (result.opened) summary.openedIncidents += 1;
        if (result.resolved) summary.resolvedIncidents += 1;
        if (result.reminder) summary.remindersQueued += 1;
        if (result.notification) summary.notificationsQueued += 1;
      } catch (error) {
        summary.errors += 1;
        const message = (error instanceof Error ? error.message : String(error)).slice(0, 1000);
        await env.DB.prepare(
          `UPDATE recommendation_delivery_slo_policies
           SET last_evaluated_at = ?, last_error = ?
           WHERE portal_id = ? AND id = ?`,
        ).bind(new Date().toISOString(), message, currentPortalId, policy.id).run();
        console.error(JSON.stringify({
          level: 'error', task: 'recommendation_delivery_slo_evaluation',
          portalId: currentPortalId, sloPolicyId: policy.id, error: message,
        }));
      }
    }
  }
  return summary;
}

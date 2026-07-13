import { activePolicy, governanceContext, latestPolicySimulation } from './governance.js';
import type { EnterpriseAnalyticsSnapshot, EnterpriseOverview, Env, RequestIdentity } from './types.js';

function todayUtc(): string {
  return new Date().toISOString().slice(0, 10);
}

function snapshotFromRow(row: Record<string, unknown>, date = todayUtc()): EnterpriseAnalyticsSnapshot {
  return {
    date,
    totalDeals: Number(row.total_deals ?? row.total ?? 0),
    readyDeals: Number(row.ready_deals ?? row.ready ?? 0),
    atRiskDeals: Number(row.at_risk_deals ?? row.at_risk ?? 0),
    criticalDeals: Number(row.critical_deals ?? row.critical ?? 0),
    averageScore: Math.round(Number(row.average_score ?? 0)),
    totalPipelineAmount: Number(row.total_pipeline_amount ?? 0),
    amountAtRisk: Number(row.amount_at_risk ?? 0),
    incompleteHandoffs: Number(row.incomplete_handoffs ?? 0),
  };
}

async function currentMetrics(env: Env, portalId: string): Promise<EnterpriseAnalyticsSnapshot> {
  const row = await env.DB.prepare(
    `SELECT
       COUNT(CASE WHEN a.is_closed = 0 THEN 1 END) AS total,
       SUM(CASE WHEN a.is_closed = 0 AND a.status = 'ready' THEN 1 ELSE 0 END) AS ready,
       SUM(CASE WHEN a.is_closed = 0 AND a.status = 'at_risk' THEN 1 ELSE 0 END) AS at_risk,
       SUM(CASE WHEN a.is_closed = 0 AND a.status = 'critical' THEN 1 ELSE 0 END) AS critical,
       AVG(CASE WHEN a.is_closed = 0 THEN a.score END) AS average_score,
       SUM(CASE WHEN a.is_closed = 0 THEN COALESCE(c.deal_amount, 0) ELSE 0 END) AS total_pipeline_amount,
       SUM(CASE WHEN a.is_closed = 0 AND a.status IN ('at_risk', 'critical') THEN COALESCE(c.deal_amount, 0) ELSE 0 END) AS amount_at_risk,
       SUM(CASE WHEN a.is_won = 1 AND (h.status IS NULL OR h.status != 'confirmed') THEN 1 ELSE 0 END) AS incomplete_handoffs
     FROM deal_assessments a
     LEFT JOIN assessment_context c ON c.portal_id = a.portal_id AND c.deal_id = a.deal_id
     LEFT JOIN handoffs h ON h.portal_id = a.portal_id AND h.deal_id = a.deal_id
     WHERE a.portal_id = ?`
  ).bind(portalId).first<Record<string, unknown>>();
  return snapshotFromRow(row ?? {}, todayUtc());
}

export async function captureAnalyticsSnapshot(env: Env, portalId: string): Promise<EnterpriseAnalyticsSnapshot> {
  const current = await currentMetrics(env, portalId);
  const policy = await activePolicy(env, portalId);
  const now = new Date().toISOString();
  await env.DB.prepare(
    `INSERT INTO analytics_snapshots (portal_id, snapshot_date, total_deals, ready_deals, at_risk_deals, critical_deals, average_score, total_pipeline_amount, amount_at_risk, incomplete_handoffs, policy_id, captured_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(portal_id, snapshot_date) DO UPDATE SET
       total_deals = excluded.total_deals,
       ready_deals = excluded.ready_deals,
       at_risk_deals = excluded.at_risk_deals,
       critical_deals = excluded.critical_deals,
       average_score = excluded.average_score,
       total_pipeline_amount = excluded.total_pipeline_amount,
       amount_at_risk = excluded.amount_at_risk,
       incomplete_handoffs = excluded.incomplete_handoffs,
       policy_id = excluded.policy_id,
       captured_at = excluded.captured_at`
  ).bind(
    portalId,
    current.date,
    current.totalDeals,
    current.readyDeals,
    current.atRiskDeals,
    current.criticalDeals,
    current.averageScore,
    current.totalPipelineAmount,
    current.amountAtRisk,
    current.incompleteHandoffs,
    policy?.id ?? null,
    now,
  ).run();
  return current;
}

export async function enterpriseOverview(env: Env, identity: RequestIdentity): Promise<EnterpriseOverview> {
  const [governance, policy, simulation, current, trendRows, pipelineRows, ownerRows, pendingRow, exceptionRow] = await Promise.all([
    governanceContext(env, identity),
    activePolicy(env, identity.portalId),
    latestPolicySimulation(env, identity.portalId),
    currentMetrics(env, identity.portalId),
    env.DB.prepare(`SELECT * FROM analytics_snapshots WHERE portal_id = ? ORDER BY snapshot_date ASC LIMIT 90`).bind(identity.portalId).all<Record<string, unknown>>(),
    env.DB.prepare(
      `SELECT c.pipeline_id, MAX(a.pipeline_label) AS pipeline_label, COUNT(*) AS total_deals,
       SUM(CASE WHEN a.status = 'critical' THEN 1 ELSE 0 END) AS critical_deals,
       SUM(CASE WHEN a.status IN ('at_risk', 'critical') THEN COALESCE(c.deal_amount, 0) ELSE 0 END) AS amount_at_risk,
       AVG(a.score) AS average_score
       FROM deal_assessments a
       JOIN assessment_context c ON c.portal_id = a.portal_id AND c.deal_id = a.deal_id
       WHERE a.portal_id = ? AND a.is_closed = 0
       GROUP BY c.pipeline_id
       ORDER BY amount_at_risk DESC LIMIT 20`
    ).bind(identity.portalId).all<Record<string, unknown>>(),
    env.DB.prepare(
      `SELECT COALESCE(c.owner_id, 'unassigned') AS owner_id, COUNT(*) AS total_deals,
       SUM(CASE WHEN a.status = 'critical' THEN 1 ELSE 0 END) AS critical_deals,
       SUM(CASE WHEN a.status IN ('at_risk', 'critical') THEN COALESCE(c.deal_amount, 0) ELSE 0 END) AS amount_at_risk,
       AVG(a.score) AS average_score
       FROM deal_assessments a
       JOIN assessment_context c ON c.portal_id = a.portal_id AND c.deal_id = a.deal_id
       WHERE a.portal_id = ? AND a.is_closed = 0
       GROUP BY COALESCE(c.owner_id, 'unassigned')
       ORDER BY amount_at_risk DESC LIMIT 25`
    ).bind(identity.portalId).all<Record<string, unknown>>(),
    env.DB.prepare(`SELECT COUNT(*) AS count FROM policy_versions WHERE portal_id = ? AND status = 'pending_approval'`).bind(identity.portalId).first<{ count: number }>(),
    env.DB.prepare(`SELECT COUNT(*) AS count FROM policy_exceptions WHERE portal_id = ? AND status IN ('pending', 'approved')`).bind(identity.portalId).first<{ count: number }>(),
  ]);

  return {
    governance,
    activePolicy: policy,
    latestSimulation: simulation,
    current,
    trend: (trendRows.results ?? []).map((row) => snapshotFromRow(row, String(row.snapshot_date))),
    byPipeline: (pipelineRows.results ?? []).map((row) => ({
      pipelineId: String(row.pipeline_id ?? ''),
      pipelineLabel: String(row.pipeline_label ?? row.pipeline_id ?? 'Unknown pipeline'),
      totalDeals: Number(row.total_deals ?? 0),
      criticalDeals: Number(row.critical_deals ?? 0),
      amountAtRisk: Number(row.amount_at_risk ?? 0),
      averageScore: Math.round(Number(row.average_score ?? 0)),
    })),
    byOwner: (ownerRows.results ?? []).map((row) => ({
      ownerId: String(row.owner_id ?? 'unassigned'),
      totalDeals: Number(row.total_deals ?? 0),
      criticalDeals: Number(row.critical_deals ?? 0),
      amountAtRisk: Number(row.amount_at_risk ?? 0),
      averageScore: Math.round(Number(row.average_score ?? 0)),
    })),
    pendingApprovals: Number(pendingRow?.count ?? 0),
    openExceptions: Number(exceptionRow?.count ?? 0),
  };
}

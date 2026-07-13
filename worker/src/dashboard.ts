import { Repository } from './repository.js';
import type { DashboardSummary, Env, ScanStatus } from './types.js';

export async function dashboardForPortal(env: Env, portalId: string): Promise<DashboardSummary> {
  const repository = new Repository(env);
  const tenant = await repository.getTenant(portalId);
  const latestCompleted = await env.DB.prepare(
    `SELECT started_at FROM scan_runs WHERE portal_id = ? AND status = 'completed' ORDER BY started_at DESC LIMIT 1`
  ).bind(portalId).first<{ started_at: string }>();
  const snapshotStartedAt = latestCompleted?.started_at ?? '1970-01-01T00:00:00.000Z';

  const counts = await env.DB.prepare(
    `SELECT
     SUM(CASE WHEN a.is_closed = 0 THEN 1 ELSE 0 END) AS total,
     SUM(CASE WHEN a.is_closed = 0 AND a.status = 'ready' THEN 1 ELSE 0 END) AS ready,
     SUM(CASE WHEN a.is_closed = 0 AND a.status = 'at_risk' THEN 1 ELSE 0 END) AS at_risk,
     SUM(CASE WHEN a.is_closed = 0 AND a.status = 'critical' THEN 1 ELSE 0 END) AS critical,
     AVG(CASE WHEN a.is_closed = 0 THEN a.score END) AS average_score,
     SUM(CASE WHEN a.is_won = 1 AND (h.status IS NULL OR h.status != 'confirmed') THEN 1 ELSE 0 END) AS incomplete_handoffs
     FROM deal_assessments a
     LEFT JOIN handoffs h ON h.portal_id = a.portal_id AND h.deal_id = a.deal_id
     WHERE a.portal_id = ? AND a.assessed_at >= ?`
  ).bind(portalId, snapshotStartedAt).first<Record<string, unknown>>();

  const issueRows = await env.DB.prepare(
    `SELECT issues_json FROM deal_assessments
     WHERE portal_id = ? AND assessed_at >= ? AND (is_closed = 0 OR is_won = 1)
     ORDER BY assessed_at DESC LIMIT 5000`
  ).bind(portalId, snapshotStartedAt).all<{ issues_json: string }>();
  const issueMap = new Map<string, { label: string; count: number }>();
  for (const row of issueRows.results ?? []) {
    const issues = JSON.parse(row.issues_json) as Array<{ code: string; label: string }>;
    for (const item of issues) {
      const current = issueMap.get(item.code) ?? { label: item.label, count: 0 };
      current.count += 1;
      issueMap.set(item.code, current);
    }
  }

  const problemRows = await env.DB.prepare(
    `SELECT deal_id, deal_name, pipeline_label, stage_label, score, status, readiness_summary, assessed_at
     FROM deal_assessments
     WHERE portal_id = ? AND assessed_at >= ? AND status IN ('critical', 'at_risk') AND (is_closed = 0 OR is_won = 1)
     ORDER BY CASE status WHEN 'critical' THEN 0 ELSE 1 END, score ASC, assessed_at DESC
     LIMIT 12`
  ).bind(portalId, snapshotStartedAt).all<Record<string, unknown>>();

  const latestScanRow = await env.DB.prepare(
    `SELECT id, trigger_type, status, started_at, completed_at, scanned_count, error_message
     FROM scan_runs WHERE portal_id = ? ORDER BY started_at DESC LIMIT 1`
  ).bind(portalId).first<Record<string, unknown>>();

  return {
    plan: tenant.plan,
    totalDeals: Number(counts?.total ?? 0),
    readyDeals: Number(counts?.ready ?? 0),
    atRiskDeals: Number(counts?.at_risk ?? 0),
    criticalDeals: Number(counts?.critical ?? 0),
    averageScore: Math.round(Number(counts?.average_score ?? 0)),
    incompleteHandoffs: Number(counts?.incomplete_handoffs ?? 0),
    lastScanAt: tenant.last_scan_at,
    nextScanAt: tenant.next_scan_at,
    topIssues: [...issueMap.entries()]
      .map(([code, value]) => ({ code, ...value }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 8),
    problemDeals: (problemRows.results ?? []).map((row) => ({
      dealId: String(row.deal_id),
      dealName: String(row.deal_name),
      pipelineLabel: String(row.pipeline_label),
      stageLabel: String(row.stage_label),
      score: Number(row.score),
      status: row.status as DashboardSummary['problemDeals'][number]['status'],
      readinessSummary: String(row.readiness_summary),
      assessedAt: String(row.assessed_at),
    })),
    latestScan: latestScanRow ? {
      id: String(latestScanRow.id),
      trigger: latestScanRow.trigger_type as ScanStatus['trigger'],
      status: latestScanRow.status as ScanStatus['status'],
      startedAt: String(latestScanRow.started_at),
      completedAt: latestScanRow.completed_at ? String(latestScanRow.completed_at) : null,
      scannedCount: Number(latestScanRow.scanned_count ?? 0),
      errorMessage: latestScanRow.error_message ? String(latestScanRow.error_message) : null,
    } : null,
  };
}

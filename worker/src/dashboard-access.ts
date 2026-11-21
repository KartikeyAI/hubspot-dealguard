import { analyticsFilters, analyticsPredicate, selectedAnalyticsFilters } from './analytics-scope.js';
import { containsInternalImplementationDetail, AppError } from './errors.js';
import { assessmentFreshness } from './evidence-freshness.js';
import { requireRecordActor } from './record-access.js';
import type { Env, RequestIdentity } from './types.js';

/** UI-only collection read. Internal scheduled digests retain their explicit portal context. */
export async function dashboardForIdentity(env: Env, identity: RequestIdentity, url: URL): Promise<Record<string, unknown>> {
  const access = await requireRecordActor(env, identity, 'analytics.view');
  const scope = analyticsFilters(access.scope, selectedAnalyticsFilters(url.searchParams));
  const predicate = analyticsPredicate('current', scope.effective);
  const rows = await env.DB.prepare(`WITH current AS (
    SELECT a.*, COALESCE(h.pipeline_id,c.pipeline_id) AS pipeline_id,
      COALESCE(h.owner_id,c.owner_id) AS owner_id,h.team_id,h.region_code,h.stage_id,
      handoff.status AS handoff_status
    FROM deal_assessments a
    LEFT JOIN assessment_context c ON c.portal_id=a.portal_id AND c.deal_id=a.deal_id AND c.updated_at=a.assessed_at
    LEFT JOIN LATERAL (SELECT pipeline_id,owner_id,team_id,region_code,stage_id FROM assessment_history
      WHERE portal_id=a.portal_id AND deal_id=a.deal_id AND assessed_at=a.assessed_at ORDER BY id DESC LIMIT 1) h ON TRUE
    LEFT JOIN handoffs handoff ON handoff.portal_id=a.portal_id AND handoff.deal_id=a.deal_id
    WHERE a.portal_id=? AND dealguard.record_is_available(a.portal_id,a.deal_id)
  ) SELECT * FROM current WHERE ${predicate.sql} ORDER BY deal_id LIMIT 10001`)
    .bind(identity.portalId,...predicate.params).all<Record<string, unknown>>();
  const all = rows.results ?? [];
  if (all.length > 10000) throw new AppError(422,'dashboard_scope_too_large','More than ten thousand recorded deals match. Narrow your pipeline or owner filter.');
  if (all.some(r => ![0,1].includes(Number(r.is_closed)) || ![0,1].includes(Number(r.is_won))))
    throw new AppError(422,'dashboard_evidence_invalid','Recorded lifecycle evidence requires reconciliation.');
  const open = all.filter(r => Number(r.is_closed) === 0);
  const issueMap = new Map<string, {label: string; count: number}>();
  let issueCoverage = 0;
  for (const row of open) {
    let issues: unknown;
    try { issues = JSON.parse(String(row.issues_json)); } catch { continue; }
    if (!Array.isArray(issues) || issues.some(i => !i || typeof i.code !== 'string' || typeof i.label !== 'string')) continue;
    issueCoverage++;
    for (const item of new Map(issues.map(i => [i.code,i])).values()) {
      const current = issueMap.get(item.code) ?? {label:item.label,count:0};current.count++;issueMap.set(item.code,current);
    }
  }
  const scoped = Object.values(access.scope).some(v => v.length > 0) || Object.keys(scope.effective).length > 0;
  const tenant = await env.DB.prepare('SELECT plan,last_scan_at,next_scan_at FROM tenants WHERE portal_id=?')
    .bind(identity.portalId).first<Record<string, unknown>>();
  const scan = scoped ? null : await env.DB.prepare(`SELECT id,trigger_type,status,started_at,completed_at,scanned_count,error_message
    FROM scan_runs WHERE portal_id=? ORDER BY started_at DESC,id DESC LIMIT 1`).bind(identity.portalId).first<Record<string, unknown>>();
  const error = typeof scan?.error_message === 'string' ? scan.error_message : null;
  const scores = open.map(r => r.score).filter((score):score is number => typeof score === 'number' && Number.isFinite(score) && score >= 0 && score <= 100);
  const ages = open.map(r => assessmentFreshness(r.assessed_at, Date.now()));
  const problemDeals = open.filter(r => ['critical','at_risk'].includes(String(r.status)))
    .sort((a,b) => Number(b.status === 'critical')-Number(a.status === 'critical') || Number(a.score)-Number(b.score) || String(a.deal_id).localeCompare(String(b.deal_id)))
    .slice(0,12).map(r => ({dealId:String(r.deal_id),dealName:String(r.deal_name),pipelineLabel:String(r.pipeline_label),stageLabel:String(r.stage_label),
      score:r.score,status:r.status,readinessSummary:r.readiness_summary,assessedAt:r.assessed_at}));
  // Recheck the actor after all reads; a concurrent role or scope revision must not expose old results.
  const latest = await requireRecordActor(env,identity,'analytics.view');
  if (JSON.stringify(latest) !== JSON.stringify(access)) throw new AppError(409,'dashboard_access_changed','Your access changed. Reload the dashboard.');
  return {plan:tenant?.plan,scopeApplied:true,source:'latest_recorded_available_deal_assessment',generatedAt:new Date().toISOString(),
    totalDeals:open.length,readyDeals:open.filter(r=>r.status==='ready').length,atRiskDeals:open.filter(r=>r.status==='at_risk').length,
    criticalDeals:open.filter(r=>r.status==='critical').length,
    averageScore:open.length > 0 && scores.length===open.length ? Math.round(scores.reduce((a,b)=>a+b,0)/scores.length) : null,
    incompleteHandoffs:all.filter(r=>r.is_closed===1 && r.is_won===1 && r.handoff_status!=='confirmed').length,
    issueCoverageComplete:issueCoverage===open.length,topIssues:issueCoverage===open.length ? [...issueMap.entries()].map(([code,value])=>({code,...value})).sort((a,b)=>b.count-a.count||a.code.localeCompare(b.code)).slice(0,8) : [],
    evidence:{recordedOpenDeals:open.length,fresh:ages.filter(a=>a.status==='fresh').length,aging:ages.filter(a=>a.status==='aging').length,
      stale:ages.filter(a=>a.status==='stale').length,unavailable:ages.filter(a=>a.status==='unavailable').length},
    lastScanAt:scoped ? null : tenant?.last_scan_at ?? null,nextScanAt:scoped ? null : tenant?.next_scan_at ?? null,
    latestScan:scan ? {id:scan.id,trigger:scan.trigger_type,status:scan.status,startedAt:scan.started_at,completedAt:scan.completed_at,
      scannedCount:scan.scanned_count,errorMessage:error && containsInternalImplementationDetail(error)?'The scan could not be completed.':error} : null,
    scanMetadataRestricted:scoped,problemDeals,
    limitations:'Recorded DealGuard scope and evidence only; not a live HubSpot permission check. A later scan does not erase previously recorded open deals.'};
}

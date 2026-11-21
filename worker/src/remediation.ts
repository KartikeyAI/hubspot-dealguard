import { resolveAssessmentCases } from './remediation-auto-resolution.js';
import { remediationCollection, requireRemediationRecord } from './remediation-access.js';
import { requireWorkResult } from './recommendation-remediation.js';
import { evidenceInstant } from './evidence-freshness.js';
import { assertRecordAvailable } from './record-lifecycle.js';
import { PLAN_LIMITS } from './config.js';
import { AppError } from './errors.js';
import { HubSpotClient } from './hubspot.js';
import { Repository } from './repository.js';
import type { DealAssessment, Env, IssueSeverity, RequestIdentity } from './types.js';

export type RemediationStatus = 'open' | 'acknowledged' | 'in_progress' | 'resolved' | 'waived' | 'overdue' | 'closed';
export type RemediationPriority = 'low' | 'medium' | 'high' | 'urgent';

interface CaseRow {
  task_delivery_state: 'not_requested' | 'pending' | 'sending' | 'created' | 'held';
  task_delivery_error: string | null;
  task_delivery_token: string | null;
  work_revision: string | number;
  id: string;
  portal_id: string;
  deal_id: string;
  issue_code: string;
  title: string;
  description: string;
  severity: IssueSeverity;
  status: RemediationStatus;
  priority: RemediationPriority;
  owner_id: string | null;
  owner_email: string | null;
  due_at: string | null;
  source: 'manual' | 'assessment' | 'workflow' | 'escalation';
  hubspot_task_id: string | null;
  resolution_note: string | null;
  created_by_user_id: string | null;
  created_by_email: string | null;
  created_at: string;
  updated_at: string;
  acknowledged_at: string | null;
  resolved_at: string | null;
  last_escalated_at: string | null;
}

export interface RemediationCase {
  id: string;
  dealId: string;
  issueCode: string;
  title: string;
  description: string;
  severity: IssueSeverity;
  status: RemediationStatus;
  priority: RemediationPriority;
  ownerId: string | null;
  ownerEmail: string | null;
  dueAt: string | null;
  source: CaseRow['source'];
  hubSpotTaskId: string | null;
  hubSpotTaskDelivery: { status: CaseRow['task_delivery_state']; reason: string | null };
  resolutionNote: string | null;
  createdAt: string;
  updatedAt: string;
  acknowledgedAt: string | null;
  resolvedAt: string | null;
  lastEscalatedAt: string | null;
}

function mapCase(row: CaseRow): RemediationCase {
  return {
    id: row.id,
    dealId: row.deal_id,
    issueCode: row.issue_code,
    title: row.title,
    description: row.description,
    severity: row.severity,
    status: row.status,
    priority: row.priority,
    ownerId: row.owner_id,
    ownerEmail: row.owner_email,
    dueAt: row.due_at,
    source: row.source,
    hubSpotTaskId: row.hubspot_task_id,
    hubSpotTaskDelivery: { status: row.task_delivery_state, reason: row.task_delivery_error },
    resolutionNote: row.resolution_note,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    acknowledgedAt: row.acknowledged_at,
    resolvedAt: row.resolved_at,
    lastEscalatedAt: row.last_escalated_at,
  };
}

function priorityForSeverity(severity: IssueSeverity): RemediationPriority {
  return severity === 'critical' ? 'urgent' : severity === 'warning' ? 'high' : 'medium';
}

function hubSpotPriority(priority: RemediationPriority): 'LOW' | 'MEDIUM' | 'HIGH' {
  return priority === 'low' ? 'LOW' : priority === 'medium' ? 'MEDIUM' : 'HIGH';
}

function defaultDueAt(severity: IssueSeverity): string {
  const hours = severity === 'critical' ? 24 : severity === 'warning' ? 72 : 168;
  return new Date(Date.now() + hours * 60 * 60_000).toISOString();
}

function safeText(value: unknown, fallback: string, max: number): string {
  if (typeof value !== 'string' || !value.trim()) return fallback;
  return value.trim().slice(0, max);
}

async function getCaseRow(env: Env, portalId: string, caseId: string): Promise<CaseRow> {
  const row = await env.DB.prepare(`SELECT * FROM remediation_cases WHERE portal_id = ? AND id = ?`).bind(portalId, caseId).first<CaseRow>();
  if (!row) throw new AppError(404, 'remediation_case_not_found', 'The remediation case does not exist.');
  return row;
}

export async function createRemediationCase(
  env: Env,
  identity: RequestIdentity,
  value: unknown,
  source: CaseRow['source'] = 'manual',
): Promise<RemediationCase> {
  const tenant = await new Repository(env).getTenant(identity.portalId);
  if (tenant.status !== 'active') throw new AppError(403, 'installation_inactive', 'This DealGuard installation is not active.');
  if (!PLAN_LIMITS[tenant.plan].remediationAutomation) throw new AppError(403, 'enterprise_subscription_required', 'Remediation automation requires DealGuard Enterprise.');
  const input = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const dealId = typeof input.dealId === 'string' && /^\d{1,32}$/.test(input.dealId) ? input.dealId : null;
  if (!dealId) throw new AppError(400, 'remediation_deal_required', 'A valid HubSpot deal ID is required.');
  await assertRecordAvailable(env, identity.portalId, dealId);
  const access = source === 'manual' ? await requireRemediationRecord(env, identity, dealId) : null;
  const current = await env.DB.prepare('SELECT assessed_at FROM deal_assessments WHERE portal_id=? AND deal_id=?')
    .bind(identity.portalId, dealId).first<{assessed_at:string}>();
  const assessmentAt = source === 'assessment' ? evidenceInstant(input.assessmentAt) : access?.assessmentAt ?? current?.assessed_at ?? null;
  const severity: IssueSeverity = input.severity === 'critical' || input.severity === 'info' ? input.severity : 'warning';
  const priority: RemediationPriority = ['low', 'medium', 'high', 'urgent'].includes(input.priority as string)
    ? input.priority as RemediationPriority : priorityForSeverity(severity);
  if (input.ownerId != null && (typeof input.ownerId !== 'string' || !/^\d{1,32}$/.test(input.ownerId))) {
    throw new AppError(400, 'remediation_owner_invalid', 'Use a HubSpot owner ID.');
  }
  if (input.ownerEmail != null && (typeof input.ownerEmail !== 'string' || input.ownerEmail.length > 254
    || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input.ownerEmail))) {
    throw new AppError(400, 'remediation_owner_invalid', 'Use a valid owner email.');
  }
  if (input.dueAt != null && !evidenceInstant(input.dueAt)) throw new AppError(400, 'remediation_due_date_invalid', 'Use an explicit ISO deadline with timezone.');
  const normalized = {
    issueCode: safeText(input.issueCode, 'manual_follow_up', 128).replace(/[^a-zA-Z0-9_.-]/g, '_'),
    title: safeText(input.title, 'Deal readiness remediation', 255),
    description: safeText(input.description, 'Resolve the identified DealGuard readiness issue.', 4000),
    severity, priority, ownerId: input.ownerId ?? null, ownerEmail: input.ownerEmail ?? null,
    dueAt: input.dueAt == null ? defaultDueAt(severity) : evidenceInstant(input.dueAt),
    createTask: input.createHubSpotTask !== false,
  };
  const result = requireWorkResult(await env.DB.prepare('SELECT dealguard.create_remediation_work(?,?,?,?,?::jsonb,?,?) AS result')
    .bind(identity.portalId, dealId, assessmentAt, source, JSON.stringify(normalized), identity.userId, identity.userEmail)
    .first<{result:unknown}>());
  const id = String(result.caseId);
  if (source === 'manual') await requireRemediationRecord(env, identity, dealId);
  // Only an unclaimed durable request may dispatch. Replays return the same case;
  // an uncertain external result is held for reconciliation rather than sent again.
  await dispatchRemediationTask(env, await getCaseRow(env, identity.portalId, id));
  return mapCase(await getCaseRow(env, identity.portalId, id));
}

async function dispatchRemediationTask(env: Env, row: CaseRow): Promise<void> {
  if (row.task_delivery_state !== 'pending') return;
  try {
    const tenant = await new Repository(env).getTenant(row.portal_id);
    if (tenant.status !== 'active' || !PLAN_LIMITS[tenant.plan].remediationAutomation) return;
    if (row.source === 'manual') await requireRemediationRecord(env, {
      portalId: row.portal_id, userId: row.created_by_user_id, userEmail: row.created_by_email, appId: null,
    }, row.deal_id);
    const current = await env.DB.prepare('SELECT assessed_at FROM deal_assessments WHERE portal_id=? AND deal_id=?')
      .bind(row.portal_id,row.deal_id).first<{assessed_at:string}>();
    const token = crypto.randomUUID();
    const claim = await env.DB.prepare('SELECT dealguard.claim_remediation_task(?,?,?,?,?) AS claimed')
      .bind(row.portal_id,row.deal_id,row.id,current?.assessed_at ?? null,token).first<{claimed:boolean}>();
    if (claim?.claimed !== true) return;
    let taskId: string | null = null;
    try {
      const currentCase = await getCaseRow(env,row.portal_id,row.id);
      if (!['open','acknowledged','in_progress','overdue'].includes(currentCase.status)) throw new AppError(409,'task_case_changed','The remediation changed before task delivery.');
      if (currentCase.source === 'manual') await requireRemediationRecord(env, {
        portalId: row.portal_id, userId: row.created_by_user_id, userEmail: row.created_by_email, appId: null,
      }, row.deal_id);
      const client = await HubSpotClient.forPortal(env,row.portal_id);
      taskId = await client.createRemediationTask({
        dealId: row.deal_id, subject: `[DealGuard] ${currentCase.title}`,
        body: `${currentCase.description}\n\nDealGuard case: ${row.id}\nIssue: ${currentCase.issue_code}`,
        dueAt: currentCase.due_at ?? defaultDueAt(currentCase.severity),
        priority: hubSpotPriority(currentCase.priority), ownerId: currentCase.owner_id,
      });
      if (!/^\d{1,32}$/.test(taskId)) taskId = null;
    } catch { /* The request may have reached HubSpot. Never retry an uncertain create. */ }
    await env.DB.prepare('SELECT dealguard.finish_remediation_task(?,?,?,?) AS finished')
      .bind(row.portal_id,row.id,token,taskId).first();
  } catch (error) {
    if (error instanceof AppError && [403,404,409,410].includes(error.status)) {
      await env.DB.prepare(`UPDATE remediation_cases SET task_delivery_state='held',task_delivery_error='task_authorization_changed'
        WHERE portal_id=? AND id=? AND task_delivery_state='pending'`).bind(row.portal_id,row.id).run();
      return;
    }
    throw error;
  }
}

export async function dispatchPendingRemediationTasks(env: Env, limit = 50): Promise<void> {
  const bounded = Math.min(100,Math.max(1,Math.floor(limit)));
  const abandoned = await env.DB.prepare(`SELECT * FROM remediation_cases WHERE task_delivery_state='sending'
    AND task_started_at<NOW()-INTERVAL '10 minutes' ORDER BY task_started_at,id LIMIT ?`).bind(bounded).all<CaseRow>();
  for (const row of abandoned.results ?? []) await env.DB.prepare('SELECT dealguard.finish_remediation_task(?,?,?,NULL) AS finished')
    .bind(row.portal_id,row.id,row.task_delivery_token).first();
  const pending = await env.DB.prepare(`SELECT r.* FROM remediation_cases r JOIN tenants t ON t.portal_id=r.portal_id
    WHERE r.task_delivery_state='pending' AND t.status='active' ORDER BY r.created_at,r.id LIMIT ?`).bind(bounded).all<CaseRow>();
  for (const row of pending.results ?? []) await dispatchRemediationTask(env,row).catch(() => {
    // A single unavailable record must not prevent later durable requests being examined.
    console.error(JSON.stringify({level:'warn',task:'remediation_task_dispatch',code:'dispatch_deferred'}));
  });
}

export async function listRemediationCases(env: Env, identity: RequestIdentity, url: URL): Promise<RemediationCase[]> {
  const scope=await remediationCollection(env,identity);
  const clauses:string[]=[],params:unknown[]=[...scope.params];
  for(const [key,column] of [['status','status'],['ownerId','owner_id']] as const) {
    const values=url.searchParams.getAll(key);
    if(values.length>1 || values.some(v=>v.length>128 || v!==v.trim())) throw new AppError(400,'remediation_filter_invalid','Use one bounded value per filter.');
    if(values[0]){clauses.push(`r.${column}=?`);params.push(values[0]);}
  }
  const pipeline=url.searchParams.getAll('pipelineId');
  if(pipeline.length>1 || pipeline.some(v=>v.length>128 || v!==v.trim())) throw new AppError(400,'remediation_filter_invalid','Pipeline filter is invalid.');
  if(pipeline[0]){clauses.push('EXISTS(SELECT 1 FROM permitted p WHERE p.portal_id=r.portal_id AND p.deal_id=r.deal_id AND p.pipeline_id=?)');params.push(pipeline[0]);}
  const rows=await env.DB.prepare(`${scope.sql} SELECT r.* FROM scoped_cases r WHERE ${clauses.join(' AND ')||'TRUE'}
    ORDER BY CASE r.severity WHEN 'critical' THEN 0 WHEN 'warning' THEN 1 ELSE 2 END,COALESCE(r.due_at,r.created_at),r.id LIMIT 201`)
    .bind(...params).all<CaseRow>();
  if((rows.results??[]).length>200) throw new AppError(422,'remediation_filter_required','More than 200 cases match. Narrow the status, assignee or pipeline filter.');
  return (rows.results??[]).map(mapCase);
}

export async function remediationSummary(env: Env, identity: RequestIdentity): Promise<{
  open:number;overdue:number;critical:number;dueSoon:number;averageResolutionHours:number|null;resolutionObservations:number;
}> {
  const scope=await remediationCollection(env,identity);
  const row=await env.DB.prepare(`${scope.sql} SELECT
    COUNT(*) FILTER(WHERE status IN ('open','acknowledged','in_progress','overdue')) AS open,
    COUNT(*) FILTER(WHERE status IN ('open','acknowledged','in_progress','overdue') AND due_at IS NOT NULL AND due_at::timestamptz<NOW()) AS overdue,
    COUNT(*) FILTER(WHERE status IN ('open','acknowledged','in_progress','overdue') AND severity='critical') AS critical,
    COUNT(*) FILTER(WHERE status IN ('open','acknowledged','in_progress','overdue') AND due_at::timestamptz>=NOW() AND due_at::timestamptz<=NOW()+INTERVAL '24 hours') AS due_soon,
    AVG(EXTRACT(EPOCH FROM(resolved_at::timestamptz-created_at::timestamptz))/3600) FILTER(WHERE status IN ('resolved','closed') AND resolved_at IS NOT NULL AND resolved_at::timestamptz>=created_at::timestamptz) AS average_resolution_hours,
    COUNT(*) FILTER(WHERE status IN ('resolved','closed') AND resolved_at IS NOT NULL AND resolved_at::timestamptz>=created_at::timestamptz) AS observations
    FROM scoped_cases`).bind(...scope.params).first<Record<string,unknown>>();
  return {open:Number(row?.open??0),overdue:Number(row?.overdue??0),critical:Number(row?.critical??0),dueSoon:Number(row?.due_soon??0),
    averageResolutionHours:row?.average_resolution_hours==null?null:Math.round(Number(row.average_resolution_hours)*10)/10,
    resolutionObservations:Number(row?.observations??0)};
}

export async function transitionRemediationCase(env: Env, identity: RequestIdentity, caseId: string, action: string, inputValue: unknown): Promise<RemediationCase> {
  const row=await env.DB.prepare('SELECT * FROM remediation_cases WHERE portal_id=? AND id=?').bind(identity.portalId,caseId).first<CaseRow>();
  if(!row) throw new AppError(404,'remediation_case_not_found','The remediation case does not exist.');
  const access=await requireRemediationRecord(env,identity,row.deal_id);
  const input=inputValue && typeof inputValue==='object' && !Array.isArray(inputValue)?inputValue as Record<string,unknown>:{}, normalized:Record<string,unknown>={};
  if(!['acknowledge','start','resolve','waive','close','reopen','assign','set_due_date','set_priority'].includes(action)) throw new AppError(400,'remediation_action_invalid','Unsupported remediation action.');
  if(['resolve','waive'].includes(action)) {
    if(typeof input.note!=='string' || !input.note.trim() || input.note.length>2000) throw new AppError(400,'remediation_note_required','A resolution or waiver note of at most 2,000 characters is required.');
    normalized.note=input.note.trim();
  }
  for(const key of ['ownerId','ownerEmail','dueAt','priority'] as const) {
    if(!(key in input)) continue;
    if(key==='dueAt' && (typeof input[key]!=='string' || !evidenceInstant(input[key]))) throw new AppError(400,'remediation_due_date_invalid','Use an explicit ISO deadline with timezone.');
    if(key==='ownerId' && input[key]!==null && (typeof input[key]!=='string' || !/^\d{1,32}$/.test(input[key]))) throw new AppError(400,'remediation_owner_invalid','Use a HubSpot owner ID.');
    if(key==='ownerEmail' && input[key]!==null && (typeof input[key]!=='string' || input[key].length>254)) throw new AppError(400,'remediation_owner_invalid','The owner email is invalid.');
    if(key==='priority' && !['low','medium','high','urgent'].includes(String(input[key]))) throw new AppError(400,'remediation_priority_invalid','The priority is invalid.');
    normalized[key]=key==='dueAt'?evidenceInstant(input[key]):input[key];
  }
  if(action==='set_due_date' && !normalized.dueAt) throw new AppError(400,'remediation_due_date_required','A deadline is required.');
  if(action==='set_priority' && !normalized.priority) throw new AppError(400,'remediation_priority_required','A priority is required.');
  if(action==='assign' && Object.keys(normalized).length===0) throw new AppError(400,'remediation_assignment_required','Provide an assignee, deadline or priority.');
  requireWorkResult(await env.DB.prepare('SELECT dealguard.transition_remediation_work(?,?,?,?,?,?,?::jsonb,?,?) AS result')
    .bind(identity.portalId,row.deal_id,row.id,access.assessmentAt,String(row.work_revision),action,JSON.stringify(normalized),identity.userId,identity.userEmail).first<{result:unknown}>());
  await requireRemediationRecord(env,identity,row.deal_id);
  const current=await env.DB.prepare('SELECT * FROM remediation_cases WHERE portal_id=? AND id=?').bind(identity.portalId,caseId).first<CaseRow>();
  if(!current) throw new AppError(409,'remediation_record_changed','The case changed; refresh before retrying.');
  return mapCase(current);
}

export async function syncAssessmentRemediations(env: Env, portalId: string, assessment: DealAssessment): Promise<void> {
  if (assessment.isClosed) return;
  const tenant = await new Repository(env).getTenant(portalId);
  if (!PLAN_LIMITS[tenant.plan].remediationAutomation) return;
  await assertRecordAvailable(env, portalId, assessment.dealId);
  for (const issue of assessment.issues.filter((item) => item.severity === 'critical')) {
    const identity: RequestIdentity = { portalId, userId: null, userEmail: null, appId: null };
    await createRemediationCase(env, identity, {
      dealId: assessment.dealId,
      assessmentAt: assessment.assessedAt,
      issueCode: issue.code,
      title: issue.label,
      description: issue.description,
      severity: issue.severity,
      priority: 'urgent',
      ownerId: assessment.ownerId ?? null,
      dueAt: defaultDueAt(issue.severity),
      createHubSpotTask: true,
    }, 'assessment');
  }
  await resolveAssessmentCases(env, portalId, assessment.dealId, assessment.assessedAt);
}

export async function escalateOverdueRemediations(env: Env, limit = 100): Promise<void> {
  const bounded = Math.min(100,Math.max(1,Math.floor(limit)));
  const rows = await env.DB.prepare(`SELECT r.*,a.assessed_at FROM remediation_cases r
    JOIN tenants t ON t.portal_id=r.portal_id JOIN deal_assessments a ON a.portal_id=r.portal_id AND a.deal_id=r.deal_id
    WHERE t.status='active' AND dealguard.record_is_available(r.portal_id,r.deal_id)
      AND r.status IN ('open','acknowledged','in_progress') AND r.due_at IS NOT NULL
      AND CASE WHEN pg_input_is_valid(r.due_at,'timestamp with time zone') THEN r.due_at::timestamptz<NOW() ELSE FALSE END
    ORDER BY r.due_at,r.id LIMIT ?`).bind(bounded).all<CaseRow & {assessed_at:string}>();
  for (const row of rows.results ?? []) {
    await env.DB.prepare('SELECT dealguard.escalate_remediation_work(?,?,?,?,?) AS changed')
      .bind(row.portal_id,row.deal_id,row.id,row.assessed_at,String(row.work_revision)).first();
  }
  await dispatchPendingRemediationTasks(env,bounded);
}

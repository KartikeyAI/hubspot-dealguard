import { remediationCollection, requireRemediationRecord } from './remediation-access.js';
import { requireWorkResult } from './recommendation-remediation.js';
import { evidenceInstant } from './evidence-freshness.js';
import { assertRecordAvailable } from './record-lifecycle.js';
import { PLAN_LIMITS } from './config.js';
import { AppError } from './errors.js';
import { HubSpotClient } from './hubspot.js';
import { enqueueOutboxEvent } from './outbox.js';
import { Repository } from './repository.js';
import type { DealAssessment, Env, IssueSeverity, RequestIdentity } from './types.js';

export type RemediationStatus = 'open' | 'acknowledged' | 'in_progress' | 'resolved' | 'waived' | 'overdue' | 'closed';
export type RemediationPriority = 'low' | 'medium' | 'high' | 'urgent';

interface CaseRow {
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

function validDate(value: unknown, fallback: string | null): string | null {
  if (typeof value !== 'string' || !value) return fallback;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : fallback;
}

async function event(env: Env, row: CaseRow, action: string, identity: RequestIdentity | null, metadata: unknown = {}): Promise<void> {
  await env.DB.prepare(`INSERT INTO remediation_events (id, portal_id, case_id, action, actor_user_id, actor_email, metadata_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(crypto.randomUUID(), row.portal_id, row.id, action, identity?.userId ?? null, identity?.userEmail ?? null, JSON.stringify(metadata ?? {}), new Date().toISOString()).run();
}

async function getCaseRow(env: Env, portalId: string, caseId: string): Promise<CaseRow> {
  const row = await env.DB.prepare(`SELECT * FROM remediation_cases WHERE portal_id = ? AND id = ?`).bind(portalId, caseId).first<CaseRow>();
  if (!row) throw new AppError(404, 'remediation_case_not_found', 'The remediation case does not exist.');
  return row;
}

async function emitCaseEvent(env: Env, row: CaseRow, eventType: string): Promise<void> {
  await enqueueOutboxEvent(env, {
    portalId: row.portal_id,
    eventType,
    severity: row.severity,
    aggregateType: 'remediation_case',
    aggregateId: row.id,
    payload: {
      caseId: row.id,
      dealId: row.deal_id,
      issueCode: row.issue_code,
      title: row.title,
      summary: row.description,
      status: row.status,
      priority: row.priority,
      ownerId: row.owner_id,
      ownerEmail: row.owner_email,
      dueAt: row.due_at,
      hubSpotTaskId: row.hubspot_task_id,
    },
  });
}

export async function createRemediationCase(
  env: Env,
  identity: RequestIdentity,
  value: unknown,
  source: CaseRow['source'] = 'manual',
): Promise<RemediationCase> {
  const tenant = await new Repository(env).getTenant(identity.portalId);
  if (!PLAN_LIMITS[tenant.plan].remediationAutomation) throw new AppError(403, 'enterprise_subscription_required', 'Remediation automation requires DealGuard Enterprise.');
  const input = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  const dealId = typeof input.dealId === 'string' && /^\d+$/.test(input.dealId) ? input.dealId : null;
  if (!dealId) throw new AppError(400, 'remediation_deal_required', 'A valid HubSpot deal ID is required.');
  await assertRecordAvailable(env, identity.portalId, dealId);
  const issueCode = safeText(input.issueCode, 'manual_follow_up', 128).replace(/[^a-zA-Z0-9_.-]/g, '_');
  const existing = await env.DB.prepare(`SELECT * FROM remediation_cases WHERE portal_id = ? AND deal_id = ? AND issue_code = ? AND status IN ('open', 'acknowledged', 'in_progress', 'overdue') LIMIT 1`)
    .bind(identity.portalId, dealId, issueCode).first<CaseRow>();
  if (existing) return mapCase(existing);
  const severity: IssueSeverity = input.severity === 'critical' || input.severity === 'info' ? input.severity : 'warning';
  const priority: RemediationPriority = ['low', 'medium', 'high', 'urgent'].includes(input.priority as string) ? input.priority as RemediationPriority : priorityForSeverity(severity);
  const dueAt = validDate(input.dueAt, defaultDueAt(severity));
  const now = new Date().toISOString();
  const id = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO remediation_cases (id, portal_id, deal_id, issue_code, title, description, severity, status, priority, owner_id, owner_email, due_at, source, created_by_user_id, created_by_email, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    id,
    identity.portalId,
    dealId,
    issueCode,
    safeText(input.title, 'Deal readiness remediation', 255),
    safeText(input.description, 'Resolve the identified DealGuard readiness issue.', 4000),
    severity,
    priority,
    typeof input.ownerId === 'string' ? input.ownerId.slice(0, 128) : null,
    typeof input.ownerEmail === 'string' ? input.ownerEmail.slice(0, 254) : null,
    dueAt,
    source,
    identity.userId,
    identity.userEmail,
    now,
    now,
  ).run();
  let row = await getCaseRow(env, identity.portalId, id);
  await event(env, row, 'created', identity, { source });
  if (input.createHubSpotTask !== false) {
    try {
      const client = await HubSpotClient.forPortal(env, identity.portalId);
      const taskId = await client.createRemediationTask({
        dealId,
        subject: `[DealGuard] ${row.title}`,
        body: `${row.description}\n\nDealGuard case: ${row.id}\nIssue: ${row.issue_code}`,
        dueAt: row.due_at ?? defaultDueAt(row.severity),
        priority: hubSpotPriority(row.priority),
        ownerId: row.owner_id,
      });
      await env.DB.prepare(`UPDATE remediation_cases SET hubspot_task_id = ?, updated_at = ? WHERE id = ?`).bind(taskId, new Date().toISOString(), id).run();
      row = await getCaseRow(env, identity.portalId, id);
      await event(env, row, 'hubspot_task_created', identity, { taskId });
    } catch (error) {
      await event(env, row, 'hubspot_task_failed', identity, { error: (error instanceof Error ? error.message : String(error)).slice(0, 1000) });
    }
  }
  await emitCaseEvent(env, row, 'remediation.created');
  await new Repository(env).audit(identity.portalId, identity.userId, identity.userEmail, 'remediation.created', { caseId: id, dealId, issueCode });
  return mapCase(row);
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
  const tenant = await new Repository(env).getTenant(portalId);
  if (!PLAN_LIMITS[tenant.plan].remediationAutomation) return;
  await assertRecordAvailable(env, portalId, assessment.dealId);
  const activeCodes = new Set(assessment.issues.map((issue) => issue.code));
  for (const issue of assessment.issues.filter((item) => item.severity === 'critical')) {
    const identity: RequestIdentity = { portalId, userId: null, userEmail: null, appId: null };
    await createRemediationCase(env, identity, {
      dealId: assessment.dealId,
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
  const stale = await env.DB.prepare(`SELECT * FROM remediation_cases WHERE portal_id = ? AND deal_id = ? AND source = 'assessment' AND status IN ('open', 'acknowledged', 'in_progress', 'overdue')`)
    .bind(portalId, assessment.dealId).all<CaseRow>();
  for (const row of stale.results ?? []) {
    if (activeCodes.has(row.issue_code)) continue;
    const now = new Date().toISOString();
    await env.DB.prepare(`UPDATE remediation_cases SET status = 'resolved', resolved_at = ?, resolution_note = 'Issue no longer detected by DealGuard.', updated_at = ? WHERE id = ?`).bind(now, now, row.id).run();
    const updated = await getCaseRow(env, portalId, row.id);
    await event(env, updated, 'auto_resolved', null, { assessmentAt: assessment.assessedAt });
    await emitCaseEvent(env, updated, 'remediation.auto_resolved');
  }
}

export async function escalateOverdueRemediations(env: Env, limit = 100): Promise<void> {
  const rows = await env.DB.prepare(`SELECT * FROM remediation_cases WHERE dealguard.record_is_available(portal_id,deal_id) AND status IN ('open', 'acknowledged', 'in_progress') AND due_at IS NOT NULL AND due_at < ? ORDER BY due_at ASC LIMIT ?`)
    .bind(new Date().toISOString(), limit).all<CaseRow>();
  for (const row of rows.results ?? []) {
    const now = new Date().toISOString();
    await env.DB.prepare(`UPDATE remediation_cases SET status = 'overdue', last_escalated_at = ?, updated_at = ? WHERE id = ? AND status IN ('open', 'acknowledged', 'in_progress')`).bind(now, now, row.id).run();
    const updated = await getCaseRow(env, row.portal_id, row.id);
    await event(env, updated, 'overdue', null, { dueAt: row.due_at });
    await emitCaseEvent(env, updated, 'remediation.overdue');
  }
}

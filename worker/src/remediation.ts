import { PLAN_LIMITS } from './config.js';
import { AppError } from './errors.js';
import { HubSpotClient } from './hubspot.js';
import { enqueueOutboxEvent } from './outbox.js';
import { Repository } from './repository.js';
import type { DealAssessment, Env, IssueSeverity, RequestIdentity } from './types.js';

export type RemediationStatus = 'open' | 'acknowledged' | 'in_progress' | 'resolved' | 'waived' | 'overdue' | 'closed';
export type RemediationPriority = 'low' | 'medium' | 'high' | 'urgent';

interface CaseRow {
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

export async function listRemediationCases(env: Env, portalId: string, url: URL): Promise<RemediationCase[]> {
  const status = url.searchParams.get('status')?.trim() ?? '';
  const ownerId = url.searchParams.get('ownerId')?.trim() ?? '';
  const dealId = url.searchParams.get('dealId')?.trim() ?? '';
  const limit = Math.min(500, Math.max(1, Number(url.searchParams.get('limit') ?? 100) || 100));
  const rows = await env.DB.prepare(
    `SELECT * FROM remediation_cases WHERE portal_id = ?
      AND (? = '' OR status = ?)
      AND (? = '' OR owner_id = ?)
      AND (? = '' OR deal_id = ?)
     ORDER BY CASE status WHEN 'overdue' THEN 0 WHEN 'open' THEN 1 WHEN 'in_progress' THEN 2 ELSE 3 END,
      CASE severity WHEN 'critical' THEN 0 WHEN 'warning' THEN 1 ELSE 2 END,
      COALESCE(due_at, '9999-12-31') ASC LIMIT ?`
  ).bind(portalId, status, status, ownerId, ownerId, dealId, dealId, limit).all<CaseRow>();
  return (rows.results ?? []).map(mapCase);
}

export async function remediationSummary(env: Env, portalId: string): Promise<{ open: number; overdue: number; critical: number; dueSoon: number; averageResolutionHours: number }> {
  const row = await env.DB.prepare(
    `SELECT
      SUM(CASE WHEN status IN ('open', 'acknowledged', 'in_progress', 'overdue') THEN 1 ELSE 0 END) AS open_count,
      SUM(CASE WHEN status = 'overdue' THEN 1 ELSE 0 END) AS overdue_count,
      SUM(CASE WHEN severity = 'critical' AND status IN ('open', 'acknowledged', 'in_progress', 'overdue') THEN 1 ELSE 0 END) AS critical_count,
      SUM(CASE WHEN due_at IS NOT NULL AND due_at <= ? AND status IN ('open', 'acknowledged', 'in_progress') THEN 1 ELSE 0 END) AS due_soon,
      AVG(CASE WHEN resolved_at IS NOT NULL THEN EXTRACT(EPOCH FROM (resolved_at::timestamptz - created_at::timestamptz)) / 3600.0 END) AS average_resolution_hours
     FROM remediation_cases WHERE portal_id = ?`
  ).bind(new Date(Date.now() + 24 * 60 * 60_000).toISOString(), portalId).first<Record<string, unknown>>();
  return {
    open: Number(row?.open_count ?? 0),
    overdue: Number(row?.overdue_count ?? 0),
    critical: Number(row?.critical_count ?? 0),
    dueSoon: Number(row?.due_soon ?? 0),
    averageResolutionHours: Math.round(Number(row?.average_resolution_hours ?? 0) * 10) / 10,
  };
}

export async function transitionRemediationCase(env: Env, identity: RequestIdentity, caseId: string, action: string, value: unknown): Promise<RemediationCase> {
  const row = await getCaseRow(env, identity.portalId, caseId);
  const input = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  const now = new Date().toISOString();
  let status = row.status;
  let acknowledgedAt = row.acknowledged_at;
  let resolvedAt = row.resolved_at;
  let resolutionNote = row.resolution_note;
  let ownerId = row.owner_id;
  let ownerEmail = row.owner_email;
  let dueAt = row.due_at;
  if (action === 'acknowledge') { status = 'acknowledged'; acknowledgedAt = now; }
  else if (action === 'start') { status = 'in_progress'; acknowledgedAt ??= now; }
  else if (action === 'resolve') { status = 'resolved'; resolvedAt = now; resolutionNote = safeText(input.note, 'Resolved by an authorised DealGuard user.', 2000); }
  else if (action === 'waive') { status = 'waived'; resolvedAt = now; resolutionNote = safeText(input.note, 'Waived by an authorised DealGuard user.', 2000); }
  else if (action === 'close') { status = 'closed'; resolvedAt ??= now; resolutionNote = safeText(input.note, resolutionNote ?? 'Closed.', 2000); }
  else if (action === 'reopen') { status = 'open'; resolvedAt = null; resolutionNote = null; }
  else if (action === 'assign') {
    ownerId = typeof input.ownerId === 'string' ? input.ownerId.slice(0, 128) : null;
    ownerEmail = typeof input.ownerEmail === 'string' ? input.ownerEmail.slice(0, 254) : null;
    dueAt = validDate(input.dueAt, row.due_at);
  } else throw new AppError(400, 'remediation_action_invalid', 'Unknown remediation action.');
  await env.DB.prepare(`UPDATE remediation_cases SET status = ?, owner_id = ?, owner_email = ?, due_at = ?, acknowledged_at = ?, resolved_at = ?, resolution_note = ?, updated_at = ? WHERE portal_id = ? AND id = ?`)
    .bind(status, ownerId, ownerEmail, dueAt, acknowledgedAt, resolvedAt, resolutionNote, now, identity.portalId, caseId).run();
  const updated = await getCaseRow(env, identity.portalId, caseId);
  await event(env, updated, action, identity, { previousStatus: row.status, status, ownerId, ownerEmail, dueAt, resolutionNote });
  await emitCaseEvent(env, updated, `remediation.${action}`);
  await new Repository(env).audit(identity.portalId, identity.userId, identity.userEmail, `remediation.${action}`, { caseId, previousStatus: row.status, status });
  return mapCase(updated);
}

export async function syncAssessmentRemediations(env: Env, portalId: string, assessment: DealAssessment): Promise<void> {
  const tenant = await new Repository(env).getTenant(portalId);
  if (!PLAN_LIMITS[tenant.plan].remediationAutomation) return;
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
  const rows = await env.DB.prepare(`SELECT * FROM remediation_cases WHERE status IN ('open', 'acknowledged', 'in_progress') AND due_at IS NOT NULL AND due_at < ? ORDER BY due_at ASC LIMIT ?`)
    .bind(new Date().toISOString(), limit).all<CaseRow>();
  for (const row of rows.results ?? []) {
    const now = new Date().toISOString();
    await env.DB.prepare(`UPDATE remediation_cases SET status = 'overdue', last_escalated_at = ?, updated_at = ? WHERE id = ? AND status IN ('open', 'acknowledged', 'in_progress')`).bind(now, now, row.id).run();
    const updated = await getCaseRow(env, row.portal_id, row.id);
    await event(env, updated, 'overdue', null, { dueAt: row.due_at });
    await emitCaseEvent(env, updated, 'remediation.overdue');
  }
}

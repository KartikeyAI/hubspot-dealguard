import { sha256Hex } from './crypto.js';
import { requireEnterprisePermission } from './enterprise-access.js';
import { AppError } from './errors.js';
import { transitionRemediationCase, type RemediationCase } from './remediation.js';
import { attachTaskToExistingRemediation } from './remediation-task.js';
import { Repository } from './repository.js';
import type { Env, RequestIdentity } from './types.js';

function clean(value: unknown, max: number): string {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

async function caseRow(env: Env, portalId: string, caseId: string): Promise<Record<string, unknown>> {
  const row = await env.DB.prepare(`SELECT * FROM remediation_cases WHERE portal_id = ? AND id = ?`).bind(portalId, caseId).first<Record<string, unknown>>();
  if (!row) throw new AppError(404, 'remediation_case_not_found', 'The remediation case does not exist.');
  return row;
}

export async function configureRemediationControls(
  env: Env,
  identity: RequestIdentity,
  caseId: string,
  input: { evidenceRequired?: boolean; acknowledgementRequired?: boolean; managerOwnerId?: string | null; managerOwnerEmail?: string | null },
): Promise<void> {
  await requireEnterprisePermission(env, identity, 'remediation.manage');
  await caseRow(env, identity.portalId, caseId);
  await env.DB.prepare(
    `UPDATE remediation_cases SET evidence_required = ?, evidence_status = CASE WHEN ? = 1 THEN 'missing' ELSE 'not_required' END,
     acknowledgement_required = ?, manager_owner_id = ?, manager_owner_email = ?, updated_at = ? WHERE portal_id = ? AND id = ?`
  ).bind(
    input.evidenceRequired ? 1 : 0, input.evidenceRequired ? 1 : 0, input.acknowledgementRequired ? 1 : 0,
    input.managerOwnerId?.slice(0, 128) ?? null, input.managerOwnerEmail?.slice(0, 254) ?? null,
    new Date().toISOString(), identity.portalId, caseId,
  ).run();
  await new Repository(env).audit(identity.portalId, identity.userId, identity.userEmail, 'remediation.controls_updated', { caseId, ...input });
}

export async function addRemediationComment(env: Env, identity: RequestIdentity, caseId: string, bodyValue: unknown): Promise<Record<string, unknown>> {
  await requireEnterprisePermission(env, identity, 'remediation.manage');
  await caseRow(env, identity.portalId, caseId);
  const body = clean(bodyValue, 8000);
  if (!body) throw new AppError(400, 'remediation_comment_required', 'A remediation comment is required.');
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  await env.DB.prepare(`INSERT INTO remediation_comments (id, portal_id, case_id, body, actor_user_id, actor_email, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .bind(id, identity.portalId, caseId, body, identity.userId, identity.userEmail, now).run();
  await env.DB.prepare(`INSERT INTO remediation_events (id, portal_id, case_id, action, actor_user_id, actor_email, metadata_json, created_at) VALUES (?, ?, ?, 'commented', ?, ?, ?, ?)`)
    .bind(crypto.randomUUID(), identity.portalId, caseId, identity.userId, identity.userEmail, JSON.stringify({ commentId: id }), now).run();
  await new Repository(env).audit(identity.portalId, identity.userId, identity.userEmail, 'remediation.comment_added', { caseId, commentId: id });
  return { id, body, actorEmail: identity.userEmail, createdAt: now };
}

export async function addRemediationEvidence(env: Env, identity: RequestIdentity, caseId: string, value: unknown): Promise<Record<string, unknown>> {
  await requireEnterprisePermission(env, identity, 'remediation.evidence');
  await caseRow(env, identity.portalId, caseId);
  const input = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  const allowed = ['url', 'text', 'hubspot_object', 'external_reference'];
  const type = allowed.includes(String(input.type)) ? String(input.type) : 'text';
  const label = clean(input.label, 255);
  const evidenceValue = clean(input.value, 16000);
  if (!label || !evidenceValue) throw new AppError(400, 'remediation_evidence_required', 'Evidence label and value are required.');
  if (type === 'url') {
    let parsed: URL;
    try { parsed = new URL(evidenceValue); } catch { throw new AppError(400, 'remediation_evidence_url_invalid', 'Evidence URL is invalid.'); }
    if (parsed.protocol !== 'https:') throw new AppError(400, 'remediation_evidence_https_required', 'Evidence URLs must use HTTPS.');
  }
  const hash = await sha256Hex(`${type}:${label}:${evidenceValue}`);
  const existing = await env.DB.prepare(`SELECT id FROM remediation_evidence WHERE portal_id = ? AND case_id = ? AND content_hash = ? LIMIT 1`)
    .bind(identity.portalId, caseId, hash).first<{ id: string }>();
  if (existing) throw new AppError(409, 'remediation_evidence_duplicate', 'This evidence has already been submitted.');
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO remediation_evidence (id, portal_id, case_id, evidence_type, label, value, content_hash, submitted_by_user_id, submitted_by_email, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(id, identity.portalId, caseId, type, label, evidenceValue, hash, identity.userId, identity.userEmail, now),
    env.DB.prepare(`UPDATE remediation_cases SET evidence_status = 'submitted', updated_at = ? WHERE portal_id = ? AND id = ?`)
      .bind(now, identity.portalId, caseId),
    env.DB.prepare(`INSERT INTO remediation_events (id, portal_id, case_id, action, actor_user_id, actor_email, metadata_json, created_at) VALUES (?, ?, ?, 'evidence_submitted', ?, ?, ?, ?)`)
      .bind(crypto.randomUUID(), identity.portalId, caseId, identity.userId, identity.userEmail, JSON.stringify({ evidenceId: id, type, label, hash }), now),
  ]);
  await new Repository(env).audit(identity.portalId, identity.userId, identity.userEmail, 'remediation.evidence_added', { caseId, evidenceId: id, type, label, hash });
  return { id, type, label, value: evidenceValue, hash, createdAt: now };
}

export async function reviewRemediationEvidence(env: Env, identity: RequestIdentity, caseId: string, decision: 'accepted' | 'rejected', comment: string): Promise<void> {
  await requireEnterprisePermission(env, identity, 'remediation.review');
  const row = await caseRow(env, identity.portalId, caseId);
  if (!Boolean(row.evidence_required)) throw new AppError(409, 'remediation_evidence_not_required', 'This remediation case does not require evidence.');
  const evidence = await env.DB.prepare(`SELECT COUNT(*) AS count FROM remediation_evidence WHERE portal_id = ? AND case_id = ?`)
    .bind(identity.portalId, caseId).first<{ count: number }>();
  if (Number(evidence?.count ?? 0) === 0) throw new AppError(409, 'remediation_evidence_missing', 'Evidence must be submitted before review.');
  const now = new Date().toISOString();
  await env.DB.batch([
    env.DB.prepare(`UPDATE remediation_cases SET evidence_status = ?, updated_at = ? WHERE portal_id = ? AND id = ?`)
      .bind(decision, now, identity.portalId, caseId),
    env.DB.prepare(`INSERT INTO remediation_events (id, portal_id, case_id, action, actor_user_id, actor_email, metadata_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(crypto.randomUUID(), identity.portalId, caseId, `evidence_${decision}`, identity.userId, identity.userEmail, JSON.stringify({ comment: comment.slice(0, 4000) }), now),
  ]);
  await new Repository(env).audit(identity.portalId, identity.userId, identity.userEmail, `remediation.evidence_${decision}`, { caseId, comment });
}

export async function transitionEnterpriseRemediation(
  env: Env,
  identity: RequestIdentity,
  caseId: string,
  action: string,
  value: unknown,
): Promise<RemediationCase> {
  const row = await caseRow(env, identity.portalId, caseId);
  await requireEnterprisePermission(env, identity, 'remediation.manage', {
    ownerId: row.owner_id ? String(row.owner_id) : null,
  });
  if (['resolve', 'close'].includes(action)) {
    if (Boolean(row.evidence_required) && String(row.evidence_status) !== 'accepted') {
      throw new AppError(409, 'remediation_evidence_approval_required', 'Required evidence must be accepted before this remediation can be resolved or closed.');
    }
    if (Boolean(row.acknowledgement_required) && !row.acknowledged_at) {
      throw new AppError(409, 'remediation_acknowledgement_required', 'This remediation must be acknowledged before resolution.');
    }
  }
  return transitionRemediationCase(env, identity, caseId, action, value);
}

export async function remediationDetail(env: Env, identity: RequestIdentity, caseId: string): Promise<Record<string, unknown>> {
  const row = await caseRow(env, identity.portalId, caseId);
  await requireEnterprisePermission(env, identity, 'remediation.view', { ownerId: row.owner_id ? String(row.owner_id) : null });
  const [comments, evidence, events] = await Promise.all([
    env.DB.prepare(`SELECT id, body, actor_user_id, actor_email, created_at FROM remediation_comments WHERE portal_id = ? AND case_id = ? ORDER BY created_at ASC`)
      .bind(identity.portalId, caseId).all<Record<string, unknown>>(),
    env.DB.prepare(`SELECT id, evidence_type, label, value, content_hash, submitted_by_user_id, submitted_by_email, created_at FROM remediation_evidence WHERE portal_id = ? AND case_id = ? ORDER BY created_at ASC`)
      .bind(identity.portalId, caseId).all<Record<string, unknown>>(),
    env.DB.prepare(`SELECT id, action, actor_user_id, actor_email, metadata_json, created_at FROM remediation_events WHERE portal_id = ? AND case_id = ? ORDER BY created_at ASC`)
      .bind(identity.portalId, caseId).all<Record<string, unknown>>(),
  ]);
  return {
    case: {
      id: row.id, dealId: row.deal_id, issueCode: row.issue_code, title: row.title, description: row.description,
      severity: row.severity, status: row.status, priority: row.priority, ownerId: row.owner_id, ownerEmail: row.owner_email,
      managerOwnerId: row.manager_owner_id, managerOwnerEmail: row.manager_owner_email, dueAt: row.due_at,
      evidenceRequired: Boolean(row.evidence_required), evidenceStatus: row.evidence_status,
      acknowledgementRequired: Boolean(row.acknowledgement_required), escalationLevel: Number(row.escalation_level ?? 0),
      hubSpotTaskId: row.hubspot_task_id, createdAt: row.created_at, updatedAt: row.updated_at,
    },
    comments: comments.results ?? [],
    evidence: evidence.results ?? [],
    events: (events.results ?? []).map((event) => ({ ...event, metadata: JSON.parse(String(event.metadata_json ?? '{}')) })),
  };
}

type BulkOperation = 'assign' | 'acknowledge' | 'start' | 'resolve' | 'waive' | 'create_tasks' | 'set_due_date' | 'set_priority';

export async function createRemediationBulkJob(env: Env, identity: RequestIdentity, value: unknown): Promise<Record<string, unknown>> {
  await requireEnterprisePermission(env, identity, 'remediation.bulk');
  const input = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  const allowed: BulkOperation[] = ['assign', 'acknowledge', 'start', 'resolve', 'waive', 'create_tasks', 'set_due_date', 'set_priority'];
  const operation = allowed.includes(input.operation as BulkOperation) ? input.operation as BulkOperation : null;
  const caseIds = Array.isArray(input.caseIds)
    ? [...new Set(input.caseIds.filter((id): id is string => typeof id === 'string' && id.length <= 128))].slice(0, 1000)
    : [];
  if (!operation || caseIds.length === 0) throw new AppError(400, 'remediation_bulk_invalid', 'A supported operation and at least one case ID are required.');
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  await env.DB.prepare(
    `INSERT INTO remediation_bulk_jobs (id, portal_id, operation, input_json, status, total_count, requested_by_user_id, requested_by_email, created_at)
     VALUES (?, ?, ?, ?, 'queued', ?, ?, ?, ?)`
  ).bind(id, identity.portalId, operation, JSON.stringify({ caseIds, parameters: input.parameters ?? {} }), caseIds.length, identity.userId, identity.userEmail, now).run();
  await new Repository(env).audit(identity.portalId, identity.userId, identity.userEmail, 'remediation.bulk_requested', { jobId: id, operation, caseCount: caseIds.length });
  return { id, operation, status: 'queued', totalCount: caseIds.length, createdAt: now };
}

export async function runRemediationBulkJob(env: Env, identity: RequestIdentity, jobId: string): Promise<Record<string, unknown>> {
  await requireEnterprisePermission(env, identity, 'remediation.bulk');
  const job = await env.DB.prepare(`SELECT * FROM remediation_bulk_jobs WHERE portal_id = ? AND id = ?`)
    .bind(identity.portalId, jobId).first<Record<string, unknown>>();
  if (!job) throw new AppError(404, 'remediation_bulk_job_not_found', 'The remediation bulk job does not exist.');
  if (!['queued', 'failed'].includes(String(job.status))) throw new AppError(409, 'remediation_bulk_job_not_runnable', 'This bulk job is already running or complete.');
  const input = JSON.parse(String(job.input_json)) as { caseIds: string[]; parameters: Record<string, unknown> };
  const operation = String(job.operation) as BulkOperation;
  await env.DB.prepare(`UPDATE remediation_bulk_jobs SET status = 'running' WHERE portal_id = ? AND id = ?`).bind(identity.portalId, jobId).run();
  const failures: Array<{ caseId: string; error: string }> = [];
  let succeeded = 0;
  for (const caseId of input.caseIds) {
    try {
      if (operation === 'assign') await transitionEnterpriseRemediation(env, identity, caseId, 'assign', input.parameters);
      else if (['acknowledge', 'start', 'resolve', 'waive'].includes(operation)) await transitionEnterpriseRemediation(env, identity, caseId, operation, input.parameters);
      else if (operation === 'set_due_date') await transitionEnterpriseRemediation(env, identity, caseId, 'assign', { dueAt: input.parameters.dueAt });
      else if (operation === 'set_priority') {
        const priority = ['low', 'medium', 'high', 'urgent'].includes(String(input.parameters.priority)) ? String(input.parameters.priority) : null;
        if (!priority) throw new AppError(400, 'priority_invalid', 'Choose a valid remediation priority.');
        await env.DB.prepare(`UPDATE remediation_cases SET priority = ?, updated_at = ? WHERE portal_id = ? AND id = ?`)
          .bind(priority, new Date().toISOString(), identity.portalId, caseId).run();
      } else if (operation === 'create_tasks') {
        await attachTaskToExistingRemediation(env, identity, caseId);
      }
      succeeded += 1;
    } catch (error) {
      failures.push({ caseId, error: error instanceof Error ? error.message : String(error) });
    }
  }
  const completedAt = new Date().toISOString();
  const status = failures.length === 0 ? 'completed' : succeeded > 0 ? 'partially_failed' : 'failed';
  await env.DB.prepare(
    `UPDATE remediation_bulk_jobs SET status = ?, succeeded_count = ?, failed_count = ?, result_json = ?, completed_at = ? WHERE portal_id = ? AND id = ?`
  ).bind(status, succeeded, failures.length, JSON.stringify({ failures }), completedAt, identity.portalId, jobId).run();
  await new Repository(env).audit(identity.portalId, identity.userId, identity.userEmail, 'remediation.bulk_completed', { jobId, status, succeeded, failed: failures.length });
  return { id: jobId, status, succeededCount: succeeded, failedCount: failures.length, failures, completedAt };
}

import { requireEnterprisePermission } from './enterprise-access.js';
import { AppError } from './errors.js';
import { HubSpotClient } from './hubspot.js';
import { Repository } from './repository.js';
import type { Env, RequestIdentity } from './types.js';

export async function attachTaskToExistingRemediation(
  env: Env,
  identity: RequestIdentity,
  caseId: string,
): Promise<{ taskId: string; existing: boolean }> {
  const item = await env.DB.prepare(
    `SELECT id, deal_id, title, description, severity, priority, owner_id, due_at, hubspot_task_id
     FROM remediation_cases WHERE portal_id = ? AND id = ?`
  ).bind(identity.portalId, caseId).first<{
    id: string;
    deal_id: string;
    title: string;
    description: string;
    severity: string;
    priority: string;
    owner_id: string | null;
    due_at: string | null;
    hubspot_task_id: string | null;
  }>();
  if (!item) throw new AppError(404, 'remediation_case_not_found', 'The remediation case does not exist.');
  await requireEnterprisePermission(env, identity, 'remediation.manage', { ownerId: item.owner_id });
  if (item.hubspot_task_id) return { taskId: item.hubspot_task_id, existing: true };

  const client = await HubSpotClient.forPortal(env, identity.portalId);
  const taskId = await client.createRemediationTask({
    dealId: item.deal_id,
    subject: `[DealGuard ${item.severity}] ${item.title}`,
    body: `${item.description}\n\nDealGuard remediation case: ${item.id}\nPriority: ${item.priority}`,
    ownerId: item.owner_id,
    dueAt: item.due_at,
    priority: item.priority,
  });
  const now = new Date().toISOString();
  const result = await env.DB.prepare(
    `UPDATE remediation_cases SET hubspot_task_id = ?, updated_at = ?
     WHERE portal_id = ? AND id = ? AND hubspot_task_id IS NULL`
  ).bind(taskId, now, identity.portalId, caseId).run();
  if (!Number(result.meta?.changes ?? 0)) {
    const current = await env.DB.prepare(`SELECT hubspot_task_id FROM remediation_cases WHERE portal_id = ? AND id = ?`)
      .bind(identity.portalId, caseId).first<{ hubspot_task_id: string | null }>();
    return { taskId: current?.hubspot_task_id ?? taskId, existing: Boolean(current?.hubspot_task_id) };
  }
  await env.DB.prepare(
    `INSERT INTO remediation_events (id, portal_id, case_id, action, actor_user_id, actor_email, metadata_json, created_at)
     VALUES (?, ?, ?, 'hubspot_task_created', ?, ?, ?, ?)`
  ).bind(crypto.randomUUID(), identity.portalId, caseId, identity.userId, identity.userEmail, JSON.stringify({ taskId }), now).run();
  await new Repository(env).audit(identity.portalId, identity.userId, identity.userEmail, 'remediation.hubspot_task_created', { caseId, taskId });
  return { taskId, existing: false };
}

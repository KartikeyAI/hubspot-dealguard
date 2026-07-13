import { PLAN_LIMITS } from './config.js';
import { sha256Hex } from './crypto.js';
import { AppError } from './errors.js';
import { HubSpotClient } from './hubspot.js';
import { Repository } from './repository.js';
import { assessDeal } from './scoring.js';
import type {
  Env,
  GovernanceContext,
  GovernanceRole,
  PolicySimulation,
  PolicyStatus,
  PolicyVersion,
  RequestIdentity,
  RuleSettings,
} from './types.js';
import { parseRuleSettings, parseSettings } from './validation.js';

const ROLE_PERMISSIONS: Record<GovernanceRole, string[]> = {
  admin: ['governance.view', 'governance.enable', 'policy.manage', 'policy.submit', 'policy.approve', 'policy.publish', 'policy.simulate', 'role.manage', 'audit.view', 'audit.export', 'exception.manage'],
  policy_admin: ['governance.view', 'policy.manage', 'policy.submit', 'policy.publish', 'policy.simulate', 'audit.view'],
  approver: ['governance.view', 'policy.approve', 'policy.simulate', 'audit.view'],
  manager: ['governance.view', 'policy.simulate', 'audit.view', 'exception.manage'],
  viewer: ['governance.view'],
};

interface PolicyRow {
  id: string;
  portal_id: string;
  version_number: number;
  name: string;
  description: string;
  status: PolicyStatus;
  rules_json: string;
  checksum: string;
  change_summary: string;
  based_on_policy_id: string | null;
  created_by_user_id: string | null;
  created_by_email: string | null;
  submitted_at: string | null;
  approved_at: string | null;
  approved_by_email: string | null;
  published_at: string | null;
  published_by_email: string | null;
  created_at: string;
  updated_at: string;
}

interface SimulationRow {
  id: string;
  policy_id: string;
  status: PolicySimulation['status'];
  total_deals: number;
  changed_deals: number;
  ready_deals: number;
  at_risk_deals: number;
  critical_deals: number;
  average_score: number;
  previous_average_score: number;
  error_message: string | null;
  started_at: string;
  completed_at: string | null;
}

function mapPolicy(row: PolicyRow): PolicyVersion {
  return {
    id: row.id,
    portalId: row.portal_id,
    versionNumber: Number(row.version_number),
    name: row.name,
    description: row.description,
    status: row.status,
    rules: JSON.parse(row.rules_json) as RuleSettings,
    checksum: row.checksum,
    changeSummary: row.change_summary,
    basedOnPolicyId: row.based_on_policy_id,
    createdByUserId: row.created_by_user_id,
    createdByEmail: row.created_by_email,
    submittedAt: row.submitted_at,
    approvedAt: row.approved_at,
    approvedByEmail: row.approved_by_email,
    publishedAt: row.published_at,
    publishedByEmail: row.published_by_email,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapSimulation(row: SimulationRow): PolicySimulation {
  return {
    id: row.id,
    policyId: row.policy_id,
    status: row.status,
    totalDeals: Number(row.total_deals),
    changedDeals: Number(row.changed_deals),
    readyDeals: Number(row.ready_deals),
    atRiskDeals: Number(row.at_risk_deals),
    criticalDeals: Number(row.critical_deals),
    averageScore: Number(row.average_score),
    previousAverageScore: Number(row.previous_average_score),
    errorMessage: row.error_message,
    startedAt: row.started_at,
    completedAt: row.completed_at,
  };
}

function cleanText(value: unknown, fallback: string, max: number): string {
  if (typeof value !== 'string') return fallback;
  const cleaned = value.trim();
  return cleaned ? cleaned.slice(0, max) : fallback;
}

async function nextVersion(env: Env, portalId: string): Promise<number> {
  const row = await env.DB.prepare(`SELECT COALESCE(MAX(version_number), 0) + 1 AS next_version FROM policy_versions WHERE portal_id = ?`)
    .bind(portalId).first<{ next_version: number }>();
  return Number(row?.next_version ?? 1);
}

export async function governanceContext(env: Env, identity: RequestIdentity): Promise<GovernanceContext> {
  const repository = new Repository(env);
  const tenant = await repository.getTenant(identity.portalId);
  const settings = parseSettings(JSON.parse(tenant.settings_json || '{}'), tenant.plan);
  let role: GovernanceRole = 'viewer';
  let installerBootstrap = false;
  const explicit = identity.userId
    ? await env.DB.prepare(`SELECT role FROM governance_roles WHERE portal_id = ? AND user_id = ? LIMIT 1`).bind(identity.portalId, identity.userId).first<{ role: GovernanceRole }>()
    : null;
  const byEmail = !explicit && identity.userEmail
    ? await env.DB.prepare(`SELECT role FROM governance_roles WHERE portal_id = ? AND lower(user_email) = lower(?) LIMIT 1`).bind(identity.portalId, identity.userEmail).first<{ role: GovernanceRole }>()
    : null;
  if (explicit?.role) role = explicit.role;
  else if (byEmail?.role) role = byEmail.role;
  else if (identity.userEmail && tenant.installer_email && identity.userEmail.toLowerCase() === tenant.installer_email.toLowerCase()) {
    role = 'admin';
    installerBootstrap = true;
  }
  const entitled = PLAN_LIMITS[tenant.plan].enterpriseGovernance;
  return {
    role,
    permissions: entitled ? ROLE_PERMISSIONS[role] : ['governance.view'],
    governanceEnabled: entitled && settings.governance.enabled,
    installerBootstrap,
  };
}

export async function requireGovernancePermission(env: Env, identity: RequestIdentity, permission: string): Promise<GovernanceContext> {
  const context = await governanceContext(env, identity);
  if (!context.permissions.includes(permission)) throw new AppError(403, 'governance_forbidden', 'You do not have permission to perform this DealGuard governance action.');
  return context;
}

export async function enableGovernance(env: Env, identity: RequestIdentity): Promise<{ context: GovernanceContext; activePolicy: PolicyVersion }> {
  await requireGovernancePermission(env, identity, 'governance.enable');
  const repository = new Repository(env);
  const credentials = await repository.getCredentials(identity.portalId);
  if (!PLAN_LIMITS[credentials.tenant.plan].enterpriseGovernance) throw new AppError(403, 'enterprise_plan_required', 'Enterprise governance requires an eligible DealGuard plan.');
  const existing = await activePolicy(env, identity.portalId);
  if (existing && credentials.settings.governance.enabled) return { context: await governanceContext(env, identity), activePolicy: existing };
  const now = new Date().toISOString();
  const rulesJson = JSON.stringify(credentials.settings.rules);
  const policyId = existing?.id ?? crypto.randomUUID();
  if (!existing) {
    await env.DB.prepare(
      `INSERT INTO policy_versions (id, portal_id, version_number, name, description, status, rules_json, checksum, change_summary, created_by_user_id, created_by_email, approved_at, approved_by_user_id, approved_by_email, published_at, published_by_user_id, published_by_email, created_at, updated_at)
       VALUES (?, ?, 1, 'Baseline policy', 'Initial policy captured when enterprise governance was enabled.', 'published', ?, ?, 'Governance baseline', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(policyId, identity.portalId, rulesJson, await sha256Hex(rulesJson), identity.userId, identity.userEmail, now, identity.userId, identity.userEmail, now, identity.userId, identity.userEmail, now, now).run();
  }
  const nextSettings = { ...credentials.settings, governance: { ...credentials.settings.governance, enabled: true } };
  await env.DB.prepare(`UPDATE tenants SET settings_json = ?, updated_at = ? WHERE portal_id = ?`).bind(JSON.stringify(nextSettings), now, identity.portalId).run();
  await repository.audit(identity.portalId, identity.userId, identity.userEmail, 'governance.enabled', { baselinePolicyId: policyId });
  const policy = await getPolicy(env, identity.portalId, policyId);
  if (!policy) throw new AppError(500, 'baseline_policy_missing', 'The baseline governance policy could not be loaded.');
  return { context: await governanceContext(env, identity), activePolicy: policy };
}

export async function listPolicies(env: Env, portalId: string): Promise<PolicyVersion[]> {
  const rows = await env.DB.prepare(`SELECT * FROM policy_versions WHERE portal_id = ? ORDER BY version_number DESC LIMIT 100`).bind(portalId).all<PolicyRow>();
  return (rows.results ?? []).map(mapPolicy);
}

export async function getPolicy(env: Env, portalId: string, policyId: string): Promise<PolicyVersion | null> {
  const row = await env.DB.prepare(`SELECT * FROM policy_versions WHERE portal_id = ? AND id = ?`).bind(portalId, policyId).first<PolicyRow>();
  return row ? mapPolicy(row) : null;
}

export async function activePolicy(env: Env, portalId: string): Promise<PolicyVersion | null> {
  const row = await env.DB.prepare(`SELECT * FROM policy_versions WHERE portal_id = ? AND status = 'published' ORDER BY version_number DESC LIMIT 1`).bind(portalId).first<PolicyRow>();
  return row ? mapPolicy(row) : null;
}

export async function createPolicyDraft(env: Env, identity: RequestIdentity, value: unknown, basedOnPolicyId: string | null = null): Promise<PolicyVersion> {
  await requireGovernancePermission(env, identity, 'policy.manage');
  const repository = new Repository(env);
  const credentials = await repository.getCredentials(identity.portalId);
  if (!credentials.settings.governance.enabled) throw new AppError(409, 'governance_not_enabled', 'Enable enterprise governance before creating policy drafts.');
  const input = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  const base = basedOnPolicyId ? await getPolicy(env, identity.portalId, basedOnPolicyId) : await activePolicy(env, identity.portalId);
  const rules = parseRuleSettings(input.rules ?? base?.rules ?? credentials.settings.rules, credentials.tenant.plan);
  const rulesJson = JSON.stringify(rules);
  const now = new Date().toISOString();
  const id = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO policy_versions (id, portal_id, version_number, name, description, status, rules_json, checksum, change_summary, based_on_policy_id, created_by_user_id, created_by_email, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'draft', ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(id, identity.portalId, await nextVersion(env, identity.portalId), cleanText(input.name, 'Governance policy draft', 120), cleanText(input.description, '', 1000), rulesJson, await sha256Hex(rulesJson), cleanText(input.changeSummary, '', 500), base?.id ?? null, identity.userId, identity.userEmail, now, now).run();
  await repository.audit(identity.portalId, identity.userId, identity.userEmail, 'policy.draft_created', { policyId: id, basedOnPolicyId: base?.id ?? null });
  const created = await getPolicy(env, identity.portalId, id);
  if (!created) throw new AppError(500, 'policy_creation_failed', 'The policy draft could not be loaded after creation.');
  return created;
}

export async function updatePolicyDraft(env: Env, identity: RequestIdentity, policyId: string, value: unknown): Promise<PolicyVersion> {
  await requireGovernancePermission(env, identity, 'policy.manage');
  const current = await getPolicy(env, identity.portalId, policyId);
  if (!current) throw new AppError(404, 'policy_not_found', 'The requested policy does not exist.');
  if (!['draft', 'rejected'].includes(current.status)) throw new AppError(409, 'policy_not_editable', 'Only draft or rejected policies can be edited.');
  const credentials = await new Repository(env).getCredentials(identity.portalId);
  const input = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  const rules = parseRuleSettings(input.rules ?? current.rules, credentials.tenant.plan);
  const rulesJson = JSON.stringify(rules);
  const now = new Date().toISOString();
  await env.DB.prepare(`UPDATE policy_versions SET name = ?, description = ?, rules_json = ?, checksum = ?, change_summary = ?, status = 'draft', updated_at = ? WHERE portal_id = ? AND id = ?`)
    .bind(cleanText(input.name, current.name, 120), cleanText(input.description, current.description, 1000), rulesJson, await sha256Hex(rulesJson), cleanText(input.changeSummary, current.changeSummary, 500), now, identity.portalId, policyId).run();
  await new Repository(env).audit(identity.portalId, identity.userId, identity.userEmail, 'policy.draft_updated', { policyId });
  const updated = await getPolicy(env, identity.portalId, policyId);
  if (!updated) throw new AppError(500, 'policy_update_failed', 'The policy could not be loaded after update.');
  return updated;
}

export async function submitPolicy(env: Env, identity: RequestIdentity, policyId: string): Promise<PolicyVersion> {
  await requireGovernancePermission(env, identity, 'policy.submit');
  const policy = await getPolicy(env, identity.portalId, policyId);
  if (!policy) throw new AppError(404, 'policy_not_found', 'The requested policy does not exist.');
  if (!['draft', 'rejected'].includes(policy.status)) throw new AppError(409, 'policy_not_submittable', 'Only draft or rejected policies can be submitted.');
  const now = new Date().toISOString();
  await env.DB.prepare(`UPDATE policy_versions SET status = 'pending_approval', submitted_at = ?, approved_at = NULL, approved_by_user_id = NULL, approved_by_email = NULL, updated_at = ? WHERE portal_id = ? AND id = ?`)
    .bind(now, now, identity.portalId, policyId).run();
  await new Repository(env).audit(identity.portalId, identity.userId, identity.userEmail, 'policy.submitted', { policyId });
  return (await getPolicy(env, identity.portalId, policyId))!;
}

export async function decidePolicy(env: Env, identity: RequestIdentity, policyId: string, decision: 'approved' | 'rejected', comment: string): Promise<PolicyVersion> {
  await requireGovernancePermission(env, identity, 'policy.approve');
  const policy = await getPolicy(env, identity.portalId, policyId);
  if (!policy) throw new AppError(404, 'policy_not_found', 'The requested policy does not exist.');
  if (policy.status !== 'pending_approval') throw new AppError(409, 'policy_not_pending', 'Only policies awaiting approval can be reviewed.');
  const credentials = await new Repository(env).getCredentials(identity.portalId);
  const sameUser = Boolean(identity.userId && policy.createdByUserId && identity.userId === policy.createdByUserId)
    || Boolean(identity.userEmail && policy.createdByEmail && identity.userEmail.toLowerCase() === policy.createdByEmail.toLowerCase());
  if (credentials.settings.governance.preventSelfApproval && sameUser) throw new AppError(409, 'self_approval_forbidden', 'A policy creator cannot approve their own policy.');
  const now = new Date().toISOString();
  await env.DB.batch([
    env.DB.prepare(`UPDATE policy_versions SET status = ?, approved_at = ?, approved_by_user_id = ?, approved_by_email = ?, updated_at = ? WHERE portal_id = ? AND id = ?`)
      .bind(decision, decision === 'approved' ? now : null, decision === 'approved' ? identity.userId : null, decision === 'approved' ? identity.userEmail : null, now, identity.portalId, policyId),
    env.DB.prepare(`INSERT INTO policy_approvals (id, portal_id, policy_id, decision, comment, actor_user_id, actor_email, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(crypto.randomUUID(), identity.portalId, policyId, decision, cleanText(comment, '', 1000), identity.userId, identity.userEmail, now),
  ]);
  await new Repository(env).audit(identity.portalId, identity.userId, identity.userEmail, `policy.${decision}`, { policyId, comment: cleanText(comment, '', 1000) });
  return (await getPolicy(env, identity.portalId, policyId))!;
}

export async function publishPolicy(env: Env, identity: RequestIdentity, policyId: string): Promise<PolicyVersion> {
  await requireGovernancePermission(env, identity, 'policy.publish');
  const policy = await getPolicy(env, identity.portalId, policyId);
  if (!policy) throw new AppError(404, 'policy_not_found', 'The requested policy does not exist.');
  const credentials = await new Repository(env).getCredentials(identity.portalId);
  const allowed = credentials.settings.governance.requireApproval ? policy.status === 'approved' : ['draft', 'approved'].includes(policy.status);
  if (!allowed) throw new AppError(409, 'policy_not_publishable', 'This policy has not completed the required approval process.');
  const now = new Date().toISOString();
  const nextSettings = { ...credentials.settings, rules: policy.rules };
  await env.DB.batch([
    env.DB.prepare(`UPDATE policy_versions SET status = 'superseded', updated_at = ? WHERE portal_id = ? AND status = 'published'`).bind(now, identity.portalId),
    env.DB.prepare(`UPDATE policy_versions SET status = 'published', published_at = ?, published_by_user_id = ?, published_by_email = ?, updated_at = ? WHERE portal_id = ? AND id = ?`).bind(now, identity.userId, identity.userEmail, now, identity.portalId, policyId),
    env.DB.prepare(`UPDATE tenants SET settings_json = ?, updated_at = ? WHERE portal_id = ?`).bind(JSON.stringify(nextSettings), now, identity.portalId),
  ]);
  await new Repository(env).audit(identity.portalId, identity.userId, identity.userEmail, 'policy.published', { policyId, versionNumber: policy.versionNumber });
  return (await getPolicy(env, identity.portalId, policyId))!;
}

export async function createPolicySimulation(env: Env, identity: RequestIdentity, policyId: string): Promise<PolicySimulation> {
  await requireGovernancePermission(env, identity, 'policy.simulate');
  const policy = await getPolicy(env, identity.portalId, policyId);
  if (!policy) throw new AppError(404, 'policy_not_found', 'The requested policy does not exist.');
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  await env.DB.prepare(`INSERT INTO policy_simulations (id, portal_id, policy_id, status, started_at, requested_by_user_id, requested_by_email) VALUES (?, ?, ?, 'running', ?, ?, ?)`)
    .bind(id, identity.portalId, policyId, now, identity.userId, identity.userEmail).run();
  return { id, policyId, status: 'running', totalDeals: 0, changedDeals: 0, readyDeals: 0, atRiskDeals: 0, criticalDeals: 0, averageScore: 0, previousAverageScore: 0, errorMessage: null, startedAt: now, completedAt: null };
}

export async function runPolicySimulation(env: Env, portalId: string, policyId: string, simulationId: string): Promise<void> {
  try {
    const policy = await getPolicy(env, portalId, policyId);
    if (!policy) throw new AppError(404, 'policy_not_found', 'The requested policy does not exist.');
    const client = await HubSpotClient.forPortal(env, portalId);
    const limit = PLAN_LIMITS[client.plan].maxPolicySimulationDeals;
    if (limit <= 0) throw new AppError(403, 'enterprise_plan_required', 'Policy simulation requires an eligible DealGuard plan.');
    const deals = await client.listDeals(limit);
    let changedDeals = 0;
    let scoreTotal = 0;
    let previousScoreTotal = 0;
    let readyDeals = 0;
    let atRiskDeals = 0;
    let criticalDeals = 0;
    for (const deal of deals) {
      const previous = assessDeal(deal, client.settings.rules);
      const projected = assessDeal(deal, policy.rules);
      if (previous.score !== projected.score || previous.status !== projected.status) changedDeals += 1;
      scoreTotal += projected.score;
      previousScoreTotal += previous.score;
      if (projected.status === 'ready') readyDeals += 1;
      if (projected.status === 'at_risk') atRiskDeals += 1;
      if (projected.status === 'critical') criticalDeals += 1;
    }
    const completedAt = new Date().toISOString();
    await env.DB.prepare(`UPDATE policy_simulations SET status = 'completed', total_deals = ?, changed_deals = ?, ready_deals = ?, at_risk_deals = ?, critical_deals = ?, average_score = ?, previous_average_score = ?, completed_at = ? WHERE id = ?`)
      .bind(deals.length, changedDeals, readyDeals, atRiskDeals, criticalDeals, deals.length ? Math.round(scoreTotal / deals.length) : 0, deals.length ? Math.round(previousScoreTotal / deals.length) : 0, completedAt, simulationId).run();
  } catch (error) {
    await env.DB.prepare(`UPDATE policy_simulations SET status = 'failed', error_message = ?, completed_at = ? WHERE id = ?`)
      .bind((error instanceof Error ? error.message : String(error)).slice(0, 1000), new Date().toISOString(), simulationId).run();
  }
}

export async function latestPolicySimulation(env: Env, portalId: string): Promise<PolicySimulation | null> {
  const row = await env.DB.prepare(`SELECT * FROM policy_simulations WHERE portal_id = ? ORDER BY started_at DESC LIMIT 1`).bind(portalId).first<SimulationRow>();
  return row ? mapSimulation(row) : null;
}

export async function listRoles(env: Env, identity: RequestIdentity): Promise<Array<{ userId: string | null; userEmail: string | null; role: GovernanceRole; updatedAt: string }>> {
  await requireGovernancePermission(env, identity, 'role.manage');
  const rows = await env.DB.prepare(`SELECT user_id, user_email, role, updated_at FROM governance_roles WHERE portal_id = ? ORDER BY role, lower(COALESCE(user_email, user_id))`).bind(identity.portalId).all<{ user_id: string | null; user_email: string | null; role: GovernanceRole; updated_at: string }>();
  return (rows.results ?? []).map((row) => ({ userId: row.user_id, userEmail: row.user_email, role: row.role, updatedAt: row.updated_at }));
}

export async function assignRole(env: Env, identity: RequestIdentity, value: unknown): Promise<void> {
  await requireGovernancePermission(env, identity, 'role.manage');
  const input = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  const userId = typeof input.userId === 'string' && input.userId.trim() ? input.userId.trim().slice(0, 128) : null;
  const userEmail = typeof input.userEmail === 'string' && input.userEmail.includes('@') ? input.userEmail.trim().toLowerCase().slice(0, 254) : null;
  const roles: GovernanceRole[] = ['admin', 'policy_admin', 'approver', 'manager', 'viewer'];
  const role = roles.includes(input.role as GovernanceRole) ? input.role as GovernanceRole : null;
  if ((!userId && !userEmail) || !role) throw new AppError(400, 'role_assignment_invalid', 'Provide a HubSpot user ID or email and a valid governance role.');
  const now = new Date().toISOString();
  const existing = userId
    ? await env.DB.prepare(`SELECT id FROM governance_roles WHERE portal_id = ? AND user_id = ?`).bind(identity.portalId, userId).first<{ id: string }>()
    : await env.DB.prepare(`SELECT id FROM governance_roles WHERE portal_id = ? AND lower(user_email) = lower(?)`).bind(identity.portalId, userEmail).first<{ id: string }>();
  if (existing) {
    await env.DB.prepare(`UPDATE governance_roles SET user_id = ?, user_email = ?, role = ?, updated_at = ? WHERE id = ?`).bind(userId, userEmail, role, now, existing.id).run();
  } else {
    await env.DB.prepare(`INSERT INTO governance_roles (id, portal_id, user_id, user_email, role, created_by_user_id, created_by_email, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(crypto.randomUUID(), identity.portalId, userId, userEmail, role, identity.userId, identity.userEmail, now, now).run();
  }
  await new Repository(env).audit(identity.portalId, identity.userId, identity.userEmail, 'governance.role_assigned', { userId, userEmail, role });
}

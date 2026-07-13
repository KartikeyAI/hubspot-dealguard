import { sha256Hex } from './crypto.js';
import { AppError } from './errors.js';
import { activePolicy, createPolicyDraft, getPolicy, requireGovernancePermission } from './governance.js';
import { Repository } from './repository.js';
import type { Env, NormalizedDeal, RequestIdentity, RuleSettings } from './types.js';
import { parseRuleSettings } from './validation.js';

export interface PolicySegmentConditions {
  pipelineIds: string[];
  stageIds: string[];
  ownerIds: string[];
  teamIds: string[];
  regionCodes: string[];
  dealTypes: string[];
  minAmount: number | null;
  maxAmount: number | null;
}

export interface PolicySegment {
  id: string;
  policyId: string;
  name: string;
  priority: number;
  enabled: boolean;
  conditions: PolicySegmentConditions;
  rulesOverride: Partial<RuleSettings>;
  createdAt: string;
  updatedAt: string;
}

interface SegmentRow {
  id: string;
  policy_id: string;
  name: string;
  priority: number;
  enabled: number;
  conditions_json: string;
  rules_override_json: string;
  created_at: string;
  updated_at: string;
}

const SYSTEM_TEMPLATES = [
  {
    key: 'b2b-saas',
    name: 'B2B SaaS revenue governance',
    description: 'Readiness controls for subscription software pipelines with stakeholder, next-step, amount and close-date discipline.',
    industry: 'saas',
    rules: { staleDays: 7, maxStageAgeDays: 21, requireOwner: true, requireAmount: true, requireCloseDate: true, requireNextStep: true, requireCompany: true, requireContact: true, excludedPipelineIds: [], excludedStageIds: [], customRequiredProperties: [] },
    segments: [],
  },
  {
    key: 'professional-services',
    name: 'Professional services deal governance',
    description: 'Controls for scoped engagements, expected value, close timing and delivery handoff.',
    industry: 'professional_services',
    rules: { staleDays: 10, maxStageAgeDays: 30, requireOwner: true, requireAmount: true, requireCloseDate: true, requireNextStep: true, requireCompany: true, requireContact: true, excludedPipelineIds: [], excludedStageIds: [], customRequiredProperties: [] },
    segments: [],
  },
  {
    key: 'enterprise-sales',
    name: 'Enterprise sales governance',
    description: 'Stricter controls for complex enterprise opportunities and prolonged buying cycles.',
    industry: 'enterprise',
    rules: { staleDays: 5, maxStageAgeDays: 28, requireOwner: true, requireAmount: true, requireCloseDate: true, requireNextStep: true, requireCompany: true, requireContact: true, excludedPipelineIds: [], excludedStageIds: [], customRequiredProperties: [] },
    segments: [{ name: 'Strategic opportunities', priority: 10, conditions: { minAmount: 100000 }, rulesOverride: { staleDays: 3, maxStageAgeDays: 21 } }],
  },
  {
    key: 'renewals',
    name: 'Renewal pipeline governance',
    description: 'Controls for renewal visibility, owner accountability and time-bound follow-up.',
    industry: 'renewals',
    rules: { staleDays: 5, maxStageAgeDays: 14, requireOwner: true, requireAmount: true, requireCloseDate: true, requireNextStep: true, requireCompany: true, requireContact: true, excludedPipelineIds: [], excludedStageIds: [], customRequiredProperties: [] },
    segments: [],
  },
  {
    key: 'partner-channel',
    name: 'Partner and channel governance',
    description: 'Deal controls for partner-owned opportunities and indirect selling motions.',
    industry: 'channel',
    rules: { staleDays: 10, maxStageAgeDays: 30, requireOwner: true, requireAmount: true, requireCloseDate: true, requireNextStep: true, requireCompany: true, requireContact: true, excludedPipelineIds: [], excludedStageIds: [], customRequiredProperties: [] },
    segments: [],
  },
] as const;

function strings(value: unknown, max = 100): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((item): item is string => typeof item === 'string' && Boolean(item.trim())).map((item) => item.trim().slice(0, 128)))].slice(0, max);
}

function finite(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function conditions(value: unknown): PolicySegmentConditions {
  const item = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  const minAmount = finite(item.minAmount);
  const maxAmount = finite(item.maxAmount);
  if (minAmount !== null && maxAmount !== null && minAmount > maxAmount) {
    throw new AppError(400, 'segment_amount_range_invalid', 'Segment minimum amount cannot exceed maximum amount.');
  }
  return {
    pipelineIds: strings(item.pipelineIds, 100),
    stageIds: strings(item.stageIds, 250),
    ownerIds: strings(item.ownerIds, 500),
    teamIds: strings(item.teamIds, 100),
    regionCodes: strings(item.regionCodes, 100),
    dealTypes: strings(item.dealTypes, 100),
    minAmount,
    maxAmount,
  };
}

function mapSegment(row: SegmentRow): PolicySegment {
  return {
    id: row.id,
    policyId: row.policy_id,
    name: row.name,
    priority: Number(row.priority),
    enabled: Boolean(row.enabled),
    conditions: conditions(JSON.parse(row.conditions_json)),
    rulesOverride: JSON.parse(row.rules_override_json) as Partial<RuleSettings>,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function patchRules(base: RuleSettings, override: Partial<RuleSettings>): RuleSettings {
  return {
    ...base,
    ...override,
    excludedPipelineIds: override.excludedPipelineIds ?? base.excludedPipelineIds,
    excludedStageIds: override.excludedStageIds ?? base.excludedStageIds,
    customRequiredProperties: override.customRequiredProperties ?? base.customRequiredProperties,
  };
}

function dealMetadata(deal: NormalizedDeal): {
  pipelineId: string;
  stageId: string;
  ownerId: string;
  teamId: string;
  regionCode: string;
  dealType: string;
  amount: number | null;
} {
  const amount = finite(deal.properties.amount);
  return {
    pipelineId: deal.stage?.pipelineId ?? deal.properties.pipeline ?? '',
    stageId: deal.stage?.id ?? deal.properties.dealstage ?? '',
    ownerId: deal.properties.hubspot_owner_id ?? '',
    teamId: deal.properties.hs_team_id ?? deal.properties.dealguard_team_id ?? '',
    regionCode: deal.properties.region ?? deal.properties.dealguard_region ?? '',
    dealType: deal.properties.dealtype ?? deal.properties.deal_type ?? '',
    amount,
  };
}

function segmentMatches(segment: PolicySegment, deal: NormalizedDeal): boolean {
  if (!segment.enabled) return false;
  const c = segment.conditions;
  const meta = dealMetadata(deal);
  if (c.pipelineIds.length && !c.pipelineIds.includes(meta.pipelineId)) return false;
  if (c.stageIds.length && !c.stageIds.includes(meta.stageId)) return false;
  if (c.ownerIds.length && !c.ownerIds.includes(meta.ownerId)) return false;
  if (c.teamIds.length && !c.teamIds.includes(meta.teamId)) return false;
  if (c.regionCodes.length && !c.regionCodes.includes(meta.regionCode)) return false;
  if (c.dealTypes.length && !c.dealTypes.includes(meta.dealType)) return false;
  if (c.minAmount !== null && (meta.amount === null || meta.amount < c.minAmount)) return false;
  if (c.maxAmount !== null && (meta.amount === null || meta.amount > c.maxAmount)) return false;
  return true;
}

export async function resolveSegmentedRules(env: Env, portalId: string, base: RuleSettings, deal: NormalizedDeal): Promise<{ rules: RuleSettings; segmentIds: string[]; policyId: string | null }> {
  const policy = await activePolicy(env, portalId);
  if (!policy) return { rules: base, segmentIds: [], policyId: null };
  const rows = await env.DB.prepare(`SELECT * FROM policy_segments WHERE portal_id = ? AND policy_id = ? AND enabled = 1 ORDER BY priority ASC, created_at ASC`)
    .bind(portalId, policy.id).all<SegmentRow>();
  let rules = policy.rules;
  const segmentIds: string[] = [];
  for (const row of rows.results ?? []) {
    const segment = mapSegment(row);
    if (segmentMatches(segment, deal)) {
      rules = patchRules(rules, segment.rulesOverride);
      segmentIds.push(segment.id);
    }
  }
  return { rules, segmentIds, policyId: policy.id };
}

export async function listPolicyTemplates(env: Env, portalId: string): Promise<Array<Record<string, unknown>>> {
  const rows = await env.DB.prepare(`SELECT * FROM policy_templates WHERE is_system = 1 OR owner_portal_id = ? ORDER BY is_system DESC, name ASC`)
    .bind(portalId).all<Record<string, unknown>>();
  return [
    ...SYSTEM_TEMPLATES.map((template) => ({ id: `system:${template.key}`, ...template, isSystem: true })),
    ...(rows.results ?? []).map((row) => ({
      id: String(row.id),
      key: String(row.key),
      name: String(row.name),
      description: String(row.description),
      industry: row.industry ? String(row.industry) : null,
      rules: JSON.parse(String(row.rules_json)),
      segments: JSON.parse(String(row.segments_json)),
      isSystem: Boolean(row.is_system),
    })),
  ];
}

export async function createPolicyTemplate(env: Env, identity: RequestIdentity, value: unknown): Promise<Record<string, unknown>> {
  await requireGovernancePermission(env, identity, 'policy.manage');
  const input = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  const name = typeof input.name === 'string' ? input.name.trim().slice(0, 120) : '';
  if (!name) throw new AppError(400, 'template_name_required', 'A template name is required.');
  const credentials = await new Repository(env).getCredentials(identity.portalId);
  const rules = parseRuleSettings(input.rules ?? credentials.settings.rules, credentials.tenant.plan);
  const id = crypto.randomUUID();
  const key = (typeof input.key === 'string' && input.key.trim() ? input.key : name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '').slice(0, 80);
  const now = new Date().toISOString();
  await env.DB.prepare(
    `INSERT INTO policy_templates (id, owner_portal_id, key, name, description, industry, rules_json, segments_json, is_system, created_by_user_id, created_by_email, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?)`
  ).bind(id, identity.portalId, key, name, typeof input.description === 'string' ? input.description.slice(0, 2000) : '', typeof input.industry === 'string' ? input.industry.slice(0, 80) : null, JSON.stringify(rules), JSON.stringify(Array.isArray(input.segments) ? input.segments.slice(0, 100) : []), identity.userId, identity.userEmail, now, now).run();
  await new Repository(env).audit(identity.portalId, identity.userId, identity.userEmail, 'policy.template_created', { templateId: id, key, name });
  return { id, key, name, rules, segments: Array.isArray(input.segments) ? input.segments : [], isSystem: false };
}

export async function createPolicyFromTemplate(env: Env, identity: RequestIdentity, templateId: string): Promise<unknown> {
  await requireGovernancePermission(env, identity, 'policy.manage');
  let template: { name: string; description: string; rules: RuleSettings; segments: Array<Record<string, unknown>> };
  if (templateId.startsWith('system:')) {
    const found = SYSTEM_TEMPLATES.find((item) => `system:${item.key}` === templateId);
    if (!found) throw new AppError(404, 'policy_template_not_found', 'The policy template does not exist.');
    template = { name: found.name, description: found.description, rules: found.rules as unknown as RuleSettings, segments: found.segments as unknown as Array<Record<string, unknown>> };
  } else {
    const row = await env.DB.prepare(`SELECT name, description, rules_json, segments_json FROM policy_templates WHERE id = ? AND (owner_portal_id = ? OR is_system = 1)`)
      .bind(templateId, identity.portalId).first<{ name: string; description: string; rules_json: string; segments_json: string }>();
    if (!row) throw new AppError(404, 'policy_template_not_found', 'The policy template does not exist.');
    template = { name: row.name, description: row.description, rules: JSON.parse(row.rules_json), segments: JSON.parse(row.segments_json) };
  }
  const policy = await createPolicyDraft(env, identity, { name: `${template.name} — draft`, description: template.description, rules: template.rules, changeSummary: `Created from template ${templateId}` });
  for (const segment of template.segments) {
    await upsertPolicySegment(env, identity, policy.id, null, segment);
  }
  return getPolicy(env, identity.portalId, policy.id);
}

export async function listPolicySegments(env: Env, portalId: string, policyId: string): Promise<PolicySegment[]> {
  const rows = await env.DB.prepare(`SELECT * FROM policy_segments WHERE portal_id = ? AND policy_id = ? ORDER BY priority ASC, created_at ASC`)
    .bind(portalId, policyId).all<SegmentRow>();
  return (rows.results ?? []).map(mapSegment);
}

export async function upsertPolicySegment(env: Env, identity: RequestIdentity, policyId: string, segmentId: string | null, value: unknown): Promise<PolicySegment> {
  await requireGovernancePermission(env, identity, 'policy.manage');
  const policy = await getPolicy(env, identity.portalId, policyId);
  if (!policy) throw new AppError(404, 'policy_not_found', 'The policy does not exist.');
  if (!['draft', 'rejected'].includes(policy.status)) throw new AppError(409, 'policy_not_editable', 'Segments can only be edited on draft or rejected policies.');
  const input = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  const name = typeof input.name === 'string' ? input.name.trim().slice(0, 120) : '';
  if (!name) throw new AppError(400, 'segment_name_required', 'A segment name is required.');
  const credentials = await new Repository(env).getCredentials(identity.portalId);
  const overrideInput = input.rulesOverride && typeof input.rulesOverride === 'object' ? input.rulesOverride as Record<string, unknown> : {};
  const validated = parseRuleSettings({ ...policy.rules, ...overrideInput }, credentials.tenant.plan);
  const override: Partial<RuleSettings> = {};
  for (const key of Object.keys(overrideInput) as Array<keyof RuleSettings>) override[key] = validated[key] as never;
  const id = segmentId ?? crypto.randomUUID();
  const now = new Date().toISOString();
  await env.DB.prepare(
    `INSERT INTO policy_segments (id, portal_id, policy_id, name, priority, enabled, conditions_json, rules_override_json, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET name = excluded.name, priority = excluded.priority, enabled = excluded.enabled,
     conditions_json = excluded.conditions_json, rules_override_json = excluded.rules_override_json, updated_at = excluded.updated_at`
  ).bind(id, identity.portalId, policyId, name, Math.min(10000, Math.max(0, Number(input.priority ?? 100) || 100)), input.enabled === false ? 0 : 1, JSON.stringify(conditions(input.conditions)), JSON.stringify(override), now, now).run();
  await new Repository(env).audit(identity.portalId, identity.userId, identity.userEmail, segmentId ? 'policy.segment_updated' : 'policy.segment_created', { policyId, segmentId: id });
  const row = await env.DB.prepare(`SELECT * FROM policy_segments WHERE id = ? AND portal_id = ?`).bind(id, identity.portalId).first<SegmentRow>();
  if (!row) throw new AppError(500, 'segment_save_failed', 'The policy segment could not be loaded.');
  return mapSegment(row);
}

export async function deletePolicySegment(env: Env, identity: RequestIdentity, policyId: string, segmentId: string): Promise<void> {
  await requireGovernancePermission(env, identity, 'policy.manage');
  const policy = await getPolicy(env, identity.portalId, policyId);
  if (!policy || !['draft', 'rejected'].includes(policy.status)) throw new AppError(409, 'policy_not_editable', 'Only draft or rejected policy segments can be deleted.');
  const result = await env.DB.prepare(`DELETE FROM policy_segments WHERE portal_id = ? AND policy_id = ? AND id = ?`).bind(identity.portalId, policyId, segmentId).run();
  if (!Number(result.meta?.changes ?? 0)) throw new AppError(404, 'segment_not_found', 'The policy segment does not exist.');
  await new Repository(env).audit(identity.portalId, identity.userId, identity.userEmail, 'policy.segment_deleted', { policyId, segmentId });
}

function diffValue(before: unknown, after: unknown, path = ''): Array<{ path: string; before: unknown; after: unknown }> {
  if (JSON.stringify(before) === JSON.stringify(after)) return [];
  if (before && after && typeof before === 'object' && typeof after === 'object' && !Array.isArray(before) && !Array.isArray(after)) {
    const left = before as Record<string, unknown>;
    const right = after as Record<string, unknown>;
    return [...new Set([...Object.keys(left), ...Object.keys(right)])].flatMap((key) => diffValue(left[key], right[key], path ? `${path}.${key}` : key));
  }
  return [{ path, before: before ?? null, after: after ?? null }];
}

export async function policyDiff(env: Env, portalId: string, policyId: string): Promise<Array<{ path: string; before: unknown; after: unknown }>> {
  const policy = await getPolicy(env, portalId, policyId);
  if (!policy) throw new AppError(404, 'policy_not_found', 'The policy does not exist.');
  const base = policy.basedOnPolicyId ? await getPolicy(env, portalId, policy.basedOnPolicyId) : null;
  const before = { rules: base?.rules ?? null, segments: base ? await listPolicySegments(env, portalId, base.id) : [] };
  const after = { rules: policy.rules, segments: await listPolicySegments(env, portalId, policy.id) };
  const diff = diffValue(before, after);
  await env.DB.prepare(
    `INSERT INTO policy_diffs (policy_id, portal_id, base_policy_id, diff_json, generated_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(policy_id) DO UPDATE SET base_policy_id = excluded.base_policy_id, diff_json = excluded.diff_json, generated_at = excluded.generated_at`
  ).bind(policy.id, portalId, base?.id ?? null, JSON.stringify(diff), new Date().toISOString()).run();
  return diff;
}

export async function exportPolicyPackage(env: Env, identity: RequestIdentity, policyId: string): Promise<Response> {
  await requireGovernancePermission(env, identity, 'audit.export');
  const policy = await getPolicy(env, identity.portalId, policyId);
  if (!policy) throw new AppError(404, 'policy_not_found', 'The policy does not exist.');
  const packageValue = {
    schema: 'dealguard-policy',
    version: 1,
    exportedAt: new Date().toISOString(),
    policy: {
      name: policy.name,
      description: policy.description,
      rules: policy.rules,
      changeSummary: policy.changeSummary,
      segments: await listPolicySegments(env, identity.portalId, policy.id),
    },
  };
  const json = JSON.stringify(packageValue, null, 2);
  const checksum = await sha256Hex(json);
  await env.DB.prepare(`INSERT INTO policy_import_exports (id, portal_id, direction, checksum, format_version, status, actor_user_id, actor_email, created_at) VALUES (?, ?, 'export', ?, 1, 'completed', ?, ?, ?)`)
    .bind(crypto.randomUUID(), identity.portalId, checksum, identity.userId, identity.userEmail, new Date().toISOString()).run();
  return new Response(json, {
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'content-disposition': `attachment; filename="dealguard-policy-${policy.versionNumber}.json"`,
      'x-content-sha256': checksum,
      'cache-control': 'no-store',
    },
  });
}

export async function importPolicyPackage(env: Env, identity: RequestIdentity, value: unknown): Promise<unknown> {
  await requireGovernancePermission(env, identity, 'policy.manage');
  const input = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  if (input.schema !== 'dealguard-policy' || Number(input.version) !== 1) throw new AppError(400, 'policy_package_invalid', 'The policy package schema or version is unsupported.');
  const source = input.policy && typeof input.policy === 'object' ? input.policy as Record<string, unknown> : {};
  const raw = JSON.stringify(input);
  const checksum = await sha256Hex(raw);
  const existing = await env.DB.prepare(`SELECT id FROM policy_import_exports WHERE portal_id = ? AND direction = 'import' AND checksum = ? LIMIT 1`)
    .bind(identity.portalId, checksum).first<{ id: string }>();
  if (existing) throw new AppError(409, 'policy_package_already_imported', 'This exact policy package has already been imported.');
  const policy = await createPolicyDraft(env, identity, {
    name: typeof source.name === 'string' ? `${source.name} — imported` : 'Imported policy',
    description: source.description,
    rules: source.rules,
    changeSummary: `Imported package ${checksum.slice(0, 12)}`,
  });
  const segments = Array.isArray(source.segments) ? source.segments.slice(0, 100) : [];
  for (const segment of segments) await upsertPolicySegment(env, identity, policy.id, null, segment);
  await env.DB.prepare(`INSERT INTO policy_import_exports (id, portal_id, direction, checksum, format_version, status, actor_user_id, actor_email, created_at) VALUES (?, ?, 'import', ?, 1, 'completed', ?, ?, ?)`)
    .bind(crypto.randomUUID(), identity.portalId, checksum, identity.userId, identity.userEmail, new Date().toISOString()).run();
  await new Repository(env).audit(identity.portalId, identity.userId, identity.userEmail, 'policy.imported', { policyId: policy.id, checksum });
  return getPolicy(env, identity.portalId, policy.id);
}

export async function createPolicyException(env: Env, identity: RequestIdentity, value: unknown): Promise<Record<string, unknown>> {
  await requireGovernancePermission(env, identity, 'exception.manage');
  const input = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  const dealId = typeof input.dealId === 'string' && /^\d+$/.test(input.dealId) ? input.dealId : '';
  const issueCode = typeof input.issueCode === 'string' ? input.issueCode.trim().slice(0, 128) : '';
  const reason = typeof input.reason === 'string' ? input.reason.trim().slice(0, 4000) : '';
  if (!dealId || !issueCode || !reason) throw new AppError(400, 'exception_fields_required', 'Deal ID, issue code and reason are required.');
  const expiresAt = typeof input.expiresAt === 'string' && Number.isFinite(Date.parse(input.expiresAt)) ? new Date(input.expiresAt).toISOString() : null;
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  await env.DB.prepare(
    `INSERT INTO policy_exceptions (id, portal_id, deal_id, issue_code, reason, status, expires_at, requested_by_user_id, requested_by_email, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?)`
  ).bind(id, identity.portalId, dealId, issueCode, reason, expiresAt, identity.userId, identity.userEmail, now, now).run();
  await new Repository(env).audit(identity.portalId, identity.userId, identity.userEmail, 'policy.exception_requested', { exceptionId: id, dealId, issueCode, expiresAt });
  return { id, dealId, issueCode, reason, status: 'pending', expiresAt, createdAt: now };
}

export async function decidePolicyException(env: Env, identity: RequestIdentity, exceptionId: string, decision: 'approved' | 'rejected' | 'revoked', comment = ''): Promise<void> {
  await requireGovernancePermission(env, identity, 'exception.manage');
  const now = new Date().toISOString();
  const result = await env.DB.prepare(
    `UPDATE policy_exceptions SET status = ?, decided_by_user_id = ?, decided_by_email = ?, decided_at = ?, updated_at = ? WHERE portal_id = ? AND id = ?`
  ).bind(decision, identity.userId, identity.userEmail, now, now, identity.portalId, exceptionId).run();
  if (!Number(result.meta?.changes ?? 0)) throw new AppError(404, 'policy_exception_not_found', 'The policy exception does not exist.');
  if (comment.trim()) {
    await env.DB.prepare(`INSERT INTO policy_exception_comments (id, portal_id, exception_id, body, actor_user_id, actor_email, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .bind(crypto.randomUUID(), identity.portalId, exceptionId, comment.trim().slice(0, 4000), identity.userId, identity.userEmail, now).run();
  }
  await new Repository(env).audit(identity.portalId, identity.userId, identity.userEmail, `policy.exception_${decision}`, { exceptionId, comment });
}

export async function addPolicyExceptionEvidence(env: Env, identity: RequestIdentity, exceptionId: string, value: unknown): Promise<Record<string, unknown>> {
  await requireGovernancePermission(env, identity, 'exception.manage');
  const input = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  const type = ['url', 'text', 'hubspot_object', 'external_reference'].includes(String(input.type)) ? String(input.type) : 'text';
  const label = typeof input.label === 'string' ? input.label.trim().slice(0, 255) : '';
  const evidenceValue = typeof input.value === 'string' ? input.value.trim().slice(0, 8000) : '';
  if (!label || !evidenceValue) throw new AppError(400, 'evidence_fields_required', 'Evidence label and value are required.');
  const exists = await env.DB.prepare(`SELECT id FROM policy_exceptions WHERE portal_id = ? AND id = ?`).bind(identity.portalId, exceptionId).first<{ id: string }>();
  if (!exists) throw new AppError(404, 'policy_exception_not_found', 'The policy exception does not exist.');
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const hash = await sha256Hex(`${type}:${label}:${evidenceValue}`);
  await env.DB.prepare(`INSERT INTO policy_exception_evidence (id, portal_id, exception_id, evidence_type, label, value, content_hash, created_by_user_id, created_by_email, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(id, identity.portalId, exceptionId, type, label, evidenceValue, hash, identity.userId, identity.userEmail, now).run();
  await new Repository(env).audit(identity.portalId, identity.userId, identity.userEmail, 'policy.exception_evidence_added', { exceptionId, evidenceId: id, hash });
  return { id, type, label, value: evidenceValue, hash, createdAt: now };
}

export async function expirePolicyExceptions(env: Env): Promise<void> {
  const now = new Date().toISOString();
  await env.DB.prepare(`UPDATE policy_exceptions SET status = 'expired', updated_at = ? WHERE status = 'approved' AND expires_at IS NOT NULL AND expires_at <= ?`)
    .bind(now, now).run();
}

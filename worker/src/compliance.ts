import { appendAuditChainEvent, canonicalAuditValue, type AuditChainInput } from './audit-chain.js';
import { decryptSecret, encryptSecret, randomToken, sha256Hex } from './crypto.js';
import { requireEnterprisePermission } from './enterprise-access.js';
import { AppError } from './errors.js';
import { createSignedObjectDownload, putObject, tenantObjectKey } from './object-storage.js';
import { enqueueDataExport } from './queue-publisher.js';
import type { Env, RequestIdentity } from './types.js';

const encoder = new TextEncoder();

export type ImmutableAuditInput = AuditChainInput;

export async function appendImmutableAudit(env: Env, input: ImmutableAuditInput): Promise<string> {
  return appendAuditChainEvent(env, input);
}

export async function verifyAuditChain(env: Env, identity: RequestIdentity): Promise<Record<string, unknown>> {
  await requireEnterprisePermission(env, identity, 'audit.view');
  const rows = await env.DB.prepare(`SELECT * FROM audit_events_v2 WHERE portal_id = ? ORDER BY sequence_number ASC`)
    .bind(identity.portalId).all<Record<string, unknown>>();
  let previous: string | null = null;
  let verified = 0;
  const failures: Array<{ id: string; sequence: number; reason: string }> = [];
  for (const row of rows.results ?? []) {
    if ((row.previous_hash ?? null) !== previous) failures.push({ id: String(row.id), sequence: Number(row.sequence_number), reason: 'previous_hash_mismatch' });
    const canonical = canonicalAuditValue({
      id: row.id, portalId: row.portal_id, sequence: Number(row.sequence_number), action: row.action,
      resourceType: row.resource_type ?? null, resourceId: row.resource_id ?? null,
      actorUserId: row.actor_user_id ?? null, actorEmail: row.actor_email ?? null,
      source: row.source, requestId: row.request_id ?? null, ipHash: row.ip_hash ?? null,
      userAgentHash: row.user_agent_hash ?? null,
      before: row.before_json ? JSON.parse(String(row.before_json)) : null,
      after: row.after_json ? JSON.parse(String(row.after_json)) : null,
      metadata: JSON.parse(String(row.metadata_json ?? '{}')), previousHash: row.previous_hash ?? null, createdAt: row.created_at,
    });
    const expected = await sha256Hex(canonical);
    if (expected !== String(row.event_hash)) failures.push({ id: String(row.id), sequence: Number(row.sequence_number), reason: 'event_hash_mismatch' });
    else verified += 1;
    previous = String(row.event_hash);
  }
  return { valid: failures.length === 0, verifiedEvents: verified, failures };
}

export async function searchImmutableAudit(env: Env, identity: RequestIdentity, url: URL): Promise<Array<Record<string, unknown>>> {
  await requireEnterprisePermission(env, identity, 'audit.view');
  const action = (url.searchParams.get('action') ?? '').slice(0, 160);
  const resourceType = (url.searchParams.get('resourceType') ?? '').slice(0, 100);
  const actorEmail = (url.searchParams.get('actorEmail') ?? '').slice(0, 254);
  const source = (url.searchParams.get('source') ?? '').slice(0, 80);
  const from = url.searchParams.get('from') && Number.isFinite(Date.parse(url.searchParams.get('from')!)) ? new Date(url.searchParams.get('from')!).toISOString() : '';
  const to = url.searchParams.get('to') && Number.isFinite(Date.parse(url.searchParams.get('to')!)) ? new Date(url.searchParams.get('to')!).toISOString() : '';
  const limit = Math.min(1000, Math.max(1, Number(url.searchParams.get('limit') ?? 100) || 100));
  const rows = await env.DB.prepare(
    `SELECT * FROM audit_events_v2 WHERE portal_id = ?
      AND (? = '' OR action = ?)
      AND (? = '' OR resource_type = ?)
      AND (? = '' OR lower(COALESCE(actor_email,'')) = lower(?))
      AND (? = '' OR source = ?)
      AND (? = '' OR created_at >= ?)
      AND (? = '' OR created_at <= ?)
     ORDER BY sequence_number DESC LIMIT ?`
  ).bind(identity.portalId, action, action, resourceType, resourceType, actorEmail, actorEmail, source, source, from, from, to, to, limit).all<Record<string, unknown>>();
  return (rows.results ?? []).map((row) => ({
    id: row.id, sequenceNumber: Number(row.sequence_number), action: row.action,
    resourceType: row.resource_type, resourceId: row.resource_id,
    actorUserId: row.actor_user_id, actorEmail: row.actor_email, source: row.source,
    requestId: row.request_id, ipHash: row.ip_hash, userAgentHash: row.user_agent_hash,
    before: row.before_json ? JSON.parse(String(row.before_json)) : null,
    after: row.after_json ? JSON.parse(String(row.after_json)) : null,
    metadata: JSON.parse(String(row.metadata_json ?? '{}')),
    previousHash: row.previous_hash, eventHash: row.event_hash, createdAt: row.created_at,
  }));
}

function csv(value: unknown): string {
  const text = typeof value === 'string' ? value : JSON.stringify(value ?? '');
  return `"${text.replaceAll('"', '""')}"`;
}

export async function exportImmutableAudit(env: Env, identity: RequestIdentity, url: URL): Promise<Response> {
  await requireEnterprisePermission(env, identity, 'audit.export');
  const format = url.searchParams.get('format') === 'jsonl' ? 'jsonl' : url.searchParams.get('format') === 'json' ? 'json' : 'csv';
  const events = await searchImmutableAudit(env, identity, new URL(`${url.origin}${url.pathname}?limit=1000&${url.searchParams.toString()}`));
  let body: string;
  let contentType: string;
  if (format === 'json') {
    body = JSON.stringify({ schema: 'dealguard-audit-export', version: 2, portalId: identity.portalId, exportedAt: new Date().toISOString(), events }, null, 2);
    contentType = 'application/json; charset=utf-8';
  } else if (format === 'jsonl') {
    body = events.map((event) => JSON.stringify(event)).join('\n');
    contentType = 'application/x-ndjson; charset=utf-8';
  } else {
    const lines = ['sequence,id,action,resource_type,resource_id,actor_user_id,actor_email,source,request_id,ip_hash,user_agent_hash,before,after,metadata,previous_hash,event_hash,created_at'];
    for (const event of events) lines.push([
      event.sequenceNumber, event.id, event.action, event.resourceType, event.resourceId, event.actorUserId,
      event.actorEmail, event.source, event.requestId, event.ipHash, event.userAgentHash,
      event.before, event.after, event.metadata, event.previousHash, event.eventHash, event.createdAt,
    ].map(csv).join(','));
    body = lines.join('\n');
    contentType = 'text/csv; charset=utf-8';
  }
  return new Response(body, {
    headers: {
      'content-type': contentType,
      'content-disposition': `attachment; filename="dealguard-audit-${identity.portalId}.${format === 'jsonl' ? 'jsonl' : format}"`,
      'x-content-sha256': await sha256Hex(body),
      'cache-control': 'no-store',
    },
  });
}

export async function getComplianceSettings(env: Env, identity: RequestIdentity): Promise<Record<string, unknown>> {
  await requireEnterprisePermission(env, identity, 'compliance.view');
  const settings = await env.DB.prepare(`SELECT * FROM compliance_settings WHERE portal_id = ?`).bind(identity.portalId).first<Record<string, unknown>>();
  const holds = await env.DB.prepare(`SELECT * FROM legal_holds WHERE portal_id = ? ORDER BY created_at DESC`).bind(identity.portalId).all<Record<string, unknown>>();
  const siem = await env.DB.prepare(`SELECT id, name, event_filters_json, enabled, last_success_at, last_error, created_at, updated_at FROM siem_destinations WHERE portal_id = ? ORDER BY name`)
    .bind(identity.portalId).all<Record<string, unknown>>();
  return {
    settings: settings ? {
      auditRetentionDays: Number(settings.audit_retention_days), operationalRetentionDays: Number(settings.operational_retention_days),
      legalHoldEnabled: Boolean(settings.legal_hold_enabled), legalHoldReason: settings.legal_hold_reason,
      dataRegion: settings.data_region, updatedAt: settings.updated_at,
    } : { auditRetentionDays: 2555, operationalRetentionDays: 365, legalHoldEnabled: false, legalHoldReason: null, dataRegion: 'global' },
    legalHolds: (holds.results ?? []).map((row) => ({ id: row.id, name: row.name, reason: row.reason, scope: JSON.parse(String(row.scope_json)), status: row.status, createdAt: row.created_at, releasedAt: row.released_at })),
    siemDestinations: (siem.results ?? []).map((row) => ({ id: row.id, name: row.name, eventFilters: JSON.parse(String(row.event_filters_json)), enabled: Boolean(row.enabled), lastSuccessAt: row.last_success_at, lastError: row.last_error, createdAt: row.created_at, updatedAt: row.updated_at })),
  };
}

export async function updateComplianceSettings(env: Env, identity: RequestIdentity, value: unknown): Promise<void> {
  await requireEnterprisePermission(env, identity, 'compliance.manage');
  const input = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  const auditRetentionDays = Math.min(36500, Math.max(365, Number(input.auditRetentionDays ?? 2555) || 2555));
  const operationalRetentionDays = Math.min(3650, Math.max(30, Number(input.operationalRetentionDays ?? 365) || 365));
  const dataRegion = typeof input.dataRegion === 'string' ? input.dataRegion.trim().slice(0, 50) : 'global';
  const existing = await env.DB.prepare(`SELECT * FROM compliance_settings WHERE portal_id = ?`).bind(identity.portalId).first<Record<string, unknown>>();
  const now = new Date().toISOString();
  await env.DB.prepare(
    `INSERT INTO compliance_settings (portal_id, audit_retention_days, operational_retention_days, legal_hold_enabled, legal_hold_reason, data_region, updated_by_user_id, updated_by_email, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(portal_id) DO UPDATE SET audit_retention_days = excluded.audit_retention_days,
      operational_retention_days = excluded.operational_retention_days, data_region = excluded.data_region,
      updated_by_user_id = excluded.updated_by_user_id, updated_by_email = excluded.updated_by_email, updated_at = excluded.updated_at`
  ).bind(identity.portalId, auditRetentionDays, operationalRetentionDays, Number(existing?.legal_hold_enabled ?? 0), existing?.legal_hold_reason ?? null, dataRegion, identity.userId, identity.userEmail, now).run();
  await appendImmutableAudit(env, { portalId: identity.portalId, action: 'compliance.settings_updated', resourceType: 'compliance_settings', resourceId: identity.portalId, actorUserId: identity.userId, actorEmail: identity.userEmail, before: existing, after: { auditRetentionDays, operationalRetentionDays, dataRegion } });
}

export async function createLegalHold(env: Env, identity: RequestIdentity, value: unknown): Promise<Record<string, unknown>> {
  await requireEnterprisePermission(env, identity, 'legal_hold.manage');
  const input = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  const name = typeof input.name === 'string' ? input.name.trim().slice(0, 120) : '';
  const reason = typeof input.reason === 'string' ? input.reason.trim().slice(0, 4000) : '';
  if (!name || !reason) throw new AppError(400, 'legal_hold_invalid', 'Legal hold name and reason are required.');
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO legal_holds (id, portal_id, name, reason, scope_json, status, created_by_user_id, created_by_email, created_at) VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?)`)
      .bind(id, identity.portalId, name, reason, JSON.stringify(input.scope ?? { all: true }), identity.userId, identity.userEmail, now),
    env.DB.prepare(
      `INSERT INTO compliance_settings (portal_id, legal_hold_enabled, legal_hold_reason, updated_at) VALUES (?, 1, ?, ?)
       ON CONFLICT(portal_id) DO UPDATE SET legal_hold_enabled = 1, legal_hold_reason = excluded.legal_hold_reason, updated_at = excluded.updated_at`
    ).bind(identity.portalId, reason, now),
  ]);
  await appendImmutableAudit(env, { portalId: identity.portalId, action: 'legal_hold.created', resourceType: 'legal_hold', resourceId: id, actorUserId: identity.userId, actorEmail: identity.userEmail, after: { name, reason, scope: input.scope ?? { all: true } } });
  return { id, name, reason, status: 'active', createdAt: now };
}

export async function releaseLegalHold(env: Env, identity: RequestIdentity, holdId: string): Promise<void> {
  await requireEnterprisePermission(env, identity, 'legal_hold.manage');
  const now = new Date().toISOString();
  const result = await env.DB.prepare(
    `UPDATE legal_holds SET status = 'released', released_at = ?, released_by_user_id = ?, released_by_email = ? WHERE portal_id = ? AND id = ? AND status = 'active'`
  ).bind(now, identity.userId, identity.userEmail, identity.portalId, holdId).run();
  if (!Number(result.meta?.changes ?? 0)) throw new AppError(404, 'legal_hold_not_found', 'The active legal hold does not exist.');
  const active = await env.DB.prepare(`SELECT COUNT(*) AS count FROM legal_holds WHERE portal_id = ? AND status = 'active'`).bind(identity.portalId).first<{ count: number }>();
  if (Number(active?.count ?? 0) === 0) await env.DB.prepare(`UPDATE compliance_settings SET legal_hold_enabled = 0, legal_hold_reason = NULL, updated_at = ? WHERE portal_id = ?`).bind(now, identity.portalId).run();
  await appendImmutableAudit(env, { portalId: identity.portalId, action: 'legal_hold.released', resourceType: 'legal_hold', resourceId: holdId, actorUserId: identity.userId, actorEmail: identity.userEmail });
}

export async function createSiemDestination(env: Env, identity: RequestIdentity, value: unknown): Promise<Record<string, unknown>> {
  await requireEnterprisePermission(env, identity, 'siem.manage');
  const input = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  const name = typeof input.name === 'string' ? input.name.trim().slice(0, 120) : '';
  const endpointValue = typeof input.endpoint === 'string' ? input.endpoint.trim() : '';
  let endpoint: URL;
  try { endpoint = new URL(endpointValue); } catch { throw new AppError(400, 'siem_endpoint_invalid', 'A valid SIEM HTTPS endpoint is required.'); }
  if (endpoint.protocol !== 'https:' || !name) throw new AppError(400, 'siem_endpoint_invalid', 'SIEM name and HTTPS endpoint are required.');
  const secret = typeof input.signingSecret === 'string' && input.signingSecret.length >= 24 ? input.signingSecret : randomToken();
  const encryptedEndpoint = await encryptSecret(endpoint.toString(), env.TOKEN_ENCRYPTION_KEY);
  const encryptedSecret = await encryptSecret(secret, env.TOKEN_ENCRYPTION_KEY);
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  await env.DB.prepare(
    `INSERT INTO siem_destinations (id, portal_id, name, endpoint_cipher, endpoint_iv, signing_secret_cipher, signing_secret_iv, event_filters_json, enabled, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`
  ).bind(id, identity.portalId, name, encryptedEndpoint.cipher, encryptedEndpoint.iv, encryptedSecret.cipher, encryptedSecret.iv, JSON.stringify(Array.isArray(input.eventFilters) ? input.eventFilters.slice(0, 100) : []), now, now).run();
  await appendImmutableAudit(env, { portalId: identity.portalId, action: 'siem.destination_created', resourceType: 'siem_destination', resourceId: id, actorUserId: identity.userId, actorEmail: identity.userEmail, after: { name, endpoint: endpoint.origin, eventFilters: input.eventFilters ?? [] } });
  return { id, name, enabled: true, signingSecret: secret, createdAt: now };
}

async function hmacBase64(secret: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const bytes = new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(body)));
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export async function dispatchSiemEvents(env: Env, limit = 500): Promise<void> {
  const destinations = await env.DB.prepare(`SELECT * FROM siem_destinations WHERE enabled = 1 LIMIT 100`).all<Record<string, unknown>>();
  for (const destination of destinations.results ?? []) {
    const lastSuccess = destination.last_success_at ? String(destination.last_success_at) : new Date(Date.now() - 5 * 60_000).toISOString();
    const events = await env.DB.prepare(`SELECT * FROM audit_events_v2 WHERE portal_id = ? AND created_at > ? ORDER BY sequence_number ASC LIMIT ?`)
      .bind(String(destination.portal_id), lastSuccess, Math.min(1000, limit)).all<Record<string, unknown>>();
    if (!(events.results ?? []).length) continue;
    try {
      const filters = JSON.parse(String(destination.event_filters_json ?? '[]')) as string[];
      const payloadEvents = (events.results ?? []).filter((event) => filters.length === 0 || filters.includes(String(event.action)));
      if (payloadEvents.length === 0) {
        await env.DB.prepare(`UPDATE siem_destinations SET last_success_at = ?, updated_at = ? WHERE id = ?`).bind(String((events.results ?? []).at(-1)?.created_at), new Date().toISOString(), String(destination.id)).run();
        continue;
      }
      const endpoint = await decryptSecret(String(destination.endpoint_cipher), String(destination.endpoint_iv), env.TOKEN_ENCRYPTION_KEY);
      const secret = await decryptSecret(String(destination.signing_secret_cipher), String(destination.signing_secret_iv), env.TOKEN_ENCRYPTION_KEY);
      const body = JSON.stringify({ schema: 'dealguard-audit-stream', version: 2, events: payloadEvents });
      const response = await fetch(endpoint, { method: 'POST', headers: { 'content-type': 'application/json', 'x-dealguard-signature': `v1=${await hmacBase64(secret, body)}` }, body });
      if (!response.ok) throw new Error(`SIEM returned HTTP ${response.status}`);
      await env.DB.prepare(`UPDATE siem_destinations SET last_success_at = ?, last_error = NULL, updated_at = ? WHERE id = ?`)
        .bind(String(payloadEvents.at(-1)?.created_at), new Date().toISOString(), String(destination.id)).run();
    } catch (error) {
      await env.DB.prepare(`UPDATE siem_destinations SET last_error = ?, updated_at = ? WHERE id = ?`)
        .bind((error instanceof Error ? error.message : String(error)).slice(0, 1000), new Date().toISOString(), String(destination.id)).run();
    }
  }
}

async function completeExportPayload(env: Env, portalId: string, scope: string): Promise<Record<string, unknown>> {
  const result: Record<string, unknown> = { schema: 'dealguard-data-export', version: 2, portalId, exportedAt: new Date().toISOString(), scope };
  if (scope === 'audit' || scope === 'complete') {
    const rows = await env.DB.prepare(`SELECT * FROM audit_events_v2 WHERE portal_id = ? ORDER BY sequence_number ASC`).bind(portalId).all<Record<string, unknown>>();
    result.audit = rows.results ?? [];
  }
  if (scope === 'configuration' || scope === 'complete') {
    const tables = ['tenants', 'policy_versions', 'policy_segments', 'enterprise_role_assignments', 'notification_channels', 'notification_routes', 'compliance_settings', 'service_slos'];
    const configuration: Record<string, unknown> = {};
    for (const table of tables) configuration[table] = (await env.DB.prepare(`SELECT * FROM ${table} WHERE portal_id = ?`).bind(portalId).all<Record<string, unknown>>()).results ?? [];
    result.configuration = configuration;
  }
  if (scope === 'operational' || scope === 'complete') {
    const tables = ['deal_assessments', 'assessment_history', 'remediation_cases', 'remediation_events', 'outbox_events', 'outbox_deliveries', 'service_health', 'operational_metrics', 'incidents'];
    const operational: Record<string, unknown> = {};
    for (const table of tables) operational[table] = (await env.DB.prepare(`SELECT * FROM ${table} WHERE portal_id = ?`).bind(portalId).all<Record<string, unknown>>()).results ?? [];
    result.operational = operational;
  }
  return result;
}

export async function createDataExport(env: Env, identity: RequestIdentity, value: unknown): Promise<Record<string, unknown>> {
  await requireEnterprisePermission(env, identity, 'data_export.manage');
  const input = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  const scopes = ['audit', 'configuration', 'operational', 'complete'];
  const formats = ['json', 'csv', 'jsonl'];
  const scope = scopes.includes(String(input.scope)) ? String(input.scope) : 'complete';
  const format = formats.includes(String(input.format)) ? String(input.format) : 'json';
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const expiresAt = new Date(Date.now() + 24 * 60 * 60_000).toISOString();
  await env.DB.prepare(
    `INSERT INTO data_export_jobs (id, portal_id, format, scope, status, requested_by_user_id, requested_by_email, created_at, expires_at)
     VALUES (?, ?, ?, ?, 'queued', ?, ?, ?, ?)`
  ).bind(id, identity.portalId, format, scope, identity.userId, identity.userEmail, now, expiresAt).run();
  try {
    await enqueueDataExport(env, identity.portalId, id);
  } catch (error) {
    await env.DB.prepare(`UPDATE data_export_jobs SET status = 'failed', error_message = ? WHERE portal_id = ? AND id = ?`)
      .bind((error instanceof Error ? error.message : String(error)).slice(0, 1000), identity.portalId, id).run();
    throw error;
  }
  await appendImmutableAudit(env, { portalId: identity.portalId, action: 'data_export.queued', resourceType: 'data_export', resourceId: id, actorUserId: identity.userId, actorEmail: identity.userEmail, metadata: { format, scope, expiresAt } });
  return { id, format, scope, status: 'queued', expiresAt, statusPath: `/api/v1/enterprise/compliance/exports/${id}` };
}

function renderExport(payload: Record<string, unknown>, format: string): { body: string; contentType: string; extension: string } {
  if (format === 'jsonl') return {
    body: Object.entries(payload).map(([type, value]) => JSON.stringify({ type, value })).join('\n'),
    contentType: 'application/x-ndjson; charset=utf-8',
    extension: 'jsonl',
  };
  if (format === 'csv') return {
    body: `section,data\\n${Object.entries(payload).map(([section, value]) => `${csv(section)},${csv(value)}`).join('\\n')}`,
    contentType: 'text/csv; charset=utf-8',
    extension: 'csv',
  };
  return { body: JSON.stringify(payload, null, 2), contentType: 'application/json; charset=utf-8', extension: 'json' };
}

export async function processDataExport(env: Env, portalId: string, exportId: string): Promise<void> {
  const claimed = await env.DB.prepare(
    `UPDATE data_export_jobs SET status = 'processing', error_message = NULL WHERE portal_id = ? AND id = ? AND status IN ('queued','failed')`
  ).bind(portalId, exportId).run();
  if (!Number(claimed.meta?.changes ?? 0)) {
    const existing = await env.DB.prepare(`SELECT status FROM data_export_jobs WHERE portal_id = ? AND id = ?`).bind(portalId, exportId).first<{ status: string }>();
    if (existing?.status === 'completed') return;
    throw new AppError(409, 'data_export_not_processable', 'The data export is already processing or does not exist.');
  }
  try {
    const job = await env.DB.prepare(`SELECT * FROM data_export_jobs WHERE portal_id = ? AND id = ?`).bind(portalId, exportId).first<Record<string, unknown>>();
    if (!job) throw new Error('Data export disappeared after it was claimed.');
    const payload = await completeExportPayload(env, portalId, String(job.scope));
    const rendered = renderExport(payload, String(job.format));
    const checksum = await sha256Hex(rendered.body);
    const key = tenantObjectKey(portalId, 'exports', exportId, `dealguard-${job.scope}.${rendered.extension}`);
    const stored = await putObject(env, { key, body: rendered.body, contentType: rendered.contentType, sha256: checksum });
    const now = new Date().toISOString();
    await env.DB.prepare(
      `UPDATE data_export_jobs SET status = 'completed', object_key = ?, checksum = ?, size_bytes = ?, content_type = ?, completed_at = ?, error_message = NULL WHERE portal_id = ? AND id = ?`
    ).bind(key, checksum, stored.sizeBytes, rendered.contentType, now, portalId, exportId).run();
    await env.DB.prepare(`UPDATE async_jobs SET status = 'completed', completed_at = ?, updated_at = ?, last_error = NULL WHERE id = ?`).bind(now, now, `export:${exportId}`).run();
    await appendImmutableAudit(env, { portalId, action: 'data_export.completed', resourceType: 'data_export', resourceId: exportId, source: 'queue', metadata: { format: job.format, scope: job.scope, checksum, objectKey: key, sizeBytes: stored.sizeBytes } });
  } catch (error) {
    const message = (error instanceof Error ? error.message : String(error)).slice(0, 1000);
    await env.DB.prepare(`UPDATE data_export_jobs SET status = 'failed', error_message = ? WHERE portal_id = ? AND id = ?`).bind(message, portalId, exportId).run();
    throw error;
  }
}

export async function dataExportStatus(env: Env, identity: RequestIdentity, exportId: string): Promise<Record<string, unknown>> {
  await requireEnterprisePermission(env, identity, 'data_export.manage');
  const job = await env.DB.prepare(`SELECT id, format, scope, status, checksum, size_bytes, content_type, created_at, completed_at, expires_at, error_message FROM data_export_jobs WHERE portal_id = ? AND id = ?`)
    .bind(identity.portalId, exportId).first<Record<string, unknown>>();
  if (!job) throw new AppError(404, 'data_export_not_found', 'The data export does not exist.');
  return { id: job.id, format: job.format, scope: job.scope, status: job.status, checksum: job.checksum, sizeBytes: job.size_bytes, contentType: job.content_type, createdAt: job.created_at, completedAt: job.completed_at, expiresAt: job.expires_at, error: job.error_message, ...(job.status === 'completed' ? { downloadPath: `/api/v1/enterprise/compliance/exports/${exportId}/download` } : {}) };
}

export async function downloadDataExport(env: Env, identity: RequestIdentity, exportId: string): Promise<Response> {
  await requireEnterprisePermission(env, identity, 'data_export.manage');
  const job = await env.DB.prepare(`SELECT * FROM data_export_jobs WHERE portal_id = ? AND id = ?`)
    .bind(identity.portalId, exportId).first<Record<string, unknown>>();
  if (!job) throw new AppError(404, 'data_export_not_found', 'The data export does not exist.');
  if (job.status !== 'completed' || !job.object_key) throw new AppError(409, 'data_export_not_ready', `The data export is ${String(job.status)}.`);
  if (job.expires_at && Date.parse(String(job.expires_at)) <= Date.now()) throw new AppError(410, 'data_export_expired', 'The data export has expired.');
  const filename = `dealguard-${String(job.scope)}-${identity.portalId}.${String(job.format)}`;
  const location = await createSignedObjectDownload(env, String(job.object_key), filename, 300);
  return new Response(null, { status: 302, headers: { location, 'cache-control': 'no-store', 'x-content-sha256': String(job.checksum ?? '') } });
}

export async function applyComplianceRetention(env: Env): Promise<void> {
  const settings = await env.DB.prepare(`SELECT * FROM compliance_settings WHERE legal_hold_enabled = 0 LIMIT 500`).all<Record<string, unknown>>();
  for (const row of settings.results ?? []) {
    const portalId = String(row.portal_id);
    const auditCutoff = new Date(Date.now() - Number(row.audit_retention_days) * 86400000).toISOString();
    const operationalCutoff = new Date(Date.now() - Number(row.operational_retention_days) * 86400000).toISOString();
    await env.DB.batch([
      env.DB.prepare(`DELETE FROM audit_events_v2 WHERE portal_id = ? AND created_at < ?`).bind(portalId, auditCutoff),
      env.DB.prepare(`DELETE FROM assessment_history WHERE portal_id = ? AND assessed_at < ?`).bind(portalId, operationalCutoff),
      env.DB.prepare(`DELETE FROM operational_metrics WHERE portal_id = ? AND recorded_at < ?`).bind(portalId, operationalCutoff),
      env.DB.prepare(`DELETE FROM alert_instances WHERE portal_id = ? AND created_at < ? AND status IN ('acknowledged','suppressed')`).bind(portalId, operationalCutoff),
    ]);
  }
}

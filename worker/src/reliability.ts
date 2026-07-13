import { getBillingStatus } from './billing.js';
import { requireEnterprisePermission } from './enterprise-access.js';
import { AppError } from './errors.js';
import { HubSpotClient } from './hubspot.js';
import { Repository } from './repository.js';
import type { Env, RequestIdentity } from './types.js';

export async function recordOperationalMetric(
  env: Env,
  input: { portalId?: string | null; service: string; metric: string; value: number; dimensions?: Record<string, unknown> },
): Promise<void> {
  if (!Number.isFinite(input.value)) return;
  await env.DB.prepare(`INSERT INTO operational_metrics (id, portal_id, service, metric, value, dimensions_json, recorded_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .bind(crypto.randomUUID(), input.portalId ?? null, input.service.slice(0, 100), input.metric.slice(0, 100), input.value, JSON.stringify(input.dimensions ?? {}), new Date().toISOString()).run();
}

export function exponentialBackoffWithJitter(attempt: number, baseMs = 1000, capMs = 3600000, random = Math.random): number {
  const boundedAttempt = Math.max(0, Math.min(20, Math.floor(attempt)));
  const exponential = Math.min(capMs, baseMs * 2 ** boundedAttempt);
  return Math.max(baseMs, Math.floor(exponential * (0.5 + random())));
}

export async function acquireJobLease(
  env: Env,
  jobKey: string,
  owner: string,
  ttlSeconds: number,
  metadata: Record<string, unknown> = {},
): Promise<boolean> {
  const now = new Date();
  const existing = await env.DB.prepare(`SELECT lease_owner, lease_expires_at FROM job_leases WHERE job_key = ?`)
    .bind(jobKey).first<{ lease_owner: string; lease_expires_at: string }>();
  if (existing && Date.parse(existing.lease_expires_at) > now.getTime() && existing.lease_owner !== owner) return false;
  const expires = new Date(now.getTime() + Math.max(30, ttlSeconds) * 1000).toISOString();
  await env.DB.prepare(
    `INSERT INTO job_leases (job_key, lease_owner, lease_expires_at, heartbeat_at, metadata_json)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(job_key) DO UPDATE SET lease_owner = excluded.lease_owner, lease_expires_at = excluded.lease_expires_at,
       heartbeat_at = excluded.heartbeat_at, metadata_json = excluded.metadata_json`
  ).bind(jobKey.slice(0, 255), owner.slice(0, 255), expires, now.toISOString(), JSON.stringify(metadata)).run();
  const acquired = await env.DB.prepare(`SELECT lease_owner FROM job_leases WHERE job_key = ?`).bind(jobKey).first<{ lease_owner: string }>();
  return acquired?.lease_owner === owner;
}

export async function heartbeatJobLease(env: Env, jobKey: string, owner: string, ttlSeconds: number): Promise<void> {
  const now = new Date();
  const result = await env.DB.prepare(`UPDATE job_leases SET heartbeat_at = ?, lease_expires_at = ? WHERE job_key = ? AND lease_owner = ?`)
    .bind(now.toISOString(), new Date(now.getTime() + Math.max(30, ttlSeconds) * 1000).toISOString(), jobKey, owner).run();
  if (!Number(result.meta?.changes ?? 0)) throw new AppError(409, 'job_lease_lost', 'The job processing lease is no longer owned by this worker.');
}

export async function releaseJobLease(env: Env, jobKey: string, owner: string): Promise<void> {
  await env.DB.prepare(`DELETE FROM job_leases WHERE job_key = ? AND lease_owner = ?`).bind(jobKey, owner).run();
}

export async function saveScanCheckpoint(
  env: Env,
  scanId: string,
  portalId: string,
  input: { cursor?: string | null; processedCount: number; lastDealId?: string | null; state?: Record<string, unknown>; leaseOwner?: string | null; leaseSeconds?: number },
): Promise<void> {
  const now = new Date();
  const leaseExpires = input.leaseOwner ? new Date(now.getTime() + Math.max(30, input.leaseSeconds ?? 300) * 1000).toISOString() : null;
  await env.DB.prepare(
    `INSERT INTO scan_checkpoints (scan_id, portal_id, cursor, processed_count, last_deal_id, state_json, lease_owner, lease_expires_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(scan_id) DO UPDATE SET cursor = excluded.cursor, processed_count = excluded.processed_count,
       last_deal_id = excluded.last_deal_id, state_json = excluded.state_json, lease_owner = excluded.lease_owner,
       lease_expires_at = excluded.lease_expires_at, updated_at = excluded.updated_at`
  ).bind(scanId, portalId, input.cursor ?? null, Math.max(0, input.processedCount), input.lastDealId ?? null, JSON.stringify(input.state ?? {}), input.leaseOwner ?? null, leaseExpires, now.toISOString()).run();
}

export async function getScanCheckpoint(env: Env, scanId: string, portalId: string): Promise<Record<string, unknown> | null> {
  const row = await env.DB.prepare(`SELECT * FROM scan_checkpoints WHERE scan_id = ? AND portal_id = ?`).bind(scanId, portalId).first<Record<string, unknown>>();
  return row ? {
    scanId: row.scan_id, portalId: row.portal_id, cursor: row.cursor, processedCount: Number(row.processed_count),
    lastDealId: row.last_deal_id, state: JSON.parse(String(row.state_json ?? '{}')), leaseOwner: row.lease_owner,
    leaseExpiresAt: row.lease_expires_at, updatedAt: row.updated_at,
  } : null;
}

export async function setServiceSlo(env: Env, identity: RequestIdentity, value: unknown): Promise<void> {
  await requireEnterprisePermission(env, identity, 'reliability.manage');
  const input = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  const service = typeof input.service === 'string' ? input.service.trim().slice(0, 100) : '';
  if (!service) throw new AppError(400, 'slo_service_required', 'A service name is required.');
  const availability = Math.min(100, Math.max(0, Number(input.availabilityTarget ?? 99.9) || 99.9));
  const success = input.successRateTarget === null ? null : Math.min(100, Math.max(0, Number(input.successRateTarget ?? 99) || 99));
  const latency = input.latencyP95MsTarget === null ? null : Math.max(1, Math.min(600000, Number(input.latencyP95MsTarget ?? 5000) || 5000));
  const windowDays = Math.min(365, Math.max(1, Number(input.windowDays ?? 30) || 30));
  await env.DB.prepare(
    `INSERT INTO service_slos (portal_id, service, availability_target, latency_p95_ms_target, success_rate_target, window_days, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(portal_id, service) DO UPDATE SET availability_target = excluded.availability_target,
       latency_p95_ms_target = excluded.latency_p95_ms_target, success_rate_target = excluded.success_rate_target,
       window_days = excluded.window_days, updated_at = excluded.updated_at`
  ).bind(identity.portalId, service, availability, latency, success, windowDays, new Date().toISOString()).run();
  await new Repository(env).audit(identity.portalId, identity.userId, identity.userEmail, 'reliability.slo_updated', { service, availability, latency, success, windowDays });
}

async function percentile(values: number[], p: number): Promise<number | null> {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
  return sorted[index] ?? null;
}

export async function reliabilityDashboard(env: Env, identity: RequestIdentity): Promise<Record<string, unknown>> {
  await requireEnterprisePermission(env, identity, 'reliability.view');
  const slos = await env.DB.prepare(`SELECT * FROM service_slos WHERE portal_id = ? ORDER BY service`).bind(identity.portalId).all<Record<string, unknown>>();
  const results: Array<Record<string, unknown>> = [];
  for (const slo of slos.results ?? []) {
    const since = new Date(Date.now() - Number(slo.window_days) * 86400000).toISOString();
    const metrics = await env.DB.prepare(`SELECT metric, value, recorded_at FROM operational_metrics WHERE (portal_id = ? OR portal_id IS NULL) AND service = ? AND recorded_at >= ?`)
      .bind(identity.portalId, String(slo.service), since).all<{ metric: string; value: number; recorded_at: string }>();
    const samples = metrics.results ?? [];
    const successSamples = samples.filter((item) => item.metric === 'success').map((item) => Number(item.value));
    const latencySamples = samples.filter((item) => item.metric === 'latency_ms').map((item) => Number(item.value));
    const availability = successSamples.length ? successSamples.reduce((sum, item) => sum + item, 0) / successSamples.length * 100 : null;
    const p95 = await percentile(latencySamples, 0.95);
    results.push({
      service: slo.service, windowDays: Number(slo.window_days),
      targets: { availability: Number(slo.availability_target), successRate: slo.success_rate_target === null ? null : Number(slo.success_rate_target), latencyP95Ms: slo.latency_p95_ms_target === null ? null : Number(slo.latency_p95_ms_target) },
      actual: { availability: availability === null ? null : Math.round(availability * 1000) / 1000, latencyP95Ms: p95, samples: samples.length },
      status: availability !== null && availability < Number(slo.availability_target) ? 'breached'
        : p95 !== null && slo.latency_p95_ms_target !== null && p95 > Number(slo.latency_p95_ms_target) ? 'breached'
        : samples.length ? 'meeting' : 'insufficient_data',
    });
  }
  const [health, incidents, synthetics, backups, restores] = await Promise.all([
    env.DB.prepare(`SELECT * FROM service_health WHERE portal_id = ? ORDER BY service`).bind(identity.portalId).all<Record<string, unknown>>(),
    env.DB.prepare(`SELECT * FROM incidents WHERE portal_id IS NULL OR portal_id = ? ORDER BY started_at DESC LIMIT 100`).bind(identity.portalId).all<Record<string, unknown>>(),
    env.DB.prepare(`SELECT * FROM synthetic_checks WHERE portal_id IS NULL OR portal_id = ? ORDER BY name`).bind(identity.portalId).all<Record<string, unknown>>(),
    env.DB.prepare(`SELECT * FROM backup_manifests ORDER BY started_at DESC LIMIT 50`).all<Record<string, unknown>>(),
    env.DB.prepare(`SELECT r.*, b.object_key, b.checksum FROM restore_tests r JOIN backup_manifests b ON b.id = r.backup_manifest_id ORDER BY r.started_at DESC LIMIT 50`).all<Record<string, unknown>>(),
  ]);
  return { slos: results, serviceHealth: health.results ?? [], incidents: incidents.results ?? [], syntheticChecks: synthetics.results ?? [], backups: backups.results ?? [], restoreTests: restores.results ?? [] };
}

export async function upsertSyntheticCheck(env: Env, identity: RequestIdentity, value: unknown, checkId: string | null = null): Promise<Record<string, unknown>> {
  await requireEnterprisePermission(env, identity, 'reliability.manage');
  const input = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  const types = ['health', 'oauth', 'hubspot_api', 'webhook', 'delivery', 'billing'];
  const checkType = types.includes(String(input.checkType)) ? String(input.checkType) : null;
  const name = typeof input.name === 'string' ? input.name.trim().slice(0, 120) : '';
  if (!checkType || !name) throw new AppError(400, 'synthetic_check_invalid', 'Synthetic check name and supported type are required.');
  const id = checkId ?? crypto.randomUUID();
  const now = new Date().toISOString();
  await env.DB.prepare(
    `INSERT INTO synthetic_checks (id, portal_id, name, check_type, target, enabled, interval_minutes, last_status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'unknown', ?, ?)
     ON CONFLICT(id) DO UPDATE SET name = excluded.name, check_type = excluded.check_type, target = excluded.target,
       enabled = excluded.enabled, interval_minutes = excluded.interval_minutes, updated_at = excluded.updated_at`
  ).bind(id, identity.portalId, name, checkType, typeof input.target === 'string' ? input.target.slice(0, 2000) : null, input.enabled === false ? 0 : 1, Math.min(1440, Math.max(5, Number(input.intervalMinutes ?? 15) || 15)), now, now).run();
  await new Repository(env).audit(identity.portalId, identity.userId, identity.userEmail, checkId ? 'reliability.synthetic_updated' : 'reliability.synthetic_created', { checkId: id, name, checkType });
  return { id, name, checkType, enabled: input.enabled !== false, updatedAt: now };
}

async function executeSynthetic(env: Env, row: Record<string, unknown>): Promise<{ status: 'passing' | 'failing'; latencyMs: number; error: string | null }> {
  const started = Date.now();
  try {
    const type = String(row.check_type);
    const portalId = row.portal_id ? String(row.portal_id) : null;
    if (type === 'health') {
      const target = row.target ? String(row.target) : `${env.APP_BASE_URL}/health`;
      const response = await fetch(target, { headers: { 'user-agent': 'DealGuard-Synthetic/2.0' } });
      if (!response.ok) throw new Error(`Health returned HTTP ${response.status}`);
    } else if (type === 'hubspot_api' || type === 'oauth') {
      if (!portalId) throw new Error('Portal is required for HubSpot synthetic check.');
      const client = await HubSpotClient.forPortal(env, portalId);
      await client.getPipelines();
    } else if (type === 'billing') {
      if (!portalId) throw new Error('Portal is required for billing synthetic check.');
      await getBillingStatus(env, portalId);
    } else if (type === 'webhook' || type === 'delivery') {
      const target = row.target ? String(row.target) : '';
      if (!target) throw new Error('Synthetic target is required.');
      const response = await fetch(target, { method: 'HEAD', headers: { 'user-agent': 'DealGuard-Synthetic/2.0' } });
      if (response.status >= 500) throw new Error(`Target returned HTTP ${response.status}`);
    }
    return { status: 'passing', latencyMs: Date.now() - started, error: null };
  } catch (error) {
    return { status: 'failing', latencyMs: Date.now() - started, error: (error instanceof Error ? error.message : String(error)).slice(0, 1000) };
  }
}

export async function runDueSyntheticChecks(env: Env): Promise<void> {
  const rows = await env.DB.prepare(
    `SELECT * FROM synthetic_checks WHERE enabled = 1 AND (last_checked_at IS NULL OR datetime(last_checked_at, '+' || interval_minutes || ' minutes') <= datetime('now')) LIMIT 100`
  ).all<Record<string, unknown>>();
  for (const row of rows.results ?? []) {
    const result = await executeSynthetic(env, row);
    const now = new Date().toISOString();
    await env.DB.prepare(`UPDATE synthetic_checks SET last_status = ?, last_checked_at = ?, last_latency_ms = ?, last_error = ?, updated_at = ? WHERE id = ?`)
      .bind(result.status, now, result.latencyMs, result.error, now, String(row.id)).run();
    await recordOperationalMetric(env, { portalId: row.portal_id ? String(row.portal_id) : null, service: `synthetic.${row.check_type}`, metric: 'success', value: result.status === 'passing' ? 1 : 0 });
    await recordOperationalMetric(env, { portalId: row.portal_id ? String(row.portal_id) : null, service: `synthetic.${row.check_type}`, metric: 'latency_ms', value: result.latencyMs });
  }
}

export async function createIncident(env: Env, identity: RequestIdentity, value: unknown): Promise<Record<string, unknown>> {
  await requireEnterprisePermission(env, identity, 'reliability.manage');
  const input = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  const title = typeof input.title === 'string' ? input.title.trim().slice(0, 255) : '';
  const severity = ['minor', 'major', 'critical'].includes(String(input.severity)) ? String(input.severity) : 'minor';
  if (!title) throw new AppError(400, 'incident_title_required', 'An incident title is required.');
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  await env.DB.prepare(
    `INSERT INTO incidents (id, portal_id, title, severity, status, affected_services_json, public_message, internal_notes, started_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'investigating', ?, ?, ?, ?, ?, ?)`
  ).bind(id, input.global === true ? null : identity.portalId, title, severity, JSON.stringify(Array.isArray(input.affectedServices) ? input.affectedServices.slice(0, 100) : []), typeof input.publicMessage === 'string' ? input.publicMessage.slice(0, 4000) : '', typeof input.internalNotes === 'string' ? input.internalNotes.slice(0, 8000) : '', now, now, now).run();
  await new Repository(env).audit(identity.portalId, identity.userId, identity.userEmail, 'reliability.incident_created', { incidentId: id, title, severity });
  return { id, title, severity, status: 'investigating', startedAt: now };
}

export async function updateIncident(env: Env, identity: RequestIdentity, incidentId: string, value: unknown): Promise<void> {
  await requireEnterprisePermission(env, identity, 'reliability.manage');
  const input = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  const current = await env.DB.prepare(`SELECT * FROM incidents WHERE id = ? AND (portal_id IS NULL OR portal_id = ?)`).bind(incidentId, identity.portalId).first<Record<string, unknown>>();
  if (!current) throw new AppError(404, 'incident_not_found', 'The incident does not exist.');
  const statuses = ['investigating', 'identified', 'monitoring', 'resolved'];
  const status = statuses.includes(String(input.status)) ? String(input.status) : String(current.status);
  const now = new Date().toISOString();
  await env.DB.prepare(
    `UPDATE incidents SET status = ?, public_message = ?, internal_notes = ?,
     identified_at = CASE WHEN ? = 'identified' AND identified_at IS NULL THEN ? ELSE identified_at END,
     resolved_at = CASE WHEN ? = 'resolved' THEN ? ELSE resolved_at END, updated_at = ? WHERE id = ?`
  ).bind(status, typeof input.publicMessage === 'string' ? input.publicMessage.slice(0, 4000) : current.public_message, typeof input.internalNotes === 'string' ? input.internalNotes.slice(0, 8000) : current.internal_notes, status, now, status, now, now, incidentId).run();
  await new Repository(env).audit(identity.portalId, identity.userId, identity.userEmail, 'reliability.incident_updated', { incidentId, status });
}

export async function publicStatus(env: Env): Promise<Record<string, unknown>> {
  const incidents = await env.DB.prepare(`SELECT id, title, severity, status, affected_services_json, public_message, started_at, identified_at, resolved_at, updated_at FROM incidents WHERE portal_id IS NULL AND (status != 'resolved' OR resolved_at >= ?) ORDER BY started_at DESC LIMIT 100`)
    .bind(new Date(Date.now() - 90 * 86400000).toISOString()).all<Record<string, unknown>>();
  const synthetics = await env.DB.prepare(`SELECT check_type, last_status, last_checked_at FROM synthetic_checks WHERE portal_id IS NULL AND enabled = 1`).all<Record<string, unknown>>();
  const current = (incidents.results ?? []).some((item) => item.status !== 'resolved' && item.severity === 'critical') ? 'major_outage'
    : (incidents.results ?? []).some((item) => item.status !== 'resolved') ? 'degraded'
    : (synthetics.results ?? []).some((item) => item.last_status === 'failing') ? 'degraded'
    : 'operational';
  return {
    status: current,
    updatedAt: new Date().toISOString(),
    components: (synthetics.results ?? []).map((row) => ({ name: row.check_type, status: row.last_status ?? 'unknown', checkedAt: row.last_checked_at })),
    incidents: (incidents.results ?? []).map((row) => ({ id: row.id, title: row.title, severity: row.severity, status: row.status, affectedServices: JSON.parse(String(row.affected_services_json)), message: row.public_message, startedAt: row.started_at, identifiedAt: row.identified_at, resolvedAt: row.resolved_at, updatedAt: row.updated_at })),
  };
}

export async function registerBackupManifest(env: Env, identity: RequestIdentity, value: unknown): Promise<Record<string, unknown>> {
  await requireEnterprisePermission(env, identity, 'reliability.manage');
  const input = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  const objectKey = typeof input.objectKey === 'string' ? input.objectKey.trim().slice(0, 1000) : '';
  const checksum = typeof input.checksum === 'string' ? input.checksum.trim().slice(0, 256) : '';
  if (!objectKey || !checksum) throw new AppError(400, 'backup_manifest_invalid', 'A backup object key and checksum from the deployment backup job are required.');
  const type = ['scheduled', 'manual', 'pre_migration'].includes(String(input.backupType)) ? String(input.backupType) : 'manual';
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  await env.DB.prepare(
    `INSERT INTO backup_manifests (id, backup_type, status, object_key, checksum, database_version, started_at, completed_at)
     VALUES (?, ?, 'completed', ?, ?, ?, ?, ?)`
  ).bind(id, type, objectKey, checksum, typeof input.databaseVersion === 'string' ? input.databaseVersion.slice(0, 100) : null, now, now).run();
  await new Repository(env).audit(identity.portalId, identity.userId, identity.userEmail, 'reliability.backup_registered', { backupManifestId: id, type, objectKey, checksum });
  return { id, type, objectKey, checksum, status: 'completed', completedAt: now };
}

export async function recordRestoreTest(env: Env, identity: RequestIdentity, value: unknown): Promise<Record<string, unknown>> {
  await requireEnterprisePermission(env, identity, 'reliability.manage');
  const input = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  const backupId = typeof input.backupManifestId === 'string' ? input.backupManifestId : '';
  const backup = await env.DB.prepare(`SELECT id, checksum FROM backup_manifests WHERE id = ? AND status = 'completed'`).bind(backupId).first<{ id: string; checksum: string }>();
  if (!backup) throw new AppError(404, 'backup_manifest_not_found', 'The completed backup manifest does not exist.');
  const validation = input.validation && typeof input.validation === 'object' ? input.validation as Record<string, unknown> : {};
  const required = ['schemaMigrationsApplied', 'tenantCountMatched', 'assessmentCountMatched', 'auditChainValid'];
  const passed = required.every((key) => validation[key] === true) && (typeof input.restoredChecksum !== 'string' || input.restoredChecksum === backup.checksum);
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  await env.DB.prepare(
    `INSERT INTO restore_tests (id, backup_manifest_id, status, validation_json, started_at, completed_at, error_message)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).bind(id, backupId, passed ? 'passed' : 'failed', JSON.stringify({ ...validation, restoredChecksum: input.restoredChecksum ?? null }), now, now, passed ? null : 'One or more restore validation controls failed.').run();
  await new Repository(env).audit(identity.portalId, identity.userId, identity.userEmail, 'reliability.restore_test_recorded', { restoreTestId: id, backupId, passed, validation });
  return { id, backupId, status: passed ? 'passed' : 'failed', validation, completedAt: now };
}

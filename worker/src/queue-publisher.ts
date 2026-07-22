import type { DealGuardQueueMessage, Env } from './types.js';

export async function enqueueScan(
  env: Env,
  input: { portalId: string; trigger: 'manual' | 'scheduled' | 'install'; scanId: string },
): Promise<void> {
  const now = new Date().toISOString();
  const jobId = `scan:${input.scanId}`;
  await env.DB.prepare(
    `INSERT INTO async_jobs (id, portal_id, job_type, idempotency_key, status, payload_json, available_at, created_at, updated_at)
     VALUES (?, ?, 'scan', ?, 'queued', ?, ?, ?, ?) ON CONFLICT(job_type, idempotency_key) DO NOTHING`
  ).bind(jobId, input.portalId, input.scanId, JSON.stringify(input), now, now, now).run();
  await env.SCAN_QUEUE.send({ version: 1, kind: 'scan', ...input, requestedAt: now });
}

export async function enqueueDataExport(env: Env, portalId: string, exportId: string): Promise<void> {
  const now = new Date().toISOString();
  await env.DB.prepare(
    `INSERT INTO async_jobs (id, portal_id, job_type, idempotency_key, status, payload_json, available_at, created_at, updated_at)
     VALUES (?, ?, 'data_export', ?, 'queued', ?, ?, ?, ?) ON CONFLICT(job_type, idempotency_key) DO NOTHING`
  ).bind(`export:${exportId}`, portalId, exportId, JSON.stringify({ exportId }), now, now, now).run();
  await env.DELIVERY_QUEUE.send({ version: 1, kind: 'delivery', task: 'data_export', resourceId: exportId, portalId, requestedAt: now });
}

export async function wakeDeliveryQueue(env: Env, task: Exclude<Extract<DealGuardQueueMessage, { kind: 'delivery' }>['task'], 'data_export'>): Promise<void> {
  await env.DELIVERY_QUEUE.send({ version: 1, kind: 'delivery', task, requestedAt: new Date().toISOString() });
}

export async function wakeMaintenanceQueue(env: Env, task: Extract<DealGuardQueueMessage, { kind: 'maintenance' }>['task']): Promise<void> {
  await env.MAINTENANCE_QUEUE.send({ version: 1, kind: 'maintenance', task, requestedAt: new Date().toISOString() });
}

import { sha256Hex } from './crypto.js';
import type { Env } from './types.js';

export interface AuditChainInput {
  portalId: string;
  action: string;
  resourceType?: string | null;
  resourceId?: string | null;
  actorUserId?: string | null;
  actorEmail?: string | null;
  source?: string;
  requestId?: string | null;
  ip?: string | null;
  userAgent?: string | null;
  before?: unknown;
  after?: unknown;
  metadata?: unknown;
}

export function canonicalAuditValue(value: unknown): string {
  if (value === undefined) return 'null';
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalAuditValue).join(',')}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${canonicalAuditValue(object[key])}`).join(',')}}`;
}

function isSequenceConflict(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes('UNIQUE constraint failed') || message.includes('SQLITE_CONSTRAINT');
}

export async function appendAuditChainEvent(env: Env, input: AuditChainInput): Promise<string> {
  const ipHash = input.ip ? await sha256Hex(input.ip) : null;
  const userAgentHash = input.userAgent ? await sha256Hex(input.userAgent) : null;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const tail = await env.DB.prepare(`SELECT sequence_number, event_hash FROM audit_events_v2 WHERE portal_id = ? ORDER BY sequence_number DESC LIMIT 1`)
      .bind(input.portalId).first<{ sequence_number: number; event_hash: string }>();
    const sequence = Number(tail?.sequence_number ?? 0) + 1;
    const id = crypto.randomUUID();
    const createdAt = new Date().toISOString();
    const previousHash = tail?.event_hash ?? null;
    const canonical = canonicalAuditValue({
      id,
      portalId: input.portalId,
      sequence,
      action: input.action,
      resourceType: input.resourceType ?? null,
      resourceId: input.resourceId ?? null,
      actorUserId: input.actorUserId ?? null,
      actorEmail: input.actorEmail ?? null,
      source: input.source ?? 'application',
      requestId: input.requestId ?? null,
      ipHash,
      userAgentHash,
      before: input.before ?? null,
      after: input.after ?? null,
      metadata: input.metadata ?? {},
      previousHash,
      createdAt,
    });
    const eventHash = await sha256Hex(canonical);
    try {
      await env.DB.prepare(
        `INSERT INTO audit_events_v2 (
          id, portal_id, sequence_number, action, resource_type, resource_id, actor_user_id, actor_email,
          source, request_id, ip_hash, user_agent_hash, before_json, after_json, metadata_json,
          previous_hash, event_hash, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).bind(
        id,
        input.portalId,
        sequence,
        input.action.slice(0, 160),
        input.resourceType?.slice(0, 100) ?? null,
        input.resourceId?.slice(0, 255) ?? null,
        input.actorUserId ?? null,
        input.actorEmail ?? null,
        (input.source ?? 'application').slice(0, 80),
        input.requestId ?? null,
        ipHash,
        userAgentHash,
        input.before === undefined ? null : JSON.stringify(input.before),
        input.after === undefined ? null : JSON.stringify(input.after),
        JSON.stringify(input.metadata ?? {}),
        previousHash,
        eventHash,
        createdAt,
      ).run();
      return id;
    } catch (error) {
      if (!isSequenceConflict(error) || attempt === 7) throw error;
      await new Promise((resolve) => setTimeout(resolve, 4 * (attempt + 1)));
    }
  }
  throw new Error('Audit chain event could not be appended.');
}

export async function promoteLegacyAuditEvents(env: Env, limit = 500): Promise<number> {
  const rows = await env.DB.prepare(
    `SELECT a.id, a.portal_id, a.user_id, a.user_email, a.action, a.metadata_json, a.created_at
     FROM audit_events a
     LEFT JOIN legacy_audit_promotions p ON p.legacy_event_id = a.id
     WHERE p.legacy_event_id IS NULL
     ORDER BY a.created_at ASC, a.id ASC LIMIT ?`
  ).bind(Math.min(2000, Math.max(1, limit))).all<{
    id: string;
    portal_id: string;
    user_id: string | null;
    user_email: string | null;
    action: string;
    metadata_json: string;
    created_at: string;
  }>();
  let promoted = 0;
  for (const row of rows.results ?? []) {
    const immutableId = await appendAuditChainEvent(env, {
      portalId: row.portal_id,
      action: row.action,
      actorUserId: row.user_id,
      actorEmail: row.user_email,
      source: 'legacy_audit_promotion',
      metadata: { ...JSON.parse(row.metadata_json || '{}'), legacyEventId: row.id, legacyCreatedAt: row.created_at },
    });
    await env.DB.prepare(`INSERT INTO legacy_audit_promotions (legacy_event_id, immutable_event_id, promoted_at) VALUES (?, ?, ?) ON CONFLICT(legacy_event_id) DO NOTHING`)
      .bind(row.id, immutableId, new Date().toISOString()).run();
    promoted += 1;
  }
  return promoted;
}

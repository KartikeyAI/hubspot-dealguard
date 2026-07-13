import { requireGovernancePermission } from './governance.js';
import type { Env, RequestIdentity } from './types.js';

export interface AuditEventView {
  id: string;
  action: string;
  userId: string | null;
  userEmail: string | null;
  metadata: unknown;
  createdAt: string;
}

function limitValue(value: string | null): number {
  const parsed = Number(value ?? 100);
  return Number.isInteger(parsed) ? Math.min(500, Math.max(1, parsed)) : 100;
}

export async function searchAuditEvents(env: Env, identity: RequestIdentity, url: URL): Promise<AuditEventView[]> {
  await requireGovernancePermission(env, identity, 'audit.view');
  const action = url.searchParams.get('action')?.trim().slice(0, 100) ?? '';
  const cursor = url.searchParams.get('before')?.trim() ?? '';
  const query = `SELECT id, action, user_id, user_email, metadata_json, created_at FROM audit_events
    WHERE portal_id = ?
      AND (? = '' OR action = ?)
      AND (? = '' OR created_at < ?)
    ORDER BY created_at DESC LIMIT ?`;
  const rows = await env.DB.prepare(query).bind(identity.portalId, action, action, cursor, cursor, limitValue(url.searchParams.get('limit'))).all<Record<string, unknown>>();
  return (rows.results ?? []).map((row) => ({
    id: String(row.id),
    action: String(row.action),
    userId: row.user_id ? String(row.user_id) : null,
    userEmail: row.user_email ? String(row.user_email) : null,
    metadata: JSON.parse(String(row.metadata_json ?? '{}')) as unknown,
    createdAt: String(row.created_at),
  }));
}

function csvCell(value: unknown): string {
  const text = typeof value === 'string' ? value : JSON.stringify(value ?? '');
  return `"${text.replaceAll('"', '""')}"`;
}

export async function exportAuditCsv(env: Env, identity: RequestIdentity): Promise<Response> {
  await requireGovernancePermission(env, identity, 'audit.export');
  const rows = await env.DB.prepare(`SELECT id, action, user_id, user_email, metadata_json, created_at FROM audit_events WHERE portal_id = ? ORDER BY created_at DESC LIMIT 10000`)
    .bind(identity.portalId).all<Record<string, unknown>>();
  const lines = ['id,action,user_id,user_email,metadata,created_at'];
  for (const row of rows.results ?? []) {
    lines.push([
      row.id,
      row.action,
      row.user_id ?? '',
      row.user_email ?? '',
      JSON.parse(String(row.metadata_json ?? '{}')),
      row.created_at,
    ].map(csvCell).join(','));
  }
  return new Response(lines.join('\n'), {
    headers: {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': `attachment; filename="dealguard-audit-${identity.portalId}.csv"`,
      'cache-control': 'no-store',
    },
  });
}

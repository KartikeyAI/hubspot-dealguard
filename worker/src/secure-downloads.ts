import { randomToken, sha256Hex } from './crypto.js';
import { requireEnterprisePermission } from './enterprise-access.js';
import { exportAnalyticsCsv } from './enterprise-analytics-v2.js';
import { exportPolicyPackage } from './enterprise-policy.js';
import { AppError } from './errors.js';
import { downloadDataExport, exportImmutableAudit } from './compliance.js';
import type { Env, RequestIdentity } from './types.js';

export type SecureDownloadKind = 'policy' | 'analytics' | 'audit' | 'data_export';

interface TokenRow {
  token_hash: string;
  portal_id: string;
  kind: SecureDownloadKind;
  resource_id: string | null;
  format: string | null;
  params_json: string;
  requested_by_user_id: string | null;
  requested_by_email: string | null;
  expires_at: string;
  used_at: string | null;
}

const PERMISSION_BY_KIND: Record<SecureDownloadKind, string> = {
  policy: 'policy.export',
  analytics: 'analytics.export',
  audit: 'audit.export',
  data_export: 'data_export.manage',
};

function sanitizeParams(value: unknown): Record<string, string> {
  const input = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  const allowed = ['days', 'audience', 'pipelineId', 'stageId', 'ownerId', 'teamId', 'regionCode', 'action', 'resourceType', 'actorEmail', 'source', 'from', 'to', 'format'];
  const result: Record<string, string> = {};
  for (const key of allowed) {
    const item = input[key];
    if (typeof item === 'string' || typeof item === 'number') result[key] = String(item).slice(0, 512);
  }
  return result;
}

export async function createSecureDownload(
  env: Env,
  identity: RequestIdentity,
  value: unknown,
): Promise<{ url: string; expiresAt: string }> {
  const input = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  const kind = ['policy', 'analytics', 'audit', 'data_export'].includes(String(input.kind))
    ? String(input.kind) as SecureDownloadKind
    : null;
  if (!kind) throw new AppError(400, 'secure_download_kind_invalid', 'Choose a supported export type.');
  await requireEnterprisePermission(env, identity, PERMISSION_BY_KIND[kind]);
  const resourceId = typeof input.resourceId === 'string' && input.resourceId.trim() ? input.resourceId.trim().slice(0, 255) : null;
  if ((kind === 'policy' || kind === 'data_export') && !resourceId) {
    throw new AppError(400, 'secure_download_resource_required', 'This export requires a resource ID.');
  }
  const format = typeof input.format === 'string' ? input.format.slice(0, 20) : null;
  const params = sanitizeParams(input.params);
  if (format) params.format = format;
  const token = randomToken();
  const tokenHash = await sha256Hex(token);
  const now = new Date();
  const expiresAt = new Date(now.getTime() + 10 * 60_000).toISOString();
  await env.DB.prepare(
    `INSERT INTO secure_download_tokens (
      token_hash, portal_id, kind, resource_id, format, params_json,
      requested_by_user_id, requested_by_email, expires_at, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(tokenHash, identity.portalId, kind, resourceId, format, JSON.stringify(params), identity.userId, identity.userEmail, expiresAt, now.toISOString()).run();
  return { url: `${env.APP_BASE_URL}/downloads/${encodeURIComponent(token)}`, expiresAt };
}

export async function consumeSecureDownload(env: Env, token: string): Promise<Response> {
  if (!token || token.length < 32 || token.length > 1024) throw new AppError(404, 'secure_download_not_found', 'The secure download does not exist.');
  const tokenHash = await sha256Hex(token);
  const row = await env.DB.prepare(`SELECT * FROM secure_download_tokens WHERE token_hash = ?`).bind(tokenHash).first<TokenRow>();
  if (!row || row.used_at || Date.parse(row.expires_at) <= Date.now()) {
    throw new AppError(410, 'secure_download_expired', 'The secure download is invalid, expired, or already used.');
  }
  const usedAt = new Date().toISOString();
  const claimed = await env.DB.prepare(
    `UPDATE secure_download_tokens SET used_at = ? WHERE token_hash = ? AND used_at IS NULL AND expires_at > ?`
  ).bind(usedAt, tokenHash, usedAt).run();
  if (!Number(claimed.meta?.changes ?? 0)) throw new AppError(410, 'secure_download_expired', 'The secure download is invalid, expired, or already used.');

  const identity: RequestIdentity = {
    portalId: row.portal_id,
    userId: row.requested_by_user_id,
    userEmail: row.requested_by_email,
    appId: null,
  };
  const params = JSON.parse(row.params_json || '{}') as Record<string, string>;
  const url = new URL(`${env.APP_BASE_URL}/internal/secure-download`);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  if (row.format) url.searchParams.set('format', row.format);

  if (row.kind === 'policy') return exportPolicyPackage(env, identity, row.resource_id!);
  if (row.kind === 'analytics') return exportAnalyticsCsv(env, identity, url);
  if (row.kind === 'audit') return exportImmutableAudit(env, identity, url);
  if (row.kind === 'data_export') return downloadDataExport(env, identity, row.resource_id!);
  throw new AppError(400, 'secure_download_kind_invalid', 'The secure download type is unsupported.');
}

export async function deleteExpiredSecureDownloads(env: Env): Promise<void> {
  await env.DB.prepare(`DELETE FROM secure_download_tokens WHERE expires_at < ? OR used_at IS NOT NULL`).bind(new Date(Date.now() - 24 * 60 * 60_000).toISOString()).run();
}

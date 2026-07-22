import { requireEnterprisePermission } from './enterprise-access.js';
import { AppError } from './errors.js';
import { createSignedObjectDownload, createSignedObjectUpload, headObject, tenantObjectKey } from './object-storage.js';
import { Repository } from './repository.js';
import type { Env, RequestIdentity } from './types.js';

const ALLOWED_CONTENT_TYPES = new Set([
  'application/pdf', 'application/json', 'text/plain', 'text/csv',
  'image/png', 'image/jpeg', 'image/webp',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
]);
const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;

type ResourceType = 'remediation_evidence' | 'policy_exception_evidence';

function input(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? value as Record<string, unknown> : {};
}

async function requireResource(env: Env, identity: RequestIdentity, resourceType: ResourceType, resourceId: string): Promise<void> {
  if (resourceType === 'remediation_evidence') {
    await requireEnterprisePermission(env, identity, 'remediation.evidence');
    const row = await env.DB.prepare(`SELECT id FROM remediation_cases WHERE portal_id = ? AND id = ?`).bind(identity.portalId, resourceId).first();
    if (!row) throw new AppError(404, 'remediation_case_not_found', 'The remediation case does not exist.');
    return;
  }
  await requireEnterprisePermission(env, identity, 'exception.manage');
  const row = await env.DB.prepare(`SELECT id FROM policy_exceptions WHERE portal_id = ? AND id = ?`).bind(identity.portalId, resourceId).first();
  if (!row) throw new AppError(404, 'policy_exception_not_found', 'The policy exception does not exist.');
}

export async function createAttachmentUpload(env: Env, identity: RequestIdentity, value: unknown): Promise<Record<string, unknown>> {
  const body = input(value);
  const resourceType = body.resourceType === 'policy_exception_evidence' ? 'policy_exception_evidence' : body.resourceType === 'remediation_evidence' ? 'remediation_evidence' : null;
  const resourceId = typeof body.resourceId === 'string' ? body.resourceId.trim().slice(0, 128) : '';
  const filename = typeof body.filename === 'string' ? body.filename.trim().slice(0, 255) : '';
  const contentType = typeof body.contentType === 'string' ? body.contentType.trim().toLowerCase() : '';
  const sizeBytes = Number(body.sizeBytes ?? 0);
  const sha256 = typeof body.sha256 === 'string' ? body.sha256.trim().toLowerCase() : '';
  if (!resourceType || !resourceId || !filename) throw new AppError(400, 'attachment_fields_required', 'Resource type, resource ID and filename are required.');
  if (!ALLOWED_CONTENT_TYPES.has(contentType)) throw new AppError(400, 'attachment_content_type_invalid', 'This attachment content type is not supported.');
  if (!Number.isInteger(sizeBytes) || sizeBytes < 1 || sizeBytes > MAX_ATTACHMENT_BYTES) throw new AppError(400, 'attachment_size_invalid', 'Attachments must be between 1 byte and 25 MB.');
  if (!/^[0-9a-f]{64}$/.test(sha256)) throw new AppError(400, 'attachment_checksum_invalid', 'Provide the lowercase SHA-256 checksum for the attachment.');
  await requireResource(env, identity, resourceType, resourceId);

  const id = crypto.randomUUID();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + 10 * 60_000).toISOString();
  const key = tenantObjectKey(identity.portalId, resourceType, id, filename);
  await env.DB.prepare(
    `INSERT INTO object_uploads (id, portal_id, resource_type, resource_id, object_key, filename, content_type, expected_size_bytes, expected_sha256, status, requested_by_user_id, requested_by_email, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?)`
  ).bind(id, identity.portalId, resourceType, resourceId, key, filename, contentType, sizeBytes, sha256, identity.userId, identity.userEmail, now.toISOString(), expiresAt).run();
  const uploadUrl = await createSignedObjectUpload(env, { key, contentType, contentLength: sizeBytes, sha256, expiresSeconds: 600 });
  await new Repository(env).audit(identity.portalId, identity.userId, identity.userEmail, 'object_upload.created', { uploadId: id, resourceType, resourceId, filename, contentType, sizeBytes, sha256 });
  return { id, uploadUrl, method: 'PUT', objectKey: key, contentType, sizeBytes, sha256, expiresAt };
}

export async function completeAttachmentUpload(env: Env, identity: RequestIdentity, uploadId: string): Promise<Record<string, unknown>> {
  const upload = await env.DB.prepare(`SELECT * FROM object_uploads WHERE portal_id = ? AND id = ?`).bind(identity.portalId, uploadId).first<Record<string, unknown>>();
  if (!upload) throw new AppError(404, 'object_upload_not_found', 'The attachment upload does not exist.');
  const resourceType = String(upload.resource_type) as ResourceType;
  const resourceId = String(upload.resource_id);
  await requireResource(env, identity, resourceType, resourceId);
  if (upload.status === 'completed') return { id: uploadId, status: 'completed', objectKey: upload.object_key };
  if (Date.parse(String(upload.expires_at)) <= Date.now()) {
    await env.DB.prepare(`UPDATE object_uploads SET status = 'expired' WHERE portal_id = ? AND id = ?`).bind(identity.portalId, uploadId).run();
    throw new AppError(410, 'object_upload_expired', 'The attachment upload has expired.');
  }
  const object = await headObject(env, String(upload.object_key));
  if (object.contentLength !== Number(upload.expected_size_bytes)) throw new AppError(409, 'object_upload_size_mismatch', 'The uploaded attachment size does not match the reserved upload.');
  if (object.sha256 !== String(upload.expected_sha256)) throw new AppError(409, 'object_upload_checksum_mismatch', 'The uploaded attachment checksum does not match the reserved upload.');
  if (object.contentType !== String(upload.content_type)) throw new AppError(409, 'object_upload_content_type_mismatch', 'The uploaded attachment content type does not match the reserved upload.');

  const now = new Date().toISOString();
  const evidenceId = crypto.randomUUID();
  const common = [evidenceId, identity.portalId, resourceId, 'object', String(upload.filename), String(upload.object_key), String(upload.expected_sha256), uploadId, String(upload.object_key), String(upload.content_type), Number(upload.expected_size_bytes), object.etag, identity.userId, identity.userEmail, now];
  if (resourceType === 'remediation_evidence') {
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO remediation_evidence (id, portal_id, case_id, evidence_type, label, value, content_hash, object_upload_id, object_key, content_type, size_bytes, object_etag, submitted_by_user_id, submitted_by_email, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(...common),
      env.DB.prepare(`UPDATE remediation_cases SET evidence_status = 'submitted', updated_at = ? WHERE portal_id = ? AND id = ?`).bind(now, identity.portalId, resourceId),
      env.DB.prepare(`UPDATE object_uploads SET status = 'completed', object_etag = ?, completed_at = ? WHERE portal_id = ? AND id = ?`).bind(object.etag, now, identity.portalId, uploadId),
      env.DB.prepare(`INSERT INTO remediation_events (id, portal_id, case_id, action, actor_user_id, actor_email, metadata_json, created_at) VALUES (?, ?, ?, 'evidence_submitted', ?, ?, ?, ?)`).bind(crypto.randomUUID(), identity.portalId, resourceId, identity.userId, identity.userEmail, JSON.stringify({ evidenceId, uploadId, type: 'object' }), now),
    ]);
  } else {
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO policy_exception_evidence (id, portal_id, exception_id, evidence_type, label, value, content_hash, object_upload_id, object_key, content_type, size_bytes, object_etag, created_by_user_id, created_by_email, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(...common),
      env.DB.prepare(`UPDATE object_uploads SET status = 'completed', object_etag = ?, completed_at = ? WHERE portal_id = ? AND id = ?`).bind(object.etag, now, identity.portalId, uploadId),
    ]);
  }
  await new Repository(env).audit(identity.portalId, identity.userId, identity.userEmail, 'object_upload.completed', { uploadId, evidenceId, resourceType, resourceId, objectKey: upload.object_key, etag: object.etag });
  return { id: uploadId, status: 'completed', evidenceId, objectKey: upload.object_key, etag: object.etag };
}

export async function attachmentDownloadUrl(env: Env, identity: RequestIdentity, uploadId: string): Promise<Record<string, unknown>> {
  const upload = await env.DB.prepare(`SELECT * FROM object_uploads WHERE portal_id = ? AND id = ? AND status = 'completed'`).bind(identity.portalId, uploadId).first<Record<string, unknown>>();
  if (!upload) throw new AppError(404, 'object_upload_not_found', 'The completed attachment does not exist.');
  await requireResource(env, identity, String(upload.resource_type) as ResourceType, String(upload.resource_id));
  return {
    url: await createSignedObjectDownload(env, String(upload.object_key), String(upload.filename), 300),
    expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
  };
}

import { decryptSecret, encryptSecret, sha256Hex } from './crypto.js';
import { AppError } from './errors.js';
import {
  permissionMatches,
  requireEnterprisePermission,
  type EnterpriseAccessContext,
} from './enterprise-access.js';
import {
  analyticsScopeFilter,
  mapRecommendation,
  RECOMMENDATION_SELECT,
  recommendationById,
  type RecommendationRow,
} from './recommendation-outcome-storage.js';
import type { RecommendationInstance } from './recommendation-outcome-types.js';
import {
  deliveryBatchStatus,
  followUpEligibility,
  normalizeRecipientEmails,
  safeManagerNote,
  safeRouteName,
} from './recommendation-operations-model.js';
import type {
  FollowUpBatchStatus,
  FollowUpBatchSummary,
  FollowUpCandidate,
  FollowUpCandidatesResponse,
  FollowUpPreviewItem,
  FollowUpPreviewResponse,
} from './recommendation-operations-types.js';
import { Repository } from './repository.js';
import type { Env, RequestIdentity } from './types.js';

const PREVIEW_TTL_MS = 15 * 60_000;
const BATCH_RETENTION_MS = 180 * 86_400_000;
const CANDIDATE_LIMIT = 100;
const MAX_RECOMMENDATIONS = 25;
const MAX_RECIPIENTS = 10;

interface FollowUpBatchRow extends Record<string, unknown> {
  id: string;
  portal_id: string;
  channel: 'email';
  route_name: string;
  status: FollowUpBatchStatus;
  requested_count: number;
  eligible_count: number;
  skipped_count: number;
  recipient_count: number;
  delivery_success_count: number;
  delivery_failure_count: number;
  confirmation_token_hash: string;
  payload_cipher: string | null;
  payload_iv: string | null;
  expires_at: string;
  created_by_user_id: string | null;
  created_by_email: string | null;
  created_at: string;
  confirmed_at: string | null;
  completed_at: string | null;
}

interface FollowUpItemRow extends Record<string, unknown> {
  recommendation_id: string;
  deal_id: string;
  deal_name: string | null;
  recommendation_code: string | null;
  recommendation_label: string | null;
  recommendation_text: string | null;
  priority: 'high' | 'medium' | 'low' | null;
  owner_role: 'deal_owner' | 'manager' | null;
  due_at: string | null;
  recommendation_status: string;
  item_status: 'eligible' | 'skipped';
  skip_reason: string | null;
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function randomToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/g, '');
}

function batchSummary(row: FollowUpBatchRow): FollowUpBatchSummary {
  return {
    id: row.id,
    channel: row.channel,
    routeName: row.route_name,
    status: row.status,
    requestedCount: Number(row.requested_count),
    eligibleCount: Number(row.eligible_count),
    skippedCount: Number(row.skipped_count),
    recipientCount: Number(row.recipient_count),
    deliverySuccessCount: Number(row.delivery_success_count),
    deliveryFailureCount: Number(row.delivery_failure_count),
    createdAt: row.created_at,
    confirmedAt: row.confirmed_at,
    completedAt: row.completed_at,
    expiresAt: row.expires_at,
  };
}

function withinAssignedScope(
  access: EnterpriseAccessContext,
  recommendation: RecommendationInstance,
): boolean {
  const checks: Array<[string[], string | null]> = [
    [access.scope.pipelineIds, recommendation.baseline.pipelineId],
    [access.scope.teamIds, recommendation.baseline.teamId],
    [access.scope.ownerIds, recommendation.baseline.ownerId],
    [access.scope.regionCodes, recommendation.baseline.regionCode],
  ];
  return checks.every(([allowed, actual]) => allowed.length === 0 || Boolean(actual && allowed.includes(actual)));
}

function sameCreator(row: FollowUpBatchRow, identity: RequestIdentity): boolean {
  if (row.created_by_user_id && identity.userId) return row.created_by_user_id === identity.userId;
  if (row.created_by_email && identity.userEmail) {
    return row.created_by_email.toLowerCase() === identity.userEmail.toLowerCase();
  }
  return false;
}

async function cleanupFollowUpData(env: Env, portalId: string): Promise<void> {
  const now = new Date().toISOString();
  const retention = new Date(Date.now() - BATCH_RETENTION_MS).toISOString();
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE dealguard.recommendation_follow_up_batches
       SET status = 'expired', payload_cipher = NULL, payload_iv = NULL, updated_at = ?
       WHERE portal_id = ? AND status = 'previewed' AND expires_at < ?`,
    ).bind(now, portalId, now),
    env.DB.prepare(
      `DELETE FROM dealguard.recommendation_follow_up_batches
       WHERE portal_id = ? AND created_at < ?`,
    ).bind(portalId, retention),
  ]);
}

function candidateFromRecommendation(item: RecommendationInstance): FollowUpCandidate {
  return {
    id: item.id,
    dealId: item.dealId,
    label: item.label,
    action: item.action,
    dimension: item.dimension,
    priority: item.priority,
    owner: item.owner,
    dueAt: item.dueAt,
    status: item.status as 'presented' | 'accepted',
    overdue: item.overdue,
    rationale: item.rationale,
    presentedAt: item.presentedAt,
  };
}

export async function recommendationFollowUpCandidates(
  env: Env,
  identity: RequestIdentity,
  url: URL,
): Promise<FollowUpCandidatesResponse> {
  const access = await requireEnterprisePermission(env, identity, 'remediation.view');
  await cleanupFollowUpData(env, identity.portalId);
  const scoped = analyticsScopeFilter(url, access);
  if (scoped.deniedKey) {
    throw new AppError(403, 'recommendation_scope_denied', `The selected ${scoped.deniedKey} is outside your assigned scope.`);
  }
  const where = scoped.clauses.length > 0 ? `AND ${scoped.clauses.join(' AND ')}` : '';
  const rows = await env.DB.prepare(
    `${RECOMMENDATION_SELECT}
     WHERE recommendation.portal_id = ?
       AND recommendation.status IN ('presented', 'accepted')
       ${where}
     ORDER BY
       CASE WHEN recommendation.status = 'accepted' THEN 0 ELSE 1 END,
       CASE WHEN recommendation.due_at IS NOT NULL AND recommendation.due_at < ? THEN 0 ELSE 1 END,
       CASE recommendation.priority WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END,
       recommendation.due_at ASC NULLS LAST,
       recommendation.presented_at DESC
     LIMIT ?`,
  ).bind(identity.portalId, ...scoped.params, new Date().toISOString(), CANDIDATE_LIMIT)
    .all<RecommendationRow>();

  const userClause = identity.userId
    ? 'created_by_user_id = ?'
    : 'lower(created_by_email) = lower(?)';
  const userValue = identity.userId ?? identity.userEmail ?? '';
  const batches = await env.DB.prepare(
    `SELECT * FROM dealguard.recommendation_follow_up_batches
     WHERE portal_id = ? AND ${userClause}
     ORDER BY created_at DESC
     LIMIT 20`,
  ).bind(identity.portalId, userValue).all<FollowUpBatchRow>();

  return {
    candidates: (rows.results ?? []).map(mapRecommendation).map(candidateFromRecommendation),
    batches: (batches.results ?? []).map(batchSummary),
    permissions: {
      canView: true,
      canManage: permissionMatches(access.permissions, 'remediation.manage'),
      canRouteNotifications: permissionMatches(access.permissions, 'alert.manage'),
      canExport: permissionMatches(access.permissions, 'analytics.export'),
    },
    semantics: {
      explicitPreviewRequired: true,
      explicitConfirmationRequired: true,
      noAutomaticRecommendationTransition: true,
      noCrmMutation: true,
    },
  };
}

export async function previewRecommendationFollowUp(
  env: Env,
  identity: RequestIdentity,
  input: unknown,
): Promise<FollowUpPreviewResponse> {
  const access = await requireEnterprisePermission(env, identity, 'remediation.manage');
  if (!permissionMatches(access.permissions, 'alert.manage')) {
    throw new AppError(403, 'recommendation_follow_up_permission_denied', 'The alert.manage permission is required to route a bulk follow-up.');
  }
  await cleanupFollowUpData(env, identity.portalId);
  const body = object(input);
  const rawIds = Array.isArray(body.recommendationIds) ? body.recommendationIds : [];
  const recommendationIds = [...new Set(rawIds
    .filter((value): value is string => typeof value === 'string' && Boolean(value.trim()))
    .map((value) => value.trim()))];
  if (recommendationIds.length === 0) {
    throw new AppError(400, 'recommendation_selection_required', 'Select at least one recommendation.');
  }
  if (recommendationIds.length > MAX_RECOMMENDATIONS) {
    throw new AppError(400, 'recommendation_selection_too_large', `Select no more than ${MAX_RECOMMENDATIONS} recommendations per follow-up.`);
  }

  const recipients = normalizeRecipientEmails(body.recipients);
  if (recipients.invalid.length > 0) {
    throw new AppError(400, 'follow_up_recipient_invalid', 'One or more follow-up recipient email addresses are invalid.', {
      invalidRecipients: recipients.invalid,
    });
  }
  if (recipients.emails.length === 0) {
    throw new AppError(400, 'follow_up_recipient_required', 'Provide at least one valid follow-up recipient.');
  }
  if (recipients.emails.length > MAX_RECIPIENTS) {
    throw new AppError(400, 'follow_up_recipient_limit', `Provide no more than ${MAX_RECIPIENTS} recipients per follow-up.`);
  }

  const recommendations: Array<RecommendationInstance | null> = [];
  const responseItems: FollowUpPreviewItem[] = [];
  for (const recommendationId of recommendationIds) {
    const recommendation = await recommendationById(env, identity.portalId, recommendationId);
    if (!recommendation || !withinAssignedScope(access, recommendation)) {
      recommendations.push(null);
      responseItems.push({
        recommendationId,
        dealId: null,
        dealName: null,
        label: null,
        priority: null,
        status: 'not_found',
        itemStatus: 'skipped',
        skipReason: 'unavailable_or_outside_scope',
      });
      continue;
    }
    recommendations.push(recommendation);
  }

  const scopedDealIds = [...new Set(recommendations
    .filter((item): item is RecommendationInstance => item !== null)
    .map((item) => item.dealId))];
  const dealNames = new Map<string, string>();
  if (scopedDealIds.length > 0) {
    const placeholders = scopedDealIds.map(() => '?').join(', ');
    const rows = await env.DB.prepare(
      `SELECT deal_id, deal_name FROM deal_assessments
       WHERE portal_id = ? AND deal_id IN (${placeholders})`,
    ).bind(identity.portalId, ...scopedDealIds).all<{ deal_id: string; deal_name: string }>();
    for (const row of rows.results ?? []) dealNames.set(String(row.deal_id), String(row.deal_name));
  }

  const storedItems: Array<{
    recommendation: RecommendationInstance;
    dealName: string | null;
    eligible: boolean;
    reason: string | null;
  }> = [];
  for (const recommendation of recommendations) {
    if (!recommendation) continue;
    const eligibility = followUpEligibility(recommendation);
    const dealName = dealNames.get(recommendation.dealId) ?? null;
    storedItems.push({ recommendation, dealName, ...eligibility });
    responseItems.push({
      recommendationId: recommendation.id,
      dealId: recommendation.dealId,
      dealName,
      label: recommendation.label,
      priority: recommendation.priority,
      status: recommendation.status,
      itemStatus: eligibility.eligible ? 'eligible' : 'skipped',
      skipReason: eligibility.reason,
    });
  }

  const eligible = storedItems.filter((item) => item.eligible);
  if (eligible.length === 0) {
    throw new AppError(409, 'no_eligible_recommendations', 'None of the selected recommendations remain presented or accepted.');
  }

  const routeName = safeRouteName(body.routeName);
  const note = safeManagerNote(body.note);
  const token = randomToken();
  const tokenHash = await sha256Hex(token);
  const encrypted = await encryptSecret(JSON.stringify({ recipients: recipients.emails, note }), env.TOKEN_ENCRYPTION_KEY);
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const expiresAt = new Date(Date.now() + PREVIEW_TTL_MS).toISOString();
  const statements = [
    env.DB.prepare(
      `INSERT INTO dealguard.recommendation_follow_up_batches (
        id, portal_id, channel, route_name, status,
        requested_count, eligible_count, skipped_count, recipient_count,
        confirmation_token_hash, payload_cipher, payload_iv, expires_at,
        created_by_user_id, created_by_email, created_at, updated_at
      ) VALUES (?, ?, 'email', ?, 'previewed', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      id, identity.portalId, routeName,
      recommendationIds.length, eligible.length, recommendationIds.length - eligible.length,
      recipients.emails.length, tokenHash, encrypted.cipher, encrypted.iv, expiresAt,
      identity.userId, identity.userEmail, now, now,
    ),
    ...storedItems.map((item) => env.DB.prepare(
      `INSERT INTO dealguard.recommendation_follow_up_items (
        id, batch_id, portal_id, recommendation_id, deal_id, deal_name,
        recommendation_code, recommendation_label, recommendation_text,
        priority, owner_role, due_at, recommendation_status,
        item_status, skip_reason, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      crypto.randomUUID(), id, identity.portalId,
      item.recommendation.id, item.recommendation.dealId, item.dealName,
      item.recommendation.recommendationCode, item.recommendation.label, item.recommendation.action,
      item.recommendation.priority, item.recommendation.owner, item.recommendation.dueAt,
      item.recommendation.status, item.eligible ? 'eligible' : 'skipped', item.reason, now,
    )),
  ];
  await env.DB.batch(statements);
  await new Repository(env).audit(identity.portalId, identity.userId, identity.userEmail, 'recommendation.follow_up.previewed', {
    batchId: id,
    requestedCount: recommendationIds.length,
    eligibleCount: eligible.length,
    skippedCount: recommendationIds.length - eligible.length,
    recipientCount: recipients.emails.length,
    routeName,
  });

  return {
    batchId: id,
    confirmationToken: token,
    expiresAt,
    route: { channel: 'email', name: routeName, recipientCount: recipients.emails.length },
    summary: {
      requested: recommendationIds.length,
      eligible: eligible.length,
      skipped: recommendationIds.length - eligible.length,
    },
    items: responseItems,
    semantics: {
      humanConfirmationRequired: true,
      noRecommendationStateChanged: true,
      noCrmMutation: true,
      recipientValuesEncryptedAtRest: true,
    },
  };
}

export async function confirmRecommendationFollowUp(
  env: Env,
  identity: RequestIdentity,
  batchId: string,
  input: unknown,
): Promise<FollowUpBatchSummary> {
  const access = await requireEnterprisePermission(env, identity, 'remediation.manage');
  if (!permissionMatches(access.permissions, 'alert.manage')) {
    throw new AppError(403, 'recommendation_follow_up_permission_denied', 'The alert.manage permission is required to confirm a bulk follow-up.');
  }
  const body = object(input);
  const token = typeof body.confirmationToken === 'string' ? body.confirmationToken : '';
  if (!token) throw new AppError(400, 'follow_up_confirmation_token_required', 'The preview confirmation token is required.');
  const batch = await env.DB.prepare(
    `SELECT * FROM dealguard.recommendation_follow_up_batches
     WHERE portal_id = ? AND id = ? LIMIT 1`,
  ).bind(identity.portalId, batchId).first<FollowUpBatchRow>();
  if (!batch || !sameCreator(batch, identity)) {
    throw new AppError(404, 'follow_up_batch_not_found', 'The follow-up preview does not exist.');
  }
  if (batch.status !== 'previewed') {
    throw new AppError(409, 'follow_up_batch_not_confirmable', `A ${batch.status} follow-up cannot be confirmed.`);
  }
  if (Date.parse(batch.expires_at) <= Date.now()) {
    await env.DB.prepare(
      `UPDATE dealguard.recommendation_follow_up_batches
       SET status = 'expired', payload_cipher = NULL, payload_iv = NULL, updated_at = ?
       WHERE portal_id = ? AND id = ? AND status = 'previewed'`,
    ).bind(new Date().toISOString(), identity.portalId, batch.id).run();
    throw new AppError(409, 'follow_up_preview_expired', 'The follow-up preview expired. Create a new preview before sending.');
  }
  if (await sha256Hex(token) !== batch.confirmation_token_hash) {
    throw new AppError(403, 'follow_up_confirmation_invalid', 'The follow-up confirmation token is invalid.');
  }

  const now = new Date().toISOString();
  await env.DB.prepare(
    `UPDATE dealguard.recommendation_follow_up_items AS item
     SET item_status = 'skipped', skip_reason = 'recommendation_no_longer_active'
     WHERE item.portal_id = ? AND item.batch_id = ? AND item.item_status = 'eligible'
       AND NOT EXISTS (
         SELECT 1 FROM recommendation_instances AS recommendation
         WHERE recommendation.portal_id = item.portal_id
           AND recommendation.id = item.recommendation_id
           AND recommendation.status IN ('presented', 'accepted')
       )`,
  ).bind(identity.portalId, batch.id).run();
  const eligible = await env.DB.prepare(
    `SELECT COUNT(*) AS count FROM dealguard.recommendation_follow_up_items
     WHERE portal_id = ? AND batch_id = ? AND item_status = 'eligible'`,
  ).bind(identity.portalId, batch.id).first<{ count: number }>();
  const eligibleCount = Number(eligible?.count ?? 0);
  if (eligibleCount === 0) {
    await env.DB.prepare(
      `UPDATE dealguard.recommendation_follow_up_batches
       SET status = 'expired', eligible_count = 0, skipped_count = requested_count,
           payload_cipher = NULL, payload_iv = NULL, updated_at = ?
       WHERE portal_id = ? AND id = ?`,
    ).bind(now, identity.portalId, batch.id).run();
    throw new AppError(409, 'follow_up_no_longer_eligible', 'The selected recommendations changed after preview. Create a new preview.');
  }
  if (!batch.payload_cipher || !batch.payload_iv) {
    throw new AppError(409, 'follow_up_payload_unavailable', 'The encrypted follow-up route is no longer available. Create a new preview.');
  }
  const payload = JSON.parse(await decryptSecret(batch.payload_cipher, batch.payload_iv, env.TOKEN_ENCRYPTION_KEY)) as {
    recipients?: unknown;
  };
  const recipients = normalizeRecipientEmails(payload.recipients);
  if (recipients.emails.length === 0 || recipients.emails.length > MAX_RECIPIENTS) {
    throw new AppError(409, 'follow_up_payload_invalid', 'The encrypted follow-up route is invalid. Create a new preview.');
  }

  const updated = await env.DB.prepare(
    `UPDATE dealguard.recommendation_follow_up_batches
     SET status = 'queued', eligible_count = ?, skipped_count = requested_count - ?,
         confirmed_at = ?, updated_at = ?
     WHERE portal_id = ? AND id = ? AND status = 'previewed'`,
  ).bind(eligibleCount, eligibleCount, now, now, identity.portalId, batch.id).run();
  if (Number(updated.meta?.changes ?? 0) <= 0) {
    throw new AppError(409, 'follow_up_confirmation_conflict', 'The follow-up changed before it could be confirmed. Refresh and try again.');
  }
  await env.DB.batch(recipients.emails.map((recipient) => env.DB.prepare(
    `INSERT INTO dealguard.recommendation_follow_up_deliveries (
      id, batch_id, portal_id, recipient_hash, status, created_at, updated_at
    ) VALUES (?, ?, ?, ?, 'queued', ?, ?)
    ON CONFLICT(batch_id, recipient_hash) DO NOTHING`,
  ).bind(crypto.randomUUID(), batch.id, identity.portalId, recipient, now, now)));
  // Replace plaintext-looking values with irreversible hashes immediately after the rows exist.
  for (const recipient of recipients.emails) {
    await env.DB.prepare(
      `UPDATE dealguard.recommendation_follow_up_deliveries
       SET recipient_hash = ?
       WHERE portal_id = ? AND batch_id = ? AND recipient_hash = ?`,
    ).bind(await sha256Hex(recipient), identity.portalId, batch.id, recipient).run();
  }
  await new Repository(env).audit(identity.portalId, identity.userId, identity.userEmail, 'recommendation.follow_up.confirmed', {
    batchId: batch.id,
    eligibleCount,
    recipientCount: recipients.emails.length,
    channel: 'email',
  });
  const current = await env.DB.prepare(
    `SELECT * FROM dealguard.recommendation_follow_up_batches WHERE portal_id = ? AND id = ?`,
  ).bind(identity.portalId, batch.id).first<FollowUpBatchRow>();
  return batchSummary(current!);
}

function escapeHtml(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;').replaceAll("'", '&#039;');
}

function emailContent(
  env: Env,
  batch: FollowUpBatchRow,
  items: FollowUpItemRow[],
  note: string,
): { subject: string; text: string; html: string } {
  const subject = `DealGuard follow-up: ${items.length} recommendation${items.length === 1 ? '' : 's'} need attention`;
  const lines = items.map((item, index) => {
    const owner = item.owner_role === 'manager' ? 'Sales manager' : 'Deal owner';
    const due = item.due_at ? new Date(item.due_at).toLocaleString('en') : 'No deadline recorded';
    const link = `${env.APP_BASE_URL.replace(/\/$/, '')}/open/deal/${encodeURIComponent(item.deal_id)}`;
    return `${index + 1}. ${item.deal_name ?? `Deal ${item.deal_id}`} — ${item.recommendation_label ?? item.recommendation_code ?? 'Recommendation'}\n${item.recommendation_text ?? ''}\nOwner: ${owner}; due: ${due}\n${link}`;
  });
  const text = [
    batch.route_name,
    note ? `Manager note: ${note}` : '',
    '',
    ...lines,
    '',
    'This message is an explicitly confirmed management follow-up. DealGuard did not change any CRM record or recommendation status.',
  ].filter((line) => line !== '').join('\n\n');
  const htmlItems = items.map((item) => {
    const owner = item.owner_role === 'manager' ? 'Sales manager' : 'Deal owner';
    const due = item.due_at ? new Date(item.due_at).toLocaleString('en') : 'No deadline recorded';
    const link = `${env.APP_BASE_URL.replace(/\/$/, '')}/open/deal/${encodeURIComponent(item.deal_id)}`;
    return `<li><strong>${escapeHtml(item.deal_name ?? `Deal ${item.deal_id}`)}</strong><br>${escapeHtml(item.recommendation_label ?? item.recommendation_code ?? 'Recommendation')}<br>${escapeHtml(item.recommendation_text ?? '')}<br><small>Owner: ${escapeHtml(owner)} · Due: ${escapeHtml(due)}</small><br><a href="${escapeHtml(link)}">Open DealGuard deal context</a></li>`;
  }).join('');
  const html = `<h2>${escapeHtml(batch.route_name)}</h2>${note ? `<p><strong>Manager note:</strong> ${escapeHtml(note)}</p>` : ''}<ol>${htmlItems}</ol><p><small>This message was explicitly confirmed by a manager. DealGuard did not change any CRM record or recommendation status.</small></p>`;
  return { subject, text, html };
}

async function sendEmail(
  env: Env,
  recipient: string,
  content: { subject: string; text: string; html: string },
): Promise<string> {
  if (!env.RESEND_API_KEY) throw new Error('resend_not_configured');
  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${env.RESEND_API_KEY}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      from: env.EMAIL_FROM,
      to: [recipient],
      subject: content.subject,
      text: content.text,
      html: content.html,
    }),
  });
  const data = await response.json().catch(() => ({})) as { id?: string; message?: string };
  if (!response.ok) throw new Error(data.message?.slice(0, 240) || `resend_${response.status}`);
  return data.id ?? 'accepted';
}

export async function deliverRecommendationFollowUpBatch(env: Env, batchId: string): Promise<void> {
  const batch = await env.DB.prepare(
    `SELECT * FROM dealguard.recommendation_follow_up_batches WHERE id = ? LIMIT 1`,
  ).bind(batchId).first<FollowUpBatchRow>();
  if (!batch || batch.status !== 'queued') return;
  const now = new Date().toISOString();
  const claimed = await env.DB.prepare(
    `UPDATE dealguard.recommendation_follow_up_batches
     SET status = 'sending', updated_at = ?
     WHERE id = ? AND status = 'queued'`,
  ).bind(now, batch.id).run();
  if (Number(claimed.meta?.changes ?? 0) <= 0) return;
  if (!batch.payload_cipher || !batch.payload_iv) {
    await env.DB.prepare(
      `UPDATE dealguard.recommendation_follow_up_batches
       SET status = 'failed', delivery_failure_count = recipient_count,
           completed_at = ?, updated_at = ? WHERE id = ?`,
    ).bind(now, now, batch.id).run();
    return;
  }

  const decrypted = JSON.parse(await decryptSecret(batch.payload_cipher, batch.payload_iv, env.TOKEN_ENCRYPTION_KEY)) as {
    recipients?: unknown;
    note?: unknown;
  };
  const recipients = normalizeRecipientEmails(decrypted.recipients).emails;
  const note = safeManagerNote(decrypted.note);
  const items = await env.DB.prepare(
    `SELECT * FROM dealguard.recommendation_follow_up_items
     WHERE portal_id = ? AND batch_id = ? AND item_status = 'eligible'
     ORDER BY CASE priority WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END,
              due_at ASC NULLS LAST, created_at ASC`,
  ).bind(batch.portal_id, batch.id).all<FollowUpItemRow>();
  const content = emailContent(env, batch, items.results ?? [], note);
  const statuses: Array<'queued' | 'sent' | 'failed'> = [];
  for (const recipient of recipients) {
    const recipientHash = await sha256Hex(recipient);
    const attemptedAt = new Date().toISOString();
    try {
      const providerId = await sendEmail(env, recipient, content);
      statuses.push('sent');
      await env.DB.prepare(
        `UPDATE dealguard.recommendation_follow_up_deliveries
         SET status = 'sent', provider_message_id = ?, error_code = NULL,
             attempted_at = ?, sent_at = ?, updated_at = ?
         WHERE portal_id = ? AND batch_id = ? AND recipient_hash = ?`,
      ).bind(providerId, attemptedAt, attemptedAt, attemptedAt, batch.portal_id, batch.id, recipientHash).run();
    } catch (error) {
      statuses.push('failed');
      const code = (error instanceof Error ? error.message : String(error)).slice(0, 240);
      await env.DB.prepare(
        `UPDATE dealguard.recommendation_follow_up_deliveries
         SET status = 'failed', error_code = ?, attempted_at = ?, updated_at = ?
         WHERE portal_id = ? AND batch_id = ? AND recipient_hash = ?`,
      ).bind(code, attemptedAt, attemptedAt, batch.portal_id, batch.id, recipientHash).run();
    }
  }
  const finalStatus = deliveryBatchStatus(statuses);
  const sent = statuses.filter((status) => status === 'sent').length;
  const failed = statuses.filter((status) => status === 'failed').length;
  const completedAt = new Date().toISOString();
  await env.DB.prepare(
    `UPDATE dealguard.recommendation_follow_up_batches
     SET status = ?, delivery_success_count = ?, delivery_failure_count = ?,
         payload_cipher = NULL, payload_iv = NULL, completed_at = ?, updated_at = ?
     WHERE id = ?`,
  ).bind(finalStatus, sent, failed, completedAt, completedAt, batch.id).run();
  await new Repository(env).audit(
    batch.portal_id,
    batch.created_by_user_id,
    batch.created_by_email,
    'recommendation.follow_up.delivered',
    { batchId: batch.id, status: finalStatus, sent, failed, recipientCount: recipients.length },
  );
}

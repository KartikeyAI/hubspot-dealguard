import { decryptSecret, encryptSecret, randomToken, sha256Hex } from './crypto.js';
import { AppError } from './errors.js';
import { Repository } from './repository.js';
import type { DealAssessment, Env, RequestIdentity, TenantSettings } from './types.js';

export type SlackNotificationKind = 'critical_deal' | 'handoff_required' | 'handoff_confirmed' | 'workflow_assessment' | 'test';
export interface SlackConnectionStatus { connected: boolean; entitled: boolean; teamId?: string; teamName?: string; channelId?: string; channelName?: string; connectedAt?: string; status?: 'active' | 'revoked' | 'error' }
interface SlackOAuthResponse { ok: boolean; error?: string; access_token?: string; scope?: string; team?: { id: string; name: string }; incoming_webhook?: { channel: string; channel_id: string; configuration_url?: string; url: string }; authed_user?: { id?: string } }
interface SlackConnectionRow { team_id: string; team_name: string; channel_id: string; channel_name: string; webhook_cipher: string; webhook_iv: string; access_token_cipher: string; access_token_iv: string; status: 'active' | 'revoked' | 'error'; connected_at: string }

function hasSlackEntitlement(plan: string): boolean { return plan === 'growth' || plan === 'beta_growth'; }
function requireSlackConfiguration(env: Env): void {
  if (!env.SLACK_CLIENT_ID || !env.SLACK_CLIENT_SECRET) throw new AppError(503, 'slack_not_configured', 'Slack integration is not configured for this DealGuard deployment.');
}

export async function createSlackAuthorization(env: Env, identity: RequestIdentity): Promise<string> {
  requireSlackConfiguration(env);
  const repository = new Repository(env);
  const tenant = await repository.getTenant(identity.portalId);
  if (!hasSlackEntitlement(tenant.plan)) throw new AppError(403, 'growth_plan_required', 'Slack notifications require DealGuard Growth.');
  const state = randomToken();
  const now = new Date();
  await env.DB.prepare(`INSERT INTO integration_oauth_states (state_hash, provider, portal_id, user_id, user_email, expires_at, created_at) VALUES (?, 'slack', ?, ?, ?, ?, ?)`)
    .bind(await sha256Hex(state), identity.portalId, identity.userId, identity.userEmail, new Date(now.getTime() + 10 * 60_000).toISOString(), now.toISOString()).run();
  const authorize = new URL('https://slack.com/oauth/v2/authorize');
  authorize.searchParams.set('client_id', env.SLACK_CLIENT_ID!);
  authorize.searchParams.set('scope', 'incoming-webhook');
  authorize.searchParams.set('redirect_uri', `${env.APP_BASE_URL}/oauth/slack/callback`);
  authorize.searchParams.set('state', state);
  return authorize.toString();
}

export async function completeSlackAuthorization(env: Env, code: string, state: string): Promise<string> {
  requireSlackConfiguration(env);
  const stateHash = await sha256Hex(state);
  const oauthState = await env.DB.prepare(`SELECT portal_id, user_id, user_email, expires_at FROM integration_oauth_states WHERE state_hash = ? AND provider = 'slack'`)
    .bind(stateHash).first<{ portal_id: string; user_id: string | null; user_email: string | null; expires_at: string }>();
  if (!oauthState) throw new AppError(400, 'invalid_slack_oauth_state', 'Slack connection state is invalid or already used.');
  await env.DB.prepare(`DELETE FROM integration_oauth_states WHERE state_hash = ?`).bind(stateHash).run();
  if (Date.parse(oauthState.expires_at) < Date.now()) throw new AppError(400, 'expired_slack_oauth_state', 'Slack connection state has expired.');
  const response = await fetch('https://slack.com/api/oauth.v2.access', {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded;charset=utf-8' },
    body: new URLSearchParams({ client_id: env.SLACK_CLIENT_ID!, client_secret: env.SLACK_CLIENT_SECRET!, code, redirect_uri: `${env.APP_BASE_URL}/oauth/slack/callback` }),
  });
  const payload = await response.json() as SlackOAuthResponse;
  if (!response.ok || !payload.ok || !payload.incoming_webhook?.url || !payload.team?.id || !payload.access_token) throw new AppError(502, 'slack_oauth_failed', `Slack could not be connected${payload.error ? `: ${payload.error}` : '.'}`);
  const tenant = await new Repository(env).getTenant(oauthState.portal_id);
  if (!hasSlackEntitlement(tenant.plan)) throw new AppError(403, 'growth_plan_required', 'Slack notifications require DealGuard Growth.');
  const encrypted = await encryptSecret(payload.incoming_webhook.url, env.TOKEN_ENCRYPTION_KEY);
  const encryptedAccessToken = await encryptSecret(payload.access_token, env.TOKEN_ENCRYPTION_KEY);
  const now = new Date().toISOString();
  await env.DB.prepare(`INSERT INTO slack_connections (portal_id, team_id, team_name, channel_id, channel_name, webhook_cipher, webhook_iv, access_token_cipher, access_token_iv, status, connected_at, connected_by_user_id, connected_by_email, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?) ON CONFLICT(portal_id) DO UPDATE SET team_id = excluded.team_id, team_name = excluded.team_name, channel_id = excluded.channel_id, channel_name = excluded.channel_name, webhook_cipher = excluded.webhook_cipher, webhook_iv = excluded.webhook_iv, access_token_cipher = excluded.access_token_cipher, access_token_iv = excluded.access_token_iv, status = 'active', connected_at = excluded.connected_at, connected_by_user_id = excluded.connected_by_user_id, connected_by_email = excluded.connected_by_email, updated_at = excluded.updated_at`)
    .bind(oauthState.portal_id, payload.team.id, payload.team.name, payload.incoming_webhook.channel_id, payload.incoming_webhook.channel, encrypted.cipher, encrypted.iv, encryptedAccessToken.cipher, encryptedAccessToken.iv, now, oauthState.user_id, oauthState.user_email, now).run();
  await new Repository(env).audit(oauthState.portal_id, oauthState.user_id, oauthState.user_email, 'slack.connected', { teamId: payload.team.id, channelId: payload.incoming_webhook.channel_id });
  return oauthState.portal_id;
}

export async function getSlackStatus(env: Env, portalId: string): Promise<SlackConnectionStatus> {
  const tenant = await new Repository(env).getTenant(portalId);
  const row = await env.DB.prepare(`SELECT team_id, team_name, channel_id, channel_name, status, connected_at FROM slack_connections WHERE portal_id = ?`)
    .bind(portalId).first<Omit<SlackConnectionRow, 'webhook_cipher' | 'webhook_iv' | 'access_token_cipher' | 'access_token_iv'>>();
  if (!row) return { connected: false, entitled: hasSlackEntitlement(tenant.plan) };
  return { connected: row.status === 'active', entitled: hasSlackEntitlement(tenant.plan), teamId: row.team_id, teamName: row.team_name, channelId: row.channel_id, channelName: row.channel_name, connectedAt: row.connected_at, status: row.status };
}

export async function disconnectSlack(env: Env, identity: RequestIdentity): Promise<void> {
  const connection = await activeConnection(env, identity.portalId);
  if (connection) {
    try {
      const accessToken = await decryptSecret(connection.access_token_cipher, connection.access_token_iv, env.TOKEN_ENCRYPTION_KEY);
      await fetch('https://slack.com/api/auth.revoke', { method: 'POST', headers: { authorization: `Bearer ${accessToken}`, 'content-type': 'application/x-www-form-urlencoded;charset=utf-8' }, body: new URLSearchParams({ test: 'false' }) });
    } catch (error) { console.error(JSON.stringify({ level: 'warn', task: 'slack_revoke', portalId: identity.portalId, error: error instanceof Error ? error.message : String(error) })); }
  }
  await env.DB.prepare(`DELETE FROM slack_connections WHERE portal_id = ?`).bind(identity.portalId).run();
  await new Repository(env).audit(identity.portalId, identity.userId, identity.userEmail, 'slack.disconnected', {});
}

function dealUrl(portalId: string, dealId: string): string { return `https://app.hubspot.com/contacts/${encodeURIComponent(portalId)}/record/0-3/${encodeURIComponent(dealId)}`; }
export function buildSlackPayload(portalId: string, assessment: DealAssessment, kind: SlackNotificationKind): Record<string, unknown> {
  const titles: Record<SlackNotificationKind, string> = { critical_deal: 'Critical deal readiness issue', handoff_required: 'Closed-won handoff requires attention', handoff_confirmed: 'Sales-to-delivery handoff confirmed', workflow_assessment: 'DealGuard workflow assessment', test: 'DealGuard Slack connection test' };
  const safe = (value: string) => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
  const issueText = assessment.issues.slice(0, 5).map((item) => `• ${safe(item.label)}: ${safe(item.description)}`).join('\n') || 'No readiness gaps detected.';
  const blocks: Array<Record<string, unknown>> = [
    { type: 'header', text: { type: 'plain_text', text: titles[kind], emoji: true } },
    { type: 'section', text: { type: 'mrkdwn', text: `*${safe(assessment.dealName)}* · ${safe(assessment.pipelineLabel)} / ${safe(assessment.stageLabel)}\nReadiness: *${assessment.score}/100 (${assessment.grade})* · ${assessment.status.replace('_', ' ')}` } },
    { type: 'section', text: { type: 'mrkdwn', text: issueText } },
    { type: 'context', elements: [{ type: 'mrkdwn', text: `DealGuard by Rokad · assessed ${assessment.assessedAt}` }] },
  ];
  if (kind !== 'test') blocks.splice(blocks.length - 1, 0, { type: 'actions', elements: [{ type: 'button', text: { type: 'plain_text', text: 'Open deal' }, url: dealUrl(portalId, assessment.dealId), action_id: 'open_deal' }] });
  return { text: `${titles[kind]}: ${safe(assessment.dealName)}`, blocks };
}

async function activeConnection(env: Env, portalId: string): Promise<SlackConnectionRow | null> {
  return env.DB.prepare(`SELECT team_id, team_name, channel_id, channel_name, webhook_cipher, webhook_iv, access_token_cipher, access_token_iv, status, connected_at FROM slack_connections WHERE portal_id = ? AND status = 'active'`)
    .bind(portalId).first<SlackConnectionRow>();
}
async function postSlack(env: Env, portalId: string, payload: Record<string, unknown>): Promise<void> {
  const connection = await activeConnection(env, portalId);
  if (!connection) throw new AppError(409, 'slack_not_connected', 'Connect a Slack channel before sending notifications.');
  const webhookUrl = await decryptSecret(connection.webhook_cipher, connection.webhook_iv, env.TOKEN_ENCRYPTION_KEY);
  const response = await fetch(webhookUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });
  if (!response.ok) {
    if (response.status === 404 || response.status === 410) await env.DB.prepare(`UPDATE slack_connections SET status = 'revoked', updated_at = ? WHERE portal_id = ?`).bind(new Date().toISOString(), portalId).run();
    throw new AppError(502, 'slack_delivery_failed', 'Slack rejected the DealGuard notification. Reconnect Slack if the problem continues.');
  }
}

async function reserveNotification(env: Env, portalId: string, dealId: string | null, kind: SlackNotificationKind, fingerprint: string, cooldownMinutes: number): Promise<string | null> {
  if (dealId && kind !== 'test' && kind !== 'handoff_confirmed') {
    const cutoff = new Date(Date.now() - cooldownMinutes * 60_000).toISOString();
    const recent = await env.DB.prepare(`SELECT id FROM notification_events WHERE portal_id = ? AND deal_id = ? AND kind = ? AND status = 'sent' AND sent_at >= ? LIMIT 1`)
      .bind(portalId, dealId, kind, cutoff).first<{ id: string }>();
    if (recent) return null;
  }
  const existing = await env.DB.prepare(`SELECT id, status, created_at FROM notification_events WHERE portal_id = ? AND fingerprint = ?`)
    .bind(portalId, fingerprint).first<{ id: string; status: string; created_at: string }>();
  const stalePending = existing?.status === 'pending' && Date.parse(existing.created_at) <= Date.now() - 10 * 60_000;
  if (existing?.status === 'failed' || stalePending) {
    await env.DB.prepare(`UPDATE notification_events SET status = 'pending', error_message = NULL, sent_at = NULL, created_at = ? WHERE id = ?`)
      .bind(new Date().toISOString(), existing.id).run();
    return existing.id;
  }
  if (existing) return null;
  const id = crypto.randomUUID();
  await env.DB.prepare(`INSERT INTO notification_events (id, portal_id, deal_id, kind, fingerprint, status, created_at) VALUES (?, ?, ?, ?, ?, 'pending', ?)`)
    .bind(id, portalId, dealId, kind, fingerprint, new Date().toISOString()).run();
  return id;
}

export async function deliverSlackAssessment(env: Env, portalId: string, assessment: DealAssessment, kind: SlackNotificationKind, fingerprint: string, cooldownMinutes = 120): Promise<boolean> {
  const notificationId = await reserveNotification(env, portalId, assessment.dealId, kind, fingerprint, cooldownMinutes);
  if (!notificationId) return false;
  try {
    await postSlack(env, portalId, buildSlackPayload(portalId, assessment, kind));
    await env.DB.prepare(`UPDATE notification_events SET status = 'sent', sent_at = ? WHERE id = ?`).bind(new Date().toISOString(), notificationId).run();
    return true;
  } catch (error) {
    await env.DB.prepare(`UPDATE notification_events SET status = 'failed', error_message = ? WHERE id = ?`).bind((error instanceof Error ? error.message : String(error)).slice(0, 1000), notificationId).run();
    throw error;
  }
}

export async function notifyAssessmentTransition(env: Env, portalId: string, previous: (DealAssessment & { handoffStatus?: string | null }) | null, assessment: DealAssessment, settings: TenantSettings, plan: string, trigger: string, force = false): Promise<void> {
  if (!hasSlackEntitlement(plan) || (!settings.notifications.slack.enabled && !force)) return;
  const slack = settings.notifications.slack;
  let kind: SlackNotificationKind | null = null;
  if (force) kind = 'workflow_assessment';
  else if (slack.alertOnHandoffRequired && assessment.isWon && previous?.handoffStatus !== 'confirmed') kind = 'handoff_required';
  else if (slack.alertOnCritical && assessment.status === 'critical') kind = 'critical_deal';
  if (!kind) return;
  const timeKey = force ? assessment.assessedAt : assessment.assessedAt.slice(0, 13);
  const fingerprint = `${kind}:${assessment.dealId}:${assessment.status}:${assessment.score}:${trigger}:${timeKey}`;
  await deliverSlackAssessment(env, portalId, assessment, kind, fingerprint, force ? 0 : slack.cooldownMinutes);
}
export async function notifyHandoffConfirmed(env: Env, portalId: string, assessment: DealAssessment, settings: TenantSettings, plan: string): Promise<void> {
  if (!hasSlackEntitlement(plan) || !settings.notifications.slack.enabled || !settings.notifications.slack.alertOnHandoffConfirmed) return;
  await deliverSlackAssessment(env, portalId, assessment, 'handoff_confirmed', `handoff_confirmed:${assessment.dealId}`, 0);
}
export async function sendSlackTest(env: Env, identity: RequestIdentity): Promise<void> {
  const credentials = await new Repository(env).getCredentials(identity.portalId);
  if (!hasSlackEntitlement(credentials.tenant.plan)) throw new AppError(403, 'growth_plan_required', 'Slack notifications require DealGuard Growth.');
  const sample: DealAssessment = { dealId: 'test', dealName: 'Example opportunity', pipelineLabel: 'Sales pipeline', stageLabel: 'Proposal', score: 62, grade: 'C', status: 'at_risk', issues: [{ code: 'test', label: 'Test notification', description: 'Your Slack connection is working.', severity: 'info', weight: 0 }], readinessSummary: 'DealGuard Slack connection test.', isClosed: false, isWon: false, handoffEligible: false, assessedAt: new Date().toISOString() };
  await postSlack(env, identity.portalId, buildSlackPayload(identity.portalId, sample, 'test'));
  await new Repository(env).audit(identity.portalId, identity.userId, identity.userEmail, 'slack.test_sent', {});
}

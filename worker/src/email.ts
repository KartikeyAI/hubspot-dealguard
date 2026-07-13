import { AppError } from './errors.js';
import { Repository } from './repository.js';
import type { Env, TenantRow, TenantSettings } from './types.js';
import { parseSettings } from './validation.js';

function due(tenant: TenantRow, settings: TenantSettings, now: Date): boolean {
  if (!settings.digest.enabled || settings.digest.recipients.length === 0) return false;
  if (now.getUTCHours() !== settings.digest.hourUtc) return false;
  if (settings.digest.frequency === 'weekly' && now.getUTCDay() !== settings.digest.dayOfWeek) return false;
  const last = tenant.last_digest_at ? Date.parse(tenant.last_digest_at) : 0;
  const interval = settings.digest.frequency === 'daily' ? 20 * 60 * 60_000 : 6 * 24 * 60 * 60_000;
  return now.getTime() - last >= interval;
}

export async function sendDueDigests(env: Env): Promise<void> {
  if (!env.RESEND_API_KEY) return;
  const repository = new Repository(env);
  const tenants = await repository.dueDigestTenants();
  const now = new Date();
  for (const tenant of tenants) {
    const settings = parseSettings(JSON.parse(tenant.settings_json), tenant.plan);
    if (!due(tenant, settings, now)) continue;
    const summary = await repository.dashboard(tenant.portal_id);
    const topIssues = summary.topIssues.length
      ? summary.topIssues.map((item) => `<li>${escapeHtml(item.label)}: ${item.count}</li>`).join('')
      : '<li>No recurring readiness issues.</li>';
    const html = `
      <h1>DealGuard pipeline digest</h1>
      <p>Average readiness score: <strong>${summary.averageScore}</strong></p>
      <p>Ready: ${summary.readyDeals} · At risk: ${summary.atRiskDeals} · Critical: ${summary.criticalDeals}</p>
      <p>Incomplete closed-won handoffs: ${summary.incompleteHandoffs}</p>
      <h2>Top readiness gaps</h2><ul>${topIssues}</ul>
      <p>Open HubSpot to review affected deals and confirm completed handoffs.</p>`;
    await sendEmail(env, settings.digest.recipients, 'DealGuard pipeline readiness digest', html);
    await repository.markDigestSent(tenant.portal_id);
  }
}

export async function sendEmail(env: Env, recipients: string[], subject: string, html: string): Promise<void> {
  if (!env.RESEND_API_KEY) throw new AppError(503, 'email_not_configured', 'Email delivery is not configured.');
  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${env.RESEND_API_KEY}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ from: env.EMAIL_FROM, to: recipients, subject, html }),
  });
  if (!response.ok) throw new AppError(502, 'email_delivery_failed', 'Digest email could not be delivered.');
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>'"]/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;',
  })[character] ?? character);
}

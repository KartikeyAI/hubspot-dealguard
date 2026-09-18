import { AppError } from './errors.js';
import { requireEnterprisePermission } from './enterprise-access.js';
import { requireCommercialTier } from './billing.js';
import { HubSpotClient, type HubSpotRequestPolicy } from './hubspot.js';
import { Repository } from './repository.js';
import { assessDeal } from './scoring.js';
import { saveAssessmentContext } from './assessment-context.js';
import { recordAssessmentHistory } from './enterprise-analytics-v2.js';
import { policyDimensionPropertyNames } from './policy-dimensions.js';
import { resolveSegmentedRulesForDeal } from './policy-runtime.js';
import { buildBackgroundAssessmentEvidence } from './assessment-service.js';
import { buildCommercialAssessment } from './commercial-assessment.js';
import { persistDecisionSnapshot } from './decision-snapshot.js';
import type { Env, RequestIdentity } from './types.js';

export const BACKGROUND_MAX_REQUESTS_PER_DEAL = 40;
const MAX_DEALS_PER_RUN = 3;
const MAX_ATTEMPTS = 5;
type Settings = { portal_id: string; enabled: number; refresh_hours: number; daily_request_limit: number; version: number };
type Candidate = { deal_id: string; status: string; attempts: number };

export function backgroundSettings(value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new AppError(400, 'background_settings_invalid', 'Provide background enrichment settings.');
  const input = value as Record<string, unknown>;
  if (Object.keys(input).some(key => !['enabled','refreshHours','dailyRequestLimit'].includes(key))
    || typeof input.enabled !== 'boolean' || !Number.isInteger(input.refreshHours)
    || Number(input.refreshHours) < 1 || Number(input.refreshHours) > 72
    || !Number.isInteger(input.dailyRequestLimit) || Number(input.dailyRequestLimit) < 100 || Number(input.dailyRequestLimit) > 10000) {
    throw new AppError(400, 'background_settings_invalid', 'Use an explicit enabled flag, 1–72 refresh hours and 100–10,000 requests per UTC day.');
  }
  return { enabled: input.enabled, refreshHours: Number(input.refreshHours), dailyRequestLimit: Number(input.dailyRequestLimit) };
}

async function requireControl(env: Env, identity: RequestIdentity) {
  if (!identity.userId?.trim() && !identity.userEmail?.trim()) throw new AppError(403, 'background_identity_required', 'An identified administrator is required.');
  await requireCommercialTier(env, identity.portalId, 'enterprise');
  // A resource-less check intentionally requires portal-wide access here.
  await requireEnterprisePermission(env, identity, 'scan.run');
}

export async function backgroundIntelligenceStatus(env: Env, identity: RequestIdentity) {
  await requireControl(env, identity);
  const settings = await env.DB.prepare('SELECT enabled, refresh_hours, daily_request_limit, version, last_run_at, next_run_at FROM background_intelligence_settings WHERE portal_id = ?')
    .bind(identity.portalId).first<Record<string, unknown>>();
  const usage = await env.DB.prepare(`SELECT request_count FROM background_intelligence_usage WHERE portal_id = ? AND usage_date = (NOW() AT TIME ZONE 'UTC')::date`)
    .bind(identity.portalId).first<{ request_count: number }>();
  const jobs = await env.DB.prepare(`SELECT status, COUNT(*)::integer AS count FROM background_intelligence_jobs WHERE portal_id = ? GROUP BY status`).bind(identity.portalId).all();
  const coverage = await env.DB.prepare(`SELECT COUNT(*)::integer AS open_deals,
    COUNT(*) FILTER (WHERE s.assessment_at = a.assessed_at AND s.generated_at::timestamptz >= NOW() - INTERVAL '24 hours')::integer AS recent_briefs
    FROM deal_assessments a LEFT JOIN deal_decision_snapshots s ON s.portal_id = a.portal_id AND s.deal_id = a.deal_id
    WHERE a.portal_id = ? AND a.is_closed = 0`).bind(identity.portalId).first();
  return { settings: { enabled: settings?.enabled === 1, refreshHours: Number(settings?.refresh_hours ?? 24),
    dailyRequestLimit: Number(settings?.daily_request_limit ?? 1000), version: Number(settings?.version ?? 0) },
    lastRunAt: settings?.last_run_at ?? null, nextRunAt: settings?.next_run_at ?? null,
    requestsToday: Number(usage?.request_count ?? 0), jobs: jobs.results ?? [], coverage,
    semantics: { optIn: true, noCrmMutation: true, noNotification: true, budgetDay: 'UTC',
      maxDealsPerRun: MAX_DEALS_PER_RUN, refreshIntervalIsTargetNotGuarantee: true } };
}

export async function saveBackgroundIntelligenceSettings(env: Env, identity: RequestIdentity, value: unknown) {
  await requireControl(env, identity);
  const settings = backgroundSettings(value);
  await env.DB.prepare(`INSERT INTO background_intelligence_settings
    (portal_id, enabled, refresh_hours, daily_request_limit, updated_by_user_id, updated_by_email)
    VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (portal_id) DO UPDATE SET
      enabled = excluded.enabled, refresh_hours = excluded.refresh_hours,
      daily_request_limit = excluded.daily_request_limit, version = background_intelligence_settings.version + 1,
      next_run_at = NOW(), lease_token = NULL, lease_expires_at = NULL, updated_at = NOW(),
      updated_by_user_id = excluded.updated_by_user_id, updated_by_email = excluded.updated_by_email`)
    .bind(identity.portalId, settings.enabled ? 1 : 0, settings.refreshHours, settings.dailyRequestLimit, identity.userId, identity.userEmail).run();
  if (!settings.enabled) await env.DB.prepare(`UPDATE background_intelligence_jobs SET status = 'cancelled', lease_token = NULL
    WHERE portal_id = ? AND status IN ('queued','retry','processing')`).bind(identity.portalId).run();
  await new Repository(env).audit(identity.portalId, identity.userId, identity.userEmail, 'background_intelligence.settings_changed', settings);
  return backgroundIntelligenceStatus(env, identity);
}

export async function retryBackgroundIntelligence(env: Env, identity: RequestIdentity) {
  await requireControl(env, identity);
  const result = await env.DB.prepare(`UPDATE background_intelligence_jobs SET status = 'queued', attempts = 0,
    available_at = NOW(), last_error_code = NULL WHERE portal_id = ? AND status = 'failed'
    RETURNING deal_id`).bind(identity.portalId).all();
  await new Repository(env).audit(identity.portalId, identity.userId, identity.userEmail, 'background_intelligence.retry_requested', { count: result.results?.length ?? 0 });
  return { queued: result.results?.length ?? 0 };
}

/** All provider attempts, including OAuth refresh and rejected calls, consume the separate budget. */
export function backgroundBudgetQuery(portalId: string, version: number, lease: string) {
  return { params: [portalId, version, lease, portalId], sql: `WITH eligible AS (
    SELECT s.daily_request_limit FROM background_intelligence_settings s JOIN tenants t ON t.portal_id = s.portal_id
    WHERE s.portal_id = ? AND s.enabled = 1 AND s.version = ? AND s.lease_token = ?
      AND s.lease_expires_at > clock_timestamp() AND t.status = 'active'
  ) INSERT INTO background_intelligence_usage (portal_id, usage_date, request_count)
    SELECT ?, (clock_timestamp() AT TIME ZONE 'UTC')::date, 1 FROM eligible
    ON CONFLICT (portal_id, usage_date) DO UPDATE SET request_count = background_intelligence_usage.request_count + 1
    WHERE background_intelligence_usage.request_count < (SELECT daily_request_limit FROM eligible)
    RETURNING request_count` };
}

export function backgroundReadAllowed(path: string, method: string): boolean {
  if (path === '/oauth/v1/token') return method === 'POST';
  if (!/^\/crm\/(?:v[34]\/(?:objects|pipelines|properties|associations)\/|(?:objects|pipelines|associations)\/2026-03\/)/.test(path)) return false;
  if (/[\\\s#]/.test(path) || path.includes('..')) return false;
  if (method === 'GET') return true;
  return method === 'POST' && /\/(?:batch\/read|search)$/.test(path);
}

export function backgroundRequestPolicy(env: Env, settings: Settings, lease: string, now = Date.now()) {
  let requests = 0, fatal: AppError | null = null;
  // Shared promise serializes the pacing of optional parallel enrichment loaders.
  let gate: Promise<void> = Promise.resolve();
  const deadlineAt = now + 60_000;
  const policy: HubSpotRequestPolicy = { deadlineAt, disableAuthRetry: true,
    async beforeRequest(path, method) {
      const admission = gate.then(async () => {
        if (fatal) throw fatal;
        if (!backgroundReadAllowed(path, method)) throw new AppError(403, 'background_write_blocked', 'Background intelligence permits CRM reads only.');
        if (++requests > BACKGROUND_MAX_REQUESTS_PER_DEAL || Date.now() >= deadlineAt) {
          throw new AppError(429, 'background_request_limit', 'Background enrichment reached its per-deal request boundary.');
        }
        const query = backgroundBudgetQuery(settings.portal_id, settings.version, lease);
        const reserved = await env.DB.prepare(query.sql).bind(...query.params).first();
        if (!reserved) {
          await currentLease(env, settings, lease);
          throw new AppError(429, 'background_budget_exhausted', 'The background request budget is exhausted.');
        }
        // Limit this worker to <4 requests/second, including metadata search calls.
        await new Promise(resolve => setTimeout(resolve, 300));
      });
      gate = admission.catch(error => { fatal = error instanceof AppError ? error : new AppError(503, 'background_budget_unavailable', 'Background request accounting is unavailable.'); });
      await admission;
    },
    afterResponse(status) {
      if ([401,429].includes(status)) fatal = new AppError(status, status === 429 ? 'hubspot_rate_limited' : 'hubspot_reauthorization_required', 'HubSpot access must recover before enrichment continues.');
    },
  };
  return { policy, requestCount: () => Math.min(requests, BACKGROUND_MAX_REQUESTS_PER_DEAL),
    assertHealthy() { if (fatal) throw fatal; if (Date.now() >= deadlineAt) throw new AppError(408, 'background_deadline', 'Background enrichment timed out.'); } };
}

async function currentLease(env: Env, settings: Settings, lease: string) {
  const row = await env.DB.prepare(`SELECT s.portal_id FROM background_intelligence_settings s JOIN tenants t ON t.portal_id = s.portal_id
    WHERE s.portal_id = ? AND s.enabled = 1 AND s.version = ? AND s.lease_token = ?
      AND s.lease_expires_at > clock_timestamp() AND t.status = 'active'`)
    .bind(settings.portal_id, settings.version, lease).first();
  if (!row) throw new AppError(409, 'background_cancelled', 'Background enrichment configuration changed.');
}

async function enrichJob(env: Env, settings: Settings, lease: string, dealId: string) {
  const budget = backgroundRequestPolicy(env, settings, lease);
  const client = await HubSpotClient.forPortal(env, settings.portal_id, budget.policy);
  const repository = new Repository(env);
  const dimensions = await policyDimensionPropertyNames(env, settings.portal_id);
  const observedAt = Date.now();
  const deal = await client.getDeal(dealId, undefined, dimensions);
  if (!deal.stage) throw new AppError(409, 'background_stage_unavailable', 'Pipeline metadata is required before a background assessment.');
  const policy = await resolveSegmentedRulesForDeal(env, settings.portal_id, client.settings.rules, deal);
  const assessment = assessDeal(deal, policy.rules, observedAt);
  let payload: Record<string, unknown> = { ...assessment };
  if (!assessment.isClosed) {
    payload = await buildBackgroundAssessmentEvidence(env, settings.portal_id, deal, assessment, policy.rules, client);
    payload = await buildCommercialAssessment(env, settings.portal_id, dealId, payload, client);
  }
  budget.assertHealthy();
  await currentLease(env, settings, lease);
  await requireCommercialTier(env, settings.portal_id, 'enterprise');
  if (!await repository.saveAssessment(settings.portal_id, assessment)) {
    throw new AppError(409, 'background_superseded', 'A newer assessment already exists.');
  }
  await saveAssessmentContext(env, settings.portal_id, assessment);
  await recordAssessmentHistory(env, settings.portal_id, assessment, { trigger: 'background_intelligence', properties: deal.properties, policyId: policy.policyId });
  await currentLease(env, settings, lease);
  const snapshotAccepted = assessment.isClosed ? false : await persistDecisionSnapshot(env, settings.portal_id, dealId, payload);
  if (!assessment.isClosed && !snapshotAccepted) throw new AppError(409, 'background_snapshot_superseded', 'The brief was superseded before persistence.');
  return { status: assessment.isClosed ? 'cancelled' : 'completed', assessmentAt: assessment.assessedAt,
    requestCount: budget.requestCount() };
}

export async function runBackgroundIntelligence(env: Env): Promise<void> {
  // One portal per message and one worker per portal; fairness uses the oldest due time.
  const rows = await env.DB.prepare(`SELECT s.portal_id FROM background_intelligence_settings s JOIN tenants t ON t.portal_id = s.portal_id
    WHERE s.enabled = 1 AND t.status = 'active' AND s.next_run_at <= NOW()
      AND (s.lease_expires_at IS NULL OR s.lease_expires_at <= NOW())
    ORDER BY s.next_run_at, s.portal_id LIMIT 5`).all<{ portal_id: string }>();
  for (const candidate of rows.results ?? []) {
    const lease = crypto.randomUUID();
    const settings = await env.DB.prepare(`UPDATE background_intelligence_settings SET lease_token = ?,
      lease_expires_at = NOW() + INTERVAL '5 minutes', last_run_at = NOW(), next_run_at = NOW() + INTERVAL '15 minutes'
      WHERE portal_id = ? AND enabled = 1 AND next_run_at <= NOW()
        AND (lease_expires_at IS NULL OR lease_expires_at <= NOW())
      RETURNING portal_id, enabled, refresh_hours, daily_request_limit, version`).bind(lease, candidate.portal_id).first<Settings>();
    if (!settings) continue;
    try {
      await requireCommercialTier(env, settings.portal_id, 'enterprise');
      await env.DB.prepare(`INSERT INTO background_intelligence_jobs (portal_id, deal_id, status)
        SELECT a.portal_id, a.deal_id, 'queued' FROM deal_assessments a
        WHERE a.portal_id = ? AND a.is_closed = 0
        AND NOT EXISTS (SELECT 1 FROM background_intelligence_jobs j WHERE j.portal_id = a.portal_id AND j.deal_id = a.deal_id)
        ORDER BY CASE WHEN a.status = 'critical' THEN 0 ELSE 1 END, a.assessed_at, a.deal_id LIMIT 50
        ON CONFLICT (portal_id, deal_id) DO NOTHING`).bind(settings.portal_id).run();
      const jobs = await env.DB.prepare(`SELECT j.deal_id, j.status, j.attempts FROM background_intelligence_jobs j
        JOIN deal_assessments a ON a.portal_id = j.portal_id AND a.deal_id = j.deal_id
        WHERE j.portal_id = ? AND a.is_closed = 0 AND j.available_at <= NOW()
          AND (j.status IN ('queued','retry','cancelled')
            OR (j.status = 'processing' AND j.started_at < NOW() - INTERVAL '5 minutes')
            OR (j.status = 'completed' AND j.completed_at <= NOW() - (?::integer * INTERVAL '1 hour')))
        ORDER BY j.completed_at NULLS FIRST, CASE WHEN a.status = 'critical' THEN 0 ELSE 1 END, j.available_at, j.deal_id LIMIT 3`)
        .bind(settings.portal_id, settings.refresh_hours).all<Candidate>();
      for (const job of jobs.results ?? []) {
        await currentLease(env, settings, lease);
        const attempts = ['completed','cancelled'].includes(job.status) ? 1 : Number(job.attempts) + 1;
        const claimed = await env.DB.prepare(`UPDATE background_intelligence_jobs SET status = 'processing', started_at = NOW(),
          lease_token = ?, attempts = ? WHERE portal_id = ? AND deal_id = ? AND EXISTS (
            SELECT 1 FROM background_intelligence_settings WHERE portal_id = ? AND enabled = 1
              AND version = ? AND lease_token = ? AND lease_expires_at > clock_timestamp()) RETURNING deal_id`)
          .bind(lease, attempts, settings.portal_id, job.deal_id, settings.portal_id, settings.version, lease).first();
        if (!claimed) break;
        try {
          const result = await enrichJob(env, settings, lease, job.deal_id);
          await env.DB.prepare(`UPDATE background_intelligence_jobs SET status = ?, completed_at = NOW(),
            assessment_at = ?, request_count = ?, last_error_code = NULL, lease_token = NULL,
            available_at = NOW() + (?::integer * INTERVAL '1 hour')
            WHERE portal_id = ? AND deal_id = ? AND lease_token = ?`)
            .bind(result.status, result.assessmentAt, result.requestCount, settings.refresh_hours, settings.portal_id, job.deal_id, lease).run();
        } catch (error) {
          const code = error instanceof AppError ? error.code : 'background_enrichment_failed';
          const budget = code === 'background_budget_exhausted';
          await env.DB.prepare(`UPDATE background_intelligence_jobs SET status = ?, last_error_code = ?, lease_token = NULL,
            available_at = CASE WHEN ? THEN ((NOW() AT TIME ZONE 'UTC')::date + 1)::timestamp AT TIME ZONE 'UTC'
              ELSE NOW() + (?::integer * INTERVAL '1 second') END
            WHERE portal_id = ? AND deal_id = ? AND lease_token = ?`)
            .bind(code === 'background_cancelled' ? 'cancelled' : budget || attempts < MAX_ATTEMPTS ? 'retry' : 'failed', code, budget,
              Math.min(3600, 120 * 2 ** Math.min(attempts, 5)), settings.portal_id, job.deal_id, lease).run();
          if (budget || code === 'hubspot_rate_limited' || code === 'hubspot_reauthorization_required') break;
        }
      }
    } finally {
      await env.DB.prepare(`UPDATE background_intelligence_settings SET lease_token = NULL, lease_expires_at = NULL
        WHERE portal_id = ? AND lease_token = ?`).bind(settings.portal_id, lease).run();
    }
    return;
  }
}

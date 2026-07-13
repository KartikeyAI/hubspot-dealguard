import { DEFAULT_SETTINGS, PLAN_LIMITS } from './config.js';
import { decryptSecret, encryptSecret } from './crypto.js';
import { AppError } from './errors.js';
import type {
  D1Database,
  DealAssessment,
  DashboardSummary,
  Env,
  HubSpotTokenInfo,
  HubSpotTokenResponse,
  PlanId,
  RequestIdentity,
  ScanStatus,
  TenantRow,
  TenantSettings,
} from './types.js';
import { parseSettings } from './validation.js';

export interface TenantCredentials {
  tenant: TenantRow;
  accessToken: string;
  refreshToken: string;
  settings: TenantSettings;
}

export class Repository {
  constructor(private readonly env: Env) {}

  async createOAuthState(stateHash: string, returnTo: string | null): Promise<void> {
    const now = new Date();
    const expires = new Date(now.getTime() + 10 * 60_000);
    await this.env.DB.prepare(
      `INSERT INTO oauth_states (state_hash, return_to, expires_at, created_at)
       VALUES (?, ?, ?, ?)`
    ).bind(stateHash, returnTo, expires.toISOString(), now.toISOString()).run();
  }

  async consumeOAuthState(stateHash: string): Promise<{ returnTo: string | null }> {
    const row = await this.env.DB.prepare(
      `SELECT return_to, expires_at FROM oauth_states WHERE state_hash = ?`
    ).bind(stateHash).first<{ return_to: string | null; expires_at: string }>();
    if (!row) throw new AppError(400, 'invalid_oauth_state', 'OAuth state is invalid or already used.');
    await this.env.DB.prepare(`DELETE FROM oauth_states WHERE state_hash = ?`).bind(stateHash).run();
    if (Date.parse(row.expires_at) < Date.now()) {
      throw new AppError(400, 'expired_oauth_state', 'OAuth state has expired. Start the installation again.');
    }
    return { returnTo: row.return_to };
  }

  async upsertTenant(tokens: HubSpotTokenResponse, info: HubSpotTokenInfo): Promise<void> {
    const access = await encryptSecret(tokens.access_token, this.env.TOKEN_ENCRYPTION_KEY);
    const refresh = await encryptSecret(tokens.refresh_token, this.env.TOKEN_ENCRYPTION_KEY);
    const now = new Date();
    const expiresAt = new Date(now.getTime() + Math.max(60, tokens.expires_in - 30) * 1000);
    const nextScanAt = now;
    await this.env.DB.prepare(
      `INSERT INTO tenants (
        portal_id, app_id, account_name, hub_domain, installer_email,
        access_token_cipher, access_token_iv, refresh_token_cipher, refresh_token_iv,
        token_expires_at, scopes_json, settings_json, plan, status,
        installed_at, updated_at, next_scan_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'free', 'active', ?, ?, ?)
      ON CONFLICT(portal_id) DO UPDATE SET
        app_id = excluded.app_id,
        hub_domain = excluded.hub_domain,
        installer_email = excluded.installer_email,
        access_token_cipher = excluded.access_token_cipher,
        access_token_iv = excluded.access_token_iv,
        refresh_token_cipher = excluded.refresh_token_cipher,
        refresh_token_iv = excluded.refresh_token_iv,
        token_expires_at = excluded.token_expires_at,
        scopes_json = excluded.scopes_json,
        status = 'active',
        updated_at = excluded.updated_at,
        next_scan_at = excluded.next_scan_at`
    ).bind(
      String(info.hub_id),
      String(info.app_id),
      null,
      info.hub_domain || null,
      info.user || null,
      access.cipher,
      access.iv,
      refresh.cipher,
      refresh.iv,
      expiresAt.toISOString(),
      JSON.stringify(info.scopes ?? []),
      JSON.stringify(DEFAULT_SETTINGS),
      now.toISOString(),
      now.toISOString(),
      nextScanAt.toISOString(),
    ).run();
    await this.audit(String(info.hub_id), null, info.user || null, 'app.installed', { scopes: info.scopes ?? [] });
  }

  async getTenant(portalId: string): Promise<TenantRow> {
    const tenant = await this.env.DB.prepare(`SELECT * FROM tenants WHERE portal_id = ? AND status != 'deleted'`)
      .bind(portalId)
      .first<TenantRow>();
    if (!tenant) throw new AppError(404, 'installation_not_found', 'DealGuard is not connected to this HubSpot account.');
    return tenant;
  }

  async getCredentials(portalId: string): Promise<TenantCredentials> {
    const tenant = await this.getTenant(portalId);
    return {
      tenant,
      accessToken: await decryptSecret(tenant.access_token_cipher, tenant.access_token_iv, this.env.TOKEN_ENCRYPTION_KEY),
      refreshToken: await decryptSecret(tenant.refresh_token_cipher, tenant.refresh_token_iv, this.env.TOKEN_ENCRYPTION_KEY),
      settings: parseSettings(JSON.parse(tenant.settings_json || '{}'), tenant.plan),
    };
  }

  async updateTokens(portalId: string, tokens: HubSpotTokenResponse): Promise<void> {
    const access = await encryptSecret(tokens.access_token, this.env.TOKEN_ENCRYPTION_KEY);
    const refresh = await encryptSecret(tokens.refresh_token, this.env.TOKEN_ENCRYPTION_KEY);
    const now = new Date();
    const expiresAt = new Date(now.getTime() + Math.max(60, tokens.expires_in - 30) * 1000);
    await this.env.DB.prepare(
      `UPDATE tenants SET access_token_cipher = ?, access_token_iv = ?, refresh_token_cipher = ?, refresh_token_iv = ?,
       token_expires_at = ?, updated_at = ?, status = 'active' WHERE portal_id = ?`
    ).bind(access.cipher, access.iv, refresh.cipher, refresh.iv, expiresAt.toISOString(), now.toISOString(), portalId).run();
  }

  async markDisconnected(portalId: string, reason: string): Promise<void> {
    await this.env.DB.prepare(`UPDATE tenants SET status = 'disconnected', updated_at = ? WHERE portal_id = ?`)
      .bind(new Date().toISOString(), portalId)
      .run();
    await this.audit(portalId, null, null, 'app.disconnected', { reason });
  }

  async saveSettings(identity: RequestIdentity, value: unknown): Promise<TenantSettings> {
    const tenant = await this.getTenant(identity.portalId);
    const settings = parseSettings(value, tenant.plan);
    await this.env.DB.prepare(`UPDATE tenants SET settings_json = ?, updated_at = ? WHERE portal_id = ?`)
      .bind(JSON.stringify(settings), new Date().toISOString(), identity.portalId)
      .run();
    await this.audit(identity.portalId, identity.userId, identity.userEmail, 'settings.updated', settings);
    return settings;
  }

  async setPlan(portalId: string, plan: PlanId): Promise<void> {
    if (!PLAN_LIMITS[plan]) throw new AppError(400, 'invalid_plan', 'Unknown plan.');
    const tenant = await this.getTenant(portalId);
    const settings = parseSettings(JSON.parse(tenant.settings_json), plan);
    await this.env.DB.prepare(`UPDATE tenants SET plan = ?, settings_json = ?, updated_at = ? WHERE portal_id = ?`)
      .bind(plan, JSON.stringify(settings), new Date().toISOString(), portalId)
      .run();
    await this.audit(portalId, null, null, 'plan.changed', { plan });
  }

  async startScan(portalId: string, trigger: 'manual' | 'scheduled' | 'install'): Promise<string> {
    const activeSince = new Date(Date.now() - 30 * 60_000).toISOString();
    const active = await this.env.DB.prepare(
      `SELECT id FROM scan_runs WHERE portal_id = ? AND status = 'running' AND started_at >= ? LIMIT 1`
    ).bind(portalId, activeSince).first<{ id: string }>();
    if (active) throw new AppError(409, 'scan_already_running', 'A DealGuard portal scan is already running.');
    const id = crypto.randomUUID();
    await this.env.DB.prepare(
      `INSERT INTO scan_runs (id, portal_id, trigger_type, status, started_at) VALUES (?, ?, ?, 'running', ?)`
    ).bind(id, portalId, trigger, new Date().toISOString()).run();
    return id;
  }

  async completeScan(
    scanId: string,
    portalId: string,
    plan: PlanId,
    counts: { scanned: number; ready: number; atRisk: number; critical: number; incompleteHandoffs: number },
  ): Promise<void> {
    const now = new Date();
    const nextScan = new Date(now.getTime() + PLAN_LIMITS[plan].minScanIntervalMinutes * 60_000);
    await this.env.DB.batch([
      this.env.DB.prepare(
        `UPDATE scan_runs SET status = 'completed', completed_at = ?, scanned_count = ?, ready_count = ?, at_risk_count = ?,
         critical_count = ?, incomplete_handoffs = ? WHERE id = ?`
      ).bind(now.toISOString(), counts.scanned, counts.ready, counts.atRisk, counts.critical, counts.incompleteHandoffs, scanId),
      this.env.DB.prepare(
        `UPDATE tenants SET last_scan_at = ?, next_scan_at = ?, updated_at = ? WHERE portal_id = ?`
      ).bind(now.toISOString(), nextScan.toISOString(), now.toISOString(), portalId),
    ]);
  }

  async failScan(scanId: string, portalId: string, error: string): Promise<void> {
    const now = new Date();
    await this.env.DB.batch([
      this.env.DB.prepare(`UPDATE scan_runs SET status = 'failed', completed_at = ?, error_message = ? WHERE id = ?`)
        .bind(now.toISOString(), error.slice(0, 1000), scanId),
      this.env.DB.prepare(`UPDATE tenants SET next_scan_at = ?, updated_at = ? WHERE portal_id = ?`)
        .bind(new Date(now.getTime() + 60 * 60_000).toISOString(), now.toISOString(), portalId),
    ]);
  }

  async saveAssessment(portalId: string, assessment: DealAssessment): Promise<void> {
    await this.env.DB.prepare(
      `INSERT INTO deal_assessments (
        portal_id, deal_id, deal_name, pipeline_label, stage_label, score, grade, status, issues_json, readiness_summary,
        is_closed, is_won, handoff_eligible, assessed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(portal_id, deal_id) DO UPDATE SET
        deal_name = excluded.deal_name,
        pipeline_label = excluded.pipeline_label,
        stage_label = excluded.stage_label,
        score = excluded.score,
        grade = excluded.grade,
        status = excluded.status,
        issues_json = excluded.issues_json,
        readiness_summary = excluded.readiness_summary,
        is_closed = excluded.is_closed,
        is_won = excluded.is_won,
        handoff_eligible = excluded.handoff_eligible,
        assessed_at = excluded.assessed_at`
    ).bind(
      portalId,
      assessment.dealId,
      assessment.dealName,
      assessment.pipelineLabel,
      assessment.stageLabel,
      assessment.score,
      assessment.grade,
      assessment.status,
      JSON.stringify(assessment.issues),
      assessment.readinessSummary,
      assessment.isClosed ? 1 : 0,
      assessment.isWon ? 1 : 0,
      assessment.handoffEligible ? 1 : 0,
      assessment.assessedAt,
    ).run();
  }

  async getAssessment(portalId: string, dealId: string): Promise<(DealAssessment & { reviewedAt: string | null; handoffStatus: string | null }) | null> {
    const row = await this.env.DB.prepare(
      `SELECT a.*, r.reviewed_at, h.status AS handoff_status
       FROM deal_assessments a
       LEFT JOIN deal_reviews r ON r.portal_id = a.portal_id AND r.deal_id = a.deal_id
       LEFT JOIN handoffs h ON h.portal_id = a.portal_id AND h.deal_id = a.deal_id
       WHERE a.portal_id = ? AND a.deal_id = ?`
    ).bind(portalId, dealId).first<Record<string, unknown>>();
    if (!row) return null;
    return {
      dealId: String(row.deal_id),
      dealName: String(row.deal_name),
      pipelineLabel: String(row.pipeline_label),
      stageLabel: String(row.stage_label),
      score: Number(row.score),
      grade: row.grade as DealAssessment['grade'],
      status: row.status as DealAssessment['status'],
      issues: JSON.parse(String(row.issues_json)) as DealAssessment['issues'],
      readinessSummary: String(row.readiness_summary),
      isClosed: Boolean(row.is_closed),
      isWon: Boolean(row.is_won),
      handoffEligible: Boolean(row.handoff_eligible),
      assessedAt: String(row.assessed_at),
      reviewedAt: row.reviewed_at ? String(row.reviewed_at) : null,
      handoffStatus: row.handoff_status ? String(row.handoff_status) : null,
    };
  }

  async markReviewed(identity: RequestIdentity, dealId: string): Promise<void> {
    const now = new Date().toISOString();
    await this.env.DB.prepare(
      `INSERT INTO deal_reviews (portal_id, deal_id, reviewed_at, reviewed_by_user_id, reviewed_by_email)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(portal_id, deal_id) DO UPDATE SET reviewed_at = excluded.reviewed_at,
       reviewed_by_user_id = excluded.reviewed_by_user_id, reviewed_by_email = excluded.reviewed_by_email`
    ).bind(identity.portalId, dealId, now, identity.userId, identity.userEmail).run();
    await this.audit(identity.portalId, identity.userId, identity.userEmail, 'deal.reviewed', { dealId });
  }

  async confirmHandoff(identity: RequestIdentity, dealId: string, assessment: DealAssessment): Promise<void> {
    if (!assessment.isWon) throw new AppError(409, 'handoff_not_eligible', 'Only closed-won deals can be confirmed for handoff.');
    if (assessment.status === 'critical') {
      throw new AppError(409, 'handoff_blocked', 'Resolve critical readiness issues before confirming handoff.', {
        issues: assessment.issues.filter((item) => item.severity === 'critical'),
      });
    }
    const now = new Date().toISOString();
    await this.env.DB.prepare(
      `INSERT INTO handoffs (portal_id, deal_id, status, confirmed_at, confirmed_by_user_id, confirmed_by_email, summary)
       VALUES (?, ?, 'confirmed', ?, ?, ?, ?)
       ON CONFLICT(portal_id, deal_id) DO UPDATE SET status = 'confirmed', confirmed_at = excluded.confirmed_at,
       confirmed_by_user_id = excluded.confirmed_by_user_id, confirmed_by_email = excluded.confirmed_by_email,
       summary = excluded.summary`
    ).bind(identity.portalId, dealId, now, identity.userId, identity.userEmail, assessment.readinessSummary).run();
    await this.audit(identity.portalId, identity.userId, identity.userEmail, 'handoff.confirmed', { dealId, score: assessment.score });
  }

  async dashboard(portalId: string): Promise<DashboardSummary> {
    const tenant = await this.getTenant(portalId);
    const counts = await this.env.DB.prepare(
      `SELECT COUNT(*) AS total,
       SUM(CASE WHEN status = 'ready' THEN 1 ELSE 0 END) AS ready,
       SUM(CASE WHEN status = 'at_risk' THEN 1 ELSE 0 END) AS at_risk,
       SUM(CASE WHEN status = 'critical' THEN 1 ELSE 0 END) AS critical,
       AVG(score) AS average_score,
       SUM(CASE WHEN is_won = 1 AND (h.status IS NULL OR h.status != 'confirmed') THEN 1 ELSE 0 END) AS incomplete_handoffs
       FROM deal_assessments a
       LEFT JOIN handoffs h ON h.portal_id = a.portal_id AND h.deal_id = a.deal_id
       WHERE a.portal_id = ?`
    ).bind(portalId).first<Record<string, unknown>>();

    const issueRows = await this.env.DB.prepare(
      `SELECT issues_json FROM deal_assessments WHERE portal_id = ? ORDER BY assessed_at DESC LIMIT 5000`
    ).bind(portalId).all<{ issues_json: string }>();
    const issueMap = new Map<string, { label: string; count: number }>();
    for (const row of issueRows.results ?? []) {
      const issues = JSON.parse(row.issues_json) as Array<{ code: string; label: string }>;
      for (const item of issues) {
        const current = issueMap.get(item.code) ?? { label: item.label, count: 0 };
        current.count += 1;
        issueMap.set(item.code, current);
      }
    }

    const problemRows = await this.env.DB.prepare(
      `SELECT deal_id, deal_name, pipeline_label, stage_label, score, status, readiness_summary, assessed_at
       FROM deal_assessments
       WHERE portal_id = ? AND status IN ('critical', 'at_risk')
       ORDER BY CASE status WHEN 'critical' THEN 0 ELSE 1 END, score ASC, assessed_at DESC
       LIMIT 12`
    ).bind(portalId).all<Record<string, unknown>>();

    const latestScanRow = await this.env.DB.prepare(
      `SELECT id, trigger_type, status, started_at, completed_at, scanned_count, error_message
       FROM scan_runs WHERE portal_id = ? ORDER BY started_at DESC LIMIT 1`
    ).bind(portalId).first<Record<string, unknown>>();

    return {
      plan: tenant.plan,
      totalDeals: Number(counts?.total ?? 0),
      readyDeals: Number(counts?.ready ?? 0),
      atRiskDeals: Number(counts?.at_risk ?? 0),
      criticalDeals: Number(counts?.critical ?? 0),
      averageScore: Math.round(Number(counts?.average_score ?? 0)),
      incompleteHandoffs: Number(counts?.incomplete_handoffs ?? 0),
      lastScanAt: tenant.last_scan_at,
      nextScanAt: tenant.next_scan_at,
      topIssues: [...issueMap.entries()]
        .map(([code, value]) => ({ code, ...value }))
        .sort((a, b) => b.count - a.count)
        .slice(0, 8),
      problemDeals: (problemRows.results ?? []).map((row) => ({
        dealId: String(row.deal_id),
        dealName: String(row.deal_name),
        pipelineLabel: String(row.pipeline_label),
        stageLabel: String(row.stage_label),
        score: Number(row.score),
        status: row.status as DashboardSummary['problemDeals'][number]['status'],
        readinessSummary: String(row.readiness_summary),
        assessedAt: String(row.assessed_at),
      })),
      latestScan: latestScanRow ? {
        id: String(latestScanRow.id),
        trigger: latestScanRow.trigger_type as ScanStatus['trigger'],
        status: latestScanRow.status as ScanStatus['status'],
        startedAt: String(latestScanRow.started_at),
        completedAt: latestScanRow.completed_at ? String(latestScanRow.completed_at) : null,
        scannedCount: Number(latestScanRow.scanned_count ?? 0),
        errorMessage: latestScanRow.error_message ? String(latestScanRow.error_message) : null,
      } : null,
    };
  }

  async listDueTenants(limit = 20): Promise<TenantRow[]> {
    const result = await this.env.DB.prepare(
      `SELECT * FROM tenants WHERE status = 'active' AND next_scan_at <= ? ORDER BY next_scan_at ASC LIMIT ?`
    ).bind(new Date().toISOString(), limit).all<TenantRow>();
    return result.results ?? [];
  }

  async dueDigestTenants(limit = 20): Promise<TenantRow[]> {
    const result = await this.env.DB.prepare(
      `SELECT * FROM tenants WHERE status = 'active' ORDER BY COALESCE(last_digest_at, installed_at) ASC LIMIT ?`
    ).bind(limit).all<TenantRow>();
    return result.results ?? [];
  }

  async markDigestSent(portalId: string): Promise<void> {
    await this.env.DB.prepare(`UPDATE tenants SET last_digest_at = ?, updated_at = ? WHERE portal_id = ?`)
      .bind(new Date().toISOString(), new Date().toISOString(), portalId)
      .run();
  }

  async audit(portalId: string, userId: string | null, userEmail: string | null, action: string, metadata: unknown): Promise<void> {
    await this.env.DB.prepare(
      `INSERT INTO audit_events (id, portal_id, user_id, user_email, action, metadata_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).bind(crypto.randomUUID(), portalId, userId, userEmail, action, JSON.stringify(metadata ?? {}), new Date().toISOString()).run();
  }

  async softDeletePortal(identity: RequestIdentity): Promise<void> {
    await this.audit(identity.portalId, identity.userId, identity.userEmail, 'data.deleted', {});
    await this.env.DB.batch([
      this.env.DB.prepare(`DELETE FROM deal_assessments WHERE portal_id = ?`).bind(identity.portalId),
      this.env.DB.prepare(`DELETE FROM deal_reviews WHERE portal_id = ?`).bind(identity.portalId),
      this.env.DB.prepare(`DELETE FROM handoffs WHERE portal_id = ?`).bind(identity.portalId),
      this.env.DB.prepare(`DELETE FROM scan_runs WHERE portal_id = ?`).bind(identity.portalId),
      this.env.DB.prepare(`UPDATE tenants SET status = 'deleted', access_token_cipher = '', access_token_iv = '', refresh_token_cipher = '', refresh_token_iv = '', updated_at = ? WHERE portal_id = ?`)
        .bind(new Date().toISOString(), identity.portalId),
    ]);
  }
}

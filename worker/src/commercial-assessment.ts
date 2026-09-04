import { buildCommercialIntegrity } from './commercial-integrity.js';
import { loadCommercialIntegrityData } from './commercial-integrity-data.js';
import {
  COMMERCIAL_LINE_ITEM_SCOPE,
  COMMERCIAL_QUOTE_SCOPE,
  type CommercialAuthorization,
  type CommercialIntegrityIntelligence,
  type CommercialScope,
} from './commercial-integrity-types.js';
import { augmentDealBriefWithCommercialIntegrity } from './deal-brief-commercial.js';
import type { DecisionAction } from './deal-momentum-types.js';
import { HubSpotClient } from './hubspot.js';
import { recordOperationalMetric } from './reliability.js';
import { Repository } from './repository.js';
import type { Env } from './types.js';

const COMMERCIAL_CACHE_TTL_MS = 60_000;
const COMMERCIAL_CACHE_MAX = 500;
const commercialCache = new Map<string, { expiresAt: number; value: Record<string, unknown> }>();
const commercialInFlight = new Map<string, Promise<Record<string, unknown>>>();

function cacheKey(portalId: string, dealId: string): string {
  return `${portalId}:${dealId}`;
}

function putCache(key: string, value: Record<string, unknown>): void {
  if (commercialCache.size >= COMMERCIAL_CACHE_MAX) {
    const oldest = commercialCache.keys().next().value as string | undefined;
    if (oldest) commercialCache.delete(oldest);
  }
  commercialCache.set(key, { expiresAt: Date.now() + COMMERCIAL_CACHE_TTL_MS, value });
}

function parsedScopes(value: string): string[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : [];
  } catch {
    return [];
  }
}

export function commercialAuthorizationFromScopes(scopes: readonly string[]): CommercialAuthorization {
  const requestedScopes: CommercialScope[] = [COMMERCIAL_LINE_ITEM_SCOPE, COMMERCIAL_QUOTE_SCOPE];
  const scopeSet = new Set(scopes);
  const grantedScopes = requestedScopes.filter((scope) => scopeSet.has(scope));
  const missingScopes = requestedScopes.filter((scope) => !scopeSet.has(scope));
  return {
    status: missingScopes.length === 0 ? 'full' : grantedScopes.length === 0 ? 'required' : 'partial',
    requestedScopes,
    grantedScopes,
    missingScopes,
  };
}

export async function commercialAuthorizationForPortal(
  env: Env,
  portalId: string,
): Promise<CommercialAuthorization> {
  const tenant = await new Repository(env).getTenant(portalId);
  return commercialAuthorizationFromScopes(parsedScopes(tenant.scopes_json));
}

function decisionActions(
  current: unknown,
  commercial: CommercialIntegrityIntelligence,
): DecisionAction[] {
  const existing = Array.isArray(current) ? current as DecisionAction[] : [];
  const priorityOrder: Record<DecisionAction['priority'], number> = { high: 0, medium: 1, low: 2 };
  const seen = new Set<string>();
  return [...commercial.commercialActions, ...existing]
    .filter((item) => {
      if (!item || typeof item.code !== 'string' || seen.has(item.code)) return false;
      seen.add(item.code);
      return true;
    })
    .sort((left, right) => priorityOrder[left.priority] - priorityOrder[right.priority])
    .slice(0, 12);
}

async function recordMetric(
  env: Env,
  portalId: string,
  metric: string,
  value: number,
): Promise<void> {
  await recordOperationalMetric(env, {
    portalId,
    service: 'commercial_integrity_enrichment',
    metric,
    value,
  }).catch(() => undefined);
}

async function buildCommercialAssessment(
  env: Env,
  portalId: string,
  dealId: string,
  baseAssessment: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const startedAt = Date.now();
  const tenant = await new Repository(env).getTenant(portalId);
  const grantedScopes = parsedScopes(tenant.scopes_json);
  const client = await HubSpotClient.forPortal(env, portalId);
  try {
    const data = await loadCommercialIntegrityData(client, dealId, grantedScopes);
    const commercial = buildCommercialIntegrity(data);
    const currentIntelligence = baseAssessment.intelligence && typeof baseAssessment.intelligence === 'object'
      ? baseAssessment.intelligence as Record<string, unknown>
      : {};
    const combinedActions = decisionActions(currentIntelligence.decisionActions, commercial);
    const currentBrief = currentIntelligence.dealBrief
      ? { dealBrief: currentIntelligence.dealBrief } as Parameters<typeof augmentDealBriefWithCommercialIntegrity>[0]
      : null;
    const brief = currentBrief
      ? augmentDealBriefWithCommercialIntegrity(currentBrief, commercial, combinedActions)
      : null;
    const value: Record<string, unknown> = {
      ...baseAssessment,
      intelligence: {
        ...currentIntelligence,
        ...commercial,
        decisionActions: combinedActions,
        ...(brief ?? {}),
      },
    };
    await recordMetric(env, portalId, 'success', 1);
    await recordMetric(env, portalId, 'latency_ms', Date.now() - startedAt);
    await recordMetric(env, portalId, 'coverage_percent', commercial.commercialIntegrity.coverage.percent);
    return value;
  } catch (error) {
    console.error(JSON.stringify({
      level: 'warn',
      task: 'commercial_integrity_enrichment',
      portalId,
      dealId,
      error: error instanceof Error ? error.message : String(error),
    }));
    await recordMetric(env, portalId, 'success', 0);
    await recordMetric(env, portalId, 'latency_ms', Date.now() - startedAt);
    return baseAssessment;
  }
}

export async function augmentAssessmentWithCommercialIntegrity(
  env: Env,
  portalId: string,
  dealId: string,
  baseAssessment: Record<string, unknown>,
  force = false,
): Promise<Record<string, unknown>> {
  const key = cacheKey(portalId, dealId);
  if (!force) {
    const cached = commercialCache.get(key);
    if (cached && cached.expiresAt > Date.now()) return cached.value;
    if (cached) commercialCache.delete(key);
    const pending = commercialInFlight.get(key);
    if (pending) return pending;
  } else {
    commercialCache.delete(key);
  }

  const task = buildCommercialAssessment(env, portalId, dealId, baseAssessment);
  commercialInFlight.set(key, task);
  try {
    const value = await task;
    putCache(key, value);
    return value;
  } finally {
    if (commercialInFlight.get(key) === task) commercialInFlight.delete(key);
  }
}

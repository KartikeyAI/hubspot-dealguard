import { AppError } from './errors.js';
import { json } from './http.js';
import { route as routeV9 } from './routes-v9.js';
import type { Env } from './types.js';

const REDACTED_READS: Record<string, Record<string, unknown>> = {
  '/api/v1/enterprise/overview': {
    activePolicy: null,
    health: { status: 'restricted', deadLetters: 0 },
  },
  '/api/v1/enterprise/analytics': {
    current: {},
    trend: [],
    stageAgingHeatmap: [],
    failurePatterns: [],
  },
  '/api/v1/enterprise/roles': { roles: [] },
  '/api/v1/enterprise/change-approvals': { approvals: [] },
  '/api/v1/enterprise/alerts': {
    channels: [],
    routes: [],
    calendars: [],
    escalations: [],
    suppressions: [],
    alerts: [],
  },
  '/api/v1/enterprise/compliance': {
    settings: null,
    legalHolds: [],
    siemDestinations: [],
    exports: [],
  },
  '/api/v1/enterprise/reliability': {
    summary: { status: 'restricted' },
    slos: [],
    synthetics: [],
    incidents: [],
    backups: [],
    restoreTests: [],
  },
  '/api/v1/billing/usage': { usage: [] },
  '/api/v1/enterprise/policy-dimensions': {
    teamProperty: null,
    regionProperty: null,
    dealTypeProperty: null,
  },
};

function redactedPayload(pathname: string): Record<string, unknown> | null {
  const base = REDACTED_READS[pathname];
  return base ? { ...base, redacted: true, reason: 'permission_denied' } : null;
}

export async function route(
  request: Request,
  env: Env,
  ctx: { waitUntil(promise: Promise<unknown>): void },
): Promise<Response> {
  if (request.method !== 'GET') return routeV9(request, env, ctx);
  const pathname = new URL(request.url).pathname;
  const fallback = redactedPayload(pathname);
  if (!fallback) return routeV9(request, env, ctx);

  try {
    return await routeV9(request, env, ctx);
  } catch (error) {
    if (error instanceof AppError && error.status === 403) {
      return json(fallback);
    }
    throw error;
  }
}

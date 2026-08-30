import { sha256Hex } from './crypto.js';
import type { EnterpriseAccessContext } from './enterprise-access.js';
import type {
  RecommendationChannelSummary,
  RecommendationFollowupBatchStatus,
  RecommendationFollowupRoutingMatch,
  RecommendationFollowupScope,
  RecommendationFollowupSeverity,
  RecommendationRouteConfig,
} from './recommendation-operations-types.js';
import { RECOMMENDATION_FOLLOWUP_EVENT } from './recommendation-operations-types.js';

const SEVERITY_RANK = { info: 0, warning: 1, critical: 2 } as const;

export function uniqueStrings(value: unknown, maximum = 100): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value
    .filter((item): item is string => typeof item === 'string' && Boolean(item.trim()))
    .map((item) => item.trim().slice(0, 256)))]
    .slice(0, maximum);
}

export function jsonStrings(value: unknown, maximum = 500): string[] {
  if (Array.isArray(value)) return uniqueStrings(value, maximum);
  if (typeof value !== 'string') return [];
  try {
    return uniqueStrings(JSON.parse(value), maximum);
  } catch {
    return [];
  }
}

export function scopeAllowed(scope: RecommendationFollowupScope, access: EnterpriseAccessContext): boolean {
  const checks: Array<[string[], string | null]> = [
    [access.scope.pipelineIds, scope.pipelineId],
    [access.scope.teamIds, scope.teamId],
    [access.scope.ownerIds, scope.ownerId],
    [access.scope.regionCodes, scope.regionCode],
  ];
  return checks.every(([allowed, actual]) => allowed.length === 0 || Boolean(actual && allowed.includes(actual)));
}

export function routeExplicitlyMatches(
  route: RecommendationRouteConfig,
  scope: RecommendationFollowupScope,
  severity: RecommendationFollowupSeverity,
): boolean {
  if (!route.enabled) return false;
  if (!route.eventTypes.includes(RECOMMENDATION_FOLLOWUP_EVENT)) return false;
  if (SEVERITY_RANK[severity] < SEVERITY_RANK[route.minimumSeverity]) return false;
  const checks: Array<[string[], string | null]> = [
    [route.pipelineIds, scope.pipelineId],
    [route.teamIds, scope.teamId],
    [route.ownerIds, scope.ownerId],
    [route.regionCodes, scope.regionCode],
  ];
  return checks.every(([allowed, actual]) => allowed.length === 0 || Boolean(actual && allowed.includes(actual)));
}

export function localBusinessTime(
  timeZone: string,
  date: Date,
): { weekday: string; hour: number; minute: number; date: string } {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? '';
  return {
    weekday: get('weekday').toLowerCase(),
    hour: Number(get('hour')),
    minute: Number(get('minute')),
    date: `${get('year')}-${get('month')}-${get('day')}`,
  };
}

function clockMinutes(value: string | undefined): number {
  const match = value?.match(/^(\d{2}):(\d{2})$/);
  return match ? Number(match[1]) * 60 + Number(match[2]) : -1;
}

export function inQuietHours(
  calendar: {
    timezone: string;
    weeklySchedule: Record<string, { start?: string; end?: string; enabled?: boolean }>;
    holidays: string[];
  } | null,
  now: Date,
): boolean {
  if (!calendar) return false;
  const local = localBusinessTime(calendar.timezone, now);
  if (calendar.holidays.includes(local.date)) return true;
  const day = calendar.weeklySchedule[local.weekday];
  if (!day?.enabled || !day.start || !day.end) return true;
  const current = local.hour * 60 + local.minute;
  const start = clockMinutes(day.start);
  const end = clockMinutes(day.end);
  return start < 0 || end < 0 || current < start || current >= end;
}

export async function routingMatch(
  input: {
    routes: RecommendationRouteConfig[];
    channels: RecommendationChannelSummary[];
    quietRouteIds: Set<string>;
    scope: RecommendationFollowupScope;
    severity: RecommendationFollowupSeverity;
    recommendationId: string;
    recommendationStatus: string;
    priority: string;
    dueAt: string | null;
    kind: string;
    managerNote: string;
  },
): Promise<RecommendationFollowupRoutingMatch> {
  const channelById = new Map(input.channels.map((channel) => [channel.id, channel]));
  const matched = input.routes
    .filter((route) => routeExplicitlyMatches(route, input.scope, input.severity))
    .filter((route) => !input.quietRouteIds.has(route.id))
    .map((route) => {
      const channelIds = [...new Set(route.channelIds.filter((id) => channelById.has(id)))].sort();
      return {
        id: route.id,
        name: route.name,
        channelIds,
        channelNames: channelIds.map((id) => channelById.get(id)!.name),
      };
    })
    .filter((route) => route.channelIds.length > 0)
    .sort((left, right) => left.id.localeCompare(right.id));
  const routeIds = matched.map((route) => route.id);
  const channelIds = [...new Set(matched.flatMap((route) => route.channelIds))].sort();
  const fingerprint = await sha256Hex(JSON.stringify({
    recommendationId: input.recommendationId,
    recommendationStatus: input.recommendationStatus,
    priority: input.priority,
    dueAt: input.dueAt,
    kind: input.kind,
    severity: input.severity,
    managerNote: input.managerNote,
    scope: input.scope,
    routeIds,
    channelIds,
  }));
  return { routeIds, channelIds, routes: matched, fingerprint, ready: channelIds.length > 0 };
}

export function deliveryBatchStatus(
  delivered: number,
  partiallyFailed: number,
  failed: number,
): RecommendationFollowupBatchStatus {
  const attempted = delivered + partiallyFailed + failed;
  if (attempted === 0 || failed === attempted) return 'failed';
  if (failed > 0 || partiallyFailed > 0) return 'partially_failed';
  return 'completed';
}

export function safeCsvCell(value: unknown): string {
  const raw = value === null || value === undefined
    ? ''
    : typeof value === 'object'
      ? JSON.stringify(value)
      : String(value);
  const safe = /^[=+\-@]/.test(raw) ? `'${raw}` : raw;
  return `"${safe.replaceAll('"', '""')}"`;
}

import type { DecisionAction } from './deal-momentum-types.js';
import type {
  EngagementCallMetadata,
  EngagementEmailMetadata,
  EngagementMetadataIntelligence,
} from './engagement-metadata-types.js';

export const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;

export function clamp(value: number, minimum = 0, maximum = 100): number {
  return Math.min(maximum, Math.max(minimum, value));
}

export function round(value: number, digits = 0): number {
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}

export function timestamp(value: string | null | undefined): number | null {
  if (!value) return null;
  const numeric = Number(value);
  const parsed = Number.isFinite(numeric) && numeric > 0
    ? (numeric < 10_000_000_000 ? numeric * 1000 : numeric)
    : Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function iso(value: number | null): string | null {
  return value === null ? null : new Date(value).toISOString();
}

export function mostRecent(values: Array<number | null>): number | null {
  const valid = values.filter((value): value is number => value !== null && Number.isFinite(value));
  return valid.length > 0 ? Math.max(...valid) : null;
}

export function nextFuture(values: Array<number | null>, now: number): number | null {
  const valid = values.filter((value): value is number => value !== null && value >= now);
  return valid.length > 0 ? Math.min(...valid) : null;
}

export function daysSince(value: number | null, now: number): number | null {
  return value === null ? null : round(Math.max(0, now - value) / DAY_MS, 1);
}

export function normalize(value: string | null | undefined): string {
  return value?.trim().toUpperCase().replaceAll(' ', '_') ?? '';
}

export function materialOutboundEmail(item: EngagementEmailMetadata): boolean {
  if (item.direction !== 'outbound') return false;
  return !['BOUNCED', 'FAILED', 'SCHEDULED', 'SENDING'].includes(normalize(item.status));
}

export function completedCall(item: EngagementCallMetadata): boolean {
  return normalize(item.status) === 'COMPLETED';
}

export function cadence(eventTimes: number[], now: number): EngagementMetadataIntelligence['engagement']['cadence'] {
  const recent14Days = eventTimes.filter((value) => value >= now - 14 * DAY_MS && value <= now).length;
  const previous14Days = eventTimes.filter((value) => value >= now - 28 * DAY_MS && value < now - 14 * DAY_MS).length;
  const weeks = new Set(
    eventTimes
      .filter((value) => value >= now - 56 * DAY_MS && value <= now)
      .map((value) => Math.floor((now - value) / (7 * DAY_MS))),
  );
  let trend: EngagementMetadataIntelligence['engagement']['cadence']['trend'];
  if (eventTimes.length === 0) trend = 'inactive';
  else if (eventTimes.length < 2) trend = 'insufficient_data';
  else if (recent14Days >= previous14Days + 2 && recent14Days >= 2) trend = 'accelerating';
  else if (previous14Days >= recent14Days + 2 && previous14Days >= 2) trend = 'declining';
  else trend = 'steady';
  return { recent14Days, previous14Days, activeWeeks8: weeks.size, trend };
}

export function reciprocity(
  inboundEmailCount: number,
  outboundEmailCount: number,
): EngagementMetadataIntelligence['engagement']['reciprocity'] {
  if (inboundEmailCount === 0 && outboundEmailCount === 0) {
    return { inboundEmailCount, outboundEmailCount, ratio: null, status: 'unavailable' };
  }
  if (outboundEmailCount === 0) {
    return { inboundEmailCount, outboundEmailCount, ratio: null, status: 'inbound_led' };
  }
  const ratio = round(inboundEmailCount / outboundEmailCount, 2);
  const status = ratio < .5 ? 'outbound_heavy' : ratio > 2 ? 'inbound_led' : 'balanced';
  return { inboundEmailCount, outboundEmailCount, ratio, status };
}

export function decisionAction(
  code: string,
  label: string,
  instruction: string,
  priority: DecisionAction['priority'],
  rationale: string,
  owner: DecisionAction['owner'],
  dueHours: number,
  evidenceCodes: string[],
  now: number,
): DecisionAction {
  return {
    code,
    label,
    action: instruction,
    priority,
    rationale,
    owner,
    dueAt: new Date(now + dueHours * HOUR_MS).toISOString(),
    evidenceCodes,
  };
}

export function sortedActions(actions: DecisionAction[]): DecisionAction[] {
  const order = { high: 0, medium: 1, low: 2 } as const;
  const seen = new Set<string>();
  return actions
    .filter((item) => {
      if (seen.has(item.code)) return false;
      seen.add(item.code);
      return true;
    })
    .sort((left, right) => order[left.priority] - order[right.priority])
    .slice(0, 6);
}

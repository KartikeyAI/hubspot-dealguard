/** Freshness is observation age, never the time a report is opened or regenerated. */
export type EvidenceFreshnessStatus = 'fresh' | 'aging' | 'stale' | 'unavailable';
export interface EvidenceFreshness {
  assessedAt: string | null;
  ageHours: number | null;
  status: EvidenceFreshnessStatus;
  reason: string | null;
}
export interface SnapshotFreshness extends EvidenceFreshness {
  generatedAt: string | null;
  usable: boolean;
}
const HOUR_MS = 3_600_000;
const STATES = ['fresh', 'aging', 'stale', 'unavailable'] as const;

/** Restrict evidence clocks to valid explicit-zone ISO instants at millisecond precision. */
export function evidenceInstant(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const parts = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (!parts) return null;
  const [, yearText, monthText, dayText, hourText, minuteText, secondText, , zone] = parts;
  const year = Number(yearText), month = Number(monthText), day = Number(dayText);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth[month - 1]!
    || Number(hourText) > 23 || Number(minuteText) > 59 || Number(secondText) > 59) return null;
  if (zone !== 'Z' && (Number(zone!.slice(1, 3)) > 23 || Number(zone!.slice(4)) > 59)) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

export function assessmentFreshness(value: unknown, now: number): EvidenceFreshness {
  const assessedAt = evidenceInstant(value);
  if (!Number.isFinite(now) || !assessedAt) {
    return { assessedAt, ageHours: null, status: 'unavailable', reason: 'invalid_observation_time' };
  }
  const age = now - Date.parse(assessedAt);
  if (age < 0) return { assessedAt, ageHours: null, status: 'unavailable', reason: 'future_observation_time' };
  // Classification uses raw elapsed time, not a rounded display value at 24/72-hour boundaries.
  const status = age <= 24 * HOUR_MS ? 'fresh' : age <= 72 * HOUR_MS ? 'aging' : 'stale';
  return { assessedAt, ageHours: age / HOUR_MS, status, reason: status === 'stale' ? 'stale_observation' : null };
}

export function snapshotFreshness(input: {
  assessmentAt: unknown;
  snapshotAssessmentAt: unknown;
  generatedAt: unknown;
  recordedStatus: unknown;
}, now: number): SnapshotFreshness {
  const observed = assessmentFreshness(input.assessmentAt, now);
  const generatedAt = evidenceInstant(input.generatedAt);
  const snapshotAt = evidenceInstant(input.snapshotAssessmentAt);
  const unavailable = (reason: string): SnapshotFreshness => ({
    ...observed, generatedAt, status: 'unavailable', usable: false, reason,
  });
  if (observed.status === 'unavailable') return unavailable(observed.reason!);
  if (!snapshotAt || snapshotAt !== observed.assessedAt) return unavailable('assessment_mismatch');
  if (!generatedAt) return unavailable('invalid_generation_time');
  const generated = Date.parse(generatedAt);
  if (generated > now) return unavailable('future_generation_time');
  if (generated < Date.parse(snapshotAt)) return unavailable('generation_precedes_observation');
  const recorded = STATES.indexOf(input.recordedStatus as EvidenceFreshnessStatus);
  if (recorded < 0 || input.recordedStatus === 'unavailable') return unavailable('unavailable_recorded_freshness');
  // A stored degradation can never be upgraded by re-reading the same snapshot.
  const status = STATES[Math.max(recorded, STATES.indexOf(observed.status))]!;
  return { ...observed, generatedAt, status, usable: status === 'fresh' || status === 'aging',
    reason: status === 'stale' ? 'stale_observation' : null };
}

export function freshnessConfidence(value: unknown, status: EvidenceFreshnessStatus): 'high' | 'medium' | 'low' {
  if (status === 'stale' || status === 'unavailable' || !['high', 'medium', 'low'].includes(String(value))) return 'low';
  return status === 'aging' && value === 'high' ? 'medium' : value as 'high' | 'medium' | 'low';
}

/** Advisory fallback deadline; a view refresh must not restart its clock. */
export function assessmentActionDueAt(assessedAt: unknown, hours: number, now: number): string | null {
  const observed = assessmentFreshness(assessedAt, now);
  if (!observed.assessedAt || observed.status === 'unavailable' || !Number.isFinite(hours) || hours < 0) return null;
  const due = Date.parse(observed.assessedAt) + hours * HOUR_MS;
  return Number.isFinite(due) && Math.abs(due) <= 8.64e15 ? new Date(due).toISOString() : null;
}

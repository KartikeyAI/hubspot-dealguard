import { assessmentFreshness, evidenceInstant, type EvidenceFreshnessStatus, type SnapshotFreshness } from './evidence-freshness.js';

export const EVIDENCE_SOURCES = ['readiness', 'history', 'relationships', 'engagement', 'commercial'] as const;
export type EvidenceSource = typeof EVIDENCE_SOURCES[number];
export interface SourceObservation {
  observedAt: string | null;
  status: EvidenceFreshnessStatus;
  usable: boolean;
  reason: string | null;
}
export interface SourceEvidence {
  version: 1;
  sources: Record<EvidenceSource, SourceObservation>;
}
function object(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
export function sourceObservation(value: unknown, now = Date.now()): SourceObservation {
  const age = assessmentFreshness(value, now);
  return { observedAt: age.assessedAt, status: age.status,
    usable: age.status === 'fresh' || age.status === 'aging', reason: age.reason };
}
export function buildSourceEvidence(times: Partial<Record<EvidenceSource, unknown>>, now = Date.now()): SourceEvidence {
  return { version: 1, sources: Object.fromEntries(EVIDENCE_SOURCES.map(key => [key, sourceObservation(times[key], now)])) as SourceEvidence['sources'] };
}
/** Receipts are observation clocks, not generation clocks. Re-read age every time. */
export function readSourceEvidence(value: unknown, now = Date.now()): SourceEvidence | null {
  const receipt = object(value), raw = object(receipt?.sources);
  if (receipt?.version !== 1 || !raw) return null;
  const result = buildSourceEvidence({}, now);
  for (const key of EVIDENCE_SOURCES) {
    const entry = object(raw[key]);
    if (!entry || !['fresh','aging','stale','unavailable'].includes(String(entry.status))) return null;
    const current = sourceObservation(entry.observedAt, now);
    const rank = ['fresh','aging','stale','unavailable'];
    if (rank.indexOf(String(entry.status)) > rank.indexOf(current.status)) {
      current.status = entry.status as EvidenceFreshnessStatus;
      current.reason = 'stored_source_degradation';
    }
    current.usable = current.status === 'fresh' || current.status === 'aging';
    result.sources[key] = current;
  }
  return result;
}
/** Withhold combined scores if any included dimension lacks a usable source clock. */
export function sourceBoundSnapshotFreshness(base: SnapshotFreshness, dimensionsValue: unknown, now: number): SnapshotFreshness {
  const dimensions = object(dimensionsValue);
  const receipt = readSourceEvidence(dimensions?.sourceEvidence, now);
  const fail = (reason: string, status: EvidenceFreshnessStatus = 'unavailable'): SnapshotFreshness => ({ ...base, status, usable: false, reason });
  if (!base.usable) return base;
  if (!receipt || receipt.sources.readiness.observedAt !== evidenceInstant(base.assessedAt)) return fail('source_provenance_unavailable');
  const required: EvidenceSource[] = ['readiness'];
  for (const [key, source] of [['momentum','history'],['closeDate','history'],['relationship','relationships'],['engagement','engagement'],['commercial','commercial']] as const) {
    if (object(dimensions?.[key])) required.push(source);
  }
  let status = base.status;
  for (const source of required) {
    const entry = receipt.sources[source];
    if (!entry.usable) return fail('source_'+source+'_'+entry.status, entry.status);
    if (!entry.observedAt || !base.generatedAt || Date.parse(entry.observedAt) > Date.parse(base.generatedAt)) return fail('source_after_generation');
    if (entry.status === 'aging') status = 'aging';
  }
  return { ...base, status };
}

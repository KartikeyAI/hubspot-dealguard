import type {
  ObservedProgress,
  RecommendationObservationInput,
  RecommendationOutcomeEvaluation,
} from './recommendation-outcome-types.js';

const DAY_MS = 86_400_000;
const DIMENSIONS = ['momentum', 'closeDate', 'relationship', 'engagement', 'commercial'] as const;
const BRIEF_RANK: Record<string, number> = {
  intervention_required: 0,
  watch: 1,
  on_track: 2,
};

function number(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function dimensionScore(value: unknown): number | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return number((value as Record<string, unknown>).score);
}

function delta(current: number | null, baseline: number | null): number | null {
  return current === null || baseline === null ? null : Math.round(current - baseline);
}

function dateDeltaDays(current: string | null, baseline: string | null): number | null {
  if (!current || !baseline) return null;
  const currentTime = Date.parse(current);
  const baselineTime = Date.parse(baseline);
  return Number.isFinite(currentTime) && Number.isFinite(baselineTime)
    ? Math.round((currentTime - baselineTime) / DAY_MS * 10) / 10
    : null;
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function classify(
  comparable: number,
  positive: number,
  negative: number,
): ObservedProgress {
  if (comparable < 2) return 'insufficient_evidence';
  if (positive > 0 && negative > 0) return 'mixed';
  if (positive >= 2) return 'improved';
  if (negative >= 2) return 'worsened';
  return 'unchanged';
}

function explanation(
  progress: ObservedProgress,
  positive: number,
  negative: number,
  comparable: number,
): string {
  if (progress === 'insufficient_evidence') {
    return 'A later Deal Brief exists, but fewer than two comparable evidence signals are available. No impact conclusion is drawn.';
  }
  if (progress === 'improved') {
    return `${positive} later evidence signals improved and ${negative} weakened after completion. This is an observed association, not proof that the recommendation caused the change.`;
  }
  if (progress === 'worsened') {
    return `${negative} later evidence signals weakened and ${positive} improved after completion. This is an observed association, not proof of causation.`;
  }
  if (progress === 'mixed') {
    return `${positive} later evidence signals improved while ${negative} weakened. The observed result is mixed and not causally attributed to the recommendation.`;
  }
  return `${comparable} comparable evidence signals were observed without a material directional change. Completion alone is not treated as evidence of impact.`;
}

export function evaluateRecommendationOutcome(
  input: RecommendationObservationInput,
): RecommendationOutcomeEvaluation {
  const readinessDelta = delta(input.current.readinessScore, input.baseline.readinessScore);
  const attentionDelta = delta(input.current.attentionScore, input.baseline.attentionScore);
  const stageChanged = input.current.stageId && input.baseline.stageId
    ? input.current.stageId !== input.baseline.stageId
    : null;
  const closeDateDeltaDays = dateDeltaDays(input.current.closeDate, input.baseline.closeDate);
  const dimensionDeltas: Record<string, number> = {};
  let positive = 0;
  let negative = 0;
  let comparable = 0;

  if (readinessDelta !== null) {
    comparable += 1;
    if (readinessDelta >= 5) positive += 1;
    if (readinessDelta <= -5) negative += 1;
  }
  if (attentionDelta !== null) {
    comparable += 1;
    if (attentionDelta <= -10) positive += 1;
    if (attentionDelta >= 10) negative += 1;
  }

  for (const dimension of DIMENSIONS) {
    const value = delta(
      dimensionScore(input.current.dimensions[dimension]),
      dimensionScore(input.baseline.dimensions[dimension]),
    );
    if (value === null) continue;
    dimensionDeltas[dimension] = value;
    comparable += 1;
    if (value >= 10) positive += 1;
    if (value <= -10) negative += 1;
  }

  const baselineRank = input.baseline.briefStatus ? BRIEF_RANK[input.baseline.briefStatus] : undefined;
  const currentRank = input.current.briefStatus ? BRIEF_RANK[input.current.briefStatus] : undefined;
  if (baselineRank !== undefined && currentRank !== undefined) {
    comparable += 1;
    if (currentRank > baselineRank) positive += 1;
    if (currentRank < baselineRank) negative += 1;
  }

  // Recommendation continuity is reported as context only. A recommendation can
  // disappear because evidence improved, another higher-priority action replaced
  // it, or evidence coverage declined. It must not independently move the outcome.
  const recommendationStillCurrent = input.current.currentRecommendationCode === input.recommendationCode;

  const currentEvidence = new Set(unique(input.current.observedEvidenceCodes));
  const evidenceNoLongerObservedCodes = unique(input.baselineEvidenceCodes)
    .filter((code) => !currentEvidence.has(code));
  const evidenceComparable = input.current.briefStatus !== 'insufficient_evidence';
  if (input.baselineEvidenceCodes.length > 0 && evidenceComparable) {
    comparable += 1;
    if (evidenceNoLongerObservedCodes.length === input.baselineEvidenceCodes.length) positive += 1;
    else if (evidenceNoLongerObservedCodes.length === 0) negative += 1;
  }

  const observedProgress = classify(comparable, positive, negative);
  return {
    evaluationStatus: observedProgress === 'insufficient_evidence' ? 'insufficient_evidence' : 'observed',
    observedProgress,
    readinessDelta,
    attentionDelta,
    stageChanged,
    closeDateDeltaDays,
    dimensionDeltas,
    evidenceNoLongerObservedCodes,
    recommendationStillCurrent,
    positiveSignalCount: positive,
    negativeSignalCount: negative,
    comparableSignalCount: comparable,
    explanation: explanation(observedProgress, positive, negative, comparable),
    causalAttribution: false,
  };
}

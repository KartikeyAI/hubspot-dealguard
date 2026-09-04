import assert from 'node:assert/strict';
import test from 'node:test';
import { evaluateRecommendationOutcome } from '../dist/recommendation-outcome-model.js';

function observation(overrides = {}) {
  return {
    recommendationCode: 'record_next_step',
    baselineEvidenceCodes: ['next_step_missing', 'stale_activity'],
    baseline: {
      assessmentAt: '2026-08-01T10:00:00.000Z',
      generatedAt: '2026-08-01T10:05:00.000Z',
      readinessScore: 55,
      readinessStatus: 'at_risk',
      pipelineId: 'pipeline-1',
      stageId: 'stage-1',
      stageLabel: 'Discovery',
      ownerId: 'owner-1',
      teamId: 'team-1',
      regionCode: 'IN',
      closeDate: '2026-09-15T00:00:00.000Z',
      attentionScore: 78,
      briefStatus: 'intervention_required',
      dimensions: {
        momentum: { score: 40, status: 'stalled' },
        closeDate: { score: 45, status: 'weak' },
        relationship: { score: 60, status: 'partial' },
      },
    },
    current: {
      assessmentAt: '2026-08-05T10:00:00.000Z',
      generatedAt: '2026-08-05T10:05:00.000Z',
      readinessScore: 72,
      readinessStatus: 'at_risk',
      stageId: 'stage-2',
      closeDate: '2026-09-15T00:00:00.000Z',
      attentionScore: 45,
      briefStatus: 'watch',
      dimensions: {
        momentum: { score: 65, status: 'watch' },
        closeDate: { score: 70, status: 'credible' },
        relationship: { score: 62, status: 'partial' },
      },
      currentRecommendationCode: 'confirm_budget_holder',
      observedEvidenceCodes: ['budget_holder_missing'],
    },
    ...overrides,
  };
}

test('classifies a later multi-signal improvement without causal attribution', () => {
  const result = evaluateRecommendationOutcome(observation());
  assert.equal(result.observedProgress, 'improved');
  assert.equal(result.evaluationStatus, 'observed');
  assert.equal(result.readinessDelta, 17);
  assert.equal(result.attentionDelta, -33);
  assert.equal(result.dimensionDeltas.momentum, 25);
  assert.equal(result.recommendationStillCurrent, false);
  assert.deepEqual(result.evidenceNoLongerObservedCodes.sort(), ['next_step_missing', 'stale_activity']);
  assert.equal(result.causalAttribution, false);
  assert.match(result.explanation, /not proof/i);
});

test('classifies a later deterioration when readiness, attention and dimensions weaken', () => {
  const input = observation({
    current: {
      ...observation().current,
      readinessScore: 40,
      attentionScore: 92,
      briefStatus: 'intervention_required',
      dimensions: {
        momentum: { score: 25 },
        closeDate: { score: 20 },
        relationship: { score: 45 },
      },
      currentRecommendationCode: 'record_next_step',
      observedEvidenceCodes: ['next_step_missing', 'stale_activity'],
    },
  });
  const result = evaluateRecommendationOutcome(input);
  assert.equal(result.observedProgress, 'worsened');
  assert.ok(result.negativeSignalCount >= 2);
  assert.match(result.explanation, /not proof of causation/i);
});

test('returns mixed when later evidence improves and weakens in different dimensions', () => {
  const input = observation({
    current: {
      ...observation().current,
      readinessScore: 68,
      attentionScore: 88,
      briefStatus: 'watch',
      dimensions: {
        momentum: { score: 62 },
        closeDate: { score: 30 },
        relationship: { score: 72 },
      },
      currentRecommendationCode: 'confirm_budget_holder',
      observedEvidenceCodes: ['stale_activity'],
    },
  });
  const result = evaluateRecommendationOutcome(input);
  assert.equal(result.observedProgress, 'mixed');
  assert.ok(result.positiveSignalCount > 0);
  assert.ok(result.negativeSignalCount > 0);
});

test('withholds a directional conclusion when fewer than two comparable signals exist', () => {
  const result = evaluateRecommendationOutcome({
    recommendationCode: 'record_next_step',
    baselineEvidenceCodes: [],
    baseline: {
      ...observation().baseline,
      readinessScore: null,
      attentionScore: null,
      briefStatus: null,
      stageId: null,
      closeDate: null,
      dimensions: {},
    },
    current: {
      ...observation().current,
      readinessScore: null,
      attentionScore: null,
      briefStatus: null,
      stageId: null,
      closeDate: null,
      dimensions: {},
      currentRecommendationCode: 'record_next_step',
      observedEvidenceCodes: [],
    },
  });
  assert.equal(result.observedProgress, 'insufficient_evidence');
  assert.equal(result.evaluationStatus, 'insufficient_evidence');
  assert.match(result.explanation, /fewer than two comparable/i);
});

test('close-date movement is recorded as evidence but does not itself imply improvement', () => {
  const result = evaluateRecommendationOutcome(observation({
    baseline: {
      ...observation().baseline,
      closeDate: '2026-09-10T00:00:00.000Z',
    },
    current: {
      ...observation().current,
      closeDate: '2026-09-24T00:00:00.000Z',
    },
  }));
  assert.equal(result.closeDateDeltaDays, 14);
  assert.equal(result.causalAttribution, false);
});

test('does not treat disappearing recommendations or missing evidence as improvement', () => {
  const result = evaluateRecommendationOutcome({
    recommendationCode: 'record_next_step',
    baselineEvidenceCodes: ['next_step_missing'],
    baseline: {
      ...observation().baseline,
      readinessScore: null,
      attentionScore: null,
      dimensions: {},
      briefStatus: 'intervention_required',
    },
    current: {
      ...observation().current,
      readinessScore: null,
      attentionScore: null,
      dimensions: {},
      briefStatus: 'insufficient_evidence',
      currentRecommendationCode: null,
      observedEvidenceCodes: [],
    },
  });
  assert.equal(result.recommendationStillCurrent, false);
  assert.equal(result.observedProgress, 'insufficient_evidence');
  assert.equal(result.evaluationStatus, 'insufficient_evidence');
});

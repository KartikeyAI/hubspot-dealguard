import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildExecutiveRevenueView,
  normalizeRecordedForecastCategory,
  revenueAmountContext,
} from '../dist/executive-revenue-analysis.js';

const period = {
  start: '2026-07-01T00:00:00.000Z',
  end: '2026-09-30T23:59:59.999Z',
  basis: 'custom',
  pullInHorizonEnd: '2026-10-30T23:59:59.999Z',
};

const emptyDecision = {
  status: null,
  attentionScore: null,
  confidence: null,
  coveragePercent: null,
  generatedAt: null,
  closeDateCredibilityScore: null,
  closeDateCredibilityStatus: null,
  nextActionDueAt: null,
  nextActionPriority: null,
};

function deal(overrides = {}) {
  return {
    dealId: 'deal-1',
    dealName: 'Example deal',
    recordUrl: 'https://app.hubspot.com/contacts/123/record/0-3/deal-1',
    pipelineId: 'pipeline-1',
    pipelineLabel: 'New business',
    stageId: 'stage-2',
    stageLabel: 'Evaluation',
    ownerId: 'owner-1',
    teamId: 'team-1',
    regionCode: 'IN',
    amount: 100000,
    amountInCompanyCurrency: null,
    currencyCode: 'INR',
    closeDate: '2026-09-15T00:00:00.000Z',
    forecastCategoryRaw: 'commit',
    readinessScore: 90,
    readinessStatus: 'ready',
    assessmentAt: '2026-08-30T08:00:00.000Z',
    decision: { ...emptyDecision },
    isClosed: false,
    isWon: false,
    ...overrides,
  };
}

function previous(overrides = {}) {
  return {
    dealId: 'deal-1',
    snapshotDate: '2026-08-29',
    capturedAt: '2026-08-29T08:00:00.000Z',
    pipelineId: 'pipeline-1',
    stageId: 'stage-1',
    ownerId: 'owner-1',
    teamId: 'team-1',
    regionCode: 'IN',
    amount: 90000,
    amountInCompanyCurrency: null,
    currencyCode: 'INR',
    closeDate: '2026-09-10T00:00:00.000Z',
    forecastCategoryRaw: 'pipeline',
    readinessScore: 80,
    readinessStatus: 'at_risk',
    assessmentAt: '2026-08-29T08:00:00.000Z',
    decisionStatus: 'watch',
    decisionAttentionScore: 45,
    decisionConfidence: 'medium',
    decisionCoveragePercent: 75,
    decisionGeneratedAt: '2026-08-29T08:00:00.000Z',
    ...overrides,
  };
}

function view(deals, previousSnapshots = []) {
  return buildExecutiveRevenueView(deals, previousSnapshots, {
    period,
    generatedAt: '2026-08-30T12:00:00.000Z',
    fetchedAt: '2026-08-30T12:00:00.000Z',
    maxDeals: 10000,
    loadedDeals: deals.length,
    sourceTruncated: false,
    candidateLimit: 20,
  });
}

test('normalises recorded HubSpot forecast categories without assigning probabilities', () => {
  assert.equal(normalizeRecordedForecastCategory('Best case'), 'best_case');
  assert.equal(normalizeRecordedForecastCategory('COMMIT'), 'commit');
  assert.equal(normalizeRecordedForecastCategory('Not forecasted'), 'not_forecasted');
  assert.equal(normalizeRecordedForecastCategory('Customer category'), 'custom');
  assert.equal(normalizeRecordedForecastCategory(null), 'unavailable');
});

test('keeps INR and USD in separate amount cohorts and never creates an unsafe combined total', () => {
  const result = view([
    deal({ dealId: 'inr', amount: 100000, currencyCode: 'INR' }),
    deal({ dealId: 'usd', amount: 5000, currencyCode: 'USD', ownerId: 'owner-2', regionCode: 'US' }),
    deal({ dealId: 'unknown', amount: 8000, currencyCode: null }),
  ]);
  assert.deepEqual(result.amountCohorts.map((item) => item.label).sort(), ['INR', 'USD']);
  assert.equal(result.amountCohorts.find((item) => item.label === 'INR').openAmount, 100000);
  assert.equal(result.amountCohorts.find((item) => item.label === 'USD').openAmount, 5000);
  assert.equal(result.coverage.comparableAmountPercent, 67);
  assert.equal(result.semantics.amountNeverCombinedAcrossCurrencies, true);
  assert.equal(revenueAmountContext(100, null, null).comparable, false);
});

test('reports close-date, amount, stage, forecast and period movement from the latest prior daily snapshot', () => {
  const result = view([
    deal({
      dealId: 'exit',
      closeDate: '2026-10-20T00:00:00.000Z',
      forecastCategoryRaw: 'pipeline',
      amount: 120000,
      stageId: 'stage-3',
    }),
    deal({
      dealId: 'entry',
      closeDate: '2026-09-20T00:00:00.000Z',
      forecastCategoryRaw: 'commit',
      amount: 70000,
    }),
  ], [
    previous({
      dealId: 'exit',
      closeDate: '2026-09-15T00:00:00.000Z',
      forecastCategoryRaw: 'commit',
      amount: 100000,
      stageId: 'stage-2',
    }),
    previous({
      dealId: 'entry',
      closeDate: '2026-10-10T00:00:00.000Z',
      stageId: 'stage-2',
      forecastCategoryRaw: 'pipeline',
      amount: 80000,
    }),
  ]);
  assert.equal(result.movement.status, 'established');
  assert.equal(result.movement.closeDatePushedDeals, 1);
  assert.equal(result.movement.closeDatePulledInDeals, 1);
  assert.equal(result.movement.periodExitDeals, 1);
  assert.equal(result.movement.periodEntryDeals, 1);
  assert.equal(result.movement.stageChangedDeals, 1);
  assert.equal(result.movement.amountIncreasedDeals, 1);
  assert.equal(result.movement.amountDecreasedDeals, 1);
  assert.equal(result.movement.forecastDowngradedDeals, 1);
  assert.equal(result.movement.forecastUpgradedDeals, 1);
});

test('ranks deterministic slippage and pull-in review candidates without presenting them as predictions', () => {
  const result = view([
    deal({
      dealId: 'slip',
      dealName: 'Slipping deal',
      closeDate: '2026-10-20T00:00:00.000Z',
      forecastCategoryRaw: 'pipeline',
      readinessScore: 45,
      readinessStatus: 'critical',
      decision: {
        ...emptyDecision,
        status: 'intervention_required',
        attentionScore: 85,
        confidence: 'high',
        coveragePercent: 95,
        generatedAt: '2026-08-30T10:00:00.000Z',
      },
    }),
    deal({
      dealId: 'pull',
      dealName: 'Pull-in review deal',
      closeDate: '2026-10-15T00:00:00.000Z',
      forecastCategoryRaw: 'best_case',
      readinessScore: 92,
      readinessStatus: 'ready',
      decision: {
        ...emptyDecision,
        status: 'on_track',
        attentionScore: 20,
        confidence: 'high',
        coveragePercent: 95,
        generatedAt: '2026-08-30T10:00:00.000Z',
        closeDateCredibilityScore: 85,
        closeDateCredibilityStatus: 'credible',
      },
    }),
  ], [
    previous({ dealId: 'slip', closeDate: '2026-09-10T00:00:00.000Z', forecastCategoryRaw: 'commit' }),
    previous({ dealId: 'pull', closeDate: '2026-10-20T00:00:00.000Z', forecastCategoryRaw: 'best_case' }),
  ]);
  assert.equal(result.slippageReviewCandidates[0].dealId, 'slip');
  assert.ok(result.slippageReviewCandidates[0].reasons.some((item) => item.code === 'moved_out_of_period'));
  assert.equal(result.pullInReviewCandidates[0].dealId, 'pull');
  assert.equal(result.semantics.pullInCandidateIsReviewPrompt, true);
  assert.equal(result.semantics.slippageCandidateIsReviewPrompt, true);
  assert.equal(result.semantics.notWinProbability, true);
});

test('calculates concentration inside a comparable cohort and establishes a baseline without prior snapshots', () => {
  const result = view([
    deal({ dealId: 'a', amount: 700, ownerId: 'owner-a', pipelineId: 'p1', pipelineLabel: 'Primary' }),
    deal({ dealId: 'b', amount: 200, ownerId: 'owner-b', pipelineId: 'p1', pipelineLabel: 'Primary' }),
    deal({ dealId: 'c', amount: 100, ownerId: 'owner-c', pipelineId: 'p2', pipelineLabel: 'Expansion' }),
  ]);
  const inr = result.concentration.find((item) => item.label === 'INR');
  const owner = inr.dimensions.find((item) => item.dimension === 'owner');
  assert.equal(owner.topEntityId, 'owner-a');
  assert.equal(owner.topSharePercent, 70);
  assert.equal(owner.status, 'concentrated');
  assert.equal(result.movement.status, 'baseline_only');
  assert.equal(result.source.comparisonSnapshotDate, null);
  assert.match(result.confidence.explanation, /baseline/i);
});

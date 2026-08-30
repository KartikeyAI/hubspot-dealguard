import assert from 'node:assert/strict';
import test from 'node:test';
import { buildDealMomentum } from '../dist/deal-momentum.js';

const NOW = Date.parse('2026-08-30T00:00:00.000Z');
const day = (offset) => new Date(NOW + offset * 86_400_000).toISOString();
const value = (entry, offset) => ({ value: entry, timestamp: day(offset) });
const stages = [
  { id: 'qualified', label: 'Qualified', pipelineId: 'sales', pipelineLabel: 'Sales', displayOrder: 1, isClosed: false, isWon: false },
  { id: 'proposal', label: 'Proposal', pipelineId: 'sales', pipelineLabel: 'Sales', displayOrder: 2, isClosed: false, isWon: false },
  { id: 'negotiation', label: 'Negotiation', pipelineId: 'sales', pipelineLabel: 'Sales', displayOrder: 3, isClosed: false, isWon: false },
];
const settings = {
  staleDays: 7,
  maxStageAgeDays: 21,
  requireOwner: true,
  requireAmount: true,
  requireCloseDate: true,
  requireNextStep: true,
  requireCompany: true,
  requireContact: true,
  excludedPipelineIds: [],
  excludedStageIds: [],
  customRequiredProperties: [],
};
const assessment = {
  dealId: '100', dealName: 'Example', pipelineLabel: 'Sales', stageLabel: 'Negotiation', pipelineId: 'sales', stageId: 'negotiation', ownerId: 'owner-1', dealAmount: 100000,
  score: 90, grade: 'A', status: 'ready', issues: [], readinessSummary: 'Ready', isClosed: false, isWon: false, handoffEligible: false, assessedAt: day(0),
};

function deal(overrides = {}) {
  return {
    id: '100',
    properties: {
      dealstage: 'negotiation', pipeline: 'sales', closedate: day(15), amount: '100000', hubspot_owner_id: 'owner-1', hs_next_step: 'Decision meeting',
      hs_last_sales_activity_timestamp: day(-1), hs_date_entered_negotiation: day(-5),
      ...overrides,
    },
    contactCount: 2,
    companyCount: 1,
    stage: { ...stages[2], enteredAtProperty: 'hs_date_entered_negotiation' },
  };
}

function history(propertyHistory) {
  return { propertyHistory, stageDefinitions: stages, fetchedAt: day(0) };
}

test('reports strong CRM process momentum for advancing, recently active deals', () => {
  const result = buildDealMomentum(deal(), settings, assessment, history({
    dealstage: [value('qualified', -60), value('proposal', -30), value('negotiation', -8)],
    closedate: [value(day(30), -40), value(day(15), -5)],
    amount: [value('90000', -50), value('100000', -10)],
    hubspot_owner_id: [value('owner-1', -60)],
    hs_next_step: [value('Discovery follow-up', -30), value('Decision meeting', -3)],
  }), NOW);
  assert.equal(result.momentum.band, 'strong');
  assert.ok(result.momentum.score >= 75);
  assert.equal(result.momentum.events.stageAdvances, 2);
  assert.equal(result.momentum.events.closeDatePullIns, 1);
  assert.equal(result.closeDateCredibility.status, 'credible');
});

test('flags stalled momentum and weak close-date credibility from regressions and repeated pushes', () => {
  const result = buildDealMomentum(deal({
    closedate: day(7), hs_next_step: '', hs_last_sales_activity_timestamp: day(-30), hs_date_entered_negotiation: day(-50),
  }), settings, assessment, history({
    dealstage: [value('negotiation', -50), value('proposal', -20)],
    closedate: [value(day(-5), -40), value(day(2), -20), value(day(7), -3)],
    amount: [value('100000', -60)],
    hubspot_owner_id: [value('owner-1', -60), value('owner-2', -30), value('owner-1', -4)],
    hs_next_step: [value('Meeting', -40), value('', -10)],
  }), NOW);
  assert.equal(result.momentum.band, 'stalled');
  assert.equal(result.momentum.events.stageRegressions, 1);
  assert.equal(result.momentum.events.closeDatePushes, 2);
  assert.equal(result.closeDateCredibility.status, 'weak');
  assert.ok(result.decisionActions.some((item) => item.code === 'reconfirm_close_date'));
  assert.ok(result.decisionActions.some((item) => item.code === 'review_stage_regression'));
});

test('withholds a momentum score when property-history coverage is insufficient', () => {
  const result = buildDealMomentum(deal(), settings, assessment, history({
    closedate: [value(day(15), -2)],
  }), NOW);
  assert.equal(result.momentum.band, 'insufficient_data');
  assert.equal(result.momentum.score, null);
  assert.equal(result.momentum.evidenceCoveragePercent, 20);
});

test('uses customer policy thresholds for stage age and recorded activity freshness', () => {
  const evidence = history({
    dealstage: [value('proposal', -40), value('negotiation', -15)],
    closedate: [value(day(20), -20), value(day(15), -5)],
    amount: [value('100000', -30)],
    hubspot_owner_id: [value('owner-1', -30)],
    hs_next_step: [value('Decision meeting', -3)],
  });
  const strict = buildDealMomentum(deal({ hs_last_sales_activity_timestamp: day(-10), hs_date_entered_negotiation: day(-15) }), { ...settings, staleDays: 5, maxStageAgeDays: 10 }, assessment, evidence, NOW);
  const lenient = buildDealMomentum(deal({ hs_last_sales_activity_timestamp: day(-10), hs_date_entered_negotiation: day(-15) }), { ...settings, staleDays: 20, maxStageAgeDays: 30 }, assessment, evidence, NOW);
  assert.ok((strict.momentum.score ?? 0) < (lenient.momentum.score ?? 0));
  assert.ok(strict.momentum.signals.some((item) => item.code === 'stage_age_above_policy'));
  assert.ok(!lenient.momentum.signals.some((item) => item.code === 'stage_age_above_policy'));
});

test('marks close-date credibility unavailable when no close date is recorded', () => {
  const result = buildDealMomentum(deal({ closedate: null }), settings, assessment, history({
    dealstage: [value('proposal', -40), value('negotiation', -15)],
    amount: [value('100000', -30)],
    hubspot_owner_id: [value('owner-1', -30)],
    hs_next_step: [value('Decision meeting', -3)],
  }), NOW);
  assert.equal(result.closeDateCredibility.status, 'unavailable');
  assert.equal(result.closeDateCredibility.score, null);
  assert.equal(result.closeDateCredibility.notWinProbability, true);
});

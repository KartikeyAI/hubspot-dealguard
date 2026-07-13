import test from 'node:test';
import assert from 'node:assert/strict';
import { assessDeal } from '../dist/scoring.js';

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

const now = Date.parse('2026-07-13T00:00:00.000Z');

test('scores a complete active deal as ready', () => {
  const result = assessDeal({
    id: '1',
    properties: {
      pipeline: 'default', dealstage: 'qualified', hubspot_owner_id: '2', amount: '10000',
      closedate: '2026-08-01T00:00:00Z', hs_next_step: 'Send proposal',
      hs_last_sales_activity_timestamp: String(now - 2 * 86_400_000),
      hs_date_entered_qualified: String(now - 5 * 86_400_000),
    },
    contactCount: 1,
    companyCount: 1,
    stage: { id: 'qualified', label: 'Qualified', pipelineId: 'default', pipelineLabel: 'Sales', isClosed: false, isWon: false, enteredAtProperty: 'hs_date_entered_qualified' },
  }, settings, now);
  assert.equal(result.status, 'ready');
  assert.equal(result.score, 100);
  assert.equal(result.issues.length, 0);
});

test('identifies critical forecast and ownership gaps', () => {
  const result = assessDeal({
    id: '2',
    properties: {
      pipeline: 'default', dealstage: 'qualified', amount: '', closedate: '2026-06-01T00:00:00Z',
      hs_next_step: '', hs_last_sales_activity_timestamp: String(now - 30 * 86_400_000),
      hs_date_entered_qualified: String(now - 60 * 86_400_000),
    },
    contactCount: 0,
    companyCount: 0,
    stage: { id: 'qualified', label: 'Qualified', pipelineId: 'default', pipelineLabel: 'Sales', isClosed: false, isWon: false, enteredAtProperty: 'hs_date_entered_qualified' },
  }, settings, now);
  assert.equal(result.status, 'critical');
  assert.ok(result.score < 50);
  assert.ok(result.issues.some((issue) => issue.code === 'owner_missing'));
  assert.ok(result.issues.some((issue) => issue.code === 'close_date_overdue'));
  assert.ok(result.issues.some((issue) => issue.code === 'stale_activity'));
});

test('applies stage-specific custom required fields', () => {
  const customSettings = {
    ...settings,
    customRequiredProperties: [{ property: 'procurement_process', label: 'Procurement process', weight: 12, severity: 'warning', stageIds: ['proposal'] }],
  };
  const result = assessDeal({
    id: '3',
    properties: {
      pipeline: 'default', dealstage: 'proposal', hubspot_owner_id: '2', amount: '5000',
      closedate: '2026-08-01T00:00:00Z', hs_next_step: 'Legal review',
      hs_last_sales_activity_timestamp: String(now), hs_date_entered_proposal: String(now),
    },
    contactCount: 1,
    companyCount: 1,
    stage: { id: 'proposal', label: 'Proposal', pipelineId: 'default', pipelineLabel: 'Sales', isClosed: false, isWon: false, enteredAtProperty: 'hs_date_entered_proposal' },
  }, customSettings, now);
  assert.ok(result.issues.some((issue) => issue.code === 'custom_procurement_process'));
  assert.equal(result.score, 88);
});

test('marks closed-won deals as handoff eligible', () => {
  const result = assessDeal({
    id: '4',
    properties: { pipeline: 'default', dealstage: 'closedwon', hubspot_owner_id: '2', amount: '5000', closedate: '2026-07-01T00:00:00Z' },
    contactCount: 1,
    companyCount: 1,
    stage: { id: 'closedwon', label: 'Closed won', pipelineId: 'default', pipelineLabel: 'Sales', isClosed: true, isWon: true, enteredAtProperty: 'hs_date_entered_closedwon' },
  }, settings, now);
  assert.equal(result.isWon, true);
  assert.equal(result.handoffEligible, true);
  assert.ok(!result.issues.some((issue) => issue.code === 'next_step_missing'));
});

test('excludes closed-lost deals from active pipeline readiness', () => {
  const result = assessDeal({
    id: '5',
    properties: { dealname: 'Lost opportunity', pipeline: 'default', dealstage: 'closedlost' },
    contactCount: 0,
    companyCount: 0,
    stage: { id: 'closedlost', label: 'Closed lost', pipelineId: 'default', pipelineLabel: 'Sales', isClosed: true, isWon: false, enteredAtProperty: 'hs_date_entered_closedlost' },
  }, settings, now);
  assert.equal(result.status, 'ready');
  assert.equal(result.score, 100);
  assert.equal(result.handoffEligible, false);
  assert.match(result.readinessSummary, /closed-lost/i);
});

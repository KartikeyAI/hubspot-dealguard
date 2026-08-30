import assert from 'node:assert/strict';
import test from 'node:test';
import { extractDecisionSnapshot } from '../dist/decision-snapshot.js';
import { buildManagerDecisionQueue } from '../dist/manager-decision-queue.js';

const NOW = Date.parse('2026-08-30T12:00:00.000Z');

function row(overrides = {}) {
  return {
    deal_id: '1',
    deal_name: 'Acme renewal',
    issues_json: '[]',
    score: 82,
    status: 'ready',
    issue_count: 0,
    pipeline_id: 'sales',
    pipeline_label: 'Sales',
    stage_id: 'negotiation',
    stage_label: 'Negotiation',
    owner_id: '100',
    team_id: '10',
    region_code: 'IN',
    deal_amount: 100000,
    deal_currency_code: 'INR',
    deal_amount_in_company_currency: null,
    stage_age_days: 5,
    assessed_at: '2026-08-30T10:00:00.000Z',
    snapshot_assessment_at: '2026-08-30T10:00:00.000Z',
    snapshot_generated_at: '2026-08-30T10:05:00.000Z',
    brief_status: 'on_track',
    snapshot_attention_score: 18,
    snapshot_confidence: 'high',
    snapshot_coverage_percent: 100,
    snapshot_freshness_status: 'fresh',
    next_action_code: null,
    next_action_label: null,
    next_action_text: null,
    next_action_priority: null,
    next_action_owner: null,
    next_action_due_at: null,
    next_action_rationale: null,
    next_action_evidence_json: '[]',
    risk_summary_json: '[]',
    dimensions_json: '{"readiness":{"score":82,"status":"ready"}}',
    open_remediation_count: 0,
    overdue_remediation_count: 0,
    ...overrides,
  };
}

test('ranks an overdue critical intervention as act now', () => {
  const result = buildManagerDecisionQueue('123', [
    row({
      deal_id: 'critical',
      deal_name: 'Critical enterprise deal',
      score: 42,
      status: 'critical',
      issue_count: 4,
      stage_age_days: 38,
      deal_amount: 900000,
      snapshot_attention_score: 88,
      brief_status: 'intervention_required',
      next_action_code: 'recover_buyer_response',
      next_action_label: 'Recover buyer response',
      next_action_text: 'Re-engage the buyer and confirm the close plan.',
      next_action_priority: 'high',
      next_action_owner: 'manager',
      next_action_due_at: '2026-08-29T12:00:00.000Z',
      next_action_rationale: 'The buyer response gap is overdue.',
      next_action_evidence_json: '["response_gap"]',
      risk_summary_json: '[{"code":"response_gap","label":"Buyer response gap","dimension":"engagement","severity":"critical"}]',
      overdue_remediation_count: 1,
      open_remediation_count: 2,
    }),
    row({ deal_id: 'healthy', deal_name: 'Healthy deal', deal_amount: 200000 }),
  ], { now: NOW, limit: 10 });

  assert.equal(result.items[0].dealId, 'critical');
  assert.equal(result.items[0].band, 'act_now');
  assert.ok(result.items[0].priorityScore >= 80);
  assert.equal(result.items[0].nextAction?.source, 'deal_brief');
  assert.equal(result.items[0].nextAction?.overdue, true);
  assert.ok(result.items[0].reasons.some((item) => item.code === 'response_gap'));
  assert.equal(result.summary.overdueActions, 1);
});

test('computes commercial importance only inside comparable currency cohorts', () => {
  const result = buildManagerDecisionQueue('123', [
    row({ deal_id: 'inr-small', deal_amount: 100, deal_currency_code: 'INR' }),
    row({ deal_id: 'inr-large', deal_amount: 1000, deal_currency_code: 'INR' }),
    row({ deal_id: 'usd-only', deal_amount: 5000, deal_currency_code: 'USD' }),
    row({ deal_id: 'unknown', deal_amount: 999999, deal_currency_code: null }),
  ], { now: NOW, limit: 10 });

  const byId = new Map(result.items.map((item) => [item.dealId, item]));
  assert.equal(byId.get('inr-large')?.amount.cohortPercentile, 100);
  assert.equal(byId.get('inr-small')?.amount.cohortPercentile, 0);
  assert.equal(byId.get('usd-only')?.amount.cohortPercentile, 50);
  assert.equal(byId.get('unknown')?.amount.comparable, false);
  assert.equal(result.amountCohorts.length, 2);
  assert.deepEqual(new Set(result.amountCohorts.map((item) => item.currencyCode)), new Set(['INR', 'USD']));
});

test('falls back to readiness and remediation when no current Deal Brief snapshot exists', () => {
  const result = buildManagerDecisionQueue('123', [row({
    snapshot_assessment_at: null,
    snapshot_generated_at: null,
    brief_status: null,
    snapshot_attention_score: null,
    score: 60,
    status: 'at_risk',
    issue_count: 2,
    stage_age_days: 24,
    issues_json: '[{"code":"next_step_missing","label":"Next step missing","description":"Record the next committed action.","severity":"warning","weight":10}]',
    remediation_title: 'Resolve close-date exception',
    remediation_description: 'Reconfirm or revise the current close plan.',
    remediation_priority: 'high',
    remediation_due_at: '2026-08-31T10:00:00.000Z',
    remediation_issue_code: 'close_date_overdue',
    open_remediation_count: 1,
  })], { now: NOW });

  const item = result.items[0];
  assert.equal(item.evidenceMode, 'readiness_only');
  assert.equal(item.evidenceCoveragePercent, 40);
  assert.equal(item.nextAction?.source, 'remediation');
  assert.ok(item.reasons.some((entry) => entry.code === 'deal_brief_missing'));
  assert.equal(result.summary.readinessOnlyDeals, 1);
});

test('does not use a stale Deal Brief attention score as current evidence', () => {
  const result = buildManagerDecisionQueue('123', [row({
    score: 90,
    status: 'ready',
    stage_age_days: 1,
    issue_count: 0,
    snapshot_generated_at: '2026-08-25T10:00:00.000Z',
    snapshot_attention_score: 99,
    brief_status: 'intervention_required',
  })], { now: NOW });

  const item = result.items[0];
  assert.equal(item.evidenceMode, 'stale_deal_brief');
  assert.equal(item.dealBriefStatus, null);
  assert.ok(item.deterministicAttentionScore < 20);
  assert.ok(item.reasons.some((entry) => entry.code === 'deal_brief_stale'));
});

test('extracts a bounded derived snapshot without raw contact, activity, or quote records', () => {
  const payload = {
    dealId: '1',
    assessedAt: '2026-08-30T10:00:00.000Z',
    score: 68,
    status: 'at_risk',
    isClosed: false,
    intelligence: {
      dealBrief: {
        methodology: 'deterministic_evidence_synthesis',
        generatedAt: '2026-08-30T10:05:00.000Z',
        status: 'watch',
        attentionScore: 54,
        confidence: 'medium',
        coverage: { percent: 85 },
        freshness: { status: 'fresh' },
        nextAction: {
          code: 'reconfirm_close', label: 'Reconfirm close plan', action: 'Reconfirm the close plan.',
          priority: 'high', owner: 'deal_owner', dueAt: '2026-08-31T10:00:00.000Z',
          rationale: 'The close date moved later.', evidenceCodes: ['close_date_push'],
        },
        risks: [{ code: 'close_date_push', label: 'Close date moved later', dimension: 'close_date', severity: 'warning', detail: 'Sensitive detail' }],
      },
      relationshipCoverage: { score: 45, status: 'weak', contacts: [{ id: 'c1', displayName: 'Private Buyer' }] },
      engagement: { score: 30, status: 'watch', emails: [{ subject: 'Private subject' }] },
      commercialIntegrity: { score: 70, status: 'watch', quotes: [{ title: 'Private quote' }] },
    },
  };
  const snapshot = extractDecisionSnapshot('123', '1', payload, NOW);
  assert.ok(snapshot);
  const serialized = JSON.stringify(snapshot);
  assert.doesNotMatch(serialized, /Private Buyer|Private subject|Private quote|Sensitive detail/);
  assert.equal(snapshot?.dimensions.relationship?.status, 'weak');
  assert.equal(snapshot?.nextAction?.code, 'reconfirm_close');
  assert.deepEqual(snapshot?.risks[0], {
    code: 'close_date_push', label: 'Close date moved later', dimension: 'close_date', severity: 'warning',
  });
});

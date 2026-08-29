import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { TRUSTWORTHY_INTELLIGENCE_SEMANTICS } from '../dist/enterprise-analytics-v2.js';

const source = fs.readFileSync(new URL('../worker/src/enterprise-analytics-v2.ts', import.meta.url), 'utf8');

test('current analytics use one latest open assessment per deal', () => {
  assert.equal(TRUSTWORTHY_INTELLIGENCE_SEMANTICS.currentState, 'latest_open_assessment_per_deal');
  assert.match(source, /SELECT DISTINCT ON \(deal_id\) \*/);
  assert.match(source, /ORDER BY deal_id, assessed_at DESC, id DESC/);
  assert.match(source, /return `\$\{alias\}\.is_closed = 0 AND \$\{filterSql\(alias, filters\)\}`/);
  assert.match(source, /FROM latest_assessments latest\s+WHERE \$\{currentStateWhere\('latest', filters\)\}/);
  assert.doesNotMatch(
    source,
    /SELECT COUNT\(DISTINCT deal_id\)[\s\S]{0,500}SUM\(CASE WHEN status\s*!=\s*'ready'/,
    'current state must not sum raw assessment-history events',
  );
});

test('daily trends deduplicate repeated same-day assessments', () => {
  assert.equal(TRUSTWORTHY_INTELLIGENCE_SEMANTICS.trend, 'latest_open_assessment_per_deal_per_day');
  assert.match(source, /SELECT DISTINCT ON \(deal_id, substr\(assessed_at, 1, 10\)\) \*/);
  assert.match(source, /ORDER BY deal_id, substr\(assessed_at, 1, 10\), assessed_at DESC, id DESC/);
});

test('outcome evidence uses one pre-close snapshot per deal', () => {
  assert.equal(
    TRUSTWORTHY_INTELLIGENCE_SEMANTICS.outcomeEvidence,
    'latest_open_assessment_before_latest_close_per_deal',
  );
  assert.match(source, /closed_outcomes AS/);
  assert.match(source, /SELECT DISTINCT ON \(history\.deal_id\)/);
  assert.match(source, /history\.is_closed = 0/);
  assert.match(source, /history\.assessed_at < outcome\.outcome_at/);
  assert.match(source, /outcome\.is_won/);
});

test('amount language is precise and data coverage is exposed', () => {
  assert.equal(
    TRUSTWORTHY_INTELLIGENCE_SEMANTICS.amountAtRisk,
    'recorded_deal_amount_with_readiness_gaps_not_expected_loss',
  );
  for (const field of [
    'amountWithReadinessGaps',
    'criticalDeals',
    'oldestAssessmentAt',
    'latestAssessmentAt',
    'amountPercent',
    'stageAgePercent',
    'ownerPercent',
  ]) {
    assert.match(source, new RegExp(`\\b${field}\\b`), `missing trustworthy analytics field: ${field}`);
  }
  assert.match(
    source,
    /pipeline_id,pipeline,total_deals,average_score,critical_deals,amount_with_readiness_gaps/,
  );
});

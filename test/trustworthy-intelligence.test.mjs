import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { TRUSTWORTHY_INTELLIGENCE_SEMANTICS } from '../dist/enterprise-analytics-v2.js';

const analytics = fs.readFileSync(new URL('../worker/src/enterprise-analytics-v2.ts', import.meta.url), 'utf8');
const config = fs.readFileSync(new URL('../worker/src/config.ts', import.meta.url), 'utf8');
const migration = fs.readFileSync(new URL('../database/migrations/0015_trustworthy_intelligence_currency.sql', import.meta.url), 'utf8');
const home = fs.readFileSync(new URL('../src/app/pages/EnterpriseHomeV4.tsx', import.meta.url), 'utf8');

const functionSource = (name) => analytics.match(new RegExp(`function ${name}\\([\\s\\S]*?\\n\\}`, 'm'))?.[0] ?? '';

test('current analytics use one latest open assessment per deal', () => {
  assert.equal(TRUSTWORTHY_INTELLIGENCE_SEMANTICS.currentState, 'latest_open_assessment_per_deal');
  assert.match(analytics, /SELECT DISTINCT ON \(deal_id\) \*/);
  assert.match(analytics, /ORDER BY deal_id, assessed_at DESC, id DESC/);
  assert.doesNotMatch(functionSource('latestAssessmentCte'), /assessed_at >=/, 'current state must not disappear outside the trend window');
  assert.match(analytics, /return `\$\{alias\}\.is_closed = 0 AND \$\{filterSql\(alias, filters\)\}`/);
  assert.match(analytics, /FROM latest_assessments latest\s+WHERE \$\{currentStateWhere\('latest', filters\)\}/);
});

test('daily trends deduplicate repeated same-day assessments', () => {
  assert.equal(TRUSTWORTHY_INTELLIGENCE_SEMANTICS.trend, 'latest_open_assessment_per_deal_per_day');
  assert.match(analytics, /SELECT DISTINCT ON \(deal_id, substr\(assessed_at, 1, 10\)\) \*/);
  assert.match(analytics, /ORDER BY deal_id, substr\(assessed_at, 1, 10\), assessed_at DESC, id DESC/);
});

test('outcome evidence uses one pre-close snapshot per deal', () => {
  assert.equal(TRUSTWORTHY_INTELLIGENCE_SEMANTICS.outcomeEvidence, 'latest_open_assessment_before_latest_close_per_deal');
  assert.match(analytics, /closed_outcomes AS/);
  assert.match(analytics, /SELECT DISTINCT ON \(history\.deal_id\)/);
  assert.match(analytics, /history\.is_closed = 0/);
  assert.match(analytics, /history\.assessed_at < outcome\.outcome_at/);
  assert.match(analytics, /outcome\.is_won/);
});

test('currency-safe analytics never sum incomparable deal currencies', () => {
  assert.equal(
    TRUSTWORTHY_INTELLIGENCE_SEMANTICS.currency,
    'company_currency_when_fully_covered_else_single_source_currency_else_not_aggregated',
  );
  assert.match(config, /'deal_currency_code'/);
  assert.match(config, /'amount_in_home_currency'/);
  assert.match(migration, /ADD COLUMN deal_currency_code/);
  assert.match(migration, /ADD COLUMN deal_amount_in_company_currency/);
  assert.match(analytics, /dealsWithCompanyCurrencyAmount === dealsWithAmount/);
  assert.match(analytics, /knownCurrencies\.length === 1/);
  assert.match(analytics, /DealGuard will not sum them/);
  assert.match(analytics, /pipelineAmount: null/);
  assert.match(analytics, /amountWithReadinessGaps: null/);
});

test('amount terminology, coverage and CSV provenance are explicit', () => {
  assert.equal(
    TRUSTWORTHY_INTELLIGENCE_SEMANTICS.amountAtRisk,
    'recorded_deal_amount_with_readiness_gaps_not_expected_loss',
  );
  for (const field of [
    'amountWithReadinessGaps',
    'criticalDeals',
    'oldestAssessmentAt',
    'latestAssessmentAt',
    'companyCurrencyAmountPercent',
    'currencyCodePercent',
    'stageAgePercent',
    'ownerPercent',
  ]) assert.match(analytics, new RegExp(`\\b${field}\\b`), `missing trustworthy analytics field: ${field}`);
  assert.match(
    analytics,
    /amount_with_readiness_gaps,currency_basis,currency_code,company_currency_coverage_percent/,
  );
});

test('App Home uses evidence-accurate customer language', () => {
  for (const label of [
    'READINESS TREND',
    'AMOUNT COVERAGE',
    'READINESS COMPLIANCE',
    'AMOUNT WITH READINESS GAPS',
    'OWNER BENCHMARK GAP',
    'ATTENTION PRIORITY',
    'Data trust and freshness',
  ]) assert.ok(home.includes(label), `missing evidence-accurate Home label: ${label}`);
  for (const unsupported of ['COMMERCIAL EXPOSURE', 'STAKEHOLDER INTELLIGENCE', 'PREDICTIVE RISK SIGNAL']) {
    assert.ok(!home.includes(unsupported), `unsupported Home claim remains: ${unsupported}`);
  }
  assert.ok(home.includes('not machine-learning win probabilities or expected-loss estimates'));
});

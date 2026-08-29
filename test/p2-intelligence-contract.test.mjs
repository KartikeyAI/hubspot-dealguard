import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const analytics = fs.readFileSync(new URL('../worker/src/enterprise-analytics-v2.ts', import.meta.url), 'utf8');
const home = fs.readFileSync(new URL('../src/app/pages/EnterpriseHomeV4.tsx', import.meta.url), 'utf8');

test('P2 analytics exposes the decision-intelligence and compatibility contracts', () => {
  for (const key of [
    'benchmarking',
    'attentionPriority',
    'predictiveRisk',
    'outcomeCorrelation',
    'workspaceAverageScore',
    'highPriorityDeals',
    'highRiskDeals',
    'confidence',
  ]) assert.match(analytics, new RegExp(`\\b${key}\\b`), `missing analytics contract: ${key}`);
});

test('attention priority is deterministic and is not represented as a win probability', () => {
  assert.match(analytics, /methodology: 'deterministic_attention_signal'/);
  assert.match(analytics, /\(100 - score\) \* \.55/);
  assert.match(analytics, /Math\.min\(30, age\) \* \.8/);
  assert.match(analytics, /Math\.min\(10, issues\) \* 3/);
  assert.match(analytics, /attentionPriority: 'deterministic_prioritisation_signal_not_win_probability'/);
  assert.doesNotMatch(analytics, /winProbability|ml_probability|machine_learning_probability/i);
});

test('outcome evidence carries sample-size confidence guards', () => {
  assert.match(analytics, /closed\.length >= 100 \? 'strong' : closed\.length >= 30 \? 'directional' : 'limited'/);
  assert.match(home, /Strong sample/);
  assert.match(home, /Directional/);
  assert.match(home, /Limited sample/);
});

test('Home explains decision evidence without overstating certainty', () => {
  for (const label of [
    'Decision intelligence',
    'BENCHMARKING',
    'OWNER BENCHMARK GAP',
    'ATTENTION PRIORITY',
    'WIN / LOSS EVIDENCE',
  ]) assert.ok(home.includes(label), `missing UI label: ${label}`);
  assert.ok(home.includes('not machine-learning win probabilities or expected-loss estimates'));
});

test('enterprise analytics CSV export remains available with amount provenance', () => {
  assert.match(analytics, /export async function exportAnalyticsCsv/);
  assert.match(analytics, /analytics\.export/);
  assert.match(analytics, /currency_basis/);
  assert.match(analytics, /company_currency_coverage_percent/);
});

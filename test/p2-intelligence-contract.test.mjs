import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const analytics = fs.readFileSync(new URL('../worker/src/enterprise-analytics-v2.ts', import.meta.url), 'utf8');
const home = fs.readFileSync(new URL('../src/app/pages/EnterpriseHomeV4.tsx', import.meta.url), 'utf8');

test('P2 analytics exposes the complete decision-intelligence contract', () => {
  for (const key of ['benchmarking', 'predictiveRisk', 'outcomeCorrelation', 'workspaceAverageScore', 'highRiskDeals', 'confidence']) {
    assert.match(analytics, new RegExp(`\\b${key}\\b`), `missing analytics contract: ${key}`);
  }
});

test('predictive risk is deterministic and not represented as ML probability', () => {
  assert.match(analytics, /methodology:'deterministic_signal'/);
  assert.match(analytics, /\(100-score\)\*\.55/);
  assert.match(analytics, /Math\.min\(30,age\)\*\.8/);
  assert.match(analytics, /Math\.min\(10,issues\)\*3/);
  assert.doesNotMatch(analytics, /winProbability|ml_probability|machine_learning_probability/i);
});

test('outcome evidence carries sample-size confidence guards', () => {
  assert.match(analytics, /closed\.length>=100\?'strong':closed\.length>=30\?'directional':'limited'/);
  assert.match(home, /Strong sample/);
  assert.match(home, /Directional/);
  assert.match(home, /Limited sample/);
});

test('Home explains predictive risk without overstating certainty', () => {
  for (const label of ['Decision intelligence', 'BENCHMARKING', 'STAKEHOLDER INTELLIGENCE', 'PREDICTIVE RISK SIGNAL', 'WIN / LOSS EVIDENCE']) assert.ok(home.includes(label), `missing UI label: ${label}`);
  assert.ok(home.includes('not machine-learning win probabilities'));
});

test('enterprise analytics CSV export remains available', () => {
  assert.match(analytics, /export async function exportAnalyticsCsv/);
  assert.match(analytics, /analytics\.export/);
});

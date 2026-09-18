import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { buildOutcomeEvidenceQuery, outcomeEvidenceSummary, OUTCOME_EVIDENCE_LIMITS } from '../dist/outcome-evidence.js';

const window = { since: '2026-09-01T00:00:00.000Z', asOf: '2026-09-18T12:00:00.000Z' };
function fixture(won = 1, lost = 1) {
  const row = { authorized_deals: won + lost, retained_observations: (won + lost) * 2,
    invalid_timestamps: 0, invalid_states: 0, closed_deals_in_window: won + lost,
    sample_size: won + lost, won, lost, without_preclose: 0, preclose_outside_scope: 0, conflicting_outcomes: 0 };
  for (const [group, size] of [['won', won], ['lost', lost]]) {
    for (const [field, value] of [['score', group === 'won' ? 80 : 40], ['issue_count', 0], ['stage_age_days', 2]]) {
      row[`${group}_${field}_count`] = size;
      row[`${group}_${field}_average`] = size ? value : null;
    }
  }
  return row;
}

test('complete two-class evidence retains compatibility fields without predictive meaning', () => {
  const result = outcomeEvidenceSummary(fixture(), window);
  assert.equal(result.status, 'available'); assert.equal(result.sampleSize, 2);
  assert.equal(result.winRate, 50); assert.equal(result.scoreDelta, 40);
  assert.equal(result.wonAverageIssues, 0, 'A measured zero remains a zero.');
  assert.equal(result.semantics.calibratedPrediction, false); assert.equal(result.semantics.causalAttribution, false);
  assert.equal(result.window.basis, 'first_observed_close_in_current_episode');
});

test('empty evidence has no win rate, group averages or invented score difference', () => {
  const result = outcomeEvidenceSummary(fixture(0, 0), window);
  assert.equal(result.status, 'insufficient_evidence'); assert.equal(result.sampleSize, 0);
  for (const key of ['winRate', 'wonAverageScore', 'lostAverageScore', 'scoreDelta', 'wonAverageStageAgeDays']) {
    assert.equal(result[key], null, key);
  }
});

test('one outcome class never produces a won-versus-lost difference or strong sample label', () => {
  for (const [won, lost, rate] of [[150, 0, 100], [0, 150, 0]]) {
    const result = outcomeEvidenceSummary(fixture(won, lost), window);
    assert.equal(result.scoreDelta, null); assert.equal(result.winRate, rate); assert.equal(result.confidence, 'limited');
  }
});

test('missing metric coverage does not enter averages as zero', () => {
  const row = fixture(2, 1); row.won_score_count = 1; row.won_stage_age_days_count = 1;
  const result = outcomeEvidenceSummary(row, window);
  assert.equal(result.wonAverageScore, null); assert.equal(result.wonAverageStageAgeDays, null);
  assert.equal(result.lostAverageScore, 40); assert.equal(result.scoreDelta, null);
  assert.equal(result.coverage.won.score, 1); assert.equal(result.winRate, 66.7);
});

test('sample strength requires both groups, complete scores and explicit sample-size thresholds', () => {
  assert.equal(outcomeEvidenceSummary(fixture(70, 30), window).confidence, 'strong');
  assert.equal(outcomeEvidenceSummary(fixture(20, 10), window).confidence, 'directional');
  assert.equal(outcomeEvidenceSummary(fixture(100, 1), window).confidence, 'limited');
  const row = fixture(70, 30); row.won_score_count = 69;
  assert.equal(outcomeEvidenceSummary(row, window).confidence, 'limited');
});

test('missing, corrupt and inconsistent query reports are unavailable, not empty successful reports', () => {
  for (const row of [undefined, {}, { ...fixture(), won: true }, { ...fixture(), won: -1 },
    { ...fixture(), sample_size: 9 }, { ...fixture(), closed_deals_in_window: 0 },
    { ...fixture(), won_score_count: 9 }]) {
    const result = outcomeEvidenceSummary(row, window);
    assert.equal(result.status, 'unavailable'); assert.equal(result.scoreDelta, null);
    assert.equal(result.winRate, null); assert.equal(result.coverage, null);
  }
});

test('valid PostgreSQL count strings are read as counts, never truthy win/loss flags', () => {
  const row = Object.fromEntries(Object.entries(fixture()).map(([key, value]) => [key, String(value)]));
  const result = outcomeEvidenceSummary(row, window);
  assert.equal(result.won, 1); assert.equal(result.lost, 1); assert.equal(result.winRate, 50);
});

test('invalid histories and capacity violations withhold outcome statistics', () => {
  for (const [field, value, reason] of [['invalid_timestamps', 1, 'invalid_assessment_timestamps'],
    ['invalid_states', 1, 'invalid_lifecycle_states'],
    ['authorized_deals', OUTCOME_EVIDENCE_LIMITS.maximumDeals + 1, 'portfolio_limit_exceeded'],
    ['retained_observations', OUTCOME_EVIDENCE_LIMITS.maximumObservations + 1, 'history_limit_exceeded']]) {
    const result = outcomeEvidenceSummary({ ...fixture(), [field]: value }, window);
    assert.equal(result.reason, reason); assert.equal(result.status, 'unavailable'); assert.equal(result.winRate, null);
  }
});

test('nonfinite and invalid aggregate values cannot become score comparisons', () => {
  for (const value of [Infinity, 'NaN', -1, 101, false, null]) {
    const result = outcomeEvidenceSummary({ ...fixture(), won_score_average: value }, window);
    assert.equal(result.wonAverageScore, null); assert.equal(result.scoreDelta, null);
  }
});

test('query binds portal, times and all scope predicates rather than interpolating their values', () => {
  const malicious = "100' OR 1=1 --";
  const query = buildOutcomeEvidenceQuery(malicious,
    { sql: 'latest.owner_id IN (?, ?)', params: ['1', '2'] },
    { sql: 'closure.pipeline_id IN (?)', params: ['p1'] },
    { sql: 'pre.owner_id IN (?, ?)', params: ['1', '2'] }, window);
  assert.equal((query.sql.match(/\?/g) ?? []).length, query.params.length);
  assert.deepEqual(query.params, [window.asOf, window.since, malicious, '1', '2', 10000, 250000, '1', '2', 'p1']);
  assert.ok(!query.sql.includes(malicious));
  assert.match(query.sql, /IS NOT TRUE THEN 'preclose_outside_scope'/, 'NULL observed dimensions must fail closed.');
  assert.doesNotMatch(query.sql, /INSERT INTO|UPDATE |DELETE FROM|LIMIT 10000/);
});

test('read-model wiring and UI retain null and lifecycle interpretation boundaries', () => {
  const analytics = readFileSync(new URL('../worker/src/enterprise-analytics-v2.ts', import.meta.url), 'utf8');
  const home = readFileSync(new URL('../src/app/pages/EnterpriseHomeV4.tsx', import.meta.url), 'utf8');
  assert.match(analytics, /await loadOutcomeEvidence/);
  assert.doesNotMatch(analytics, /Boolean\(row\.is_won\)|closed_outcomes AS/);
  assert.match(home, /outcomes\.scoreDelta !== null/);
  assert.match(home, /observed sample win rate/);
  assert.match(home, /Sample strength is not forecast confidence/);
});

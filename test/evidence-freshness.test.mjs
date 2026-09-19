import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { evidenceInstant, assessmentFreshness, snapshotFreshness, assessmentActionDueAt,
  freshnessConfidence } from '../dist/evidence-freshness.js';
import { extractDecisionSnapshot, persistDecisionSnapshot } from '../dist/decision-snapshot.js';
import { buildManagerDecisionQueue } from '../dist/manager-decision-queue.js';
import { currentDecision } from '../dist/executive-revenue.js';
import { buildDealBrief } from '../dist/deal-brief.js';

const NOW = Date.parse('2026-09-18T12:00:00.000Z');
const HOUR = 3_600_000;
const at = (hours, milliseconds = 0) => new Date(NOW - hours * HOUR + milliseconds).toISOString();
const snapshot = (extra = {}) => ({ assessmentAt: at(2), snapshotAssessmentAt: at(2),
  generatedAt: at(1), recordedStatus: 'fresh', ...extra });
const payload = () => ({ dealId: '1', isClosed: false, assessedAt: at(2), score: 80, status: 'ready',
  intelligence: { dealBrief: { generatedAt: at(1), status: 'on_track', attentionScore: 15, confidence: 'high',
    coverage: { percent: 100 }, freshness: { status: 'fresh', assessedAt: at(2) }, risks: [], nextAction: null },
    relationshipCoverage: { score: null, status: 'unavailable' } } });
const row = (extra = {}) => ({ deal_id: '1', score: 80, status: 'ready', issue_count: 0, issues_json: '[]',
  assessed_at: at(2), snapshot_assessment_at: at(2), snapshot_generated_at: at(1),
  snapshot_freshness_status: 'fresh', snapshot_confidence: 'high', snapshot_coverage_percent: 100,
  snapshot_attention_score: 95, brief_status: 'intervention_required',
  dimensions_json: '{"closeDate":{"score":90,"status":"credible"}}',
  risk_summary_json: '[{"code":"stale_only_risk","label":"Stored risk","severity":"warning"}]',
  next_action_code: 'snapshot_action', next_action_label: 'Stored next action', next_action_text: 'Verify source',
  next_action_priority: 'high', next_action_owner: 'manager', next_action_due_at: at(-24), ...extra });
const queueItem = (r, now = NOW) => buildManagerDecisionQueue('100', [r], { now }).items[0];
const executive = (r, now = NOW) => currentDecision({ ...r, assessment_at: r.snapshot_assessment_at,
  generated_at: r.snapshot_generated_at, freshness_status: r.snapshot_freshness_status,
  confidence: r.snapshot_confidence, coverage_percent: r.snapshot_coverage_percent, attention_score: r.snapshot_attention_score,
}, r.assessed_at, now);

test('evidence clocks require an explicit zone and a real calendar date', () => {
  assert.equal(evidenceInstant('2026-09-18T17:30:00+05:30'), at(0));
  assert.equal(evidenceInstant('2024-02-29T12:00:00Z'), '2024-02-29T12:00:00.000Z');
  assert.equal(evidenceInstant('2026-09-18T12:00:00.1Z'), '2026-09-18T12:00:00.100Z');
  for (const v of [null, false, 0, [], '', '2026-09-18', '2026-09-18T12:00:00', '2026-02-29T12:00:00Z',
    '2026-04-31T00:00:00Z', '2026-01-01T24:00:00Z', '2026-01-01T00:60:00Z', '2026-01-01T00:00:60Z',
    '2026-01-01T00:00:00+24:00', '2026-01-01T00:00:00.0001Z', ' 2026-09-18T12:00:00Z']) {
    assert.equal(evidenceInstant(v), null, String(v));
  }
});

test('24- and 72-hour classification does not round an old observation into a fresher state', () => {
  for (const [hours, shift, state] of [[24, 0, 'fresh'], [24, -1, 'aging'], [72, 0, 'aging'], [72, -1, 'stale']]) {
    const f = assessmentFreshness(at(hours, shift), NOW);
    assert.equal(f.status, state);
    assert.equal(f.ageHours, (NOW - Date.parse(at(hours, shift))) / HOUR);
  }
  assert.equal(assessmentFreshness(at(0, 1), NOW).status, 'unavailable');
  assert.equal(assessmentFreshness(at(0), NaN).status, 'unavailable');
});

test('generation never resets source age and stored degradation cannot be upgraded', () => {
  const f = snapshotFreshness(snapshot({ assessmentAt: at(80), snapshotAssessmentAt: at(80), generatedAt: at(0) }), NOW);
  assert.equal(f.status, 'stale'); assert.equal(f.ageHours, 80); assert.equal(f.usable, false);
  assert.equal(snapshotFreshness(snapshot({ recordedStatus: 'stale' }), NOW).status, 'stale');
  assert.equal(snapshotFreshness(snapshot({ recordedStatus: 'aging' }), NOW).status, 'aging');
  for (const status of [null, '', 'unknown', 'unavailable']) {
    assert.equal(snapshotFreshness(snapshot({ recordedStatus: status }), NOW).usable, false);
  }
});

test('invalid, future, reversed and non-identical assessment clocks cannot become usable snapshots', () => {
  for (const change of [
    { generatedAt: null }, { generatedAt: at(-1) }, { generatedAt: at(3) },
    { snapshotAssessmentAt: at(2, 1) }, { assessmentAt: at(-1), snapshotAssessmentAt: at(-1) },
  ]) assert.equal(snapshotFreshness(snapshot(change), NOW).usable, false);
  assert.equal(snapshotFreshness(snapshot({ snapshotAssessmentAt: '2026-09-18T15:30:00+05:30' }), NOW).usable, true);
});

test('confidence is capped by evidence age, not page refresh', () => {
  assert.equal(freshnessConfidence('high', 'fresh'), 'high');
  assert.equal(freshnessConfidence('high', 'aging'), 'medium');
  for (const status of ['stale', 'unavailable']) assert.equal(freshnessConfidence('high', status), 'low');
  assert.equal(freshnessConfidence('low', 'fresh'), 'low');
});

test('manager and executive readers reject the same stale or invalid snapshots', () => {
  for (const overrides of [
    { assessed_at: at(80), snapshot_assessment_at: at(80), snapshot_generated_at: at(0) },
    { snapshot_generated_at: at(-1) }, { snapshot_generated_at: at(3) },
    { snapshot_assessment_at: at(2, 500) }, { snapshot_freshness_status: 'unavailable' },
  ]) {
    const r = row(overrides), manager = queueItem(r), exec = executive(r);
    assert.equal(manager.snapshotFreshness.usable, false);
    assert.equal(manager.dealBriefStatus, null);
    assert.equal(manager.evidenceConfidence, 'low');
    assert.ok(manager.deterministicAttentionScore < 95);
    assert.equal(manager.nextAction, null);
    assert.equal(manager.reasons.some(x => x.code === 'stale_only_risk'), false);
    assert.equal(exec.attentionScore, null); assert.equal(exec.closeDateCredibilityScore, null);
    assert.equal(exec.nextActionDueAt, null); assert.equal(exec.freshness.usable, false);
  }
});

test('aging snapshots remain visibly aging in both consumers', () => {
  const r = row({ assessed_at: at(48), snapshot_assessment_at: at(48), snapshot_generated_at: at(1) });
  const m = queueItem(r), e = executive(r);
  assert.equal(m.evidenceMode, 'aging_deal_brief'); assert.equal(m.evidenceConfidence, 'medium');
  assert.equal(m.assessmentFreshness.ageHours, 48); assert.equal(m.snapshotFreshness.generatedAt, at(1));
  assert.equal(e.freshness.status, 'aging'); assert.equal(e.confidence, 'medium');
});

test('fallback deadlines do not slide on repeated views, and overdue state advances', () => {
  const r = row({ snapshot_generated_at: null, status: 'critical', score: 40, issue_count: 1,
    issues_json: JSON.stringify([{ code: 'missing', label: 'Missing evidence', severity: 'critical', weight: 10 }]) });
  const early = queueItem(r), later = queueItem(r, NOW + 25 * HOUR);
  assert.equal(early.nextAction.source, 'readiness');
  assert.equal(early.nextAction.dueAt, at(-22));
  assert.equal(later.nextAction.dueAt, early.nextAction.dueAt);
  assert.equal(early.nextAction.overdue, false); assert.equal(later.nextAction.overdue, true);
  assert.equal(assessmentActionDueAt(at(-1), 24, NOW), null);
  assert.equal(assessmentActionDueAt(null, 24, NOW), null);
});

test('missing readiness clocks cannot invent due dates and are disclosed in the queue', () => {
  const m = queueItem(row({ assessed_at: 'invalid', snapshot_generated_at: null, status: 'critical',
    issues_json: '[{"code":"missing","label":"Missing","severity":"critical"}]' }));
  assert.equal(m.nextAction.dueAt, null); assert.equal(m.assessmentFreshness.status, 'unavailable');
  assert.ok(m.reasons.some(r => r.code === 'assessment_freshness_review'));
});

test('snapshot extraction rejects fake clocks, identity mismatches and missing required numbers', () => {
  assert.ok(extractDecisionSnapshot('100', '1', payload(), NOW));
  for (const mutate of [
    p => { p.dealId = 'other'; }, p => { delete p.isClosed; }, p => { p.score = null; },
    p => { p.intelligence.dealBrief.generatedAt = null; }, p => { p.intelligence.dealBrief.generatedAt = at(-1); },
    p => { p.intelligence.dealBrief.freshness.assessedAt = at(2, 1); },
    p => { p.intelligence.dealBrief.attentionScore = null; }, p => { p.intelligence.dealBrief.attentionScore = false; },
    p => { p.intelligence.dealBrief.attentionScore = 101; }, p => { p.intelligence.dealBrief.coverage.percent = ''; },
  ]) { const p = payload(); mutate(p); assert.equal(extractDecisionSnapshot('100', '1', p, NOW), null); }
  assert.equal(extractDecisionSnapshot(' ', '1', payload(), NOW), null);
  const p = payload(); p.score = 0; p.intelligence.dealBrief.attentionScore = 0;
  p.intelligence.dealBrief.coverage.percent = 0;
  const result = extractDecisionSnapshot('100', '1', p, NOW);
  assert.equal(result.attentionScore, 0); assert.equal(result.dimensions.readiness.score, 0);
  assert.equal('score' in result.dimensions.relationship, false);
});

test('extracting a regenerated stale brief preserves stale age and reduces confidence', () => {
  const p = payload(); p.assessedAt = at(80); p.intelligence.dealBrief.freshness.assessedAt = at(80);
  const result = extractDecisionSnapshot('100', '1', p, NOW);
  assert.equal(result.freshnessStatus, 'stale'); assert.equal(result.confidence, 'low');
});

test('ignored snapshot writes do not start recommendation observation', async () => {
  const p = payload(); const now = Date.now(); p.assessedAt = new Date(now - 2000).toISOString();
  p.intelligence.dealBrief.generatedAt = new Date(now - 1000).toISOString();
  p.intelligence.dealBrief.freshness.assessedAt = p.assessedAt;
  const calls = [];
  const env = { DB: { prepare(sql) { calls.push(sql); return { bind() { return { first: async () => null }; } }; } } };
  assert.equal(await persistDecisionSnapshot(env, '100', '1', p), false);
  assert.equal(calls.length, 1); assert.match(calls[0], /RETURNING deal_id/);
  assert.match(calls[0], /current_assessment\.is_closed = 0/);
});

test('stale persisted evidence does not present new recommendations', async () => {
  const p = payload(), now = Date.now(); p.assessedAt = new Date(now - 80 * HOUR).toISOString();
  p.intelligence.dealBrief.generatedAt = new Date(now - 1000).toISOString();
  p.intelligence.dealBrief.freshness.assessedAt = p.assessedAt;
  const calls = [];
  const env = { DB: { prepare(sql) { calls.push(sql); return { bind() { return { first: async () => ({ deal_id: '1' }) }; } }; } } };
  assert.equal(await persistDecisionSnapshot(env, '100', '1', p), true);
  assert.equal(calls.length, 1);
});

test('misaddressed closure payload cannot delete another deal snapshot', async () => {
  const env = { DB: { prepare() { throw new Error('Unexpected database call'); } } };
  assert.equal(await persistDecisionSnapshot(env, '100', '1', { dealId: '2', isClosed: true }), false);
});

test('shared helpers are wired into record cache, reader UI and deadline production paths', () => {
  const source = path => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
  assert.match(source('worker/src/assessment-service.ts'), /assessmentFreshness\(stored.assessedAt/);
  assert.match(source('worker/src/deal-brief.ts'), /assessmentActionDueAt\(assessedAt, 24, now\)/);
  const ui = source('src/app/pages/ManagerDecisionQueueCore.tsx');
  for (const term of ['Observation age:', 'Brief generated:', 'not this page refresh']) assert.ok(ui.includes(term));
});

test('Deal Brief uses exact evidence age and a source-anchored readiness action', () => {
  const input = { assessment: { dealId: '1', score: 80, status: 'ready', grade: 'B', assessedAt: at(2), issues: [],
      dealName: 'Example', pipelineLabel: 'Sales', stageLabel: 'Qualified', isClosed: false, isWon: false },
    readiness: { risk: { contributors: [] }, nextBestActions: [{ code: 'missing', label: 'Missing', action: 'Verify', severity: 'warning', impact: 10 }],
      stageReadiness: { percent: 80, blockers: [] }, change: { scoreDelta: null, newIssueCodes: [], resolvedIssueCodes: [] } },
    momentum: null, relationship: null, decisionActions: [] };
  const early = buildDealBrief(input, NOW).dealBrief;
  const later = buildDealBrief(input, NOW + 25 * HOUR).dealBrief;
  assert.equal(early.nextAction.dueAt, later.nextAction.dueAt);
  assert.equal(later.freshness.status, 'aging');
  input.assessment.assessedAt = at(24, -1);
  assert.equal(buildDealBrief(input, NOW).dealBrief.freshness.status, 'aging');
  input.assessment.assessedAt = at(-1);
  const invalid = buildDealBrief(input, NOW).dealBrief;
  assert.equal(invalid.freshness.status, 'unavailable'); assert.equal(invalid.confidence, 'low');
  assert.equal(invalid.nextAction.dueAt, null);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { loadOutcomeEvidence } from '../dist/outcome-evidence.js';
import { analyticsPredicate } from '../dist/analytics-scope.js';

const databaseUrl = process.env.DEALGUARD_ANALYTICS_TEST_DATABASE_URL;
if (process.env.GITHUB_WORKFLOW === 'CI' && !databaseUrl) {
  throw new Error('Canonical CI requires the isolated analytics PostgreSQL fixture.');
}

test('outcome lifecycle SQL runs against the migrated PostgreSQL schema', { skip: !databaseUrl }, async (t) => {
  const { Client } = await import('pg');
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  t.after(async () => { await client.query('ROLLBACK'); await client.end(); });
  await client.query('BEGIN');
  await client.query('CREATE TEMP TABLE assessment_history AS SELECT * FROM dealguard.assessment_history WITH NO DATA');
  await client.query('SET LOCAL search_path TO pg_temp, public');
  const window = { since: '2026-09-01T00:00:00.000Z', asOf: '2026-09-18T12:00:00.000Z' };
  const scope = { ownerId: ['1', '2'], pipelineId: ['p1'], teamId: ['t1'], regionCode: ['r1'] };
  let sequence = 0;
  const add = async (deal, at, extra = {}) => {
    const row = { id: String(++sequence).padStart(8, '0'), portal_id: '100', deal_id: deal,
      score: 70, issue_count: 0, stage_age_days: 3, is_closed: 0, is_won: 0,
      pipeline_id: 'p1', stage_id: 's1', owner_id: '1', team_id: 't1', region_code: 'r1',
      assessed_at: at, ...extra };
    const keys = Object.keys(row);
    await client.query(`INSERT INTO assessment_history (${keys.join(',')}) VALUES (${keys.map((_, i) => `$${i + 1}`).join(',')})`, Object.values(row));
  };
  const close = (deal, at, extra = {}) => add(deal, at, { is_closed: 1, is_won: 1, score: 99, ...extra });
  const reset = async () => { await client.query('TRUNCATE assessment_history'); sequence = 0; };
  const env = { DB: { prepare(sql) { return { bind(...params) { return {
    async first() {
      let index = 0;
      const query = sql.replace(/\?/g, () => `$${++index}`);
      assert.equal(index, params.length, 'Every placeholder must have a bound value.');
      assert.doesNotMatch(sql, /INSERT INTO|UPDATE |DELETE FROM/);
      return (await client.query(query, params)).rows[0] ?? null;
    },
  }; } }; } } };
  const load = (filters = scope, authorization = scope, portal = '100', bounds = window) => loadOutcomeEvidence(
    env, portal, analyticsPredicate('latest', authorization), analyticsPredicate('closure', filters),
    analyticsPredicate('pre', filters), bounds,
  );

  await t.test('repeated assessments preserve first closure time and use the last strictly pre-close score', async () => {
    await reset(); await add('A', '2026-08-20T00:00:00Z', { score: 20 });
    await add('A', '2026-09-02T00:00:00Z', { score: 60 });
    await add('A', '2026-09-02T00:00:00Z', { score: 70 });
    await close('A', '2026-09-03T00:00:00Z'); await close('A', '2026-09-17T00:00:00Z');
    const report = await load();
    assert.equal(report.status, 'available'); assert.equal(report.sampleSize, 1); assert.equal(report.wonAverageScore, 70);
    assert.equal(report.coverage.firstOutcomeAt, '2026-09-03T00:00:00.000Z');
    assert.equal(report.coverage.lastOutcomeAt, '2026-09-03T00:00:00.000Z');
  });
  await t.test('reopened deals do not retain a prior won or lost outcome', async () => {
    await reset(); await add('A', '2026-09-02T00:00:00Z');
    await close('A', '2026-09-03T00:00:00Z'); await add('A', '2026-09-04T00:00:00Z');
    const report = await load(); assert.equal(report.sampleSize, 0); assert.equal(report.winRate, null);
    assert.equal(report.coverage.closedDealsInWindow, 0);
  });
  await t.test('reclosing after reopening selects only the new episode and its new pre-close evidence', async () => {
    await reset(); await add('A', '2026-08-20T00:00:00Z', { score: 90 });
    await close('A', '2026-09-03T00:00:00Z');
    await add('A', '2026-09-04T00:00:00Z', { score: 30 });
    await close('A', '2026-09-10T00:00:00Z', { is_won: 0 });
    await close('A', '2026-09-17T00:00:00Z', { is_won: 0 });
    const report = await load(); assert.equal(report.sampleSize, 1); assert.equal(report.lost, 1); assert.equal(report.won, 0);
    assert.equal(report.lostAverageScore, 30); assert.equal(report.scoreDelta, null);
    assert.equal(report.coverage.firstOutcomeAt, '2026-09-10T00:00:00.000Z');
  });
  await t.test('refreshing an old closed deal cannot move its outcome into the selected period', async () => {
    await reset(); await add('A', '2026-08-10T00:00:00Z'); await close('A', '2026-08-20T00:00:00Z');
    await close('A', '2026-09-17T00:00:00Z');
    const report = await load(); assert.equal(report.sampleSize, 0); assert.equal(report.coverage.closedDealsInWindow, 0);
  });
  await t.test('changed closed labels without a recorded reopening are excluded, even if the label later changes back', async () => {
    await reset(); await add('A', '2026-09-02T00:00:00Z'); await close('A', '2026-09-03T00:00:00Z');
    await close('A', '2026-09-04T00:00:00Z', { is_won: 0 }); await close('A', '2026-09-05T00:00:00Z');
    const report = await load(); assert.equal(report.sampleSize, 0); assert.equal(report.coverage.conflictingOutcomes, 1);
  });
  await t.test('orphan closes and same-instant open/close ties cannot fabricate pre-close evidence', async () => {
    await reset(); await close('orphan', '2026-09-03T00:00:00Z');
    await add('tie', '2026-09-03T00:00:00Z'); await close('tie', '2026-09-03T00:00:00Z');
    const report = await load(); assert.equal(report.sampleSize, 0); assert.equal(report.coverage.withoutPrecloseEvidence, 2);
  });
  await t.test('current assignment, closure dimensions and pre-close dimensions all constrain the cohort', async () => {
    await reset(); await add('A', '2026-09-02T00:00:00Z'); await close('A', '2026-09-03T00:00:00Z');
    await add('B', '2026-09-02T00:00:00Z', { owner_id: '2' });
    await close('B', '2026-09-03T00:00:00Z', { owner_id: '2', is_won: 0 });
    await add('hidden', '2026-09-02T00:00:00Z', { owner_id: '3' });
    await close('hidden', '2026-09-03T00:00:00Z', { owner_id: '3' });
    await add('A', '2026-09-02T00:00:00Z', { portal_id: '200', score: 1 });
    await close('A', '2026-09-03T00:00:00Z', { portal_id: '200', is_won: 0 });
    const report = await load(); assert.equal(report.sampleSize, 2); assert.equal(report.winRate, 50);
    assert.equal(report.wonAverageScore, 70); assert.equal(report.lostAverageScore, 70);
    assert.equal((await load({ ...scope, ownerId: '2' })).sampleSize, 1);
    await close('A', '2026-09-05T00:00:00Z', { owner_id: '3' });
    assert.equal((await load()).sampleSize, 1, 'Transferred-out current state revokes historical access.');
    await close('B', '2026-09-06T00:00:00Z', { owner_id: '2', team_id: 'outside', is_won: 0 });
    assert.equal((await load()).sampleSize, 0);
  });
  await t.test('missing or out-of-scope pre-close dimensions cannot inherit later access', async () => {
    await reset();
    for (const [deal, owner] of [['outside', '3'], ['missing', null]]) {
      await add(deal, '2026-09-02T00:00:00Z', { owner_id: owner });
      await close(deal, '2026-09-03T00:00:00Z');
    }
    const report = await load(); assert.equal(report.sampleSize, 0); assert.equal(report.coverage.precloseOutsideScope, 2);
    await reset(); await add('closed-outside', '2026-09-02T00:00:00Z');
    await close('closed-outside', '2026-09-03T00:00:00Z', { owner_id: '3' });
    await close('closed-outside', '2026-09-05T00:00:00Z');
    assert.equal((await load()).coverage.closedDealsInWindow, 0, 'Reassignment is not a new closure.');
  });
  await t.test('explicit-zone timestamps order by instant and are independent of database timezone', async () => {
    await reset(); await add('A', '2026-09-10T13:00:00+05:30', { score: 30 });
    await add('A', '2026-09-10T08:00:00Z', { score: 80 });
    await close('A', '2026-09-10T08:30:00Z');
    const before = await load(); assert.equal(before.wonAverageScore, 80);
    await client.query("SET LOCAL TIME ZONE 'America/New_York'");
    assert.deepEqual(await load(), before);
    await client.query("SET LOCAL TIME ZONE 'UTC'");
  });
  await t.test('bounds are inclusive, future closes do not leak, and future recorded assignment can revoke access', async () => {
    await reset();
    await add('start', '2026-08-31T00:00:00Z'); await close('start', window.since);
    await add('end', '2026-09-02T00:00:00Z'); await close('end', window.asOf);
    await add('future', '2026-09-02T00:00:00Z'); await close('future', '2026-09-18T12:00:00.001Z');
    assert.equal((await load()).sampleSize, 2);
    await close('end', '2026-09-19T00:00:00Z', { owner_id: '3' });
    assert.equal((await load()).sampleSize, 1);
  });
  await t.test('invalid timestamps withhold scoped evidence rather than dropping an inconvenient transition', async () => {
    for (const timestamp of ['not-a-time', 'infinity', '2026-02-30T00:00:00Z', '2026-09-01T00:00:00']) {
      await reset(); await add('A', '2026-09-02T00:00:00Z'); await close('A', '2026-09-03T00:00:00Z');
      await add('A', timestamp);
      const report = await load(); assert.equal(report.status, 'unavailable');
      assert.equal(report.reason, 'invalid_assessment_timestamps'); assert.equal(report.winRate, null);
    }
    await reset(); await add('A', '2026-09-02T00:00:00Z'); await close('A', '2026-09-03T00:00:00Z');
    await add('foreign', 'not-a-time', { portal_id: '200' });
    await add('hidden', 'not-a-time', { owner_id: '3' });
    assert.equal((await load()).sampleSize, 1, 'Unrelated tenants and scope must not poison the visible report.');
  });
  await t.test('invalid closed/won state flags cannot silently become wins or losses', async () => {
    for (const flags of [{ is_closed: 2 }, { is_closed: null }, { is_won: 2 }, { is_won: null }, { is_closed: 0, is_won: 1 }]) {
      await reset(); await add('A', '2026-09-02T00:00:00Z', flags);
      await close('A', '2026-09-03T00:00:00Z');
      assert.equal((await load()).reason, 'invalid_lifecycle_states');
    }
  });
  await t.test('missing metric values remain null and expose per-group observation counts', async () => {
    await reset(); await add('A', '2026-09-02T00:00:00Z', { score: null, stage_age_days: null });
    await close('A', '2026-09-03T00:00:00Z');
    await add('B', '2026-09-02T00:00:00Z', { score: 60, stage_age_days: 5 });
    await close('B', '2026-09-03T00:00:00Z');
    await add('C', '2026-09-02T00:00:00Z', { score: 40, stage_age_days: null });
    await close('C', '2026-09-03T00:00:00Z', { is_won: 0 });
    const report = await load(); assert.equal(report.sampleSize, 3); assert.equal(report.winRate, 66.7);
    assert.equal(report.wonAverageScore, null); assert.equal(report.lostAverageScore, 40);
    assert.equal(report.scoreDelta, null); assert.equal(report.wonAverageStageAgeDays, null);
    assert.equal(report.lostAverageStageAgeDays, null); assert.equal(report.wonAverageIssues, 0);
    assert.deepEqual(report.coverage.won, { score: 1, issues: 2, stageAge: 1 });
  });
  await t.test('an oversized authorized cohort returns unavailable instead of a truncated win rate', async () => {
    await reset();
    await client.query(`INSERT INTO assessment_history (id, portal_id, deal_id, owner_id, pipeline_id, team_id, region_code,
      assessed_at, is_closed, is_won) SELECT n::text, '100', n::text, '1', 'p1', 't1', 'r1',
      '2026-09-02T00:00:00Z', 1, 1 FROM generate_series(1, 10001) n`);
    const report = await load(); assert.equal(report.status, 'unavailable');
    assert.equal(report.reason, 'portfolio_limit_exceeded'); assert.equal(report.coverage, null);
  });
  await t.test('the retained observation cap is enforced even when only one deal is represented', async () => {
    await reset();
    await client.query(`INSERT INTO assessment_history (id, portal_id, deal_id, owner_id, pipeline_id, team_id, region_code,
      assessed_at, is_closed, is_won) SELECT n::text, '100', 'A', '1', 'p1', 't1', 'r1',
      '2026-09-02T00:00:00Z', 1, 1 FROM generate_series(1, 250001) n`);
    const report = await load(); assert.equal(report.status, 'unavailable');
    assert.equal(report.reason, 'history_limit_exceeded'); assert.equal(report.winRate, null);
  });
});

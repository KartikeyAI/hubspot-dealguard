import test from 'node:test';
import assert from 'node:assert/strict';
import { portfolioHistory } from '../dist/portfolio-history.js';

const databaseUrl = process.env.DEALGUARD_ANALYTICS_TEST_DATABASE_URL;
if (process.env.GITHUB_WORKFLOW === 'CI' && !databaseUrl) throw new Error('Canonical CI requires the isolated analytics PostgreSQL fixture.');

test('portfolio carry-forward executes on the migrated PostgreSQL schema', { skip: !databaseUrl }, async (t) => {
  const { Client } = await import('pg');
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  t.after(async () => { await client.query('ROLLBACK'); await client.end(); });
  await client.query('BEGIN');
  await client.query('CREATE TEMP TABLE assessment_history AS SELECT * FROM dealguard.assessment_history WITH NO DATA');
  await client.query('SET LOCAL search_path TO pg_temp, public');
  const now = Date.parse('2026-03-08T12:00:00.000Z');
  const actor = { portalId: '100', userId: '1', userEmail: 'owner@example.test' };
  const assignment = { pipelineIds: ['p1'], ownerIds: ['1', '2'], teamIds: ['t1'], regionCodes: ['r1'] };
  let sequence = 0, queries = 0;
  const add = async (deal, at, extra = {}) => {
    const value = { id: String(++sequence).padStart(7, '0'), portal_id: '100', deal_id: deal,
      score: 40, grade: 'F', status: 'critical', issue_codes_json: '["gap"]', issue_count: 1,
      pipeline_id: 'p1', pipeline_label: 'Pipeline', stage_id: 's1', stage_label: 'Qualified',
      owner_id: '1', team_id: 't1', region_code: 'r1', is_closed: 0, is_won: 0,
      deal_amount: 100, deal_currency_code: 'USD', deal_amount_in_company_currency: 100,
      trigger_type: 'fixture', assessed_at: at, ...extra };
    const keys = Object.keys(value);
    await client.query(`INSERT INTO assessment_history (${keys.join(',')}) VALUES (${keys.map((_, i) => `$${i + 1}`).join(',')})`, Object.values(value));
  };
  const reset = async () => { await client.query('TRUNCATE assessment_history'); sequence = 0; };
  const envFor = (scope = assignment, role = 'revops_manager') => ({ DB: { prepare(sql) { return { bind(...params) {
    const execute = async () => {
      if (sql.includes('FROM enterprise_role_assignments')) return { rows: [{ role, permissions_json: '[]',
        pipeline_ids_json: JSON.stringify(scope.pipelineIds), owner_ids_json: JSON.stringify(scope.ownerIds),
        team_ids_json: JSON.stringify(scope.teamIds), region_codes_json: JSON.stringify(scope.regionCodes) }] };
      queries += 1;
      let index = 0;
      const query = sql.replace(/\?/g, () => `$${++index}`);
      assert.equal(index, params.length);
      assert.doesNotMatch(sql, /INSERT INTO|UPDATE |DELETE FROM/);
      return client.query(query, params);
    };
    return { async first() { return (await execute()).rows[0] ?? null; },
      async all() { return { results: (await execute()).rows }; } };
  } }; } } });
  const load = (extra = '', env = envFor(), at = now) => portfolioHistory(env, actor,
    new URL(`https://example.test/api/v1/enterprise/portfolio-history?days=8${extra}`), at);

  await t.test('a pre-window seed carries without fabricating a fresh observation', async () => {
    await reset(); await add('A', '2026-02-28T10:00:00.000Z');
    const report = await load(); assert.equal(report.status, 'available'); assert.equal(report.points.length, 8);
    for (const point of report.points) {
      assert.equal(point.openDeals, 1); assert.equal(point.assessedDeals, 0); assert.equal(point.carriedForwardDeals, 1);
      assert.equal(point.freshness.oldestObservedAt, '2026-02-28T10:00:00.000Z');
      assert.equal(point.monetary.pipelineAmount, 100);
    }
    assert.equal(report.points[0].freshness.agingDeals, 1);
    assert.equal(report.points.at(-1).freshness.staleDeals, 1);
    assert.equal(report.points.at(-1).snapshotAt, '2026-03-08T12:00:00.000Z');
  });
  await t.test('unknown days are unavailable; a recorded closure is not zero-score readiness', async () => {
    await reset(); await add('A', '2026-03-03T10:00:00.000Z');
    await add('A', '2026-03-05T10:00:00.000Z', { is_closed: 1, is_won: 1 });
    const { points } = await load();
    assert.equal(points[0].evidenceStatus, 'no_observations'); assert.equal(points[0].averageScore, null);
    assert.equal(points[0].monetary.pipelineAmount, null);
    assert.equal(points[2].openDeals, 1); assert.equal(points[2].assessedDeals, 1);
    assert.equal(points[4].openDeals, 0); assert.equal(points[4].closedDeals, 1); assert.equal(points[4].averageScore, null);
  });
  await t.test('same-day deduplication, tie order, closure and reopening retain the last recorded state', async () => {
    await reset(); await add('A', '2026-03-01T10:00:00.000Z');
    await add('A', '2026-03-04T10:00:00.000Z', { score: 60 });
    await add('A', '2026-03-04T10:00:00.000Z', { score: 80, status: 'ready' });
    await add('A', '2026-03-05T10:00:00.000Z', { is_closed: 1 });
    await add('A', '2026-03-07T10:00:00.000Z', { score: 65 });
    const { points } = await load();
    assert.equal(points[3].averageScore, 80); assert.equal(points[3].assessedDeals, 1);
    assert.equal(points[4].openDeals, 0); assert.equal(points[5].openDeals, 0);
    assert.equal(points[6].openDeals, 1); assert.equal(points[6].averageScore, 65);
    assert.equal(points[7].carriedForwardDeals, 1);
  });
  await t.test('current access and historical dimensions both apply without resurrecting a filtered prior state', async () => {
    await reset(); await add('A', '2026-03-01T10:00:00.000Z');
    await add('A', '2026-03-04T10:00:00.000Z', { owner_id: '2' });
    const selected = await load('&ownerId=1');
    assert.equal(selected.points[2].openDeals, 1); assert.equal(selected.points[3].openDeals, 0);
    assert.equal((await load()).points[3].openDeals, 1);
    await add('A', '2026-03-07T10:00:00.000Z', { owner_id: '3' });
    assert.ok((await load()).points.every((point) => point.evidenceStatus === 'no_observations'));
    const before = queries; await assert.rejects(load('&ownerId=3'), { status: 403 }); assert.equal(queries, before);
  });
  await t.test('portal isolation and missing scope dimensions cannot enter totals', async () => {
    await reset(); await add('A', '2026-03-01T10:00:00.000Z');
    for (const extra of [{ portal_id: '200' }, { team_id: null }, { region_code: 'other' }, { pipeline_id: 'other' }]) {
      await add(`hidden-${sequence}`, '2026-03-01T10:00:00.000Z', { deal_amount: 999999, ...extra });
    }
    assert.equal((await load()).points.at(-1).openDeals, 1);
    assert.equal((await load()).points.at(-1).monetary.pipelineAmount, 100);
    const before = queries; await assert.rejects(load('', envFor(assignment, 'billing_administrator')), { status: 403 });
    assert.equal(queries, before);
  });
  await t.test('mixed/unknown source currencies suppress unsafe amounts while comparable company values work', async () => {
    await reset(); await add('A', '2026-03-01T10:00:00.000Z', { deal_amount_in_company_currency: null });
    await add('B', '2026-03-01T10:00:00.000Z', { deal_currency_code: 'INR', deal_amount_in_company_currency: null });
    assert.equal((await load()).points[0].monetary.pipelineAmount, null);
    await client.query("UPDATE assessment_history SET deal_currency_code = 'USD'");
    assert.equal((await load()).points[0].monetary.pipelineAmount, 200);
    await client.query("UPDATE assessment_history SET deal_currency_code = NULL WHERE deal_id = 'B'");
    assert.equal((await load()).points[0].monetary.pipelineAmount, null);
    await client.query('UPDATE assessment_history SET deal_amount_in_company_currency = 500');
    assert.equal((await load()).points[0].monetary.pipelineAmount, 1000);
  });
  await t.test('UTC boundaries do not depend on the PostgreSQL session timezone and future observations do not enter daily values', async () => {
    await reset(); await add('A', '2026-03-02T01:00:00+05:30');
    await add('A', '2026-03-09T10:00:00.000Z', { score: 99 });
    await client.query("SET LOCAL TIME ZONE 'America/New_York'");
    const report = await load();
    assert.equal(report.points[0].assessedDeals, 1); assert.equal(report.points[0].freshness.oldestObservedAt, '2026-03-01T19:30:00.000Z');
    assert.equal(report.points.at(-1).averageScore, 40);
    await client.query("SET LOCAL TIME ZONE 'UTC'");
  });
  await t.test('freshness thresholds use the observation clock, including exact boundaries', async () => {
    await reset(); await add('A', '2026-03-07T12:00:00.000Z'); await add('B', '2026-03-05T12:00:00.000Z');
    const point = (await load()).points.at(-1);
    assert.equal(point.freshness.freshDeals, 1); assert.equal(point.freshness.agingDeals, 1); assert.equal(point.freshness.staleDeals, 0);
    const later = (await load('', envFor(), now + 1)).points.at(-1);
    assert.equal(later.freshness.freshDeals, 0); assert.equal(later.freshness.agingDeals, 1); assert.equal(later.freshness.staleDeals, 1);
  });
  await t.test('invalid timestamps withhold history instead of falling back to a convenient prior state', async () => {
    await reset(); await add('A', '2026-03-01T10:00:00.000Z'); await add('A', '2026-02-30T10:00:00Z');
    const report = await load(); assert.equal(report.status, 'unavailable'); assert.equal(report.reason, 'invalid_assessment_timestamps');
    assert.deepEqual(report.points, []);
  });
  await t.test('10,000 seeded deals yield a complete bounded 90-day series', async () => {
    await reset();
    await client.query(`INSERT INTO assessment_history (id, portal_id, deal_id, owner_id, pipeline_id, team_id, region_code,
      assessed_at, is_closed, score, status, deal_amount, deal_currency_code, deal_amount_in_company_currency)
      SELECT n::text, '100', n::text, '1', 'p1', 't1', 'r1', '2025-12-01T00:00:00.000Z', 0, 80, 'ready', 100, 'USD', 100
      FROM generate_series(1,10000) n`);
    const started = performance.now();
    const report = await portfolioHistory(envFor(), actor,
      new URL('https://example.test/api/v1/enterprise/portfolio-history?days=90'), now);
    assert.equal(report.status, 'available'); assert.equal(report.points.length, 90);
    assert.ok(report.points.every((point) => point.openDeals === 10000 && point.carriedForwardDeals === 10000));
    assert.equal(report.points.at(-1).monetary.pipelineAmount, 1000000);
    t.diagnostic(`10,000-deal/90-day single-observation fixture completed in ${Math.round(performance.now() - started)} ms; not a production SLO benchmark.`);
  });
  await t.test('oversized authorized portfolios do not expose truncated totals', async () => {
    await reset();
    await client.query(`INSERT INTO assessment_history (id, portal_id, deal_id, owner_id, pipeline_id, team_id, region_code, assessed_at)
      SELECT n::text, '100', n::text, '1', 'p1', 't1', 'r1', '2026-03-01T00:00:00.000Z' FROM generate_series(1,10001) n`);
    const report = await load(); assert.equal(report.reason, 'portfolio_limit_exceeded'); assert.deepEqual(report.points, []);
  });
});

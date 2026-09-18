import test from 'node:test';
import assert from 'node:assert/strict';
import { persistDecisionSnapshot } from '../dist/decision-snapshot.js';

const databaseUrl = process.env.DEALGUARD_ANALYTICS_TEST_DATABASE_URL;
if (process.env.GITHUB_WORKFLOW === 'CI' && !databaseUrl) throw new Error('Canonical CI requires the isolated analytics PostgreSQL fixture.');

test('snapshot acceptance and monotonic persistence on migrated PostgreSQL', { skip: !databaseUrl }, async (t) => {
  const { Client } = await import('pg');
  const { postgresSql } = await import('../dist/postgres.js');
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  t.after(async () => { await client.query('ROLLBACK'); await client.end(); });
  await client.query('BEGIN');
  for (const table of ['deal_assessments', 'deal_decision_snapshots']) {
    await client.query(`CREATE TEMP TABLE ${table} AS SELECT * FROM dealguard.${table} WITH NO DATA`);
    await client.query(`ALTER TABLE ${table} ADD PRIMARY KEY (portal_id, deal_id)`);
  }
  await client.query('SET LOCAL search_path TO pg_temp, public');
  const now = Date.now(), at = h => new Date(now - h * 3_600_000).toISOString();
  // Old evidence deliberately avoids creating recommendation work; only real snapshot SQL executes.
  const payload = (extra = {}) => ({ dealId: '1', isClosed: false, score: 80, status: 'ready', assessedAt: at(80),
    intelligence: { dealBrief: { generatedAt: at(2), status: 'on_track', attentionScore: 20,
      confidence: 'high', coverage: { percent: 100 }, freshness: { status: 'fresh' }, risks: [], nextAction: null } }, ...extra });
  const p = payload();
  const calls = [];
  const env = { DB: { prepare(sql) { return { bind(...params) { return {
    async first() {
      assert.match(sql, /INSERT INTO deal_decision_snapshots/, 'No downstream recommendation queries from stale or rejected evidence.');
      calls.push({ sql, params });
      return (await client.query(postgresSql.placeholders(sql), params)).rows[0] ?? null;
    },
  }; } }; } } };
  const current = async (assessmentAt = at(80), closed = 0, portal = '100') => {
    await client.query(`INSERT INTO deal_assessments (portal_id, deal_id, assessed_at, is_closed)
      VALUES ($1, '1', $2, $3) ON CONFLICT (portal_id, deal_id)
      DO UPDATE SET assessed_at = excluded.assessed_at, is_closed = excluded.is_closed`, [portal, assessmentAt, closed]);
  };
  const saved = async (portal = '100') => (await client.query(
    "SELECT * FROM deal_decision_snapshots WHERE portal_id = $1 AND deal_id = '1'", [portal])).rows[0];

  await t.test('rejects an absent current assessment without creating a snapshot', async () => {
    assert.equal(await persistDecisionSnapshot(env, '100', '1', p), false);
    assert.equal(await saved(), undefined);
  });
  await t.test('accepts matching observed state and derives freshness rather than trusting its label', async () => {
    await current();
    assert.equal(await persistDecisionSnapshot(env, '100', '1', p), true);
    const s = await saved(); assert.equal(s.freshness_status, 'stale'); assert.equal(s.confidence, 'low');
    assert.equal(s.assessment_at, at(80)); assert.equal(s.generated_at, at(2));
  });
  await t.test('exact replay is a no-op, preserving updated and source timestamps', async () => {
    const before = await saved();
    assert.equal(await persistDecisionSnapshot(env, '100', '1', p), false);
    assert.deepEqual(await saved(), before);
  });
  await t.test('older generation of the same assessment cannot replace a newer brief', async () => {
    const before = await saved(), older = structuredClone(p);
    older.intelligence.dealBrief.generatedAt = at(3);
    older.intelligence.dealBrief.attentionScore = 99;
    assert.equal(await persistDecisionSnapshot(env, '100', '1', older), false);
    assert.deepEqual(await saved(), before);
  });
  await t.test('newer generation can update the same source without renewing observation age', async () => {
    const newer = structuredClone(p); newer.intelligence.dealBrief.generatedAt = at(1);
    assert.equal(await persistDecisionSnapshot(env, '100', '1', newer), true);
    assert.equal((await saved()).assessment_at, at(80));
    assert.equal((await saved()).freshness_status, 'stale');
  });
  await t.test('newer assessment must match the recorded current assessment before it is accepted', async () => {
    const newer = payload({ assessedAt: at(79) });
    assert.equal(await persistDecisionSnapshot(env, '100', '1', newer), false);
    await current(at(79));
    assert.equal(await persistDecisionSnapshot(env, '100', '1', newer), true);
    assert.equal((await saved()).assessment_at, at(79));
  });
  await t.test('older evidence cannot overwrite newer source even after a regressed current row', async () => {
    await current(at(80));
    const before = await saved(), older = structuredClone(p); older.intelligence.dealBrief.generatedAt = at(0.5);
    assert.equal(await persistDecisionSnapshot(env, '100', '1', older), false);
    assert.deepEqual(await saved(), before);
  });
  await t.test('stale open payload cannot recreate a brief when the recorded deal is closed', async () => {
    await current(at(79), 1);
    await client.query("DELETE FROM deal_decision_snapshots WHERE portal_id = '100'");
    assert.equal(await persistDecisionSnapshot(env, '100', '1', payload({ assessedAt: at(79) })), false);
    assert.equal(await saved(), undefined);
  });
  await t.test('same deal ID in a different portal is isolated, including current-state validation', async () => {
    await current(at(80), 0, '200');
    assert.equal(await persistDecisionSnapshot(env, '200', '1', p), true);
    assert.equal(await persistDecisionSnapshot(env, '100', '1', p), false);
    assert.ok(await saved('200')); assert.equal(await saved('100'), undefined);
  });
  await t.test('equivalent zoned instants match current source at exact millisecond precision', async () => {
    const iso = at(80), milliseconds = Date.parse(iso);
    const shifted = new Date(milliseconds + 5.5 * 3_600_000).toISOString().replace('Z', '+05:30');
    await current(shifted, 0, '300');
    assert.equal(await persistDecisionSnapshot(env, '300', '1', p), true);
    assert.equal((await saved('300')).assessment_at, iso);
    await current(new Date(milliseconds + 1).toISOString(), 0, '400');
    assert.equal(await persistDecisionSnapshot(env, '400', '1', p), false);
  });
  await t.test('invalid and misaddressed evidence never reaches SQL', async () => {
    const count = calls.length;
    const invalid = payload(); invalid.intelligence.dealBrief.generatedAt = null;
    assert.equal(await persistDecisionSnapshot(env, '200', '1', invalid), false);
    assert.equal(await persistDecisionSnapshot(env, '200', '2', p), false);
    assert.equal(calls.length, count);
  });
});

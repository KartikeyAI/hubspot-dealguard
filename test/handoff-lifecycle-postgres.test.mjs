import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Repository } from '../dist/repository.js';
const databaseUrl = process.env.DEALGUARD_ANALYTICS_TEST_DATABASE_URL;
if (process.env.GITHUB_WORKFLOW === 'CI' && !databaseUrl) throw new Error('Canonical CI requires the isolated PostgreSQL fixture.');

test('durable handoff cycles and monotonic assessment writes on migrated PostgreSQL', { skip: !databaseUrl }, async t => {
  const { Client } = await import('pg');
  const { postgresSql } = await import('../dist/postgres.js');
  const client = new Client({ connectionString: databaseUrl }); await client.connect();
  t.after(async () => { await client.query('ROLLBACK'); await client.end(); });
  await client.query('BEGIN');
  await client.query('SET LOCAL search_path TO dealguard, public');
  const portal = `handoff-test-${randomUUID()}`, other = `${portal}-other`;
  const now = Date.now(), at = n => new Date(now - 100000 + n * 1000).toISOString();
  for (const p of [portal, other]) await client.query(`INSERT INTO tenants (portal_id, app_id,
    access_token_cipher, access_token_iv, refresh_token_cipher, refresh_token_iv,
    token_expires_at, settings_json, installed_at, updated_at, next_scan_at)
    VALUES ($1,'test','test','test','test','test',$2,'{}',$2,$2,$2)`, [p, at(0)]);
  const env = { DB: { prepare(sql) { return { bind(...params) {
    const run = () => client.query(postgresSql.placeholders(postgresSql.qualifyRelations(sql)), params);
    return { async first() { return (await run()).rows[0] ?? null; },
      async run() { const v = await run(); return { success: true, results: v.rows }; } };
  } }; } } };
  const repo = new Repository(env); repo.audit = async () => {};
  const actor = { portalId: portal, userId: 'user', userEmail: 'test@example.test' };
  const a = (n, won = true) => ({ dealId: '1', dealName: 'Fixture', pipelineLabel: 'Sales', stageLabel: 'Fixture',
    score: 90, grade: 'A', status: 'ready', issues: [], readinessSummary: 'Fixture',
    isClosed: won, isWon: won, handoffEligible: won, assessedAt: at(n) });
  const handoff = async (p = portal) => (await client.query('SELECT * FROM handoffs WHERE portal_id=$1 AND deal_id=$2', [p, '1'])).rows[0];
  const cycles = async () => (await client.query('SELECT * FROM handoff_cycles WHERE portal_id=$1 ORDER BY cycle_number', [portal])).rows;

  await t.test('an open assessment has no handoff; first observed win starts exactly one cycle', async () => {
    assert.equal(await repo.saveAssessment(portal, a(1, false)), true);
    assert.equal(await handoff(), undefined);
    assert.equal(await repo.saveAssessment(portal, a(2)), true);
    assert.equal((await handoff()).started_at, at(2));
    assert.equal((await handoff()).cycle_number, 1);
    assert.equal((await cycles()).length, 1);
  });
  await t.test('refreshing a won deal does not restart its timer', async () => {
    await repo.saveAssessment(portal, a(3));
    assert.equal((await handoff()).started_at, at(2));
  });
  await t.test('confirmation retries preserve the original timestamp and actor', async () => {
    const first = await repo.confirmHandoff(actor, '1', a(3));
    const second = await repo.confirmHandoff({ ...actor, userId: 'another' }, '1', a(3));
    assert.equal(first.changed, true); assert.equal(second.changed, false);
    assert.equal(first.confirmedAt, second.confirmedAt);
    assert.equal((await cycles())[0].confirmed_by_user_id, 'user');
  });
  await t.test('reopening invalidates current confirmation but preserves completed cycle evidence', async () => {
    await repo.saveAssessment(portal, a(4, false));
    assert.equal((await handoff()).active, 0);
    assert.equal((await handoff()).confirmed_at, null);
    const old = (await cycles())[0];
    assert.equal(old.status, 'confirmed'); assert.equal(old.end_reason, 'deal_reopened');
    await assert.rejects(repo.confirmHandoff(actor, '1', a(3)), { status: 409 });
  });
  await t.test('reclosing starts a new independent cycle', async () => {
    await repo.saveAssessment(portal, a(5));
    assert.equal((await handoff()).cycle_number, 2);
    assert.equal((await handoff()).started_at, at(5));
    assert.equal((await handoff()).status, 'pending');
  });
  await t.test('out-of-order and exact-replay assessment writes cannot regress the cycle', async () => {
    const before = await handoff();
    assert.equal(await repo.saveAssessment(portal, a(4, false)), false);
    assert.equal(await repo.saveAssessment(portal, a(5)), false);
    assert.deepEqual(await handoff(), before);
    assert.equal((await cycles()).length, 2);
  });
  await t.test('uncompleted handoff is cancelled when deal ceases to be won', async () => {
    await repo.saveAssessment(portal, a(6, false));
    assert.equal((await cycles())[1].status, 'cancelled');
    assert.equal((await cycles())[1].ended_at, at(6));
  });
  await t.test('critical deal cannot confirm; a new assessment must match exactly', async () => {
    const critical = { ...a(7), status: 'critical', score: 20 };
    await repo.saveAssessment(portal, critical);
    await assert.rejects(repo.confirmHandoff(actor, '1', critical), { status: 409 });
    await repo.saveAssessment(portal, a(8));
    await assert.rejects(repo.confirmHandoff(actor, '1', a(7)), { status: 409 });
    assert.equal((await repo.confirmHandoff(actor, '1', a(8))).changed, true);
  });
  await t.test('same deal IDs are isolated by portal and cycles cascade on deletion', async () => {
    await repo.saveAssessment(other, a(1));
    assert.equal((await handoff(other)).cycle_number, 1);
    await client.query('DELETE FROM deal_assessments WHERE portal_id=$1', [other]);
    assert.equal((await client.query('SELECT COUNT(*) FROM handoff_cycles WHERE portal_id=$1', [other])).rows[0].count, '0');
    assert.equal((await cycles()).length, 3);
  });
});

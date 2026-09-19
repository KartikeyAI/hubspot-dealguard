import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { capturePortfolioSnapshot, portfolioCaptureQuery, recordedPortfolioHistory } from '../dist/portfolio-snapshots.js';
const url = process.env.DEALGUARD_ANALYTICS_TEST_DATABASE_URL;
if (process.env.GITHUB_WORKFLOW === 'CI' && !url) throw new Error('Canonical CI requires PostgreSQL fixture.');

test('durable portfolio capture, immutability, retention independence and scoped reads', { skip: !url }, async t => {
  const { Client } = await import('pg');
  const { postgresSql } = await import('../dist/postgres.js');
  const db = new Client({ connectionString: url }); await db.connect();
  t.after(async () => { await db.query('ROLLBACK'); await db.end(); });
  await db.query('BEGIN'); await db.query('SET LOCAL search_path TO dealguard, public');
  const portal = randomUUID(), other = randomUUID(), now = Date.now();
  const at = new Date(now - 3600000).toISOString(), today = new Date(now).toISOString().slice(0,10);
  for (const p of [portal, other]) await db.query(`INSERT INTO tenants (portal_id, app_id,
    access_token_cipher, access_token_iv, refresh_token_cipher, refresh_token_iv,
    token_expires_at, settings_json, installed_at, updated_at, next_scan_at)
    VALUES ($1,'test','test','test','test','test',$2,'{}',$2,$2,$2)`, [p,at]);
  const insert = async (p, deal, owner, amount = 100) => db.query(`INSERT INTO assessment_history
    (id,portal_id,deal_id,score,grade,status,issue_codes_json,issue_count,pipeline_id,pipeline_label,
      stage_id,stage_label,owner_id,team_id,region_code,deal_amount,deal_currency_code,
      deal_amount_in_company_currency,stage_age_days,is_closed,is_won,trigger_type,assessed_at)
    VALUES ($1,$2,$3,80,'B','ready','[]',0,'p','Sales','s','Open',$4,'t','r',$5::double precision,'USD',$5::double precision,2,0,0,'test',$6)`,
    [randomUUID(),p,deal,owner,amount,at]);
  const env = { DB: { prepare(sql) { return { bind(...params) {
    const run = () => db.query(postgresSql.placeholders(postgresSql.qualifyRelations(sql)), params);
    return { async first() { return (await run()).rows[0] ?? null; }, async all() { return { results:(await run()).rows }; },
      async run() { return { success: true, results:(await run()).rows }; } };
  } }; } } };
  const actor = { portalId: portal, userId:'owner',userEmail:'owner@example.test' };
  const accessEnv = scope => ({ DB: { prepare(sql) {
    if (sql.includes('FROM enterprise_role_assignments')) return { bind() { return { async first() { return {
      role:'viewer',permissions_json:'[]',pipeline_ids_json:'[]',owner_ids_json:JSON.stringify(scope),
      team_ids_json:'[]',region_codes_json:'[]' }; } }; } };
    return env.DB.prepare(sql);
  } } });
  const read = scope => recordedPortfolioHistory(accessEnv(scope), actor,
    new URL('https://example.test/api/v1/enterprise/portfolio-snapshots?days=7'));
  await t.test('empty evidence does not become a zero-valued snapshot', async () => {
    assert.equal((await capturePortfolioSnapshot(env, portal)).status,'no_observations');
    assert.equal((await read([])).points.at(-1).evidenceStatus,'not_captured');
  });
  await insert(portal,'1','a',100); await insert(portal,'2','b',200); await insert(other,'1','a',900000);
  await t.test('manifest and all items are written atomically with a content fingerprint', async () => {
    assert.equal((await capturePortfolioSnapshot(env,portal)).status,'captured');
    const r = (await db.query('SELECT * FROM portfolio_snapshot_runs WHERE portal_id=$1',[portal])).rows[0];
    assert.equal(r.deal_count,2); assert.match(r.source_fingerprint,/^[0-9a-f]{64}$/);
    assert.equal((await db.query('SELECT COUNT(*) FROM portfolio_snapshot_items WHERE portal_id=$1',[portal])).rows[0].count,'2');
  });
  await t.test('same-day recapture cannot revise its original source state', async () => {
    const before=(await db.query('SELECT * FROM portfolio_snapshot_items WHERE portal_id=$1 ORDER BY deal_id',[portal])).rows;
    await insert(portal,'3','a',500);
    assert.equal((await capturePortfolioSnapshot(env,portal)).status,'already_captured');
    assert.deepEqual((await db.query('SELECT * FROM portfolio_snapshot_items WHERE portal_id=$1 ORDER BY deal_id',[portal])).rows,before);
  });
  await t.test('read totals use frozen evidence and current plus captured scope', async () => {
    const all=await read([]), scoped=await read(['a']);
    assert.equal(all.points.at(-1).openDeals,2); assert.equal(all.points.at(-1).monetary.pipelineAmount,300);
    assert.equal(scoped.points.at(-1).openDeals,1); assert.equal(scoped.points.at(-1).monetary.pipelineAmount,100);
    assert.equal(all.points[0].evidenceStatus,'not_captured');
    assert.equal(all.points.at(-1).date,today);
  });
  await t.test('captured items reject UPDATE without changing evidence', async () => {
    await db.query('SAVEPOINT immutable');
    await assert.rejects(db.query('UPDATE portfolio_snapshot_items SET score=100 WHERE portal_id=$1',[portal]),{code:'55000'});
    await db.query('ROLLBACK TO SAVEPOINT immutable');
    assert.equal((await read([])).points.at(-1).averageScore,80);
  });
  await t.test('history retention does not erase a capture; scoped reads cannot invent current permission', async () => {
    await db.query('DELETE FROM assessment_history WHERE portal_id=$1',[portal]);
    assert.equal((await read([])).points.at(-1).monetary.pipelineAmount,300);
    assert.equal((await read(['a'])).points.at(-1).evidenceStatus,'no_in_scope_observations');
  });
  await t.test('incomplete captures are withheld rather than returning partial totals', async () => {
    await db.query("DELETE FROM portfolio_snapshot_items WHERE portal_id=$1 AND deal_id='1'",[portal]);
    const data=await read([]); assert.equal(data.status,'unavailable'); assert.equal(data.points.length,0);
  });
  await t.test('deleting the manifest deletes items through a tenant-safe foreign key', async () => {
    await db.query('DELETE FROM portfolio_snapshot_runs WHERE portal_id=$1',[portal]);
    assert.equal((await db.query('SELECT COUNT(*) FROM portfolio_snapshot_items WHERE portal_id=$1',[portal])).rows[0].count,'0');
  });
  await t.test('capture builder binds identifiers and rejects oversized cohorts without a partial manifest', async () => {
    const query=portfolioCaptureQuery(other,new Date().toISOString(),randomUUID());
    assert.ok(!query.sql.includes(other)); assert.equal(query.params[0],other);
    // A small fixture override exercises the exact guard without fabricating application totals.
    const params=[...query.params]; params[7]=0;
    const row=(await db.query(postgresSql.placeholders(query.sql),params)).rows[0];
    assert.equal(row.copied,0); assert.equal(row.id,null);
  });
});

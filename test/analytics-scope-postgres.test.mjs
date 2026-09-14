import test from 'node:test';
import assert from 'node:assert/strict';
import { enterpriseAnalyticsV2, listAnalyticsViews, saveAnalyticsView, deleteAnalyticsView,
  exportAnalyticsCsv } from '../dist/enterprise-analytics-v2.js';

const databaseUrl = process.env.DEALGUARD_ANALYTICS_TEST_DATABASE_URL;
if (process.env.GITHUB_WORKFLOW === 'CI' && !databaseUrl) throw new Error('Canonical CI requires the isolated analytics PostgreSQL fixture.');

// No provider requests or permanent-table writes. Tables inherit actual migrated column types.
test('analytics SQL and saved-view isolation on migrated PostgreSQL', { skip: !databaseUrl }, async (t) => {
  const { Client } = await import('pg');
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  t.after(async () => { await client.query('ROLLBACK'); await client.end(); });
  await client.query('BEGIN');
  for (const name of ['assessment_history', 'handoffs', 'policy_versions', 'analytics_saved_views']) {
    await client.query(`CREATE TEMP TABLE ${name} AS SELECT * FROM dealguard.${name} WITH NO DATA`);
  }
  await client.query('ALTER TABLE analytics_saved_views ADD PRIMARY KEY (id)');
  await client.query('SET LOCAL search_path TO pg_temp, public');
  const scope = { pipelineIds: ['p1', 'p2'], ownerIds: ['1', '2'], teamIds: ['t1'], regionCodes: ['r1'] };
  const actor = { portalId: '100', userId: '1', userEmail: 'owner@example.test' };
  const iso = (days) => new Date(Date.now() - days * 86400000).toISOString();
  const earlier = iso(3), current = iso(1);
  const insert = async (table, data) => {
    const keys = Object.keys(data);
    await client.query(`INSERT INTO ${table} (${keys.join(',')}) VALUES (${keys.map((_, i) => `$${i + 1}`).join(',')})`, Object.values(data));
  };
  let sequence = 0;
  const observation = async (deal, owner, pipeline, at, extra = {}) => insert('assessment_history', {
    id: String(++sequence).padStart(6, '0'), portal_id: '100', deal_id: deal, score: 80, status: 'ready', grade: 'B',
    issue_codes_json: '[]', issue_count: 0, pipeline_id: pipeline, pipeline_label: pipeline, stage_id: 's1', stage_label: 'Qualified',
    owner_id: owner, team_id: 't1', region_code: 'r1', deal_amount: 100, deal_currency_code: 'USD',
    deal_amount_in_company_currency: 100, stage_age_days: 2, is_closed: 0, is_won: 0,
    policy_id: 'policy1', trigger_type: 'test', assessed_at: at, ...extra,
  });
  await insert('policy_versions', { id: 'policy1', portal_id: '100', name: 'Allowed policy' });
  await observation('A', '1', 'p1', earlier, { score: 40, status: 'critical' });
  await observation('A', '1', 'p1', current);
  await observation('B', '2', 'p2', current, { score: 50, status: 'at_risk', deal_amount: 200, deal_amount_in_company_currency: 200, issue_count: 1, issue_codes_json: '["allowed_gap"]' });
  await observation('C', '3', 'p1', current, { pipeline_label: 'FORBIDDEN_OWNER', issue_codes_json: '["FORBIDDEN_OWNER"]' });
  await observation('D', '1', 'p3', current, { pipeline_label: 'FORBIDDEN_PIPELINE' });
  await observation('E', '1', 'p1', current, { team_id: 'other', pipeline_label: 'FORBIDDEN_TEAM' });
  await observation('F', '1', 'p1', current, { region_code: 'other', pipeline_label: 'FORBIDDEN_REGION' });
  await observation('A', '1', 'p1', current, { portal_id: '200', deal_amount: 999999, pipeline_label: 'FORBIDDEN_TENANT' });
  await observation('H', '1', 'p1', iso(6), { pipeline_label: 'FORBIDDEN_MOVED_HISTORY' });
  await observation('H', '3', 'p1', current);
  await observation('I', '1', 'p1', iso(2), { score: 65 });
  await observation('I', '1', 'p1', current, { is_closed: 1, is_won: 1, score: 99 });
  await observation('J', '3', 'p1', iso(5));
  await observation('J', '1', 'p1', current, { deal_amount: 400, deal_amount_in_company_currency: 400 });
  await observation('K', null, 'p1', current);
  // Same-instant ordering must select the newer ID before scope/open filtering.
  await observation('TIE', '1', 'p1', current);
  await observation('TIE', '3', 'p1', current);
  for (const [deal, status, hours] of [['A', 'confirmed', 2], ['B', 'pending', null], ['I', 'confirmed', 4], ['C', 'confirmed', 50], ['H', 'confirmed', 50], ['missing', 'confirmed', 50]]) {
    await insert('handoffs', { id: `handoff-${deal}`, portal_id: '100', deal_id: deal, status,
      created_at: iso(2), confirmed_at: hours === null ? null : new Date(Date.now() - 2 * 86400000 + hours * 3600000).toISOString() });
  }
  const queries = [];
  const envFor = (assignment = scope, role = 'revops_manager') => ({ DB: { prepare(sql) {
    return { bind(...params) {
      const execute = async () => {
        if (sql.includes('FROM enterprise_role_assignments')) return { rows: [{ role, permissions_json: '[]',
          pipeline_ids_json: JSON.stringify(assignment.pipelineIds), owner_ids_json: JSON.stringify(assignment.ownerIds),
          team_ids_json: JSON.stringify(assignment.teamIds), region_codes_json: JSON.stringify(assignment.regionCodes) }] };
        queries.push({ sql, params });
        let index = 0;
        const query = sql.replace(/\?/g, () => `$${++index}`);
        assert.equal(index, params.length, 'Every SQL placeholder must have exactly one bound value.');
        return client.query(query, params);
      };
      return { async first() { return (await execute()).rows[0] ?? null; },
        async all() { return { results: (await execute()).rows }; }, async run() { return execute(); } };
    } };
  } } });
  const env = envFor();
  const url = (query = '') => new URL(`https://example.test/api/v1/enterprise/analytics?days=30&${query}`);

  await t.test('multi-scope current totals, breakdowns, and histories exclude unauthorized evidence', async () => {
    const data = await enterpriseAnalyticsV2(env, actor, url());
    assert.equal(data.current.totalDeals, 3);
    assert.equal(data.current.pipelineAmount, 700);
    assert.equal(data.current.amountWithReadinessGaps, 200);
    assert.equal(data.byOwner.length, 2);
    assert.equal(data.byPipeline.length, 2);
    assert.deepEqual(data.failurePatterns, [{ code: 'allowed_gap', count: 1 }]);
    assert.deepEqual(data.attentionPriority.deals.map((row) => row.dealId).sort(), ['A', 'B', 'J']);
    assert.equal(data.handoffSla.total, 3);
    assert.equal(data.handoffSla.confirmed, 2);
    assert.equal(Math.round(data.handoffSla.averageHours), 3);
    assert.equal(data.outcomeCorrelation.sampleSize, 1);
    assert.equal(data.outcomeCorrelation.wonAverageScore, 65, 'Do not use post-close score 99.');
    assert.equal(data.policyImpact[0].firstAssessedAt, earlier);
    assert.equal(data.policyImpact[0].assessedDeals, 4);
    assert.equal(data.trend.reduce((sum, row) => sum + row.assessedDeals, 0), 5);
    assert.doesNotMatch(JSON.stringify(data), /FORBIDDEN/);
  });
  await t.test('explicit selection narrows rather than overrides assigned scope', async () => {
    const data = await enterpriseAnalyticsV2(env, actor, url('ownerId=1&pipelineId=p1'));
    assert.equal(data.current.totalDeals, 2);
    assert.equal(data.current.pipelineAmount, 500);
    const count = queries.length;
    await assert.rejects(enterpriseAnalyticsV2(env, actor, url('ownerId=3')), { status: 403 });
    assert.equal(queries.length, count, 'Denied filters must not execute aggregate queries.');
  });
  await t.test('single-value scope works and missing observed ownership is not a match', async () => {
    const data = await enterpriseAnalyticsV2(envFor({ ...scope, ownerIds: ['2'] }), actor, url());
    assert.equal(data.current.totalDeals, 1);
    assert.equal(data.handoffSla.total, 1);
    assert.equal(data.current.pipelineAmount, 200);
  });
  await t.test('CSV uses the same scope and requires export permission', async () => {
    const csv = await (await exportAnalyticsCsv(env, actor, url())).text();
    assert.doesNotMatch(csv, /FORBIDDEN/);
    assert.equal(csv.split('\n').length, 3);
    await assert.rejects(exportAnalyticsCsv(envFor(scope, 'viewer'), actor, url()), { status: 403 });
  });
  await t.test('historical authorization follows latest recorded assignment even after transfer', async () => {
    await observation('B', '3', 'p2', iso(0.5));
    const data = await enterpriseAnalyticsV2(env, actor, url());
    assert.equal(data.current.totalDeals, 2);
    assert.equal(data.current.pipelineAmount, 500);
    assert.equal(data.handoffSla.total, 2);
    assert.equal(data.policyImpact[0].assessedDeals, 3);
    assert.equal(data.trend.reduce((sum, row) => sum + row.assessedDeals, 0), 4);
  });
  await t.test('shared views are readable but only the creator can edit or delete', async () => {
    for (const [id, portal, user, email, shared] of [
      ['own', '100', '1', null, 0], ['other', '100', '2', null, 0],
      ['shared', '100', '2', null, 1], ['foreign', '200', '1', null, 1],
      ['legacy', '100', null, 'OWNER@EXAMPLE.TEST', 0],
      ['same-email-different-id', '100', '2', 'owner@example.test', 0],
      ['ownerless', '100', null, null, 0],
    ]) await insert('analytics_saved_views', { id, portal_id: portal, created_by_user_id: user,
      created_by_email: email, is_shared: shared, name: id, filters_json: '{}', columns_json: '[]' });
    assert.deepEqual((await listAnalyticsViews(env, actor)).map((view) => view.id).sort(), ['legacy', 'own', 'shared']);
    assert.deepEqual((await listAnalyticsViews(env, { ...actor, userEmail: null })).map((view) => view.id).sort(), ['own', 'shared']);
    for (const id of ['other', 'shared', 'foreign', 'same-email-different-id', 'ownerless', 'nonexistent']) {
      await assert.rejects(saveAnalyticsView(env, actor, { name: 'not allowed' }, id), { status: 404 });
      await assert.rejects(deleteAnalyticsView(env, actor, id), { status: 404 });
    }
    assert.equal((await client.query("SELECT name FROM analytics_saved_views WHERE id = 'foreign'")).rows[0].name, 'foreign');
    await saveAnalyticsView(env, actor, { name: 'My revised view' }, 'own');
    assert.equal((await client.query("SELECT name FROM analytics_saved_views WHERE id = 'own'")).rows[0].name, 'My revised view');
    await saveAnalyticsView(env, actor, { name: 'Legacy revised' }, 'legacy');
    await deleteAnalyticsView(env, actor, 'own');
    assert.equal((await client.query("SELECT COUNT(*) FROM analytics_saved_views WHERE id = 'own'")).rows[0].count, '0');
    const created = await saveAnalyticsView(env, actor, { name: 'A new view' });
    assert.ok(created.id && !['own', 'other'].includes(created.id));
  });
});

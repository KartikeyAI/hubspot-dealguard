import test from 'node:test';
import assert from 'node:assert/strict';
import { analyticsFilters, analyticsPredicate, selectedAnalyticsFilters, analyticsViewOwner,
  analyticsCsvCell, requireAnalyticsCollectionAccess } from '../dist/analytics-scope.js';

const scope = (extra = {}) => ({ pipelineIds: [], ownerIds: [], teamIds: [], regionCodes: [], ...extra });
const identity = { portalId: '100', userId: '1', userEmail: 'owner@example.test' };
const roleEnvironment = (role, assignment = scope()) => ({ DB: { prepare(sql) {
  assert.match(sql, /FROM enterprise_role_assignments/);
  return { bind() { return { async first() { return {
    role, permissions_json: '[]', pipeline_ids_json: JSON.stringify(assignment.pipelineIds),
    owner_ids_json: JSON.stringify(assignment.ownerIds), team_ids_json: JSON.stringify(assignment.teamIds),
    region_codes_json: JSON.stringify(assignment.regionCodes),
  }; } }; } };
} } });

test('collection access permits a scoped manager without relaxing record-level permissions', async () => {
  const expected = scope({ ownerIds: ['1', '2'] });
  const access = await requireAnalyticsCollectionAccess(roleEnvironment('sales_manager', expected), identity, 'analytics.view');
  assert.deepEqual(access.scope, expected);
  await assert.rejects(requireAnalyticsCollectionAccess(roleEnvironment('viewer'), identity, 'analytics.export'), { status: 403 });
  await assert.rejects(requireAnalyticsCollectionAccess(roleEnvironment('billing_administrator'), identity, 'analytics.view'), { status: 403 });
  await assert.rejects(requireAnalyticsCollectionAccess(roleEnvironment('administrator'), { portalId: '100' }, 'analytics.view'), { code: 'analytics_identity_required' });
});

test('unfiltered analytics keep every allowed value and AND independent scope dimensions', () => {
  const { effective, authorization } = analyticsFilters(scope({
    pipelineIds: ['p1', 'p2'], ownerIds: ['1', '2'], teamIds: ['t1'], regionCodes: ['r1'],
  }), {});
  assert.deepEqual(effective, authorization);
  const predicate = analyticsPredicate('latest', effective);
  assert.equal(predicate.sql, 'latest.pipeline_id IN (?, ?) AND latest.owner_id IN (?, ?) AND latest.team_id IN (?) AND latest.region_code IN (?)');
  assert.deepEqual(predicate.params, ['p1', 'p2', '1', '2', 't1', 'r1']);
});

test('selected filters narrow scope but cannot replace the authorization boundary', () => {
  const { effective, authorization } = analyticsFilters(scope({ ownerIds: ['1', '2'] }), { ownerId: '2', stageId: 's1' });
  assert.deepEqual(analyticsPredicate('daily', effective).params, ['s1', '2']);
  assert.deepEqual(authorization, { ownerId: ['1', '2'] });
  for (const [key, filter] of [['ownerIds', 'ownerId'], ['pipelineIds', 'pipelineId'], ['teamIds', 'teamId'], ['regionCodes', 'regionCode']]) {
    assert.throws(() => analyticsFilters(scope({ [key]: ['allowed'] }), { [filter]: 'other' }), { status: 403 });
  }
});

test('unrestricted scope remains unrestricted, explicit empty SQL sets deny all', () => {
  assert.deepEqual(analyticsPredicate('latest', analyticsFilters(scope(), {}).effective), { sql: 'TRUE', params: [] });
  assert.equal(analyticsPredicate('latest', { ownerId: [] }).sql, 'FALSE');
  assert.throws(() => analyticsFilters(scope({ ownerIds: [''] }), {}), { status: 403 });
  assert.throws(() => analyticsFilters(scope({ ownerIds: Array(501).fill('1') }), {}), { status: 403 });
});

test('filter identifiers are bound, not interpolated into SQL', () => {
  const hostile = "owner'); SELECT pg_sleep(10); --";
  const result = analyticsPredicate('latest', { ownerId: hostile });
  assert.equal(result.sql, 'latest.owner_id IN (?)');
  assert.deepEqual(result.params, [hostile]);
  assert.throws(() => analyticsPredicate('latest; DELETE FROM tenants', {}));
});

test('URL filters reject duplicate, truncated, and whitespace-altered values', () => {
  assert.deepEqual(selectedAnalyticsFilters(new URLSearchParams('ownerId=1&pipelineId=p1')), { pipelineId: 'p1', ownerId: '1' });
  for (const query of ['ownerId=1&ownerId=2', `ownerId=${'a'.repeat(129)}`, 'ownerId=%201', 'ownerId=1%20']) {
    assert.throws(() => selectedAnalyticsFilters(new URLSearchParams(query)), { status: 400 });
  }
  assert.deepEqual(selectedAnalyticsFilters(new URLSearchParams('ownerId=')), {});
});

test('view ownership requires nonempty identity and keeps ID ownership authoritative', () => {
  assert.throws(() => analyticsViewOwner({ userId: '', userEmail: null }), { status: 403 });
  const result = analyticsViewOwner(identity);
  assert.match(result.sql, /NULLIF\(created_by_user_id, ''\) IS NULL/);
  assert.match(result.sql, /\?::text IS NOT NULL/);
  assert.deepEqual(result.params, ['1', 'owner@example.test', 'owner@example.test']);
});

test('CSV cells neutralize spreadsheet formulas, escape text, and preserve missing values', () => {
  for (const input of ['=1+1', '+SUM(A1)', '-1+1', '@SUM(A1)', '  =1', '\ttext', '\rtext', '\ntext']) {
    assert.ok(analyticsCsvCell(input).startsWith('"\''));
  }
  assert.equal(analyticsCsvCell('a,"b"'), '"a,""b"""');
  assert.equal(analyticsCsvCell(null), '""');
  assert.equal(analyticsCsvCell(undefined), '""');
  assert.equal(analyticsCsvCell(0), '"0"');
  assert.equal(analyticsCsvCell(-2), '"-2"');
});

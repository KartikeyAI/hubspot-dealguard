import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { resolve } from 'node:path';
import { Client } from 'pg';
import { recordedAssessment } from '../dist/recorded-assessment.js';
import { buildSourceEvidence } from '../dist/source-evidence.js';
import { localFixtureUrl, readOnlyPortalAdapter, schemaEvidence } from './local-rehearsal-support.mjs';

const source = localFixtureUrl('DEALGUARD_LOCAL_SCALE', 'RUN DISPOSABLE LOCAL SCALE');
const admin = new Client({ connectionString: source.href });
const portals = ['A', 'B'].map(label => ({ label, id: 'local_scale_' + label + '_' + randomUUID(), owner: 'synthetic-owner-' + label }));
const clients = [], seeded = [];
const dealsPerPortal = 5000, concurrency = 8, perPortalConcurrency = concurrency / portals.length;
const metrics = { queries: 0, rows: 0, writeAttempts: 0, unexpectedTenantParameters: 0, unexpectedTenantRows: 0, providerCalls: 0 };
const previousFetch = globalThis.fetch;
const started = performance.now();
const round = value => Math.round(value * 1000) / 1000;
const percentile = (values, quantile) => values[Math.max(0, Math.ceil(values.length * quantile) - 1)];
const summary = values => {
  const sorted = [...values].sort((a, b) => a - b);
  return { count: sorted.length, p50Milliseconds: round(percentile(sorted, .5)), p95Milliseconds: round(percentile(sorted, .95)),
    p99Milliseconds: round(percentile(sorted, .99)), maxMilliseconds: round(sorted.at(-1)) };
};

try {
  await admin.connect();
  if (Number((await admin.query('SELECT COUNT(*) AS n FROM dealguard.tenants')).rows[0].n) !== 0) {
    throw new Error('The source fixture database must contain no existing tenants.');
  }
  const stamp = new Date(Date.now() - 60000).toISOString();
  const risks = JSON.stringify([{ code: 'synthetic-readiness-gap', label: 'Synthetic readiness gap', dimension: 'readiness', severity: 'warning' }]);
  const dimensions = JSON.stringify({ readiness: { score: 55, status: 'at_risk' }, sourceEvidence: buildSourceEvidence({ readiness: stamp }) });
  for (const portal of portals) {
    await admin.query(`INSERT INTO dealguard.tenants(portal_id,app_id,access_token_cipher,access_token_iv,refresh_token_cipher,refresh_token_iv,
      token_expires_at,settings_json,installed_at,updated_at,next_scan_at)
      VALUES($1,'synthetic','unused','unused','unused','unused',$2,'{}',$2,$2,$2)`, [portal.id, stamp]);
    seeded.push(portal.id);
    await admin.query(`INSERT INTO dealguard.enterprise_role_assignments(id,portal_id,user_id,role,pipeline_ids_json,owner_ids_json,created_at,updated_at)
      VALUES($1,$2,'7','viewer','["synthetic-pipeline"]',$3,$4,$4)`, [randomUUID(), portal.id, JSON.stringify([portal.owner]), stamp]);
    await admin.query(`INSERT INTO dealguard.deal_assessments(portal_id,deal_id,deal_name,pipeline_label,stage_label,score,grade,status,
      issues_json,readiness_summary,is_closed,is_won,assessed_at)
      SELECT $1,n::text,$2||n::text,'Synthetic pipeline','Synthetic stage',55,'D','at_risk','[]','Synthetic recorded assessment',0,0,$3
      FROM generate_series(1,$4::integer) n`, [portal.id, 'SYNTHETIC portal ' + portal.label + ' deal ', stamp, dealsPerPortal]);
    await admin.query(`INSERT INTO dealguard.assessment_context(portal_id,deal_id,pipeline_id,owner_id,stage_id,updated_at)
      SELECT $1,n::text,'synthetic-pipeline',$2,'synthetic-stage',$3 FROM generate_series(1,$4::integer) n`, [portal.id, portal.owner, stamp, dealsPerPortal]);
    await admin.query(`INSERT INTO dealguard.assessment_history(id,portal_id,deal_id,score,grade,status,issue_codes_json,issue_count,
      pipeline_id,pipeline_label,stage_id,stage_label,owner_id,is_closed,is_won,trigger_type,assessed_at)
      SELECT gen_random_uuid()::text,$1,n::text,55,'D','at_risk','[]',0,'synthetic-pipeline','Synthetic pipeline',
      'synthetic-stage','Synthetic stage',$2,0,0,'synthetic-local-rehearsal',$3 FROM generate_series(1,$4::integer) n`, [portal.id, portal.owner, stamp, dealsPerPortal]);
    await admin.query(`INSERT INTO dealguard.deal_record_lifecycle(portal_id,deal_id,state,verified_at)
      SELECT $1,n::text,'active',$2::timestamptz FROM generate_series(1,$3::integer) n`, [portal.id, stamp, dealsPerPortal]);
    await admin.query(`INSERT INTO dealguard.deal_decision_snapshots(portal_id,deal_id,assessment_at,generated_at,methodology,brief_status,
      attention_score,confidence,coverage_percent,freshness_status,risk_summary_json,dimensions_json,created_at,updated_at)
      SELECT $1,n::text,$2,$2,'deterministic_evidence_synthesis','watch',45,'low',20,'fresh',$3,$4,$2,$2
      FROM generate_series(1,$5::integer) n`, [portal.id, stamp, risks, dimensions, dealsPerPortal]);
  }
  for (const table of ['deal_assessments', 'assessment_context', 'assessment_history', 'deal_record_lifecycle', 'deal_decision_snapshots']) {
    await admin.query(`ANALYZE dealguard.${table}`);
  }
  const before = await schemaEvidence(admin);
  globalThis.fetch = async () => { metrics.providerCalls++; throw new Error('A recorded read attempted an external request.'); };
  const lanes = [];
  for (const portal of portals) {
    portal.latencies = [];
    for (let lane = 0; lane < perPortalConcurrency; lane++) {
      const client = new Client({ connectionString: source.href });
      await client.connect(); clients.push(client);
      await client.query("SET statement_timeout TO '15s'");
      await client.query('SET default_transaction_read_only TO on');
      const env = { DB: readOnlyPortalAdapter(client, portal.id, portals.map(p => p.id), metrics) };
      const identity = { portalId: portal.id, userId: '7', userEmail: null, appId: 'synthetic' };
      const read = async dealId => {
        const value = await recordedAssessment(env, identity, String(dealId));
        assert.equal(value.dealName, 'SYNTHETIC portal ' + portal.label + ' deal ' + dealId);
        assert.equal(value.dealId, String(dealId));
        assert.equal(value.source, 'recorded_assessment');
        assert.equal(value.assessedAt, stamp);
        assert.equal(value.intelligence?.dealBrief.generatedAt, stamp);
        assert.equal(value.recordCapabilities.canRefresh, false);
      };
      lanes.push({ portal, lane, read });
    }
  }
  // Warm each connection without including startup/planning in the measured run.
  await Promise.all(lanes.map(async lane => { for (let n = 1; n <= 4; n++) await lane.read(n); }));
  const warmupQueries = metrics.queries;
  const measuredStarted = performance.now();
  await Promise.all(lanes.map(async ({ portal, lane, read }) => {
    for (let deal = lane + 1; deal <= dealsPerPortal; deal += perPortalConcurrency) {
      if (performance.now() - measuredStarted > 180000) throw new Error('Local scale rehearsal exceeded its bounded three-minute read window.');
      const start = performance.now();
      await read(deal);
      portal.latencies.push(performance.now() - start);
    }
  }));
  const measuredMilliseconds = performance.now() - measuredStarted;
  const after = await schemaEvidence(admin);
  assert.deepEqual(after, before, 'Recorded reads changed schema table contents.');
  for (const key of ['writeAttempts', 'unexpectedTenantParameters', 'unexpectedTenantRows', 'providerCalls']) assert.equal(metrics[key], 0, key);
  const receipt = {
    schema: 'dealguard-disposable-recorded-read-scale-v1', observedAt: new Date().toISOString(), status: 'passed', syntheticFixture: true,
    scope: 'Actual recordedAssessment service with the production SQL normalization and a loopback node-postgres read-only instrumentation adapter. No HTTP, Workers, Neon or object store.',
    productionLoadVerified: false, cloudflareCpuVerified: false, neonLatencyVerified: false, objectStoreVerified: false,
    productionRpoVerified: false, productionRtoVerified: false,
    service: 'recordedAssessment', adapter: 'local node-postgres; deployed Neon HTTP adapter not exercised',
    deals: dealsPerPortal * portals.length, portals: portals.length, concurrency, perPortalConcurrency, warmupReads: lanes.length * 4,
    measurements: summary(portals.flatMap(portal => portal.latencies)),
    perPortal: portals.map(portal => ({ label: portal.label, ...summary(portal.latencies) })),
    measuredMilliseconds: round(measuredMilliseconds), totalMilliseconds: round(performance.now() - started),
    measuredSqlQueries: metrics.queries - warmupQueries, instrumentation: metrics,
    isolationChecks: 'Each prepared query must bind its lane portal; returned portal_id and full response deal identity are checked. Both portals deliberately share deal IDs. This does not measure physical PostgreSQL row scans.',
    readOnlyPostgresSessions: true, schemaContentsUnchanged: true, tablesVerified: Object.keys(before).length,
    tableFingerprints: before, nodeVersion: process.version,
    postgresVersion: (await admin.query('SHOW server_version')).rows[0].server_version,
  };
  const report = resolve(process.env.DEALGUARD_SCALE_REPORT ?? '/tmp/dealguard-local-scale.json');
  await writeFile(report, JSON.stringify(receipt, null, 2) + '\n', { mode: 0o600 });
  console.log(JSON.stringify({ status: receipt.status, deals: receipt.deals, portals: receipt.portals, concurrency,
    measurements: receipt.measurements, measuredMilliseconds: receipt.measuredMilliseconds,
    writes: metrics.writeAttempts, otherPortalRows: metrics.unexpectedTenantRows, externalCalls: metrics.providerCalls,
    schemaContentsUnchanged: true, productionLoadVerified: false, report }, null, 2));
} finally {
  globalThis.fetch = previousFetch;
  await Promise.all(clients.map(client => client.end().catch(() => undefined)));
  if (seeded.length) await admin.query('DELETE FROM dealguard.tenants WHERE portal_id=ANY($1::text[])', [seeded]).catch(() => undefined);
  await admin.end().catch(() => undefined);
}

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { contextFailures, intelligenceEvidenceFailures, intelligenceFingerprint,
  deploymentEvidenceFailures, stagingRunFailures } from '../scripts/intelligence-certification.mjs';
import { context, intelligenceEvidence, deploymentRecord, workflowMetadata } from './intelligence-evidence-fixtures.mjs';
const { version } = JSON.parse(await readFile('package.json', 'utf8'));

test('complete, current, identity-bound intelligence evidence certifies', () => {
  const expected = context(version);
  assert.deepEqual(intelligenceEvidenceFailures(intelligenceEvidence(expected), expected), []);
  assert.deepEqual(deploymentEvidenceFailures(deploymentRecord(version)), []);
  assert.deepEqual(deploymentEvidenceFailures(deploymentRecord(version, 'production')), []);
});

for (const [name, mutate] of [
  ['missing suite', (e) => { e.results = []; }],
  ['duplicate ID', (e) => { e.results[1].id = e.results[0].id; }],
  ['unknown ID', (e) => { e.results[1].id = 'DG-INT-999'; }],
  ['skipped test', (e) => { e.results[1].status = 'skipped'; }],
  ['optional test', (e) => { e.results[1].required = false; }],
  ['failed test', (e) => { e.results[1].status = 'failed'; }],
  ['string summary count', (e) => { e.summary.passed = '12'; }],
  ['falsified summary', (e) => { e.summary.failed = 1; }],
  ['diagnostic mode', (e) => { e.environment.certificationRequired = false; }],
  ['expired evidence', (e) => { e.startedAt = new Date(Date.now() - 25 * 3600_000).toISOString(); }],
  ['future evidence', (e) => { e.finishedAt = new Date(Date.now() + 3600_000).toISOString(); }],
  ['reversed timestamps', (e) => { e.startedAt = new Date(Date.now() + 1000).toISOString(); }],
  ['invalid timestamps', (e) => { e.finishedAt = 'yesterday'; }],
  ['missing entitlement', (e) => { e.results[0].actual.entitled = false; }],
  ['wrong version', (e) => { e.release = '99.0.0'; }],
  ['wrong commit', (e) => { e.environment.gitSha = 'c'.repeat(40); }],
  ['wrong target', (e) => { e.environment.releaseTarget = 'production'; }],
  ['wrong portal', (e) => { e.environment.portalId = '999'; }],
  ['wrong test deal', (e) => { e.environment.testDealId = '111'; }],
  ['wrong run', (e) => { e.environment.workflowRunId = '999'; }],
  ['old attempt', (e) => { e.environment.workflowRunAttempt = '2'; }],
  ['wrong origin', (e) => { e.environment.baseUrl = 'https://other-staging.example'; }],
  ['credential-bearing origin', (e) => { e.environment.baseUrl = 'https://user:pass@dealguard-api-staging.rokad.co'; }],
]) test(`certification rejects ${name}`, () => {
  const expected = context(version); const e = intelligenceEvidence(expected); mutate(e);
  assert.ok(intelligenceEvidenceFailures(e, expected).length > 0);
});

test('configuration rejects invalid targets, schemes, paths and missing IDs', () => {
  for (const invalid of [{ target: 'prod' }, { baseUrl: 'http://staging.example' }, { baseUrl: 'https://staging.example/path' },
    { baseUrl: 'https://staging.example?secret=value' }, { workflowRunId: '' }, { testDealId: '' }, { commit: 'local' }]) {
    assert.ok(contextFailures({ ...context(version), ...invalid }).length);
  }
});

for (const [name, mutate] of [
  ['legacy schema', (r) => { r.schemaVersion = 3; }],
  ['missing intelligence', (r) => { delete r.intelligence; }],
  ['fingerprint mismatch', (r) => { r.intelligenceSha256 = '0'.repeat(64); }],
  ['wrong baseline', (r) => { r.baseline.source.commit = 'c'.repeat(40); }],
  ['zero preflight tests', (r) => { r.preflight = { total: 0, passed: 0, failed: 0 }; }],
  ['wrong smoke target', (r) => { r.smoke.target = 'production'; }],
  ['missing smoke tests', (r) => { r.smoke.checks = []; }],
  ['skipped required live test', (r) => { r.acceptance.results[7].status = 'skipped'; }],
  ['replayed live evidence', (r) => { r.acceptance.environment.workflowRunAttempt = '2'; }],
  ['wrong backup target', (r) => { r.backupReference = 'backups/production/test.sql.enc'; }],
  ['backup traversal', (r) => { r.backupReference = 'backups/staging/../test.sql.enc'; }],
]) test(`deployment gate rejects ${name}`, () => {
  const record = deploymentRecord(version); mutate(record);
  assert.ok(deploymentEvidenceFailures(record).length > 0);
});

test('manual Enterprise contracts retain only the explicit no-subscription plan-preview exception', () => {
  const record = deploymentRecord(version);
  record.acceptance.results[12] = { id: 'DG-LIVE-013', status: 'skipped', required: false, actual: { reason: 'Portal has no Dodo subscription.' } };
  record.acceptance.summary = { passed: 13, failed: 0, skipped: 1, requiredFailed: 0 };
  assert.deepEqual(deploymentEvidenceFailures(record), []);
  record.acceptance.results[12].actual.reason = 'Plan preview disabled.';
  assert.ok(deploymentEvidenceFailures(record).length);
});

test('GitHub workflow provenance validates origin and attempt, not the workflow-ref head SHA', () => {
  const record = deploymentRecord(version); const metadata = workflowMetadata();
  assert.deepEqual(stagingRunFailures(metadata, record, record.repository, record.runId), []);
  for (const override of [{ conclusion: 'failure' }, { event: 'pull_request' }, { path: '.github/workflows/ci.yml' },
    { id: 999 }, { run_attempt: 2 }, { repository: { full_name: 'other/repo' } }]) {
    assert.ok(stagingRunFailures({ ...metadata, ...override }, record, record.repository, record.runId).length);
  }
});

const mockTransport = `
import { appendFileSync } from 'node:fs';
globalThis.fetch = async (input, options = {}) => {
 const url = new URL(input); const path = url.pathname; const mode = process.env.TEST_RESPONSE_MODE;
 appendFileSync(process.env.TEST_REQUEST_LOG, JSON.stringify({path,method:options.method})+'\\n');
 if (options.method !== 'GET' && !(options.method === 'POST' && path === '/api/v1/deals/987/assessment')) throw new Error('Unexpected write');
 if (!options.headers['x-hubspot-signature-v3']) return Response.json({}, {status:401});
 if (path.endsWith('/access')) return Response.json({entitled:mode!=='no-entitlement',tier:'enterprise',permissions:['*'],role:'admin'});
 if (path.endsWith('/assessment')) return Response.json(mode==='no-brief' ? {score:80} : {score:80,intelligence:{dealBrief:{status:'watch'}}});
 if (path.endsWith('/recommendations')) return Response.json(mode==='no-history' ? {} : {recommendations:[]});
 if (mode==='empty-portfolio') return Response.json({});
 if (mode==='failed-endpoint' && path.endsWith('/decision-queue')) return Response.json({}, {status:503});
 return Response.json({items:[],evidenceMode:'insufficient_data'});
};`;

async function cli(t, mode = '', extraEnv = {}) {
  const root = await mkdtemp(join(tmpdir(), 'dg-int-cli-')); t.after(() => rm(root, { recursive: true, force: true }));
  const loader = join(root, 'transport.mjs'); const log = join(root, 'requests.jsonl');
  await writeFile(loader, mockTransport);
  const result = spawnSync(process.execPath, ['--import', loader, resolve('scripts/intelligence-acceptance.mjs')], {
    encoding: 'utf8', timeout: 10_000,
    env: { ...process.env, RELEASE_SHA:'a'.repeat(40), GITHUB_SHA:'c'.repeat(40), RELEASE_TARGET:'staging',
      GITHUB_RUN_ID:'456', GITHUB_RUN_ATTEMPT:'1', ACCEPTANCE_INTELLIGENCE_REQUIRED:'true',
      ACCEPTANCE_INTELLIGENCE_PORTFOLIO:'true', ACCEPTANCE_INTELLIGENCE_REFRESH_DEAL:'true',
      ACCEPTANCE_BASE_URL:'https://dealguard-api-staging.rokad.co', ACCEPTANCE_PORTAL_ID:'123', ACCEPTANCE_TEST_DEAL_ID:'987',
      ACCEPTANCE_USER_ID:'321', ACCEPTANCE_USER_EMAIL:'', HUBSPOT_CLIENT_SECRET:'test-only-secret-DO-NOT-LOG',
      ACCEPTANCE_OUTPUT_DIR:join(root, 'evidence'), TEST_RESPONSE_MODE:mode, TEST_REQUEST_LOG:log, ...extraEnv },
  });
  const files = await readdir(join(root, 'evidence')).catch(() => []);
  const evidence = files.find((name) => name.endsWith('.json'));
  return { result, log: await readFile(log,'utf8').catch(() => ''),
    evidence: evidence ? JSON.parse(await readFile(join(root,'evidence',evidence),'utf8')) : null };
}

test('real intelligence CLI produces 12 required results using isolated test transport', async (t) => {
  const { result, evidence, log } = await cli(t);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(intelligenceEvidenceFailures(evidence, context(version)), []);
  assert.equal(evidence.environment.gitSha, 'a'.repeat(40));
  assert.equal(log.trim().split('\n').map(JSON.parse).filter((r) => r.method === 'POST').length, 1);
  assert.doesNotMatch(JSON.stringify(evidence)+result.stdout+result.stderr, /test-only-secret-DO-NOT-LOG/);
});
for (const mode of ['no-entitlement','no-brief','no-history','empty-portfolio','failed-endpoint']) {
  test(`real intelligence CLI fails for ${mode}`, async (t) => {
    const { result, evidence } = await cli(t, mode);
    assert.notEqual(result.status, 0); assert.ok(evidence);
    assert.ok(intelligenceEvidenceFailures(evidence, context(version)).length > 0);
  });
}
test('incomplete strict configurations fail before sending a request', async (t) => {
  for (const env of [{ACCEPTANCE_TEST_DEAL_ID:''},{ACCEPTANCE_INTELLIGENCE_PORTFOLIO:'false'},
    {ACCEPTANCE_INTELLIGENCE_REFRESH_DEAL:'false'},{GITHUB_RUN_ATTEMPT:''},{ACCEPTANCE_TIMEOUT_MS:'NaN'}]) {
    const { result, log } = await cli(t, '', env); assert.notEqual(result.status,0); assert.equal(log,'');
  }
});
test('diagnostic-only runs cannot certify and explicitly retain all skipped result IDs', async (t) => {
  const { result, evidence } = await cli(t, '', { ACCEPTANCE_INTELLIGENCE_REQUIRED:'false', ACCEPTANCE_INTELLIGENCE_REFRESH_DEAL:'false' });
  assert.equal(result.status,0,result.stderr); assert.equal(evidence.results.length,12);
  assert.equal(evidence.results.find((r)=>r.id==='DG-INT-002').status,'skipped');
  assert.ok(intelligenceEvidenceFailures(evidence,context(version)).length);
});

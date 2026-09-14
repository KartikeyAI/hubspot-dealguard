import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { deploymentRecord as validRecord, workflowMetadata } from './intelligence-evidence-fixtures.mjs';
const { version } = JSON.parse(await readFile('package.json', 'utf8'));

async function fixture(t, target = 'staging') {
  const root = await mkdtemp(join(tmpdir(), 'dg-deploy-')); t.after(() => rm(root, { recursive: true, force: true }));
  const record = validRecord(version, target);
  for (const directory of ['acceptance', 'intelligence', 'download/nested']) await mkdir(join(root, directory), { recursive: true });
  async function put(name, data) { await writeFile(join(root,name),JSON.stringify(data)); }
  await put('preflight.json',{summary:record.preflight}); await put('health.json',record.health);
  await put('smoke.json',record.smoke); await put('baseline.json',record.baseline);
  await put('acceptance/result.json',record.acceptance); await put('intelligence/result.json',record.intelligence);
  await put('staging-run.json',workflowMetadata());
  const env = { ...process.env, RELEASE_TARGET:target, RELEASE_SHA:record.commit, BACKUP_REFERENCE:record.backupReference,
    BACKUP_SHA256:record.backupSha256, GITHUB_REPOSITORY:record.repository, GITHUB_WORKFLOW:record.workflow,
    GITHUB_RUN_ID:record.runId, GITHUB_RUN_ATTEMPT:record.runAttempt, STAGING_RUN_ID:record.runId,
    ACCEPTANCE_BASE_URL:record.acceptanceContext.baseUrl, ACCEPTANCE_PORTAL_ID:'123', ACCEPTANCE_TEST_DEAL_ID:'987' };
  const run = (overrides = {}) => spawnSync(process.execPath, [resolve('scripts/deployment-record.mjs'),
    '--output',join(root,'deployment-record.json'),'--preflight',join(root,'preflight.json'),
    '--health',join(root,'health.json'),'--smoke',join(root,'smoke.json'),'--baseline',join(root,'baseline.json'),
    '--acceptance-dir',join(root,'acceptance'),'--intelligence-dir',join(root,'intelligence')],
  { encoding:'utf8',env:{...env,...overrides},timeout:10_000 });
  const promote = (overrides = {}) => spawnSync(process.execPath, [resolve('scripts/verify-staging-promotion.mjs'),
    '--input',join(root,'download'),'--run-metadata',join(root,'staging-run.json')],
  { encoding:'utf8',env:{...env,...overrides},timeout:10_000 });
  return { root,record,put,run,promote };
}

test('deployment record binds baseline, smoke, live and intelligence evidence to one release and run', async (t) => {
  const f=await fixture(t); const result=f.run(); assert.equal(result.status,0,result.stderr);
  const record=JSON.parse(await readFile(join(f.root,'deployment-record.json'),'utf8'));
  assert.equal(record.schemaVersion,4); assert.equal(record.result,'passed'); assert.equal(record.promotable,true);
  assert.equal(record.commit,f.record.commit); assert.equal(record.intelligence.results.length,12);
  assert.match(record.intelligenceSha256,/^[0-9a-f]{64}$/);
});

test('deployment evidence fails closed without complete encrypted backup evidence', async (t) => {
  const f=await fixture(t);
  for (const overrides of [{BACKUP_REFERENCE:''},{BACKUP_SHA256:''},
    {BACKUP_REFERENCE:'backups/production/test.sql.enc'},{BACKUP_REFERENCE:'backups/staging/test.sql'}]) {
    const result=f.run(overrides); assert.notEqual(result.status,0);
    assert.equal(JSON.parse(await readFile(join(f.root,'deployment-record.json'),'utf8')).result,'failed');
  }
});

test('deployment evidence fails closed when public smoke is missing, failed or from another target', async (t) => {
  const f=await fixture(t);
  for (const data of [null,{...f.record.smoke,summary:{total:7,passed:6,failed:1}}, {...f.record.smoke,target:'production'}]) {
    await f.put('smoke.json',data); assert.notEqual(f.run().status,0);
  }
});

test('production deployment requires full standard and intelligence acceptance', async (t) => {
  const f=await fixture(t,'production'); assert.equal(f.run().status,0);
  await f.put('acceptance/result.json',{...f.record.acceptance,profile:'read-only'});
  const result=f.run(); assert.notEqual(result.status,0); assert.match(result.stderr,/production requires stable version and full acceptance/);
});

test('production promotion requires exact release, fresh intelligence and trusted run metadata', async (t) => {
  const f=await fixture(t); assert.equal(f.run().status,0);
  const record=JSON.parse(await readFile(join(f.root,'deployment-record.json'),'utf8'));
  await f.put('download/nested/deployment-record.json',record);
  assert.equal(f.promote().status,0);
  const mismatch=f.promote({RELEASE_SHA:'c'.repeat(40)});
  assert.notEqual(mismatch.status,0); assert.match(mismatch.stderr,/staging commit does not match requested production commit/);
  for (const invalid of [{...record,backupSha256:''},{...record,schemaVersion:3},{...record,intelligence:null},
    {...record,runAttempt:'2'},{...record,promotable:false}]) {
    await f.put('download/nested/deployment-record.json',invalid); assert.notEqual(f.promote().status,0);
  }
  await f.put('download/nested/deployment-record.json',record);
  await f.put('staging-run.json',{...workflowMetadata(),conclusion:'failure'});
  assert.notEqual(f.promote().status,0);
});

test('ambiguous or stale result directories cannot select a convenient passing result', async (t) => {
  const f=await fixture(t);
  await f.put('intelligence/older.json',f.record.intelligence); assert.notEqual(f.run().status,0);
  await rm(join(f.root,'intelligence/older.json'));
  await f.put('acceptance/older.json',f.record.acceptance); assert.notEqual(f.run().status,0);
  await f.put('download/nested/deployment-record.json',f.record);
  await f.put('download/deployment-record.json',f.record); assert.notEqual(f.promote().status,0);
});

test('read-only staging evidence remains usable for diagnostics but is not promotable', async (t) => {
  const f=await fixture(t); const acceptance=structuredClone(f.record.acceptance);
  acceptance.profile='read-only';
  for (let i=7;i<14;i++) { acceptance.results[i].status='skipped'; acceptance.results[i].required=false; }
  acceptance.summary={passed:7,failed:0,skipped:7,requiredFailed:0};
  await f.put('acceptance/result.json',acceptance); await rm(join(f.root,'intelligence/result.json'));
  const result=f.run(); assert.equal(result.status,0,result.stderr);
  const record=JSON.parse(await readFile(join(f.root,'deployment-record.json'),'utf8'));
  assert.equal(record.promotable,false); await f.put('download/nested/deployment-record.json',record);
  assert.notEqual(f.promote().status,0);
});

test('controlled deployment retains existing invariants and requires intelligence before recording release', async () => {
  const workflow=await readFile('.github/workflows/controlled-deploy.yml','utf8');
  for (const marker of ['ref: ${{ inputs.release_sha }}','persist-credentials: false','backup_reference is required',
    'backup_sha256:','BACKUP_SHA256: ${{ inputs.backup_sha256 }}','expected_backup_prefix="backups/${RELEASE_TARGET}/"',
    'backup_reference must identify an encrypted .enc object','backup_sha256 must be a 64-character SHA-256 digest',
    'DEPLOY DEALGUARD TO PRODUCTION','production requires the full acceptance profile',
    'test_deal_id is required for production certification','release:verify-staging',
    'storage:backup:head -- "$BACKUP_REFERENCE" "$BACKUP_SHA256"','npm run db:migrate','npm run db:migrate:check',
    'npm run db:validate','wrangler deploy --config .release/wrangler.toml','production:smoke','acceptance:live',
    'acceptance:intelligence','release:record','worker/src/version.ts','database/migrations','retention-days: 90',
    'artifacts/intelligence-acceptance/','include-hidden-files: true','github.run_attempt','actions/runs/$STAGING_RUN_ID',
    'ACCEPTANCE_INTELLIGENCE_REQUIRED:', 'Full acceptance requires a dedicated test deal']) assert.ok(workflow.includes(marker),marker);
  assert.ok(workflow.indexOf('run: touch .env')<workflow.indexOf('run: npm run check'));
  assert.ok(workflow.indexOf('run: touch .env')<workflow.indexOf('run: npm run db:migrate'));
  assert.ok(workflow.indexOf('run: npm run acceptance:intelligence')<workflow.indexOf('run: npm run release:record'));
  assert.doesNotMatch(workflow,/wrangler d1|D1_DATABASE_ID|wrangler secret (put|bulk)/i);
  assert.match(workflow,/name: dealguard-deployment-\$\{\{ inputs.target \}\}-\$\{\{ github.run_id \}\}-\$\{\{ github.run_attempt \}\}/);
});

test('deployment input shell rejects full runs without a test deal and does not execute injected values', async (t) => {
  const f=await fixture(t); const workflow=await readFile('.github/workflows/controlled-deploy.yml','utf8');
  const shell=workflow.split('      - name: Validate immutable deployment inputs')[1].split('        run: |\n')[1].split('\n      - uses:')[0]
    .split('\n').map((line)=>line.slice(10)).join('\n');
  assert.doesNotMatch(shell,/\$\{\{/);
  const marker=join(f.root,'injected');
  for (const testDealId of ['',`$(touch ${marker})`]) {
    const result=spawnSync('bash',['-c',shell],{encoding:'utf8',env:{...process.env, RELEASE_SHA:'a'.repeat(40),
      RELEASE_TARGET:'staging',BACKUP_REFERENCE:'backups/staging/test.enc',BACKUP_SHA256:'b'.repeat(64),
      ACCEPTANCE_PROFILE:'full',ACCEPTANCE_PORTAL_ID:'123',ACCEPTANCE_TEST_DEAL_ID:testDealId}});
    assert.notEqual(result.status,0); await assert.rejects(readFile(marker),{code:'ENOENT'});
  }
});

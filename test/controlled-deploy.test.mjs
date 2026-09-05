import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';

const commit = 'a'.repeat(40);
const backupSha256 = 'b'.repeat(64);
const { version } = JSON.parse(await readFile('package.json', 'utf8'));
const root = '.release/controlled-deploy-test';

async function fixture() {
  await rm(root, { recursive: true, force: true });
  await mkdir(`${root}/acceptance`, { recursive: true });
  await mkdir(`${root}/production-smoke`, { recursive: true });
  await writeFile(`${root}/preflight.json`, JSON.stringify({ summary: { total: 48, passed: 48, failed: 0 } }));
  await writeFile(`${root}/health.json`, JSON.stringify({ status: 'ok', service: 'dealguard-api', version }));
  await writeFile(`${root}/production-smoke/evidence.json`, JSON.stringify({
    target: 'production',
    baseUrl: 'https://dealguard-api.rokad.co/',
    expectedVersion: version,
    summary: { total: 7, passed: 7, failed: 0 },
  }));
  await writeFile(`${root}/acceptance/result.json`, JSON.stringify({ profile: 'full', summary: { total: 14, passed: 14, failed: 0, skipped: 0 } }));
}

function deploymentRecord(extraEnvironment = {}) {
  return spawnSync(process.execPath, [
    'scripts/deployment-record.mjs',
    '--output', `${root}/deployment-record.json`,
    '--preflight', `${root}/preflight.json`,
    '--health', `${root}/health.json`,
    '--smoke', `${root}/production-smoke/evidence.json`,
    '--acceptance-dir', `${root}/acceptance`,
  ], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env: {
      ...process.env,
      RELEASE_TARGET: 'staging',
      RELEASE_SHA: commit,
      BACKUP_REFERENCE: `backups/staging/dealguard-${version}.sql.enc`,
      BACKUP_SHA256: backupSha256,
      GITHUB_REPOSITORY: 'KartikeyAI/hubspot-dealguard',
      GITHUB_WORKFLOW: 'Controlled deploy',
      GITHUB_RUN_ID: '123',
      ...extraEnvironment,
    },
  });
}

test('deployment evidence requires preflight, health, smoke, acceptance, immutable SHA and encrypted backup evidence', async () => {
  await fixture();
  const result = deploymentRecord();
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  const record = JSON.parse(await readFile(`${root}/deployment-record.json`, 'utf8'));
  assert.equal(record.schemaVersion, 3);
  assert.equal(record.result, 'passed');
  assert.equal(record.target, 'staging');
  assert.equal(record.commit, commit);
  assert.equal(record.version, version);
  assert.equal(record.backupReference, `backups/staging/dealguard-${version}.sql.enc`);
  assert.equal(record.backupSha256, backupSha256);
  assert.equal(record.health.service, 'dealguard-api');
  assert.equal(record.smoke.summary.failed, 0);
  assert.equal(record.acceptance.summary.failed, 0);
});

test('deployment evidence fails closed without complete backup evidence', async () => {
  await fixture();
  const missingReference = deploymentRecord({ BACKUP_REFERENCE: '' });
  assert.notEqual(missingReference.status, 0);
  let record = JSON.parse(await readFile(`${root}/deployment-record.json`, 'utf8'));
  assert.equal(record.result, 'failed');
  assert.ok(record.failures.includes('backup reference is missing'));

  const missingDigest = deploymentRecord({ BACKUP_SHA256: '' });
  assert.notEqual(missingDigest.status, 0);
  record = JSON.parse(await readFile(`${root}/deployment-record.json`, 'utf8'));
  assert.ok(record.failures.includes('backup SHA-256 is missing or invalid'));

  const wrongTarget = deploymentRecord({ BACKUP_REFERENCE: `backups/production/dealguard-${version}.sql.enc` });
  assert.notEqual(wrongTarget.status, 0);
  record = JSON.parse(await readFile(`${root}/deployment-record.json`, 'utf8'));
  assert.ok(record.failures.includes('backup reference does not match deployment target'));

  const unencryptedName = deploymentRecord({ BACKUP_REFERENCE: `backups/staging/dealguard-${version}.sql` });
  assert.notEqual(unencryptedName.status, 0);
  record = JSON.parse(await readFile(`${root}/deployment-record.json`, 'utf8'));
  assert.ok(record.failures.includes('backup reference is not an encrypted Tigris object key'));
});

test('deployment evidence fails closed when public smoke is missing or failed', async () => {
  await fixture();
  await writeFile(`${root}/production-smoke/evidence.json`, JSON.stringify({ expectedVersion: version, summary: { total: 7, passed: 6, failed: 1 } }));
  const result = deploymentRecord();
  assert.notEqual(result.status, 0);
  const record = JSON.parse(await readFile(`${root}/deployment-record.json`, 'utf8'));
  assert.ok(record.failures.includes('public deployment smoke did not pass'));
});

test('production deployment evidence requires full signed acceptance', async () => {
  await fixture();
  await writeFile(`${root}/acceptance/result.json`, JSON.stringify({ profile: 'read-only', summary: { total: 7, passed: 7, failed: 0, skipped: 0 } }));
  const result = deploymentRecord({
    RELEASE_TARGET: 'production',
    BACKUP_REFERENCE: `backups/production/dealguard-${version}.sql.enc`,
  });
  assert.notEqual(result.status, 0);
  const record = JSON.parse(await readFile(`${root}/deployment-record.json`, 'utf8'));
  assert.ok(record.failures.includes('production acceptance profile is not full'));
});

test('production promotion accepts only passing staging evidence for the exact release and backup digest', async () => {
  await fixture();
  assert.equal(deploymentRecord().status, 0);
  await mkdir(`${root}/download/nested`, { recursive: true });
  await writeFile(`${root}/download/nested/deployment-record.json`, await readFile(`${root}/deployment-record.json`));

  const pass = spawnSync(process.execPath, [
    'scripts/verify-staging-promotion.mjs', '--input', `${root}/download`,
  ], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env: { ...process.env, RELEASE_SHA: commit },
  });
  assert.equal(pass.status, 0, `${pass.stdout}\n${pass.stderr}`);

  const record = JSON.parse(await readFile(`${root}/download/nested/deployment-record.json`, 'utf8'));
  record.commit = 'c'.repeat(40);
  await writeFile(`${root}/download/nested/deployment-record.json`, JSON.stringify(record));
  let reject = spawnSync(process.execPath, [
    'scripts/verify-staging-promotion.mjs', '--input', `${root}/download`,
  ], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env: { ...process.env, RELEASE_SHA: commit },
  });
  assert.notEqual(reject.status, 0);
  assert.match(reject.stderr, /staging commit does not match requested production commit/);

  record.commit = commit;
  record.backupSha256 = '';
  await writeFile(`${root}/download/nested/deployment-record.json`, JSON.stringify(record));
  reject = spawnSync(process.execPath, [
    'scripts/verify-staging-promotion.mjs', '--input', `${root}/download`,
  ], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env: { ...process.env, RELEASE_SHA: commit },
  });
  assert.notEqual(reject.status, 0);
  assert.match(reject.stderr, /lacks valid backup SHA-256 evidence/);
});

test('controlled deployment workflow retains production release invariants', async () => {
  const workflow = await readFile('.github/workflows/controlled-deploy.yml', 'utf8');
  assert.match(workflow, /ref: \$\{\{ inputs\.release_sha \}\}/);
  assert.match(workflow, /persist-credentials: false/);
  assert.match(workflow, /backup_reference is required/);
  assert.match(workflow, /backup_sha256:/);
  assert.match(workflow, /BACKUP_SHA256: \$\{\{ inputs\.backup_sha256 \}\}/);
  assert.match(workflow, /expected_backup_prefix="backups\/\$\{RELEASE_TARGET\}\/"/);
  assert.match(workflow, /backup_reference must identify an encrypted \.enc object/);
  assert.match(workflow, /backup_sha256 must be a 64-character SHA-256 digest/);
  assert.match(workflow, /DEPLOY DEALGUARD TO PRODUCTION/);
  assert.match(workflow, /production requires the full acceptance profile/);
  assert.match(workflow, /test_deal_id is required for production certification/);
  assert.match(workflow, /inputs\.target == 'production'/);
  assert.match(workflow, /gh run download/);
  assert.match(workflow, /release:verify-staging/);
  assert.match(workflow, /storage:backup:head -- "\$BACKUP_REFERENCE" "\$BACKUP_SHA256"/);
  assert.match(workflow, /- name: Create non-secret CI environment file\s+run: touch \.env/);
  assert.ok(workflow.indexOf('run: touch .env') < workflow.indexOf('run: npm run check'));
  assert.ok(workflow.indexOf('run: touch .env') < workflow.indexOf('run: npm run db:migrate'));
  assert.match(workflow, /npm run db:migrate/);
  assert.match(workflow, /npm run db:migrate:check/);
  assert.match(workflow, /npm run db:validate/);
  assert.doesNotMatch(workflow, /wrangler d1|D1_DATABASE_ID/i);
  assert.match(workflow, /wrangler deploy --config \.release\/wrangler\.toml/);
  assert.match(workflow, /production:smoke/);
  assert.match(workflow, /acceptance:live/);
  assert.match(workflow, /release:record/);
  assert.match(workflow, /worker\/src\/version\.ts/);
  assert.match(workflow, /database\/migrations/);
  assert.match(workflow, /retention-days: 90/);
  assert.doesNotMatch(workflow, /wrangler secret (put|bulk)/);
});

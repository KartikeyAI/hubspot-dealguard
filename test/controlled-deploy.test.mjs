import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';

const commit = 'a'.repeat(40);
const { version } = JSON.parse(await readFile('package.json', 'utf8'));
const root = '.release/controlled-deploy-test';

async function fixture() {
  await rm(root, { recursive: true, force: true });
  await mkdir(`${root}/acceptance`, { recursive: true });
  await writeFile(`${root}/preflight.json`, JSON.stringify({ summary: { total: 40, passed: 40, failed: 0 } }));
  await writeFile(`${root}/health.json`, JSON.stringify({ status: 'ok', version }));
  await writeFile(`${root}/acceptance/result.json`, JSON.stringify({ profile: 'full', summary: { total: 20, passed: 20, failed: 0, skipped: 0 } }));
}

function deploymentRecord(extraEnvironment = {}) {
  return spawnSync(process.execPath, [
    'scripts/deployment-record.mjs',
    '--output', `${root}/deployment-record.json`,
    '--preflight', `${root}/preflight.json`,
    '--health', `${root}/health.json`,
    '--acceptance-dir', `${root}/acceptance`,
  ], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env: {
      ...process.env,
      RELEASE_TARGET: 'staging',
      RELEASE_SHA: commit,
      BACKUP_REFERENCE: 'backups/staging/dealguard-2.1.0-rc.1.sql.enc',
      GITHUB_REPOSITORY: 'rokadhq/hubspot-dealguard',
      GITHUB_WORKFLOW: 'Controlled deploy',
      GITHUB_RUN_ID: '123',
      ...extraEnvironment,
    },
  });
}

test('deployment evidence requires preflight, health, acceptance, immutable SHA and backup reference', async () => {
  await fixture();
  const result = deploymentRecord();
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  const record = JSON.parse(await readFile(`${root}/deployment-record.json`, 'utf8'));
  assert.equal(record.result, 'passed');
  assert.equal(record.target, 'staging');
  assert.equal(record.commit, commit);
  assert.equal(record.version, version);
  assert.equal(record.acceptance.summary.failed, 0);
});

test('deployment evidence fails closed without a backup reference', async () => {
  await fixture();
  const result = deploymentRecord({ BACKUP_REFERENCE: '' });
  assert.notEqual(result.status, 0);
  const record = JSON.parse(await readFile(`${root}/deployment-record.json`, 'utf8'));
  assert.equal(record.result, 'failed');
  assert.ok(record.failures.includes('backup reference is missing'));
});

test('production promotion accepts only passing staging evidence for the exact release', async () => {
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
  record.commit = 'b'.repeat(40);
  await writeFile(`${root}/download/nested/deployment-record.json`, JSON.stringify(record));
  const reject = spawnSync(process.execPath, [
    'scripts/verify-staging-promotion.mjs', '--input', `${root}/download`,
  ], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env: { ...process.env, RELEASE_SHA: commit },
  });
  assert.notEqual(reject.status, 0);
  assert.match(reject.stderr, /staging commit does not match requested production commit/);
});

test('controlled deployment workflow retains enterprise release invariants', async () => {
  const workflow = await readFile('.github/workflows/controlled-deploy.yml', 'utf8');
  assert.match(workflow, /ref: \$\{\{ inputs\.release_sha \}\}/);
  assert.match(workflow, /persist-credentials: false/);
  assert.match(workflow, /backup_reference is required/);
  assert.match(workflow, /inputs\.target == 'production'/);
  assert.match(workflow, /gh run download/);
  assert.match(workflow, /release:verify-staging/);
  assert.match(workflow, /storage:backup:head/);
  assert.match(workflow, /npm run db:migrate/);
  assert.match(workflow, /npm run db:migrate:check/);
  assert.match(workflow, /npm run db:validate/);
  assert.doesNotMatch(workflow, /wrangler d1|D1_DATABASE_ID/i);
  assert.match(workflow, /wrangler deploy --config \.release\/wrangler\.toml/);
  assert.match(workflow, /acceptance:live/);
  assert.match(workflow, /release:record/);
  assert.match(workflow, /database\/migrations/);
  assert.match(workflow, /retention-days: 90/);
  assert.doesNotMatch(workflow, /wrangler secret (put|bulk)/);
});

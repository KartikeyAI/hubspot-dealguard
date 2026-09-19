import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { collectReleaseBaseline, releaseTarget, releaseVersionPolicy } from '../scripts/release-baseline.mjs';

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const cli = join(repository, 'scripts/release-baseline.mjs');
async function fixture(t, version = '3.0.0-alpha.1') {
  const root = await mkdtemp(join(tmpdir(), 'dealguard-baseline-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const put = async (path, value) => {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), typeof value === 'string' ? value : JSON.stringify(value));
  };
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git('init');
  git('config', 'user.name', 'DealGuard test');
  git('config', 'user.email', 'test@example.invalid');
  git('config', 'commit.gpgsign', 'false');
  await put('package.json', { name: 'dealguard-test', version });
  await put('worker/src/version.ts', `export const DEALGUARD_VERSION = '${version}';\n`);
  await put('wrangler.toml', 'name = "dealguard-test"\n');
  await put('hsproject.json', { name: 'DealGuard', platformVersion: '2026.03' });
  await put('src/app/app-hsmeta.json', { uid: 'app', type: 'app', config: { auth: {
    requiredScopes: ['crm.objects.deals.read'], optionalScopes: ['crm.objects.quotes.read'],
  }, unusedSecretFixture: 'secret-not-for-baseline' } });
  await put('src/app/cards/card-hsmeta.json', { uid: 'card', type: 'card', config: {} });
  await put('src/app/cards/package.json', { name: 'cards', version: '2.1.0' });
  await put('database/migrations/0001_initial.sql', 'CREATE SCHEMA dealguard;\n');
  await put('database/migrations/0002_next.sql', 'SELECT 1;\n');
  const commit = () => { git('add', '.'); git('commit', '-qm', 'fixture'); return git('rev-parse', 'HEAD'); };
  const sha = commit();
  return { root, put, git, commit, sha };
}

test('stable releases work for both targets; only approved prerelease channels work in staging', () => {
  for (const version of ['2.1.0', '3.0.0', '3.2.10']) {
    assert.equal(releaseVersionPolicy(version, 'production').ok, true);
    assert.equal(releaseVersionPolicy(version, 'staging').channel, 'stable');
  }
  for (const version of ['3.0.0-alpha.1', '3.0.0-beta.0', '3.0.0-rc.12']) {
    assert.equal(releaseVersionPolicy(version, 'staging').ok, true);
    assert.equal(releaseVersionPolicy(version, 'production').ok, false);
  }
});

test('malformed versions, metadata, unsupported channels, and unknown targets fail closed', () => {
  for (const version of [null, {}, '', 'v3.0.0', '03.0.0', '3.00.0', '3.0.01', '3.0',
    '3.0.0-dev.1', '3.0.0-beta', '3.0.0-rc.01', '3.0.0-rc.-1', '3.0.0+build', '3.0.0\n', ' 3.0.0']) {
    assert.equal(releaseVersionPolicy(version, 'staging').ok, false, String(version));
  }
  assert.equal(releaseVersionPolicy('3.0.0', 'prod').ok, false);
  for (const target of ['', 'prod', 'STAGING', null]) assert.throws(() => releaseTarget(target));
  assert.equal(releaseTarget(), 'staging');
});

test('baseline binds exact committed source and inventories hashes without asserting live readiness', async (t) => {
  const f = await fixture(t);
  const result = await collectReleaseBaseline({ root: f.root, expectedCommit: f.sha, target: 'staging' });
  assert.equal(result.source.commit, f.sha);
  assert.equal(result.source.tree, f.git('rev-parse', 'HEAD^{tree}'));
  assert.equal(result.release.version, '3.0.0-alpha.1');
  assert.equal(result.release.packages.length, 2);
  assert.equal(result.database.requiredMigrationVersion, 2);
  assert.equal(result.database.appliedVersion, null);
  assert.match(result.database.manifestSha256, /^[a-f0-9]{64}$/);
  assert.equal(result.hubspot.components.length, 2);
  assert.deepEqual(result.hubspot.optionalScopes, ['crm.objects.quotes.read']);
  assert.equal(result.hubspot.projectBuildId, null);
  assert.equal(result.verification.productionDeployment, 'not_verified');
  assert.doesNotMatch(JSON.stringify(result), /secret-not-for-baseline/);
  const again = await collectReleaseBaseline({ root: f.root });
  assert.equal(again.database.manifestSha256, result.database.manifestSha256);
  assert.equal(again.hubspot.manifestSha256, result.hubspot.manifestSha256);
});

test('production rejects a committed prerelease; stable 3.0 is accepted', async (t) => {
  const alpha = await fixture(t);
  await assert.rejects(collectReleaseBaseline({ root: alpha.root, target: 'production' }), /stable semver/);
  const stable = await fixture(t, '3.0.0');
  assert.equal((await collectReleaseBaseline({ root: stable.root, target: 'production' })).release.channel, 'stable');
});

test('wrong SHA, changed tracked source, and staged changes fail closed', async (t) => {
  const f = await fixture(t);
  await assert.rejects(collectReleaseBaseline({ root: f.root, expectedCommit: 'a'.repeat(40) }), /release SHA/);
  await assert.rejects(collectReleaseBaseline({ root: f.root, expectedCommit: 'main' }), /release SHA/);
  await f.put('worker/src/version.ts', "export const DEALGUARD_VERSION = '3.0.0';\n");
  await assert.rejects(collectReleaseBaseline({ root: f.root }), /Tracked worktree/);
  f.git('add', '.');
  await assert.rejects(collectReleaseBaseline({ root: f.root }), /Tracked worktree/);
});

test('untracked executable source is rejected but generated evidence does not dirty the baseline', async (t) => {
  const f = await fixture(t);
  await f.put('.release/release-baseline.json', '{}');
  await f.put('.env', 'TEST_SECRET=not-recorded\n');
  assert.equal((await collectReleaseBaseline({ root: f.root })).source.clean, true);
  await f.put('worker/src/untracked.ts', 'export {};');
  await assert.rejects(collectReleaseBaseline({ root: f.root }), /Untracked release source/);
});

test('mismatched Worker identity cannot pass', async (t) => {
  const f = await fixture(t);
  await f.put('worker/src/version.ts', "export const DEALGUARD_VERSION = '2.1.0';\n");
  f.commit();
  await assert.rejects(collectReleaseBaseline({ root: f.root }), /Worker release version/);
});

test('migration gaps and duplicate numbers cannot pass', async (t) => {
  const f = await fixture(t);
  await f.put('database/migrations/0004_gap.sql', 'SELECT 4;');
  f.commit();
  await assert.rejects(collectReleaseBaseline({ root: f.root }), /contiguous/);
  await rm(join(f.root, 'database/migrations/0004_gap.sql'));
  await f.put('database/migrations/0002_duplicate.sql', 'SELECT 2;');
  f.commit();
  await assert.rejects(collectReleaseBaseline({ root: f.root }), /contiguous/);
});

test('duplicate component UIDs and malformed JSON cannot pass', async (t) => {
  const f = await fixture(t);
  await f.put('src/app/cards/duplicate-hsmeta.json', { uid: 'card', type: 'card' });
  f.commit();
  await assert.rejects(collectReleaseBaseline({ root: f.root }), /Duplicate HubSpot/);
  await f.put('src/app/cards/duplicate-hsmeta.json', '{');
  f.commit();
  await assert.rejects(collectReleaseBaseline({ root: f.root }), /Invalid release JSON/);
});

test('overlapping required and optional scopes cannot pass', async (t) => {
  const f = await fixture(t);
  await f.put('src/app/app-hsmeta.json', { uid: 'app', type: 'app', config: { auth: {
    requiredScopes: ['crm.objects.deals.read'], optionalScopes: ['crm.objects.deals.read'],
  } } });
  f.commit();
  await assert.rejects(collectReleaseBaseline({ root: f.root }), /scopes overlap/);
});

test('symlinked release files cannot be used as evidence', async (t) => {
  const f = await fixture(t);
  await rm(join(f.root, 'wrangler.toml'));
  await symlink('package.json', join(f.root, 'wrangler.toml'));
  f.commit();
  await assert.rejects(collectReleaseBaseline({ root: f.root }), /non-regular/);
});

test('running from a nested working directory is rejected', async (t) => {
  const f = await fixture(t);
  await assert.rejects(collectReleaseBaseline({ root: join(f.root, 'worker') }), /repository root/);
});

test('CLI records actual checkout, not the workflow trigger SHA, and excludes environment secrets', async (t) => {
  const f = await fixture(t);
  const env = { ...process.env, RELEASE_TARGET: 'staging', RELEASE_SHA: f.sha,
    GITHUB_SHA: 'b'.repeat(40), HUBSPOT_CLIENT_SECRET: 'never-in-evidence' };
  const result = spawnSync(process.execPath, [cli], { cwd: f.root, encoding: 'utf8', env });
  assert.equal(result.status, 0, result.stderr);
  const evidence = await readFile(join(f.root, '.release/release-baseline.json'), 'utf8');
  assert.equal(JSON.parse(evidence).source.commit, f.sha);
  assert.doesNotMatch(evidence + result.stdout + result.stderr, /never-in-evidence/);
  for (const args of [['--target', 'production'], ['--target'], ['--unknown', 'value']]) {
    const rejected = spawnSync(process.execPath, [cli, ...args], { cwd: f.root, encoding: 'utf8', env });
    assert.notEqual(rejected.status, 0);
  }
});

test('canonical CI and deployment capture baselines before dependencies, migrations, and deployment', async () => {
  const ci = await readFile(join(repository, '.github/workflows/ci.yml'), 'utf8');
  const workflow = await readFile(join(repository, '.github/workflows/controlled-deploy.yml'), 'utf8');
  const preflight = await readFile(join(repository, 'scripts/release-preflight.mjs'), 'utf8');
  for (const source of [ci, workflow]) {
    assert.ok(source.includes('node scripts/release-baseline.mjs'));
    assert.ok(source.indexOf('actions/setup-node@') < source.indexOf('node scripts/release-baseline.mjs'));
    assert.ok(source.indexOf('node scripts/release-baseline.mjs') < source.indexOf('npm install'));
    assert.ok(source.includes('.release/release-baseline.json'));
  }
  assert.ok(workflow.indexOf('node scripts/release-baseline.mjs') < workflow.indexOf('run: npm run db:migrate'));
  assert.match(preflight, /releaseVersionPolicy\(packageJson\.version, target\)/);
  assert.match(preflight, /releaseTarget\(process\.env\.RELEASE_TARGET\)/);
  // Workflow inputs must enter shell through quoted environment variables, not script interpolation.
  const runBlocks = workflow.split(/\n\s+run: /).slice(1).map((block) => block.split(/\n      - /)[0]);
  for (const block of runBlocks) assert.doesNotMatch(block, /\$\{\{\s*inputs\./);
});

test('protected preflight uses the same staging and production version policy', async (t) => {
  const f = await fixture(t);
  for (const path of ['docs/DEPLOYMENT.md', 'docs/MIGRATION_D1_TO_NEON.md',
    'docs/PRODUCTION_DEPLOYMENT_RUNBOOK.md', 'docs/PRODUCTION_ACCEPTANCE_RUNBOOK.md',
    '.env.example', 'worker/src/index.ts', 'worker/src/postgres.ts', 'worker/src/runtime.ts',
    'worker/src/object-storage.ts', 'worker/src/queueing.ts', 'scripts/render-hubspot-target.mjs',
    'scripts/production-smoke.mjs']) await f.put(path, '// isolated preflight test fixture\n');
  const preflight = join(repository, 'scripts/release-preflight.mjs');
  for (const target of ['staging', 'production']) {
    const result = spawnSync(process.execPath, [preflight, '--no-render'], {
      cwd: f.root, encoding: 'utf8', env: { ...process.env, RELEASE_TARGET: target },
    });
    // Missing integration configuration intentionally keeps overall preflight blocked.
    assert.notEqual(result.status, 0);
    const report = JSON.parse(await readFile(join(f.root, '.release/preflight.json'), 'utf8'));
    assert.equal(report.checks.find((check) => check.id === 'package.version.production').ok, target === 'staging');
    assert.equal(report.checks.find((check) => check.id === 'runtime.version.matches').ok, false);
  }
});

test('deployment input validation does not execute shell syntax inside dispatch values', async (t) => {
  const f = await fixture(t);
  const workflow = await readFile(join(repository, '.github/workflows/controlled-deploy.yml'), 'utf8');
  const script = workflow.split('      - name: Validate immutable deployment inputs')[1]
    .split('        run: |\n')[1].split('\n      - uses:')[0].split('\n')
    .map((line) => line.replace(/^          /, '')).join('\n');
  const marker = join(f.root, 'must-not-exist');
  const env = { ...process.env, RELEASE_SHA: 'a'.repeat(40), RELEASE_TARGET: 'production',
    BACKUP_REFERENCE: 'backups/production/test.enc', BACKUP_SHA256: 'b'.repeat(64),
    ACCEPTANCE_PORTAL_ID: '123', ACCEPTANCE_PROFILE: 'full', STAGING_RUN_ID: '123',
    ACCEPTANCE_TEST_DEAL_ID: '456', PRODUCTION_CONFIRMATION: 'DEPLOY DEALGUARD TO PRODUCTION' };
  assert.equal(spawnSync('bash', ['-c', script], { env }).status, 0);
  for (const name of ['ACCEPTANCE_PORTAL_ID', 'PRODUCTION_CONFIRMATION']) {
    const result = spawnSync('bash', ['-c', script], {
      env: { ...env, [name]: `$(touch '${marker}')` }, encoding: 'utf8',
    });
    assert.notEqual(result.status, 0);
    await assert.rejects(readFile(marker), { code: 'ENOENT' });
  }
  for (const source of [workflow, await readFile(join(repository, '.github/workflows/ci.yml'), 'utf8')]) {
    assert.match(source, /include-hidden-files: true/);
    assert.doesNotMatch(source, /path:\s*\.release\/\*\*/);
  }
});

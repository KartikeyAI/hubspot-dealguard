import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';

const { version } = JSON.parse(await readFile('package.json', 'utf8'));
const completeEnvironment = {
  APP_BASE_URL: 'https://dealguard-api-staging.rokad.co',
  HUBSPOT_APP_ID: '123456',
  HUBSPOT_CLIENT_ID: 'hubspot-client-id',
  HUBSPOT_CLIENT_SECRET: 'hubspot-client-secret',
  TOKEN_ENCRYPTION_KEY: 'x'.repeat(32),
  ADMIN_API_KEY: 'admin-api-key',
  NEON_DATABASE_URL: 'postgresql://dealguard:secret@ep-example.us-east-2.aws.neon.tech/dealguard?sslmode=require',
  HYPERDRIVE_CONFIG_ID: '0123456789abcdef0123456789abcdef',
  CLOUDFLARE_ACCOUNT_ID: 'cloudflare-account-id',
  CLOUDFLARE_API_TOKEN: 'cloudflare-api-token',
  RESEND_API_KEY: 'resend-api-key',
  SLACK_CLIENT_ID: 'slack-client-id',
  SLACK_CLIENT_SECRET: 'slack-client-secret',
  TIGRIS_BUCKET: 'dealguard-staging',
  TIGRIS_ACCESS_KEY_ID: 'tid_test_access_key',
  TIGRIS_SECRET_ACCESS_KEY: 'tsec_test_secret_key',
  DODO_API_KEY: 'dodo-api-key',
  DODO_WEBHOOK_SECRET: 'whsec_ZG9kby10ZXN0LXNlY3JldA',
  DODO_ENVIRONMENT: 'test',
  DODO_GROWTH_MONTHLY_PRODUCT_ID: 'prod_growth_month',
  DODO_GROWTH_YEARLY_PRODUCT_ID: 'prod_growth_year',
  DODO_ENTERPRISE_MONTHLY_PRODUCT_ID: 'prod_enterprise_month',
  DODO_ENTERPRISE_YEARLY_PRODUCT_ID: 'prod_enterprise_year',
  DODO_AI_CREDIT_EVENT_NAME: 'dealguard_ai_credit',
  DODO_ACTIVE_DEAL_EVENT_NAME: 'dealguard_active_deal',
  DODO_EVENT_OVERAGE_EVENT_NAME: 'dealguard_event',
  DODO_RETENTION_EVENT_NAME: 'dealguard_retention_gb_month',
};

function runPreflight(extraEnvironment = {}, extraArguments = []) {
  return spawnSync(process.execPath, [
    'scripts/release-preflight.mjs',
    '--output', '.release/test-preflight.json',
    '--wrangler-output', '.release/test-wrangler.toml',
    ...extraArguments,
  ], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env: { ...process.env, ...completeEnvironment, ...extraEnvironment },
  });
}

test('release preflight validates complete enterprise configuration and renders no placeholders', async () => {
  await rm('.release', { recursive: true, force: true });
  const result = runPreflight();
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);

  const report = JSON.parse(await readFile('.release/test-preflight.json', 'utf8'));
  assert.equal(report.summary.failed, 0);
  assert.equal(report.releaseVersion, version);
  assert.equal(report.target, 'staging');

  const wrangler = await readFile('.release/test-wrangler.toml', 'utf8');
  assert.match(wrangler, /main = "\.\.\/worker\/src\/index\.ts"/);
  assert.match(wrangler, /APP_BASE_URL = "https:\/\/dealguard-api-staging\.rokad\.co"/);
  assert.match(wrangler, /HUBSPOT_APP_ID = "123456"/);
  assert.match(wrangler, /id = "0123456789abcdef0123456789abcdef"/);
  assert.match(wrangler, /TIGRIS_BUCKET = "dealguard-staging"/);
  assert.match(wrangler, /workers_dev = true/);
  assert.doesNotMatch(wrangler, /REPLACE_WITH_|d1_databases|D1_DATABASE_ID/i);
});

test('release preflight requires live Dodo mode and production URL for production', async () => {
  await rm('.release', { recursive: true, force: true });
  const productionBase = { RELEASE_TARGET: 'production', APP_BASE_URL: 'https://dealguard-api.rokad.co' };
  const rejected = runPreflight({ ...productionBase, DODO_ENVIRONMENT: 'test' }, ['--no-render']);
  assert.notEqual(rejected.status, 0);
  const rejectedReport = JSON.parse(await readFile('.release/test-preflight.json', 'utf8'));
  assert.ok(rejectedReport.checks.some((item) => item.id === 'env.DODO_ENVIRONMENT.target' && !item.ok));

  const accepted = runPreflight({ ...productionBase, DODO_ENVIRONMENT: 'live' }, ['--no-render']);
  assert.equal(accepted.status, 0, `${accepted.stdout}\n${accepted.stderr}`);
});

test('release preflight reports invalid environment without crashing or rendering config', async () => {
  await rm('.release', { recursive: true, force: true });
  const result = runPreflight({ APP_BASE_URL: '', HUBSPOT_APP_ID: 'not-numeric', NEON_DATABASE_URL: '' }, ['--no-render']);
  assert.notEqual(result.status, 0);

  const report = JSON.parse(await readFile('.release/test-preflight.json', 'utf8'));
  assert.ok(report.summary.failed >= 4);
  assert.ok(report.checks.some((item) => item.id === 'env.APP_BASE_URL.https' && !item.ok));
  assert.ok(report.checks.some((item) => item.id === 'env.HUBSPOT_APP_ID.numeric' && !item.ok));
  assert.ok(report.checks.some((item) => item.id === 'env.NEON_DATABASE_URL.postgres' && !item.ok));
});

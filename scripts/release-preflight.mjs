import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import process from 'node:process';

const ROOT = resolve(new URL('..', import.meta.url).pathname, '..');
const args = new Set(process.argv.slice(2));
const outputPath = resolve(ROOT, valueAfter('--output') ?? '.release/preflight.json');
const wranglerOutput = resolve(ROOT, valueAfter('--wrangler-output') ?? '.release/wrangler.toml');
const renderWrangler = !args.has('--no-render');
const target = process.env.RELEASE_TARGET === 'production' ? 'production' : 'staging';
const includeHubSpotUpload = truthy(process.env.RELEASE_INCLUDE_HUBSPOT_UPLOAD);
const checks = [];

function valueAfter(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : null;
}

function truthy(value) {
  return ['1', 'true', 'yes', 'on'].includes(String(value ?? '').toLowerCase());
}

function present(value) {
  const text = String(value ?? '').trim();
  return Boolean(text) && !/^(replace_with|changeme|todo|example|placeholder)/i.test(text);
}

function add(id, ok, detail, category = 'repository') {
  checks.push({ id, ok: Boolean(ok), category, detail: String(detail) });
}

async function text(path) {
  return readFile(resolve(ROOT, path), 'utf8');
}

function requiredEnvironment() {
  const common = [
    'APP_BASE_URL',
    'HUBSPOT_APP_ID',
    'HUBSPOT_CLIENT_ID',
    'HUBSPOT_CLIENT_SECRET',
    'TOKEN_ENCRYPTION_KEY',
    'ADMIN_API_KEY',
    'D1_DATABASE_ID',
    'CLOUDFLARE_ACCOUNT_ID',
    'CLOUDFLARE_API_TOKEN',
    'RESEND_API_KEY',
    'SLACK_CLIENT_ID',
    'SLACK_CLIENT_SECRET',
    'DODO_API_KEY',
    'DODO_WEBHOOK_SECRET',
    'DODO_GROWTH_MONTHLY_PRODUCT_ID',
    'DODO_GROWTH_YEARLY_PRODUCT_ID',
    'DODO_ENTERPRISE_MONTHLY_PRODUCT_ID',
    'DODO_ENTERPRISE_YEARLY_PRODUCT_ID',
    'DODO_AI_CREDIT_EVENT_NAME',
    'DODO_ACTIVE_DEAL_EVENT_NAME',
    'DODO_EVENT_OVERAGE_EVENT_NAME',
    'DODO_RETENTION_EVENT_NAME',
  ];
  if (includeHubSpotUpload) common.push('HUBSPOT_CLI_CONFIG_B64');
  return common;
}

async function validateEnvironment() {
  for (const name of requiredEnvironment()) {
    add(`env.${name}`, present(process.env[name]), present(process.env[name]) ? 'configured' : 'missing or placeholder', 'environment');
  }
  const baseUrl = process.env.APP_BASE_URL ?? '';
  let parsed = null;
  try { parsed = new URL(baseUrl); } catch { /* handled below */ }
  add('env.APP_BASE_URL.https', parsed?.protocol === 'https:', 'APP_BASE_URL must be an absolute HTTPS URL', 'environment');
  add('env.HUBSPOT_APP_ID.numeric', /^\d+$/.test(process.env.HUBSPOT_APP_ID ?? ''), 'HUBSPOT_APP_ID must be numeric', 'environment');
  add('env.D1_DATABASE_ID.uuid', /^[0-9a-f-]{32,36}$/i.test(process.env.D1_DATABASE_ID ?? ''), 'D1_DATABASE_ID must look like a Cloudflare D1 identifier', 'environment');
  add('env.TOKEN_ENCRYPTION_KEY.length', String(process.env.TOKEN_ENCRYPTION_KEY ?? '').length >= 32, 'TOKEN_ENCRYPTION_KEY must contain at least 32 characters', 'environment');
  add('env.DODO_WEBHOOK_SECRET.format', String(process.env.DODO_WEBHOOK_SECRET ?? '').startsWith('whsec_'), 'DODO_WEBHOOK_SECRET must use the whsec_ form', 'environment');
}

async function validateRepository() {
  const packageJson = JSON.parse(await text('package.json'));
  const hsProject = JSON.parse(await text('hsproject.json'));
  const appManifest = JSON.parse(await text('src/app/app-hsmeta.json'));
  const wrangler = await text('wrangler.toml');
  const deployment = await text('docs/DEPLOYMENT.md');
  const envExample = await text('.env.example');
  const routeFiles = (await readdir(resolve(ROOT, 'worker/src'))).filter((name) => /^routes.*\.ts$/.test(name));
  const routeSource = (await Promise.all(routeFiles.map((name) => text(`worker/src/${name}`)))).join('\n');

  add('package.version.release_candidate', /^2\.0\.0-rc\.\d+$/.test(packageJson.version), `package version is ${packageJson.version}`);
  add('runtime.version.matches', routeSource.includes(`version: '${packageJson.version}'`) || routeSource.includes(`version: \"${packageJson.version}\"`), 'health endpoint version must match package.json');
  add('hubspot.platform', hsProject.platformVersion === '2026.03', `HubSpot platform version is ${hsProject.platformVersion}`);
  add('hubspot.marketplace_distribution', appManifest?.config?.distribution === 'marketplace', 'HubSpot app distribution must be marketplace');

  const baseUrl = new URL(process.env.APP_BASE_URL);
  const normalizedRoot = `${baseUrl.origin}/`;
  const redirect = `${baseUrl.origin}/oauth/callback`;
  add('hubspot.fetch_domain', appManifest?.config?.permittedUrls?.fetch?.includes(normalizedRoot), `permitted fetch URLs must include ${normalizedRoot}`);
  add('hubspot.redirect_domain', appManifest?.config?.auth?.redirectUrls?.includes(redirect), `OAuth redirects must include ${redirect}`);
  add('hubspot.support_https', ['documentationUrl', 'supportUrl'].every((key) => String(appManifest?.config?.support?.[key] ?? '').startsWith('https://')), 'support and documentation URLs must use HTTPS');

  add('wrangler.worker_name', /name\s*=\s*"dealguard-api"/.test(wrangler), 'Worker must retain the dealguard-api name');
  add('wrangler.database_binding', /binding\s*=\s*"DB"/.test(wrangler), 'D1 must be bound as DB');
  add('wrangler.cron', /crons\s*=\s*\["\*\/15 \* \* \* \*"\]/.test(wrangler), '15-minute scheduler must remain configured');
  add('repository.no_stripe_deployment', !/STRIPE_|api\.stripe\.com|webhooks\/stripe/i.test(`${deployment}\n${envExample}`), 'release documentation and environment template must not reference Stripe');
  add('repository.dodo_documented', /Dodo Payments/i.test(deployment), 'deployment guide must document Dodo Payments');

  const migrationFiles = (await readdir(resolve(ROOT, 'worker/migrations')))
    .filter((name) => /^\d{4}_.+\.sql$/.test(name))
    .sort();
  const migrationNumbers = migrationFiles.map((name) => Number(name.slice(0, 4)));
  const contiguous = migrationNumbers.every((number, index) => index === 0 ? number === 1 : number === migrationNumbers[index - 1] + 1);
  add('migrations.contiguous', contiguous, `migration sequence: ${migrationNumbers.join(', ')}`);
  add('migrations.latest', migrationNumbers.at(-1) === 13, `latest migration is ${migrationFiles.at(-1) ?? 'missing'}`);

  const requiredEnvNames = requiredEnvironment().filter((name) => !['CLOUDFLARE_ACCOUNT_ID', 'CLOUDFLARE_API_TOKEN', 'D1_DATABASE_ID', 'HUBSPOT_CLI_CONFIG_B64'].includes(name));
  for (const name of requiredEnvNames) {
    add(`env_example.${name}`, envExample.includes(`${name}=`), `${name} must be documented in .env.example`);
  }

  return { packageJson, appManifest, wrangler, migrationFiles };
}

function renderDeploymentWrangler(source) {
  const baseUrl = new URL(process.env.APP_BASE_URL).origin;
  let rendered = source
    .replace(/APP_BASE_URL\s*=\s*"[^"]*"/, `APP_BASE_URL = "${baseUrl}"`)
    .replace(/HUBSPOT_APP_ID\s*=\s*"[^"]*"/, `HUBSPOT_APP_ID = "${process.env.HUBSPOT_APP_ID}"`)
    .replace(/database_id\s*=\s*"[^"]*"/, `database_id = "${process.env.D1_DATABASE_ID}"`);
  rendered = rendered.replace(/workers_dev\s*=\s*(true|false)/, `workers_dev = ${target === 'staging' ? 'true' : 'false'}`);
  return rendered;
}

async function main() {
  await validateEnvironment();
  const repository = await validateRepository();
  if (renderWrangler && checks.every((item) => item.ok || item.category !== 'environment')) {
    await mkdir(dirname(wranglerOutput), { recursive: true });
    await writeFile(wranglerOutput, renderDeploymentWrangler(repository.wrangler), { mode: 0o600 });
    add('output.wrangler', true, `rendered ${wranglerOutput}`, 'output');
  }

  const failed = checks.filter((item) => !item.ok);
  const report = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    target,
    releaseVersion: repository.packageJson.version,
    includeHubSpotUpload,
    commit: process.env.GITHUB_SHA ?? null,
    summary: { total: checks.length, passed: checks.length - failed.length, failed: failed.length },
    checks,
  };
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });

  for (const item of checks) console.log(`${item.ok ? 'PASS' : 'FAIL'} ${item.id}: ${item.detail}`);
  console.log(`\nPreflight ${failed.length ? 'failed' : 'passed'}: ${report.summary.passed}/${report.summary.total} checks passed.`);
  if (failed.length) process.exitCode = 1;
}

await main();

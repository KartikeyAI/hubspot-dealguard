import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, relative, resolve } from 'node:path';
import process from 'node:process';

const ROOT = process.cwd();
const target = process.env.RELEASE_TARGET === 'production' ? 'production' : 'staging';
const includeHubSpotUpload = String(process.env.RELEASE_INCLUDE_HUBSPOT_UPLOAD ?? 'false') === 'true';
const renderWrangler = !process.argv.includes('--no-render');
const outputPath = resolve(ROOT, valueAfter('--output') ?? '.release/preflight.json');
const wranglerOutput = resolve(ROOT, valueAfter('--wrangler-output') ?? '.release/wrangler.toml');
const checks = [];

function valueAfter(name) { const index = process.argv.indexOf(name); return index >= 0 ? process.argv[index + 1] : null; }
function add(id, ok, detail, category = 'repository') { checks.push({ id, ok: Boolean(ok), detail, category }); }
async function text(path) { return readFile(resolve(ROOT, path), 'utf8'); }
function present(value) { return typeof value === 'string' && value.trim() !== '' && !/^(replace|placeholder|changeme)/i.test(value.trim()); }
function parsedUrl(value) { try { const url = new URL(String(value ?? '')); return url.protocol === 'https:' ? url : null; } catch { return null; } }
function postgresUrl(value) { try { const url = new URL(String(value ?? '')); return ['postgres:', 'postgresql:'].includes(url.protocol) ? url : null; } catch { return null; } }

function requiredEnvironment() {
  const common = [
    'APP_BASE_URL', 'HUBSPOT_APP_ID', 'HUBSPOT_CLIENT_ID', 'HUBSPOT_CLIENT_SECRET',
    'TOKEN_ENCRYPTION_KEY', 'ADMIN_API_KEY', 'NEON_DATABASE_URL', 'HYPERDRIVE_CONFIG_ID',
    'CLOUDFLARE_ACCOUNT_ID', 'CLOUDFLARE_API_TOKEN', 'RESEND_API_KEY',
    'SLACK_CLIENT_ID', 'SLACK_CLIENT_SECRET',
    'TIGRIS_BUCKET', 'TIGRIS_ACCESS_KEY_ID', 'TIGRIS_SECRET_ACCESS_KEY',
    'DODO_API_KEY', 'DODO_WEBHOOK_SECRET', 'DODO_ENVIRONMENT',
    'DODO_GROWTH_MONTHLY_PRODUCT_ID', 'DODO_GROWTH_YEARLY_PRODUCT_ID',
    'DODO_ENTERPRISE_MONTHLY_PRODUCT_ID', 'DODO_ENTERPRISE_YEARLY_PRODUCT_ID',
    'DODO_AI_CREDIT_EVENT_NAME', 'DODO_ACTIVE_DEAL_EVENT_NAME',
    'DODO_EVENT_OVERAGE_EVENT_NAME', 'DODO_RETENTION_EVENT_NAME',
  ];
  if (includeHubSpotUpload) common.push('HUBSPOT_CLI_CONFIG_B64');
  return common;
}

async function validateEnvironment() {
  for (const name of requiredEnvironment()) add(`env.${name}`, present(process.env[name]), present(process.env[name]) ? 'configured' : 'missing or placeholder', 'environment');
  const base = parsedUrl(process.env.APP_BASE_URL);
  add('env.APP_BASE_URL.https', Boolean(base), 'APP_BASE_URL must be an absolute HTTPS URL', 'environment');
  add('env.APP_BASE_URL.target', Boolean(base && (target === 'production' ? base.hostname === 'dealguard-api.rokad.co' : base.hostname.includes('staging'))), `APP_BASE_URL must identify the ${target} deployment`, 'environment');
  add('env.HUBSPOT_APP_ID.numeric', /^\d+$/.test(process.env.HUBSPOT_APP_ID ?? ''), 'HUBSPOT_APP_ID must be numeric', 'environment');
  add('env.NEON_DATABASE_URL.postgres', Boolean(postgresUrl(process.env.NEON_DATABASE_URL)), 'NEON_DATABASE_URL must be a PostgreSQL connection URL', 'environment');
  add('env.NEON_DATABASE_URL.tls', /sslmode=(require|verify-full)/i.test(process.env.NEON_DATABASE_URL ?? '') || /\.neon\.tech(?::|\/)/i.test(process.env.NEON_DATABASE_URL ?? ''), 'Neon connections must require TLS', 'environment');
  add('env.HYPERDRIVE_CONFIG_ID.format', /^[0-9a-f]{32}$/i.test(process.env.HYPERDRIVE_CONFIG_ID ?? ''), 'HYPERDRIVE_CONFIG_ID must be a 32-character Cloudflare identifier', 'environment');
  add('env.TOKEN_ENCRYPTION_KEY.length', String(process.env.TOKEN_ENCRYPTION_KEY ?? '').length >= 32, 'TOKEN_ENCRYPTION_KEY must contain at least 32 characters', 'environment');
  add('env.TIGRIS_ACCESS_KEY_ID.format', String(process.env.TIGRIS_ACCESS_KEY_ID ?? '').startsWith('tid_'), 'Tigris access key must use the tid_ form', 'environment');
  add('env.TIGRIS_SECRET_ACCESS_KEY.format', String(process.env.TIGRIS_SECRET_ACCESS_KEY ?? '').startsWith('tsec_'), 'Tigris secret key must use the tsec_ form', 'environment');
  add('env.DODO_WEBHOOK_SECRET.format', String(process.env.DODO_WEBHOOK_SECRET ?? '').startsWith('whsec_'), 'DODO_WEBHOOK_SECRET must use the whsec_ form', 'environment');
  const expectedDodoEnvironment = target === 'production' ? 'live' : 'test';
  add('env.DODO_ENVIRONMENT.target', process.env.DODO_ENVIRONMENT === expectedDodoEnvironment, `DODO_ENVIRONMENT must be ${expectedDodoEnvironment} for ${target}`, 'environment');
}

async function validateRepository() {
  const packageJson = JSON.parse(await text('package.json'));
  const hsProject = JSON.parse(await text('hsproject.json'));
  const appManifest = JSON.parse(await text('src/app/app-hsmeta.json'));
  const wrangler = await text('wrangler.toml');
  const deployment = await text('docs/DEPLOYMENT.md');
  const migrationGuide = await text('docs/MIGRATION_D1_TO_NEON.md');
  const productionRunbook = await text('docs/PRODUCTION_DEPLOYMENT_RUNBOOK.md');
  const acceptanceRunbook = await text('docs/PRODUCTION_ACCEPTANCE_RUNBOOK.md');
  const envExample = await text('.env.example');
  const index = await text('worker/src/index.ts');
  const versionSource = await text('worker/src/version.ts');
  const postgres = await text('worker/src/postgres.ts');
  const storage = await text('worker/src/object-storage.ts');
  const queueing = await text('worker/src/queueing.ts');
  const targetRenderer = await text('scripts/render-hubspot-target.mjs');
  const smokeSource = await text('scripts/production-smoke.mjs');

  add('package.version.production', /^2\.1\.0$/.test(packageJson.version), `package version is ${packageJson.version}`);
  add('runtime.version.matches', versionSource.includes(`DEALGUARD_VERSION = '${packageJson.version}'`) && /DEALGUARD_VERSION/.test(index), 'central Worker health identity must match package.json');
  add('hubspot.platform', hsProject.platformVersion === '2026.03', `HubSpot platform version is ${hsProject.platformVersion}`);
  add('hubspot.marketplace_distribution', appManifest?.config?.distribution === 'marketplace', 'HubSpot app distribution must be marketplace');

  const canonicalRoot = 'https://dealguard-api.rokad.co/';
  const canonicalRedirect = 'https://dealguard-api.rokad.co/oauth/callback';
  add('hubspot.fetch_domain', appManifest?.config?.permittedUrls?.fetch?.includes(canonicalRoot), `canonical manifest must include ${canonicalRoot}`);
  add('hubspot.redirect_domain', appManifest?.config?.auth?.redirectUrls?.includes(canonicalRedirect), `canonical manifest must include ${canonicalRedirect}`);
  add('hubspot.target_renderer', /HUBSPOT_TARGET_BASE_URL/.test(targetRenderer) && /dealguard-api-staging\.rokad\.co/.test(targetRenderer) && /replaceAll/.test(targetRenderer), 'HubSpot target renderer must safely produce staging or production manifests');

  add('wrangler.node_compat', /nodejs_compat/.test(wrangler), 'Cloudflare nodejs_compat must be enabled for pg and AWS SDK');
  add('wrangler.hyperdrive', /binding\s*=\s*"HYPERDRIVE"/.test(wrangler), 'Hyperdrive binding is required');
  for (const binding of ['SCAN_QUEUE', 'DELIVERY_QUEUE', 'MAINTENANCE_QUEUE']) add(`wrangler.queue.${binding}`, wrangler.includes(`binding = "${binding}"`), `${binding} producer binding is required`);
  add('wrangler.queue.consumers', (wrangler.match(/queues\.consumers/g) ?? []).length >= 6, 'staging and production queue consumers are required');
  add('wrangler.no_d1', !/d1_databases|D1_DATABASE|wrangler d1/i.test(wrangler), 'Wrangler configuration must not contain legacy database bindings');
  add('runtime.postgres_adapter', /new Client/.test(postgres) && /search_path TO dealguard/.test(postgres), 'PostgreSQL adapter must use pg through the dealguard schema');
  add('runtime.queue_handler', /async queue\(/.test(index) && /processQueueBatch/.test(index), 'Worker queue consumer handler is required');
  add('runtime.tigris', /t3\.storage\.dev/.test(storage) && /PutObjectCommand/.test(storage), 'Tigris S3 object storage adapter is required');
  add('runtime.queue_retry', /MAX_QUEUE_ATTEMPTS/.test(queueing) && /retry\(/.test(queueing), 'Queue retry and dead-letter behavior is required');
  add('runtime.production_smoke', /DG-PROD-007/.test(smokeSource) && /dealguard-api\.rokad\.co/.test(smokeSource), 'production smoke verification must cover release identity, OAuth, public surfaces and secret leakage');

  const migrationFiles = (await readdir(resolve(ROOT, 'database/migrations'))).filter((name) => /^\d{4}_.+\.sql$/.test(name)).sort();
  const migrationNumbers = migrationFiles.map((name) => Number(name.slice(0, 4)));
  const contiguous = migrationNumbers.every((number, index) => index === 0 ? number === 1 : number === migrationNumbers[index - 1] + 1);
  add('migrations.contiguous', contiguous, `PostgreSQL migration sequence: ${migrationNumbers.join(', ')}`);
  add('migrations.latest', migrationNumbers.at(-1) === 14, `latest migration is ${migrationFiles.at(-1) ?? 'missing'}`);
  add('migrations.no_d1_directory', !(await readdir(resolve(ROOT, 'worker'))).includes('migrations'), 'legacy runtime migration directory must be removed');

  const publicDocs = `${deployment}\n${productionRunbook}\n${acceptanceRunbook}\n${envExample}`;
  add('repository.no_d1_release', !/Cloudflare D1 database|wrangler d1|D1_DATABASE_ID|production D1 backup/i.test(publicDocs), 'production documentation and environment template must not describe D1 as the runtime');
  add('repository.neon_documented', /Neon PostgreSQL/i.test(deployment), 'deployment guide must document Neon PostgreSQL');
  add('repository.tigris_documented', /Tigris/i.test(deployment), 'deployment guide must document Tigris');
  add('repository.queues_documented', /Cloudflare Queues/i.test(deployment), 'deployment guide must document Cloudflare Queues');
  add('repository.cutover_documented', /row-count reconciliation/i.test(migrationGuide) && /rollback/i.test(migrationGuide) && /Tigris/i.test(migrationGuide), 'migration guide must document reconciliation, backup and rollback');
  add('repository.production_runbook', /Production go\/no-go/i.test(productionRunbook) && /Controlled deploy/i.test(productionRunbook) && /rollback/i.test(productionRunbook), 'production deployment runbook must contain go/no-go, controlled deploy and rollback procedures');
  add('repository.acceptance_runbook', /DG-PROD-001/.test(acceptanceRunbook) && /DG-LIVE-014/.test(acceptanceRunbook), 'production acceptance runbook must map automated smoke and signed acceptance checks');

  const excluded = new Set(['CLOUDFLARE_ACCOUNT_ID', 'CLOUDFLARE_API_TOKEN', 'HYPERDRIVE_CONFIG_ID', 'HUBSPOT_CLI_CONFIG_B64']);
  for (const name of requiredEnvironment().filter((item) => !excluded.has(item))) add(`env_example.${name}`, envExample.includes(`${name}=`), `${name} must be documented in .env.example`);
  return { packageJson, wrangler };
}

function renderDeploymentWrangler(source) {
  const baseUrl = parsedUrl(process.env.APP_BASE_URL);
  if (!baseUrl) throw new Error('APP_BASE_URL is invalid.');
  const appId = process.env.HUBSPOT_APP_ID;
  const hyperdrive = process.env.HYPERDRIVE_CONFIG_ID;
  const bucket = process.env.TIGRIS_BUCKET;
  const sourceMain = source.match(/^main\s*=\s*"([^"]+)"/m)?.[1];
  if (!sourceMain) throw new Error('Wrangler source configuration is missing main.');
  const renderedMain = relative(dirname(wranglerOutput), resolve(ROOT, sourceMain)).replaceAll('\\', '/');
  let rendered = source
    .replace(/^main\s*=\s*"[^"]+"/m, `main = "${renderedMain}"`)
    .replaceAll('REPLACE_WITH_STAGING_HUBSPOT_APP_ID', appId)
    .replaceAll('REPLACE_WITH_PRODUCTION_HUBSPOT_APP_ID', appId)
    .replaceAll('REPLACE_WITH_LOCAL_HUBSPOT_APP_ID', appId)
    .replaceAll('REPLACE_WITH_STAGING_HYPERDRIVE_ID', hyperdrive)
    .replaceAll('REPLACE_WITH_PRODUCTION_HYPERDRIVE_ID', hyperdrive)
    .replaceAll('REPLACE_WITH_STAGING_TIGRIS_BUCKET', bucket)
    .replaceAll('REPLACE_WITH_PRODUCTION_TIGRIS_BUCKET', bucket)
    .replaceAll('REPLACE_WITH_LOCAL_TIGRIS_BUCKET', bucket);
  const environmentPattern = new RegExp(`(\\[env\\.${target}\\.vars\\][\\s\\S]*?APP_BASE_URL\\s*=\\s*)"[^"]*"`);
  rendered = rendered.replace(environmentPattern, `$1"${baseUrl.origin}"`);
  return rendered;
}

async function main() {
  await validateEnvironment();
  const repository = await validateRepository();
  const environmentFailed = checks.some((item) => item.category === 'environment' && !item.ok);
  if (renderWrangler && !environmentFailed) {
    await mkdir(dirname(wranglerOutput), { recursive: true });
    await writeFile(wranglerOutput, renderDeploymentWrangler(repository.wrangler), { mode: 0o600 });
    add('output.wrangler', true, `rendered ${wranglerOutput}`, 'output');
  }
  const failed = checks.filter((item) => !item.ok);
  const report = { schemaVersion: 3, generatedAt: new Date().toISOString(), target, releaseVersion: repository.packageJson.version, includeHubSpotUpload, commit: process.env.GITHUB_SHA ?? null, summary: { total: checks.length, passed: checks.length - failed.length, failed: failed.length }, checks };
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  for (const item of checks) console.log(`${item.ok ? 'PASS' : 'FAIL'} ${item.id}: ${item.detail}`);
  console.log(`\nPreflight ${failed.length ? 'failed' : 'passed'}: ${report.summary.passed}/${report.summary.total} checks passed.`);
  if (failed.length) process.exitCode = 1;
}

await main();

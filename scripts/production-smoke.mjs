import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import process from 'node:process';

const root = process.cwd();
const packageJson = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'));
const allowNonProduction = String(process.env.PRODUCTION_SMOKE_ALLOW_NON_PRODUCTION ?? 'false') === 'true';
const baseUrl = cleanBaseUrl(valueAfter('--base-url') ?? process.env.PRODUCTION_SMOKE_BASE_URL ?? process.env.APP_BASE_URL);
const output = resolve(root, valueAfter('--output') ?? process.env.PRODUCTION_SMOKE_OUTPUT ?? '.release/production-smoke/evidence.json');
const timeoutMs = boundedNumber(process.env.PRODUCTION_SMOKE_TIMEOUT_MS ?? '20000', 1000, 60000);
const expectedVersion = String(process.env.PRODUCTION_SMOKE_EXPECT_VERSION ?? packageJson.version).trim();
const target = allowNonProduction ? 'staging' : 'production';
const checks = [];

function valueAfter(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : null;
}

function boundedNumber(value, minimum, maximum) {
  const number = Number(value);
  if (!Number.isFinite(number)) return minimum;
  return Math.max(minimum, Math.min(maximum, number));
}

function cleanBaseUrl(value) {
  if (!value) throw new Error('PRODUCTION_SMOKE_BASE_URL, APP_BASE_URL, or --base-url is required.');
  const parsed = new URL(String(value));
  if (parsed.protocol !== 'https:' && !allowNonProduction) throw new Error('Production smoke target must use HTTPS.');
  parsed.pathname = '/';
  parsed.search = '';
  parsed.hash = '';
  return parsed;
}

function sanitizedUrl(url) {
  const parsed = new URL(url);
  parsed.search = '';
  parsed.hash = '';
  return parsed.toString();
}

async function request(path, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(new URL(path, baseUrl), {
      redirect: options.redirect ?? 'follow',
      method: options.method ?? 'GET',
      headers: options.headers,
      signal: controller.signal,
    });
    const text = await response.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { json = null; }
    return {
      status: response.status,
      headers: Object.fromEntries(response.headers.entries()),
      text,
      json,
    };
  } finally {
    clearTimeout(timer);
  }
}

async function run(id, area, title, callback) {
  const startedAt = new Date().toISOString();
  try {
    const actual = await callback();
    checks.push({ id, area, title, result: 'passed', startedAt, completedAt: new Date().toISOString(), actual });
  } catch (error) {
    checks.push({
      id,
      area,
      title,
      result: 'failed',
      startedAt,
      completedAt: new Date().toISOString(),
      error: (error instanceof Error ? error.message : String(error)).slice(0, 2000),
    });
  }
}

function ensure(condition, message) {
  if (!condition) throw new Error(message);
}

if (!allowNonProduction) ensure(baseUrl.hostname === 'dealguard-api.rokad.co', `Production smoke hostname must be dealguard-api.rokad.co, received ${baseUrl.hostname}.`);

await run('DG-PROD-001', 'release', 'Production HTTPS identity', async () => ({
  origin: baseUrl.origin,
  hostname: baseUrl.hostname,
  protocol: baseUrl.protocol,
}));

await run('DG-PROD-002', 'worker', 'Health endpoint and release identity', async () => {
  const response = await request('/health');
  ensure(response.status === 200, `/health returned ${response.status}.`);
  ensure(response.json?.status === 'ok', 'Health status is not ok.');
  ensure(response.json?.service === 'dealguard-api', 'Health service identity is invalid.');
  ensure(response.json?.version === expectedVersion, `Health version ${response.json?.version ?? 'missing'} does not match ${expectedVersion}.`);
  return { status: response.status, version: response.json.version, service: response.json.service };
});

await run('DG-PROD-003', 'reliability', 'Public status endpoint', async () => {
  const response = await request('/status');
  ensure(response.status === 200, `/status returned ${response.status}.`);
  ensure(String(response.headers['content-type'] ?? '').includes('application/json'), '/status is not JSON.');
  ensure(!/(stack trace|postgresql:\/\/|tsec_|whsec_|bearer\s+[a-z0-9._-]+)/i.test(response.text), '/status exposes sensitive diagnostic content.');
  return { status: response.status, payloadKeys: response.json && typeof response.json === 'object' ? Object.keys(response.json).sort() : [] };
});

await run('DG-PROD-004', 'public', 'Documentation, privacy, terms and support surfaces', async () => {
  const pages = [];
  for (const path of ['/docs', '/privacy', '/terms', '/support']) {
    const response = await request(path);
    ensure(response.status === 200, `${path} returned ${response.status}.`);
    ensure(String(response.headers['content-type'] ?? '').includes('text/html'), `${path} is not HTML.`);
    ensure(Buffer.byteLength(response.text) >= 200, `${path} returned an unexpectedly small response.`);
    pages.push({ path, status: response.status, bytes: Buffer.byteLength(response.text) });
  }
  return pages;
});

await run('DG-PROD-005', 'security', 'Unsigned protected API rejection', async () => {
  const response = await request('/api/v1/billing');
  ensure(response.status === 401, `Unsigned billing API returned ${response.status}.`);
  return { status: response.status, errorCode: response.json?.error?.code ?? null };
});

await run('DG-PROD-006', 'hubspot', 'OAuth install redirect contract', async () => {
  const response = await request('/oauth/install', { redirect: 'manual' });
  ensure([301, 302, 303, 307, 308].includes(response.status), `/oauth/install returned ${response.status}.`);
  const location = response.headers.location;
  ensure(location, 'OAuth install response is missing Location.');
  const oauthTarget = new URL(location);
  ensure(oauthTarget.protocol === 'https:', 'OAuth redirect is not HTTPS.');
  ensure(oauthTarget.hostname === 'app.hubspot.com', `OAuth redirect host is ${oauthTarget.hostname}.`);
  for (const parameter of ['client_id', 'redirect_uri', 'scope', 'state']) ensure(oauthTarget.searchParams.has(parameter), `OAuth redirect is missing ${parameter}.`);
  ensure(oauthTarget.searchParams.get('redirect_uri') === `${baseUrl.origin}/oauth/callback`, 'OAuth redirect URI does not match target origin.');
  return { status: response.status, target: sanitizedUrl(oauthTarget), scopeCount: String(oauthTarget.searchParams.get('scope') ?? '').split(' ').filter(Boolean).length };
});

await run('DG-PROD-007', 'security', 'No obvious secret leakage on public surfaces', async () => {
  const combined = [];
  for (const path of ['/health', '/status', '/docs', '/privacy', '/terms', '/support']) combined.push((await request(path)).text);
  const text = combined.join('\n');
  const forbidden = [/postgres(?:ql)?:\/\//i, /tsec_[A-Za-z0-9_-]+/, /whsec_[A-Za-z0-9_-]+/, /-----BEGIN (?:RSA |EC )?PRIVATE KEY-----/, /CLOUDFLARE_API_TOKEN/i, /HUBSPOT_CLIENT_SECRET/i];
  const matched = forbidden.find((pattern) => pattern.test(text));
  ensure(!matched, `Public surfaces match forbidden secret pattern ${matched}.`);
  return { scannedSurfaces: 6 };
});

const summary = {
  total: checks.length,
  passed: checks.filter((check) => check.result === 'passed').length,
  failed: checks.filter((check) => check.result === 'failed').length,
};
const evidence = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  target,
  baseUrl: sanitizedUrl(baseUrl),
  expectedVersion,
  operator: process.env.GITHUB_ACTOR ?? process.env.USER ?? 'unknown',
  commit: process.env.RELEASE_SHA ?? process.env.GITHUB_SHA ?? null,
  summary,
  checks,
};
await mkdir(dirname(output), { recursive: true });
await writeFile(output, `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 });
const markdown = output.replace(/\.json$/i, '.md');
await writeFile(markdown, [
  '# DealGuard production smoke evidence',
  '',
  `- Generated: ${evidence.generatedAt}`,
  `- Environment: ${evidence.target}`,
  `- Target: ${evidence.baseUrl}`,
  `- Expected version: ${evidence.expectedVersion}`,
  `- Result: ${summary.failed === 0 ? 'PASSED' : 'FAILED'} (${summary.passed}/${summary.total})`,
  '',
  ...checks.map((check) => `- ${check.result === 'passed' ? '✅' : '❌'} **${check.id}** ${check.title}${check.error ? ` — ${check.error}` : ''}`),
  '',
].join('\n'), { mode: 0o600 });

console.log(JSON.stringify({ evidence: output, markdown, summary }, null, 2));
if (summary.failed > 0) process.exitCode = 1;

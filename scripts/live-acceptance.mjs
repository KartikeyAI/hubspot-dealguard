import { readFile } from 'node:fs/promises';
import process from 'node:process';
import { AcceptanceClient, EvidenceRun, bool, cleanBaseUrl, required, safeUrl } from './acceptance-core.mjs';
import { runAcceptanceSuite } from './acceptance-tests.mjs';

const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
const profile = process.env.ACCEPTANCE_PROFILE === 'full' ? 'full' : 'read-only';
const full = profile === 'full';
const config = {
  baseUrl: cleanBaseUrl(required('ACCEPTANCE_BASE_URL', process.env.ACCEPTANCE_BASE_URL)),
  portalId: required('ACCEPTANCE_PORTAL_ID', process.env.ACCEPTANCE_PORTAL_ID),
  appId: String(process.env.HUBSPOT_APP_ID ?? '').trim(),
  clientSecret: required('HUBSPOT_CLIENT_SECRET', process.env.HUBSPOT_CLIENT_SECRET),
  userId: String(process.env.ACCEPTANCE_USER_ID ?? '').trim(),
  userEmail: String(process.env.ACCEPTANCE_USER_EMAIL ?? '').trim(),
  dodoWebhookSecret: String(process.env.DODO_WEBHOOK_SECRET ?? '').trim(),
  expectedTier: String(process.env.ACCEPTANCE_EXPECT_TIER ?? '').trim(),
  testDealId: String(process.env.ACCEPTANCE_TEST_DEAL_ID ?? '').trim(),
  checkoutTier: ['growth', 'enterprise'].includes(process.env.ACCEPTANCE_CHECKOUT_TIER) ? process.env.ACCEPTANCE_CHECKOUT_TIER : 'growth',
  checkoutInterval: process.env.ACCEPTANCE_CHECKOUT_INTERVAL === 'year' ? 'year' : 'month',
  timeoutMs: Math.max(1000, Number(process.env.ACCEPTANCE_TIMEOUT_MS ?? 25000)),
  outputDir: String(process.env.ACCEPTANCE_OUTPUT_DIR ?? 'artifacts/acceptance'),
  operator: String(process.env.ACCEPTANCE_OPERATOR ?? process.env.GITHUB_ACTOR ?? 'unknown'),
  gitSha: String(process.env.GITHUB_SHA ?? 'local'),
  runScan: bool(process.env.ACCEPTANCE_RUN_SCAN, full),
  runCheckout: bool(process.env.ACCEPTANCE_CREATE_CHECKOUT, full),
  runDodoWebhook: bool(process.env.ACCEPTANCE_DODO_WEBHOOK, full),
  runPlanPreview: bool(process.env.ACCEPTANCE_PLAN_PREVIEW, full),
  runSecureDownload: bool(process.env.ACCEPTANCE_SECURE_DOWNLOAD, full),
};

if (!/^\d+$/.test(config.portalId)) throw new Error('ACCEPTANCE_PORTAL_ID must contain only digits.');
if (config.runDodoWebhook) required('DODO_WEBHOOK_SECRET', config.dodoWebhookSecret);

const evidence = new EvidenceRun({
  release: packageJson.version,
  profile,
  environment: {
    baseUrl: safeUrl(config.baseUrl),
    portalId: config.portalId,
    appIdConfigured: Boolean(config.appId),
    userIdConfigured: Boolean(config.userId),
    userEmailConfigured: Boolean(config.userEmail),
    operator: config.operator,
    gitSha: config.gitSha,
  },
});
const client = new AcceptanceClient(config);
await runAcceptanceSuite(client, evidence, config, packageJson.version);
const output = await evidence.write(config.outputDir);

console.log(JSON.stringify({
  runId: output.evidence.runId,
  release: packageJson.version,
  profile,
  summary: output.evidence.summary,
  evidence: { json: output.jsonPath, markdown: output.markdownPath },
}, null, 2));

if (output.evidence.summary.failed > 0) process.exitCode = 1;

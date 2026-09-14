import { readFile } from 'node:fs/promises';
import process from 'node:process';
import { AcceptanceClient, EvidenceRun, bool, cleanBaseUrl, ensure, required, safeUrl } from './acceptance-core.mjs';
import { certificationContext, contextFailures, intelligenceEvidenceFailures } from './intelligence-certification.mjs';

const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
const mode = process.env.ACCEPTANCE_INTELLIGENCE_REQUIRED ?? 'false';
if (!['true', 'false'].includes(mode)) throw new Error('ACCEPTANCE_INTELLIGENCE_REQUIRED must be true or false.');
const certificationRequired = mode === 'true';
const releaseContext = certificationContext(process.env, packageJson.version);
const config = {
  baseUrl: cleanBaseUrl(required('ACCEPTANCE_BASE_URL', process.env.ACCEPTANCE_BASE_URL)),
  portalId: required('ACCEPTANCE_PORTAL_ID', process.env.ACCEPTANCE_PORTAL_ID),
  appId: String(process.env.HUBSPOT_APP_ID ?? '').trim(),
  clientSecret: required('HUBSPOT_CLIENT_SECRET', process.env.HUBSPOT_CLIENT_SECRET),
  userId: String(process.env.ACCEPTANCE_USER_ID ?? '').trim(),
  userEmail: String(process.env.ACCEPTANCE_USER_EMAIL ?? '').trim(),
  testDealId: String(process.env.ACCEPTANCE_TEST_DEAL_ID ?? '').trim(),
  timeoutMs: Number(process.env.ACCEPTANCE_TIMEOUT_MS ?? 25_000),
  outputDir: String(process.env.ACCEPTANCE_OUTPUT_DIR ?? 'artifacts/intelligence-acceptance'),
  operator: String(process.env.ACCEPTANCE_OPERATOR ?? process.env.GITHUB_ACTOR ?? 'unknown'),
  gitSha: releaseContext.commit || 'local',
  runPortfolio: bool(process.env.ACCEPTANCE_INTELLIGENCE_PORTFOLIO, true),
  refreshDeal: bool(process.env.ACCEPTANCE_INTELLIGENCE_REFRESH_DEAL, true),
};
if (!/^\d+$/.test(config.portalId)) throw new Error('ACCEPTANCE_PORTAL_ID must contain only digits.');
if (config.testDealId && !/^\d+$/.test(config.testDealId)) throw new Error('ACCEPTANCE_TEST_DEAL_ID must contain only digits.');
if (!Number.isFinite(config.timeoutMs) || config.timeoutMs < 1000 || config.timeoutMs > 60_000) {
  throw new Error('ACCEPTANCE_TIMEOUT_MS must be between 1000 and 60000.');
}
// Reject an incomplete certification configuration before making any request.
if (certificationRequired) {
  const failures = contextFailures(releaseContext);
  if (!config.runPortfolio || !config.refreshDeal) failures.push('Certification cannot disable portfolio or deal refresh tests.');
  if (!config.userId && !config.userEmail) failures.push('An identified acceptance user is required.');
  if (failures.length) throw new Error(failures.join('; '));
}

const evidence = new EvidenceRun({
  release: packageJson.version,
  profile: 'intelligence-convergence',
  environment: {
    baseUrl: safeUrl(config.baseUrl), portalId: config.portalId,
    appIdConfigured: Boolean(config.appId), userIdConfigured: Boolean(config.userId),
    userEmailConfigured: Boolean(config.userEmail), testDealConfigured: Boolean(config.testDealId),
    operator: config.operator, gitSha: config.gitSha, testDealId: config.testDealId,
    certificationRequired, releaseTarget: releaseContext.target,
    workflowRunId: releaseContext.workflowRunId, workflowRunAttempt: releaseContext.workflowRunAttempt,
  },
});
const client = new AcceptanceClient(config);
const test = (id, area, title, requiredTest = true) => ({ id, area, title, expected: title, required: requiredTest });
const skip = (id, area, title, reason) => evidence.skip(test(id, area, title, certificationRequired), reason);
let enterprise = false;
await evidence.run(test('DG-INT-001', 'access', 'Enterprise intelligence access'), async () => {
  const response = await client.signed('GET', '/api/v1/enterprise/access');
  ensure(response.status === 200, `Access returned ${response.status}.`);
  enterprise = response.json?.entitled === true;
  ensure(Array.isArray(response.json?.permissions), 'Permission list is unavailable.');
  if (certificationRequired) ensure(enterprise, 'Active Enterprise entitlement is required for certification.');
  return { entitled: enterprise, role: response.json?.role, permissions: response.json?.permissions, requestId: response.requestId };
});

function assessmentResult(response) {
  ensure(response.status === 200, `Assessment returned ${response.status}.`);
  ensure(Number.isFinite(response.json?.score) && response.json.score >= 0 && response.json.score <= 100, 'Readiness score is invalid.');
  const intelligence = response.json?.intelligence ?? {};
  const brief = intelligence.dealBrief ?? response.json?.dealBrief;
  ensure(brief && ['on_track', 'watch', 'intervention_required', 'insufficient_evidence'].includes(brief.status), 'Enriched Deal Brief is unavailable or invalid.');
  return { dealId: config.testDealId, score: response.json.score, status: response.json.status,
    intelligenceDimensions: Object.keys(intelligence), briefStatus: brief.status, requestId: response.requestId };
}

if (config.testDealId) {
  if (config.refreshDeal) {
    await evidence.run(test('DG-INT-002', 'deal-intelligence', 'Refresh deterministic Deal Brief'), async () =>
      assessmentResult(await client.signed('POST', `/api/v1/deals/${config.testDealId}/assessment`, {})));
  } else skip('DG-INT-002', 'deal-intelligence', 'Refresh deterministic Deal Brief', 'Refresh disabled for diagnostic run.');
  await evidence.run(test('DG-INT-003', 'deal-intelligence', 'Read current DealGuard intelligence'), async () =>
    assessmentResult(await client.signed('GET', `/api/v1/deals/${config.testDealId}/assessment`)));
  await evidence.run(test('DG-INT-004', 'recommendations', 'Tracked recommendation history'), async () => {
    const response = await client.signed('GET', `/api/v1/deals/${config.testDealId}/recommendations?limit=20`);
    ensure(response.status === 200, `Recommendation history returned ${response.status}.`);
    const recommendations = response.json?.recommendations ?? response.json?.items;
    ensure(Array.isArray(recommendations), 'Recommendation history is not an array.');
    return { dealId: config.testDealId, recommendations: recommendations.length,
      statuses: [...new Set(recommendations.map((item) => item?.status).filter(Boolean))], requestId: response.requestId };
  });
} else {
  for (const [id, title] of [['DG-INT-002', 'Refresh deterministic Deal Brief'], ['DG-INT-003', 'Read current DealGuard intelligence'], ['DG-INT-004', 'Tracked recommendation history']]) {
    skip(id, 'deal-intelligence', title, 'ACCEPTANCE_TEST_DEAL_ID not provided.');
  }
}

const endpoints = [
  ['DG-INT-005', 'manager-queue', '/api/v1/enterprise/decision-queue?limit=10', 'Manager Decision Queue'],
  ['DG-INT-006', 'executive-revenue', '/api/v1/enterprise/executive-revenue?candidateLimit=5', 'Executive Revenue View'],
  ['DG-INT-007', 'recommendation-outcomes', '/api/v1/enterprise/recommendation-outcomes?days=90', 'Recommendation outcome analytics'],
  ['DG-INT-008', 'recommendation-operations', '/api/v1/enterprise/recommendation-followups/candidates?limit=10', 'Recommendation follow-up candidates'],
  ['DG-INT-009', 'recommendation-routing', '/api/v1/enterprise/recommendation-routing-policies', 'Recommendation routing policies'],
  ['DG-INT-010', 'delivery-analytics', '/api/v1/enterprise/recommendation-delivery-analytics?days=30', 'Recommendation delivery analytics'],
  ['DG-INT-011', 'delivery-slos', '/api/v1/enterprise/recommendation-delivery-slos', 'Recommendation delivery SLO state'],
];
for (const [id, area, endpoint, title] of endpoints) {
  if (!config.runPortfolio || !enterprise) {
    skip(id, area, title, !enterprise ? 'Active Enterprise entitlement required.' : 'Portfolio diagnostics disabled.');
    continue;
  }
  await evidence.run(test(id, area, title), async () => {
    const response = await client.signed('GET', endpoint);
    ensure(response.status === 200, `${title} returned ${response.status}.`);
    ensure(response.json && typeof response.json === 'object' && !Array.isArray(response.json)
      && Object.keys(response.json).length > 0 && response.json.redacted !== true, `${title} returned no usable evidence object.`);
    return { endpoint, topLevelKeys: Object.keys(response.json).slice(0, 30), requestId: response.requestId };
  });
}
await evidence.run(test('DG-INT-012', 'security', 'Unsigned intelligence endpoint rejection'), async () => {
  const response = await client.http('GET', client.identityUrl('/api/v1/enterprise/decision-queue'));
  ensure(response.status === 401, `Unsigned decision queue returned ${response.status}.`);
  return { status: response.status, errorCode: response.json?.error?.code, requestId: response.requestId };
});
const output = await evidence.write(config.outputDir);
const certificationFailures = certificationRequired ? intelligenceEvidenceFailures(output.evidence, releaseContext) : [];
console.log(JSON.stringify({ runId: output.evidence.runId, release: packageJson.version,
  certification: certificationRequired ? (certificationFailures.length ? 'failed' : 'passed') : 'not_requested',
  summary: output.evidence.summary, certificationFailures,
  evidence: { json: output.jsonPath, markdown: output.markdownPath } }, null, 2));
if (output.evidence.summary.failed > 0 || certificationFailures.length) process.exitCode = 1;

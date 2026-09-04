import { readFile } from 'node:fs/promises';
import process from 'node:process';
import {
  AcceptanceClient,
  EvidenceRun,
  bool,
  cleanBaseUrl,
  ensure,
  required,
  safeUrl,
} from './acceptance-core.mjs';

const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
const config = {
  baseUrl: cleanBaseUrl(required('ACCEPTANCE_BASE_URL', process.env.ACCEPTANCE_BASE_URL)),
  portalId: required('ACCEPTANCE_PORTAL_ID', process.env.ACCEPTANCE_PORTAL_ID),
  appId: String(process.env.HUBSPOT_APP_ID ?? '').trim(),
  clientSecret: required('HUBSPOT_CLIENT_SECRET', process.env.HUBSPOT_CLIENT_SECRET),
  userId: String(process.env.ACCEPTANCE_USER_ID ?? '').trim(),
  userEmail: String(process.env.ACCEPTANCE_USER_EMAIL ?? '').trim(),
  testDealId: String(process.env.ACCEPTANCE_TEST_DEAL_ID ?? '').trim(),
  timeoutMs: Math.max(1000, Number(process.env.ACCEPTANCE_TIMEOUT_MS ?? 25_000)),
  outputDir: String(process.env.ACCEPTANCE_OUTPUT_DIR ?? 'artifacts/intelligence-acceptance'),
  operator: String(process.env.ACCEPTANCE_OPERATOR ?? process.env.GITHUB_ACTOR ?? 'unknown'),
  gitSha: String(process.env.GITHUB_SHA ?? 'local'),
  runPortfolio: bool(process.env.ACCEPTANCE_INTELLIGENCE_PORTFOLIO, true),
  refreshDeal: bool(process.env.ACCEPTANCE_INTELLIGENCE_REFRESH_DEAL, true),
};

if (!/^\d+$/.test(config.portalId)) throw new Error('ACCEPTANCE_PORTAL_ID must contain only digits.');
if (config.testDealId && !/^\d+$/.test(config.testDealId)) {
  throw new Error('ACCEPTANCE_TEST_DEAL_ID must contain only digits.');
}

const evidence = new EvidenceRun({
  release: packageJson.version,
  profile: 'intelligence-convergence',
  environment: {
    baseUrl: safeUrl(config.baseUrl),
    portalId: config.portalId,
    appIdConfigured: Boolean(config.appId),
    userIdConfigured: Boolean(config.userId),
    userEmailConfigured: Boolean(config.userEmail),
    testDealConfigured: Boolean(config.testDealId),
    operator: config.operator,
    gitSha: config.gitSha,
  },
});
const client = new AcceptanceClient(config);
const test = (id, area, title, expected, requiredTest = true) => ({
  id,
  area,
  title,
  expected,
  required: requiredTest,
});

let enterprise = false;
await evidence.run(test(
  'DG-INT-001',
  'access',
  'Enterprise intelligence access',
  'Signed access response identifies entitlement and permissions',
), async () => {
  const response = await client.signed('GET', '/api/v1/enterprise/access');
  ensure(response.status === 200, `Access returned ${response.status}.`);
  enterprise = response.json?.entitled === true || response.json?.tier === 'enterprise';
  ensure(Array.isArray(response.json?.permissions), 'Permission list is unavailable.');
  return {
    entitled: enterprise,
    role: response.json?.role,
    permissions: response.json?.permissions,
    requestId: response.requestId,
  };
});

if (config.testDealId) {
  if (config.refreshDeal) {
    await evidence.run(test(
      'DG-INT-002',
      'deal-intelligence',
      'Refresh deterministic Deal Brief',
      'Assessment returns readiness and the enriched Deal Brief without mutating HubSpot commercial fields',
    ), async () => {
      const response = await client.signed('POST', `/api/v1/deals/${config.testDealId}/assessment`, {});
      ensure(response.status === 200, `Assessment returned ${response.status}: ${response.json?.error?.message ?? ''}`);
      ensure(typeof response.json?.score === 'number', 'Readiness score is unavailable.');
      const intelligence = response.json?.intelligence ?? {};
      ensure(intelligence.dealBrief || response.json?.dealBrief, 'Enriched Deal Brief is unavailable.');
      return {
        dealId: config.testDealId,
        score: response.json.score,
        status: response.json.status,
        intelligenceDimensions: Object.keys(intelligence),
        briefStatus: intelligence.dealBrief?.status ?? response.json?.dealBrief?.status ?? null,
        requestId: response.requestId,
      };
    });
  }

  await evidence.run(test(
    'DG-INT-003',
    'deal-intelligence',
    'Read current DealGuard intelligence',
    'Current assessment exposes deterministic intelligence and evidence limitations',
  ), async () => {
    const response = await client.signed('GET', `/api/v1/deals/${config.testDealId}/assessment`);
    ensure(response.status === 200, `Assessment read returned ${response.status}.`);
    ensure(typeof response.json?.score === 'number', 'Current assessment score is unavailable.');
    const intelligence = response.json?.intelligence ?? {};
    return {
      dealId: config.testDealId,
      score: response.json.score,
      status: response.json.status,
      intelligenceDimensions: Object.keys(intelligence),
      requestId: response.requestId,
    };
  });

  await evidence.run(test(
    'DG-INT-004',
    'recommendations',
    'Tracked recommendation history',
    'Deal recommendation history returns bounded lifecycle evidence',
  ), async () => {
    const response = await client.signed('GET', `/api/v1/deals/${config.testDealId}/recommendations?limit=20`);
    ensure(response.status === 200, `Recommendation history returned ${response.status}.`);
    const recommendations = response.json?.recommendations ?? response.json?.items ?? [];
    ensure(Array.isArray(recommendations), 'Recommendation history is not an array.');
    return {
      dealId: config.testDealId,
      recommendations: recommendations.length,
      statuses: [...new Set(recommendations.map((item) => item?.status).filter(Boolean))],
      requestId: response.requestId,
    };
  });
} else {
  for (const [id, title] of [
    ['DG-INT-002', 'Refresh deterministic Deal Brief'],
    ['DG-INT-003', 'Read current DealGuard intelligence'],
    ['DG-INT-004', 'Tracked recommendation history'],
  ]) evidence.skip(test(id, 'deal-intelligence', title, 'Developer-account test deal is configured', false), 'ACCEPTANCE_TEST_DEAL_ID not provided.');
}

const portfolioEndpoints = [
  ['DG-INT-005', 'manager-queue', '/api/v1/enterprise/decision-queue?limit=10', 'Manager Decision Queue'],
  ['DG-INT-006', 'executive-revenue', '/api/v1/enterprise/executive-revenue?candidateLimit=5', 'Executive Revenue View'],
  ['DG-INT-007', 'recommendation-outcomes', '/api/v1/enterprise/recommendation-outcomes?days=90', 'Recommendation outcome analytics'],
  ['DG-INT-008', 'recommendation-operations', '/api/v1/enterprise/recommendation-followups/candidates?limit=10', 'Recommendation follow-up candidates'],
  ['DG-INT-009', 'recommendation-routing', '/api/v1/enterprise/recommendation-routing-policies', 'Recommendation routing policies'],
  ['DG-INT-010', 'delivery-analytics', '/api/v1/enterprise/recommendation-delivery-analytics?days=30', 'Recommendation delivery analytics'],
  ['DG-INT-011', 'delivery-slos', '/api/v1/enterprise/recommendation-delivery-slos', 'Recommendation delivery SLO state'],
];

if (config.runPortfolio && enterprise) {
  for (const [id, area, endpoint, title] of portfolioEndpoints) {
    await evidence.run(test(id, area, title, 'Scoped Enterprise endpoint returns deterministic operating evidence'), async () => {
      const response = await client.signed('GET', endpoint);
      ensure(response.status === 200, `${endpoint} returned ${response.status}: ${response.json?.error?.message ?? ''}`);
      ensure(response.json && typeof response.json === 'object', `${endpoint} returned no JSON object.`);
      return {
        endpoint,
        topLevelKeys: Object.keys(response.json).slice(0, 30),
        requestId: response.requestId,
      };
    });
  }
} else {
  const reason = !enterprise ? 'Active Enterprise entitlement required.' : 'Portfolio intelligence acceptance disabled.';
  for (const [id, area, , title] of portfolioEndpoints) {
    evidence.skip(test(id, area, title, 'Scoped Enterprise endpoint returns deterministic operating evidence', false), reason);
  }
}

await evidence.run(test(
  'DG-INT-012',
  'security',
  'Unsigned intelligence endpoint rejection',
  'Protected intelligence endpoint rejects an unsigned request',
), async () => {
  const response = await client.http('GET', client.identityUrl('/api/v1/enterprise/decision-queue'));
  ensure(response.status === 401, `Unsigned decision queue returned ${response.status}.`);
  return { status: response.status, errorCode: response.json?.error?.code, requestId: response.requestId };
});

const output = await evidence.write(config.outputDir);
console.log(JSON.stringify({
  runId: output.evidence.runId,
  release: packageJson.version,
  summary: output.evidence.summary,
  evidence: { json: output.jsonPath, markdown: output.markdownPath },
}, null, 2));
if (output.evidence.summary.requiredFailed > 0) process.exitCode = 1;

import { randomUUID } from 'node:crypto';
import { ensure } from './acceptance-core.mjs';

const test = (id, area, title, expected, required = true) => ({ id, area, title, expected, required });
const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

export async function runAcceptanceSuite(client, evidence, config, packageVersion) {
  let billing = null;
  let access = null;

  await evidence.run(test('DG-LIVE-001', 'worker', 'Public health endpoint', 'HTTP 200 with current release identity'), async () => {
    const response = await client.http('GET', new URL('/health', config.baseUrl));
    ensure(response.status === 200, `Expected 200, received ${response.status}.`);
    ensure(response.json?.status === 'ok' && response.json?.service === 'dealguard-api', 'Health identity is invalid.');
    ensure(response.json?.version === packageVersion, `Worker ${response.json?.version ?? 'missing'} does not match package ${packageVersion}.`);
    return { status: response.status, service: response.json.service, version: response.json.version, requestId: response.requestId };
  });

  await evidence.run(test('DG-LIVE-002', 'public', 'Documentation and legal surfaces', 'Docs, privacy, terms and support return HTML'), async () => {
    const actual = [];
    for (const page of ['/docs', '/privacy', '/terms', '/support']) {
      const response = await client.http('GET', new URL(page, config.baseUrl));
      ensure(response.status === 200, `${page} returned ${response.status}.`);
      ensure(String(response.contentType).includes('text/html'), `${page} did not return HTML.`);
      actual.push({ page, status: response.status, bytes: Buffer.byteLength(response.text) });
    }
    return actual;
  });

  await evidence.run(test('DG-LIVE-003', 'security', 'Unsigned API is rejected', 'Protected route returns HTTP 401'), async () => {
    const response = await client.http('GET', client.identityUrl('/api/v1/billing'));
    ensure(response.status === 401, `Unsigned API returned ${response.status}.`);
    return { status: response.status, errorCode: response.json?.error?.code, requestId: response.requestId };
  });

  await evidence.run(test('DG-LIVE-004', 'billing', 'Signed billing status', 'Provider-neutral tier, status and allowances resolve'), async () => {
    const response = await client.signed('GET', '/api/v1/billing');
    ensure(response.status === 200, `Billing returned ${response.status}.`);
    ensure(['free', 'growth', 'enterprise'].includes(response.json?.tier), 'Billing tier is invalid.');
    if (config.expectedTier) ensure(response.json.tier === config.expectedTier, `Expected ${config.expectedTier}, received ${response.json.tier}.`);
    billing = response.json;
    return {
      tier: billing.tier, status: billing.status, provider: billing.provider, entitled: billing.entitled,
      checkoutConfigured: billing.checkoutConfigured, portalConfigured: billing.portalConfigured,
      customerId: billing.customerId, subscriptionId: billing.subscriptionId, productId: billing.productId,
      allowances: billing.allowances, requestId: response.requestId,
    };
  });

  await evidence.run(test('DG-LIVE-005', 'access', 'Signed access context', 'Role, permissions and entitlement resolve'), async () => {
    const response = await client.signed('GET', '/api/v1/enterprise/access');
    ensure(response.status === 200, `Access returned ${response.status}.`);
    ensure(typeof response.json?.role === 'string' && Array.isArray(response.json?.permissions), 'Access context is incomplete.');
    access = response.json;
    return { role: access.role, entitled: access.entitled, bootstrap: access.bootstrap, permissions: access.permissions, requestId: response.requestId };
  });

  await evidence.run(test('DG-LIVE-006', 'hubspot', 'Dashboard and metadata', 'Portal dashboard and live HubSpot metadata are available'), async () => {
    const [dashboard, metadata] = await Promise.all([
      client.signed('GET', '/api/v1/dashboard'),
      client.signed('GET', '/api/v1/metadata'),
    ]);
    ensure(dashboard.status === 200, `Dashboard returned ${dashboard.status}.`);
    ensure(metadata.status === 200, `Metadata returned ${metadata.status}.`);
    ensure(Array.isArray(metadata.json?.properties) && Array.isArray(metadata.json?.pipelines), 'HubSpot metadata is incomplete.');
    return {
      dashboard: { totalDeals: dashboard.json?.totalDeals, averageScore: dashboard.json?.averageScore, latestScan: dashboard.json?.latestScan?.status ?? null },
      metadata: { properties: metadata.json.properties.length, pipelines: metadata.json.pipelines.length },
      requestIds: [dashboard.requestId, metadata.requestId].filter(Boolean),
    };
  });

  await evidence.run(test('DG-LIVE-007', 'enterprise', 'App Home read model', 'Restricted panels return data or explicit redacted states'), async () => {
    const endpoints = [
      '/api/v1/enterprise/overview', '/api/v1/enterprise/analytics?days=30&audience=executive',
      '/api/v1/enterprise/roles', '/api/v1/enterprise/change-approvals', '/api/v1/enterprise/alerts',
      '/api/v1/enterprise/compliance', '/api/v1/enterprise/reliability', '/api/v1/billing/usage',
      '/api/v1/enterprise/policy-dimensions',
    ];
    const actual = [];
    for (const endpoint of endpoints) {
      const response = await client.signed('GET', endpoint);
      ensure(response.status === 200, `${endpoint} returned ${response.status}.`);
      actual.push({ endpoint: endpoint.split('?')[0], redacted: Boolean(response.json?.redacted), reason: response.json?.reason ?? null });
    }
    return actual;
  });

  if (config.testDealId) {
    await evidence.run(test('DG-LIVE-008', 'hubspot', 'Live deal assessment', 'Real test deal is assessed'), async () => {
      ensure(/^\d+$/.test(config.testDealId), 'ACCEPTANCE_TEST_DEAL_ID must contain only digits.');
      const response = await client.signed('POST', `/api/v1/deals/${config.testDealId}/assessment`, {});
      ensure(response.status === 200, `Assessment returned ${response.status}.`);
      ensure(typeof response.json?.score === 'number' && Array.isArray(response.json?.issues), 'Assessment is incomplete.');
      return { dealId: config.testDealId, score: response.json.score, grade: response.json.grade, status: response.json.status, issueCount: response.json.issues.length, requestId: response.requestId };
    });
  } else evidence.skip(test('DG-LIVE-008', 'hubspot', 'Live deal assessment', 'Real test deal is assessed', false), 'ACCEPTANCE_TEST_DEAL_ID not provided.');

  if (config.runScan) {
    await evidence.run(test('DG-LIVE-009', 'worker', 'Portal scan', 'Manual scan is accepted and observable'), async () => {
      const response = await client.signed('POST', '/api/v1/scans', {});
      ensure(response.status === 202, `Scan returned ${response.status}: ${response.json?.error?.message ?? ''}`);
      let latest = null;
      for (let attempt = 0; attempt < 12; attempt += 1) {
        await wait(5000);
        const dashboard = await client.signed('GET', '/api/v1/dashboard');
        ensure(dashboard.status === 200, `Dashboard poll returned ${dashboard.status}.`);
        latest = dashboard.json?.latestScan;
        if (latest?.status !== 'running') break;
      }
      ensure(['completed', 'running'].includes(latest?.status), `Unexpected scan state ${latest?.status ?? 'missing'}.`);
      return { scanId: response.json?.scanId, status: latest.status, scannedCount: latest.scannedCount, requestId: response.requestId };
    });
  } else evidence.skip(test('DG-LIVE-009', 'worker', 'Portal scan', 'Manual scan is accepted and observable', false), 'Disabled for this profile.');

  if (config.runDodoWebhook) {
    await evidence.run(test('DG-LIVE-010', 'billing', 'Invalid Dodo signature', 'Invalid webhook returns HTTP 401'), async () => {
      const envelope = { type: 'payment.failed', timestamp: new Date().toISOString(), data: {} };
      const rawBody = JSON.stringify(envelope);
      const response = await client.http('POST', new URL('/webhooks/dodo', config.baseUrl), { body: envelope, headers: client.dodoHeaders(rawBody, false) });
      ensure(response.status === 401, `Invalid webhook returned ${response.status}.`);
      return { status: response.status, errorCode: response.json?.error?.code, requestId: response.requestId };
    });

    await evidence.run(test('DG-LIVE-011', 'billing', 'Non-subscription Dodo isolation', 'Signed payment event cannot mutate entitlement'), async () => {
      ensure(billing, 'Billing state is unavailable.');
      const envelope = {
        business_id: `acceptance-${randomUUID()}`,
        type: 'payment.failed',
        timestamp: new Date().toISOString(),
        data: { object: { id: `payment-${randomUUID()}`, metadata: { portal_id: config.portalId } } },
      };
      const rawBody = JSON.stringify(envelope);
      const response = await client.http('POST', new URL('/webhooks/dodo', config.baseUrl), { body: envelope, headers: client.dodoHeaders(rawBody, true) });
      ensure(response.status === 200, `Signed webhook returned ${response.status}.`);
      const after = await client.signed('GET', '/api/v1/billing');
      for (const field of ['tier', 'status', 'provider', 'subscriptionId', 'productId', 'entitled']) {
        ensure(after.json?.[field] === billing?.[field], `Webhook changed ${field}.`);
      }
      return { status: response.status, unchanged: ['tier', 'status', 'provider', 'subscriptionId', 'productId', 'entitled'] };
    });
  } else {
    evidence.skip(test('DG-LIVE-010', 'billing', 'Invalid Dodo signature', 'Invalid webhook returns HTTP 401', false), 'Dodo webhook tests disabled.');
    evidence.skip(test('DG-LIVE-011', 'billing', 'Non-subscription Dodo isolation', 'Signed payment event cannot mutate entitlement', false), 'Dodo webhook tests disabled.');
  }

  if (config.runCheckout) {
    await evidence.run(test('DG-LIVE-012', 'billing', 'Dodo checkout creation', 'Hosted HTTPS checkout is created without granting entitlement'), async () => {
      ensure(access?.permissions?.includes('*') || access?.permissions?.includes('billing.manage'), 'Acceptance identity lacks billing.manage.');
      const before = await client.signed('GET', '/api/v1/billing');
      const response = await client.signed('POST', '/api/v1/billing/checkout', {
        tier: config.checkoutTier, interval: config.checkoutInterval, usageMode: 'capped', overageEnabled: false,
      });
      ensure(response.status === 200, `Checkout returned ${response.status}: ${response.json?.error?.message ?? ''}`);
      const checkout = new URL(response.json?.url);
      ensure(checkout.protocol === 'https:', 'Checkout URL is not HTTPS.');
      const after = await client.signed('GET', '/api/v1/billing');
      ensure(after.json?.tier === before.json?.tier && after.json?.entitled === before.json?.entitled, 'Checkout creation granted entitlement.');
      return { checkoutHost: checkout.hostname, tier: config.checkoutTier, interval: config.checkoutInterval, entitlementUnchanged: true };
    });
  } else evidence.skip(test('DG-LIVE-012', 'billing', 'Dodo checkout creation', 'Hosted checkout is created without granting entitlement', false), 'Checkout creation disabled.');

  if (config.runPlanPreview && billing?.provider === 'dodo' && billing?.subscriptionId) {
    await evidence.run(test('DG-LIVE-013', 'billing', 'Provider plan preview', 'Dodo preview returns without mutating state'), async () => {
      const targetTier = billing.tier === 'enterprise' ? 'growth' : 'enterprise';
      const targetInterval = billing.billingInterval === 'year' ? 'month' : 'year';
      const before = await client.signed('GET', '/api/v1/billing');
      const response = await client.signed('POST', '/api/v1/billing/plan-change/preview', {
        tier: targetTier, interval: targetInterval, effectiveAt: 'next_billing_date',
        prorationBillingMode: 'do_not_bill', onPaymentFailure: 'prevent_change',
      });
      ensure(response.status === 200, `Plan preview returned ${response.status}.`);
      const after = await client.signed('GET', '/api/v1/billing');
      ensure(after.json?.tier === before.json?.tier && after.json?.scheduledTier === before.json?.scheduledTier, 'Plan preview mutated state.');
      return { targetTier, targetInterval, previewPresent: Boolean(response.json?.preview ?? response.json), stateUnchanged: true };
    });
  } else evidence.skip(test('DG-LIVE-013', 'billing', 'Provider plan preview', 'Dodo preview returns without mutating state', false), billing?.provider !== 'dodo' ? 'Portal has no Dodo subscription.' : 'Plan preview disabled.');

  if (config.runSecureDownload && billing?.tier === 'enterprise' && billing?.entitled) {
    await evidence.run(test('DG-LIVE-014', 'compliance', 'Single-use audit export', 'Export succeeds once and replay returns 410'), async () => {
      const response = await client.signed('POST', '/api/v1/enterprise/downloads', { kind: 'audit', format: 'jsonl' });
      ensure(response.status === 201, `Export creation returned ${response.status}.`);
      const downloadUrl = new URL(response.json?.url);
      ensure(downloadUrl.origin === new URL(config.baseUrl).origin, 'Download origin is unexpected.');
      const first = await client.http('GET', downloadUrl);
      ensure(first.status === 200, `First download returned ${first.status}.`);
      const second = await client.http('GET', downloadUrl);
      ensure(second.status === 410, `Replay returned ${second.status}.`);
      return { firstStatus: first.status, firstBytes: Buffer.byteLength(first.text), replayStatus: second.status, expiresAt: response.json.expiresAt };
    });
  } else evidence.skip(test('DG-LIVE-014', 'compliance', 'Single-use audit export', 'Export succeeds once and replay returns 410', false), billing?.tier !== 'enterprise' ? 'Active Enterprise portal required.' : 'Secure export disabled.');
}

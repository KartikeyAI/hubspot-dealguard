import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('enterprise App Home read fallbacks are redacted and GET-only', async () => {
  const router = await readFile('worker/src/routes-v10.ts', 'utf8');
  const index = await readFile('worker/src/index.ts', 'utf8');

  assert.match(index, /routes-v17/);
  assert.match(router, /request\.method !== 'GET'/);
  assert.match(router, /error instanceof AppError && error\.status === 403/);
  assert.match(router, /reason: 'permission_denied'/);
  assert.match(router, /redacted: true/);

  for (const path of [
    '/api/v1/enterprise/overview',
    '/api/v1/enterprise/analytics',
    '/api/v1/enterprise/roles',
    '/api/v1/enterprise/change-approvals',
    '/api/v1/enterprise/policy-templates',
    '/api/v1/enterprise/alerts',
    '/api/v1/enterprise/compliance',
    '/api/v1/enterprise/reliability',
    '/api/v1/billing/usage',
    '/api/v1/enterprise/policy-dimensions',
  ]) {
    assert.match(router, new RegExp(path.replaceAll('/', '\\/')));
  }
});

test('non-Enterprise portals receive a safe billing and upgrade shell', async () => {
  const router = await readFile('worker/src/routes-v10.ts', 'utf8');
  assert.match(router, /\/api\/v1\/enterprise\/access/);
  const billingAccess = await readFile('worker/src/billing-delivery-status.ts', 'utf8');
  assert.match(router, /billingAccessFallback\(env, identity\)/);
  assert.match(billingAccess, /enterprise_subscription_required/);
  assert.match(billingAccess, /enterpriseAccessContext\(env, identity\)/);
  assert.match(billingAccess, /'billing\.view'/);
  assert.match(billingAccess, /permissionMatches\(context.permissions, 'billing\.manage'\)/);
  assert.match(billingAccess, /scope: context.scope/);
  assert.match(billingAccess, /entitled: false/);
});

test('permission fallback does not weaken enterprise mutations', async () => {
  const router = await readFile('worker/src/routes-v10.ts', 'utf8');
  assert.match(router, /if \(request\.method !== 'GET'\) return routeV9\(request, env, ctx\)/);
  assert.doesNotMatch(router, /status === 401/);
  assert.doesNotMatch(router, /status === 402/);
  assert.doesNotMatch(router, /status === 409/);
});

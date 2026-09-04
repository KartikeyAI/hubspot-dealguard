import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const read = (path) => fs.readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

test('declares quote and line-item permissions as optional rather than required', () => {
  const app = JSON.parse(read('src/app/app-hsmeta.json'));
  const auth = app.config.auth;
  assert.ok(auth.optionalScopes.includes('crm.objects.line_items.read'));
  assert.ok(auth.optionalScopes.includes('crm.objects.quotes.read'));
  assert.equal(auth.requiredScopes.includes('crm.objects.line_items.read'), false);
  assert.equal(auth.requiredScopes.includes('crm.objects.quotes.read'), false);
  const config = read('worker/src/config.ts');
  assert.match(config, /OPTIONAL_COMMERCIAL_HUBSPOT_SCOPES/);
});

test('uses exact date-versioned deal association and commercial object endpoints', () => {
  const source = read('worker/src/commercial-integrity-data.ts');
  assert.match(source, /\/crm\/associations\/2026-03\/deals\/\$\{toObjectType\}\/batch\/read/);
  assert.match(source, /\/crm\/objects\/2026-03\/\$\{objectType\}\/batch\/read/);
  assert.match(source, /\/crm\/objects\/2026-03\/deals\//);
  assert.match(source, /MAX_LINE_ITEMS = 200/);
  assert.match(source, /MAX_QUOTES = 50/);
});

test('keeps commercial reads metadata-only', () => {
  const source = read('worker/src/commercial-integrity-data.ts');
  for (const allowed of ['quantity', 'price', 'amount', 'discount', 'hs_discount_percentage', 'hs_expiration_date', 'hs_status', 'hs_quote_amount', 'hs_currency']) {
    assert.ok(source.includes(`'${allowed}'`), `expected ${allowed}`);
  }
  for (const blocked of ['hs_body', 'hs_terms', 'hs_payment', 'hs_signature', 'hs_attachment', 'hs_contract', 'hs_quote_body']) {
    assert.equal(source.includes(`'${blocked}'`), false, `blocked ${blocked}`);
  }
});

test('performs no commercial object request before optional authorization', () => {
  const source = read('worker/src/commercial-integrity-data.ts');
  const guard = source.indexOf("if (authorization.status === 'required')");
  const dealRead = source.indexOf('const dealRecord = await internal.request');
  assert.ok(guard >= 0 && dealRead > guard);
  assert.match(source, /return \{[\s\S]*authorization,[\s\S]*availability: \{ lineItems: false, quotes: false \}/);
});

test('isolates commercial enrichment from scans, webhooks, workflows, and the core assessment service', () => {
  const wrapper = read('worker/src/routes-v11.ts');
  const index = read('worker/src/index.ts');
  const routeV12 = read('worker/src/routes-v12.ts');
  const assessment = read('worker/src/assessment-service.ts');
  assert.match(index, /routes-v17\.js/);
  assert.match(routeV12, /routes-v11\.js/);
  assert.match(wrapper, /assessmentDealId/);
  assert.match(wrapper, /pathname\.match/);
  assert.match(wrapper, /return routeV10\(request, env, ctx\)/);
  assert.equal(assessment.includes('commercial-integrity'), false);
  assert.equal(assessment.includes('loadCommercialIntegrityData'), false);
});

test('provides permission-checked progressive reauthorization using optional_scope', () => {
  const source = read('worker/src/routes-v11.ts');
  assert.match(source, /commercial-access/);
  assert.match(source, /requireOperationalPermission\(env, identity, 'integration\.manage'\)/);
  assert.match(source, /authorize\.searchParams\.set\('optional_scope'/);
  assert.match(source, /authorization\.missingScopes\.join\(' '\)/);
});

test('uses same-currency checks and non-authoritative discount review semantics', () => {
  const source = read('worker/src/commercial-integrity-analysis.ts');
  assert.match(source, /latestCurrentQuote\.currencyCode === data\.deal\.currencyCode/);
  assert.match(source, /Amount alignment is suppressed/);
  assert.match(source, /review threshold, not as evidence that the discount is unauthorized/);
  assert.match(source, /do not establish whether a discount is authorized/);
});

test('adds commercial evidence and actions to the Deal Brief without predictive claims', () => {
  const source = read('worker/src/deal-brief-commercial.ts');
  const types = read('worker/src/commercial-integrity-types.ts');
  assert.match(source, /dimension: 'commercial'/);
  assert.match(source, /current\.percent \* \.8/);
  assert.match(source, /20 \* commercial!/);
  assert.match(types, /notForecastCategory: true/);
  assert.match(types, /notWinProbability: true/);
  assert.match(types, /notExpectedLoss: true/);
  assert.match(types, /contentProcessed: false/);
});

test('registers dedicated commercial UI and authorization controls', () => {
  const card = read('src/app/cards/DealGuardCommercialCard.tsx');
  const meta = JSON.parse(read('src/app/cards/dealguard-commercial-card-hsmeta.json'));
  const primary = read('src/app/cards/DealGuardCard.tsx');
  assert.equal(meta.config.name, 'DealGuard — Commercial Integrity');
  assert.match(card, /Prepare commercial authorization/);
  assert.match(card, /Open HubSpot authorization/);
  assert.match(card, /does not inspect proposal documents/);
  assert.match(primary, /COMMERCIAL INTEGRITY/);
});

test('watches and executes focused commercial checks in P2 CI', () => {
  const workflow = read('.github/workflows/p2-decision-intelligence.yml');
  assert.match(workflow, /commercial-integrity-data\.ts/);
  assert.match(workflow, /routes-v11\.ts/);
  assert.match(workflow, /DealGuardCommercialCard\.tsx/);
  assert.match(workflow, /commercial-integrity-contract\.test\.mjs/);
  assert.match(workflow, /Run commercial-integrity tests/);
});

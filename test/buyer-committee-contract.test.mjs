import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const data = fs.readFileSync(new URL('../worker/src/buyer-committee-data.ts', import.meta.url), 'utf8');
const evaluator = fs.readFileSync(new URL('../worker/src/buyer-committee.ts', import.meta.url), 'utf8');
const service = fs.readFileSync(new URL('../worker/src/assessment-service.ts', import.meta.url), 'utf8');
const shared = fs.readFileSync(new URL('../src/app/cards/deal-intelligence-shared.tsx', import.meta.url), 'utf8');
const mainCard = fs.readFileSync(new URL('../src/app/cards/DealGuardCard.tsx', import.meta.url), 'utf8');
const committeeCard = fs.readFileSync(new URL('../src/app/cards/DealGuardBuyerCommitteeCard.tsx', import.meta.url), 'utf8');
const actionsCard = fs.readFileSync(new URL('../src/app/cards/DealGuardActionsCard.tsx', import.meta.url), 'utf8');
const scopes = fs.readFileSync(new URL('../worker/src/config.ts', import.meta.url), 'utf8');

const expectedContactProperties = ['firstname', 'lastname', 'jobtitle', 'hs_buying_role', 'lastmodifieddate'];
const expectedCompanyProperties = ['name', 'domain', 'industry', 'hs_lastmodifieddate'];

test('relationship enrichment uses current HubSpot association and object endpoints', () => {
  for (const path of [
    '/crm/associations/2026-03/deals/${toObjectType}/batch/read',
    '/crm/objects/2026-03/${objectType}/batch/read',
  ]) assert.ok(data.includes(path), `missing ${path}`);
  assert.match(data, /const MAX_CONTACTS = 100/);
  assert.match(data, /const MAX_COMPANIES = 20/);
  assert.match(data, /paging\?\.next\?\.after/);
});

test('relationship property boundary excludes communication content and email', () => {
  for (const property of expectedContactProperties) assert.match(data, new RegExp(`'${property}'`));
  for (const property of expectedCompanyProperties) assert.match(data, new RegExp(`'${property}'`));
  assert.doesNotMatch(data, /'email'|'notes'|'body'|'hs_email_text'|'hs_call_body'/);
});

test('job-title evidence is visibly inferred and cannot confirm authority', () => {
  assert.match(evaluator, /source: 'job_title_hint'/);
  assert.match(evaluator, /confidence: 'inferred'/);
  assert.match(evaluator, /status !== 'explicit'/);
  assert.match(evaluator, /do not confirm decision authority, budget authority, advocacy, or buyer intent/);
});

test('relationship enrichment is record-only, optional, cached, and gracefully degrading', () => {
  assert.match(service, /trigger === 'record'/);
  assert.match(service, /optionalBuyerCommitteeIntelligence/);
  assert.match(service, /task: 'buyer_committee_enrichment'/);
  assert.match(service, /return null;/);
  assert.match(service, /ENRICHMENT_CACHE_TTL_MS = 60_000/);
  assert.match(service, /enrichmentInFlight/);
  assert.match(service, /putCache\(cacheKey\(portalId, dealId\), value\)/);
  assert.match(service, /combineDecisionActions/);
});

test('HubSpot cards expose relationship coverage without predictive language', () => {
  for (const source of [shared, mainCard, committeeCard, actionsCard]) assert.doesNotMatch(source, /buyer intent score|win probability score|predictive stakeholder/i);
  for (const label of ['Relationship coverage', 'Core buying roles', 'Associated stakeholders', 'Evidence boundary']) assert.ok(committeeCard.includes(label), `missing ${label}`);
  assert.match(mainCard, /relationship coverage/i);
  assert.match(actionsCard, /relationship/i);
  assert.match(actionsCard, /evidence/i);
});

test('relationship slice adds no OAuth scope or database migration dependency', () => {
  assert.match(scopes, /crm\.objects\.contacts\.read/);
  assert.match(scopes, /crm\.objects\.companies\.read/);
  assert.doesNotMatch(scopes, /crm\.schemas\.contacts\.read|crm\.schemas\.companies\.read/);
});

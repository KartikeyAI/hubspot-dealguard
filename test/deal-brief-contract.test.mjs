import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const brief = fs.readFileSync(new URL('../worker/src/deal-brief.ts', import.meta.url), 'utf8');
const briefTypes = fs.readFileSync(new URL('../worker/src/deal-brief-types.ts', import.meta.url), 'utf8');
const service = fs.readFileSync(new URL('../worker/src/assessment-service.ts', import.meta.url), 'utf8');
const shared = fs.readFileSync(new URL('../src/app/cards/deal-intelligence-shared.tsx', import.meta.url), 'utf8');
const card = fs.readFileSync(new URL('../src/app/cards/DealGuardCard.tsx', import.meta.url), 'utf8');
const metadata = fs.readFileSync(new URL('../src/app/cards/dealguard-card-hsmeta.json', import.meta.url), 'utf8');
const config = fs.readFileSync(new URL('../worker/src/config.ts', import.meta.url), 'utf8');
const workflow = fs.readFileSync(new URL('../.github/workflows/p2-decision-intelligence.yml', import.meta.url), 'utf8');

test('Deal Brief synthesises existing deterministic dimensions', () => {
  assert.match(brief, /buildDealBrief/);
  assert.match(brief, /readinessEvidence/);
  assert.match(brief, /momentumEvidence/);
  assert.match(brief, /relationshipEvidence/);
  assert.match(brief, /deterministic_evidence_synthesis/);
  for (const dimension of ['readiness', 'momentum', 'close_date', 'relationship', 'change']) {
    assert.match(briefTypes, new RegExp(`'${dimension}'`));
  }
});

test('attention priority is explicitly not a prediction', () => {
  assert.match(briefTypes, /notWinProbability: true/);
  assert.match(briefTypes, /notBuyerIntent: true/);
  assert.match(briefTypes, /notForecastCategory: true/);
  assert.match(card, /not buyer intent, a forecast category, a win probability, or an expected-loss estimate/);
  assert.doesNotMatch(brief, /expectedLoss|forecastProbability|machine_learning|probabilityScore/i);
});

test('both cached record opens and explicit record refreshes receive a Deal Brief', () => {
  assert.match(service, /completeIntelligence\(stored, readiness, momentum, relationship\)/);
  assert.match(service, /completeIntelligence\(assessment, readiness, momentum, relationship\)/);
  assert.match(service, /buildDealBrief\(\{/);
  assert.match(service, /putCache\(cacheKey\(portalId, dealId\), value\)/);
});

test('the primary HubSpot card is now the unified Deal Brief surface', () => {
  assert.match(metadata, /DealGuard — Deal Brief/);
  for (const label of ['Deal brief', 'ATTENTION PRIORITY', 'EVIDENCE COVERAGE', 'Top risks', 'Positive signals', 'What changed', 'Evidence by dimension']) {
    assert.ok(card.includes(label), `missing Deal Brief UI label: ${label}`);
  }
  assert.match(shared, /dealBrief\?: DealBrief/);
  assert.match(shared, /briefVariant/);
  assert.match(shared, /attentionVariant/);
  assert.match(shared, /freshnessVariant/);
});

test('the slice does not expand HubSpot OAuth access', () => {
  for (const scope of ['crm.objects.emails.read', 'crm.objects.calls.read', 'crm.objects.meetings.read', 'sales-email-read']) {
    assert.ok(!config.includes(scope), `unexpected scope added: ${scope}`);
  }
});

test('focused CI covers Deal Brief behaviour and contracts', () => {
  assert.match(workflow, /worker\/src\/deal-brief\.ts/);
  assert.match(workflow, /worker\/src\/deal-brief-types\.ts/);
  assert.match(workflow, /test\/deal-brief\.test\.mjs/);
  assert.match(workflow, /test\/deal-brief-contract\.test\.mjs/);
  assert.match(workflow, /Run Deal Brief tests/);
});

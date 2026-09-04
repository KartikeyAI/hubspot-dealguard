import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const service = fs.readFileSync(new URL('../worker/src/assessment-service.ts', import.meta.url), 'utf8');
const momentum = fs.readFileSync(new URL('../worker/src/deal-momentum.ts', import.meta.url), 'utf8');
const card = fs.readFileSync(new URL('../src/app/cards/DealGuardCard.tsx', import.meta.url), 'utf8');
const actions = fs.readFileSync(new URL('../src/app/cards/DealGuardActionsCard.tsx', import.meta.url), 'utf8');
const changes = fs.readFileSync(new URL('../src/app/cards/DealGuardChangesCard.tsx', import.meta.url), 'utf8');
const app = fs.readFileSync(new URL('../src/app/app-hsmeta.json', import.meta.url), 'utf8');

test('record assessments receive optional momentum while webhook and workflow paths stay current-state only', () => {
  assert.match(service, /trigger === 'record'/);
  assert.match(service, /optionalMomentumIntelligence/);
  assert.match(service, /task: 'deal_history_enrichment'/);
  assert.match(service, /return null;/);
  assert.match(momentum, /collectMomentumEvidence/);
  assert.match(momentum, /evaluateCloseDateCredibility/);
});

test('optional history failure does not replace deterministic readiness intelligence', () => {
  assert.match(service, /const readiness = await readinessIntelligence/);
  assert.match(service, /return \{[\s\S]*\.\.\.readiness,[\s\S]*\.\.\.\(momentum \?\? \{\}\),[\s\S]*\.\.\.\(relationship \?\? \{\}\),[\s\S]*\.\.\.\(engagement \?\? \{\}\)/);
  assert.match(service, /catch \(error\)[\s\S]*task: 'deal_history_enrichment'[\s\S]*return null/);
});

test('deal cards expose precise CRM-process and close-date terminology', () => {
  for (const label of [/CRM process momentum/i, /Close-date credibility/i, /How to read this brief/i]) assert.match(card, label);
  assert.match(card, /not buyer intent[\s\S]*win probability/i);
  assert.ok(actions.includes('Recommended actions'));
  assert.ok(actions.includes('Owner:'));
  assert.ok(actions.includes('Why:'));
  assert.ok(changes.includes('90-day CRM movement'));
  assert.ok(changes.includes('Close-date evidence'));
});

test('the slice introduces no additional OAuth scope', () => {
  const metadata = JSON.parse(app);
  assert.deepEqual(metadata.config.auth.requiredScopes, [
    'crm.objects.deals.read',
    'crm.objects.deals.write',
    'crm.objects.contacts.read',
    'crm.objects.companies.read',
    'crm.schemas.deals.read',
    'crm.schemas.deals.write',
  ]);
});

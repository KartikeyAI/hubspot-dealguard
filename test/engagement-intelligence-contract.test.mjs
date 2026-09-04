import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const data = fs.readFileSync(new URL('../worker/src/engagement-metadata-data.ts', import.meta.url), 'utf8');
const evaluator = fs.readFileSync(new URL('../worker/src/engagement-intelligence.ts', import.meta.url), 'utf8');
const analysis = fs.readFileSync(new URL('../worker/src/engagement-analysis.ts', import.meta.url), 'utf8');
const signals = fs.readFileSync(new URL('../worker/src/engagement-signals.ts', import.meta.url), 'utf8');
const engagementActions = fs.readFileSync(new URL('../worker/src/engagement-actions.ts', import.meta.url), 'utf8');
const utilities = fs.readFileSync(new URL('../worker/src/engagement-metadata-utils.ts', import.meta.url), 'utf8');
const service = fs.readFileSync(new URL('../worker/src/assessment-service.ts', import.meta.url), 'utf8');
const brief = fs.readFileSync(new URL('../worker/src/deal-brief-engagement.ts', import.meta.url), 'utf8');
const shared = fs.readFileSync(new URL('../src/app/cards/deal-intelligence-shared.tsx', import.meta.url), 'utf8');
const card = fs.readFileSync(new URL('../src/app/cards/DealGuardEngagementCard.tsx', import.meta.url), 'utf8');
const actions = fs.readFileSync(new URL('../src/app/cards/DealGuardActionsCard.tsx', import.meta.url), 'utf8');
const config = fs.readFileSync(new URL('../worker/src/config.ts', import.meta.url), 'utf8');
const workflow = fs.readFileSync(new URL('../.github/workflows/p2-decision-intelligence.yml', import.meta.url), 'utf8');

test('uses date-versioned, deal-associated activity searches with bounded metadata properties', () => {
  assert.match(data, /`\/crm\/objects\/2026-03\/\$\{objectType\}\/search`/);
  for (const objectType of ['emails', 'calls', 'meetings']) {
    assert.ok(data.includes(`'${objectType}'`), `missing activity search type ${objectType}`);
  }
  assert.match(data, /propertyName:\s*'associations\.deal'/);
  assert.match(data, /const MAX_EMAILS = 200/);
  assert.match(data, /const MAX_CALLS = 100/);
  assert.match(data, /const MAX_MEETINGS = 100/);
  assert.match(data, /Promise\.allSettled/);

  for (const property of [
    'hs_timestamp', 'hs_email_direction', 'hs_email_status', 'hubspot_owner_id',
    'hs_call_direction', 'hs_call_status', 'hs_call_disposition', 'hs_call_duration',
    'hs_meeting_start_time', 'hs_meeting_end_time', 'hs_meeting_outcome',
  ]) assert.ok(data.includes(`'${property}'`), `missing metadata property ${property}`);

  for (const forbidden of [
    'hs_email_subject', 'hs_email_text', 'hs_email_html', 'hs_email_headers',
    'hs_call_body', 'hs_call_title', 'hs_call_from_number', 'hs_call_to_number', 'hs_call_recording_url',
    'hs_meeting_title', 'hs_meeting_body', 'hs_internal_meeting_notes',
  ]) assert.ok(!data.includes(forbidden), `content property must not be requested: ${forbidden}`);
});

test('keeps engagement deterministic, content-free, and non-predictive', () => {
  assert.match(evaluator, /methodology:\s*'hubspot_activity_metadata'/);
  assert.match(evaluator, /contentProcessed:\s*false/);
  assert.match(evaluator, /notBuyerIntent:\s*true/);
  assert.match(evaluator, /notWinProbability:\s*true/);
  assert.match(evaluator, /notSentimentAnalysis:\s*true/);
  assert.match(evaluator, /absence of logged activity may reflect CRM logging or association gaps/i);
  assert.match(analysis, /let score: number \| null = null/);
  assert.match(analysis, /status === 'active'|status = 'active'/);
  assert.match(signals, /outbound_without_reply_14d/);
  assert.match(engagementActions, /reengage_or_requalify_response_gap/);
  assert.match(utilities, /export function cadence/);
  const implementation = [evaluator, analysis, signals, engagementActions, utilities].join('\n');
  assert.doesNotMatch(implementation, /OpenAI|Anthropic|language model|embedding|sentiment score/i);
});

test('runs only on record-open or explicit record-refresh paths and fails independently', () => {
  assert.match(service, /if \(trigger === 'record'\)/);
  assert.match(service, /optionalEngagementIntelligence/);
  assert.match(service, /engagement_metadata_enrichment/);
  assert.match(service, /return null;/);
  assert.match(service, /enrichmentInFlight/);
  assert.match(service, /ENRICHMENT_CACHE_TTL_MS = 60_000/);
  assert.doesNotMatch(data, /env\.DB|INSERT INTO|UPDATE\s+engagement/i);
  assert.doesNotMatch(evaluator, /env\.DB|INSERT INTO|UPDATE\s+engagement/i);
});

test('integrates engagement into the Deal Brief and combined action queue', () => {
  assert.match(service, /augmentDealBriefWithEngagement/);
  assert.match(service, /engagement\?\.engagementActions/);
  assert.match(brief, /dimension:\s*'engagement'/);
  assert.match(brief, /engagementContribution/);
  assert.match(brief, /missing\.push\('engagement'\)/);
  assert.match(brief, /email subjects, bodies, headers, addresses/i);
});

test('adds a dedicated HubSpot engagement surface with precise interpretation labels', () => {
  for (const label of [
    'Engagement evidence',
    'Email response gap',
    'Activity cadence',
    'Reciprocity',
    'Metadata-only boundary',
  ]) assert.ok(card.includes(label), `missing UI label: ${label}`);
  assert.ok(card.includes('does not request email subjects or bodies'));
  assert.ok(shared.includes("methodology: 'hubspot_activity_metadata'"));
  assert.ok(actions.includes('activity metadata'));
  assert.match(actions, /does not inspect communication(?: or proposal)? content/i);
});

test('does not expand OAuth scopes', () => {
  assert.ok(config.includes("'crm.objects.contacts.read'"));
  for (const scope of [
    'sales-email-read',
    'crm.objects.emails.read',
    'crm.objects.calls.read',
    'crm.objects.meetings.read',
  ]) assert.ok(!config.includes(`'${scope}'`), `unexpected scope expansion: ${scope}`);
});

test('focused CI watches and executes the engagement slice', () => {
  for (const path of [
    'worker/src/engagement-metadata-types.ts',
    'worker/src/engagement-metadata-data.ts',
    'worker/src/engagement-metadata-utils.ts',
    'worker/src/engagement-analysis.ts',
    'worker/src/engagement-signals.ts',
    'worker/src/engagement-actions.ts',
    'worker/src/engagement-intelligence.ts',
    'worker/src/deal-brief-engagement.ts',
    'src/app/cards/DealGuardEngagementCard.tsx',
    'test/engagement-intelligence.test.mjs',
    'test/engagement-intelligence-contract.test.mjs',
    'test/deal-brief-engagement.test.mjs',
    'docs/ENGAGEMENT_INTELLIGENCE.md',
  ]) assert.ok(workflow.includes(path), `workflow does not watch ${path}`);
  assert.ok(workflow.includes('Run engagement-intelligence tests'));
});

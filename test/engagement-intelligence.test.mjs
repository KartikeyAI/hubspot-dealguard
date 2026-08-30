import assert from 'node:assert/strict';
import test from 'node:test';
import { buildEngagementIntelligence } from '../dist/engagement-intelligence.js';
import {
  ENGAGEMENT_CALL_PROPERTIES,
  ENGAGEMENT_EMAIL_PROPERTIES,
  ENGAGEMENT_MEETING_PROPERTIES,
  loadEngagementMetadata,
} from '../dist/engagement-metadata-data.js';

const NOW = Date.parse('2026-08-30T12:00:00.000Z');
const DAY = 86_400_000;
const at = (daysAgo) => new Date(NOW - daysAgo * DAY).toISOString();
const future = (days) => new Date(NOW + days * DAY).toISOString();

function deal(overrides = {}) {
  return {
    id: '42', contactCount: 2, companyCount: 1,
    properties: { closedate: future(20), ...overrides },
    stage: { isClosed: false },
  };
}

function data(overrides = {}) {
  return {
    emails: [], calls: [], meetings: [],
    availability: { emails: true, calls: true, meetings: true },
    truncated: { emails: false, calls: false, meetings: false },
    fetchedAt: new Date(NOW).toISOString(),
    windowStartedAt: at(90), meetingHorizonAt: future(180), limitations: [],
    ...overrides,
  };
}

test('classifies recent reciprocal activity and a future meeting as active', () => {
  const result = buildEngagementIntelligence(data({
    emails: [
      { id: 'e1', timestamp: at(5), direction: 'outbound', status: 'SENT', ownerId: '1', updatedAt: at(5) },
      { id: 'e2', timestamp: at(2), direction: 'inbound', status: null, ownerId: null, updatedAt: at(2) },
    ],
    calls: [{ id: 'c1', timestamp: at(8), direction: 'inbound', status: 'COMPLETED', disposition: null, durationMs: 120000, ownerId: '1', updatedAt: at(8) }],
    meetings: [
      { id: 'm1', timestamp: at(10), startAt: at(10), endAt: at(10 - 0.04), outcome: 'COMPLETED', ownerId: '1', updatedAt: at(10) },
      { id: 'm2', timestamp: future(5), startAt: future(5), endAt: future(5.04), outcome: 'SCHEDULED', ownerId: '1', updatedAt: at(1) },
    ],
  }), deal(), NOW);
  assert.equal(result.engagement.status, 'active');
  assert.ok((result.engagement.score ?? 0) >= 70);
  assert.equal(result.engagement.emailResponseGapDays, null);
  assert.equal(result.engagement.nextScheduledMeetingAt, future(5));
  assert.equal(result.engagement.contentProcessed, false);
  assert.equal(result.engagement.notBuyerIntent, true);
  assert.ok(result.engagement.signals.some((item) => item.code === 'bidirectional_email_activity'));
});

test('detects a material outbound-without-reply gap and recommends re-engagement', () => {
  const result = buildEngagementIntelligence(data({
    emails: [
      { id: 'e1', timestamp: at(50), direction: 'inbound', status: null, ownerId: null, updatedAt: at(50) },
      { id: 'e2', timestamp: at(20), direction: 'outbound', status: 'SENT', ownerId: '1', updatedAt: at(20) },
    ],
  }), deal({ closedate: future(15) }), NOW);
  assert.equal(result.engagement.status, 'disengaged');
  assert.equal(result.engagement.emailResponseGapDays, 20);
  assert.ok(result.engagement.signals.some((item) => item.code === 'outbound_without_reply_14d'));
  assert.equal(result.engagementActions[0]?.code, 'reengage_or_requalify_response_gap');
  assert.equal(result.engagementActions[0]?.priority, 'high');
});

test('treats no associated activity as insufficient evidence, not buyer disengagement', () => {
  const result = buildEngagementIntelligence(data(), deal(), NOW);
  assert.equal(result.engagement.status, 'insufficient_data');
  assert.equal(result.engagement.score, null);
  assert.equal(result.engagementActions[0]?.code, 'verify_engagement_logging');
  assert.match(result.engagement.limitations.join(' '), /not proof/i);
});

test('detects declining activity cadence without inspecting content', () => {
  const emails = [1, 16, 17, 18, 19].map((daysAgo, index) => ({
    id: `e${index}`, timestamp: at(daysAgo), direction: index % 2 ? 'inbound' : 'outbound',
    status: index % 2 ? null : 'SENT', ownerId: '1', updatedAt: at(daysAgo),
  }));
  const result = buildEngagementIntelligence(data({ emails }), deal({ closedate: future(45) }), NOW);
  assert.equal(result.engagement.cadence.trend, 'declining');
  assert.ok(result.engagement.signals.some((item) => item.code === 'engagement_cadence_declining'));
  assert.ok(result.engagementActions.some((item) => item.code === 'restore_engagement_cadence'));
});

test('loader requests only metadata properties through date-versioned association-filtered searches', async () => {
  const calls = [];
  const client = {
    async request(path, init) {
      calls.push({ path, body: JSON.parse(init.body) });
      return { total: 1, results: [{ id: path.includes('emails') ? 'e1' : path.includes('calls') ? 'c1' : 'm1', properties: { hs_timestamp: at(2) }, updatedAt: at(1) }] };
    },
  };
  const result = await loadEngagementMetadata(client, '42', NOW);
  assert.equal(calls.length, 3);
  assert.deepEqual(calls.map((item) => item.path), [
    '/crm/objects/2026-03/emails/search',
    '/crm/objects/2026-03/calls/search',
    '/crm/objects/2026-03/meetings/search',
  ]);
  for (const item of calls) {
    assert.equal(item.body.filterGroups[0].filters[0].propertyName, 'associations.deal');
    assert.equal(item.body.filterGroups[0].filters[0].value, '42');
    assert.deepEqual(item.body.sorts, [{ propertyName: 'hs_timestamp', direction: 'DESCENDING' }]);
    const properties = item.body.properties.join(' ');
    assert.doesNotMatch(properties, /body|subject|header|email_address|from_number|to_number|recording|notes|title/i);
  }
  assert.deepEqual(calls[0].body.properties, [...ENGAGEMENT_EMAIL_PROPERTIES]);
  assert.deepEqual(calls[1].body.properties, [...ENGAGEMENT_CALL_PROPERTIES]);
  assert.deepEqual(calls[2].body.properties, [...ENGAGEMENT_MEETING_PROPERTIES]);
  assert.equal(result.availability.emails, true);
  assert.equal(result.availability.calls, true);
  assert.equal(result.availability.meetings, true);
});

test('loader returns partial evidence when one activity endpoint is unavailable', async () => {
  const client = {
    async request(path) {
      if (path.includes('/calls/')) throw new Error('not available');
      return { total: 0, results: [] };
    },
  };
  const result = await loadEngagementMetadata(client, '42', NOW);
  assert.equal(result.availability.emails, true);
  assert.equal(result.availability.calls, false);
  assert.equal(result.availability.meetings, true);
  assert.ok(result.limitations.some((item) => item.includes('Call metadata')));
});

test('loader marks bounded search results as truncated', async () => {
  const client = {
    async request(path) {
      return { total: path.includes('emails') ? 300 : 0, results: [], paging: path.includes('emails') ? { next: { after: '200' } } : undefined };
    },
  };
  const result = await loadEngagementMetadata(client, '42', NOW);
  assert.equal(result.truncated.emails, true);
});

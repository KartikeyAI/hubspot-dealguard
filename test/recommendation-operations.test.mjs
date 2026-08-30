import assert from 'node:assert/strict';
import test from 'node:test';
import {
  deliveryBatchStatus,
  inQuietHours,
  routeExplicitlyMatches,
  routingMatch,
  safeCsvCell,
  scopeAllowed,
} from '../dist/recommendation-operations-model.js';
import { RECOMMENDATION_FOLLOWUP_EVENT } from '../dist/recommendation-operations-types.js';

const scope = {
  pipelineId: 'pipeline-1',
  teamId: 'team-1',
  ownerId: 'owner-1',
  regionCode: 'IN',
};

const access = {
  role: 'remediation_manager',
  permissions: ['remediation.bulk'],
  scope: {
    pipelineIds: ['pipeline-1'],
    teamIds: ['team-1'],
    ownerIds: ['owner-1'],
    regionCodes: ['IN'],
  },
  bootstrap: false,
};

function route(overrides = {}) {
  return {
    id: 'route-1',
    name: 'Recommendation follow-ups',
    eventTypes: [RECOMMENDATION_FOLLOWUP_EVENT],
    minimumSeverity: 'warning',
    pipelineIds: [],
    teamIds: [],
    ownerIds: [],
    regionCodes: [],
    channelIds: ['channel-1'],
    quietHoursCalendarId: null,
    enabled: true,
    ...overrides,
  };
}

test('requires explicit recommendation follow-up event opt-in', () => {
  assert.equal(routeExplicitlyMatches(route({ eventTypes: [] }), scope, 'warning'), false);
  assert.equal(routeExplicitlyMatches(route({ eventTypes: ['deal.critical'] }), scope, 'warning'), false);
  assert.equal(routeExplicitlyMatches(route(), scope, 'warning'), true);
});

test('enforces route severity and data scope', () => {
  assert.equal(routeExplicitlyMatches(route({ minimumSeverity: 'critical' }), scope, 'warning'), false);
  assert.equal(routeExplicitlyMatches(route({ pipelineIds: ['pipeline-2'] }), scope, 'critical'), false);
  assert.equal(routeExplicitlyMatches(route({ ownerIds: ['owner-1'] }), scope, 'critical'), true);
  assert.equal(scopeAllowed(scope, access), true);
  assert.equal(scopeAllowed({ ...scope, regionCode: 'US' }, access), false);
});

test('excludes configured quiet hours from a confirmable routing match', async () => {
  const match = await routingMatch({
    routes: [route()],
    channels: [{ id: 'channel-1', name: 'RevOps email', type: 'email' }],
    quietRouteIds: new Set(['route-1']),
    scope,
    severity: 'warning',
    recommendationId: 'recommendation-1',
    recommendationStatus: 'accepted',
    priority: 'high',
    dueAt: '2026-09-01T00:00:00.000Z',
    kind: 'manager_review',
    managerNote: 'Review this action before the forecast call.',
  });
  assert.equal(match.ready, false);
  assert.deepEqual(match.routeIds, []);
  assert.deepEqual(match.channelIds, []);
});

test('deduplicates channels and produces a stable routing fingerprint', async () => {
  const input = {
    routes: [
      route({ id: 'route-a', channelIds: ['channel-1', 'channel-2'] }),
      route({ id: 'route-b', channelIds: ['channel-2'] }),
    ],
    channels: [
      { id: 'channel-1', name: 'Email', type: 'email' },
      { id: 'channel-2', name: 'Slack', type: 'slack_webhook' },
    ],
    quietRouteIds: new Set(),
    scope,
    severity: 'critical',
    recommendationId: 'recommendation-1',
    recommendationStatus: 'presented',
    priority: 'high',
    dueAt: null,
    kind: 'owner_reminder',
    managerNote: 'Please confirm ownership and a dated next step.',
  };
  const first = await routingMatch(input);
  const second = await routingMatch({ ...input, routes: [...input.routes].reverse() });
  assert.equal(first.ready, true);
  assert.deepEqual(first.channelIds, ['channel-1', 'channel-2']);
  assert.deepEqual(first.routeIds, ['route-a', 'route-b']);
  assert.equal(first.fingerprint, second.fingerprint);
});

test('detects quiet hours using a configured business calendar', () => {
  const calendar = {
    timezone: 'Asia/Kolkata',
    weeklySchedule: {
      mon: { enabled: true, start: '09:00', end: '18:00' },
    },
    holidays: [],
  };
  assert.equal(inQuietHours(calendar, new Date('2026-08-31T04:30:00.000Z')), false);
  assert.equal(inQuietHours(calendar, new Date('2026-08-31T01:00:00.000Z')), true);
});

test('derives transparent batch delivery states', () => {
  assert.equal(deliveryBatchStatus(3, 0, 0), 'completed');
  assert.equal(deliveryBatchStatus(2, 1, 0), 'partially_failed');
  assert.equal(deliveryBatchStatus(0, 0, 3), 'failed');
  assert.equal(deliveryBatchStatus(0, 0, 0), 'failed');
});

test('neutralizes spreadsheet formula injection in CSV cells', () => {
  assert.equal(safeCsvCell('=HYPERLINK("https://example.com")'), '"\'=HYPERLINK(""https://example.com"")"');
  assert.equal(safeCsvCell('+SUM(1,2)'), '"\'+SUM(1,2)"');
  assert.equal(safeCsvCell('ordinary text'), '"ordinary text"');
});

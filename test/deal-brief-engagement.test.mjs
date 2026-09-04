import assert from 'node:assert/strict';
import test from 'node:test';
import { augmentDealBriefWithEngagement } from '../dist/deal-brief-engagement.js';

function base(overrides = {}) {
  return {
    dealBrief: {
      methodology: 'deterministic_evidence_synthesis', generatedAt: '2026-08-30T12:00:00.000Z',
      status: 'on_track', attentionScore: 20, confidence: 'high', summary: 'The deal is operationally on track.',
      risks: [], positiveSignals: [], changes: [], nextAction: null,
      coverage: { readiness: true, momentum: true, closeDate: true, relationship: true, percent: 100, missingDimensions: [], truncated: false },
      freshness: { assessedAt: '2026-08-30T10:00:00.000Z', ageHours: 2, status: 'fresh' },
      limitations: [], notWinProbability: true, notBuyerIntent: true, notForecastCategory: true,
      ...overrides,
    },
  };
}

function engagement(status = 'active', score = 85, overrides = {}) {
  return {
    engagement: {
      methodology: 'hubspot_activity_metadata', windowDays: 90, score, status, confidence: 'high', summary: 'Summary',
      lastBuyerActivityAt: '2026-08-29T12:00:00.000Z', lastInboundEmailAt: '2026-08-29T12:00:00.000Z', lastOutboundEmailAt: '2026-08-28T12:00:00.000Z',
      unansweredOutboundSince: null, emailResponseGapDays: null, lastCompletedCallAt: null, lastCompletedMeetingAt: null, nextScheduledMeetingAt: null,
      counts: { inboundEmails: 1, outboundEmails: 1, forwardedEmails: 0, failedOrBouncedEmails: 0, inboundCalls: 0, outboundCalls: 0, completedCalls: 0, completedMeetings: 0, scheduledMeetings: 0, noShowMeetings: 0, canceledMeetings: 0, totalMaterialActivities: 2 },
      cadence: { recent14Days: 2, previous14Days: 1, activeWeeks8: 2, trend: 'steady' },
      reciprocity: { inboundEmailCount: 1, outboundEmailCount: 1, ratio: 1, status: 'balanced' },
      coverage: { emails: true, calls: true, meetings: true, percent: 100, truncated: false, missingTypes: [] },
      signals: [{ code: 'recent_inbound_email', label: 'Recent inbound email', direction: 'positive', severity: 'info', detail: 'Recent reply.', observedAt: '2026-08-29T12:00:00.000Z', evidenceCodes: ['last_inbound_email_at'] }],
      fetchedAt: '2026-08-30T12:00:00.000Z', limitations: [], contentProcessed: false, notBuyerIntent: true, notWinProbability: true, notSentimentAnalysis: true,
      ...overrides,
    },
    engagementActions: [],
  };
}

test('adds engagement coverage and positive evidence to an on-track brief', () => {
  const result = augmentDealBriefWithEngagement(base(), engagement(), []).dealBrief;
  assert.equal(result.status, 'on_track');
  assert.equal(result.coverage.engagement, true);
  assert.equal(result.coverage.percent, 100);
  assert.ok(result.positiveSignals.some((item) => item.dimension === 'engagement'));
  assert.ok(result.limitations.some((item) => item.includes('subjects')));
});

test('escalates disengaged metadata with a high-priority engagement action', () => {
  const action = { code: 'reengage_or_requalify_response_gap', label: 'Resolve response gap', action: 'Re-engage the buyer.', priority: 'high', rationale: 'No reply.', owner: 'deal_owner', dueAt: '2026-08-31T12:00:00.000Z', evidenceCodes: ['outbound_without_reply_14d'] };
  const current = engagement('disengaged', 20, {
    signals: [{ code: 'outbound_without_reply_14d', label: 'Outbound without reply', direction: 'negative', severity: 'critical', detail: 'No reply for 20 days.', observedAt: '2026-08-10T12:00:00.000Z', evidenceCodes: ['gap'] }],
  });
  current.engagementActions = [action];
  const result = augmentDealBriefWithEngagement(base(), current, [action]).dealBrief;
  assert.equal(result.status, 'intervention_required');
  assert.equal(result.nextAction?.code, action.code);
  assert.ok(result.risks.some((item) => item.dimension === 'engagement'));
});

test('marks engagement as missing and lowers overall evidence coverage', () => {
  const result = augmentDealBriefWithEngagement(base(), null, []).dealBrief;
  assert.equal(result.coverage.engagement, false);
  assert.equal(result.coverage.percent, 80);
  assert.ok(result.coverage.missingDimensions.includes('engagement'));
  assert.equal(result.status, 'watch');
});

test('caps confidence when engagement results are truncated', () => {
  const current = engagement('active', 80, { coverage: { emails: true, calls: true, meetings: true, percent: 100, truncated: true, missingTypes: [] } });
  const result = augmentDealBriefWithEngagement(base(), current, []).dealBrief;
  assert.equal(result.coverage.truncated, true);
  assert.notEqual(result.confidence, 'high');
});

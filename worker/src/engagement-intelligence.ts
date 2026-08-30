import { analyzeEngagement } from './engagement-analysis.js';
import { buildEngagementActions } from './engagement-actions.js';
import type { EngagementMetadataData, EngagementMetadataIntelligence } from './engagement-metadata-types.js';
import { iso } from './engagement-metadata-utils.js';
import { buildEngagementSignals } from './engagement-signals.js';
import type { NormalizedDeal } from './types.js';

export function buildEngagementIntelligence(
  data: EngagementMetadataData,
  deal: NormalizedDeal,
  now = Date.now(),
): EngagementMetadataIntelligence {
  const analysis = analyzeEngagement(data, now);
  const signals = buildEngagementSignals(data, analysis, now);
  const limitations = [
    'Only timestamps, direction, status, outcome, duration, and owner identifiers are processed; communication content is excluded.',
    'Absence of logged activity may reflect CRM logging or association gaps and is not proof that no customer interaction occurred.',
    ...data.limitations,
  ];
  return {
    engagement: {
      methodology: 'hubspot_activity_metadata',
      windowDays: 90,
      score: analysis.score,
      status: analysis.status,
      confidence: analysis.confidence,
      summary: analysis.summary,
      lastBuyerActivityAt: iso(analysis.lastBuyerActivity),
      lastInboundEmailAt: iso(analysis.lastInboundEmail),
      lastOutboundEmailAt: iso(analysis.lastOutboundEmail),
      unansweredOutboundSince: iso(analysis.unansweredOutboundSince),
      emailResponseGapDays: analysis.emailResponseGapDays,
      lastCompletedCallAt: iso(analysis.lastCompletedCall),
      lastCompletedMeetingAt: iso(analysis.lastCompletedMeeting),
      nextScheduledMeetingAt: iso(analysis.nextScheduledMeeting),
      counts: {
        inboundEmails: analysis.inboundEmails.length,
        outboundEmails: analysis.outboundEmails.length,
        forwardedEmails: analysis.forwardedEmails.length,
        failedOrBouncedEmails: analysis.failedOrBouncedEmails.length,
        inboundCalls: analysis.inboundCalls.length,
        outboundCalls: analysis.outboundCalls.length,
        completedCalls: analysis.completedCalls.length,
        completedMeetings: analysis.completedMeetings.length,
        scheduledMeetings: analysis.scheduledMeetings.length,
        noShowMeetings: analysis.noShowMeetings.length,
        canceledMeetings: analysis.canceledMeetings.length,
        totalMaterialActivities: analysis.materialEventTimes.length,
      },
      cadence: analysis.cadenceState,
      reciprocity: analysis.reciprocityState,
      coverage: analysis.coverage,
      signals,
      fetchedAt: data.fetchedAt,
      limitations: [...new Set(limitations)],
      contentProcessed: false,
      notBuyerIntent: true,
      notWinProbability: true,
      notSentimentAnalysis: true,
    },
    engagementActions: buildEngagementActions(analysis, deal, now),
  };
}
